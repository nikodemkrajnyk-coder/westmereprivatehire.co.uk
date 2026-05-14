'use strict';
/**
 * auto-file.js — Real-time filing of business data to organized folders.
 *
 * Every time data enters or changes in the system, the corresponding file
 * in the WestmereData/ folder is created/updated/deleted automatically.
 *
 * On Railway (production): files live in /data/WestmereData/
 * On local Mac with iCloud: also mirrored to
 *   ~/Library/Mobile Documents/com~apple~CloudDocs/WestmereData/
 *
 * Folder structure:
 *   WestmereData/
 *     Bookings/YYYY-MM/<ref>.json
 *     Customers/<id>_<name>.json
 *     Drivers/<Name>/profile.json
 *     Drivers/<Name>/<doc_type>.<ext>
 *     Invoices/<invoice_no>.json
 *     Invoices/<invoice_no>.pdf
 *     Earnings/monthly/<YYYY-MM>.json
 *
 * All writes are fire-and-forget — errors are logged but never thrown,
 * so a filing failure can never break the main request.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { DATA_DIR } = require('./db');

// ── Destination roots ────────────────────────────────────────────────────────

const LOCAL_ROOT = path.join(DATA_DIR, 'WestmereData');

const ICLOUD_ROOT = path.join(
  os.homedir(),
  'Library', 'Mobile Documents', 'com~apple~CloudDocs',
  'WestmereData'
);

function iCloudAvailable() {
  try {
    return fs.existsSync(path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  } catch { return false; }
}

// ── Core helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Write JSON to path, creating parent dirs as needed. */
function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Write a buffer/string to path, creating parent dirs as needed. */
function writeBuf(filePath, buf) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buf);
}

