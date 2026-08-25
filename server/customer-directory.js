/**
 * THE OWNER'S CUSTOMER LIST — the people HE has chosen to keep.
 *
 * WHY THIS IS ITS OWN TABLE
 *   `customers` already exists, but it is an ACCOUNT table: email is NOT NULL
 *   UNIQUE and password is NOT NULL, because a row there is a rider login. Most
 *   of this business arrives by phone and never makes an account, and a regular
 *   who has never given an email address cannot be represented there at all.
 *   Forcing them in would mean inventing `07700900123@placeholder.invalid`.
 *
 *   So this is its own table, and it carries `customer_id` when the person also
 *   happens to have an account — one row per human either way.
 *
 * MANUAL, NOT AUTOMATIC
 *   This list used to populate itself: anyone with more than two bookings was
 *   added on a rebuild. The owner asked for that removed — he would rather tap
 *   "Add to customer list" on the booking of somebody he actually wants to keep.
 *   So there is no threshold, no rebuild, and nothing writes to this table
 *   except an explicit owner action.
 *
 *   That has a pleasant consequence: because nothing repopulates the list,
 *   removing somebody is a plain DELETE. There is no resurrection to defend
 *   against, so there is no suppression flag and no "Removed" view to maintain.
 *   To put somebody back, the owner taps Add on any of their bookings again.
 *
 * THE MATCH KEY
 *   A phone number is what this trade identifies people by, so `phone_key` is
 *   primary and UNIQUE; email is the fallback for the rare booking with an
 *   address but no number. Both are normalised hard — "+44 7700 900123",
 *   "07700 900123" and "07700900123" are one person; "Ben@Example.com" and
 *   "ben@example.com" are one person. This is what makes Add idempotent: tapping
 *   it on a second booking by the same customer updates the row rather than
 *   creating a twin.
 *
 * GUARDRAIL: server/tests/customer-directory.test.js
 */

/**
 * UK mobile/landline → a stable comparison key.
 * Strips everything that is not a digit, then folds the international forms onto
 * the national one: +447700900123 / 00447700900123 / 447700900123 / 07700900123
 * all become 7700900123. Returns '' when there is nothing usable, and callers
 * must treat '' as "no key", never as a matchable value — otherwise every
 * customer with no phone number collapses into one row.
 */
