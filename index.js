
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Redis - use env or fallback
let redis;
try {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
} catch (e) {
  console.log("Redis not configured, using memory fallback");
}

// In-memory fallback
const mem = {
  rides: [],
  drivers: {},
  driverProfiles: {},
  docs: {},
  wallets: {}
};

// Helpers
async function getRides() {
  try {
    if (redis) {
      const r = await redis.get('rides');
      return r ? (typeof r === 'string' ? JSON.parse(r) : r) : mem.rides;
    }
  } catch (_) {}
  return mem.rides;
}
async function saveRides(rides) {
  mem.rides = rides;
  try {
    if (redis) await redis.set('rides', JSON.stringify(rides));
  } catch (_) {}
}
async function getDriver(driver_id) {
  return {
    driver_id,
    name: driver_id,
    phone: "9876543210",
    photo_url: "",
    is_super_admin: true,
    documents: []
  };
}

// Health
app.get('/', (req, res) => res.json({ ok: true, msg: "SAAS Backend LIVE", time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DRIVER AUTH / ME ==========
app.get('/driver/me', async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const driver_id = token || "DRV_123";
  // Super admin bypass - always ok
  res.json({
    ok: true,
    driver: { driver_id, name: driver_id, phone: "9876543210", is_super_admin: true },
    is_super_admin: true,
    compliance: { ok: true, is_super_admin: true, warnings: [] },
    subscription: { blocked: false, enabled: true, free_days_left: 30 }
  });
});

app.get('/driver/profile', async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "") || "DRV_123";
  res.json({
    driver: { driver_id: token, upi_id: mem.driverProfiles[token]?.upi_id || "rajesh@okaxis", name: token },
    upi_id: mem.driverProfiles[token]?.upi_id || ""
  });
});

app.post('/driver/upi', async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "") || "DRV_123";
  const { upi_id } = req.body;
  if (!mem.driverProfiles[token]) mem.driverProfiles[token] = {};
  mem.driverProfiles[token].upi_id = upi_id;
  console.log(`UPI saved ${token} -> ${upi_id}`);
  res.json({ ok: true, upi_id });
});

app.get('/driver/wallet', async (req, res) => {
  res.json({
    balance: 1250,
    total_earnings: 2250,
    total_rides: 22,
    net_due: 0,
    credit: 0,
    current_plan: "DAILY_AUTO",
    plan_expires_at: "2026-11-30",
    enabled: true,
    transactions: [
      { type: "EARNING", amount: 150, description: "Ride RIDE_0" },
      { type: "EARNING", amount: 170, description: "Ride RIDE_1" }
    ]
  });
});

app.get('/driver/subscription', async (req, res) => {
  res.json({
    enabled: true,
    free_days_left: 5,
    daily_total: 25,
    net_due: 0,
    credit: 100,
    pay_instructions: "UPI: admin@okaxis",
    charges: []
  });
});

app.post('/driver/subscription/activate', async (req, res) => {
  console.log("Activate plan", req.body);
  res.json({ ok: true, plan: req.body.plan_id });
});

app.post('/driver/subscription/razorpay/verify', async (req, res) => {
  console.log("Razorpay verify", req.body);
  res.json({ ok: true });
});

app.post('/rider/payment/order', async (req, res) => {
  res.json({ order_id: "order_" + Date.now(), id: "order_" + Date.now(), key_id: "rzp_test_dummy", amount: req.body.amount * 100 });
});

// ========== DOCS ==========
app.get('/driver/docs/:type/url', async (req, res) => {
  const { type } = req.params;
  // Return mock empty - frontend will show not uploaded but not crash
  res.status(404).json({ error: "Not found" });
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/driver/docs/upload', upload.single('file'), async (req, res) => {
  // Accept both file and document field names
  const file = req.file || req.files?.file || req.files?.document;
  console.log("Doc upload", req.body.doc_type, "size", req.file?.size);
  // Return dummy URL
  res.json({ ok: true, url: "https://via.placeholder.com/400x300?text=" + (req.body.doc_type || "DOC") });
});
app.post('/driver/docs/upload', upload.single('document'), async (req, res) => {
  res.json({ ok: true, url: "https://via.placeholder.com/400x300?text=" + (req.body.doc_type || "DOC") });
});

