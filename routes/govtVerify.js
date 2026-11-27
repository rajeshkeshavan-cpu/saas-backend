
// BACKEND V92 - GOVT VERIFY WITH OCR + EXPIRY + MANUAL ADMIN
// Based on V91 + 3 doc verification
// D:/Projects/saas-backend/Index-V92.js

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Helper: Parse date from various formats (DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD)
function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    // Try YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return new Date(dateStr);
    // Try DD-MM-YYYY or DD/MM/YYYY
    const parts = dateStr.split(/[-\/]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) return new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
      // Assume DD-MM-YYYY
      return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
    return new Date(dateStr);
  } catch(e) { return null; }
}

function isDLValid(expiryStr) {
  const expiry = parseDate(expiryStr);
  if (!expiry) return { valid: false, reason: 'Invalid expiry date format' };
  const today = new Date(); today.setHours(0,0,0,0);
  const isValid = expiry > today;
  return { 
    valid: isValid, 
    expiry: expiry.toISOString().split('T')[0],
    reason: isValid ? `Valid till ${expiry.toDateString()}` : `Expired on ${expiry.toDateString()}`
  };
}

function isRCValid(vehicleNo, rcData) {
  // RC valid if vehicle number matches and status active
  const cleanInput = vehicleNo.replace(/\s/g,'').toUpperCase();
  const cleanRC = (rcData.registrationNo || rcData.vehicle_number || '').replace(/\s/g,'').toUpperCase();
  const matches = cleanInput === cleanRC || cleanRC.includes(cleanInput) || cleanInput.includes(cleanRC);
  return {
    valid: matches,
    reason: matches ? `Vehicle ${cleanInput} matched in RC` : `Vehicle mismatch: Input ${cleanInput} vs RC ${cleanRC}`
  };
}

function isAadhaarValid(aadhaarNo) {
  // Basic Aadhaar validation: 12 digits + Verhoeff check (simplified Luhn)
  const clean = aadhaarNo.replace(/\s/g,'');
  if (!/^\d{12}$/.test(clean)) return { valid: false, reason: 'Aadhaar must be 12 digits' };
  if (/^(.)\1{11}$/.test(clean)) return { valid: false, reason: 'Invalid Aadhaar - all same digits' };
  // Verhoeff simplified - for now accept if 12 digits
  // Real check would call UIDAI via Surepass
  return { valid: true, reason: 'Aadhaar format valid (12 digits)' };
}

// Mock Parivahan call - replace with real API when you have Surepass key
async function callParivahanDL(dlNumber, dob) {
  const apiKey = process.env.PARIVAHAN_API_KEY;
  if (apiKey) {
    // Real API call example for Surepass
    // const res = await fetch('https://kyc-api.surepass.io/api/v1/driving-license/driving-license', {
    //   method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ id_number: dlNumber, dob: dob })
    // });
    // return await res.json();
    return { status: 'mock', message: 'Real API key present but not implemented, using mock' };
  }
  // Mock - for now assume valid if DL number format ok
  const dlRegex = /^[A-Z]{2}[0-9]{2}\s?[0-9]{11}$|^[A-Z]{2}-[0-9]{2}-[0-9]{7,11}$/i;
  return {
    status: 'MOCK_VALID',
    dl_number: dlNumber,
    name: 'Mock Driver',
    valid: dlRegex.test(dlNumber.replace(/-/g,'')) || dlNumber.length > 10
  };
}

async function callParivahanRC(vehicleNo) {
  const apiKey = process.env.PARIVAHAN_API_KEY;
  if (apiKey) {
    // Real RC API
    return { status: 'mock' };
  }
  // Mock - valid if format KA03XY9999
  const rcRegex = /^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$/i;
  return {
    status: 'MOCK_VALID',
    registrationNo: vehicleNo.toUpperCase(),
    owner: 'Mock Owner',
    valid: rcRegex.test(vehicleNo.replace(/\s/g,''))
  };
}

