// Driver registration, document upload (private Supabase bucket) and admin verification.
// Mounted from index.js:  const driverReg = require('./driver_registration'); driverReg(app, io);
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'driver-docs';
const REQUIRED_BASE = ['SELFIE', 'DL', 'AADHAAR', 'RC', 'PERMIT', 'INSURANCE'];
const ALL_DOCS = [...REQUIRED_BASE, 'POLICE', 'FITNESS'];
const DOC_NAMES = {
  SELFIE: 'Selfie', DL: 'Driving licence', AADHAAR: 'Aadhaar', RC: 'RC book', PERMIT: 'Vehicle permit',
  INSURANCE: 'Insurance', POLICE: 'Police verification', FITNESS: 'Fitness certificate',
};
// Police verification: required for taxis. For autos it is off until you confirm the state rule;
// set POLICE_REQUIRED_AUTO=true in Render to require it for autos too.
const policeRequired = (vehicleType) => vehicleType === 'TAXI' || process.env.POLICE_REQUIRED_AUTO === 'true';
const requiredDocsFor = (driver) => (policeRequired(driver.vehicle_type) ? [...REQUIRED_BASE, 'POLICE'] : REQUIRED_BASE);
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

// ---------- compliance: documents + expiry dates + police rule ----------
const DATE_RULES = [ // [column, label, required?]
  ['dl_expiry', 'Driving licence', true],
  ['permit_expiry', 'Vehicle permit', true],
  ['insurance_expiry', 'Insurance', true],
  ['fitness_expiry', 'Fitness certificate', false],
];
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
const daysUntil = (dateStr) => Math.round((new Date(dateStr + 'T00:00:00Z') - new Date(todayIst() + 'T00:00:00Z')) / 86400000);

async function getCompliance(driver_id) {
  const { data } = await supabase.from('driver_compliance').select('*').eq('driver_id', driver_id).maybeSingle();
  return data || null;
}

// issues block the driver from going online; warnings are shown (expiring within 30 days)
function evaluate(driver, comp, haveDocs, opts = {}) {
  const issues = [];
  const warnings = [];
  if (!opts.skipStatus && driver.status !== 'VERIFIED') issues.push('Your account is not verified yet');
  for (const t of requiredDocsFor(driver)) if (!haveDocs.has(t)) issues.push('Missing document: ' + DOC_NAMES[t]);
  if (policeRequired(driver.vehicle_type) && !driver.police_verified) issues.push('Police verification is not confirmed yet');
  if (!comp) {
    issues.push('Licence, permit and insurance details are not entered yet');
  } else {
    for (const [col, label, req] of DATE_RULES) {
      const v = comp[col];
      if (!v) {
        if (req) issues.push(label + ' expiry date is missing');
        continue;
      }
      const left = daysUntil(v);
      if (left < 0) issues.push(label + ' expired on ' + v);
      else if (left <= 30) warnings.push(label + ' expires in ' + left + ' day' + (left === 1 ? '' : 's') + ' (' + v + ')');
    }
  }
  return { ok: issues.length === 0, issues, warnings };
}

async function driverCompliance(driver, opts = {}) {
  const { data: docs } = await supabase.from('driver_documents').select('doc_type').eq('driver_id', driver.driver_id);
  const have = new Set((docs || []).map((x) => x.doc_type));
  return evaluate(driver, await getCompliance(driver.driver_id), have, opts);
}

