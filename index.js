const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const redis = new Redis(process.env.REDIS_URL || undefined, process.env.REDIS_URL ? { tls: {} } : {});
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.log('Redis error:', err.message));

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
global.supabase = supabase;
if (!supabase) console.log('⚠️ Supabase not configured');

const rides = new Map();
global.onlineDrivers = {};

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });
const ALL_DOCS = ['SELFIE','DL','RC','AADHAAR','PERMIT','INSURANCE','POLICE','FITNESS'];
const JWT_SECRET = process.env.JWT_SECRET || 'urbanride_secret';

let razorpayInstance = null;

function authenticate(req,res,next){
  try{
    const hdr = (req.headers.authorization||'').replace('Bearer ','').trim();
    if(!hdr) return res.status(401).json({error:'No token'});
    try{
      const decoded = jwt.verify(hdr, JWT_SECRET);
      req.user = decoded;
      return next();
    }catch(e){}
    if(hdr.length>=6){
      req.user = { token: hdr };
      return next();
    }
    return res.status(401).json({error:'Invalid token'});
  }catch(e){ return res.status(401).json({error:'Auth failed'}); }
}

// ---- In-memory ride messages + DEDUP STORE ----
const rideMessages = new Map();
const recentMsgHashes = new Map();

function msgHash(rideId, from, text){
  return `${rideId}::${from}::${text.trim().toLowerCase()}`;
}
function isDuplicate(rideId, from, text){
  const hash = msgHash(rideId, from, text);
  if(!recentMsgHashes.has(rideId)) recentMsgHashes.set(rideId, new Map());
  const map = recentMsgHashes.get(rideId);
  const now = Date.now();
  for(const [h, t] of map.entries()){ if(now - t > 10000) map.delete(h); }
  if(map.has(hash)){
    const last = map.get(hash);
    if(now - last < 8000){ return true; }
  }
  map.set(hash, now);
  return false;
}
function addRideMessage(rideId, msg){
  if(!rideMessages.has(rideId)) rideMessages.set(rideId, []);
  rideMessages.get(rideId).push(msg);
  if(rideMessages.get(rideId).length>50) rideMessages.set(rideId, rideMessages.get(rideId).slice(-50));
}
function clearRideMessages(rideId){
  if(rideMessages.has(rideId)){
    rideMessages.delete(rideId);
    recentMsgHashes.delete(rideId);
    console.log(`🧹 Cleared messages for ${rideId}`);
  }
}

function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  razorpayInstance = new Razorpay({ key_id, key_secret });
  return razorpayInstance;
}

try {
  const razorModule = require('./razorpay');
  if (razorModule && typeof razorModule === 'function') {
    razorModule(app, { supabase, redis, io });
    console.log('✅ razorpay.js mounted');
  }
} catch(e) { console.log('razorpay.js not mounted:', e.message); }

function getDriverIdFromToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.driver_id) return decoded.driver_id;
  } catch(e) {}
  return token;
}

// ========== ADMIN ROUTE - FIXES 404 ==========
app.get('/admin', (req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    // Fallback inline HTML if file not in repo - serve minimal
    res.send(`
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UrbanRide Admin</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>body{margin:0;font-family:system-ui} .h{background:#1B5E20;color:#fff;padding:12px} #map{height:60vh} .list{padding:12px} .card{border:1px solid #ddd;padding:8px;margin-bottom:8px;border-radius:8px;font-size:12px}</style>
</head><body>
<div class="h">🚕 UrbanRide Admin - LIVE - ${new Date().toISOString()} - Backend: ${process.env.RENDER_EXTERNAL_URL||'render'}</div>
<div id="map"></div>
<div class="list"><div id="drivers">Loading drivers...</div><div id="rides">Loading rides...</div></div>
<script>
let map=L.map('map').setView([12.9716,77.5946],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
let markers={};
async function load(){
  try{
    const d=await fetch('/drivers').then(r=>r.json());
    document.getElementById('drivers').innerHTML='<h3>Drivers '+d.length+'</h3>'+d.map(x=>'<div class=card>'+x.driver_id+' - '+x.lat+','+x.lng+'</div>').join('');
    d.forEach(x=>{
      const lat=parseFloat(x.lat),lng=parseFloat(x.lng);
      if(markers[x.driver_id]) markers[x.driver_id].setLatLng([lat,lng]);
      else markers[x.driver_id]=L.marker([lat,lng]).addTo(map).bindPopup(x.driver_id);
    });
    const r=await fetch('/rides').then(r=>r.json());
    document.getElementById('rides').innerHTML='<h3>Rides '+r.length+'</h3>'+r.slice(0,20).map(x=>'<div class=card><b>'+x.ride_id+'</b> '+x.status+' ₹'+x.fare+' - '+(x.driver_id||'no driver')+'</div>').join('');
  }catch(e){ console.log(e); }
}
load(); setInterval(load,4000);
</script></body></html>
    `);
  }
});