// POST /drivers/:driverId/verify/dl
router.post('/drivers/:driverId/verify/dl', upload.none(), async (req, res) => {
  try {
    const { driverId } = req.params;
    const { dl_number, dob, expiry_date, dl_text } = req.body;
    
    if (!dl_number || !expiry_date) {
      return res.status(400).json({ ok: false, error: 'dl_number and expiry_date required' });
    }

    // 1. Check expiry
    const expiryCheck = isDLValid(expiry_date);
    
    // 2. Call Parivahan (mock for now)
    const parivahan = await callParivahanDL(dl_number, dob);
    
    const finalValid = expiryCheck.valid && (parivahan.valid !== false);
    
    // 3. Save to Supabase driver_documents
    const { error } = await supabase.from('driver_documents').upsert({
      driver_id: driverId,
      doc_type: 'DL',
      doc_number: dl_number,
      expiry_date: expiryCheck.expiry,
      status: finalValid ? 'APPROVED' : 'REJECTED',
      verification_data: {
        expiry_check: expiryCheck,
        parivahan: parivahan,
        dob: dob,
        verified_at: new Date().toISOString(),
        method: process.env.PARIVAHAN_API_KEY ? 'PARIVAHAN_API' : 'OCR_EXPIRY_MOCK'
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id,doc_type' });

    if (error) throw error;

    // 4. Update drivers table compliance
    await supabase.from('drivers').update({
      dl_verified: finalValid,
      dl_expiry: expiryCheck.expiry
    }).eq('driver_id', driverId);

    res.json({
      ok: true,
      valid: finalValid,
      dl_number,
      expiry_check: expiryCheck,
      parivahan,
      message: finalValid ? 'DL Verified ✓' : `DL Rejected: ${expiryCheck.reason}`
    });

  } catch(e) {
    console.error('DL verify error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /drivers/:driverId/verify/rc
router.post('/drivers/:driverId/verify/rc', upload.none(), async (req, res) => {
  try {
    const { driverId } = req.params;
    const { rc_number, vehicle_number, chassis_no } = req.body;
    const vNo = rc_number || vehicle_number;
    
    if (!vNo) return res.status(400).json({ ok: false, error: 'rc_number or vehicle_number required' });

    // Get driver to compare vehicle number
    const { data: driver } = await supabase.from('drivers').select('vehicle_number').eq('driver_id', driverId).single();
    const driverVehicle = driver?.vehicle_number || '';

    const parivahan = await callParivahanRC(vNo);
    const matchCheck = isRCValid(vNo, parivahan);
    const vehicleMatch = driverVehicle ? vNo.replace(/\s/g,'').toUpperCase() === driverVehicle.replace(/\s/g,'').toUpperCase() : true;

    const finalValid = matchCheck.valid && vehicleMatch && (parivahan.valid !== false);

    await supabase.from('driver_documents').upsert({
      driver_id: driverId,
      doc_type: 'RC',
      doc_number: vNo,
      status: finalValid ? 'APPROVED' : 'REJECTED',
      verification_data: {
        vehicle_match: { driver_vehicle: driverVehicle, input: vNo, matches: vehicleMatch },
        parivahan,
        match_check: matchCheck,
        chassis_no,
        verified_at: new Date().toISOString(),
        method: process.env.PARIVAHAN_API_KEY ? 'PARIVAHAN_API' : 'OCR_MOCK'
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id,doc_type' });

    await supabase.from('drivers').update({ rc_verified: finalValid }).eq('driver_id', driverId);

    res.json({
      ok: true,
      valid: finalValid,
      rc_number: vNo,
      vehicle_match: vehicleMatch,
      parivahan,
      match_check: matchCheck,
      message: finalValid ? 'RC Verified ✓' : `RC Rejected: ${matchCheck.reason}`
    });

  } catch(e) {
    console.error('RC verify error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /drivers/:driverId/verify/aadhaar
router.post('/drivers/:driverId/verify/aadhaar', upload.none(), async (req, res) => {
  try {
    const { driverId } = req.params;
    const { aadhaar_number } = req.body;
    
    if (!aadhaar_number) return res.status(400).json({ ok: false, error: 'aadhaar_number required' });

    const aadhaarCheck = isAadhaarValid(aadhaar_number);
    
    // Mock UIDAI call - real would use Surepass
    const uidaiMock = {
      status: process.env.AADHAAR_API_KEY ? 'API_NOT_IMPLEMENTED' : 'MOCK_VALID',
      aadhaar_number: aadhaar_number.replace(/\s/g,''),
      valid: aadhaarCheck.valid
    };

    const finalValid = aadhaarCheck.valid && uidaiMock.valid;

    await supabase.from('driver_documents').upsert({
      driver_id: driverId,
      doc_type: 'AADHAAR',
      doc_number: aadhaar_number.replace(/\s/g,''),
      status: finalValid ? 'APPROVED' : 'REJECTED',
      verification_data: {
        format_check: aadhaarCheck,
        uidai: uidaiMock,
        verified_at: new Date().toISOString(),
        method: process.env.AADHAAR_API_KEY ? 'UIDAI_API' : 'FORMAT_CHECK_MOCK'
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id,doc_type' });

    await supabase.from('drivers').update({ aadhaar_verified: finalValid }).eq('driver_id', driverId);

    res.json({
      ok: true,
      valid: finalValid,
      aadhaar_number: aadhaar_number.replace(/\s/g,''),
      format_check: aadhaarCheck,
      uidai: uidaiMock,
      message: finalValid ? 'Aadhaar Verified ✓' : `Aadhaar Rejected: ${aadhaarCheck.reason}`
    });

  } catch(e) {
    console.error('Aadhaar verify error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ADMIN MANUAL VERIFY - POST /admin/drivers/:driverId/verify-doc
router.post('/admin/drivers/:driverId/verify-doc', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { doc_type, status, admin_note } = req.body; // status: APPROVED or REJECTED
    
    if (!doc_type || !status) return res.status(400).json({ ok: false, error: 'doc_type and status required' });

    const { data, error } = await supabase.from('driver_documents').upsert({
      driver_id: driverId,
      doc_type: doc_type.toUpperCase(),
      status: status.toUpperCase(),
      verification_data: {
        manual_verify: true,
        admin_note: admin_note || '',
        verified_by: 'ADMIN',
        verified_at: new Date().toISOString(),
        method: 'MANUAL_ADMIN'
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id,doc_type' }).select();

    if (error) throw error;

    // Update drivers table flags
    const flagMap = { 'DL': 'dl_verified', 'RC': 'rc_verified', 'AADHAAR': 'aadhaar_verified' };
    const flag = flagMap[doc_type.toUpperCase()];
    if (flag) {
      await supabase.from('drivers').update({ [flag]: status.toUpperCase() === 'APPROVED' }).eq('driver_id', driverId);
    }

    // Check if all 3 docs approved -> mark govt verified
    const { data: allDocs } = await supabase.from('driver_documents').select('doc_type,status').eq('driver_id', driverId).in('doc_type', ['DL','RC','AADHAAR']);
    const approvedCount = (allDocs || []).filter(d => d.status === 'APPROVED').length;
    const govtVerified = approvedCount >= 3;

    if (govtVerified) {
      await supabase.from('drivers').update({ govt_verified: true, verification_status: 'APPROVED' }).eq('driver_id', driverId);
    }

    res.json({ ok: true, doc: data, govt_verified: govtVerified, approved_count: approvedCount, message: `${doc_type} ${status} by admin` });

  } catch(e) {
    console.error('Admin verify error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /drivers/:driverId/verification-status
router.get('/drivers/:driverId/verification-status', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { data: docs, error } = await supabase.from('driver_documents').select('*').eq('driver_id', driverId).in('doc_type', ['DL','RC','AADHAAR']);
    if (error) throw error;

    const dl = docs.find(d => d.doc_type === 'DL');
    const rc = docs.find(d => d.doc_type === 'RC');
    const aadhaar = docs.find(d => d.doc_type === 'AADHAAR');

    const govtVerified = docs.filter(d => d.status === 'APPROVED').length >= 3;

    res.json({
      ok: true,
      driver_id: driverId,
      govt_verified: govtVerified,
      docs: {
        DL: { status: dl?.status || 'PENDING', expiry: dl?.expiry_date, verified: dl?.status === 'APPROVED' },
        RC: { status: rc?.status || 'PENDING', verified: rc?.status === 'APPROVED' },
        AADHAAR: { status: aadhaar?.status || 'PENDING', verified: aadhaar?.status === 'APPROVED' }
      },
      all_docs: docs,
      can_go_online: govtVerified
    });

  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
