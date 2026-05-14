'use strict';
/**
 * export-routes.js — Full data export as a structured ZIP archive.
 *
 * GET /api/export/zip
 *   Streams a ZIP download containing all business data in an organised
 *   folder structure. Works on Railway and locally. The user can save
 *   the ZIP to their iCloud Drive folder for automatic cloud backup.
 *
 * ZIP structure:
 *   Bookings/
 *     YYYY-MM/bookings.json    — bookings grouped by calendar month
 *     record_book.csv          — all bookings as a flat CSV
 *   Customers/
 *     customers.json
 *   Drivers/
 *     <Name>/
 *       profile.json
 *       <doc_type>.<ext>       — uploaded document files
 *   Invoices/
 *     invoices.json            — invoice records
 *     <INV-XXXX>.pdf           — PDF files (if available on disk)
 *   Earnings/
 *     earnings_summary.json
 *     monthly/<YYYY-MM>.json
 *   Database/
 *     westmere_export.json     — full raw DB dump (all tables)
 */

const express  = require('express');
const archiver = require('archiver');
const path     = require('path');
const fs       = require('fs');
const { getDb, DATA_DIR } = require('./db');

const router = express.Router();

// ── Auth guard ──────────────────────────────────────────────────────────────
function requireAdminOrOwner(req, res, next) {
  if (!req.auth || !['admin', 'owner'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Admin/owner access required' });
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toCSVRow(fields) {
  return fields.map(f => {
    const s = f == null ? '' : String(f);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }).join(',');
}

function buildBookingsCsv(bookings) {
  const header = toCSVRow([
    'Ref','Date','Time','Pickup','Destination','Name','Phone','Email',
    'Passengers','Bags','Flight','Fare','Payment','Status','Notes','Created'
  ]);
  const rows = bookings.map(b => toCSVRow([
    b.ref, b.date, b.time, b.pickup, b.destination,
    b.name, b.phone, b.email,
    b.passengers, b.bags, b.flight,
    b.fare, b.payment, b.status, b.notes,
    b.created_at
  ]));
  return [header, ...rows].join('\r\n');
}

function buildEarningsSummary(bookings) {
  const completed = bookings.filter(b => b.status === 'completed');
  const total = completed.reduce((s, b) => s + (parseFloat(b.fare) || 0), 0);

  // Monthly breakdown
  const monthly = {};
  for (const b of completed) {
    const mon = (b.date || '').slice(0, 7); // YYYY-MM
    if (!mon) continue;
    if (!monthly[mon]) monthly[mon] = { month: mon, count: 0, total: 0, bookings: [] };
    monthly[mon].count++;
    monthly[mon].total = parseFloat((monthly[mon].total + (parseFloat(b.fare) || 0)).toFixed(2));
    monthly[mon].bookings.push({ ref: b.ref, date: b.date, fare: b.fare, pickup: b.pickup, destination: b.destination });
  }

  return {
    summary: {
      total_completed: completed.length,
      total_earnings: parseFloat(total.toFixed(2)),
      exported_at: new Date().toISOString()
    },
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month))
  };
}

// ── Route ────────────────────────────────────────────────────────────────────

// GET /api/export/zip
router.get('/zip', requireAdminOrOwner, async (req, res) => {
  const db = getDb();
  const ts = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="westmere-data-${ts}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', err => {
    console.error('[EXPORT] Archive error:', err.message);
    // Headers already sent — nothing we can do except log
  });

  archive.pipe(res);

  try {
    // ── 1. All bookings ────────────────────────────────────────────────────
    const bookings = db.prepare(`
      SELECT * FROM bookings ORDER BY date ASC, time ASC
    `).all();

    // Grouped by month → Bookings/YYYY-MM/bookings.json
    const byMonth = {};
    for (const b of bookings) {
      const mon = (b.date || 'unknown').slice(0, 7);
      if (!byMonth[mon]) byMonth[mon] = [];
      byMonth[mon].push(b);
    }
    for (const [mon, bks] of Object.entries(byMonth)) {
      archive.append(JSON.stringify(bks, null, 2), {
        name: `Bookings/${mon}/bookings.json`
      });
    }

    // record_book.csv
    archive.append(buildBookingsCsv(bookings), {
      name: 'Bookings/record_book.csv'
    });

    // ── 2. Customers ───────────────────────────────────────────────────────
    const customers = db.prepare(`
      SELECT id, full_name, email, phone, created_at,
             (SELECT COUNT(*) FROM bookings WHERE email = c.email) AS booking_count
      FROM customers c ORDER BY full_name ASC
    `).all();
    archive.append(JSON.stringify(customers, null, 2), {
      name: 'Customers/customers.json'
    });

    // ── 3. Drivers ─────────────────────────────────────────────────────────
    const drivers = db.prepare(`
      SELECT id, full_name, email, phone, vehicle, reg, phv_no, license_no,
             onboarding_status, active, role, created_at
      FROM users WHERE role IN ('driver','owner') ORDER BY full_name ASC
    `).all();

    for (const driver of drivers) {
      const safeName = (driver.full_name || `driver-${driver.id}`)
        .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');
      const prefix = `Drivers/${safeName}/`;

      // profile.json
      archive.append(JSON.stringify(driver, null, 2), {
        name: prefix + 'profile.json'
      });

      // Document files
      const docs = db.prepare(`
        SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY type ASC
      `).all(driver.id);

      for (const doc of docs) {
        if (doc.file_path && fs.existsSync(doc.file_path)) {
          const ext = path.extname(doc.original_name || doc.file_path) || '.bin';
          archive.file(doc.file_path, {
            name: prefix + doc.type + ext
          });
        }
      }
    }

    // ── 4. Invoices ────────────────────────────────────────────────────────
    const invoices = db.prepare(`
      SELECT * FROM invoices ORDER BY issued_date DESC
    `).all();
    archive.append(JSON.stringify(invoices, null, 2), {
      name: 'Invoices/invoices.json'
    });

    // PDF files from disk
    const invoicesDir = path.join(DATA_DIR, 'invoices');
    if (fs.existsSync(invoicesDir)) {
      const pdfs = fs.readdirSync(invoicesDir).filter(f => f.endsWith('.pdf'));
      for (const pdf of pdfs) {
        archive.file(path.join(invoicesDir, pdf), {
          name: `Invoices/${pdf}`
        });
      }
    }

    // ── 5. Earnings ────────────────────────────────────────────────────────
    const earnings = buildEarningsSummary(bookings);
    archive.append(JSON.stringify(earnings.summary, null, 2), {
      name: 'Earnings/earnings_summary.json'
    });
    for (const mon of earnings.monthly) {
      archive.append(JSON.stringify(mon, null, 2), {
        name: `Earnings/monthly/${mon.month}.json`
      });
    }

    // ── 6. Full DB dump ────────────────────────────────────────────────────
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const dump = { _exported_at: new Date().toISOString(), _version: 'westmere-export-v1' };
    for (const t of tables) {
      dump[t.name] = db.prepare('SELECT * FROM ' + t.name).all();
    }
    archive.append(JSON.stringify(dump, null, 2), {
      name: 'Database/westmere_export.json'
    });

  } catch (err) {
    console.error('[EXPORT] Data assembly error:', err.message);
    // Finalize anyway — ZIP will be partial but won't leave response hanging
  }

  await archive.finalize();
});

module.exports = router;
