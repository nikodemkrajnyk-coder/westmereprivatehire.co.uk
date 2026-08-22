/**
 * THE OWNER'S CUSTOMER DIRECTORY — who has ridden with us more than twice.
 *
 * WHY THIS IS ITS OWN TABLE
 *   `customers` already exists, but it is an ACCOUNT table: email is NOT NULL
 *   UNIQUE and password is NOT NULL, because a row there is a rider login. Most
 *   of this business arrives by phone and never makes an account, and a regular
 *   who has never given an email address cannot be represented there at all.
 *   Forcing them in would mean inventing a fake email, which is how a directory
 *   fills up with `07700900123@placeholder.invalid`.
 *
 *   So the directory is its own table, derived from booking history, and it
 *   carries `customer_id` when the person ALSO has an account — one row per
 *   human either way.
 *
 * THE MATCH KEY
 *   A phone number is what this trade actually identifies people by, so
 *   `phone_key` is primary and UNIQUE. Email is the fallback for the rare
 *   booking with an address but no number. Both are normalised hard —
 *   "+44 7700 900123", "07700 900123" and "07700900123" are one person, and
 *   "Ben@Example.com" and "ben@example.com" are one person.
 *
 * THE RULE
 *   MORE THAN TWO bookings — three or more — and the person is listed. One or
 *   two and they are not. Cancelled bookings do not count towards it: someone
 *   who booked twice and cancelled both is not a regular.
 *
 * GUARDRAIL: server/tests/customer-directory.test.js
 */

/**
 * UK mobile/landline → a stable comparison key.
 * Strips everything that is not a digit, then folds the international forms
 * onto the national one: +447700900123 / 00447700900123 / 447700900123 /
 * 07700900123 all become 7700900123. Returns '' when there is nothing usable,
 * and callers must treat '' as "no key", never as a matchable value — otherwise
 * every customer with no phone number collapses into one row.
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

const MIN_BOOKINGS = 3; // "more than two"

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
      -- Set once the owner edits the address by hand. The nightly/booking-time
      -- recompute then leaves it alone: his correction outranks our guess.
      address_locked INTEGER NOT NULL DEFAULT 0,
      booking_count INTEGER NOT NULL DEFAULT 0,
      last_booking  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // A partial index: many rows legitimately have no email, and a plain UNIQUE
  // would collide them all on ''.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_custdir_email
             ON customer_directory(email_key) WHERE email_key IS NOT NULL AND email_key <> ''`);
  } catch (_) {}
}

/**
 * Every booking that counts, folded into one record per person.
 * A booking contributes its passenger_* fields, or the linked account's, and
 * cancelled trips are excluded from the count that decides listing.
 */
function gatherFromBookings(db) {
  const rows = db.prepare(`
    SELECT b.id, b.pickup, b.date, b.status,
           COALESCE(NULLIF(TRIM(c.full_name), ''), b.passenger_name)  AS name,
           COALESCE(NULLIF(TRIM(c.phone), ''),     b.passenger_phone) AS phone,
           COALESCE(NULLIF(TRIM(c.email), ''),     b.passenger_email) AS email,
           b.customer_id
      FROM bookings b
      LEFT JOIN customers c ON b.customer_id = c.id
     WHERE COALESCE(b.status, '') <> 'cancelled'
     ORDER BY b.date ASC, b.id ASC
  `).all();

  const people = new Map();          // key → record
  const byEmail = new Map();         // email_key → key, so a phone-less booking joins the right person

  for (const r of rows) {
    const pk = normPhone(r.phone);
    const ek = normEmail(r.email);
    // Phone first; fall back to a person already known by this email; otherwise
    // the email itself becomes the key. A booking with NEITHER cannot identify
    // anybody and is skipped — it would otherwise merge strangers together.
    let key = pk ? 'p:' + pk : (ek ? (byEmail.get(ek) || 'e:' + ek) : null);
    if (!key) continue;
    if (ek && !byEmail.has(ek)) byEmail.set(ek, key);

    let rec = people.get(key);
    if (!rec) {
      rec = { key, phone_key: pk || null, email_key: ek || null, name: null, phone: null,
              email: null, customer_id: null, count: 0, last: null, pickups: new Map() };
      people.set(key, rec);
    }
    rec.count++;
    // Latest non-empty value wins — bookings are walked oldest first, so the most
    // recent spelling of a name or the newest email is what the owner sees.
    if (r.name && String(r.name).trim()) rec.name = String(r.name).trim();
    if (r.phone && String(r.phone).trim()) rec.phone = String(r.phone).trim();
    if (r.email && String(r.email).trim()) rec.email = String(r.email).trim();
    if (!rec.phone_key && pk) rec.phone_key = pk;
    if (!rec.email_key && ek) rec.email_key = ek;
    if (r.customer_id) rec.customer_id = r.customer_id;
    if (r.date && (!rec.last || r.date > rec.last)) rec.last = r.date;

    // HOME ADDRESS = where they are usually collected from. Most frequent pickup
    // wins; a tie goes to the most recent, because people move.
    const pu = (r.pickup || '').trim();
    if (pu) {
      const cur = rec.pickups.get(pu) || { n: 0, last: '' };
      cur.n++; if (r.date && r.date > cur.last) cur.last = r.date;
      rec.pickups.set(pu, cur);
    }
  }
  return people;
}

