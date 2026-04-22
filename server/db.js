const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// ── Persistent storage path ───────────────────────────────────────────────
// On Railway: mount a Volume at /data via the Railway dashboard
// (Service → Volumes → Mount path: /data), then set:
//   DB_PATH=/data/westmere.db   (Railway env var)
//
// Locally (Mac dev): no env var needed — defaults to ./data/westmere.db
//
// Without a Railway Volume every redeploy wipes the SQLite file.
// The Volume persists across redeploys and restarts.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'westmere.db');
const DATA_DIR = path.dirname(DB_PATH);

let db;

function getDb() {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    migrate();
    seedDefaults();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Users table (admin, owner, driver accounts)
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL CHECK(role IN ('admin','owner','driver','customer')),
      full_name  TEXT,
      email      TEXT,
      phone      TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Customer accounts (for account page)
    CREATE TABLE IF NOT EXISTS customers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT    NOT NULL,
      full_name  TEXT    NOT NULL,
      phone      TEXT,
      account_type TEXT  NOT NULL DEFAULT 'personal' CHECK(account_type IN ('personal','business')),
      company    TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Bookings
    CREATE TABLE IF NOT EXISTS bookings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ref         TEXT    NOT NULL UNIQUE,
      customer_id INTEGER REFERENCES customers(id),
      driver_id   INTEGER REFERENCES users(id),
      pickup      TEXT    NOT NULL,
      destination TEXT    NOT NULL,
      date        TEXT    NOT NULL,
      time        TEXT    NOT NULL DEFAULT 'ASAP',
      passengers  INTEGER NOT NULL DEFAULT 1,
      bags        TEXT    NOT NULL DEFAULT '0',
      trip_type   TEXT,
      flight      TEXT,
      fare        REAL,
      payment     TEXT    DEFAULT 'cash',
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','active','completed','cancelled')),
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Session log (for audit)
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      customer_id INTEGER,
      role       TEXT    NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT    NOT NULL
    );

    -- Audit log
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type  TEXT    NOT NULL,
      user_id    INTEGER NOT NULL,
      action     TEXT    NOT NULL,
      detail     TEXT,
      ip         TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Third-party integrations (Google Calendar OAuth tokens, etc.)
    CREATE TABLE IF NOT EXISTS integrations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      provider      TEXT    NOT NULL,
      account_email TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER,
      scope         TEXT,
      sync_token    TEXT,
      calendar_id   TEXT DEFAULT 'primary',
      data          TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider)
    );
  `);
}

function migrate() {
  // Migrate bags column from INTEGER NOT NULL to TEXT NOT NULL DEFAULT '0'
  // SQLite doesn't support ALTER COLUMN, so we check and recreate if needed
  try {
    const info = db.prepare("PRAGMA table_info(bookings)").all();
    const bagsCol = info.find(c => c.name === 'bags');
    if (bagsCol && bagsCol.type === 'INTEGER') {
      db.exec(`
        ALTER TABLE bookings RENAME TO bookings_old;
        CREATE TABLE bookings (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ref         TEXT    NOT NULL UNIQUE,
          customer_id INTEGER REFERENCES customers(id),
          driver_id   INTEGER REFERENCES users(id),
          pickup      TEXT    NOT NULL,
          destination TEXT    NOT NULL,
          date        TEXT    NOT NULL,
          time        TEXT    NOT NULL DEFAULT 'ASAP',
          passengers  INTEGER NOT NULL DEFAULT 1,
          bags        TEXT    NOT NULL DEFAULT '0',
          trip_type   TEXT,
          flight      TEXT,
          fare        REAL,
          payment     TEXT    DEFAULT 'cash',
          status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','active','completed','cancelled')),
          notes       TEXT,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO bookings SELECT * FROM bookings_old;
        DROP TABLE bookings_old;
      `);
      console.log('[DB] Migrated bags column to TEXT');
    }
  } catch (e) {
    // Table might not exist yet, that's fine
  }

  // Add calendar_event_id column to bookings (for Google Calendar sync)
  try {
    const info = db.prepare("PRAGMA table_info(bookings)").all();
    if (!info.find(c => c.name === 'calendar_event_id')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN calendar_event_id TEXT`);
      console.log('[DB] Added calendar_event_id column to bookings');
    }
  } catch (e) {
    // Non-fatal
  }

  // Passenger contact columns — public /book stores these so guest bookings
  // (no customer account) can still be looked up for rider tracking via
  // booking ref + phone.
  try {
    const info = db.prepare("PRAGMA table_info(bookings)").all();
    for (const [n, t] of [['passenger_name','TEXT'],['passenger_phone','TEXT'],['passenger_email','TEXT']]) {
      if (!info.find(c => c.name === n)) {
        db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to bookings');
      }
    }
  } catch (e) { console.error('[DB] passenger columns migration failed:', e.message); }

  // Ensure integrations table exists for legacy databases
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        provider      TEXT    NOT NULL,
        account_email TEXT,
        access_token  TEXT,
        refresh_token TEXT,
        expires_at    INTEGER,
        scope         TEXT,
        sync_token    TEXT,
        calendar_id   TEXT DEFAULT 'primary',
        data          TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider)
      );
    `);
  } catch (e) {}

  // Smart intake: needs_reassignment flag + reason from Claude evaluation
  try {
    const info = db.prepare("PRAGMA table_info(bookings)").all();
    if (!info.find(c => c.name === 'needs_reassignment')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN needs_reassignment INTEGER NOT NULL DEFAULT 0`);
      console.log('[DB] Added needs_reassignment column to bookings');
    }
    if (!info.find(c => c.name === 'intake_reason')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN intake_reason TEXT`);
      console.log('[DB] Added intake_reason column to bookings');
    }
    if (!info.find(c => c.name === 'intake_checked_at')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN intake_checked_at TEXT`);
      console.log('[DB] Added intake_checked_at column to bookings');
    }
  } catch (e) {}

  // Time off / blackout windows for the operator (or per-driver)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS time_off (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id  INTEGER REFERENCES users(id),
        date       TEXT    NOT NULL,
        end_date   TEXT,
        start_time TEXT,
        end_time   TEXT,
        reason     TEXT,
        created_by INTEGER,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_time_off_date ON time_off(date);
    `);
  } catch (e) {}

  // Driver profile columns — admin can add driver details (licence, vehicle etc.)
  // before granting app login. Username/password stay required but are set to
  // placeholder values until admin issues real credentials.
  try {
    const info = db.prepare("PRAGMA table_info(users)").all();
    const driverCols = [
      ['license_no',        'TEXT'],
      ['license_expiry',    'TEXT'],
      ['dbs_no',            'TEXT'],
      ['dbs_expiry',        'TEXT'],
      ['vehicle',           'TEXT'],
      ['reg',               'TEXT'],
      ['phv_no',            'TEXT'],
      ['insurance_no',      'TEXT'],
      ['driver_notes',      'TEXT'],
      ['has_login',         'INTEGER NOT NULL DEFAULT 0'],
      ['photo',             'TEXT'],
      ['is_default_driver', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_passengers',    'INTEGER'],
      ['max_bags',          'INTEGER'],
      ['luggage_notes',     'TEXT']
    ];
    for (const [name, type] of driverCols) {
      if (!info.find(c => c.name === name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        console.log('[DB] Added ' + name + ' column to users');
      }
    }
    // Backfill has_login=1 for existing accounts (they all have real usernames)
    db.prepare(`UPDATE users SET has_login = 1 WHERE has_login = 0 AND username NOT LIKE '__nolgn_%'`).run();
  } catch (e) {
    console.error('[DB] users driver-profile migration failed:', e.message);
  }

  // Driver-offer workflow: admin offers a job to a specific driver; driver has
  // a window to accept or decline; after timeout the job reverts to admin.
  // Adds columns additively — old rows simply have NULLs.
  try {
    const info = db.prepare("PRAGMA table_info(bookings)").all();
    const newCols = [
      ['offered_to_driver_id', 'INTEGER REFERENCES users(id)'],
      ['offered_at',           'TEXT'],
      ['decided_at',           'TEXT'],
      ['done_at',              'TEXT'],
      ['cancelled_at',         'TEXT'],
      ['cancellation_reason',  'TEXT'],
      ['driver_pay',           'REAL'],
      ['admin_fee',            'REAL']
    ];
    for (const [name, type] of newCols) {
      if (!info.find(c => c.name === name)) {
        db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`);
        console.log('[DB] Added ' + name + ' column to bookings');
      }
    }
  } catch (e) {
    console.error('[DB] driver-offer column migration failed:', e.message);
  }

  // Customer billing details — for invoicing (address + bank).
  try {
    const info = db.prepare("PRAGMA table_info(customers)").all();
    const custCols = [
      ['address_line1',    'TEXT'],
      ['address_line2',    'TEXT'],
      ['postcode',         'TEXT'],
      ['bank_name',        'TEXT'],
      ['bank_sort_code',   'TEXT'],
      ['bank_account_no',  'TEXT'],
      ['bank_account_name','TEXT']
    ];
    for (const [n, t] of custCols) {
      if (!info.find(c => c.name === n)) {
        db.exec(`ALTER TABLE customers ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to customers');
      }
    }
  } catch (e) { console.error('[DB] customer billing migration failed:', e.message); }

  // Driver locations — latest GPS position per driver for live rider tracking.
  // One row per driver_id (UPSERT), kept fresh by the driver app posting
  // every few seconds while on a job.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_locations (
        driver_id  INTEGER PRIMARY KEY REFERENCES users(id),
        lat        REAL    NOT NULL,
        lng        REAL    NOT NULL,
        heading    REAL,
        accuracy   REAL,
        speed      REAL,
        updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {
    console.error('[DB] driver_locations table failed:', e.message);
  }

  // Invoices table — persistent record of every invoice generated.
  // Previously we only stored an audit_log entry; this table keeps the
  // full recipient, line items, totals, and (for account customers) the
  // booking ids covered, so invoices can be re-viewed later.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_no      TEXT    NOT NULL UNIQUE,
        kind            TEXT    NOT NULL CHECK(kind IN ('account','bespoke')),
        customer_id     INTEGER REFERENCES customers(id),
        recipient_name  TEXT    NOT NULL,
        recipient_email TEXT,
        recipient_phone TEXT,
        recipient_addr  TEXT,
        period_from     TEXT,
        period_to       TEXT,
        period_label    TEXT,
        issued_date     TEXT    NOT NULL,
        due_date        TEXT,
        notes           TEXT,
        line_items_json TEXT    NOT NULL,
        booking_ids_json TEXT,
        total           REAL    NOT NULL DEFAULT 0,
        emailed         INTEGER NOT NULL DEFAULT 0,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_date);
    `);
  } catch (e) {
    console.error('[DB] invoices table creation failed:', e.message);
  }

  // Key-value settings columns in integrations table
  try {
    const cols = db.prepare("PRAGMA table_info(integrations)").all();
    if (!cols.find(c => c.name === 'key')) {
      db.exec(`ALTER TABLE integrations ADD COLUMN key TEXT`);
      console.log('[DB] Added key column to integrations');
    }
    if (!cols.find(c => c.name === 'value')) {
      db.exec(`ALTER TABLE integrations ADD COLUMN value TEXT`);
      console.log('[DB] Added value column to integrations');
    }
  } catch (e) {}

  // Rebuild the bookings CHECK constraint to allow the new 'offered' status.
  // Detect by inspecting the stored CREATE TABLE text in sqlite_master.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get();
    const needsRebuild = row && row.sql && !/'offered'/.test(row.sql);

    if (needsRebuild) {
      const info = db.prepare("PRAGMA table_info(bookings)").all();
      const cols = info.map(c => c.name).join(', ');
      db.exec('BEGIN');
      db.exec(`ALTER TABLE bookings RENAME TO bookings_pre_offer`);
      db.exec(`
        CREATE TABLE bookings (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ref         TEXT    NOT NULL UNIQUE,
          customer_id INTEGER REFERENCES customers(id),
          driver_id   INTEGER REFERENCES users(id),
          pickup      TEXT    NOT NULL,
          destination TEXT    NOT NULL,
          date        TEXT    NOT NULL,
          time        TEXT    NOT NULL DEFAULT 'ASAP',
          passengers  INTEGER NOT NULL DEFAULT 1,
          bags        TEXT    NOT NULL DEFAULT '0',
          trip_type   TEXT,
          flight      TEXT,
          fare        REAL,
          payment     TEXT    DEFAULT 'cash',
          status      TEXT    NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','confirmed','offered','active','completed','cancelled')),
          notes       TEXT,
          calendar_event_id   TEXT,
          needs_reassignment  INTEGER NOT NULL DEFAULT 0,
          intake_reason       TEXT,
          intake_checked_at   TEXT,
          offered_to_driver_id INTEGER REFERENCES users(id),
          offered_at           TEXT,
          decided_at           TEXT,
          done_at              TEXT,
          cancelled_at         TEXT,
          cancellation_reason  TEXT,
          driver_pay           REAL,
          admin_fee            REAL,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`INSERT INTO bookings (${cols}) SELECT ${cols} FROM bookings_pre_offer`);
      db.exec(`DROP TABLE bookings_pre_offer`);
      db.exec('COMMIT');
      console.log('[DB] Rebuilt bookings with offered status support');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[DB] bookings status CHECK rebuild failed:', e.message);
  }
}

function seedDefaults() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync('sussex', 12);
    db.prepare(`
      INSERT INTO users (username, password, role, full_name, email)
      VALUES (?, ?, ?, ?, ?)
    `).run('westmere', hash, 'admin', 'Westmere Admin', 'admin@westmereprivatehire.co.uk');

    console.log('[DB] Default admin user created (westmere / sussex)');
  }

  // Seed default driver (Nikodem Krajnyk) — owner drives his own jobs
  // by default, so every new booking gets allocated to him automatically.
  // Admin can later add more drivers and reassign via the admin UI.
  try {
    const existingDefault = db.prepare("SELECT id FROM users WHERE is_default_driver = 1 LIMIT 1").get();
    const nikodem = db.prepare("SELECT id FROM users WHERE full_name = ? AND role IN ('driver','owner') LIMIT 1").get('Nikodem Krajnyk');
    if (!existingDefault && !nikodem) {
      const crypto = require('crypto');
      const placeholderUser = '__nolgn_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
      const placeholderPass = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
      db.prepare(`
        INSERT INTO users (username, password, role, full_name, email, phone, active, has_login, vehicle, is_default_driver, max_passengers, max_bags)
        VALUES (?, ?, 'owner', 'Nikodem Krajnyk', 'bookings@westmereprivatehire.co.uk', '07930 342593', 1, 0, 'Tesla Model S', 1, 4, 4)
      `).run(placeholderUser, placeholderPass);
      console.log('[DB] Seeded default driver Nikodem Krajnyk');
    } else if (!existingDefault && nikodem) {
      db.prepare("UPDATE users SET is_default_driver = 1 WHERE id = ?").run(nikodem.id);
      console.log('[DB] Marked existing Nikodem as default driver');
    }
  } catch (e) {
    console.error('[DB] default driver seed failed:', e.message);
  }

  // Seed default invoice settings
  try {
    const invoiceRow = db.prepare("SELECT id FROM integrations WHERE key = 'invoice_settings'").get();
    if (!invoiceRow) {
      db.prepare("INSERT INTO integrations (provider, key, value) VALUES ('invoice_settings', 'invoice_settings', ?)").run(JSON.stringify({
        business_name: 'Westmere Private Hire',
        owner_name: 'Nikodem Krajnyk',
        address_line1: '4 Fisher Street',
        address_line2: 'Lewes, East Sussex',
        postcode: 'BN7 2DG',
        phone: '07930 342593',
        email: 'bookings@westmereprivatehire.co.uk',
        bank_name: '',
        sort_code: '',
        account_no: '',
        account_name: ''
      }));
      console.log('[DB] Seeded default invoice settings');
    }
  } catch (e) {}
}

module.exports = { getDb };
