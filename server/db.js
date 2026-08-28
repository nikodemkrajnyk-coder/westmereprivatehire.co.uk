const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// ── Persistent storage path ───────────────────────────────────────────────
// On Railway: mount a Volume at /data via the Railway dashboard
// (Service → Volumes → Mount path: /data), then set:
//   SQLITE_DB=/data/westmere.db   (Railway env var)
//
// Locally (Mac dev): no env var needed — defaults to ./data/westmere.db
//
// Without a Railway Volume every redeploy wipes the SQLite file.
// The Volume persists across redeploys and restarts.
//
// Safety: if SQLITE_DB is set but the directory is not writable (e.g. the
// volume wasn't mounted yet on a first boot), we fall back to the local
// ./data/ path and log a warning rather than crashing before app.listen.
function resolveDbPath() {
  const preferred = process.env.SQLITE_DB ? process.env.SQLITE_DB.trim() : undefined;
  const fallback = path.join(__dirname, '..', 'data', 'westmere.db');
  if (!preferred) return fallback;

  const dir = path.dirname(preferred);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Quick write-test — fails early if the volume isn't writable
    const probe = path.join(dir, '.db_probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return preferred;
  } catch (e) {
    console.warn('[SQLITE_DB]', preferred, 'not writable (' + e.message + ') — falling back to local path');
    return fallback;
  }
}

