/**
 * THE BUSINESS ACCOUNT — one company, one responsible contact.
 *
 * A corporate client holds an account in the COMPANY's name: every ride on it
 * goes to one monthly invoice, and one person — their receptionist or office
 * manager — signs in, books the cars, and takes her own paperwork without
 * ringing the office. That last part is the point of the whole thing.
 *
 * TWO RULES LIVE HERE, AND NOTHING ELSE MAY DECIDE THEM:
 *
 *   1. WHICH ACCOUNT IS THIS PERSON ACTING FOR. A contact's own customers row
 *      carries parent_customer_id pointing at the company. Every booking on the
 *      account carries customer_id = THE COMPANY, never the contact — which is
 *      what lets Customer Spend, the invoice run, the trips list and the
 *      turnover SQL keep working untouched and see the whole company. Anything
 *      that reads "this customer's" bookings on a business account has to ask
 *      accountIdFor() first, or she sees an empty screen while her rides sit
 *      against the company id.
 *
 *   2. WHO THE DRIVER RINGS. On a business account the driver is given the
 *      CONTACT's number and rings her on arrival; she tells the passenger the
 *      car is outside. The passenger's own number is never collected, never
 *      stored and never passed on. driverContactFor() is the single answer to
 *      "what number goes on the job", and the guard drives a real dispatch
 *      through it and asserts a passenger number cannot appear.
 *
 * A SECOND BOOKER is possible in this shape — another customers row pointing at
 * the same company — and is deliberately not offered anywhere in the app. The
 * column exists so that adding one later is a row, not a migration.
 *
 * GUARDRAIL: server/tests/business-account.test.js
 */

/** Is this customer row a business account, or a contact on one? */
function isBusiness(c) {
  return !!(c && (String(c.account_type || '') === 'business' || c.parent_customer_id));
}

/**
 * The account a customer acts for: the company when they are a contact on one,
 * otherwise themselves.
 *
 * Takes an id and returns an id, so every caller can use it in the query it
 * already has. A missing or broken parent falls back to the customer's own id —
 * a contact whose company row was deleted must still see her own history rather
 * than a 500.
 */
function accountIdFor(db, customerId) {
  const id = parseInt(customerId, 10);
  if (!id) return null;
  /* Same reason as contextFor: this stands in front of a customer's own trip
     list, and a missing column must read as "no parent", never as a 500. */
  let row = null;
  try { row = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(id); }
  catch (e) { return id; }
  if (!row) return id;
  if (!row.parent_customer_id) return row.id;
  const parent = db.prepare('SELECT id FROM customers WHERE id = ? AND active = 1').get(row.parent_customer_id);
  return parent ? parent.id : row.id;
}

/**
 * Everything a screen needs to know about who is signed in: the person, the
 * account they act for, and whether this is a business account at all.
 */
function contextFor(db, customerId) {
  const id = parseInt(customerId, 10);
  if (!id) return null;
  /* SELECT *, NOT A NAMED LIST. The named list threw `no such column:
     account_type` against a customers table that predates it — and because
     this is called on the way to a DRIVER'S JOB EMAIL, the throw did not
     produce a wrong answer, it produced no email at all. A lookup that sits in
     front of somebody's work must degrade to "not a business account", never
     to an exception. Found by the ad-hoc offer guard. */
  let me = null;
  try { me = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(id); }
  catch (e) { return null; }
  if (!me) return null;
  const accountId = accountIdFor(db, id);
  let account = me;
  if (accountId !== me.id) {
    try { account = db.prepare('SELECT * FROM customers WHERE id = ?').get(accountId) || me; }
    catch (e) { account = me; }
  }
  const business = isBusiness(me) || isBusiness(account);
  return {
    contact: me,
    account: account || me,
    accountId: (account || me).id,
    business: business,
    /* The name the invoice is raised in and the heading she reads. A business
       row should always carry `company`; falling back to the account's own name
       keeps a half-set-up account readable instead of blank. */
    companyName: business ? ((account && (account.company || account.full_name)) || me.company || me.full_name) : null
  };
}

/**
 * THE NUMBER THAT GOES TO THE DRIVER.
 *
 * On a business account it is the CONTACT's — never the passenger's, which we
 * do not hold. On a personal account nothing changes: the passenger is the
 * account holder and their own number is the right one.
 *
 * Returns { name, phone, label } or null when there is nobody to ring, so the
 * dispatch builder can print a labelled block rather than a bare number. The
 * label is what stops a driver assuming the number belongs to the person he is
 * collecting.
 */
function driverContactFor(db, booking) {
  if (!booking || !booking.customer_id) return null;
  const ctx = contextFor(db, booking.customer_id);
  if (!ctx || !ctx.business) return null;
  /* The contact is whoever holds the login for this company. One in v1; if a
     second is ever added, the one who made the booking, else the first. */
  let bookers = [];
  try {
    bookers = db.prepare(`SELECT id, full_name, phone FROM customers
                           WHERE active = 1 AND (id = ? OR parent_customer_id = ?)
                             AND phone IS NOT NULL AND TRIM(phone) <> ''
                           ORDER BY parent_customer_id IS NULL, id`).all(ctx.accountId, ctx.accountId);
  } catch (e) { return null; }
  const who = bookers[0];
  if (!who) return null;
  return {
    name: who.full_name,
    phone: who.phone,
    company: ctx.companyName,
    label: 'Account contact'
  };
}

/**
 * What a business booking is allowed to carry about its passenger.
 *
 * A NAME AND NOTHING ELSE. The booking row has passenger_phone and
 * passenger_email columns because every other kind of booking needs them, and
 * the quiet way this rule breaks is somebody filling one in "to be helpful"
 * months from now. This strips them at the one place a business booking is
 * written, and the guard asserts the stripped values never reach a driver.
 */
function passengerFieldsFor(name) {
  return {
    passenger_name: String(name || '').trim().slice(0, 120),
    passenger_phone: null,
    passenger_email: null
  };
}

/**
 * The one line every driver-facing send adds to its payload.
 *
 * Returns the booking with `account_contact` attached when it is a company
 * ride, and untouched when it is not — so a call site can wrap whatever object
 * it was already passing without caring which kind of account this is. Every
 * path that reaches a driver goes through this: dispatch, the ad-hoc offer, the
 * twelve-hour reminder, and the owner's view/resend of the job email.
 */
function forDriver(db, booking) {
  if (!booking) return booking;
  let contact = null;
  try { contact = driverContactFor(db, booking); }
  catch (e) { console.error('[BIZ] driver contact failed:', e.message); }
  if (!contact) return booking;
  /* ── AND THE NAME IS THE PASSENGER'S, NOT THE COMPANY'S ────────────────
     Every dispatch query reads `COALESCE(c.full_name, b.passenger_name) AS
     customer_name`, and on a company ride the joined customer IS the company —
     so without this the driver is told he is collecting "Harding Executive
     Travel" from the head office at a quarter past six. The booking's own
     passenger_name is the person standing outside.
     Found by the guard, not by reading it. */
  const out = Object.assign({}, booking, { account_contact: contact });
  const who = String(booking.passenger_name || '').trim();
  if (who) out.customer_name = who;
  /* The passenger's own number never travels, whatever the row carries. */
  out.customer_phone = '';
  return out;
}

module.exports = {
  isBusiness,
  forDriver,
  accountIdFor,
  contextFor,
  driverContactFor,
  passengerFieldsFor
};
