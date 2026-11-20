
// wallet_subscription.js - MERGED - Karnataka Namma Yatri Zero Commission Model
// Combines: subscription.js (admin config, GST, dues, gate) + wallet.js (earnings, balance, payouts, multi-plans)
// Mounted from index.js: const walletSub = require('./wallet_subscription'); walletSub(app, { redis, driverReg, io });

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const DEFAULTS = {
  enabled: true, // Namma Yatri model ON by default
  daily_fee_auto: 25,
  daily_fee_taxi: 35,
  per_ride_fee: 5,
  monthly_auto: 600,
  monthly_taxi: 800,
  gst_rate: 0.18,
  gst_inclusive: false,
  free_days: 7,
  trial_rides: 3,
  max_unpaid_days: 2,
  pay_instructions: 'Pay via UPI to your platform UPI ID - then admin marks as paid',
};

const PLANS = {
  DAILY_AUTO: { id: 'DAILY_AUTO', name: 'Auto Daily ₹25', vehicle_type: 'AUTO', price: 25, days: 1 },
  DAILY_TAXI: { id: 'DAILY_TAXI', name: 'Taxi Daily ₹35', vehicle_type: 'TAXI', price: 35, days: 1 },
  PER_RIDE: { id: 'PER_RIDE', name: 'Per Ride ₹5', vehicle_type: 'ANY', price: 5, days: 0 },
  MONTHLY_AUTO: { id: 'MONTHLY_AUTO', name: 'Auto Monthly ₹600', vehicle_type: 'AUTO', price: 600, days: 30 },
  MONTHLY_TAXI: { id: 'MONTHLY_TAXI', name: 'Taxi Monthly ₹800', vehicle_type: 'TAXI', price: 800, days: 30 },
};

const num = (v,d,lo,hi)=>{ const n=Number(v); return isFinite(n)?Math.min(Math.max(n,lo),hi):d; };
const round2 = x => Math.round(x*100)/100;
const todayIst = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
const nowIso = () => new Date().toISOString();
const addDays = (d, days)=>{ const x=new Date(d); x.setDate(x.getDate()+days); return x; };

function sanitize(i){
  i=i&&typeof i==='object'?i:{};
  return {
    enabled: i.enabled!==false,
    daily_fee_auto: num(i.daily_fee_auto, DEFAULTS.daily_fee_auto,0,1000),
    daily_fee_taxi: num(i.daily_fee_taxi, DEFAULTS.daily_fee_taxi,0,1000),
    per_ride_fee: num(i.per_ride_fee, DEFAULTS.per_ride_fee,0,100),
    monthly_auto: num(i.monthly_auto, DEFAULTS.monthly_auto,0,10000),
    monthly_taxi: num(i.monthly_taxi, DEFAULTS.monthly_taxi,0,10000),
    gst_rate: num(i.gst_rate, DEFAULTS.gst_rate,0,0.3),
    gst_inclusive: i.gst_inclusive===true,
    free_days: num(i.free_days, DEFAULTS.free_days,0,90),
    trial_rides: num(i.trial_rides, DEFAULTS.trial_rides,0,10),
    max_unpaid_days: num(i.max_unpaid_days, DEFAULTS.max_unpaid_days,0,14),
    pay_instructions: String(i.pay_instructions||'').slice(0,500),
  };
}

let cfgCache={at:0,value:sanitize({})};
async function getConfig(force=false){
  if(!force && Date.now()-cfgCache.at<30000) return cfgCache.value;
  let saved=null;
  if(supabase){
    try{ const {data}=await supabase.from('app_settings').select('value').eq('key','subscription').maybeSingle(); saved=data?data.value:null; }catch(e){}
  }
  cfgCache={at:Date.now(), value:sanitize(saved)};
  return cfgCache.value;
}

