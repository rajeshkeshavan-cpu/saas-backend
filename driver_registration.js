// Driver registration, document upload (private Supabase bucket) and admin verification.
// Mounted from index.js:  const driverReg = require('./driver_registration'); driverReg(app, io);
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'driver-docs';
const REQUIRED_DOCS = ['SELFIE', 'DL', 'AADHAAR', 'RC'];
const ALL_DOCS = [...REQUIRED_DOCS, 'POLICE']; // police verification is optional
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;
if (!supabase) console.log('⚠️  Supabase not configured (set SUPABASE_URL and SUPABASE_SERVICE_KEY)');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.log('⚠️  JWT_SECRET not set - driver logins will reset on every restart');
if (!process.env.ADMIN_PASSWORD) console.log('⚠️  ADMIN_PASSWORD not set - admin page is disabled');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!EXT[file.mimetype]),
});

// runs multer but answers with JSON instead of an HTML error page
const uploadOne = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (err) {
      const big = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: big ? 'That photo is larger than 5 MB. Try again.' : 'Upload failed. Try again.' });
    }
    next();
  });

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();
const newDriverId = () => 'DRV_' + crypto.randomBytes(3).toString('hex').toUpperCase();
const publicDriver = (d) => {
  if (!d) return null;
  const { pin_hash, ...rest } = d;
  return rest;
};

