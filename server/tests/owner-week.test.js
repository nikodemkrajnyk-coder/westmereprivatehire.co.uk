/**
 * The weekly schedule hides nothing, and a delete completes — run with:
 *   node server/tests/owner-week.test.js   (also gated by `npm test`)
 *
 * TWO REAL FAILURES, BOTH REPORTED BY THE OWNER:
 *
 * 1. A booking he could not delete. "Failed to delete booking. Please try
 *    again." — and retrying never helped, because the cause was structural:
 *    change_requests.booking_id is NOT NULL REFERENCES bookings(id) with no
 *    ON DELETE CASCADE, and the database runs with foreign_keys = ON. Any
 *    booking a customer had asked to change was undeletable. It showed up on a
 *    TO-CONFIRM booking because that is exactly where a change request puts
 *    one.
 *
 * 2. A STYLE MISMATCH in the weekly schedule, where Westmere bookings and
 *    Google Calendar events render side by side. The booking carried the
 *    glance row — date and time at --text-xl navy — while the event put its
 *    time in a 0.67rem uppercase chip with no date, dimmed to 70%. The event
 *    read as a footnote to the booking above it.
 *
 * WHAT IS *NOT* A BUG, checked and recorded so nobody re-opens it: the day
 * BUCKETING. A Sunday booking lands in the Sunday bucket of its own week. The
 * key is a literal YYYY-MM-DD string compare, never a parsed instant, so the
 * UTC-midnight trap cannot apply here. The tests below prove that with a real
 * Sunday rather than leaving it as an assumption.
 *
 * The tests run the SHIPPED delete handler against a real SQLite database and
 * read the shipped renderer, rather than restating either.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = read('westmere-owner.html');
const apiSrc = read('server/api.js');

function extractHandler(method, route) {
  const marker = "router." + method + "('" + route + "'";
  const start = apiSrc.indexOf(marker);
  assert.ok(start !== -1, 'server/api.js no longer defines ' + method.toUpperCase() + ' ' + route);
  const arrow = apiSrc.indexOf('=>', start);
  let i = apiSrc.indexOf('{', arrow), depth = 0;
  for (let j = i; j < apiSrc.length; j++) {
    if (apiSrc[j] === '{') depth++;
    else if (apiSrc[j] === '}') { depth--; if (depth === 0) return apiSrc.slice(i + 1, j); }
  }
  throw new Error('unbalanced braces extracting ' + route);
}
const delHandler = extractHandler('delete', '/bookings/:id');

// A database with the SAME constraint the live one has. Without the pragma and
// the REFERENCES clause this test would pass against a bug that still ships.
function makeDb({ changeRequest = false, linkedLeg = false } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, ref TEXT, date TEXT, status TEXT,
                           calendar_event_id TEXT,
                           linked_booking_id INTEGER REFERENCES bookings(id));
    CREATE TABLE change_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,
                           booking_id INTEGER NOT NULL REFERENCES bookings(id),
                           booking_ref TEXT NOT NULL, status TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_type TEXT, user_id INTEGER,
                           action TEXT, detail TEXT, ip TEXT);`);
  db.prepare("INSERT INTO bookings (id,ref,date,status) VALUES (7,'WPH-BEN','2026-08-16','pending')").run();
  if (changeRequest) db.prepare("INSERT INTO change_requests (booking_id,booking_ref,status) VALUES (7,'WPH-BEN','open')").run();
  if (linkedLeg) db.prepare("INSERT INTO bookings (id,ref,date,status,linked_booking_id) VALUES (9,'WPH-RETURN','2026-08-18','confirmed',7)").run();
  return db;
}

function runDelete(db, id = 7, role = 'owner') {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
  const sandbox = {
    getDb: () => db, res,
    req: { auth: { role, id: 1, type: 'staff' }, params: { id: String(id) }, body: {}, ip: '::1' },
    gcal: { deleteEvent: () => Promise.resolve() },
    autoFile: { removeBooking() {} },
    events: { broadcast() {} },
    parseInt, isNaN, Number, String, console: { log() {}, error() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext('(function(req,res){' + delHandler + '})(req,res)', sandbox);
  return res;
}

console.log('\nThe week hides nothing, and delete completes');

// ── 1. THE DELETE FAILURE ────────────────────────────────────────────────
test('a To-Confirm booking WITH a change request can be deleted', () => {
  const db = makeDb({ changeRequest: true });
  const r = runDelete(db);
  assert.strictEqual(r.statusCode, 200,
    'this is the exact failure the owner reported — a booking a customer asked to change ' +
    'returned ' + r.statusCode + ': ' + JSON.stringify(r.body));
  assert.strictEqual(r.body && r.body.ok, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 0, 'the booking is still there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM change_requests').get().n, 0,
    'the change request is orphaned — it points at a booking that no longer exists');
});

test('a booking with a linked return leg can be deleted', () => {
  const db = makeDb({ linkedLeg: true });
  const r = runDelete(db);
  assert.strictEqual(r.statusCode, 200, 'a linked return leg blocked the delete: ' + JSON.stringify(r.body));
  const ret = db.prepare('SELECT linked_booking_id FROM bookings WHERE id=9').get();
  assert.strictEqual(ret.linked_booking_id, null, 'the return leg still points at a deleted booking');
});

test('a plain booking still deletes, and the delete is still audited', () => {
  const db = makeDb();
  assert.strictEqual(runDelete(db).statusCode, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 0);
  const log = db.prepare('SELECT action,detail FROM audit_log').all();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].action, 'booking_deleted');
});

test('a refused delete changes nothing at all', () => {
  const db = makeDb({ changeRequest: true });
  assert.strictEqual(runDelete(db, 7, 'customer').statusCode, 403);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 1, 'a 403 still deleted the booking');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM change_requests').get().n, 1,
    'a 403 still destroyed the change request — the transaction must cover the whole thing');
});

// ── 2. THE HIDDEN SUNDAY BOOKING ─────────────────────────────────────────
const weekFn = (() => {
  const i = OWNER.indexOf('async function buildConfirmed');
  return OWNER.slice(i, OWNER.indexOf('\n}\n', i));
})();

test('the Mon-Sun scaffold really is seven days, and ends on the Sunday', () => {
  assert.ok(/for\(var i=0;i<7;i\+\+\)/.test(weekFn), 'the week no longer renders all seven days');
  assert.ok(/weekEnd\.setDate\(weekEnd\.getDate\(\)\+6\)/.test(weekFn),
    'the week must end six days after the Monday — Sunday, not Saturday');
  // Monday-first, from LOCAL components. (x.getDay()+6)%7 maps Sun->6, so the
  // Monday is found by subtracting, and Sunday lands at i=6 rather than
  // starting a new week.
  const iso = OWNER.slice(OWNER.indexOf('function isoWeekStart'));
  const body = iso.slice(0, iso.indexOf('\n'));
  assert.ok(/\(x\.getDay\(\)\+6\)%7/.test(body), 'isoWeekStart must treat Monday as day 0');
  assert.ok(!/new Date\(['"`]/.test(body) && !/toISOString/.test(body),
    'isoWeekStart must not parse a string or go via UTC — a Sunday would fall into the wrong week');
});

// Prove the week maths with real dates rather than by reading it.
test('a Sunday date lands in the SAME Mon-Sun week, not the next one', () => {
  const isoWeekStart = new Function(
    OWNER.slice(OWNER.indexOf('function isoWeekStart'), OWNER.indexOf('\n', OWNER.indexOf('function isoWeekStart'))) +
    '\nreturn isoWeekStart;')();
  const dk = (y, m, d) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  // Sunday 16 August 2026.
  const sunday = new Date(2026, 7, 16);
  assert.strictEqual(sunday.getDay(), 0, 'fixture is not actually a Sunday');
  const mon = isoWeekStart(sunday);
  const end = new Date(mon); end.setDate(end.getDate() + 6);
  const startKey = dk(mon.getFullYear(), mon.getMonth(), mon.getDate());
  const endKey = dk(end.getFullYear(), end.getMonth(), end.getDate());
  assert.strictEqual(startKey, '2026-08-10', 'the Monday of that week is wrong: ' + startKey);
  assert.strictEqual(endKey, '2026-08-16', 'the week does not reach its own Sunday: ' + endKey);
  const benDate = '2026-08-16';
  assert.ok(benDate >= startKey && benDate <= endKey,
    "Mr Ben's Sunday booking falls outside the week that contains it");
});

test('a Sunday booking buckets under SUNDAY, never Friday or Saturday', () => {
  // Pure maths on the shipped helpers, with a real Sunday.
  const isoWeekStart = new Function(
    OWNER.slice(OWNER.indexOf('function isoWeekStart'), OWNER.indexOf('\n', OWNER.indexOf('function isoWeekStart'))) +
    '\nreturn isoWeekStart;')();
  const dayHeader = new Function(
    OWNER.slice(OWNER.indexOf('function _fmtDayHeader'), OWNER.indexOf('\n}', OWNER.indexOf('function _fmtDayHeader')) + 2) +
    '\nreturn _fmtDayHeader;')();
  const dk = (y, m, d) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');

  const ben = '2026-08-16';                       // a Sunday
  const mon = isoWeekStart(new Date(2026, 7, 16));
  const buckets = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(d.getDate() + i);
    buckets.push({ i, key: dk(d.getFullYear(), d.getMonth(), d.getDate()), label: dayHeader(d) });
  }
  const landed = buckets.find(b => b.key === ben);
  assert.ok(landed, "the Sunday booking does not match any day bucket in its own week");
  assert.strictEqual(landed.i, 6, 'the Sunday booking landed in bucket ' + landed.i + ' (' + landed.label + ')');
  assert.ok(/^SUNDAY/.test(landed.label), 'the Sunday bucket is labelled "' + landed.label + '"');
  assert.ok(!/FRIDAY|SATURDAY/.test(landed.label), 'a Sunday booking is being labelled ' + landed.label);
  // Friday and Saturday must be their own, separate buckets.
  assert.ok(/^FRIDAY/.test(buckets[4].label) && /^SATURDAY/.test(buckets[5].label),
    'the week is mislabelling its last three days: ' + buckets.slice(4).map(b => b.label).join(' | '));
  // And the bucket is a STRING match — nothing is ever parsed into an instant.
  assert.ok(/x\.date===dayKey/.test(weekFn),
    'the day bucket must compare the literal YYYY-MM-DD, not a parsed Date');
});

test('a Google Calendar event is styled like a job, not like a footnote', () => {
  // THE COMPLAINT: in the weekly schedule these render side by side, and they
  // did not match. A booking carried the glance row at --text-xl navy; a
  // personal event put its time in a 0.67rem uppercase chip with no date, the
  // whole card dimmed to 70%. Next to each other the event read as a footnote
  // to the booking above it rather than as its own commitment on that day.
  const i = OWNER.indexOf("if(j.type==='personal'){");
  assert.ok(i !== -1, 'jobCardHtml no longer has a personal-event branch');
  const branch = OWNER.slice(i, OWNER.indexOf('\n  }', i));

  assert.ok(/class="wm-glance"/.test(branch),
    'a personal event does not render the glance row — it will not match the booking beside it');
  assert.ok(/wm-glance-date/.test(branch) && /wm-glance-time/.test(branch),
    'the event must show the same DATE and TIME fields a booking shows');
  assert.ok(/_fmtUpcomingDate\(j\.date\)/.test(branch), "the event's glance date must come from its own date");
  // An event has no fare. An em-dash there would read as an unpriced job.
  assert.ok(!/wm-glance-fare/.test(branch), 'a personal event is rendering a fare slot');
  // ...and it must still be tellable apart from a booking.
  assert.ok(/Personal calendar/.test(branch), 'the event lost the label that distinguishes it from a job');
  // The dimming went with it: a 70% card cannot match a full-strength one.
  assert.ok(!/opacity:\.7/.test(branch), 'the personal card is dimmed again — it cannot match a booking at 70%');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/owner-week\.test\.js/.test(read('package.json')), 'owner-week.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