/** Copy a file, creating parent dirs as needed. */
function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/** Delete a file if it exists. */
function del(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

/**
 * Write to LOCAL_ROOT and, if iCloud is available, also to ICLOUD_ROOT.
 * rel is the path relative to the data root, e.g. 'Bookings/2026-05/WM-XYZ.json'
 */
function writeToRoots(rel, writeFn) {
  writeFn(path.join(LOCAL_ROOT, rel));
  if (iCloudAvailable()) {
    try { writeFn(path.join(ICLOUD_ROOT, rel)); } catch (_) {}
  }
}

function deleteFromRoots(rel) {
  del(path.join(LOCAL_ROOT, rel));
  if (iCloudAvailable()) {
    try { del(path.join(ICLOUD_ROOT, rel)); } catch (_) {}
  }
}

function safeName(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 50);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * File or update a single booking.
 * booking — full booking row from DB
 */
function fileBooking(booking) {
  if (!booking) return;
  setImmediate(() => {
    try {
      const mon = (booking.date || 'unknown').slice(0, 7);
      const ref = (booking.ref || 'unknown').replace(/[^a-zA-Z0-9\-_]/g, '');
      const rel = `Bookings/${mon}/${ref}.json`;
      writeToRoots(rel, p => writeJson(p, booking));
    } catch (e) {
      console.error('[AUTO-FILE] fileBooking error:', e.message);
    }
  });
}

/**
 * Delete the filed copy of a booking.
 * ref — booking reference, date — 'YYYY-MM-DD'
 */
function removeBooking(ref, date) {
  if (!ref) return;
  setImmediate(() => {
    try {
      const mon = (date || '').slice(0, 7) || 'unknown';
      const safeRef = ref.replace(/[^a-zA-Z0-9\-_]/g, '');
      deleteFromRoots(`Bookings/${mon}/${safeRef}.json`);
    } catch (e) {
      console.error('[AUTO-FILE] removeBooking error:', e.message);
    }
  });
}

/**
 * File or update a customer record.
 * customer — full customer row from DB
 */
function fileCustomer(customer) {
  if (!customer) return;
  setImmediate(() => {
    try {
      const name = safeName(customer.full_name || customer.email || String(customer.id));
      const rel = `Customers/${customer.id}_${name}.json`;
      // Strip password hash before filing
      const safe = { ...customer };
      delete safe.password;
      delete safe.verification_token;
      writeToRoots(rel, p => writeJson(p, safe));
    } catch (e) {
      console.error('[AUTO-FILE] fileCustomer error:', e.message);
    }
  });
}

/**
 * File or update a driver profile.
 * driver — users row (role=driver|owner)
 */
function fileDriverProfile(driver) {
  if (!driver) return;
  setImmediate(() => {
    try {
      const name = safeName(driver.full_name || String(driver.id));
      const safe = { ...driver };
      delete safe.password;
      delete safe.calendar_token;
      const rel = `Drivers/${name}/profile.json`;
      writeToRoots(rel, p => writeJson(p, safe));
    } catch (e) {
      console.error('[AUTO-FILE] fileDriverProfile error:', e.message);
    }
  });
}

/**
 * File a driver document (copy the uploaded file into the organized folder).
 * driverName — human name for the folder
 * doc — driver_documents row (must have file_path, type, original_name)
 */
function fileDriverDoc(driverName, doc) {
  if (!doc || !doc.file_path) return;
  setImmediate(() => {
    try {
      if (!fs.existsSync(doc.file_path)) return;
      const name = safeName(driverName);
      const ext  = path.extname(doc.original_name || doc.file_path) || '.bin';
      const rel  = `Drivers/${name}/${doc.type}${ext}`;
      writeToRoots(rel, p => copyFile(doc.file_path, p));
    } catch (e) {
      console.error('[AUTO-FILE] fileDriverDoc error:', e.message);
    }
  });
}

/**
 * File an invoice (JSON record, and optionally a PDF buffer).
 * invoiceNo — e.g. 'INV-202605-0001'
 * invoiceData — invoice row or summary object
 * pdfBuffer — optional Buffer; if provided, saved as .pdf alongside .json
 */
function fileInvoice(invoiceNo, invoiceData, pdfBuffer) {
  if (!invoiceNo) return;
  setImmediate(() => {
    try {
      const safe = invoiceNo.replace(/[^a-zA-Z0-9\-_]/g, '');
      writeToRoots(`Invoices/${safe}.json`, p => writeJson(p, invoiceData));
      if (pdfBuffer) {
        writeToRoots(`Invoices/${safe}.pdf`, p => writeBuf(p, pdfBuffer));
      }
    } catch (e) {
      console.error('[AUTO-FILE] fileInvoice error:', e.message);
    }
  });
}

/**
 * Delete the filed copy of an invoice.
 */
function removeInvoice(invoiceNo) {
  if (!invoiceNo) return;
  setImmediate(() => {
    try {
      const safe = invoiceNo.replace(/[^a-zA-Z0-9\-_]/g, '');
      deleteFromRoots(`Invoices/${safe}.json`);
      deleteFromRoots(`Invoices/${safe}.pdf`);
    } catch (e) {
      console.error('[AUTO-FILE] removeInvoice error:', e.message);
    }
  });
}

/**
 * Update the monthly earnings summary for a given YYYY-MM.
 * Called after any booking status change that affects earnings.
 * getDb — pass require('./db').getDb to avoid circular dep
 */
function updateEarnings(month, getDb) {
  if (!month) return;
  setImmediate(() => {
    try {
      const db = getDb();
      const bookings = db.prepare(`
        SELECT ref, date, time, pickup, destination, fare, status
        FROM bookings WHERE date LIKE ? AND status = 'completed'
        ORDER BY date ASC
      `).all(month + '%');

      const total = bookings.reduce((s, b) => s + (parseFloat(b.fare) || 0), 0);
      const summary = {
        month,
        completed_trips: bookings.length,
        total_earnings: parseFloat(total.toFixed(2)),
        updated_at: new Date().toISOString(),
        bookings
      };

      const rel = `Earnings/monthly/${month}.json`;
      writeToRoots(rel, p => writeJson(p, summary));
    } catch (e) {
      console.error('[AUTO-FILE] updateEarnings error:', e.message);
    }
  });
}

module.exports = {
  fileBooking,
  removeBooking,
  fileCustomer,
  fileDriverProfile,
  fileDriverDoc,
  fileInvoice,
  removeInvoice,
  updateEarnings
};