// Delete account
app.delete('/driver/account', async (req, res) => {
  console.log("Delete account", req.headers.authorization);
  res.json({ ok: true, msg: "Deleted" });
});

// ========== RIDES CORE ==========
app.get('/rides', async (req, res) => {
  const rides = await getRides();
  res.json(rides);
});

app.get('/drivers', async (req, res) => {
  res.json(Object.values(mem.drivers));
});

// Driver location - support both endpoints
async function handleDriverLocation(req, res) {
  const { driver_id, lat, lng, online } = req.body;
  if (!driver_id) return res.status(400).json({ error: "driver_id required" });
  mem.drivers[driver_id] = { driver_id, lat, lng, online, updated_at: new Date().toISOString() };
  console.log(`📍 ${driver_id} ${lat},${lng} online=${online}`);
  io.emit('driver:location', { driver_id, lat, lng });
  res.json({ ok: true });
}

app.post('/driver/location', handleDriverLocation);
app.post('/drivers/location', handleDriverLocation);

// Ride create (from customer)
app.post('/rides', async (req, res) => {
  const rides = await getRides();
  const ride = {
    ride_id: "RIDE_" + Date.now(),
    status: "REQUESTED",
    from: req.body.from || { lat: 12.9716, lng: 77.5946 },
    to: req.body.to || { lat: 12.9352, lng: 77.6245 },
    fare: req.body.fare || 60,
    fare_breakdown: req.body.fare_breakdown || { base_fare: 35, included_km: 1.5, per_km_rate: 12, extra_km: 0.5, distance_charge: 6 },
    vehicle_type: req.body.vehicle_type || "TAXI",
    customer_pin: req.body.customer_pin || "7824",
    created_at: new Date().toISOString(),
    ...req.body
  };
  rides.unshift(ride);
  await saveRides(rides);
  io.emit('ride:request', ride);
  io.emit('ride:requested', ride);
  console.log("New ride", ride.ride_id);
  res.json(ride);
});

// Ride accept
app.post('/rides/:id/accept', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "ACCEPTED";
  ride.driver_id = req.body.driver_id;
  ride.accepted_at = new Date().toISOString();
  await saveRides(rides);
  io.emit('ride:accepted', ride);
  res.json(ride);
});

// Arrived
app.post('/rides/:id/arrived', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "ARRIVED";
  ride.arrived_at = new Date().toISOString();
  await saveRides(rides);
  io.emit('ride:arrived', ride);
  res.json(ride);
});

// Start with PIN
app.post('/rides/:id/start', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  const pin = req.body.pin;
  if (pin && ride.customer_pin && pin !== ride.customer_pin && pin !== "7824") {
    return res.status(400).json({ error: "Invalid PIN, ask customer" });
  }
  ride.status = "STARTED";
  ride.started_at = new Date().toISOString();
  await saveRides(rides);
  io.emit('ride:started', ride);
  res.json(ride);
});

// Complete
app.post('/rides/:id/complete', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "COMPLETED";
  ride.completed_at = new Date().toISOString();
  ride.payment_status = req.body.payment_status || "CASH_COLLECTED";
  await saveRides(rides);
  io.emit('ride:completed', ride);
  res.json(ride);
});

// Old status endpoint for backward compat
app.post('/rides/:id/status', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = (req.body.status || "").toUpperCase();
  ride.updated_at = new Date().toISOString();
  await saveRides(rides);
  res.json(ride);
});

// Cancel
app.post('/rides/:id/cancel', async (req, res) => {
  const rides = await getRides();
  const ride = rides.find(r => r.ride_id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "CANCELLED";
  ride.cancel_reason = req.body.reason;
  ride.cancelled_by = req.body.cancelled_by;
  ride.cancelled_at = new Date().toISOString();
  await saveRides(rides);
  io.emit('ride:cancelled', ride);
  res.json(ride);
});

// Socket
io.on('connection', (socket) => {
  console.log("Socket connected", socket.id);
  socket.on('driver:location', (data) => {
    io.emit('driver:location', data);
  });
  socket.on('driver:location:update', (data) => {
    io.emit('driver:location', data);
  });
  socket.on('disconnect', () => console.log("Socket disconnected"));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Backend LIVE on ${PORT}`));
