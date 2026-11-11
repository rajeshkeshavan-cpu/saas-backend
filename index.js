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

io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);
  socket.on('driver:location:update', async (data) => {
    const { tenant_id, driver_id, lat, lng } = data;
    const key = `tenant:${tenant_id}:drivers:geo`;
    await redis.geoadd(key, lng, lat, driver_id);
    io.emit('driver:location', { driver_id, lat, lng });
  });
  socket.on('join:ride', (ride_id) => {
    socket.join(ride_id);
  });
});

app.post('/rides/request', async (req, res) => {
  const { tenant_id, customer_id, from, to, distance_km, fare } = req.body;
  const ride_id = `RIDE_${Date.now()}`;
  const ride = {
    ride_id,
    tenant_id: tenant_id || 'TENANT_01',
    customer_id,
    from, to, distance_km, fare,
    status: 'REQUESTED',
    driver_id: null,
    created_at: new Date().toISOString()
  };
  rides.set(ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride_id, JSON.stringify(ride));
  console.log(`🚕 Ride ${ride_id} Fare ₹${fare}`);
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

app.get('/rides/:id', (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Not found'});
  res.json(ride);
});

app.get('/rides', (req, res) => {
  res.json(Array.from(rides.values()));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend Phase 3 running on PORT ${PORT}`));