// the driver app asks for this about every 4 seconds, so remember the answer for a minute
const onlineCache = new Map();

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
    const { data: docs } = await supabase.from('driver_documents').select('doc_type,status,uploaded_at,storage_path').eq('driver_id', req.driver.driver_id);
    const compliance = await driverCompliance(req.driver);
    const required = requiredDocsFor(req.driver);
    res.json({ driver: publicDriver(req.driver), documents: docs || [], required, optional: ALL_DOCS.filter((t) => !required.includes(t)), compliance });
  });

  // Signed URL to view document from private Supabase bucket driver-docs
  app.get('/driver/docs/:type/url', needDb, requireDriver, async (req, res) => {
    try {
      const type = String(req.params.type).toUpperCase();
      if (!ALL_DOCS.includes(type)) return res.status(400).json({ error: 'Unknown doc type' });
      const { data: doc } = await supabase.from('driver_documents').select('storage_path').eq('driver_id', req.driver.driver_id).eq('doc_type', type).maybeSingle();
      if (!doc || !doc.storage_path) return res.status(404).json({ error: 'Document not found in driver_documents table' });
      // Create signed URL valid 5 minutes
      const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300);
      if (error || !signed) return res.status(500).json({ error: 'Could not create signed URL: ' + (error?.message || 'unknown') });
      res.json({ url: signed.signedUrl, doc_type: type, storage_path: doc.storage_path });
    } catch (e) {
      console.log('signed url error', e.message);
      res.status(500).json({ error: e.message });
    }
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
      res.json({ success: true, doc_type: type, status: d.status, missing: requiredDocsFor(d).filter((t) => !have.has(t)) });
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
      const missing = requiredDocsFor(d).filter((t) => !have.has(t));
      if (missing.length) return res.status(400).json({ error: 'Upload all required documents first. Missing: ' + missing.map((t) => DOC_NAMES[t]).join(', ') });
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
    const comp = await getCompliance(d.driver_id);
    const have = new Set(out.map((x) => x.doc_type));
    res.json({
      driver: publicDriver(d),
      documents: out,
      required: requiredDocsFor(d),
      police_required: policeRequired(d.vehicle_type),
      compliance_details: comp,
      compliance: evaluate(d, comp, have, { skipStatus: true }),
    });
  });

  app.post('/admin/api/drivers/:id/approve', adminGuard, async (req, res) => {
    const d = await getDriver(req.params.id);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const { data: docs } = await supabase.from('driver_documents').select('doc_type').eq('driver_id', d.driver_id);
    const have = new Set((docs || []).map((x) => x.doc_type));
    const missing = requiredDocsFor(d).filter((t) => !have.has(t));
    if (missing.length) return res.status(400).json({ error: 'Missing documents: ' + missing.map((t) => DOC_NAMES[t]).join(', ') });
    const check = evaluate(d, await getCompliance(d.driver_id), have, { skipStatus: true });
    if (!check.ok) return res.status(400).json({ error: 'Cannot approve yet: ' + check.issues.join('; ') });
    const t = nowIso();
    await supabase.from('drivers').update({ status: 'VERIFIED', verified_at: t, rejection_reason: null, updated_at: t }).eq('driver_id', d.driver_id);
    await supabase.from('driver_documents').update({ status: 'APPROVED' }).eq('driver_id', d.driver_id);
    onlineCache.delete(d.driver_id);
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

  // admin enters the details read from the documents (licence, permit, insurance, fitness)
  app.post('/admin/api/drivers/:id/compliance', adminGuard, async (req, res) => {
    const d = await getDriver(req.params.id);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const b = req.body || {};
    const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 40));
    const date = (v) => (v == null || String(v).trim() === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : 'BAD');
    const row = {
      driver_id: d.driver_id,
      plate_type: ['YELLOW', 'GREEN', 'OTHER'].includes(b.plate_type) ? b.plate_type : null,
      dl_number: text(b.dl_number),
      badge_number: text(b.badge_number),
      permit_number: text(b.permit_number),
      dl_expiry: date(b.dl_expiry),
      permit_expiry: date(b.permit_expiry),
      insurance_expiry: date(b.insurance_expiry),
      fitness_expiry: date(b.fitness_expiry),
      updated_at: nowIso(),
    };
    if (['dl_expiry', 'permit_expiry', 'insurance_expiry', 'fitness_expiry'].some((k) => row[k] === 'BAD')) return res.status(400).json({ error: 'Dates must look like 2027-03-31' });
    const { error } = await supabase.from('driver_compliance').upsert(row, { onConflict: 'driver_id' });
    if (error) {
      console.log('compliance save error', error.message);
      return res.status(500).json({ error: 'Could not save: ' + error.message });
    }
    onlineCache.delete(d.driver_id);
    res.json({ success: true, compliance: await driverCompliance(d, { skipStatus: true }) });
  });

  // drivers with a licence / permit / insurance / fitness date that has passed or is close
  app.get('/admin/api/compliance/expiring', adminGuard, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const limit = new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const cols = DATE_RULES.map((r) => r[0]);
    const { data, error } = await supabase.from('driver_compliance').select('*').or(cols.map((c) => c + '.lte.' + limit).join(','));
    if (error) return res.status(500).json({ error: error.message });
    const ids = (data || []).map((r) => r.driver_id);
    const { data: drivers } = ids.length ? await supabase.from('drivers').select('driver_id,name,phone,vehicle_type,vehicle_number,status').in('driver_id', ids) : { data: [] };
    const byId = Object.fromEntries((drivers || []).map((x) => [x.driver_id, x]));
    const out = [];
    for (const r of data || []) {
      const items = DATE_RULES.filter(([c]) => r[c] && r[c] <= limit).map(([c, label]) => ({ label, date: r[c], days_left: daysUntil(r[c]) }));
      if (items.length) out.push({ driver: byId[r.driver_id] || { driver_id: r.driver_id }, items });
    }
    out.sort((a, b) => Math.min(...a.items.map((i) => i.days_left)) - Math.min(...b.items.map((i) => i.days_left)));
    res.json(out);
  });

  app.post('/admin/api/drivers/:id/police', adminGuard, async (req, res) => {
    const value = (req.body || {}).value === true;
    await supabase.from('drivers').update({ police_verified: value, updated_at: nowIso() }).eq('driver_id', req.params.id);
    onlineCache.delete(req.params.id);
    res.json({ success: true, police_verified: value });
  });
}

module.exports = mount;
module.exports.lookupDriver = async (driver_id) => (supabase ? getDriver(driver_id) : null);
// Used when a driver sends location: logged in, own driver_id, verified, documents and dates in order.
module.exports.onlineCheck = async (req) => {
  if (!supabase) return { ok: false, error: 'Server is not ready' };
  const t = tokenOf(req);
  if (!t) return { ok: false, error: 'Please log in again' };
  const hit = onlineCache.get(t.driver_id);
  let result = hit && Date.now() - hit.at < 60000 ? hit.result : null;
  if (!result) {
    const d = await getDriver(t.driver_id);
    if (!d) return { ok: false, error: 'Account not found' };
    const c = await driverCompliance(d);
    result = { ok: c.ok, error: c.ok ? null : c.issues[0], issues: c.issues };
    onlineCache.set(t.driver_id, { at: Date.now(), result });
  }
  if (String((req.body || {}).driver_id) !== t.driver_id) return { ok: false, error: 'Wrong driver account' };
  return result;
};

// true only for a logged-in, VERIFIED driver sending their own driver_id
module.exports.isVerifiedRequest = async (req) => {
  if (!supabase) return false;
  const t = tokenOf(req);
  if (!t) return false;
  const d = await getDriver(t.driver_id);
  return !!d && d.status === 'VERIFIED' && String((req.body || {}).driver_id) === d.driver_id;
};
