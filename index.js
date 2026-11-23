const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const crypto = require('crypto');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Redis
const redis = new Redis(process.env.REDIS_URL || undefined, process.env.REDIS_URL ? { tls: {} } : {});
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.log('Redis error:', err.message));

// Supabase global for UPI routes
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
global.supabase = supabase;
if (!supabase) console.log('⚠️ Supabase not configured');

// In-memory rides + driver presence
const rides = new Map();
global.onlineDrivers = {};

// driver registration, document upload and admin verification
const driverReg = require('./driver_registration');
driverReg(app, io);

// customer accounts (phone + PIN login)
const customerAcc = require('./customer_accounts');
customerAcc(app);

// Karnataka fares: route, breakdown, locked quote - surge capped at 1.0 per Rule 129
const pricing = require('./pricing');
pricing(app, { redis, customerAcc, rides: () => Array.from(rides.values()) });

// ---------- Landing Page for Razorpay Website Approval ----------
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UrbanRide - Karnataka Govt Compliant Ride Booking</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:Inter,system-ui,sans-serif}
body{background:#f8fafc;color:#1e293b;line-height:1.6}
.hero{background:linear-gradient(135deg,#16a34a,#15803d);color:white;padding:60px 20px;text-align:center}
.hero h1{font-size:42px;margin-bottom:12px}
.hero p{font-size:18px;opacity:.9}
.container{max-width:1000px;margin:0 auto;padding:40px 20px}
.card{background:white;border-radius:16px;padding:28px;margin:20px 0;box-shadow:0 4px 20px rgba(0,0,0,.06);border:1px solid #e2e8f0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.badge{background:#dcfce7;color:#166534;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600;display:inline-block;margin:4px}
h2{color:#15803d;margin-bottom:16px} h3{margin-bottom:8px} ul{padding-left:20px}
.footer{background:#1e293b;color:#94a3b8;padding:30px 20px;text-align:center;margin-top:40px}
a{color:#16a34a;text-decoration:none}
.btn{background:#16a34a;color:white;padding:12px 24px;border-radius:8px;display:inline-block;margin:10px 10px 0 0;font-weight:600}
</style>
</head>
<body>
<div class="hero">
<h1>🚕 UrbanRide</h1>
<p>Karnataka Government Fare Compliant • Zero Commission for Drivers</p>
<p style="margin-top:10px"><span class="badge">GOVT APPROVED FARES</span> <span class="badge">AUTO Rs36 + Rs18/km</span> <span class="badge">TAXI Rs100 + Rs24/km</span> <span class="badge">Razorpay Secured</span></p>
</div>
<div class="container">
<div class="card">
<h2>About UrbanRide</h2>
<p>UrbanRide is a Karnataka-compliant ride booking platform for Auto and Taxi drivers. We follow <b>Karnataka Motor Vehicles Rules, Rule 129 - Fare Chart</b> with surge capped at 1.0x. Drivers receive 100% of ride fare directly to their bank via UPI QR - zero commission model.</p>
<p style="margin-top:12px">Platform fee: Rs25 Auto / Rs35 Taxi per day for app usage. Payments powered by Razorpay.</p>
<a href="#contact" class="btn">Driver App</a>
<a href="#contact" class="btn" style="background:white;color:#16a34a;border:1px solid #16a34a">Customer App</a>
</div>
<div class="grid">
<div class="card"><h3>🚖 For Drivers</h3><ul><li>100% fare direct to your bank via UPI</li><li>Daily subscription Rs25 Auto, Rs35 Taxi</li><li>Govt fare, no surge exploitation</li><li>RC, DL, Permit verification</li></ul></div>
<div class="card"><h3>🧑‍💼 For Customers</h3><ul><li>Govt fixed fares - no hidden charges</li><li>UPI payment direct to driver</li><li>Trip PIN verification</li><li>Live tracking</li></ul></div>
<div class="card"><h3>💳 Payments</h3><ul><li>Ride fare: UPI direct to driver bank</li><li>Platform fee: Razorpay UPI to UrbanRide</li><li>Secure, RBI compliant</li><li>Instant settlement</li></ul></div>
</div>
<div class="card" id="contact">
<h2>Contact & Business Details</h2>
<p><b>Business Name:</b> UrbanRide</p>
<p><b>Business Type:</b> Individual - Transportation Service</p>
<p><b>Website:</b> https://saas-backend-avz2.onrender.com</p>
<p><b>Contact:</b> rajesh.keshavan@okaxis / 9886180011</p>
<p><b>Address:</b> No 7, SK Nivas, Muneshwara Temple Street, Subbanna Palayam, MS Nagar PO, Bangalore 560033, Karnataka, India</p>
<p><b>Service Area:</b> Karnataka - Bengaluru Urban</p>
<br><h3>Policies</h3><p><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms</a> | <a href="/refund">Refund & Cancellation</a> | <a href="/contact">Contact Us</a></p>
</div>
<div class="card">
<h2>How It Works</h2>
<p><b>1.</b> Customer books ride - fare per Karnataka govt chart<br>
<b>2.</b> Driver accepts - arrives at pickup<br>
<b>3.</b> Trip PIN verified - ride starts<br>
<b>4.</b> Ride completes - customer scans driver's UPI QR - amount goes direct to driver's bank<br>
<b>5.</b> Driver pays daily platform fee Rs25 via Razorpay UPI to UrbanRide</p>
</div>
</div>
<div class="footer"><p>UrbanRide © 2026 - Karnataka Govt Fare Compliant</p><p>Backend API: /health, /fare/quote, /rides/* | Razorpay Integrated | Supabase Secured</p><p style="margin-top:10px"><a href="/privacy" style="color:#94a3b8">Privacy</a> | <a href="/terms" style="color:#94a3b8">Terms</a> | <a href="/health/razorpay" style="color:#94a3b8">Razorpay Status</a> | <a href="/health">Health</a></p></div>
</body>
</html>`;

app.get('/', (req, res) => {
  // Serve landing page for browser, JSON for API check
  const accept = req.headers.accept || '';
  if (accept.includes('text/html') || !accept.includes('application/json')) {
    res.set('Content-Type','text/html').send(LANDING_HTML);
  } else {
    res.json({ status: 'UrbanRide Backend - Running', version: 'Karnataka Fares v2', razorpay: !!process.env.RAZORPAY_KEY_ID });
  }
});

app.get('/privacy', (req,res)=>res.send('<h1>Privacy Policy - UrbanRide</h1><p>We collect phone, location, ride data for service. UPI IDs stored securely in Supabase. No data sold. Data retained per legal requirements. Contact: 9886180011</p><p>Last updated: Nov 2026</p><br><a href="/">Home</a>'));
app.get('/terms', (req,res)=>res.send('<h1>Terms of Service - UrbanRide</h1><p>Drivers must have valid DL, RC, Permit, Insurance. Fares per Karnataka Govt notification. Platform fee Rs25/35 daily non-refundable unless service down >24h. Zero commission model - ride fare direct to driver.</p><br><a href="/">Home</a>'));
app.get('/refund', (req,res)=>res.send('<h1>Refund & Cancellation Policy - UrbanRide</h1><p>Platform fee Rs25/35 daily: Refund if service not usable for >24h due to technical issue, processed via Razorpay within 5-7 days. Ride fare: Direct between customer and driver via UPI, not held by UrbanRide, so no refund via platform. Cancellation: Ride can be cancelled before driver arrival without charge.</p><p>Contact: 9886180011 / rajesh.keshavan@okaxis</p><br><a href="/">Home</a>'));
app.get('/contact', (req,res)=>res.send('<h1>Contact Us - UrbanRide</h1><p><b>UrbanRide</b><br>Phone: 9886180011<br>Email: rajesh.keshavan@okaxis<br>Address: No 7, SK Nivas, Muneshwara Temple Street, Subbanna Palayam, MS Nagar PO, Bangalore 560033, Karnataka, India<br>Business: Individual - Transportation</p><br><a href="/">Home</a>'));
app.get('/health', (req,res)=>res.json({ ok:true, time: new Date().toISOString(), redis: redis.status, supabase: !!supabase }));

// the one-time trip PIN must never be sent to drivers
const publicRide = (ride) => {
  if (!ride) return ride;
  const { customer_pin, ...rest } = ride;
  return rest;
};

// Render restarts wipe in-memory Map, fallback to Redis
async function getRide(id) {
  let ride = rides.get(id);
  if (ride) return ride;
  try {
    const data = await redis.hget('tenant:TENANT_01:rides', id);
    if (data) {
      ride = JSON.parse(data);
      rides.set(id, ride);
      return ride;
    }
  } catch (e) {}
  return null;
}

app.get('/nearest', async (req, res) => {
  const { tenant_id, lat, lng, radius_km = 3 } = req.query;
  if (!tenant_id || !lat || !lng) return res.status(400).json({ error: "Missing params" });
  try {
    const key = `tenant:${tenant_id}:drivers:geo`;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusNum = parseFloat(radius_km);
    const raw = await new Promise((resolve, reject) => {
      redis.send_command('georadius', [key, lngNum.toString(), latNum.toString(), radiusNum.toString(), 'km', 'WITHCOORD', 'WITHDIST', 'ASC'], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    const drivers = raw.map(r => ({
      driver_id: r[0],
      distance_km: parseFloat(r[1]),
      lng: parseFloat(r[2][0]),
      lat: parseFloat(r[2][1])
    }));
    res.json({ tenant_id, center: { lat: latNum, lng: lngNum }, radius_km: radiusNum, drivers, count: drivers.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/drivers', async (req, res) => {
  try {
    const driverKeys = await redis.keys('driver:*:location');
    let drivers = [];
    for (let key of driverKeys) {
      const data = await redis.hgetall(key);
      if (data && data.lat) {
        let driverId = key.split(':')[1];
        drivers.push({
          driver_id: driverId,
          lat: parseFloat(data.lat),
          lng: parseFloat(data.lng),
          last_seen: data.updated_at,
          online: true
        });
      }
    }
    for (let id in global.onlineDrivers) {
      if (!drivers.find(d => d.driver_id === id)) {
        drivers.push(global.onlineDrivers[id]);
      }
    }
    res.json(drivers);
  } catch (e) {
    console.log('drivers error', e.message);
    res.json([]);
  }
});

app.post('/customer/register', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone || phone.length != 10) return res.status(400).json({ error: "10 digit phone required" });
    let existing = await redis.hgetall(`customer:${phone}`);
    if (existing && existing.pin) {
      return res.json({ phone, pin: existing.pin, existing: true });
    }
    let pin = Math.floor(1000 + Math.random() * 9000).toString();
    await redis.hset(`customer:${phone}`, { pin, phone, created: new Date().toISOString() });
    console.log(`📱 Customer ${phone} PIN ${pin}`);
    res.json({ phone, pin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/driver/:id/selfie', async (req, res) => {
  console.log(`📸 Selfie received for ${req.params.id}`);
  res.json({ verified: true, driver_id: req.params.id });
});

app.post('/driver/location', async (req, res) => {
  const { driver_id, lat, lng } = req.body;
  if (!driver_id || !lat || !lng) return res.status(400).json({ error: "Missing" });
  if (process.env.REQUIRE_VERIFIED_DRIVERS === 'true') {
    const chk = await driverReg.onlineCheck(req);
    if (!chk.ok) return res.status(403).json({ error: chk.error, issues: chk.issues || [] });
  }
  await redis.hset(`driver:${driver_id}:location`, { lat, lng, updated_at: Date.now() });
  global.onlineDrivers[driver_id] = { driver_id, lat, lng, last_seen: Date.now(), online: true };
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);
  socket.on('driver:location:update', async (data) => {
    try {
      const { tenant_id, driver_id, lat, lng } = data;
      if (!driver_id || !lat || !lng) return;
      await redis.hset(`driver:${driver_id}:location`, { lat, lng, updated_at: Date.now() });
      global.onlineDrivers[driver_id] = { driver_id, lat, lng, last_seen: Date.now(), online: true };
      const key = `tenant:${tenant_id || 'TENANT_01'}:drivers:geo`;
      await redis.geoadd(key, lng, lat, driver_id);
      io.emit('driver:location', { driver_id, lat, lng });
    } catch (e) {
      console.log('location error', e.message);
    }
  });
  socket.on('join:ride', (ride_id) => {
    socket.join(ride_id);
  });
});

// ---------- RIDES ----------
app.post('/rides/request', async (req, res) => {
  const cust = await customerAcc.customerFromReq(req);
  if (!cust) return res.status(401).json({ error: 'Please log in again' });
  const { tenant_id, from, to, distance_km: client_distance, fare: client_fare, vehicle_type, eta_min, booked_for_other, passenger_name, passenger_phone, quote_id } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Pickup and drop are required' });

  let fareData = null;
  let locked = null;
  if (quote_id) {
    locked = await pricing.takeQuote(redis, quote_id, cust.customer_id);
    if (locked) {
      fareData = { total: locked.total, breakdown: locked.breakdown, distance_km: locked.distance_km, duration_min: locked.duration_min };
      console.log(`🔒 Using locked quote ${quote_id} fare ₹${locked.total} for ${cust.customer_id}`);
    }
  }
  if (!fareData) {
    if (client_distance && client_fare) {
      console.log(`⚠️ No locked quote, using client values distance ${client_distance} fare ${client_fare}`);
      fareData = { total: Number(client_fare), breakdown: null, distance_km: Number(client_distance) };
    } else {
      return res.status(400).json({ error: 'Please get fare quote first: POST /fare/quote with from/to' });
    }
  }

  const ride_id = `RIDE_${Date.now()}`;
  const customer_pin = String(crypto.randomInt(1000, 10000));
  const ride = {
    ride_id,
    tenant_id: tenant_id || 'TENANT_01',
    customer_id: cust.customer_id,
    customer_phone: cust.phone,
    customer_name: cust.name,
    customer_pin,
    from, to,
    distance_km: fareData.distance_km,
    duration_min: fareData.duration_min || null,
    fare: fareData.total,
    fare_breakdown: fareData.breakdown,
    vehicle_type: locked?.vehicle_type || vehicle_type || 'TAXI',
    eta_min: eta_min || null,
    booked_for_other: booked_for_other === true,
    passenger_name: passenger_name || null,
    passenger_phone: passenger_phone || null,
    status: 'REQUESTED',
    driver_id: null,
    created_at: new Date().toISOString()
  };
  rides.set(ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride_id, JSON.stringify(ride));
  console.log(`🚕 Ride ${ride_id} customer ${cust.customer_id} Fare ₹${fareData.total} ${locked ? '(locked)' : '(client fallback)'}`);
  io.emit('ride:request', publicRide(ride));
  res.json({ success: true, ride });
});

app.post('/rides/:id/accept', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { driver_id } = req.body;
  if (ride.status !== 'REQUESTED') return res.status(409).json({ error: 'Ride already taken or cancelled' });
  ride.status = 'ACCEPTED';
  ride.driver_id = driver_id;
  try {
    const dr = await driverReg.lookupDriver(driver_id);
    if (dr) {
      ride.driver_name = dr.name;
      ride.vehicle_number = dr.vehicle_number;
      ride.driver_verified = dr.status === 'VERIFIED';
    }
  } catch (e) {}
  ride.accepted_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:accepted', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.post('/rides/:id/decline', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'DECLINED';
  io.emit('ride:declined', publicRide(ride));
  res.json({ success: true });
});

app.post('/rides/:id/cancel', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { cancelled_by, reason } = req.body;
  ride.status = 'CANCELLED';
  ride.cancelled_by = cancelled_by || 'unknown';
  ride.cancel_reason = reason || 'No reason';
  ride.cancelled_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`❌ Ride ${ride.ride_id} cancelled by ${ride.cancelled_by}: ${ride.cancel_reason}`);
  io.emit('ride:cancelled', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.post('/rides/:id/arrived', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'ARRIVED';
  ride.arrived_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:arrived', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.post('/rides/:id/start', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { pin } = req.body;
  if (!pin || String(pin) !== String(ride.customer_pin)) {
    return res.status(400).json({ error: 'Wrong PIN. Ask the customer for their 4 digit trip PIN.' });
  }
  ride.status = 'STARTED';
  ride.started_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:started', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.post('/rides/:id/complete', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'COMPLETED';
  ride.completed_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:completed', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.get('/rides/:id', async (req, res) => {
  let ride = rides.get(req.params.id);
  if (!ride) {
    try {
      const data = await redis.hget('tenant:TENANT_01:rides', req.params.id);
      if (data) ride = JSON.parse(data);
    } catch(e) {}
  }
  if (!ride) return res.status(404).json({error: 'Not found'});
  const cust = await customerAcc.customerFromReq(req);
  if (cust && cust.customer_id === ride.customer_id) return res.json(ride);
  res.json(publicRide(ride));
});

app.get('/rides', async (req, res) => {
  try {
    const allRedis = await redis.hgetall('tenant:TENANT_01:rides');
    const redisRides = Object.values(allRedis).map(v => { try { return JSON.parse(v); } catch(e) { return null; } }).filter(Boolean);
    const memRides = Array.from(rides.values());
    const merged = new Map();
    redisRides.forEach(r => merged.set(r.ride_id, r));
    memRides.forEach(r => merged.set(r.ride_id, r));
    res.json(Array.from(merged.values()).map(publicRide));
  } catch(e) {
    res.json(Array.from(rides.values()).map(publicRide));
  }
});

// ---- Razorpay + Wallet/Subscription ----
try {
  const razor = require('./razorpay');
  razor(app, { supabase, redis, driverReg, io });
  console.log('✅ Razorpay mounted: /rider/payment/order + /rider/payment/verify');
} catch(e) { console.log('Razorpay mount error', e.message); }

try {
  let walletSub = null;
  try { walletSub = require('./wallet_subscription_merged'); } 
  catch(e1) { 
    try { walletSub = require('./wallet_subscription'); }
    catch(e2) {
      try { walletSub = require('./wallet'); } catch(e3) { console.log('Wallet optional - not found, skipping'); }
    }
  }
  if (walletSub) {
    if (typeof walletSub === 'function') {
      walletSub(app, { supabase, redis, driverReg, io });
      console.log('✅ Wallet/Sub mounted');
    } else if (walletSub && typeof walletSub.mount === 'function') {
      walletSub.mount(app, { supabase, redis, driverReg, io });
      console.log('✅ Wallet/Sub mounted via .mount');
    }
  }
} catch(e) {
  console.log('Wallet mount error', e.message);
}

// Health check for razorpay keys
app.get('/health/razorpay', (req,res)=>{
  const hasKey = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  res.json({ configured: hasKey, key_id_present: !!process.env.RAZORPAY_KEY_ID, key_prefix: (process.env.RAZORPAY_KEY_ID||'').substring(0,8), mode: (process.env.RAZORPAY_KEY_ID||'').startsWith('rzp_live')?'LIVE': hasKey?'TEST':'MISSING_KEYS' });
});

// Driver UPI direct to bank - zero commission
app.post('/driver/upi', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({error: 'Login required'});
    if (!supabase) return res.status(500).json({error: 'Supabase not configured'});
    
    let driver = null;
    try { driver = await driverReg.verifyDriverToken(token); } catch(_){}
    if (!driver) {
      try { const jwt = require('jsonwebtoken'); driver = jwt.verify(token, process.env.JWT_SECRET || ''); } catch(_){}
    }
    if (!driver) return res.status(401).json({error: 'Invalid token'});
    
    const driver_id = driver.driver_id || driver.id;
    const { upi_id } = req.body;
    if (!upi_id || !upi_id.includes('@')) return res.status(400).json({error: 'Valid UPI ID required e.g. 9886180011@ybl'});
    
    const { data, error } = await supabase.from('drivers').update({ upi_id: upi_id.trim(), updated_at: new Date().toISOString() }).eq('driver_id', driver_id).select().maybeSingle();
    if (error) {
      console.log('UPI save error', error.message);
      return res.status(500).json({error: error.message});
    }
    console.log(`✅ Driver ${driver_id} UPI saved ${upi_id}`);
    res.json({success: true, driver_id, upi_id: upi_id.trim()});
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

app.get('/driver/upi/:id', async (req, res) => {
  try {
    if (!supabase) return res.json({upi_id: null});
    const { data } = await supabase.from('drivers').select('driver_id, upi_id').eq('driver_id', req.params.id).maybeSingle();
    res.json(data || {upi_id: null});
  } catch(e) { res.json({upi_id: null}); }
});




const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });
const ALL_DOCS = ['SELFIE','DL','RC','AADHAAR','PERMIT','INSURANCE','POLICE','FITNESS'];

// GET /driver/me - returns documents for app
app.get('/driver/me', async (req, res) => {
  try {
    const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!auth) return res.status(401).json({ error: 'No token' });
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const { data: driver } = await supabase.from('drivers').select('*').eq('driver_id', auth).maybeSingle();
    if (!driver) return res.status(401).json({ error: 'Driver not found' });
    const { data: docs } = await supabase.from('driver_documents').select('doc_type,status,uploaded_at,storage_path').eq('driver_id', auth);
    const { data: comp } = await supabase.from('driver_compliance').select('*').eq('driver_id', auth).maybeSingle();
    res.json({ driver, documents: docs || [], compliance: comp || {}, required: ['SELFIE','DL','RC','AADHAAR'], optional: ['PERMIT','INSURANCE','POLICE','FITNESS'] });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /driver/docs/:type/url - signed URL
app.get('/driver/docs/:type/url', async (req, res) => {
  try {
    const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const type = String(req.params.type).toUpperCase();
    if (!ALL_DOCS.includes(type)) return res.status(400).json({ error: 'Unknown doc type ' + type });
    if (!auth) return res.status(401).json({ error: 'No token' });
    const { data: doc } = await supabase.from('driver_documents').select('storage_path,doc_type,status').eq('driver_id', auth).eq('doc_type', type).maybeSingle();
    if (!doc || !doc.storage_path) return res.status(404).json({ error: 'Document not found for ' + type });
    const { data: signed, error: signErr } = await supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').createSignedUrl(doc.storage_path, 60*5);
    if (signErr) return res.status(500).json({ error: signErr.message });
    res.json({ url: signed.signedUrl, doc_type: type, storage_path: doc.storage_path, status: doc.status });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// POST /driver/docs/upload - gallery re-upload fix
app.post('/driver/docs/upload', (req, res) => {
  upload.any()(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!auth) return res.status(401).json({ error: 'No token' });
      const { data: driver } = await supabase.from('drivers').select('*').eq('driver_id', auth).maybeSingle();
      if (!driver) return res.status(401).json({ error: 'Invalid driver token ' + auth });
      
      const type = (req.body.doc_type || req.query.doc_type || '').toString().toUpperCase();
      if (!ALL_DOCS.includes(type)) return res.status(400).json({ error: 'doc_type required: ' + ALL_DOCS.join(',') });
      
      let file = null;
      if (req.files && req.files.length > 0) {
        // Accept any field name: file, document, etc
        file = req.files[0];
      } else if (req.file) {
        file = req.file;
      }
      if (!file) return res.status(400).json({ error: 'file required. Send as multipart field file or document' });
      
      const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase();
      const fileName = `${auth}/${type}_${Date.now()}.${ext}`;
      console.log(`[UPLOAD] ${auth} ${type} -> ${fileName} size ${file.buffer?.length || file.size}`);
      
      const { error: upErr } = await supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').upload(fileName, file.buffer, {
        contentType: file.mimetype || 'image/jpeg',
        upsert: true
      });
      if (upErr) {
        console.error('Storage upload failed', upErr);
        return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message });
      }
      
      const { data: existing } = await supabase.from('driver_documents').select('*').eq('driver_id', auth).eq('doc_type', type).maybeSingle();
      if (existing) {
        await supabase.from('driver_documents').update({ storage_path: fileName, status: 'PENDING_VERIFICATION', uploaded_at: new Date().toISOString() }).eq('driver_id', auth).eq('doc_type', type);
      } else {
        await supabase.from('driver_documents').insert({ driver_id: auth, doc_type: type, storage_path: fileName, status: 'PENDING_VERIFICATION', uploaded_at: new Date().toISOString() });
      }
      
      const { data: signed } = await supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').createSignedUrl(fileName, 60*5);
      console.log(`[UPLOAD OK] ${auth} ${type} -> ${fileName}`);
      res.json({ ok: true, doc_type: type, storage_path: fileName, url: signed?.signedUrl, message: type + ' uploaded successfully' });
    } catch(e) {
      console.error('upload error', e);
      res.status(500).json({ error: e.message });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend Karnataka Fares + Landing + Docs Upload - Running on PORT ${PORT}`));