// Also serve admin.html static if needed
app.use('/admin-static', express.static(__dirname));

// ---- FIXED UPLOAD: SINGLE ROUTE ----
app.post('/driver/docs/upload', (req, res) => {
  upload.any()(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!rawAuth) return res.status(401).json({ error: 'No token' });
      const driverId = getDriverIdFromToken(rawAuth);
      let driver = null;
      const { data: d1 } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
      driver = d1;
      if (!driver) {
        const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
        driver = d2;
      }
      if (!driver && rawAuth !== driverId) {
        const { data: d3 } = await supabase.from('drivers').select('*').eq('driver_id', rawAuth).maybeSingle();
        driver = d3;
      }
      if (!driver) return res.status(401).json({ error: 'Driver not found for ' + rawAuth });
      const type = (req.body.doc_type || '').toUpperCase();
      if (!ALL_DOCS.includes(type)) return res.status(400).json({ error: 'doc_type required' });
      let file = req.files && req.files.length>0 ? req.files[0] : null;
      if (!file) return res.status(400).json({ error: 'file required' });
      const ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase();
      const fileName = `${driver.driver_id}/${type}_${Date.now()}.${ext}`;
      let mime = file.mimetype || 'image/jpeg';
      if (mime === 'application/octet-stream' || !mime.startsWith('image/')) {
        mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      }
      const { error: upErr } = await supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').upload(fileName, file.buffer, { contentType: mime, upsert: true });
      if (upErr) return res.status(500).json({ error: upErr.message });
      const { data: existing } = await supabase.from('driver_documents').select('*').eq('driver_id', driver.driver_id).eq('doc_type', type).maybeSingle();
      if (existing) {
        await supabase.from('driver_documents').update({ storage_path: fileName, status: 'APPROVED', uploaded_at: new Date().toISOString() }).eq('driver_id', driver.driver_id).eq('doc_type', type);
      } else {
        await supabase.from('driver_documents').insert({ driver_id: driver.driver_id, doc_type: type, storage_path: fileName, status: 'APPROVED', uploaded_at: new Date().toISOString() });
      }
      const { data: urlData } = supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').getPublicUrl(fileName);
      res.json({ ok: true, url: urlData.publicUrl, path: fileName });
    } catch(e){
      console.error('[UPLOAD] error', e);
      res.status(500).json({ error: e.message });
    }
  });
});