const DB_PATH = resolveDbPath();
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
      payment     TEXT    DEFAULT 'pending',
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','offered','awaiting_payment','confirmed','active','completed','cancelled')),
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
          payment     TEXT    DEFAULT 'pending',
          status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','offered','confirmed','active','completed','cancelled')),
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
    // Per-driver calendar event ID — so assigned jobs appear on each driver's personal calendar
    if (!info.find(c => c.name === 'driver_calendar_event_id')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN driver_calendar_event_id TEXT`);
      console.log('[DB] Added driver_calendar_event_id column to bookings');
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
      ['calendar_token',    'TEXT'],
      ['reg',               'TEXT'],
      ['phv_no',            'TEXT'],
      ['insurance_no',      'TEXT'],
      ['driver_notes',      'TEXT'],
      ['has_login',         'INTEGER NOT NULL DEFAULT 0'],
      ['photo',             'TEXT'],
      ['is_default_driver', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_passengers',    'INTEGER'],
      ['max_bags',          'INTEGER'],
      ['luggage_notes',     'TEXT'],
      ['reset_token',       'TEXT'],
      ['reset_token_expires','TEXT']
    ];
    for (const [name, type] of driverCols) {
      if (!info.find(c => c.name === name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        console.log('[DB] Added ' + name + ' column to users');
      }
    }
    // Backfill has_login=1 for existing accounts (they all have real usernames)
    db.prepare(`UPDATE users SET has_login = 1 WHERE has_login = 0 AND username NOT LIKE '__nolgn_%'`).run();
    // Backfill calendar_token for existing drivers that don't have one yet
    const { randomUUID } = require('crypto');
    const noToken = db.prepare("SELECT id FROM users WHERE role = 'driver' AND (calendar_token IS NULL OR calendar_token = '')").all();
    for (const row of noToken) {
      db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(randomUUID().replace(/-/g, ''), row.id);
    }
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
      ['admin_fee',            'REAL'],
      /* AN OFFER TO SOMEBODY WHO IS NOT ON THE SYSTEM.
         The owner sends work to drivers he does not employ — a name and an
         email typed in on the spot. There is no users row to point
         offered_to_driver_id at, so the person is recorded here instead, and
         offered_to_driver_id stays NULL. Which of the two is set is what tells
         every downstream branch whether this is a registered offer or an ad-hoc
         one; nothing infers it from anything else.
         assigned_to_name is who accepted, when there is no driver account to
         put in driver_id. */
      ['offered_to_name',      'TEXT'],
      ['offered_to_email',     'TEXT'],
      /* The car, so the CUSTOMER's reminder can say who is coming. An outside
         driver has no users row to read a vehicle and a registration from, so
         the owner types them when he sends the job, and accepting copies them
         onto the booking. Without these the reminder would fall back to the
         owner's own Tesla and tell the customer the wrong car. */
      ['offered_to_reg',       'TEXT'],
      ['offered_to_car',       'TEXT'],
      ['assigned_to_name',     'TEXT'],
      ['assigned_to_reg',      'TEXT'],
      ['assigned_to_car',      'TEXT'],
      /* Where the ad-hoc driver's own 12-hour reminder goes. Accepting used to
         clear offered_to_email — correct, the offer is spent — which left no
         address to remind them at. It is copied here instead. */
      ['assigned_to_email',    'TEXT']
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

  // Fix bookings CHECK constraint to allow 'offered' status.
  // SQLite can't ALTER a constraint — detect by inspecting sqlite_master SQL
  // and rebuild the table if 'offered' is missing from the status check.
  try {
    const masterRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get();
    if (masterRow && masterRow.sql && !masterRow.sql.includes("'offered'")) {
      console.log('[DB] Migrating bookings CHECK constraint to include offered status…');
      const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name).join(', ');
      // Run each DDL statement separately — better-sqlite3 multi-statement exec
      // can fail silently on mixed DDL+DML in a single exec() call.
      db.prepare('ALTER TABLE bookings RENAME TO bookings_pre_offered').run();
      db.exec(`
        CREATE TABLE bookings (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          ref                 TEXT    NOT NULL UNIQUE,
          customer_id         INTEGER REFERENCES customers(id),
          driver_id           INTEGER REFERENCES users(id),
          pickup              TEXT    NOT NULL,
          destination         TEXT    NOT NULL,
          date                TEXT    NOT NULL,
          time                TEXT    NOT NULL DEFAULT 'ASAP',
          passengers          INTEGER NOT NULL DEFAULT 1,
          bags                TEXT    NOT NULL DEFAULT '0',
          trip_type           TEXT,
          flight              TEXT,
          fare                REAL,
          payment             TEXT    DEFAULT 'pending',
          status              TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','offered','confirmed','active','completed','cancelled')),
          notes               TEXT,
          created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
          calendar_event_id   TEXT,
          passenger_name      TEXT,
          passenger_phone     TEXT,
          passenger_email     TEXT,
          needs_reassignment  INTEGER NOT NULL DEFAULT 0,
          intake_reason       TEXT,
          intake_checked_at   TEXT,
          offered_to_driver_id INTEGER REFERENCES users(id),
          offered_at          TEXT,
          decided_at          TEXT,
          done_at             TEXT,
          cancelled_at        TEXT,
          cancellation_reason TEXT,
          driver_pay          REAL,
          admin_fee           REAL
        )
      `);
      db.prepare(`INSERT INTO bookings (${cols}) SELECT ${cols} FROM bookings_pre_offered`).run();
      db.prepare('DROP TABLE bookings_pre_offered').run();
      console.log('[DB] bookings table rebuilt with offered status support');
    }
  } catch (e) {
    console.error('[DB] offered-status migration failed:', e.message);
  }

  // ── awaiting_payment status ────────────────────────────────────────────
  // A booking whose customer has CHOSEN a payment method (card started, or
  // cash "pay driver on the day") but which is not yet settled. The ride is
  // going ahead, so it shows in the schedule/driver view, but it only becomes
  // 'confirmed' when the payment lands (Stripe webhook) or the owner/driver
  // marks the cash received. Add it to the CHECK constraint without dropping
  // any columns: derive the new schema from the live one, injecting the value
  // into the status IN(...) list, then copy every existing column across.
  try {
    const masterRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get();
    if (masterRow && masterRow.sql && !masterRow.sql.includes("'awaiting_payment'")) {
      console.log('[DB] Migrating bookings CHECK constraint to include awaiting_payment status…');
      const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name).join(', ');
      const newSql = masterRow.sql.replace(
        /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
        (m, list) => list.includes("'awaiting_payment'") ? m : `CHECK(status IN (${list}, 'awaiting_payment'))`
      );
      if (newSql === masterRow.sql) {
        console.error('[DB] awaiting_payment migration: could not locate status CHECK — leaving table untouched.');
      } else {
        db.prepare('ALTER TABLE bookings RENAME TO bookings_pre_awaiting').run();
        db.exec(newSql);   // recreates 'bookings' with all original columns + widened CHECK
        db.prepare(`INSERT INTO bookings (${cols}) SELECT ${cols} FROM bookings_pre_awaiting`).run();
        db.prepare('DROP TABLE bookings_pre_awaiting').run();
        console.log('[DB] bookings table rebuilt with awaiting_payment status support');
      }
    }
  } catch (e) {
    console.error('[DB] awaiting_payment-status migration failed:', e.message);
  }

  // Customer billing details — for invoicing (address + bank).
  // Also adds email verification columns for self-service registration.
  try {
    const info = db.prepare("PRAGMA table_info(customers)").all();
    const custCols = [
      ['address_line1',      'TEXT'],
      ['address_line2',      'TEXT'],
      ['postcode',           'TEXT'],
      ['bank_name',          'TEXT'],
      ['bank_sort_code',     'TEXT'],
      ['bank_account_no',    'TEXT'],
      ['bank_account_name',  'TEXT'],
      ['verified',           'INTEGER NOT NULL DEFAULT 1'],  // 1 = verified (legacy admin-created accounts auto-verified)
      ['verification_token', 'TEXT'],
      ['reset_token',        'TEXT'],
      ['reset_token_expires','TEXT']
    ];
    for (const [n, t] of custCols) {
      if (!info.find(c => c.name === n)) {
        db.exec(`ALTER TABLE customers ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to customers');
      }
    }
  } catch (e) { console.error('[DB] customer billing migration failed:', e.message); }

  // Deduplicate customers by email and enforce unique index.
  // Removes any duplicate rows created before the UNIQUE constraint existed,
  // keeping the highest id (most recent) per email. Also hard-deletes any
  // soft-deleted records with clearly synthetic/test email domains.
  try {
    db.exec(`DELETE FROM customers WHERE active = 0 AND email LIKE '%.invalid'`);
    db.exec(`DELETE FROM customers WHERE id NOT IN (SELECT MAX(id) FROM customers GROUP BY lower(email))`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_unique ON customers(email COLLATE NOCASE)`);
  } catch (e) { console.error('[DB] customer dedup migration failed:', e.message); }

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
        paid            INTEGER NOT NULL DEFAULT 0,
        paid_at         TEXT,
        created_by      INTEGER REFERENCES users(id),
        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_date);
    `);

  /* THE INVOICE ACCESS TOKEN.
     The public PDF route took the invoice NUMBER as its only credential, and
     invoice numbers are sequential: INV-202608-0001, 0002, 0003. Anyone who
     guessed one was handed a PDF carrying the business's bank details and a
     customer's name and address. A number that a customer can read off their
     own invoice is an identifier, not a secret.

     Same pattern as bookings.pay_token: a per-row secret, minted once and
     never re-minted — re-minting would invalidate the link in an invoice email
     that has already been sent. 32 hex characters from crypto.randomBytes.

     BACKFILLED, so invoices raised before this keep working the moment their
     recipient is sent a new link. The backfill is idempotent: it only touches
     rows with no token, so it is safe on every boot.

     GUARDRAIL: server/tests/invoice-access.test.js */
  try {
    const invInfo = db.prepare('PRAGMA table_info(invoices)').all();
    if (!invInfo.find(c => c.name === 'access_token')) {
      db.exec('ALTER TABLE invoices ADD COLUMN access_token TEXT');
      console.log('[DB] Added access_token column to invoices');
    }
    /* THE JOURNEY BEHIND A BESPOKE INVOICE.
       "Create Invoice" on a job card knows the route, the date, the time and
       the reference. It was flattening all four into one description string —
       fine on a line of a PDF, useless to an email that wants to show the trip
       the way a confirmation does — and the structured version was passed to
       the email at CREATE time and then thrown away. So sending the same
       invoice a week later could only print the flattened line.
       Stored as JSON, nullable: an invoice with no journey behind it (one typed
       by hand, or any invoice raised before this) simply has NULL and falls
       back to its descriptions. Nothing needs backfilling, because there is
       nothing to backfill it FROM. */
    if (!invInfo.find(c => c.name === 'journey_json')) {
      db.exec('ALTER TABLE invoices ADD COLUMN journey_json TEXT');
      console.log('[DB] Added journey_json column to invoices');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_access_token ON invoices(access_token)');
    const crypto = require('crypto');
    const untokened = db.prepare(
      "SELECT id FROM invoices WHERE access_token IS NULL OR access_token = ''").all();
    if (untokened.length) {
      const set = db.prepare('UPDATE invoices SET access_token = ? WHERE id = ?');
      for (const r of untokened) set.run(crypto.randomBytes(16).toString('hex'), r.id);
      console.log('[DB] Backfilled access_token for ' + untokened.length + ' invoice(s)');
    }
  } catch (e) {
    console.error('[DB] invoice access_token migration failed:', e.message);
  }
  } catch (e) {
    console.error('[DB] invoices table creation failed:', e.message);
  }

  // Invoice payment tracking — add paid/paid_at to DBs whose invoices table
  // was created before these columns existed (CREATE TABLE IF NOT EXISTS skips
  // them on an existing table).
  try {
    const invInfo = db.prepare("PRAGMA table_info(invoices)").all();
    const invCols = [
      ['paid',    'INTEGER NOT NULL DEFAULT 0'],
      ['paid_at', 'TEXT']
    ];
    for (const [n, t] of invCols) {
      if (!invInfo.find(c => c.name === n)) {
        db.exec(`ALTER TABLE invoices ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to invoices');
      }
    }
  } catch (e) { console.error('[DB] invoice paid migration failed:', e.message); }

  // Saved invoice recipients for auto-fill
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_recipients (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        email        TEXT    UNIQUE,
        address      TEXT,
        phone        TEXT,
        company      TEXT,
        last_used_at TEXT    NOT NULL DEFAULT (datetime('now')),
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_recipients_used ON invoice_recipients(last_used_at);
    `);
  } catch (e) {
    console.error('[DB] invoice_recipients table creation failed:', e.message);
  }

  // Purge obviously fake test/placeholder recipients on startup.
  // Invoice recipients are kept even if the matching customer was deleted —
  // they are separate concepts (a deleted customer account doesn't mean
  // the business relationship ended).
  try {
    const info = db.prepare(`
      DELETE FROM invoice_recipients
      WHERE email IS NOT NULL
        AND (
          email LIKE '%@westmere-test.invalid'
          OR email LIKE '%@%example.com'
        )
    `).run();
    if (info.changes) console.log('[DB] Removed ' + info.changes + ' test recipient(s)');
  } catch (e) {
    console.error('[DB] invoice_recipients cleanup failed:', e.message);
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
          payment     TEXT    DEFAULT 'pending',
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

  // ── Driver onboarding: driver_documents table + onboarding columns ────────
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS driver_documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id     INTEGER NOT NULL REFERENCES users(id),
      type          TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      original_name TEXT,
      mime_type     TEXT,
      uploaded_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      status        TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','approved','rejected')),
      reviewed_at   TEXT,
      reviewed_by   INTEGER,
      notes         TEXT
    )`);
  } catch(e) { console.error('[DB] driver_documents table failed:', e.message); }

  try {
    const uInfo = db.prepare('PRAGMA table_info(users)').all();
    for (const [name, type] of [
      ['onboarding_status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['address_line1', 'TEXT'], ['address_line2', 'TEXT'],
      ['city', 'TEXT'], ['postcode', 'TEXT'],
    ]) {
      if (!uInfo.find(c => c.name === name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        console.log('[DB] Added ' + name + ' to users');
      }
    }
    // Existing drivers with real logins are already onboarded
    db.prepare(`UPDATE users SET onboarding_status='approved'
      WHERE role IN ('driver','owner') AND onboarding_status='pending'
      AND has_login=1 AND username NOT LIKE '__nolgn_%'`).run();
  } catch(e) { console.error('[DB] onboarding columns failed:', e.message); }

  // Return / round-trip bookings: link outbound and return legs
  try {
    const bInfo = db.prepare("PRAGMA table_info(bookings)").all();
    if (!bInfo.find(c => c.name === 'linked_booking_id')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN linked_booking_id INTEGER REFERENCES bookings(id)`);
      console.log('[DB] Added linked_booking_id column to bookings');
    }
    if (!bInfo.find(c => c.name === 'trip_group')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN trip_group TEXT`);
      console.log('[DB] Added trip_group column to bookings');
    }
  } catch(e) { console.error('[DB] linked_booking_id migration failed:', e.message); }

  // Dead miles — collection distance fee baked into the fare
  // suggested_fare — fare engine's all-in estimate, computed when the booking
  // is created so the owner/admin can confirm at the suggested price or adjust.
  try {
    const dmInfo = db.prepare("PRAGMA table_info(bookings)").all();
    for (const [n, t] of [['dead_miles_fee', 'REAL DEFAULT 0'], ['dead_miles_km', 'REAL DEFAULT 0'], ['suggested_fare', 'REAL']]) {
      if (!dmInfo.find(c => c.name === n)) {
        db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to bookings');
      }
    }
  } catch(e) { console.error('[DB] dead_miles migration failed:', e.message); }

  // Trip miles — road distance for mileage tracking / tax purposes
  try {
    const tmInfo = db.prepare("PRAGMA table_info(bookings)").all();
    if (!tmInfo.find(c => c.name === 'trip_miles')) {
      db.exec(`ALTER TABLE bookings ADD COLUMN trip_miles REAL`);
      console.log('[DB] Added trip_miles column to bookings');
    }
  } catch(e) { console.error('[DB] trip_miles migration failed:', e.message); }

  // Stop-on-the-way address — a proper field so owner sees it in email/app (was stuffed into notes)
  try { db.exec(`ALTER TABLE bookings ADD COLUMN stop_address TEXT`); } catch(_){}

  // Timestamp (UTC) of the last operator-sent booking confirmation, so the app
  // can always show whether/when a confirmation went out. Additive only; the
  // email/fare engine is unchanged.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN confirmation_sent_at TEXT`); } catch(_){}

  // Cancel / refund workflow. When a PAID booking is cancelled it stays in the
  // system flagged "refund due"; the owner then refunds (real Stripe refund if
  // the card charge is on file, else a recorded manual refund). Additive only.
  //   payment_intent_id — Stripe PaymentIntent for the charge (enables refunds)
  //   refund_status      — NULL | 'due' | 'refunded'
  //   refund_amount      — £ owed / refunded (defaults to the fare paid)
  //   refunded_at        — UTC timestamp the refund was issued/recorded
  //   refund_method      — 'stripe' (auto) | 'manual' (owner returns by hand)
  try {
    const bi = db.prepare("PRAGMA table_info(bookings)").all();
    for (const [n, t] of [['payment_intent_id','TEXT'],['refund_status','TEXT'],['refund_amount','REAL'],['refunded_at','TEXT'],['refund_method','TEXT']]) {
      if (!bi.find(c => c.name === n)) { db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${t}`); console.log('[DB] Added ' + n + ' column to bookings'); }
    }
  } catch(e) { console.error('[DB] refund column migration failed:', e.message); }

  // ── FARE CHANGED AFTER THE CUSTOMER ALREADY PAID ──────────────────────
  //
  // The owner edits a prepaid trip and the price moves. Only the DIFFERENCE is
  // ever refunded or collected — never the full new fare, or the customer is
  // charged twice for one journey. These columns hold that one open difference.
  //
  //   paid_amount            — £ ACTUALLY COLLECTED. Stamped by the Stripe
  //                            webhook (the real charge) and by mark-paid.
  //                            Without it, editing the fare would destroy the
  //                            only record of what was taken.
  //   fare_adjust_kind       — NULL | 'refund' (we owe them) | 'topup' (they owe us)
  //   fare_adjust_amount     — £ of that difference, always POSITIVE
  //   fare_adjust_paid       — the paid_amount it was computed against, kept so
  //                            a refund can be capped at what was really taken
  //   fare_adjust_at         — when the edit raised it; also half the
  //                            idempotency key, so re-pricing twice can never
  //                            let an old refund settle the new difference
  //   fare_adjust_method     — 'stripe' | 'cash' — how it will be settled
  //   fare_adjust_settled_at — set ONCE, the moment it is refunded/collected.
  //                            This is the no-double-refund latch.
  //   fare_adjust_ref        — Stripe refund id / payment-intent id, for audit
  //
  // NOT the same as refund_status/refund_amount above: those mean "the whole
  // booking was cancelled and the whole fare goes back". Mixing them would
  // cancel a live trip. GUARDRAIL: server/tests/fare-adjust.test.js
  try {
    const bi = db.prepare("PRAGMA table_info(bookings)").all();
    for (const [n, t] of [['paid_amount','REAL'],['fare_adjust_kind','TEXT'],['fare_adjust_amount','REAL'],
                          ['fare_adjust_paid','REAL'],['fare_adjust_at','TEXT'],['fare_adjust_method','TEXT'],
                          ['fare_adjust_settled_at','TEXT'],['fare_adjust_ref','TEXT']]) {
      if (!bi.find(c => c.name === n)) { db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${t}`); console.log('[DB] Added ' + n + ' column to bookings'); }
    }
  } catch(e) { console.error('[DB] fare-adjust column migration failed:', e.message); }

  // Owner/driver documents: add expiry_date column
  try {
    const ddInfo = db.prepare("PRAGMA table_info(driver_documents)").all();
    if (!ddInfo.find(c => c.name === 'expiry_date')) {
      db.exec(`ALTER TABLE driver_documents ADD COLUMN expiry_date TEXT`);
      console.log('[DB] Added expiry_date to driver_documents');
    }
  } catch(e) { console.error('[DB] driver_documents expiry_date migration failed:', e.message); }

  // Online pre-payment after estimate confirmed:
  //   pay_token — random secret embedded in the "Pay Now" email link. Gates
  //               the public pay page/intent so booking refs can't be enumerated.
  //   paid_at   — timestamp the customer paid online (NULL = unpaid / cash on day).
  try {
    const ppInfo = db.prepare("PRAGMA table_info(bookings)").all();
    for (const [n, t] of [['pay_token', 'TEXT'], ['paid_at', 'TEXT']]) {
      if (!ppInfo.find(c => c.name === n)) {
        db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${t}`);
        console.log('[DB] Added ' + n + ' column to bookings');
      }
    }
  } catch(e) { console.error('[DB] pre-payment column migration failed:', e.message); }

  // Customer-submitted special requirement note. DISTINCT from `notes` (which is
  // the operator's message shown to the customer in the confirmation email).
  // customer_note is what the CUSTOMER writes back via the "Add a note" link in
  // their email — child seat, extra luggage, meet-and-greet, etc. Additive only.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN customer_note TEXT`); } catch(_){}

  // When an estimate email was last sent (estimate-first flow). Distinct from
  // confirmation_sent_at so the owner app can show "Estimate sent" separately.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN estimate_sent_at TEXT`); } catch(_){}

  // When the review-request email was sent for THIS booking. Per-booking guard
  // so completing a trip asks for a review exactly once (re-marking a completed
  // booking never re-sends), while a repeat customer is still invited per trip.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN review_request_sent_at TEXT`); } catch(_){}

  // When the 12-hour owner pickup-reminder was sent for THIS booking. Per-booking
  // guard so each upcoming booking reminds the owner exactly once.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT`); } catch(_){}
  // The CUSTOMER's 12-hour reminder has its own latch. Sharing the owner's
  // reminder_sent_at would mean one send suppressing the other — the owner would
  // get his and the customer would silently get nothing, or the reverse.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN customer_reminder_sent_at TEXT`); } catch(_){}
  /* And a THIRD, for the driver's own reminder. Same reasoning as the second:
     three sends, three latches, none able to suppress another. */
  try { db.exec(`ALTER TABLE bookings ADD COLUMN driver_reminder_sent_at TEXT`); } catch(_){}

  // A per-OFFER secret, minted when a job is offered and cleared the moment it
  // is decided or reclaimed. Gates the accept/decline links in the driver's
  // offer email. Separate from pay_token, which is the CUSTOMER's: one secret
  // doing two jobs means a customer's payment link would also decide offers.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN offer_token TEXT`); } catch(_){}

  // Set when Google REJECTS the refresh token itself (invalid_grant), which no
  // retry can fix. Lets the owner app say "reconnect Google" instead of showing
  // a healthy connection above an empty calendar. Cleared on the next
  // successful refresh, so a network blip never leaves a false alarm.
  try { db.exec(`ALTER TABLE integrations ADD COLUMN needs_reconnect INTEGER DEFAULT 0`); } catch(_){}

  // Review request tracking — sent once per email address, never resent
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_emails_sent (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        email   TEXT NOT NULL UNIQUE,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { console.error('[DB] review_emails_sent table failed:', e.message); }

  // ── Customer CHANGE REQUESTS ───────────────────────────────────────────
  // A customer asking for an amendment to an already-booked trip does NOT
  // amend it. The booking is untouched — fields, fare and status all stay
  // exactly as they were — and the ask is recorded here for the owner to
  // apply by hand with the existing edit tools.
  //
  // WHY ITS OWN TABLE: the email can be missed, filtered or deleted. If the
  // only record of "please move me to the 18th" is an inbox, the request is
  // one bad spam rule away from being lost. Every request is kept here in
  // full — the snapshot of the booking AS IT WAS, what was asked for, and
  // the customer's own words — so the owner can always see exactly what was
  // requested, and a second request never overwrites the first.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_requests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id    INTEGER NOT NULL REFERENCES bookings(id),
        booking_ref   TEXT    NOT NULL,
        customer_id   INTEGER REFERENCES customers(id),
        contact_name  TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        current_json  TEXT    NOT NULL,
        requested_json TEXT   NOT NULL,
        changed_json  TEXT    NOT NULL DEFAULT '{}',
        summary       TEXT,
        note          TEXT,
        -- open      → waiting on the owner
        -- reviewed  → EARLY-stage note dismissed (nothing to accept: the owner
        --             simply prices the new details and sends the estimate)
        -- accepted  → the owner APPLIED the requested values to the booking
        -- declined  → the owner kept the booking exactly as originally booked
        status        TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed','accepted','declined')),
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        actioned_at   TEXT,
        actioned_by   INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_change_requests_booking ON change_requests(booking_id);
      CREATE INDEX IF NOT EXISTS idx_change_requests_status  ON change_requests(status);
    `);
  } catch (e) { console.error('[DB] change_requests table failed:', e.message); }

  // Denormalised flag + human-readable summary of the LATEST open change
  // request, carried on the booking row itself. Deliberate duplication: the
  // owner and admin lists both read `SELECT b.*`, so the "Change requested"
  // badge costs no join and no second fetch, and cannot be dropped by a query
  // that forgets about it. Neither column is a core booking field — writing
  // them never alters the journey, the fare or the status.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN change_requested_at TEXT`); } catch(_){}
  try { db.exec(`ALTER TABLE bookings ADD COLUMN change_request_summary TEXT`); } catch(_){}
  // The same request in the shape the staff apps RENDER: a compact
  // {changed:[{key,label,current,requested}], note, price} blob. The owner and
  // admin apps draw the Current → Requested comparison straight from this, so
  // neither has to parse the human-readable summary above nor make a second
  // fetch per row. Parsed through WMLifecycle.changeRequestDetail(), which can
  // never throw on a bad value.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN change_request_detail TEXT`); } catch(_){}

  // Set when an ACCEPTED change altered something that can move the price
  // (anything but the flight number). We deliberately do NOT re-price, charge
  // or refund automatically — the owner settles the money by hand. This is the
  // flag that keeps "Fare may change — confirm with the customer" on the job
  // until they have done so.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN fare_review_at TEXT`); } catch(_){}

  // MONEY ALREADY COLLECTED, before a re-estimate cleared the payment state.
  //
  // When the owner accepts a journey change and re-prices it, the booking goes
  // back to pending for the NEW fare — which means paid_at/payment have to be
  // cleared so the customer can pay the new amount the normal way. If that were
  // all we did, the £96 already taken for the old journey would vanish from the
  // record and the owner could innocently charge the full new fare on top.
  //
  // So every settled payment cleared by a re-estimate is appended here as
  // [{amount, method, at, fare, ref_of_change}], and the owner sees
  // "Already collected £96 (card)" next to the fare box when they set the new
  // price. We do not auto-refund or auto-deduct (owner's decision) — but the
  // figure can never be lost.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN prior_payments_json TEXT`); } catch(_){}

  // When the owner last re-priced this booking after accepting a journey
  // change. Lets My Account say "Change accepted — choose how you'd like to
  // pay" rather than the generic "your estimate is ready", so the customer
  // recognises the quote as the answer to the change THEY asked for.
  try { db.exec(`ALTER TABLE bookings ADD COLUMN re_estimated_at TEXT`); } catch(_){}
}

