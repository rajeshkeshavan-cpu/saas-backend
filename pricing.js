// pricing.js - Karnataka Compliant - Merged version
// Keeps your advanced features: route, breakdown, locked quote, admin API
// But enforces Karnataka Govt rates + surge ban (Rule 129)
// Mounted from index.js: const pricing = require('./pricing'); pricing(app, { redis, customerAcc, rides });

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;

const QUOTE_TTL_SECONDS = 300; // 5 min locked quote
const HARD_MAX_SURGE = 1.0; // KARNATAKA: never above govt rate - surge prohibited
const VEHICLES = ['AUTO', 'TAXI', 'TAXI_10_15L', 'TAXI_ABOVE_15L'];

// KARNATAKA GOVT RATES - Feb 2024 taxi notification + RTA July 2025 auto
// Source: Transport Dept notification + RTA Bengaluru
const DEFAULTS = {
  rates: {
    AUTO: { base_fare: 36, included_km: 2, per_km: 18, per_min: 0, min_fare: 36, gst_rate: 0, govt_note: "RTA July 2025: 36/2km+18/km" },
    TAXI: { base_fare: 100, included_km: 4, per_km: 24, per_min: 0, min_fare: 100, gst_rate: 0, govt_note: "Govt Feb 2024: <=10L 100/4km+24/km" },
    TAXI_10_15L: { base_fare: 115, included_km: 4, per_km: 28, per_min: 0, min_fare: 115, gst_rate: 0, govt_note: "Govt Feb 2024: 10-15L 115/4km+28/km" },
    TAXI_ABOVE_15L: { base_fare: 130, included_km: 4, per_km: 32, per_min: 0, min_fare: 130, gst_rate: 0, govt_note: "Govt Feb 2024: >15L 130/4km+32/km" },
  },
  rounding_rupees: 1,
  surge: {
    min_multiplier: 0.7, // Karnataka allows DISCOUNT only, down to 0.7 = 30% off
    max_multiplier: 1.0, // KARNATAKA: max 1.0 = govt rate, no surge above
    peak_windows: [], // disabled for Karnataka - govt rate is fixed
    rain: { enabled: false, threshold_mm: 0.3, increment: 0 },
    demand: {
      enabled: true, // demand can give DISCOUNT when low demand, not surge
      radius_km: 3,
      window_minutes: 10,
      tiers: [
        { ratio: 0.5, increment: -0.1 }, // low demand = 10% discount
        { ratio: 0.3, increment: -0.2 }, // very low = 20% discount
      ],
    },
    manual: { increment: 0, expires_at: null, note: '' }, // manual discount only, capped at 0
  },
  waiting: {
    free_min: 5,
    per_min: 1, // Re 1 per min after 5 min free
  }
};

const num = (v, d, lo, hi) => {
  const n = Number(v);
  if (!isFinite(n)) return d;
  return Math.min(Math.max(n, lo), hi);
};
const hhmm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);

function sanitize(inp) {
  const i = inp && typeof inp === 'object' ? inp : {};
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const vt of VEHICLES) {
    const r = (i.rates && i.rates[vt]) || {};
    const d = DEFAULTS.rates[vt];
    out.rates[vt] = {
      base_fare: num(r.base_fare, d.base_fare, 0, 5000),
      included_km: num(r.included_km, d.included_km, 0, 50),
      per_km: num(r.per_km, d.per_km, 0, 500),
      per_min: num(r.per_min, d.per_min, 0, 50),
      min_fare: num(r.min_fare, d.min_fare, 0, 5000),
      gst_rate: num(r.gst_rate, d.gst_rate, 0, 0.3),
      govt_note: d.govt_note,
    };
  }
  // ENFORCE KARNATAKA CAPS - even if admin tries to set surge, cap at 1.0
  out.rounding_rupees = [1, 5, 10].includes(Number(i.rounding_rupees)) ? Number(i.rounding_rupees) : 1;
  const s = i.surge || {};
  const ds = DEFAULTS.surge;
  out.surge.min_multiplier = num(s.min_multiplier, ds.min_multiplier, 0.5, 1);
  out.surge.max_multiplier = 1.0; // HARD CODED for Karnataka - cannot be changed via admin
  if (Array.isArray(s.peak_windows)) {
    out.surge.peak_windows = []; // disabled for Karnataka
  }
  const dm = s.demand || {};
  out.surge.demand = {
    enabled: dm.enabled === undefined ? ds.demand.enabled : dm.enabled === true,
    radius_km: num(dm.radius_km, ds.demand.radius_km, 0.5, 20),
    window_minutes: num(dm.window_minutes, ds.demand.window_minutes, 1, 60),
    tiers: Array.isArray(dm.tiers) ? dm.tiers.slice(0, 6).map((t) => ({ ratio: num(t.ratio, 0.1, 1, 20), increment: num(t.increment, -0.5, 0, 0) })) : ds.demand.tiers, // only discounts
  };
  const mn = s.manual || {};
  out.surge.manual = {
    increment: num(mn.increment, 0, -0.3, 0), // only discount, max 30% off
    expires_at: mn.expires_at && !isNaN(Date.parse(mn.expires_at)) ? new Date(mn.expires_at).toISOString() : null,
    note: String(mn.note || '').slice(0, 60),
  };
  out.waiting = {
    free_min: num(i.waiting?.free_min, 5, 0, 10),
    per_min: num(i.waiting?.per_min, 1, 0, 5),
  };
  return out;
}

