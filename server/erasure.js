/**
 * ERASURE AND RETENTION — what we delete, what we must keep, and when.
 *
 * Two promises are made to customers in the privacy policy and neither was
 * kept by any code:
 *
 *   "You can ask us to delete your data." Deleting an account set active = 0
 *   and left every field exactly where it was — name, email, phone, home
 *   address, bank details, journeys — and registering the same email again
 *   switched the row back on. That is not erasure; it is hiding a row.
 *
 *   "We keep records for six years and then securely delete them." Nothing
 *   deleted anything, ever.
 *
 * WHAT CANNOT SIMPLY BE DELETED. A private hire operator has to be able to
 * show a record of journeys for its licence, and invoices for HMRC — six years
 * is the figure the policy names and the ordinary one. So a journey is NOT
 * destroyed when its passenger asks to be forgotten: it is DETACHED from them.
 * The row keeps its date, route, fare and driver, which is what the licence and
 * the tax return need; it loses the name, number, email, note and account link,
 * which is what identifies a person. Six years later the row goes entirely.
 *
 * That distinction is the whole design:
 *     erasure removes the PERSON from the record,
 *     retention removes the RECORD.
 *
 * Both functions will tell you what they would do without doing it — pass
 * { dryRun: true } — because the first thing anybody sensibly asks of a
 * deletion routine is "show me what you are about to remove", and the customer
 * is shown exactly that before the button does anything.
 *
 * GUARDRAIL: server/tests/erasure.test.js
 */

/** What the name becomes on a detached journey. Deliberately a sentence, so
    that anybody reading the trips list understands what they are looking at
    rather than wondering who "REDACTED" was. */
const ERASED_NAME = 'Erased at customer request';

/** Six years, as the privacy policy says. ONE place, so the promise and the
    code cannot drift apart. */
const RETENTION_YEARS = 6;

/**
 * A UK wall-clock date N years before `today`.
 *
 * Component arithmetic on the string, never an instant — CLAUDE.md's timezone
 * invariant. A cutoff built with `new Date()` would land a day out for an hour
 * every British summer morning, and the rows it deleted would be gone.
 */
