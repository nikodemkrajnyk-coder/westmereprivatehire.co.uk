const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'westmere.db');

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
}

module.exports = { getDb };
