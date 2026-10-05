/**
 * HAVE THE REMINDERS GONE? — run with:
 *   node server/tests/reminder-indicator.test.js   (also gated by `npm test`)
 *
 * The sweeper tells the rider and the driver twelve hours before a pickup, and
 * until now the only way to know either had happened was to go and look in the
 * database. The owner asked to see it on the job.
 *
 * TWO LATCHES, READ — NOT A THIRD FIGURE KEPT. The marks come straight off
 * customer_reminder_sent_at and driver_reminder_sent_at, the columns the
 * sweeper stamps (server/reminder.js). Nothing new is recorded, so there is
 * nothing new that can drift out of step with what was actually sent.
 *
 * THE DRIVER'S MARK ONLY ON A PASSED JOB. With nobody else driving, the owner
 * IS the driver and his reminder is the owner reminder — a mark saying "driver
 * reminded" about himself is noise on every card. And nothing at all on a job
 * that is not going ahead yet: a reminder that has not gone for a booking
 * nobody has confirmed is not news.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = strip(read('westmere-owner.html'), { html: true });
const ADMIN = strip(read('westmere-admin.html'), { html: true });
const THEME = read('westmere-theme.css');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* The shipped functions, run — not read for keywords. */
const ownerRow = new Function('escH', fnBlock(OWNER, 'wmRemindersRow') + '; return wmRemindersRow;')(esc);
const admRow = new Function('escTo', fnBlock(ADMIN, 'admRemindersHtml') + '; return admRemindersHtml;')(esc);

/* THE MARK ITSELF, not the word anywhere in the markup: the actions beside it
   are called ...ViewDriverEmail / ...ResendToDriver and carry "Driver" in their
   own names, which a bare /Driver/ cannot tell apart from a reminder tick. */
const hasMark = (h, label) => new RegExp('>' + label + '<\\/span>').test(String(h));

const CONFIRMED = { apiStatus: 'confirmed' };
const CONFIRMED_ADM = { status: 'confirmed' };

test('a confirmed job his own shows the RIDER mark only', () => {
  const h = ownerRow(Object.assign({}, CONFIRMED, { riderRemindedAt: '2026-10-12 17:00' }));
  assert.ok(/Rider/.test(h), 'the rider mark is missing');
  assert.ok(!hasMark(h, 'Driver'), 'a job nobody was passed is claiming a driver reminder');
  assert.ok(/wm-rem on/.test(h), 'a sent reminder is not marked as sent');
});

test('not yet sent reads as not sent, not as nothing', () => {
  const h = ownerRow(Object.assign({}, CONFIRMED, { riderRemindedAt: null }));
  assert.ok(/Rider/.test(h), 'the rider mark disappears when it has not gone');
  assert.ok(!/wm-rem on/.test(h), 'an unsent reminder is marked as sent');
  assert.ok(/—/.test(h), 'there is no "not yet" mark at all');
});

test('a PASSED job shows both, independently', () => {
  const both = ownerRow(Object.assign({}, CONFIRMED, {
    passedAt: 'x', driverId: 9, riderRemindedAt: '2026-10-12 17:00', driverRemindedAt: '2026-10-12 17:00' }));
  assert.ok(hasMark(both, 'Rider') && hasMark(both, 'Driver'), 'a passed job must show both');
  assert.strictEqual((both.match(/wm-rem on/g) || []).length, 2, 'both should read as sent');

  const half = ownerRow(Object.assign({}, CONFIRMED, {
    passedAt: 'x', driverId: 9, riderRemindedAt: '2026-10-12 17:00', driverRemindedAt: null }));
  assert.strictEqual((half.match(/wm-rem on/g) || []).length, 1,
    'one sent and one not must not read the same');
});

test('a job passed to a FIRM shows no driver mark — there is no driver', () => {
  const h = ownerRow(Object.assign({}, CONFIRMED, { passedAt: 'x', operatorId: 31 }));
  assert.ok(!hasMark(h, 'Driver'), 'an operator job is claiming a driver reminder');
});

test('nothing at all on a job that is not going ahead', () => {
  for (const st of ['pending', 'offered', 'cancelled', 'completed', '']) {
    assert.strictEqual(ownerRow({ apiStatus: st, riderRemindedAt: null }), '',
      st + ' is showing a reminder row');
  }
  assert.strictEqual(ownerRow(null), '');
});

test('the admin says the same thing from the same columns', () => {
  const h = admRow(Object.assign({}, CONFIRMED_ADM, {
    passed_at: 'x', driver_id: 9, customer_reminder_sent_at: '2026-10-12 17:00',
    driver_reminder_sent_at: null }));
  assert.ok(hasMark(h, 'Rider') && hasMark(h, 'Driver'), 'the admin shows a different set of marks');
  assert.strictEqual((h.match(/wm-rem on/g) || []).length, 1);
  assert.strictEqual(admRow({ status: 'pending' }), '', 'the admin shows the row on an unconfirmed job');
  assert.ok(!hasMark(admRow(Object.assign({}, CONFIRMED_ADM, { passed_at: 'x', operator_id: 31 })), 'Driver'),
    'the admin claims a driver reminder on an operator job');
});

test('the marks are read off the LATCHES, not off a new column', () => {
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/customer_reminder_sent_at/.test(src) && /driver_reminder_sent_at/.test(src),
      who + ' does not read the sweeper\'s own columns');
  }
  // And the sweeper still stamps exactly those.
  const rem = read('server/reminder.js');
  for (const col of ['customer_reminder_sent_at', 'driver_reminder_sent_at']) {
    assert.ok(new RegExp('SET ' + col + " = datetime\\('now'\\)").test(rem),
      'the sweeper no longer stamps ' + col + ' — the marks would never light');
  }
});

test('the mark is an outline, and SENT is the gold one', () => {
  const base = THEME.slice(THEME.indexOf('.wm-rem{'), THEME.indexOf('.wm-rem.on{'));
  assert.ok(/background:\s*var\(--westmere-white\)/.test(base), 'the mark fills — §20');
  assert.ok(/border:[^;]*var\(--westmere-line-strong\)/.test(base), 'the unsent mark has no edge');
  assert.ok(/\.wm-rem\.on\{[^}]*var\(--westmere-gold\)/.test(THEME), 'sent is not distinguished');
  assert.ok(/\.wm-rem\.on \.wm-rem-t\{[^}]*var\(--westmere-gold-ink\)/.test(THEME),
    'the tick is not the gold ink');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/reminder-indicator\.test\.js/.test(read('package.json')),
    'reminder-indicator.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