function dailyAmounts(cfg, vehicleType='AUTO'){
  const fee = vehicleType==='TAXI'?cfg.daily_fee_taxi:cfg.daily_fee_auto;
  if(cfg.gst_inclusive){
    const base=round2(fee/(1+cfg.gst_rate));
    return {base, gst:round2(fee-base), total:round2(fee)};
  }
  const gst=round2(fee*cfg.gst_rate);
  return {base:round2(fee), gst, total:round2(fee+gst)};
}

// Wallet helpers
async function getWallet(driver_id){
  if(!supabase) return null;
  const {data}=await supabase.from('driver_wallets').select('*').eq('driver_id',driver_id).maybeSingle();
  return data;
}
async function ensureWallet(driver_id, vehicle_type='AUTO'){
  if(!supabase) return null;
  let w=await getWallet(driver_id);
  if(w) return w;
  const nw={ driver_id, balance:0, total_earnings:0, total_rides:0, subscription_due:0, subscription_status:'ACTIVE', current_plan:null, plan_expires_at:null, vehicle_type, last_payout_at:null, trial_rides_left: DEFAULTS.trial_rides, created_at:nowIso(), updated_at:nowIso() };
  const {data}=await supabase.from('driver_wallets').insert(nw).select().maybeSingle();
  return data||nw;
}
async function addTxn(driver_id, ride_id, type, amount, balance_after, desc){
  if(!supabase) return;
  await supabase.from('wallet_transactions').insert({ id:crypto.randomUUID(), driver_id, ride_id, type, amount, balance_after, description:desc, created_at:nowIso() });
}
async function dues(driver_id){
  const {data}=await supabase.from('driver_charges').select('total_amount').eq('driver_id',driver_id).eq('status','DUE');
  const due=round2((data||[]).reduce((a,r)=>a+Number(r.total_amount),0));
  const {data:cr}=await supabase.from('driver_credit').select('balance').eq('driver_id',driver_id).maybeSingle();
  const credit=round2(cr?Number(cr.balance):0);
  return {due, credit, net_due:round2(Math.max(0,due-credit)), unpaid_days:(data||[]).length};
}

const seenToday=new Map();
const blockMsg=(d,a)=>`Platform fee dues of Rs ${d.net_due.toFixed(2)} are pending. Please pay to go online.`;

async function gate(driver){
  const cfg=await getConfig();
  if(!supabase || !cfg.enabled) return {ok:true};
  const day=todayIst();
  const d=await dues(driver.driver_id);
  const amounts=dailyAmounts(cfg, driver.vehicle_type);
  const verifiedAt=driver.verified_at?new Date(driver.verified_at):null;
  const freeUntil=verifiedAt?new Date(verifiedAt.getTime()+cfg.free_days*86400000):null;
  if(freeUntil && new Date()<freeUntil) return {ok:true, free_days_left:Math.ceil((freeUntil-new Date())/86400000)};
  if(seenToday.get(driver.driver_id)===day){
    return d.unpaid_days>cfg.max_unpaid_days && d.net_due>0 ? {ok:false, error:blockMsg(d,amounts)} : {ok:true};
  }
  if(d.unpaid_days>=cfg.max_unpaid_days && d.net_due>0) return {ok:false, error:blockMsg(d,amounts)};
  try{ const {error}=await supabase.rpc('ensure_daily_charge',{p_driver:driver.driver_id, p_date:day, p_base:amounts.base, p_gst:amounts.gst}); if(error) console.log('charge error',error.message); else seenToday.set(driver.driver_id,day); }catch(e){ console.log('gate rpc error',e.message); }
  return {ok:true};
}