let cfgCache = { at: 0, value: sanitize({}) };
async function getConfig(force = false) {
  if (!force && Date.now() - cfgCache.at < 30000) return cfgCache.value;
  let saved = null;
  if (supabase) {
    try {
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'pricing').maybeSingle();
      saved = data ? data.value : null;
    } catch (e) {}
  }
  cfgCache = { at: Date.now(), value: sanitize(saved) };
  return cfgCache.value;
}

const round2 = (x) => Math.round(x * 100) / 100;
const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const validPoint = (p) => p && isFinite(Number(p.lat)) && isFinite(Number(p.lng)) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

function istNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { dow, minutes: (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10) };
}

const routeCache = new Map();
async function getRoute(a, b) {
  const key = [a.lat, a.lng, b.lat, b.lng].map((v) => Number(v).toFixed(4)).join(',');
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.value;
  let value = null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const r = await fetch(url, { headers: { 'User-Agent': 'saas-ride-backend/1.0' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      if (d.code === 'Ok' && d.routes && d.routes.length) {
        const rt = d.routes[0];
        value = {
          km: rt.distance / 1000,
          minutes: Math.max(1, Math.ceil(rt.duration / 60)),
          estimated: false,
          coords: rt.geometry.coordinates.map((c) => [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5]),
        };
      }
    }
  } catch (e) {}
  if (!value) {
    const km = haversineKm(a, b) * 1.35;
    value = { km, minutes: Math.max(1, Math.ceil((km / 22) * 60)), estimated: true, coords: [[a.lat, a.lng], [b.lat, b.lng]] };
  }
  routeCache.set(key, { at: Date.now(), value });
  if (routeCache.size > 500) routeCache.delete(routeCache.keys().next().value);
  return value;
}

async function computeSurge(pickup, cfg, ctx) {
  const s = cfg.surge;
  const reasons = [];
  let inc = 0;

  // KARNATAKA: Only discounts allowed, no surge
  // Check demand for discount
  if (s.demand.enabled && ctx) {
    const cutoff = Date.now() - s.demand.window_minutes * 60000;
    const near = (p) => p && validPoint(p) && haversineKm(pickup, { lat: Number(p.lat), lng: Number(p.lng) }) <= s.demand.radius_km;
    const drivers = Object.values(global.onlineDrivers || {}).filter((d) => Date.now() - Number(d.last_seen || 0) < 90000 && near(d)).length;
    const waiting = ctx.rides().filter((r) => r.status === 'REQUESTED' && Date.parse(r.created_at) >= cutoff && near(r.from)).length;
    const ratio = (waiting + 1) / Math.max(1, drivers);
    // Low ratio = low demand = discount
    let best = null;
    for (const t of s.demand.tiers) if (ratio <= t.ratio && (!best || t.ratio < best.ratio)) best = t;
    if (best && best.increment < 0) {
      inc += best.increment;
      reasons.push({ label: 'Low demand discount', increment: best.increment });
    }
  }

  // Manual discount
  const m = s.manual;
  if (m.increment !== 0 && m.increment < 0 && (!m.expires_at || Date.parse(m.expires_at) > Date.now())) {
    inc += m.increment;
    reasons.push({ label: m.note || 'Promo discount', increment: m.increment });
  }

  let multiplier = 1 + inc;
  // Enforce Karnataka caps: 0.7 to 1.0
  if (multiplier > 1.0) multiplier = 1.0;
  if (multiplier < s.min_multiplier) multiplier = s.min_multiplier;
  
  return { 
    multiplier: round2(multiplier), 
    reasons, 
    capped: multiplier >= 1.0, 
    max_multiplier: 1.0,
    govt_compliant: true,
    note: "Karnataka: Surge prohibited, discount only per Rule 129"
  };
}

function priceFor(vt, route, surge, cfg) {
  const r = cfg.rates[vt] || cfg.rates['TAXI'];
  const extraKm = Math.max(0, route.km - r.included_km);
  const distance_charge = round2(extraKm * r.per_km);
  const time_charge = round2(route.minutes * r.per_min);
  const waiting_charge = 0; // calculated separately if needed
  let subtotal = round2(r.base_fare + distance_charge + time_charge);
  const minApplied = subtotal < r.min_fare;
  if (minApplied) subtotal = r.min_fare;
  const surge_amount = round2(subtotal * (surge.multiplier - 1)); // negative = discount
  const pre_tax = round2(subtotal + surge_amount);
  const gst = round2(pre_tax * r.gst_rate);
  const exact = pre_tax + gst;
  const step = cfg.rounding_rupees;
  const total = Math.max(0, Math.round(exact / step) * step);
  const rounding = round2(total - exact);

  const lines = [
    { label: `Base fare (${r.included_km}km)`, amount: r.base_fare, govt_rate: r.govt_note },
  ];
  if (distance_charge > 0) lines.push({ label: `Distance (${extraKm.toFixed(1)} km beyond first ${r.included_km} km @ ₹${r.per_km}/km)`, amount: distance_charge });
  if (time_charge > 0) lines.push({ label: `Time (${route.minutes} min)`, amount: time_charge });
  if (minApplied) lines.push({ label: 'Minimum fare adjustment', amount: round2(r.min_fare - (r.base_fare + distance_charge + time_charge)) });
  if (surge_amount !== 0) {
    const why = surge.reasons.map((x) => x.label).join(', ');
    lines.push({ label: `${surge_amount > 0 ? 'Surge' : 'Discount'} (${surge.multiplier}x${why ? ': ' + why : ''}) - Karnataka allows discount only`, amount: surge_amount });
  }
  if (gst > 0) lines.push({ label: `GST (${Math.round(r.gst_rate * 1000) / 10}%)`, amount: gst });
  if (rounding !== 0) lines.push({ label: 'Rounding', amount: rounding });
  
  return {
    vehicle_type: vt,
    total,
    breakdown: { 
      base_fare: r.base_fare, 
      included_km: r.included_km,
      per_km_rate: r.per_km,
      extra_km: round2(extraKm),
      distance_charge, 
      time_charge, 
      waiting_charge,
      minimum_fare_adjustment: minApplied ? round2(r.min_fare - (r.base_fare + distance_charge + time_charge)) : 0, 
      subtotal, 
      surge_multiplier: surge.multiplier, 
      surge_amount, 
      discount: surge_amount < 0 ? Math.abs(surge_amount) : 0,
      gst, 
      rounding, 
      total, 
      platform_fee: 0,
      govt_compliant: true,
      govt_note: r.govt_note,
    },
    lines,
  };
}

const quoteLimiter = new Map();
function limited(id) {
  const now = Date.now();
  const list = (quoteLimiter.get(id) || []).filter((t) => now - t < 60000);
  list.push(now);
  quoteLimiter.set(id, list);
  return list.length > 30;
}

function adminOk(req) {
  const pw = process.env.ADMIN_PASSWORD || '';
  const key = String(req.headers['x-admin-key'] || '');
  if (!pw || key.length !== pw.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(pw));
}

function mount(app, ctx) {
  const { redis, customerAcc } = ctx;

  app.post('/fare/quote', async (req, res) => {
    try {
      const cust = await customerAcc.customerFromReq(req);
      if (!cust) return res.status(401).json({ error: 'Please log in again' });
      if (limited(cust.customer_id)) return res.status(429).json({ error: 'Too many fare checks. Wait a moment.' });
      const { from, to } = req.body || {};
      if (!validPoint(from) || !validPoint(to)) return res.status(400).json({ error: 'Pickup and drop locations are required' });
      const a = { lat: Number(from.lat), lng: Number(from.lng) };
      const b = { lat: Number(to.lat), lng: Number(to.lng) };
      if (haversineKm(a, b) < 0.05) return res.status(400).json({ error: 'Pickup and drop are the same place' });
      if (haversineKm(a, b) > 150) return res.status(400).json({ error: 'This trip is too long for a city ride' });

      const cfg = await getConfig();
      const route = await getRoute(a, b);
      const surge = await computeSurge(a, cfg, ctx);
      const quotes = {};
      for (const vt of VEHICLES) {
        const q = priceFor(vt, route, surge, cfg);
        const quote_id = 'Q_' + crypto.randomBytes(6).toString('hex');
        await redis.set(
          'quote:' + quote_id,
          JSON.stringify({ customer_id: cust.customer_id, vehicle_type: vt, from: a, to: b, distance_km: round2(route.km), duration_min: route.minutes, total: q.total, breakdown: q.breakdown, created_at: new Date().toISOString() }),
          'EX',
          QUOTE_TTL_SECONDS
        );
        quotes[vt] = { quote_id, total: q.total, lines: q.lines, breakdown: q.breakdown };
      }
      res.json({
        success: true,
        expires_in: QUOTE_TTL_SECONDS,
        distance_km: round2(route.km),
        duration_min: route.minutes,
        estimated: route.estimated,
        route: route.coords,
        surge,
        quotes,
        govt_compliant: true,
        note: "Karnataka Govt Rates: Auto 36/2km+18/km, Taxi 100/4km+24/km <=10L, 115+28 10-15L, 130+32 >15L. Surge prohibited."
      });
    } catch (e) {
      console.log('quote error', e.message);
      res.status(500).json({ error: 'Could not work out the fare. Try again.' });
    }
  });

  // Keep old endpoint for backward compat
  app.post('/fare/estimate', async (req, res) => {
    req.body.from = { lat: req.body.from_lat || req.body.from?.lat, lng: req.body.from_lng || req.body.from?.lng };
    req.body.to = { lat: req.body.to_lat || req.body.to?.lat, lng: req.body.to_lng || req.body.to?.lng };
    if (!validPoint(req.body.from) || !validPoint(req.body.to)) {
      // fallback to distance_km method
      try {
        const { distance_km, vehicle_type } = req.body;
        const cfg = await getConfig();
        const fakeRoute = { km: distance_km || 3, minutes: 10, estimated: true, coords: [] };
        const surge = { multiplier: 1.0, reasons: [], capped: true, max_multiplier: 1.0, govt_compliant: true };
        const q = priceFor(vehicle_type || 'TAXI', fakeRoute, surge, cfg);
        return res.json({ total: q.total, breakdown: q.breakdown, lines: q.lines, govt_compliant: true });
      } catch(e){ return res.status(400).json({ error: "from/to required" }); }
    }
    // delegate to quote logic but return single
    return app._router.stack.find(r => r.route && r.route.path === '/fare/quote') ? res.redirect(307, '/fare/quote') : res.status(400).json({ error: "Use /fare/quote" });
  });

  app.get('/fare/config', async (req, res) => {
    const cfg = await getConfig();
    res.json({ config: cfg, govt_rates: cfg.rates, hard_max_surge: HARD_MAX_SURGE, note: "Karnataka compliant - surge capped at 1.0" });
  });

  const adminGuard = (req, res, next) => (!supabase ? res.status(503).json({ error: 'Storage not configured' }) : adminOk(req) ? next() : res.status(401).json({ error: 'Wrong admin password' }));
  app.get('/admin/api/pricing', adminGuard, async (req, res) => {
    res.json({ config: await getConfig(true), hard_max_surge: HARD_MAX_SURGE, karnataka_note: "Max multiplier is locked to 1.0 per Karnataka Rule 129 - surge prohibited" });
  });
  app.post('/admin/api/pricing', adminGuard, async (req, res) => {
    const clean = sanitize(req.body && req.body.config);
    // Force Karnataka compliance again
    clean.surge.max_multiplier = 1.0;
    const { error } = await supabase.from('app_settings').upsert({ key: 'pricing', value: clean, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: 'Could not save: ' + error.message });
    cfgCache = { at: Date.now(), value: clean };
    console.log('💰 Pricing settings updated (Karnataka compliant)');
    res.json({ success: true, config: clean });
  });
}

mount.takeQuote = async (redis, quote_id, customer_id) => {
  if (!quote_id || !/^Q_[0-9a-f]{12}$/.test(String(quote_id))) return null;
  const key = 'quote:' + quote_id;
  const out = await redis.multi().get(key).del(key).exec();
  const raw = out && out[0] && out[0][1];
  if (!raw) return null;
  try {
    const q = JSON.parse(raw);
    return q.customer_id === customer_id ? q : null;
  } catch (e) {
    return null;
  }
};
mount._test = { sanitize, priceFor, computeSurge, istNow, DEFAULTS };

module.exports = mount;