async function getDriver(driver_id) {
  const { data } = await supabase.from('drivers').select('*').eq('driver_id', driver_id).maybeSingle();
  return data || null;
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(h.slice(7), JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// simple login brute-force protection: 5 wrong PINs locks that phone for 10 minutes
const failures = new Map();
const isLocked = (phone) => {
  const f = failures.get(phone);
  return !!f && f.count >= 5 && Date.now() - f.last < 10 * 60 * 1000;
};
const noteFail = (phone) => {
  const f = failures.get(phone);
  if (!f || Date.now() - f.last > 10 * 60 * 1000) failures.set(phone, { count: 1, last: Date.now() });
  else failures.set(phone, { count: f.count + 1, last: Date.now() });
};

function adminOk(req) {
  const pw = process.env.ADMIN_PASSWORD || '';
  const key = String(req.headers['x-admin-key'] || '');
  if (!pw || key.length !== pw.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(pw));
}

// ---------- routes ----------
function mount(app, io) {
  const needDb = (req, res, next) => (supabase ? next() : res.status(503).json({ error: 'Storage not configured' }));

  const requireDriver = async (req, res, next) => {
    const t = tokenOf(req);
    if (!t) return res.status(401).json({ error: 'Please log in again' });
    const d = await getDriver(t.driver_id);
    if (!d) return res.status(401).json({ error: 'Account not found' });
    req.driver = d;
    next();
  };

  const adminGuard = (req, res, next) => {
    if (!supabase) return res.status(503).json({ error: 'Storage not configured' });
    if (!adminOk(req)) return res.status(401).json({ error: 'Wrong admin password' });
    next();
  };

  // ----- driver: register / login / profile -----
  app.post('/driver/register', needDb, async (req, res) => {
    try {
      const { name, phone, pin, vehicle_type, vehicle_number } = req.body || {};
      const vt = String(vehicle_type || '').toUpperCase();
      if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Enter your name' });
      if (!/^\d{10}$/.test(String(phone || ''))) return res.status(400).json({ error: 'Enter a 10 digit phone number' });
      if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
      if (!['AUTO', 'TAXI'].includes(vt)) return res.status(400).json({ error: 'Choose Auto or Taxi' });
      if (!vehicle_number || String(vehicle_number).trim().length < 4) return res.status(400).json({ error: 'Enter the vehicle number' });

      const pin_hash = await bcrypt.hash(String(pin), 10);
      const driver_id = newDriverId();
      const { data, error } = await supabase
        .from('drivers')
        .insert({ driver_id, phone: String(phone), name: String(name).trim(), pin_hash, vehicle_type: vt, vehicle_number: String(vehicle_number).trim().toUpperCase() })
        .select()
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'This phone number is already registered. Please log in.' });
        console.log('register error', error.message);
        return res.status(500).json({ error: 'Could not register. Try again.' });
      }
      const token = jwt.sign({ driver_id }, JWT_SECRET, { expiresIn: '90d' });
      console.log(`🧾 Driver registered ${driver_id} ${vt}`);
      res.json({ success: true, token, driver: publicDriver(data) });
    } catch (e) {
      console.log('register exception', e.message);
      res.status(500).json({ error: 'Could not register. Try again.' });
    }
  });

  app.post('/driver/login', needDb, async (req, res) => {
    try {
      const { phone, pin } = req.body || {};
      if (!/^\d{10}$/.test(String(phone || '')) || !/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'Enter phone and 4 digit PIN' });
      if (isLocked(phone)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 10 minutes.' });
      const { data: d } = await supabase.from('drivers').select('*').eq('phone', String(phone)).maybeSingle();
      const ok = d && (await bcrypt.compare(String(pin), d.pin_hash));
      if (!ok) {
        noteFail(phone);
        return res.status(401).json({ error: 'Wrong phone or PIN' });
      }
      failures.delete(phone);
      const token = jwt.sign({ driver_id: d.driver_id }, JWT_SECRET, { expiresIn: '90d' });
      res.json({ success: true, token, driver: publicDriver(d) });
    } catch (e) {
      console.log('login exception', e.message);
      res.status(500).json({ error: 'Could not log in. Try again.' });
    }
  });

  app.get('/driver/me', needDb, requireDriver, async (req, res) => {
    const { data: docs } = await supabase.from('driver_documents').select('doc_type,status,uploaded_at').eq('driver_id', req.driver.driver_id);
    res.json({ driver: publicDriver(req.driver), documents: docs || [], required: REQUIRED_DOCS, optional: ['POLICE'] });
  });

  // ----- driver: upload one document (multipart field "file") -----
  app.post('/driver/docs/:type', needDb, requireDriver, uploadOne, async (req, res) => {
    try {
      const type = String(req.params.type).toUpperCase();
      const d = req.driver;
      if (!ALL_DOCS.includes(type)) return res.status(400).json({ error: 'Unknown document type' });
      if (!req.file) return res.status(400).json({ error: 'Send a JPG/PNG image or PDF up to 5 MB in the field "file"' });
      if (type === 'SELFIE' && req.file.mimetype === 'application/pdf') return res.status(400).json({ error: 'Selfie must be a photo' });
      if (!['DOCS_PENDING', 'UNDER_REVIEW', 'REJECTED'].includes(d.status)) return res.status(409).json({ error: 'Your account is already verified. Contact support to change documents.' });

      const storage_path = `${d.driver_id}/${type}.${EXT[req.file.mimetype]}`;
      const { data: old } = await supabase.from('driver_documents').select('storage_path').eq('driver_id', d.driver_id).eq('doc_type', type).maybeSingle();
      const up = await supabase.storage.from(BUCKET).upload(storage_path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (up.error) {
        console.log('upload error', up.error.message);
        return res.status(500).json({ error: 'Upload failed. Try again.' });
      }
      if (old && old.storage_path !== storage_path) await supabase.storage.from(BUCKET).remove([old.storage_path]);
      const row = { driver_id: d.driver_id, doc_type: type, storage_path, status: 'UPLOADED', note: null, uploaded_at: nowIso() };
      const { error: dbErr } = await supabase.from('driver_documents').upsert(row, { onConflict: 'driver_id,doc_type' });
      if (dbErr) {
        console.log('doc row error', dbErr.message);
        return res.status(500).json({ error: 'Could not save the document. Try again.' });
      }

      const { data: docs } = await supabase.from('driver_documents').select('doc_type').eq('driver_id', d.driver_id);
      const have = new Set((docs || []).map((x) => x.doc_type));
      res.json({ success: true, doc_type: type, status: d.status, missing: REQUIRED_DOCS.filter((t) => !have.has(t)) });
    } catch (e) {
      console.log('upload exception', e.message);
      res.status(500).json({ error: 'Upload failed. Try again.' });
    }
  });

  // ----- driver: submit all documents for review (needs the 4 required documents) -----
  app.post('/driver/submit', needDb, requireDriver, async (req, res) => {
    try {
      const d = req.driver;
      if (!['DOCS_PENDING', 'REJECTED'].includes(d.status)) return res.status(409).json({ error: 'Your documents are already submitted.' });
      const { data: docs } = await supabase.from('driver_documents').select('doc_type').eq('driver_id', d.driver_id);
      const have = new Set((docs || []).map((x) => x.doc_type));
      const missing = REQUIRED_DOCS.filter((t) => !have.has(t));
      if (missing.length) return res.status(400).json({ error: 'Upload all required documents first. Missing: ' + missing.join(', ') });
      await supabase.from('drivers').update({ status: 'UNDER_REVIEW', rejection_reason: null, updated_at: nowIso() }).eq('driver_id', d.driver_id);
      console.log(`📨 Driver submitted for review ${d.driver_id}`);
      res.json({ success: true, status: 'UNDER_REVIEW' });
    } catch (e) {
      console.log('submit exception', e.message);
      res.status(500).json({ error: 'Could not submit. Try again.' });
    }
  });

  // ----- admin (header x-admin-key = ADMIN_PASSWORD) -----
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

  app.get('/admin/api/drivers', adminGuard, async (req, res) => {
    let q = supabase
      .from('drivers')
      .select('driver_id,name,phone,vehicle_type,vehicle_number,status,police_verified,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    if (req.query.status) q = q.eq('status', String(req.query.status).toUpperCase());
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.get('/admin/api/drivers/:id', adminGuard, async (req, res) => {
    const d = await getDriver(req.params.id);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const { data: docs } = await supabase.from('driver_documents').select('*').eq('driver_id', d.driver_id);
    const out = [];
    for (const doc of docs || []) {
      const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 600); // link works 10 minutes
      out.push({ doc_type: doc.doc_type, status: doc.status, uploaded_at: doc.uploaded_at, url: s ? s.signedUrl : null, is_pdf: doc.storage_path.endsWith('.pdf') });
    }
    res.json({ driver: publicDriver(d), documents: out, required: REQUIRED_DOCS });
  });

  app.post('/admin/api/drivers/:id/approve', adminGuard, async (req, res) => {
    const d = await getDriver(req.params.id);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const { data: docs } = await supabase.from('driver_documents').select('doc_type').eq('driver_id', d.driver_id);
    const have = new Set((docs || []).map((x) => x.doc_type));
    const missing = REQUIRED_DOCS.filter((t) => !have.has(t));
    if (missing.length) return res.status(400).json({ error: 'Missing documents: ' + missing.join(', ') });
    const t = nowIso();
    await supabase.from('drivers').update({ status: 'VERIFIED', verified_at: t, rejection_reason: null, updated_at: t }).eq('driver_id', d.driver_id);
    await supabase.from('driver_documents').update({ status: 'APPROVED' }).eq('driver_id', d.driver_id);
    console.log(`✅ Driver verified ${d.driver_id}`);
    io.emit('driver:status', { driver_id: d.driver_id, status: 'VERIFIED' });
    res.json({ success: true });
  });

  app.post('/admin/api/drivers/:id/reject', adminGuard, async (req, res) => {
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Give a reason so the driver knows what to fix' });
    const d = await getDriver(req.params.id);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    await supabase.from('drivers').update({ status: 'REJECTED', rejection_reason: reason, updated_at: nowIso() }).eq('driver_id', d.driver_id);
    console.log(`❌ Driver rejected ${d.driver_id}: ${reason}`);
    io.emit('driver:status', { driver_id: d.driver_id, status: 'REJECTED' });
    res.json({ success: true });
  });

  app.post('/admin/api/drivers/:id/police', adminGuard, async (req, res) => {
    const value = (req.body || {}).value === true;
    await supabase.from('drivers').update({ police_verified: value, updated_at: nowIso() }).eq('driver_id', req.params.id);
    res.json({ success: true, police_verified: value });
  });
}

module.exports = mount;
module.exports.lookupDriver = async (driver_id) => (supabase ? getDriver(driver_id) : null);
// true only for a logged-in, VERIFIED driver sending their own driver_id
module.exports.isVerifiedRequest = async (req) => {
  if (!supabase) return false;
  const t = tokenOf(req);
  if (!t) return false;
  const d = await getDriver(t.driver_id);
  return !!d && d.status === 'VERIFIED' && String((req.body || {}).driver_id) === d.driver_id;
};