async function summary(driver){
  const cfg=await getConfig();
  if(!supabase) return {enabled:false};
  const amounts=dailyAmounts(cfg, driver.vehicle_type);
  const d=await dues(driver.driver_id);
  const wallet=await ensureWallet(driver.driver_id, driver.vehicle_type);
  const since=new Date(Date.now()-90*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  const {data:charges}=await supabase.from('driver_charges').select('id,charge_date,total_amount,base_amount,gst_amount,status,note').eq('driver_id',driver.driver_id).gte('charge_date',since).order('charge_date',{ascending:false});
  const {data:payments}=await supabase.from('driver_payments').select('amount,method,reference,created_at').eq('driver_id',driver.driver_id).order('created_at',{ascending:false}).limit(20);
  const {data:txns}=await supabase.from('wallet_transactions').select('*').eq('driver_id',driver.driver_id).order('created_at',{ascending:false}).limit(20);
  const verifiedAt=driver.verified_at?new Date(driver.verified_at):null;
  const freeLeft=verifiedAt?Math.max(0,Math.ceil((verifiedAt.getTime()+cfg.free_days*86400000-Date.now())/86400000)):0;
  const blocked=cfg.enabled && freeLeft===0 && d.unpaid_days>=cfg.max_unpaid_days && d.net_due>0;
  return { enabled:cfg.enabled, daily_fee_auto:cfg.daily_fee_auto, daily_fee_taxi:cfg.daily_fee_taxi, gst_rate:cfg.gst_rate, daily_total:amounts.total, gst_inclusive:cfg.gst_inclusive, free_days_left:freeLeft, due:d.due, credit:d.credit, net_due:d.net_due, blocked, block_message:blocked?blockMsg(d,amounts):null, pay_instructions:cfg.pay_instructions, charges:charges||[], payments:payments||[], wallet, txns:txns||[], plans:PLANS, govt_note:'Karnataka: Zero commission, driver keeps full Govt fare ₹59' };
}

function adminOk(req){
  const pw=process.env.ADMIN_PASSWORD||'';
  const key=String(req.headers['x-admin-key']||'');
  if(!pw||key.length!==pw.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key),Buffer.from(pw));
}

