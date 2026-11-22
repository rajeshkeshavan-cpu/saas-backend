
// razorpay.js - FINAL CLEAN - Karnataka Zero Commission + 6 Plans + LIVE Debug
// Mounted from index.js: const razor = require('./razorpay'); razor(app, { supabase, redis, driverReg, io })

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// 6 Plans - Karnataka Namma Yatri model - matches driver app V24
const PLANS = {
  AUTO_DAILY:   { id: 'AUTO_DAILY',   name: 'Auto Daily',   vehicle_type: 'AUTO', price: 25,  days: 1 },
  AUTO_WEEKLY:  { id: 'AUTO_WEEKLY',  name: 'Auto Weekly',  vehicle_type: 'AUTO', price: 150, days: 7 },
  AUTO_MONTHLY: { id: 'AUTO_MONTHLY', name: 'Auto Monthly', vehicle_type: 'AUTO', price: 599, days: 30 },
  TAXI_DAILY:   { id: 'TAXI_DAILY',   name: 'Taxi Daily',   vehicle_type: 'TAXI', price: 35,  days: 1 },
  TAXI_WEEKLY:  { id: 'TAXI_WEEKLY',  name: 'Taxi Weekly',  vehicle_type: 'TAXI', price: 199, days: 7 },
  TAXI_MONTHLY: { id: 'TAXI_MONTHLY', name: 'Taxi Monthly', vehicle_type: 'TAXI', price: 799, days: 30 },
  // Legacy aliases for old driver apps
  DAILY_AUTO:   { id: 'DAILY_AUTO',   name: 'Auto Daily',   vehicle_type: 'AUTO', price: 25,  days: 1 },
  DAILY_TAXI:   { id: 'DAILY_TAXI',   name: 'Taxi Daily',   vehicle_type: 'TAXI', price: 35,  days: 1 },
  MONTHLY_AUTO: { id: 'MONTHLY_AUTO', name: 'Auto Monthly', vehicle_type: 'AUTO', price: 600, days: 30 },
  MONTHLY_TAXI: { id: 'MONTHLY_TAXI', name: 'Taxi Monthly', vehicle_type: 'TAXI', price: 800, days: 30 },
  PER_RIDE:     { id: 'PER_RIDE',     name: 'Per Ride',     vehicle_type: 'ANY',  price: 5,   days: 0 },
};

let razorpay = null;
function getRazor() {
  if (razorpay) return razorpay;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    console.log('⚠️ Razorpay keys not set');
    return null;
  }
  razorpay = new Razorpay({ key_id, key_secret });
  return razorpay;
}

const nowIso = () => new Date().toISOString();
const addDays = (d, days) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };

async function getWallet(driver_id) {
  if (!supabase) return null;
  const { data } = await supabase.from('driver_wallets').select('*').eq('driver_id', driver_id).maybeSingle();
  return data;
}
async function ensureWallet(driver_id, vehicle_type='AUTO') {
  if (!supabase) return null;
  let w = await getWallet(driver_id);
  if (w) return w;
  const nw = { driver_id, balance: 0, total_earnings: 0, total_rides: 0, subscription_due: 0, subscription_status: 'ACTIVE', current_plan: null, plan_expires_at: null, vehicle_type, last_payout_at: null, trial_rides_left: 3, created_at: nowIso(), updated_at: nowIso() };
  const { data } = await supabase.from('driver_wallets').insert(nw).select().maybeSingle();
  return data || nw;
}
async function addTxn(driver_id, ride_id, type, amount, balance_after, desc) {
  if (!supabase) return;
  await supabase.from('wallet_transactions').insert({ id: crypto.randomUUID(), driver_id, ride_id, type, amount, balance_after, description: desc, created_at: nowIso() });
}