function normPhone(raw) {
  if (raw == null) return '';
  let d = String(raw).replace(/\D+/g, '');
  if (!d) return '';
  if (d.startsWith('0044')) d = d.slice(4);
  else if (d.startsWith('44') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  // Too short to be a real number — refuse it rather than match on a fragment.
  return d.length >= 9 ? d : '';
}

/** Email → a stable comparison key. Case-insensitive, trimmed. '' when unusable. */
function normEmail(raw) {
  if (raw == null) return '';
  const e = String(raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_directory (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_key     TEXT UNIQUE,
      email_key     TEXT,
      customer_id   INTEGER,
      name          TEXT,
      phone         TEXT,
      email         TEXT,
      home_address  TEXT,
      -- 'manual' for anything the owner added by tapping Add on a booking.
      -- 'auto' marks the rows left behind by the old more-than-two-bookings
      -- rule, so they can be told apart from his own choices for as long as
      -- they survive. Nothing writes 'auto' any more.
      added_by      TEXT NOT NULL DEFAULT 'manual',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(customer_directory)').all().map((c) => c.name);
    // Rows that predate this column were all put there by the automatic rule.
    if (!cols.includes('added_by')) {
      db.exec("ALTER TABLE customer_directory ADD COLUMN added_by TEXT NOT NULL DEFAULT 'auto'");
      db.exec("UPDATE customer_directory SET added_by = 'auto' WHERE added_by IS NULL OR added_by = ''");
    }
  } catch (e) { console.error('[CUSTDIR] added_by migration failed:', e.message); }
  // A partial index: many rows legitimately have no email, and a plain UNIQUE
  // would collide them all on ''.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_custdir_email
             ON customer_directory(email_key) WHERE email_key IS NOT NULL AND email_key <> ''`);
  } catch (_) {}
}

/** Is this person already on the list? → the row, or null. */
function findByIdentity(db, phone, email) {
  ensureSchema(db);
  const pk = normPhone(phone), ek = normEmail(email);
  if (pk) {
    const byPhone = db.prepare('SELECT * FROM customer_directory WHERE phone_key = ?').get(pk);
    if (byPhone) return byPhone;
  }
  if (ek) {
    const byEmail = db.prepare("SELECT * FROM customer_directory WHERE email_key = ? AND email_key <> ''").get(ek);
    if (byEmail) return byEmail;
  }
  return null;
}

/**
 * Add the customer on a booking to the list — the ONLY way anything gets in.
 *
 * Idempotent on the normalised identity: tapping Add on a second booking by the
 * same person refreshes their details instead of creating a twin. An existing
 * home address the owner typed is never overwritten by a pickup.
 *
 * Reads the booking; writes ONLY to customer_directory. The booking itself, the
 * accounts table, invoices and earnings are untouched.
 *
 * → { ok, already, customer } | { ok:false, reason }
 */
function addFromBooking(db, bookingId) {
  ensureSchema(db);
  const b = db.prepare(`
    SELECT b.id, b.pickup, b.date, b.customer_id,
           COALESCE(NULLIF(TRIM(c.full_name), ''), b.passenger_name)  AS name,
           COALESCE(NULLIF(TRIM(c.phone), ''),     b.passenger_phone) AS phone,
           COALESCE(NULLIF(TRIM(c.email), ''),     b.passenger_email) AS email
      FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
     WHERE b.id = ?
  `).get(bookingId);
  if (!b) return { ok: false, reason: 'not_found' };

  const pk = normPhone(b.phone), ek = normEmail(b.email);
  // Without a phone or an email there is nothing to identify them by, and a row
  // with neither could never be matched again — including by a second Add.
  if (!pk && !ek) return { ok: false, reason: 'no_contact' };

  const name = (b.name || '').trim() || null;
  const phone = (b.phone || '').trim() || null;
  const email = (b.email || '').trim() || null;
  // The pickup on THIS booking is the best guess at where they live. It is only
  // a guess, so it never overwrites an address already on the record.
  const home = (b.pickup || '').trim() || null;

  const existing = findByIdentity(db, b.phone, b.email);
  if (existing) {
    db.prepare(`
      UPDATE customer_directory
         SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email),
             phone_key = COALESCE(?, phone_key), email_key = COALESCE(?, email_key),
             customer_id = COALESCE(?, customer_id),
             home_address = COALESCE(home_address, ?),
             updated_at = datetime('now')
       WHERE id = ?
    `).run(name, phone, email, pk || null, ek || null, b.customer_id || null, home, existing.id);
    return { ok: true, already: true, customer: db.prepare('SELECT * FROM customer_directory WHERE id = ?').get(existing.id) };
  }

  const info = db.prepare(`
    INSERT INTO customer_directory (phone_key, email_key, customer_id, name, phone, email, home_address, added_by)
    VALUES (?,?,?,?,?,?,?,'manual')
  `).run(pk || null, ek || null, b.customer_id || null, name, phone, email, home);
  return { ok: true, already: false, customer: db.prepare('SELECT * FROM customer_directory WHERE id = ?').get(info.lastInsertRowid) };
}

/**
 * HAS THIS TRIP'S MONEY ACTUALLY CHANGED HANDS?
 *
 * The single definition of "spent" in this system. It already existed, inline,
 * inside GET /customer-spend; lifting it here rather than writing a second copy
 * for the customer detail page is the whole point — two definitions of revenue
 * is two different answers to "what has this customer spent with me", and the
 * owner would have no way to know which one to believe.
 *
 *   • CANCELLED is never revenue, whatever else is true of it.
 *   • paid_at set  → a genuine card payment landed. Money is in the bank even
 *     if the journey has not happened yet.
 *   • completed    → the journey ran, so the cash or account fare is collected.
 *
 * Everything else — a confirmed cash job next Tuesday, an estimate nobody has
 * accepted — is money EXPECTED, not money taken, and belongs in a separate
 * figure. Counting it as spend would flatter every customer by the value of
 * whatever they happen to have booked.
 *
 * GUARDRAIL: server/tests/customer-spend.test.js, customer-detail.test.js
 */
function isSettledForSpend(b) {
  if (!b) return false;
  if (String(b.status || '').toLowerCase() === 'cancelled') return false;
  return !!b.paid_at || String(b.status || '').toLowerCase() === 'completed';
}

/**
 * Every trip belonging to one saved customer, newest first, with the money
 * totalled the way isSettledForSpend defines it.
 *
 * Matched on the NORMALISED phone and email — the same keys the directory
 * itself is built on — so a regular whose number was typed "+44 7700 900123"
 * on one booking and "07700900123" on the next is one person with one history,
 * which is the entire reason those keys exist.
 */
function tripsFor(db, id) {
  ensureSchema(db);
  const c = db.prepare('SELECT * FROM customer_directory WHERE id = ?').get(id);
  if (!c) return null;

  const pk = c.phone_key || normPhone(c.phone);
  const ek = c.email_key || normEmail(c.email);
  const rows = db.prepare(`
    SELECT b.id, b.ref, b.date, b.time, b.pickup, b.destination, b.stop_address,
           b.fare, b.status, b.payment, b.paid_at,
           COALESCE(NULLIF(TRIM(cu.phone), ''), b.passenger_phone) AS phone,
           COALESCE(NULLIF(TRIM(cu.email), ''), b.passenger_email) AS email
      FROM bookings b LEFT JOIN customers cu ON b.customer_id = cu.id
  `).all();

  const mine = rows.filter((r) => {
    // Phone first — it is what this trade identifies people by. An empty key
    // must never match, or every customer without a number becomes this one.
    if (pk && normPhone(r.phone) === pk) return true;
    if (ek && normEmail(r.email) === ek) return true;
    return false;
  });

  let totalSpent = 0, settledTrips = 0, bookedValue = 0, bookedTrips = 0, cancelled = 0;
  for (const r of mine) {
    const fare = Number(r.fare);
    const money = isFinite(fare) && fare > 0 ? fare : 0;
    if (String(r.status || '').toLowerCase() === 'cancelled') { cancelled++; continue; }
    if (isSettledForSpend(r)) { totalSpent += money; settledTrips++; }
    else { bookedValue += money; bookedTrips++; }
  }

  // Newest first. Dates are UK wall-clock strings and sort correctly as text —
  // never parse them into a Date to compare (the timezone invariant, CLAUDE.md).
  mine.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    customer: c,
    trips: mine,
    stats: {
      totalTrips: mine.length,
      totalSpent: Math.round(totalSpent * 100) / 100,
      settledTrips,
      bookedValue: Math.round(bookedValue * 100) / 100,
      bookedTrips,
      cancelledTrips: cancelled,
      averageFare: settledTrips ? Math.round((totalSpent / settledTrips) * 100) / 100 : 0,
      firstTrip: mine.length ? mine[mine.length - 1].date : null,
      lastTrip: mine.length ? mine[0].date : null
    }
  };
}

/** Take somebody off the list. A plain delete — nothing repopulates it. */
function remove(db, id) {
  ensureSchema(db);
  const row = db.prepare('SELECT id, name FROM customer_directory WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM customer_directory WHERE id = ?').run(id);
  return row;
}

/**
 * How many trips has each listed customer taken, and when was the last?
 *
 * Counted live from bookings rather than stored, because nothing rebuilds this
 * table any more — a stored counter would freeze on the day they were added and
 * quietly drift for ever. Cancelled trips do not count.
 */
function tripStats(db) {
  const rows = db.prepare(`
    SELECT b.date,
           COALESCE(NULLIF(TRIM(c.phone), ''), b.passenger_phone) AS phone,
           COALESCE(NULLIF(TRIM(c.email), ''), b.passenger_email) AS email
      FROM bookings b LEFT JOIN customers c ON b.customer_id = c.id
     WHERE COALESCE(b.status, '') <> 'cancelled'
  `).all();
  const byPhone = new Map(), byEmail = new Map();
  const bump = (map, key, date) => {
    if (!key) return;
    const cur = map.get(key) || { n: 0, last: null };
    cur.n++; if (date && (!cur.last || date > cur.last)) cur.last = date;
    map.set(key, cur);
  };
  for (const r of rows) {
    const pk = normPhone(r.phone), ek = normEmail(r.email);
    bump(byPhone, pk, r.date);
    if (!pk) bump(byEmail, ek, r.date);   // only count by email when there is no number, or they'd double
  }
  return { byPhone, byEmail };
}

/** The saved list, most recent trip first, optionally filtered. */
function list(db, q) {
  ensureSchema(db);
  const stats = tripStats(db);
  const rows = db.prepare(`
    SELECT id, name, phone, email, home_address, customer_id, added_by, created_at
      FROM customer_directory
  `).all().map((r) => {
    const s = (r.phone_key || normPhone(r.phone)) ? stats.byPhone.get(normPhone(r.phone)) : null;
    const e = s || stats.byEmail.get(normEmail(r.email));
    return Object.assign({}, r, { booking_count: (e && e.n) || 0, last_booking: (e && e.last) || null });
  });
  rows.sort((a, b) => {
    if (!!a.last_booking !== !!b.last_booking) return a.last_booking ? -1 : 1;
    if (a.last_booking && b.last_booking && a.last_booking !== b.last_booking) return a.last_booking < b.last_booking ? 1 : -1;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });

  const term = String(q || '').trim().toLowerCase();
  if (!term) return rows;
  // Search the way the owner would: by name, by any form of the number, by email.
  const tphone = normPhone(term);
  return rows.filter((r) => {
    if (String(r.name || '').toLowerCase().includes(term)) return true;
    if (String(r.email || '').toLowerCase().includes(term)) return true;
    if (tphone && normPhone(r.phone).includes(tphone)) return true;
    if (String(r.phone || '').replace(/\s+/g, '').includes(term.replace(/\s+/g, ''))) return true;
    if (String(r.home_address || '').toLowerCase().includes(term)) return true;
    return false;
  });
}

/**
 * One-shot cleanup for the rows the old automatic rule left behind.
 *
 * The last deploy backfilled everyone with three or more bookings. Those rows
 * are marked added_by='auto'. Setting CUSTDIR_CLEAR_AUTO=1 in the environment
 * deletes exactly those on the next boot and nothing else — anything the owner
 * has since added by hand is 'manual' and is never touched.
 *
 * Not destructive by default, and safe to leave set: once the auto rows are
 * gone it deletes nothing on every subsequent boot.
 */
function clearAutoAdded(db) {
  ensureSchema(db);
  const info = db.prepare("DELETE FROM customer_directory WHERE added_by = 'auto'").run();
  return info.changes;
}

module.exports = { normPhone, normEmail, ensureSchema, addFromBooking, remove,
                   findByIdentity, list, tripStats, clearAutoAdded,
                   isSettledForSpend, tripsFor };