function seedDefaults() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    // Default admin password: read from env var, fall back to a local-dev default.
    // In production set ADMIN_DEFAULT_PASSWORD as a Railway env var.
    const adminPw = process.env.ADMIN_DEFAULT_PASSWORD || 'changeme-admin';
    const hash = bcrypt.hashSync(adminPw, 12);
    db.prepare(`
      INSERT INTO users (username, password, role, full_name, email)
      VALUES (?, ?, ?, ?, ?)
    `).run('westmere', hash, 'admin', 'Westmere Admin', 'admin@westmereprivatehire.co.uk');

    console.log('[DB] Default admin user created (username: westmere)');
  }

  // Ensure owner login account exists (nikodem) — persists across fresh DB deploys
  try {
    const owner = db.prepare("SELECT id FROM users WHERE username = 'nikodem'").get();
    if (!owner) {
      // Owner password: read from env var, fall back to a local-dev default.
      // In production set OWNER_DEFAULT_PASSWORD as a Railway env var.
      const ownerPw = process.env.OWNER_DEFAULT_PASSWORD || 'changeme-owner';
      const hash = bcrypt.hashSync(ownerPw, 12);
      db.prepare(`
        INSERT INTO users (username, password, role, full_name, email, phone, active, has_login, vehicle, is_default_driver, max_passengers, max_bags)
        VALUES (?, ?, 'owner', 'Nikodem Krajnyk', 'nikodem.krajnyk@gmail.com', '07930342593', 1, 1, 'Tesla Model S', 1, 4, 4)
      `).run('nikodem', hash);
      console.log('[DB] Owner account seeded (username: nikodem)');
    }
  } catch (e) {
    console.error('[DB] owner seed failed:', e.message);
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
        address_line1: '66 High Street',
        address_line2: 'Lewes, East Sussex',
        postcode: 'BN7 1XG',
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

  // NOTE: No customer records are seeded here. Customers must only ever be
  // created by the admin through the admin panel, or by riders registering
  // themselves. Seeding customers caused deleted accounts to reappear on every
  // server start / redeploy, so all customer seeding has been removed.
}

module.exports = { getDb, DATA_DIR };