function mount(app, ctx) {
  const { redis, driverReg } = ctx || {};

  async function driverFromReq(req) {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!token) return null;
      if (driverReg && driverReg.verifyDriverToken) return await driverReg.verifyDriverToken(token);
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || '';
      if (!secret) return null;
      return jwt.verify(token, secret);
    } catch(e){ return null; }
  }

  // --- Health ---
  app.get('/health/razorpay', (req,res)=>{
    const hasKey = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    res.json({ configured: hasKey, key_id_present: !!process.env.RAZORPAY_KEY_ID, key_prefix: (process.env.RAZORPAY_KEY_ID||'').substring(0,8), mode: (process.env.RAZORPAY_KEY_ID||'').startsWith('rzp_live')?'LIVE': hasKey?'TEST':'MISSING_KEYS', plans: Object.keys(PLANS) });
  });

  // --- Rider: Create payment order (UPI direct) - FIXED for LIVE ---
  app.post('/rider/payment/order', async (req, res) => {
    const rz = getRazor();
    if (!rz) return res.status(500).json({ error: 'Razorpay not configured - check RAZORPAY_KEY_ID/SECRET' });
    try {
      const { ride_id, amount, customer_phone, driver_id } = req.body;
      if (!ride_id || !amount) return res.status(400).json({ error: 'ride_id and amount required', got: req.body });
      const amtPaise = Math.round(Number(amount) * 100);
      if (amtPaise < 100) return res.status(400).json({ error: 'Invalid amount min 1 INR', amtPaise });
      
      // Razorpay receipt max 40 chars - trim ride_id
      const receipt = `r_${Date.now()}`.substring(0,40);
      
      console.log(`Creating Razorpay order ride_id=${ride_id} amount=${amount} paise=${amtPaise} key=${(process.env.RAZORPAY_KEY_ID||'').substring(0,8)}`);
      
      const order = await rz.orders.create({
        amount: amtPaise,
        currency: 'INR',
        receipt,
        notes: { ride_id: String(ride_id).substring(0,30), driver_id: driver_id || '', customer_phone: customer_phone || '', govt_fare: 'Karnataka', zero_commission: 'true' }
      });

      console.log(`💳 Order created ${ride_id} ₹${amount} ${order.id}`);
      res.json({ success: true, order_id: order.id, id: order.id, amount, amount_paise: amtPaise, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID, ride_id });
    } catch (e) {
      const msg = e.error?.description || e.message || 'Razorpay error';
      console.log('❌ Razorpay order ERROR:', e.statusCode, msg, JSON.stringify(e.error||{}).substring(0,300));
      res.status(500).json({ error: msg, code: e.statusCode, details: e.error, key_prefix: (process.env.RAZORPAY_KEY_ID||'').substring(0,8) });
    }
  });

  // Rider: Verify
  app.post('/rider/payment/verify', async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, ride_id, driver_id, amount } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing Razorpay fields' });
      const secret = process.env.RAZORPAY_KEY_SECRET || '';
      const generated = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      if (generated !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });
      if (supabase && driver_id) {
        const wallet = await ensureWallet(driver_id);
        const newBalance = Number(wallet.balance || 0) + Number(amount || 0);
        const newEarnings = Number(wallet.total_earnings || 0) + Number(amount || 0);
        const newRides = Number(wallet.total_rides || 0) + 1;
        await supabase.from('driver_wallets').update({ balance: newBalance, total_earnings: newEarnings, total_rides: newRides, updated_at: nowIso() }).eq('driver_id', driver_id);
        await addTxn(driver_id, ride_id, 'EARNING', Number(amount), newBalance, `Ride ${ride_id} ₹${amount} via Razorpay UPI`);
        try { await supabase.from('rides').update({ payment_status: 'PAID', payment_id: razorpay_payment_id, paid_at: nowIso() }).eq('ride_id', ride_id); } catch(_){}
      }
      res.json({ success: true, verified: true, ride_id, driver_id, amount });
    } catch (e) {
      console.log('Verify error', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // --- NEW: Driver subscription order - for V24 driver app (simple amount) ---
  app.post('/driver/subscription/order', async (req, res) => {
    const rz = getRazor();
    if (!rz) return res.status(500).json({ error: 'Razorpay not configured' });
    try {
      const { plan_id, amount, driver_id } = req.body;
      let amt = amount;
      let plan = null;
      if (plan_id) plan = PLANS[plan_id];
      if (!amt && plan) amt = plan.price;
      if (!amt) amt = 25;
      const amtPaise = Math.round(Number(amt) * 100);
      if (amtPaise < 100) return res.status(400).json({ error: 'Invalid amount min 1 INR' });
      
      const receipt = `sub_${Date.now()}`.substring(0,40);
      console.log(`Creating sub order plan=${plan_id} amount=${amt} paise=${amtPaise}`);
      
      const order = await rz.orders.create({
        amount: amtPaise,
        currency: 'INR',
        receipt,
        notes: { plan_id: plan_id||'AUTO_DAILY', type: 'driver_subscription', driver_id: driver_id||'' }
      });
      res.json({ success: true, order_id: order.id, id: order.id, amount: amt, amount_paise: amtPaise, key_id: process.env.RAZORPAY_KEY_ID, plan });
    } catch (e) {
      const msg = e.error?.description || e.message;
      console.log('❌ Sub order ERROR:', e.statusCode, msg, JSON.stringify(e.error||{}).substring(0,300));
      res.status(500).json({ error: msg, code: e.statusCode, details: e.error });
    }
  });

  // --- Driver: Subscription Razorpay order (with auth) ---
  app.post('/driver/subscription/razorpay/order', async (req, res) => {
    const rz = getRazor(); if (!rz) return res.status(500).json({ error: 'Razorpay not configured' });
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { plan_id } = req.body;
      const plan = PLANS[plan_id];
      if (!plan) return res.status(400).json({ error: 'Invalid plan_id', valid: Object.keys(PLANS) });
      const receipt = `sub_${Date.now()}`.substring(0,40);
      const order = await rz.orders.create({
        amount: Math.round(plan.price * 100),
        currency: 'INR',
        receipt,
        notes: { driver_id: driver.driver_id, plan_id, plan_name: plan.name, type: 'SUBSCRIPTION' }
      });
      console.log(`💳 Sub order driver ${driver.driver_id} plan ${plan_id} ₹${plan.price} order ${order.id}`);
      res.json({ success: true, order_id: order.id, id: order.id, plan, key_id: process.env.RAZORPAY_KEY_ID });
    } catch(e){ 
      const msg = e.error?.description || e.message;
      console.log('Sub order auth ERROR', msg);
      res.status(500).json({ error: msg }); 
    }
  });

  app.post('/driver/subscription/razorpay/verify', async (req, res) => {
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = req.body;
      const plan = PLANS[plan_id]; if (!plan) return res.status(400).json({ error: 'Invalid plan' });
      const secret = process.env.RAZORPAY_KEY_SECRET || '';
      const gen = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      if (gen !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });
      const expires = plan.days > 0 ? addDays(new Date(), plan.days) : null;
      const driver_id = driver.driver_id || driver.id;
      await supabase.from('driver_wallets').update({
        current_plan: plan_id,
        plan_expires_at: expires ? expires.toISOString() : null,
        subscription_status: 'ACTIVE',
        subscription_due: 0,
        updated_at: nowIso()
      }).eq('driver_id', driver_id);
      await supabase.from('driver_subscriptions').insert({
        id: crypto.randomUUID(),
        driver_id,
        plan_id: plan.id,
        plan_name: plan.name,
        amount: plan.price,
        start_date: nowIso(),
        end_date: expires ? expires.toISOString() : null,
        status: 'ACTIVE',
        payment_id: razorpay_payment_id,
        payment_method: 'RAZORPAY',
        created_at: nowIso()
      });
      const wallet = await getWallet(driver_id);
      await addTxn(driver_id, null, 'SUBSCRIPTION_CHARGE', -plan.price, wallet ? wallet.balance : 0, `Subscription ${plan.name} ₹${plan.price} via Razorpay`);
      res.json({ success: true, plan, expires_at: expires, payment_id: razorpay_payment_id });
    } catch(e){ console.log('Sub verify error', e.message); res.status(500).json({ error: e.message }); }
  });

  // Wallet recharge
  app.post('/driver/wallet/recharge/order', async (req, res) => {
    const rz = getRazor(); if (!rz) return res.status(500).json({ error: 'Razorpay not configured' });
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { amount } = req.body;
      if (!amount || Number(amount) < 1) return res.status(400).json({ error: 'Min ₹1' });
      const order = await rz.orders.create({ amount: Math.round(Number(amount)*100), currency: 'INR', receipt: `wallet_${Date.now()}`, notes: { driver_id: driver.driver_id, type: 'WALLET_TOPUP' } });
      res.json({ success: true, order_id: order.id, id: order.id, amount, key_id: process.env.RAZORPAY_KEY_ID });
    } catch(e){ res.status(500).json({ error: e.message }); }
  });

  console.log('💳 Razorpay FINAL CLEAN mounted - 6 Plans + LIVE debug + /driver/subscription/order');
}

module.exports = mount;