app.get('/driver/docs/:type/url', async (req,res)=>{
  try{
    const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!rawAuth) return res.status(401).json({ error: 'No token' });
    const driverId = getDriverIdFromToken(rawAuth);
    const type = (req.params.type || '').toUpperCase();
    const { data: driver } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
    let d = driver;
    if (!d) {
      const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
      d = d2;
    }
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const { data: doc } = await supabase.from('driver_documents').select('*').eq('driver_id', d.driver_id).eq('doc_type', type).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const { data: urlData } = supabase.storage.from(process.env.DRIVER_DOCS_BUCKET || 'driver-docs').getPublicUrl(doc.storage_path);
    res.json({ url: urlData.publicUrl, status: doc.status });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

function publicRide(ride){
  if(!ride) return ride;
  const { customer_pin, ...pub } = ride;
  return { ...pub, has_pin: !!customer_pin };
}
async function getRide(rideId){
  try{
    let r = rides.get(rideId);
    if(r) return r;
    const data = await redis.hget('tenant:TENANT_01:rides', rideId);
    if(data){
      r = JSON.parse(data);
      rides.set(rideId, r);
      return r;
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
        if (err) reject(err); else resolve(result);
      });
    });
    const drivers = raw.map(r => ({
      driver_id: r[0],
      distance_km: parseFloat(r[1]),
      lng: parseFloat(r[2][0]),
      lat: parseFloat(r[2][1])
    }));
    res.json({ tenant_id, center: { lat: latNum, lng: lngNum }, radius_km: radiusNum, drivers, count: drivers.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/drivers', async (req, res) => {
  try {
    const driverKeys = await redis.keys('driver:*:location');
    let drivers = [];
    for (let key of driverKeys) {
      const data = await redis.hgetall(key);
      if (data && data.lat) {
        let driverId = key.split(':')[1];
        drivers.push({ driver_id: driverId, lat: parseFloat(data.lat), lng: parseFloat(data.lng), last_seen: data.updated_at, online: true });
      }
    }
    for (let id in global.onlineDrivers) {
      if (!drivers.find(d => d.driver_id === id)) drivers.push(global.onlineDrivers[id]);
    }
    res.json(drivers);
  } catch (e) { res.json([]); }
});

app.post('/customer/register', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone || phone.length != 10) return res.status(400).json({ error: "10 digit phone required" });
    let existing = await redis.hgetall(`customer:${phone}`);
    if (existing && existing.pin) return res.json({ phone, pin: existing.pin, existing: true });
    let pin = Math.floor(1000 + Math.random() * 9000).toString();
    await redis.hset(`customer:${phone}`, { pin, phone, created: new Date().toISOString() });
    res.json({ phone, pin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/driver/:id/selfie', async (req, res) => { res.json({ verified: true, driver_id: req.params.id }); });

app.post('/driver/location', async (req, res) => {
  const { driver_id, lat, lng } = req.body;
  if (!driver_id || !lat || !lng) return res.status(400).json({ error: "Missing" });
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
    } catch (e) { console.log('location error', e.message); }
  });
  socket.on('join:ride', (rideId) => {
    try{
      const r = typeof rideId === 'string' ? rideId : (rideId?.ride_id || rideId?.rideId || rideId);
      if(r){
        const room = `ride_${r}`;
        socket.join(room);
        console.log(`Socket ${socket.id} joined ${room}`);
      }
    }catch(e){}
  });
  socket.on('ride_message', (data) => {
    try{
      const rideId = data?.ride_id || data?.rideId;
      if(rideId){
        const msg = { ...data, time: data.time || new Date().toISOString() };
        if(isDuplicate(rideId, msg.from || 'driver', msg.text || '')){ return; }
        addRideMessage(rideId, msg);
        io.to(`ride_${rideId}`).emit('ride_message', msg);
      }
    }catch(e){}
  });
});

app.post('/rides/request', async (req, res) => {
  const { tenant_id, from, to, distance_km: client_distance, fare: client_fare, vehicle_type, eta_min, booked_for_other, passenger_name, passenger_phone, customer_pin: body_pin } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Pickup and drop are required' });
  let fareData = null;
  if (client_distance && client_fare) {
    fareData = { total: Number(client_fare), breakdown: req.body.fare_breakdown || null, distance_km: Number(client_distance) };
  } else { return res.status(400).json({ error: 'Please get fare quote first' }); }
  const ride_id = `RIDE_${Date.now()}`;
  const customer_pin = (body_pin || String(crypto.randomInt(1000, 10000))).toString();
  const ride = {
    ride_id, tenant_id: tenant_id || 'TENANT_01',
    customer_id: req.body.customer_id || 'CUST_001',
    customer_phone: req.body.customer_phone || '',
    customer_pin, from, to,
    distance_km: fareData.distance_km,
    fare: fareData.total,
    fare_breakdown: fareData.breakdown,
    vehicle_type: vehicle_type || 'TAXI',
    eta_min: eta_min || null,
    booked_for_other: booked_for_other === true,
    passenger_name: passenger_name || null,
    passenger_phone: passenger_phone || null,
    status: 'REQUESTED', driver_id: null,
    created_at: new Date().toISOString()
  };
  rides.set(ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride_id, JSON.stringify(ride));
  console.log(`🚕 Ride ${ride_id} Fare ₹${fareData.total} PIN ${customer_pin}`);
  io.emit('ride:request', publicRide(ride));
  res.json({ success: true, ride });
});

