const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });


redis.on('connect', () => console.log('✅ Redis connected'));

// In-memory rides store
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
    console.log(`🔍 Searching ${key} at ${latNum},${lngNum} radius ${radiusNum}km`);

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
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  socket.on('driver:location:update', async (data) => {
    const { tenant_id, driver_id, lat, lng } = data;
    const key = `tenant:${tenant_id}:drivers:geo`;
    await redis.geoadd(key, lng, lat, driver_id);
    // Broadcast driver location to customers tracking this driver
    io.emit('driver:location', { driver_id, lat, lng });
  });

  socket.on('join:ride', (ride_id) => {
    socket.join(ride_id);
    console.log(`📲 Socket ${socket.id} joined ride ${ride_id}`);
  });
});

// 1. Request
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

  const key = `tenant:${ride.tenant_id}:drivers:geo`;
  const nearby = await redis.call('GEORADIUS', key, from.lng, from.lat, 5, 'km', 'COUNT', 10);
  console.log(`🚕 Ride ${ride_id} ${from.lat},${from.lng} -> ${to.lat},${to.lng} Fare ₹${fare} - Found ${nearby.length} drivers`);

  io.emit('ride:request', ride);
  res.json({ success: true, ride });
});

// 2. Accept
app.post('/rides/:id/accept', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  const { driver_id } = req.body;
  ride.status = 'ACCEPTED';
  ride.driver_id = driver_id;
  ride.accepted_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`✅ Ride ${ride.ride_id} accepted by ${driver_id}`);
  io.emit('ride:accepted', ride);
  io.to(ride.ride_id).emit('ride:accepted', ride);
  res.json({ success: true, ride });
});

// 3. Decline
app.post('/rides/:id/decline', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'DECLINED';
  io.emit('ride:declined', ride);
  res.json({ success: true });
});

// 4. NEW PHASE 3: Driver Arrived at Pickup A
app.post('/rides/:id/arrived', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'ARRIVED';
  ride.arrived_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`📍 Ride ${ride.ride_id} ARRIVED at pickup`);
  io.emit('ride:arrived', ride);
  io.to(ride.ride_id).emit('ride:arrived', ride);
  res.json({ success: true, ride });
});

// 5. NEW: Trip Started A -> B
app.post('/rides/:id/start', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'STARTED';
  ride.started_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`🚀 Ride ${ride.ride_id} STARTED`);
  io.emit('ride:started', ride);
  io.to(ride.ride_id).emit('ride:started', ride);
  res.json({ success: true, ride });
});

// 6. NEW: Trip Completed at B
app.post('/rides/:id/complete', async (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Ride not found'});
  ride.status = 'COMPLETED';
  ride.completed_at = new Date().toISOString();
  rides.set(ride.ride_id, ride);
  await redis.hset(`tenant:${ride.tenant_id}:rides`, ride.ride_id, JSON.stringify(ride));
  console.log(`🏁 Ride ${ride.ride_id} COMPLETED Fare ₹${ride.fare}`);
  io.emit('ride:completed', ride);
  io.to(ride.ride_id).emit('ride:completed', ride);
  res.json({ success: true, ride });
});

// 7. Get ride
app.get('/rides/:id', (req, res) => {
  const ride = rides.get(req.params.id);
  if (!ride) return res.status(404).json({error: 'Not found'});
  res.json(ride);
});

// 8. All rides (for debugging)
app.get('/rides', (req, res) => {
  res.json(Array.from(rides.values()));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Backend Phase 3 running on PORT ${PORT}`));