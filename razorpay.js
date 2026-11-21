
// razorpay.js - Phase 3 - Rider UPI Direct + Driver Subscription Autopay
// Mounted from index.js: const razor = require('./razorpay'); razor(app, { supabase, redis, driverReg, io })

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const PLANS = {
  DAILY_AUTO: { id: 'DAILY_AUTO', name: 'Auto Daily', vehicle_type: 'AUTO', price: 25, days: 1 },
  DAILY_TAXI: { id: 'DAILY_TAXI', name: 'Taxi Daily', vehicle_type: 'TAXI', price: 35, days: 1 },
  PER_RIDE: { id: 'PER_RIDE', name: 'Per Ride', vehicle_type: 'ANY', price: 5, days: 0 },
  MONTHLY_AUTO: { id: 'MONTHLY_AUTO', name: 'Auto Monthly', vehicle_type: 'AUTO', price: 600, days: 30 },
  MONTHLY_TAXI: { id: 'MONTHLY_TAXI', name: 'Taxi Monthly', vehicle_type: 'TAXI', price: 800, days: 30 },
};

let razorpay = null;
function getRazor() {
  if (razorpay) return razorpay;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    console.log('⚠️ Razorpay keys not set - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Render env');
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

  // --- Rider: Create payment order for ride (UPI direct - zero commission) ---
  app.post('/rider/payment/order', async (req, res) => {
    const rz = getRazor();
    if (!rz) {
      console.log('❌ RAZORPAY KEYS MISSING - check Render env RAZORPAY_KEY_ID/SECRET');
      return res.status(500).json({ error: 'Razorpay not configured - missing keys in Render env', configured: false });
    }
    try {
      const { ride_id, amount, customer_phone, driver_id } = req.body;
      if (!amount || !ride_id) return res.status(400).json({ error: 'ride_id and amount required' });
      // Karnataka Govt fare - ensure amount matches locked quote
      const amtPaise = Math.round(Number(amount) * 100);
      if (amtPaise < 100) return res.status(400).json({ error: 'Invalid amount' });

      const order = await rz.orders.create({
        amount: amtPaise,
        currency: 'INR',
        receipt: `ride_${ride_id}_${Date.now()}`,
        notes: { ride_id, driver_id: driver_id || '', customer_phone: customer_phone || '', govt_fare: 'Karnataka compliant', zero_commission: 'true' }
      });

      console.log(`💳 Razorpay order created for ride ${ride_id} ₹${amount} order_id ${order.id}`);
      res.json({ success: true, order_id: order.id, amount: amount, amount_paise: amtPaise, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID, ride_id });
    } catch (e) {
      console.log('Razorpay order error', e.message, e.stack);
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // Rider: Verify payment after UPI
  app.post('/rider/payment/verify', async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, ride_id, driver_id, amount } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing Razorpay fields' });

      const secret = process.env.RAZORPAY_KEY_SECRET || '';
      const generated = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      if (generated !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

      // Credit driver wallet full fare (zero commission)
      if (supabase && driver_id) {
        const wallet = await ensureWallet(driver_id);
        const newBalance = Number(wallet.balance || 0) + Number(amount || 0);
        const newEarnings = Number(wallet.total_earnings || 0) + Number(amount || 0);
        const newRides = Number(wallet.total_rides || 0) + 1;
        await supabase.from('driver_wallets').update({ balance: newBalance, total_earnings: newEarnings, total_rides: newRides, updated_at: nowIso() }).eq('driver_id', driver_id);
        await addTxn(driver_id, ride_id, 'EARNING', Number(amount), newBalance, `Ride ${ride_id} Govt fare ₹${amount} via Razorpay UPI`);

        // Update rides table if exists
        try { await supabase.from('rides').update({ payment_status: 'PAID', payment_id: razorpay_payment_id, paid_at: nowIso() }).eq('ride_id', ride_id); } catch(_){}
      }

      console.log(`✅ Payment verified ride ${ride_id} driver ${driver_id} ₹${amount} payment ${razorpay_payment_id}`);
      res.json({ success: true, verified: true, ride_id, driver_id, amount });
    } catch (e) {
      console.log('Verify error', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // --- Driver: Wallet Recharge Order ---
  app.post('/driver/wallet/recharge/order', async (req, res) => {
    const rz = getRazor(); if (!rz) return res.status(500).json({ error: 'Razorpay not configured' });
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { amount } = req.body; // amount in INR
      if (!amount || Number(amount) < 1) return res.status(400).json({ error: 'Min ₹1' });
      const order = await rz.orders.create({ amount: Math.round(Number(amount)*100), currency: 'INR', receipt: `wallet_${driver.driver_id}_${Date.now()}`, notes: { driver_id: driver.driver_id, type: 'WALLET_TOPUP' } });
      res.json({ success: true, order_id: order.id, amount, key_id: process.env.RAZORPAY_KEY_ID });
    } catch(e){ res.status(500).json({ error: e.message }); }
  });

  app.post('/driver/wallet/recharge/verify', async (req, res) => {
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
      const secret = process.env.RAZORPAY_KEY_SECRET || '';
      const gen = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      if (gen !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });
      const wallet = await ensureWallet(driver.driver_id, driver.vehicle_type);
      const newBal = Number(wallet.balance || 0) + Number(amount);
      await supabase.from('driver_wallets').update({ balance: newBal, updated_at: nowIso() }).eq('driver_id', driver.driver_id);
      await addTxn(driver.driver_id, null, 'TOPUP', Number(amount), newBal, `Wallet recharge ₹${amount} via Razorpay`);
      res.json({ success: true, balance: newBal });
    } catch(e){ res.status(500).json({ error: e.message }); }
  });

  // --- Driver: Subscription Payment via Razorpay ---
  app.post('/driver/subscription/razorpay/order', async (req, res) => {
    const rz = getRazor(); if (!rz) return res.status(500).json({ error: 'Razorpay not configured' });
    const driver = await driverFromReq(req); if (!driver) return res.status(401).json({ error: 'Login required' });
    try {
      const { plan_id } = req.body;
      const plan = PLANS[plan_id];
      if (!plan) return res.status(400).json({ error: 'Invalid plan_id' });
      const order = await rz.orders.create({
        amount: Math.round(plan.price * 100),
        currency: 'INR',
        receipt: `sub_${driver.driver_id}_${plan_id}_${Date.now()}`,
        notes: { driver_id: driver.driver_id, plan_id, plan_name: plan.name, type: 'SUBSCRIPTION' }
      });
      console.log(`💳 Subscription order driver ${driver.driver_id} plan ${plan_id} ₹${plan.price} order ${order.id}`);
      res.json({ success: true, order_id: order.id, plan, key_id: process.env.RAZORPAY_KEY_ID });
    } catch(e){ res.status(500).json({ error: e.message }); }
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

      console.log(`✅ Subscription verified driver ${driver_id} plan ${plan_id} payment ${razorpay_payment_id}`);
      res.json({ success: true, plan, expires_at: expires, payment_id: razorpay_payment_id });
    } catch(e){ console.log('Sub verify error', e.message); res.status(500).json({ error: e.message }); }
  });

  // Webhook for auto-capture (uses json body - raw would conflict with global express.json)
  app.post('/razorpay/webhook', async (req, res) => {
    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
      if (webhookSecret) {
        const signature = req.headers['x-razorpay-signature'];
        const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
        if (signature !== expected) return res.status(400).json({ error: 'Invalid webhook signature' });
      }
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      console.log('🔔 Razorpay webhook', payload.event);
      res.json({ status: 'ok' });
    } catch(e){ res.status(400).json({ error: e.message }); }
  });

  console.log('💳 Razorpay module mounted - Rider UPI Direct + Subscription Autopay');
}

module.exports = mount;
