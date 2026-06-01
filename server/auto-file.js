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
const { DATA_DIR, getDb } = require('./db');

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

/** Write text (CSV) to path, creating parent dirs as needed. */
function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

// ── CSV helpers ────────────────────────────────────────────────────────────

/** Escape a single CSV field per RFC 4180 (quote if it contains , " or newline). */
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Join an array of fields into one CSV row. */
function csvRow(fields) {
  return fields.map(csvField).join(',');
}

/** Build a complete CSV document from a header array and an array of row arrays. */
function buildCsv(header, rows) {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

/** Look up a driver's display name by id (returns '' on any failure). */
function driverNameById(driverId) {
  if (!driverId) return '';
  try {
    const u = getDb().prepare('SELECT full_name FROM users WHERE id = ?').get(driverId);
    return u && u.full_name ? u.full_name : '';
  } catch (_) { return ''; }
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
const BOOKING_CSV_HEADER = [
  'ref', 'date', 'time', 'pickup', 'destination', 'fare', 'status',
  'passenger_name', 'driver_name', 'payment'
];

function bookingRow(b) {
  return [
    b.ref, b.date, b.time, b.pickup, b.destination, b.fare, b.status,
    b.passenger_name || b.customer_name || '',
    b.driver_name || driverNameById(b.driver_id),
    b.payment || 'cash'
  ];
}

function fileBooking(booking) {
  if (!booking) return;
  setImmediate(() => {
    try {
      const mon = (booking.date || 'unknown').slice(0, 7);
      const ref = (booking.ref || 'unknown').replace(/[^a-zA-Z0-9\-_]/g, '');
      const rel = `Bookings/${mon}/${ref}.csv`;
      const csv = buildCsv(BOOKING_CSV_HEADER, [bookingRow(booking)]);
      writeToRoots(rel, p => writeText(p, csv));
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
      deleteFromRoots(`Bookings/${mon}/${safeRef}.csv`);
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
      const rel = `Customers/${customer.id}_${name}.csv`;
      const header = [
        'id', 'full_name', 'email', 'phone', 'account_type',
        'address_line1', 'address_line2', 'postcode', 'created_at'
      ];
      const row = [
        customer.id, customer.full_name, customer.email, customer.phone,
        customer.account_type, customer.address_line1, customer.address_line2,
        customer.postcode, customer.created_at
      ];
      writeToRoots(rel, p => writeText(p, buildCsv(header, [row])));
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
      const rel = `Drivers/${name}/profile.csv`;
      const header = [
        'id', 'full_name', 'email', 'phone', 'role', 'vehicle', 'reg',
        'phv_no', 'license_no', 'onboarding_status', 'active', 'created_at'
      ];
      const row = [
        driver.id, driver.full_name, driver.email, driver.phone, driver.role,
        driver.vehicle, driver.reg, driver.phv_no, driver.license_no,
        driver.onboarding_status, driver.active, driver.created_at
      ];
      writeToRoots(rel, p => writeText(p, buildCsv(header, [row])));
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
      const d = invoiceData || {};
      const header = [
        'invoice_no', 'kind', 'recipient_name', 'recipient_email',
        'issued_date', 'due_date', 'period_label', 'total', 'emailed'
      ];
      const row = [
        d.invoice_no || invoiceNo, d.kind, d.recipient_name, d.recipient_email,
        d.issued_date, d.due_date, d.period_label, d.total, d.emailed
      ];
      writeToRoots(`Invoices/${safe}.csv`, p => writeText(p, buildCsv(header, [row])));
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
      deleteFromRoots(`Invoices/${safe}.csv`);
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

      const header = ['ref', 'date', 'time', 'pickup', 'destination', 'fare', 'status'];
      const rows = bookings.map(b => [
        b.ref, b.date, b.time, b.pickup, b.destination, b.fare, b.status
      ]);
      // Totals row at the foot of the CSV.
      rows.push(['TOTAL', month, '', '', bookings.length + ' trips', total.toFixed(2), 'completed']);

      const rel = `Earnings/monthly/${month}.csv`;
      writeToRoots(rel, p => writeText(p, buildCsv(header, rows)));
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
