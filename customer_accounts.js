// Customer accounts: sign up / log in with phone + 4 digit PIN (stored hashed in Supabase).
// Mounted from index.js:  const customerAcc = require('./customer_accounts'); customerAcc(app);
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const publicCustomer = (c) => {
  if (!c) return null;
  const { pin_hash, ...rest } = c;
  return rest;
};

async function getCustomer(customer_id) {
  if (!supabase || !customer_id) return null;
  const { data } = await supabase.from('customers').select('*').eq('customer_id', customer_id).maybeSingle();
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

// 5 wrong PINs lock a phone for 10 minutes
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

function mount(app) {
  const needDb = (req, res, next) => (supabase ? next() : res.status(503).json({ error: 'Storage not configured' }));

  app.post('/customer/signup', needDb, async (req, res) => {
    try {
      const { name, phone, pin } = req.body || {};
      if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Enter your name' });
      if (!/^\d{10}$/.test(String(phone || ''))) return res.status(400).json({ error: 'Enter a 10 digit phone number' });
      if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4 digits' });
      const pin_hash = await bcrypt.hash(String(pin), 10);
      const customer_id = 'CUS_' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const { data, error } = await supabase
        .from('customers')
        .insert({ customer_id, phone: String(phone), name: String(name).trim(), pin_hash })
        .select()
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'This phone number is already registered. Please log in.' });
        console.log('customer signup error', error.message);
        return res.status(500).json({ error: 'Could not sign up. Try again.' });
      }
      const token = jwt.sign({ customer_id }, JWT_SECRET, { expiresIn: '90d' });
      console.log(`🧑 Customer registered ${customer_id}`);
      res.json({ success: true, token, customer: publicCustomer(data) });
    } catch (e) {
      console.log('customer signup exception', e.message);
      res.status(500).json({ error: 'Could not sign up. Try again.' });
    }
  });

  app.post('/customer/login', needDb, async (req, res) => {
    try {
      const { phone, pin } = req.body || {};
      if (!/^\d{10}$/.test(String(phone || '')) || !/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'Enter phone and 4 digit PIN' });
      if (isLocked(phone)) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 10 minutes.' });
      const { data: c } = await supabase.from('customers').select('*').eq('phone', String(phone)).maybeSingle();
      const ok = c && (await bcrypt.compare(String(pin), c.pin_hash));
      if (!ok) {
        noteFail(phone);
        return res.status(401).json({ error: 'Wrong phone or PIN' });
      }
      failures.delete(phone);
      const token = jwt.sign({ customer_id: c.customer_id }, JWT_SECRET, { expiresIn: '90d' });
      res.json({ success: true, token, customer: publicCustomer(c) });
    } catch (e) {
      console.log('customer login exception', e.message);
      res.status(500).json({ error: 'Could not log in. Try again.' });
    }
  });

  app.get('/customer/me', needDb, async (req, res) => {
    const c = await mount.customerFromReq(req);
    if (!c) return res.status(401).json({ error: 'Please log in again' });
    res.json({ customer: publicCustomer(c) });
  });
}

// returns the logged-in customer (or null). Driver tokens have no customer_id, so they never match.
mount.customerFromReq = async (req) => {
  const t = tokenOf(req);
  if (!t || !t.customer_id) return null;
  return getCustomer(t.customer_id);
};

module.exports = mount;