/* Airports and terminals are where a regular gets COLLECTED on the way home,
   not where they live. A customer with three airport return legs and one house
   pickup would otherwise be filed as living at Gatwick — which is exactly what
   the first version of this did. Anything that looks like a transport hub is
   excluded from the candidates; if that leaves nothing, we return null and the
   owner fills the address in himself, which is honest. */
const NOT_A_HOME = /\bairport\b|\bterminal\b|\bheathrow\b|\bgatwick\b|\bstansted\b|\bluton\b|\bstation\b|\bst pancras\b|\bking'?s cross\b|\beuston\b|\bcruise\b|\bport of\b|\bferry\b/i;

function pickHomeAddress(pickups) {
  let best = null;
  for (const [addr, v] of pickups) {
    if (NOT_A_HOME.test(addr)) continue;
    if (!best || v.n > best.n || (v.n === best.n && v.last > best.last)) best = { addr, n: v.n, last: v.last };
  }
  return best ? best.addr : null;
}

/**
 * Rebuild the directory from booking history.
 *
 * Idempotent by construction: it upserts on phone_key (or email_key), so
 * running it twice produces exactly the same table. Owner-edited addresses are
 * preserved — `address_locked` is the record of "he has already corrected this".
 *
 * → { listed, skipped } — how many met the threshold, how many did not.
 */
function rebuild(db) {
  ensureSchema(db);
  const people = gatherFromBookings(db);
  const findByPhone = db.prepare('SELECT * FROM customer_directory WHERE phone_key = ?');
  const findByEmail = db.prepare("SELECT * FROM customer_directory WHERE email_key = ? AND email_key <> ''");
  let listed = 0, skipped = 0;

  for (const rec of people.values()) {
    if (rec.count < MIN_BOOKINGS) { skipped++; continue; }
    listed++;
    const home = pickHomeAddress(rec.pickups);
    const existing = (rec.phone_key && findByPhone.get(rec.phone_key))
                  || (rec.email_key && findByEmail.get(rec.email_key))
                  || null;
    if (existing) {
      db.prepare(`
        UPDATE customer_directory
           SET name = COALESCE(?, name),
               phone = COALESCE(?, phone),
               email = COALESCE(?, email),
               phone_key = COALESCE(?, phone_key),
               email_key = COALESCE(?, email_key),
               customer_id = COALESCE(?, customer_id),
               home_address = CASE WHEN address_locked = 1 THEN home_address ELSE COALESCE(?, home_address) END,
               booking_count = ?, last_booking = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(rec.name, rec.phone, rec.email, rec.phone_key, rec.email_key,
             rec.customer_id, home, rec.count, rec.last, existing.id);
    } else {
      db.prepare(`
        INSERT INTO customer_directory (phone_key, email_key, customer_id, name, phone, email,
                                        home_address, booking_count, last_booking)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(rec.phone_key, rec.email_key, rec.customer_id, rec.name, rec.phone,
             rec.email, home, rec.count, rec.last);
    }
  }
  return { listed, skipped };
}

/**
 * Called after a booking is created or its status changes. A full rebuild is
 * cheap at this scale (one pass over bookings, a few hundred rows) and it is the
 * only version that cannot drift from the history it claims to summarise — an
 * incremental counter would eventually disagree with the bookings table, and
 * the owner would have no way to tell which was lying.
 */
function syncAfterBooking(db) {
  try { return rebuild(db); }
  catch (e) { console.error('[CUSTDIR] sync failed:', e.message); return null; }
}

/** The saved list, newest activity first, optionally filtered. */
function list(db, q) {
  ensureSchema(db);
  const term = String(q || '').trim().toLowerCase();
  const rows = db.prepare(`
    SELECT id, name, phone, email, home_address, booking_count, last_booking, customer_id, address_locked
      FROM customer_directory
     ORDER BY (last_booking IS NULL), last_booking DESC, name COLLATE NOCASE ASC
  `).all();
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

module.exports = { normPhone, normEmail, ensureSchema, rebuild, syncAfterBooking, list,
                   pickHomeAddress, gatherFromBookings, NOT_A_HOME, MIN_BOOKINGS };
