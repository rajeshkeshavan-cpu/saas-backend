const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Redis
const redis = new Redis(process.env.REDIS_URL || undefined, process.env.REDIS_URL ? { tls: {} } : {});
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.log('Redis error:', err.message));

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

app.get('/', (req, res) => {
  res.send('SaaS Driver Backend - Karnataka Fares - Running');
});

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

  // Karnataka compliant: server is authority for fare
  let fareData = null;
  let locked = null;
  if (quote_id) {
    locked = await pricing.takeQuote(redis, quote_id, cust.customer_id);
    if (locked) {
      fareData = { total: locked.total, breakdown: locked.breakdown, distance_km: locked.distance_km, duration_min: locked.duration_min };
      console.log(`🔒 Using locked quote ${quote_id} fare ₹${locked.total} for ${cust.customer_id}`);
    }
  }
  // If no locked quote, client sent distance - fallback (less accurate, but prevents app break)
  if (!fareData) {
    if (client_distance && client_fare) {
      console.log(`⚠️ No locked quote, using client values distance ${client_distance} fare ${client_fare} - encourage app to use /fare/quote`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend Karnataka Fares - Running on PORT ${PORT}`));