function mount(app, ctx){
  const { requireDriver, invalidate, redis, driverReg, io }=ctx;
  const needDb=(req,res,next)=>(supabase?next():res.status(503).json({error:'Storage not configured'}));
  const adminGuard=(req,res,next)=>(!supabase?res.status(503).json({error:'Storage not configured'}):adminOk(req)?next():res.status(401).json({error:'Wrong admin password'}));

  async function driverFromReq(req){
    try{
      const token=(req.headers.authorization||'').replace('Bearer ','').trim();
      if(!token) return null;
      if(driverReg && driverReg.verifyDriverToken) return await driverReg.verifyDriverToken(token);
      const jwt=require('jsonwebtoken'); const secret=process.env.JWT_SECRET||''; if(!secret) return null;
      return jwt.verify(token,secret);
    }catch(e){ return null; }
  }

  // Driver: wallet + subscription summary
  app.get('/driver/wallet', needDb, async (req,res)=>{
    const driver=await driverFromReq(req);
    if(!driver) return res.status(401).json({error:'Login required'});
    const driver_id=driver.driver_id||driver.id;
    const driverRec={driver_id, vehicle_type:driver.vehicle_type||'AUTO', verified_at:driver.verified_at};
    res.json({success:true, ...(await summary(driverRec))});
  });

  app.get('/driver/subscription', needDb, requireDriver ? requireDriver : async (req,res,next)=>{ const d=await driverFromReq(req); if(!d) return res.status(401).json({error:'Login required'}); req.driver=d; next(); }, async (req,res)=>{
    res.json(await summary(req.driver));
  });

  app.get('/driver/wallet/history', needDb, async (req,res)=>{
    const driver=await driverFromReq(req);
    if(!driver) return res.status(401).json({error:'Login required'});
    const {data}=await supabase.from('wallet_transactions').select('*').eq('driver_id',driver.driver_id||driver.id).order('created_at',{ascending:false}).limit(50);
    res.json(data||[]);
  });

  app.post('/driver/subscription/activate', needDb, async (req,res)=>{
    const driver=await driverFromReq(req);
    if(!driver) return res.status(401).json({error:'Login required'});
    const driver_id=driver.driver_id||driver.id;
    const {plan_id, payment_id}=req.body||{};
    const plan=PLANS[plan_id];
    if(!plan) return res.status(400).json({error:'Invalid plan'});
    let wallet=await ensureWallet(driver_id, driver.vehicle_type);
    const expires=plan.days>0?addDays(new Date(), plan.days):null;
    await supabase.from('driver_wallets').update({current_plan:plan_id, plan_expires_at:expires?expires.toISOString():null, subscription_status:'ACTIVE', subscription_due:0, updated_at:nowIso()}).eq('driver_id',driver_id);
    await supabase.from('driver_subscriptions').insert({id:crypto.randomUUID(), driver_id, plan_id:plan.id, plan_name:plan.name, amount:plan.price, start_date:nowIso(), end_date:expires?expires.toISOString():null, status:'ACTIVE', payment_id:payment_id||null, created_at:nowIso()});
    await addTxn(driver_id,null,'SUBSCRIPTION_CHARGE',-plan.price,wallet.balance,`Subscription ${plan.name} ₹${plan.price}`);
    console.log(`💳 Driver ${driver_id} activated ${plan_id} ₹${plan.price}`);
    res.json({success:true, plan, expires_at:expires});
  });

  // Admin: config
  app.get('/admin/api/subscription', adminGuard, async (req,res)=> res.json({config:await getConfig(true), amounts:dailyAmounts(await getConfig())}));
  app.post('/admin/api/subscription', adminGuard, async (req,res)=>{
    const clean=sanitize(req.body&&req.body.config);
    const {error}=await supabase.from('app_settings').upsert({key:'subscription', value:clean, updated_at:nowIso()},{onConflict:'key'});
    if(error) return res.status(500).json({error:'Could not save: '+error.message});
    cfgCache={at:Date.now(), value:clean}; seenToday.clear();
    console.log('💳 Subscription settings updated', clean);
    res.json({success:true, config:clean, amounts:dailyAmounts(clean)});
  });

  app.get('/admin/api/subscription/dues', adminGuard, async (req,res)=>{
    const {data:rows}=await supabase.from('driver_charges').select('driver_id,total_amount,charge_date').eq('status','DUE');
    const by={}; for(const r of rows||[]){ const x=(by[r.driver_id]=by[r.driver_id]||{driver_id:r.driver_id, due:0, days:0, oldest:r.charge_date}); x.due=round2(x.due+Number(r.total_amount)); x.days+=1; if(r.charge_date<x.oldest) x.oldest=r.charge_date; }
    const ids=Object.keys(by);
    const {data:drivers}=ids.length?await supabase.from('drivers').select('driver_id,name,phone,vehicle_type,vehicle_number').in('driver_id',ids):{data:[]};
    const {data:credits}=ids.length?await supabase.from('driver_credit').select('driver_id,balance').in('driver_id',ids):{data:[]};
    const cr=Object.fromEntries((credits||[]).map(c=>[c.driver_id, Number(c.balance)]));
    const dr=Object.fromEntries((drivers||[]).map(d=>[d.driver_id,d]));
    res.json(ids.map(id=>({...by[id], credit:cr[id]||0, driver:dr[id]||{driver_id:id}})).sort((a,b)=>b.due-a.due));
  });

  app.post('/admin/api/drivers/:id/payment', adminGuard, async (req,res)=>{
    const amount=Number((req.body||{}).amount);
    if(!isFinite(amount)||amount<=0||amount>100000) return res.status(400).json({error:'Enter amount 1-100000'});
    const reference=String((req.body||{}).reference||'').trim().slice(0,60)||null;
    const note=String((req.body||{}).note||'').trim().slice(0,100)||null;
    const {data,error}=await supabase.rpc('apply_payment',{p_driver:req.params.id, p_amount:amount, p_method:'MANUAL', p_reference:reference, p_note:note});
    if(error) return res.status(500).json({error:error.message});
    if(invalidate) invalidate(req.params.id);
    seenToday.delete(req.params.id);
    console.log(`💰 Payment recorded ${req.params.id} Rs ${amount}`);
    res.json({success:true, credit_balance:data});
  });

  app.post('/admin/api/charges/:id/waive', adminGuard, async (req,res)=>{
    const {data,error}=await supabase.from('driver_charges').update({status:'WAIVED', note:String((req.body||{}).note||'Waived').slice(0,100)}).eq('id',req.params.id).eq('status','DUE').select('driver_id').maybeSingle();
    if(error) return res.status(500).json({error:error.message});
    if(data && invalidate) invalidate(data.driver_id);
    res.json({success:true});
  });

  app.post('/admin/payouts/run', adminGuard, async (req,res)=>{
    const {data:wallets}=await supabase.from('driver_wallets').select('*').gt('balance',99);
    let paid=[];
    for(const w of (wallets||[])){
      console.log(`💸 Payout driver ${w.driver_id} ₹${w.balance} - integrate Cashfree Payout`);
      await addTxn(w.driver_id,null,'PAYOUT',-w.balance,0,`Payout ₹${w.balance}`);
      await supabase.from('driver_wallets').update({balance:0, last_payout_at:nowIso(), updated_at:nowIso()}).eq('driver_id',w.driver_id);
      paid.push({driver_id:w.driver_id, amount:w.balance});
    }
    res.json({success:true, paid, count:paid.length, note:'Integrate Cashfree Payouts API: POST https://payout-api.cashfree.com/payout/v1/requestTransfer'});
  });

  // Hooks for index.js
  mount.creditRide = async (ride)=>{
    if(!ride||!ride.driver_id||!ride.fare) return;
    try{
      const driver_id=ride.driver_id; const fare=Number(ride.fare)||0;
      let wallet=await ensureWallet(driver_id, ride.vehicle_type);
      const earning=fare; // zero commission
      let newBalance=Number(wallet.balance)+earning;
      let newEarnings=Number(wallet.total_earnings)+earning;
      let newRides=Number(wallet.total_rides)+1;
      let trialLeft=wallet.trial_rides_left||0;
      if(trialLeft>0) trialLeft--;
      else if(wallet.current_plan==='PER_RIDE'){
        newBalance-=5; await addTxn(driver_id, ride.ride_id, 'SUBSCRIPTION_CHARGE', -5, newBalance, 'Per ride fee ₹5');
      }
      await supabase.from('driver_wallets').update({balance:newBalance, total_earnings:newEarnings, total_rides:newRides, trial_rides_left:trialLeft, updated_at:nowIso()}).eq('driver_id',driver_id);
      await addTxn(driver_id, ride.ride_id, 'EARNING', earning, newBalance, `Ride ${ride.ride_id} Govt Fare ₹${fare} (Full)`);
      console.log(`💰 Wallet credited ${driver_id} ₹${earning} balance ₹${newBalance}`);
      if(io) io.emit('wallet:update',{driver_id, balance:newBalance, earning});
    }catch(e){ console.log('wallet credit error',e.message); }
  };

  mount.canAcceptRide = async (driver_id)=>{
    let wallet=await ensureWallet(driver_id);
    if(!wallet) return {ok:true};
    if((wallet.trial_rides_left||0)>0) return {ok:true, trial:true};
    if(wallet.plan_expires_at){
      const expired=new Date(wallet.plan_expires_at)<new Date();
      if(expired){
        const daysExpired=Math.floor((new Date()-new Date(wallet.plan_expires_at))/86400000);
        if(daysExpired>3) return {ok:false, reason:'Subscription expired '+daysExpired+' days ago. Pay ₹25 to continue.'};
        return {ok:true, warning:'Subscription expired, please renew soon'};
      }
    }
    // Also check dues table
    try{ const d=await dues(driver_id); const cfg=await getConfig(); if(d.unpaid_days>=cfg.max_unpaid_days && d.net_due>0) return {ok:false, reason:`Platform fee dues Rs ${d.net_due.toFixed(2)} pending. Pay to go online.`}; }catch(e){}
    return {ok:true};
  };

  mount.gate=gate;
  mount.summary=summary;
  mount.canAcceptRide=mount.canAcceptRide;

  console.log('💰 Wallet+Subscription merged loaded - Zero commission ₹25/day, GST, Earnings, Payouts');
}

module.exports = mount;
