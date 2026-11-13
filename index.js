const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const redis = new Redis(process.env.REDIS_URL || undefined, process.env.REDIS_URL ? { tls: {} } : {});
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.log('Redis error:', err.message));

const rides = new Map();
global.onlineDrivers = {};

app.get('/', (req, res) => {
  res.send('SaaS Driver Backend - Phase 3 - Running');
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

// NEW: Drivers list for customer app - MUST BE BEFORE listen!
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
    // Merge with in-memory
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

// NEW: Customer registration with PIN
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

// NEW: Driver selfie upload (mock verification)
app.post('/driver/:id/selfie', async (req, res) => {
  console.log(`📸 Selfie received for ${req.params.id}`);
  res.json({ verified: true, driver_id: req.params.id });
});

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
      console.log(`📍 ${driver_id} ${lat},${lng}`);
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

app.post('/rides/request', async (req, res) => {
  const { tenant_id, customer_id, customer_phone, customer_pin, from, to, distance_km, fare } = req.body;
  const ride_id = `RIDE_${Date.now()}`;
  const ride = {
    ride_id,
    tenant_id: tenant_id || 'TENANT_01',
    customer_id: customer_id || customer_phone,
    customer_phone,
    customer_pin,
    from, to, distance_km, fare,
    status: 'REQUESTED',
    driver_id: null,
    created_at: new Date().toISOString()
  };
  rides.set(ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride_id, JSON.stringify(ride));
  console.log(`🚕 Ride ${ride_id} Phone ${customer_phone} PIN ${customer_pin} Fare ₹${fare}`);
  io.emit('ride:request', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/accept', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { driver_id } = req.body;
  ride.status = 'ACCEPTED';
  ride.driver_id = driver_id;
  ride.accepted_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:accepted', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/decline', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'DECLINED';
  io.emit('ride:declined', ride);
  res.json({ success: true });
});

app.post('/rides/:id/cancel', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { cancelled_by, reason } = req.body;
  ride.status = 'CANCELLED';
  ride.cancelled_by = cancelled_by || 'unknown';
  ride.cancel_reason = reason || 'No reason';
  ride.cancelled_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`❌ Ride ${ride.ride_id} cancelled by ${ride.cancelled_by}: ${ride.cancel_reason}`);
  io.emit('ride:cancelled', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/arrived', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'ARRIVED';
  ride.arrived_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:arrived', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/start', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  // Optional PIN verification
  const { pin } = req.body;
  if (pin && ride.customer_pin && pin != ride.customer_pin) {
    return res.status(400).json({ error: `Wrong PIN. Expected ${ride.customer_pin}` });
  }
  ride.status = 'STARTED';
  ride.started_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:started', ride);
  res.json({ success: true, ride });
});

app.post('/rides/:id/complete', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'COMPLETED';
  ride.completed_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  io.emit('ride:completed', ride);
  res.json({ success: true, ride });
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
  } catch(e) {
    res.json(Array.from(rides.values()));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend Phase 3 - Drivers + PIN running on PORT ${PORT}`));