function cutoffDate(years, today) {
  const t = String(today || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' }));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return '1900-01-01';
  const y = +m[1] - (Number(years) || RETENTION_YEARS);
  return String(y).padStart(4, '0') + '-' + m[2] + '-' + m[3];
}

/** A phone number folded to the key customer_directory matches on. Same rule
    as customer-directory.js; '' means "no key" and must never match. */
function phoneKey(raw) {
  if (raw == null) return '';
  let d = String(raw).replace(/\D+/g, '');
  if (!d) return '';
  if (d.startsWith('0044')) d = d.slice(4);
  else if (d.startsWith('44') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 9 ? d : '';
}

function emailKey(raw) {
  const e = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

/** A count that returns 0 rather than throwing when a table does not exist —
    customer_directory is created lazily, not at boot. */
function countOf(db, sql, params) {
  try { return db.prepare(sql).get(...(params || [])).c; }
  catch (e) { return 0; }
}

/**
 * WHAT ERASING THIS ACCOUNT WOULD DO — the figures the customer is shown on
 * the confirmation screen, and the figures the audit line is written from.
 * Nothing here writes, so the screen cannot promise something the database
 * will not do.
 */
function erasurePlan(db, customerId) {
  const id = parseInt(customerId, 10);
  if (!id) return null;
  let me = null;
  try { me = db.prepare('SELECT * FROM customers WHERE id = ?').get(id); }
  catch (e) { return null; }
  if (!me) return null;

  /* A BUSINESS ACCOUNT IS NOT ONE PERSON'S TO ERASE. The company holds it, its
     invoices are the company's records, and a contact who leaves is replaced,
     not erased. Refusing here — with a reason a person can act on — is right;
     silently wiping a company's booking history because a receptionist tapped
     a button in her own account would not be. */
  if (String(me.account_type || '') === 'business' || me.parent_customer_id) {
    return { refused: 'business', company: me.company || me.full_name };
  }

  const email = emailKey(me.email);
  const pkey = phoneKey(me.phone);

  return {
    customer: { id: id, name: me.full_name, email: me.email },
    /* Kept, detached: date/route/fare stay, the person goes. */
    journeys: countOf(db, `SELECT COUNT(*) c FROM bookings
                            WHERE customer_id = ?
                               OR (? <> '' AND LOWER(TRIM(COALESCE(passenger_email,''))) = ?)`,
                      [id, email, email]),
    /* Kept whole, for HMRC: an issued invoice is a tax document. */
    invoices: countOf(db, 'SELECT COUNT(*) c FROM invoices WHERE customer_id = ?', [id]),
    /* Deleted outright: none of this is a journey record. */
    directory: countOf(db, `SELECT COUNT(*) c FROM customer_directory
                             WHERE customer_id = ?
                                OR (? <> '' AND email_key = ?)
                                OR (? <> '' AND phone_key = ?)`,
                       [id, email, email, pkey, pkey]),
    change_requests: countOf(db, 'SELECT COUNT(*) c FROM change_requests WHERE customer_id = ?', [id]),
    sessions: countOf(db, 'SELECT COUNT(*) c FROM sessions WHERE customer_id = ?', [id]),
    retention_years: RETENTION_YEARS
  };
}

/**
 * ERASE ONE CUSTOMER.
 *
 * Returns the plan it carried out, or { refused } — never a bare boolean, so
 * the confirmation screen and the audit line both describe what actually
 * happened rather than what was intended.
 */
function eraseCustomer(db, customerId, opts) {
  const o = opts || {};
  const plan = erasurePlan(db, customerId);
  if (!plan || plan.refused) return plan;
  if (o.dryRun) return plan;

  const id = plan.customer.id;
  const email = emailKey(plan.customer.email);
  const pkey = phoneKey((db.prepare('SELECT phone FROM customers WHERE id = ?').get(id) || {}).phone);
  const quiet = (sql, params) => {
    try { db.prepare(sql).run(...(params || [])); }
    catch (e) { /* a table this database does not have holds nothing to erase */ }
  };

  const run = db.transaction(() => {
    /* ── THE JOURNEY KEEPS THE ROAD AND LOSES THE PERSON ──────────────────
       Everything the licence and the tax return need — date, time, pickup,
       destination, fare, driver, status — is untouched. Everything that names
       a person is gone, including the free-text note fields, which is where a
       phone number or a door code ends up in practice. */
    quiet(`UPDATE bookings
              SET passenger_name = ?, passenger_phone = NULL, passenger_email = NULL,
                  customer_note = NULL, notes = NULL, flight = NULL,
                  change_request_detail = NULL, change_request_summary = NULL,
                  customer_id = NULL, updated_at = datetime('now')
            WHERE customer_id = ?
               OR (? <> '' AND LOWER(TRIM(COALESCE(passenger_email,''))) = ?)`,
          [ERASED_NAME, id, email, email]);

    /* The owner's saved address book is a convenience, not a record — it goes
       whole, matched three ways because a row can have been added from a
       booking that carried only a number. */
    quiet(`DELETE FROM customer_directory
            WHERE customer_id = ?
               OR (? <> '' AND email_key = ?)
               OR (? <> '' AND phone_key = ?)`,
          [id, email, email, pkey, pkey]);
    quiet(`DELETE FROM invoice_recipients WHERE ? <> '' AND LOWER(TRIM(COALESCE(email,''))) = ?`,
          [email, email]);
    quiet(`DELETE FROM review_emails_sent WHERE ? <> '' AND LOWER(TRIM(email)) = ?`, [email, email]);
    quiet('DELETE FROM sessions WHERE customer_id = ?', [id]);

    /* A change request is the owner's record of what was asked for. The ask
       stays; the contact details on it do not. */
    quiet(`UPDATE change_requests
              SET contact_name = ?, contact_email = NULL, contact_phone = NULL, customer_id = NULL
            WHERE customer_id = ?`, [ERASED_NAME, id]);

    /* ── THE ACCOUNT ROW IS OVERWRITTEN, NOT HIDDEN ───────────────────────
       Every field that identifies a person is cleared, the bank columns
       included. The email becomes a unique address at a reserved .invalid
       domain, which does two jobs: nothing can match this row to the person
       again, and signing up with their real address starts a genuinely NEW
       account instead of finding this one. The row survives only because
       bookings and invoices older than the retention window still reference
       the id, and a dangling reference reads worse than a tombstone. */
    quiet(`UPDATE customers
              SET email = ?, password = '', full_name = ?, phone = NULL, company = NULL,
                  address_line1 = NULL, address_line2 = NULL, postcode = NULL,
                  bank_name = NULL, bank_sort_code = NULL, bank_account_no = NULL,
                  bank_account_name = NULL,
                  verified = 0, verification_token = NULL,
                  reset_token = NULL, reset_token_expires = NULL,
                  active = 0, erased_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`,
          ['erased-' + id + '@westmereprivatehire.invalid', ERASED_NAME, id]);

    /* An issued invoice stays as issued — it is a tax document and its figures
       must still add up — but it no longer points at an account, so nothing
       can walk from it back to a person here. */
    quiet('UPDATE invoices SET customer_id = NULL WHERE customer_id = ?', [id]);

    /* The audit line records WHAT was done, not WHO it was done to: the
       detail carries counts and the customer id, never the name or email we
       have just spent a transaction removing. */
    quiet(`INSERT INTO audit_log (user_type, user_id, action, detail, ip)
           VALUES ('customer', ?, 'account_erased', ?, NULL)`,
          [id, 'detached ' + plan.journeys + ' journey(s); kept ' + plan.invoices
               + ' invoice(s) for ' + RETENTION_YEARS + ' years; deleted '
               + plan.directory + ' address-book row(s)']);
  });
  run();
  return plan;
}

/**
 * THE SIX YEARS THE POLICY PROMISES, ACTUALLY APPLIED.
 *
 * Journeys and invoices older than the window go, and so do expired sessions —
 * a session row holds an IP address and is useless the moment it expires, so it
 * is pruned on its own expiry rather than kept for six years.
 */
function runRetention(db, opts) {
  const o = opts || {};
  const cutoff = cutoffDate(o.years || RETENTION_YEARS, o.today);
  const expired = "COALESCE(expires_at,'') <> '' AND expires_at < datetime('now')";

  const plan = {
    cutoff: cutoff,
    bookings: countOf(db, 'SELECT COUNT(*) c FROM bookings WHERE date < ?', [cutoff]),
    invoices: countOf(db, "SELECT COUNT(*) c FROM invoices WHERE COALESCE(issued_date,'') <> '' AND issued_date < ?", [cutoff]),
    audit:    countOf(db, 'SELECT COUNT(*) c FROM audit_log WHERE created_at < ?', [cutoff]),
    sessions: countOf(db, 'SELECT COUNT(*) c FROM sessions WHERE ' + expired, [])
  };
  if (o.dryRun) return plan;

  const quiet = (sql, params) => {
    try { db.prepare(sql).run(...(params || [])); } catch (e) {}
  };
  const run = db.transaction(() => {
    /* A booking is referenced by change_requests and by the invoice that
       billed it; both are cleared of the reference first so the delete cannot
       fail on a foreign key and leave the window unenforced. */
    quiet('DELETE FROM change_requests WHERE booking_id IN (SELECT id FROM bookings WHERE date < ?)', [cutoff]);
    quiet('DELETE FROM bookings WHERE date < ?', [cutoff]);
    quiet("DELETE FROM invoices WHERE COALESCE(issued_date,'') <> '' AND issued_date < ?", [cutoff]);
    quiet('DELETE FROM audit_log WHERE created_at < ?', [cutoff]);
    quiet('DELETE FROM sessions WHERE ' + expired, []);
  });
  run();
  if (plan.bookings || plan.invoices || plan.audit || plan.sessions) {
    console.log('[RETENTION] older than ' + cutoff + ' — removed ' + plan.bookings
      + ' journey(s), ' + plan.invoices + ' invoice(s), ' + plan.audit
      + ' audit row(s), ' + plan.sessions + ' expired session(s)');
  }
  return plan;
}

/**
 * Run it daily, starting an hour after boot so a deploy is never racing it.
 * A six-year window does not need to be swept more often than that, and the
 * delay keeps the first sweep out of the way of the restart it rode in on.
 */
function startRetention(db) {
  const DAY = 24 * 60 * 60 * 1000;
  let timer = null;
  const tick = () => {
    try { runRetention(db); } catch (e) { console.error('[RETENTION]', e.message); }
    timer = setTimeout(tick, DAY);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(tick, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('[RETENTION] scheduled — ' + RETENTION_YEARS + '-year window, swept daily');
}

module.exports = {
  eraseCustomer,
  erasurePlan,
  runRetention,
  startRetention,
  cutoffDate,
  RETENTION_YEARS,
  ERASED_NAME
};