app.post('/rides/:id/accept', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { driver_id } = req.body;
  if (ride.status !== 'REQUESTED') return res.status(409).json({ error: 'Ride already taken or cancelled' });
  ride.status = 'ACCEPTED'; ride.driver_id = driver_id; ride.accepted_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:accepted', ride);
  io.to(`ride_${ride.ride_id}`).emit('ride:accepted', ride);
  res.json({ success: true, ride });
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
  ride.status = 'CANCELLED'; ride.cancelled_by = cancelled_by || 'unknown'; ride.cancel_reason = reason || 'No reason'; ride.cancelled_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  clearRideMessages(ride.ride_id);
  io.emit('ride:cancelled', publicRide(ride));
  io.to(`ride_${ride.ride_id}`).emit('ride:cancelled', publicRide(ride));
  res.json({ success: true, ride: publicRide(ride) });
});

app.post('/rides/:id/arrived', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'ARRIVED'; ride.arrived_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:arrived', ride);
  io.to(`ride_${ride.ride_id}`).emit('ride:arrived', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/start', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { pin } = req.body;
  if (!pin || String(pin) !== String(ride.customer_pin)) {
    return res.status(400).json({ error: 'Wrong PIN. Ask customer for PIN ' + ride.customer_pin });
  }
  ride.status = 'STARTED'; ride.started_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:started', ride);
  io.to(`ride_${ride.ride_id}`).emit('ride:started', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/complete', async (req, res) => {
  const ride = await getRide(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'COMPLETED'; ride.completed_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  clearRideMessages(ride.ride_id);
  io.emit('ride:completed', ride);
  io.to(`ride_${ride.ride_id}`).emit('ride:completed', ride);
  res.json({ success: true, ride });
});

app.get('/rides/:id', async (req, res) => {
  let ride = rides.get(req.params.id);
  if (!ride) {
    try { const data = await redis.hget('tenant:TENANT_01:rides', req.params.id); if (data) ride = JSON.parse(data); } catch(e) {}
  }
  if (!ride) return res.status(404).json({error: 'Not found'});
  res.json(ride);
});

app.get('/rides', async (req, res) => {
  try {
    const allRedis = await redis.hgetall('tenant:TENANT_01:rides');
    const redisRides = Object.values(allRedis).map(v => { try { return JSON.parse(v); } catch(e) { return null; } }).filter(Boolean);
    const memRides = Array.from(rides.values());
    const merged = new Map();
    redisRides.forEach(r => merged.set(r.ride_id, r));
    memRides.forEach(r => merged.set(r.ride_id, r));
    res.json(Array.from(merged.values()));
  } catch(e) { res.json(Array.from(rides.values())); }
});

app.post('/rides/:id/message', authenticate, (req, res) => {
  const rideId = req.params.id;
  const from = (req.body.from || 'driver').toString().toLowerCase();
  const text = (req.body.text || '').toString().trim();
  if (!text) return res.status(400).json({error: 'text required'});
  if(isDuplicate(rideId, from, text)){
    console.log(`⚠ Duplicate HTTP msg blocked ${rideId} ${from}: ${text}`);
    return res.json({ok:true, delivered:true, duplicate:true});
  }
  const msg = { ride_id: rideId, from, text, time: new Date().toISOString(), id: `MSG_${Date.now()}_${Math.random().toString(36).slice(2,6)}` };
  addRideMessage(rideId, msg);
  io.to(`ride_${rideId}`).emit('ride_message', msg);
  io.to(`ride_${rideId}`).emit('ride:message', msg);
  console.log(`💬 [HTTP] Ride ${rideId} ${from}: ${text} -> room ride_${rideId} ONLY`);
  res.json({ok:true, delivered:true, message:msg});
});

app.get('/rides/:id/messages', authenticate, (req, res) => {
  const rideId = req.params.id;
  res.json({ride_id: rideId, messages: rideMessages.get(rideId) || []});
});

app.post('/rider/payment/order', async (req, res) => {
  try {
    const { ride_id, amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const amt = Math.round(Number(amount) * 100);
    const receipt = `ride_${(ride_id||'').toString().substring(0,20)}_${Date.now()}`.substring(0,40);
    const rzp = getRazorpay();
    if (!rzp) return res.json({ order_id: `order_mock_${Date.now()}`, amount: amt, currency: 'INR', receipt, key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test', mock: true });
    const order = await rzp.orders.create({ amount: amt, currency: 'INR', receipt, notes: { ride_id: ride_id || '' } });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, receipt: order.receipt, key_id: process.env.RAZORPAY_KEY_ID, ride_id });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/driver/profile', async (req, res) => {
  try {
    const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!rawAuth) return res.status(401).json({ error: 'No token' });
    const driverId = getDriverIdFromToken(rawAuth);
    let driver = null;
    const { data: d1 } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
    driver = d1;
    if (!driver) {
      const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
      driver = d2;
    }
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver, upi_id: driver.upi_id || '' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/driver/upi', async (req, res) => {
  try {
    const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const driverId = getDriverIdFromToken(rawAuth);
    const { upi_id } = req.body;
    if (!upi_id || !upi_id.includes('@')) return res.status(400).json({ error: 'Invalid UPI ID' });
    let driver = null;
    const { data: d1 } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
    driver = d1;
    if (!driver) {
      const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
      driver = d2;
    }
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const { data, error } = await supabase.from('drivers').update({ upi_id: upi_id.trim(), updated_at: new Date().toISOString() }).eq('driver_id', driver.driver_id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, driver: data, upi_id: data.upi_id });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/driver/wallet', async (req, res) => {
  try {
    const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const driverId = getDriverIdFromToken(rawAuth);
    let driver = null;
    const { data: d1 } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
    driver = d1;
    if (!driver) {
      const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
      driver = d2;
    }
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    let wallet = null;
    try {
      const { data: w } = await supabase.from('driver_wallets').select('*').eq('driver_id', driver.driver_id).maybeSingle();
      wallet = w;
    } catch(e){}
    if (!wallet) wallet = { driver_id: driver.driver_id, balance: 0, total_earnings: 0, total_rides: 0 };
    let txns = [];
    try {
      const { data: t } = await supabase.from('wallet_transactions').select('*').eq('driver_id', driver.driver_id).order('created_at', { ascending: false }).limit(20);
      txns = t || [];
    } catch(e){}
    res.json({ ...wallet, transactions: txns, upi_id: driver.upi_id || '' });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/driver/subscription', async (req, res) => {
  try {
    const rawAuth = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const driverId = getDriverIdFromToken(rawAuth);
    const SUPER_ADMINS = ['DRV_E90F74','DRV_EAD55B','9886180011','8431670039'];
    let driver = null;
    const { data: d1 } = await supabase.from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
    driver = d1;
    if (!driver) {
      const { data: d2 } = await supabase.from('drivers').select('*').eq('phone', driverId).maybeSingle();
      driver = d2;
    }
    const isSuper = driver && (SUPER_ADMINS.includes(driver.driver_id) || SUPER_ADMINS.includes(driver.phone));
    if (isSuper) return res.json({ blocked: false, is_super_admin: true, plan: 'SUPER_ADMIN_FREE' });
    res.json({ blocked: false, plan: 'FREE_TRIAL', trial_rides_left: 3 });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/health', (req,res) => {
  res.json({ status:'LIVE', version:'V73 ADMIN + DEDUP FIXED', supabase: !!supabase, timestamp: new Date().toISOString() });
});
app.get('/', (req,res) => res.json({ status:'UrbanRide Backend LIVE', version:'V73 ADMIN + DEDUP FIXED', admin:'/admin' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend V73 ADMIN + DEDUP FIXED - PORT ${PORT}`));
