/**
 * THE DASHBOARD SAYS TRUE THINGS — run with:
 *   node server/tests/dashboard-truth.test.js   (also gated by `npm test`)
 *
 * Three things the dashboards were saying that were not true. None was found
 * by reading the code; all three turned up the first time the screens were
 * rendered as part of the design pass, which is the point: a figure that is
 * wrong still lays out perfectly.
 *
 *   1. "Good morning, Westmere" was a STRING IN THE MARKUP. Nothing ever
 *      changed it, so the admin panel said good morning at ten at night and
 *      at three in the morning, for ever.
 *
 *   2. "NaN days ago" against every booking with no created_at. The code did
 *      `new Date(b.created_at)` and wrapped it in try/catch — but an Invalid
 *      Date does not throw, and `Math.floor(NaN)` is NaN, so the catch never
 *      fired and the string went to screen.
 *
 *   3. The owner's "Previous Weeks" list filtered `k !== thisKey`, which
 *      excludes this week and NOTHING ELSE — so a booking taken for next
 *      month put a FUTURE week at the top of a list headed "Previous".
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fnBlock, stripComments } = require('./_source.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const ADMIN = read('westmere-admin.html');
const OWNER = read('westmere-owner.html');
const ADMIN_JS = stripComments(ADMIN, { html: true });
const OWNER_JS = stripComments(OWNER, { html: true });

// ── 1. THE GREETING ───────────────────────────────────────────────────────

test('the greeting is set from the clock, not written into the page', () => {
  assert.ok(/id="dash-greeting"/.test(ADMIN), 'the greeting has no id, so nothing can set it');
  assert.ok(/dash-greeting/.test(ADMIN_JS.replace(/id="dash-greeting"/g, '')),
    'nothing in the script ever touches the greeting');
  assert.ok(/Good afternoon/.test(ADMIN_JS) && /Good evening/.test(ADMIN_JS),
    'the only greeting the admin panel knows is "Good morning"');
});

test('the greeting reads the UK hour, not the browser\'s', () => {
  // A phone on holiday is not a different time of day for this business.
  const m = /hour:\s*'2-digit'/.test(ADMIN_JS);
  assert.ok(m, 'the greeting does not ask for an hour');
  assert.ok(/timeZone:\s*'Europe\/London'[^)]*hour:|hour:[^)]*timeZone:\s*'Europe\/London'/.test(ADMIN_JS),
    'the greeting hour is not pinned to Europe/London');
  assert.ok(/hour12:\s*false/.test(ADMIN_JS),
    'without hour12:false the hour parses as 10 at ten at night');
});

test('the three greetings land where they should across the day', () => {
  // The rule itself, run rather than read.
  const rule = (hr) => (hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening');
  const src = ADMIN_JS.slice(ADMIN_JS.indexOf("var word=hr<"));
  assert.ok(/hr<12\?'Good morning':hr<18\?'Good afternoon':'Good evening'/.test(src.slice(0, 120)),
    'the shipped rule is not the one asserted here: ' + src.slice(0, 120));
  assert.strictEqual(rule(0), 'Good morning');
  assert.strictEqual(rule(11), 'Good morning');
  assert.strictEqual(rule(12), 'Good afternoon');
  assert.strictEqual(rule(17), 'Good afternoon');
  assert.strictEqual(rule(18), 'Good evening');
  assert.strictEqual(rule(22), 'Good evening');
  assert.strictEqual(rule(23), 'Good evening');
});

// ── 2. "NaN DAYS AGO" ─────────────────────────────────────────────────────

test('a booking with no created_at is given no age, rather than NaN', () => {
  const block = ADMIN_JS.slice(ADMIN_JS.indexOf("var actDiv=el('dash-activity')"),
                               ADMIN_JS.indexOf("if(actDiv)actDiv.innerHTML=html"));
  assert.ok(block.length > 200, 'the recent-activity block was not found');
  assert.ok(/isFinite\(/.test(block),
    'the age is computed without checking the date parsed — Invalid Date does not throw');
  assert.ok(!/try\{var mins=Math\.floor\(\(Date\.now\(\)-new Date\(b\.created_at\)/.test(block),
    'the original "catch will save us" version is back');
});

test('the age rule itself: no date → nothing; a date → a phrase', () => {
  const age = (created, now) => {
    const t = created ? new Date(String(created).replace(' ', 'T')).getTime() : NaN;
    if (!isFinite(t)) return '';
    let mins = Math.floor((now - t) / 60000);
    if (mins < 0) mins = 0;
    return mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.floor(mins / 60) + ' hours ago'
                                                       : Math.floor(mins / 1440) + ' days ago';
  };
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.strictEqual(age(null, now), '', 'a missing date produced text');
  assert.strictEqual(age('', now), '', 'an empty date produced text');
  assert.strictEqual(age('not a date', now), '', 'rubbish produced text');
  assert.ok(!/NaN/.test(age(undefined, now) + age(null, now)), 'NaN reached the screen');
  assert.strictEqual(age('2026-10-04T11:30:00Z', now), '30 min ago');
  assert.strictEqual(age('2026-10-02T12:00:00Z', now), '2 days ago');
  // A clock skew must not print "-3 min ago".
  assert.strictEqual(age('2026-10-04T12:05:00Z', now), '0 min ago');
});

test('a booking with no name does not print a stray comma', () => {
  const block = ADMIN_JS.slice(ADMIN_JS.indexOf("var actDiv=el('dash-activity')"),
                               ADMIN_JS.indexOf("if(actDiv)actDiv.innerHTML=html"));
  assert.ok(!/escTo\(b\.customer_name\|\|''\)\+', '/.test(block),
    'an unnamed booking reads "WPH-7F2K — , Weppons Farm" again');
  assert.ok(/b\.customer_name\?/.test(block), 'the name is not made conditional');
});

// ── 3. "PREVIOUS WEEKS" MEANS BEFORE ──────────────────────────────────────

test('"Previous Weeks" excludes the future, not just this week', () => {
  const fn = fnBlock(OWNER_JS, 'buildEarnings');
  assert.ok(/prevKeys=Object\.keys\(weeks\)\.filter\(function\s*\(?k\)?\{return k<thisKey;\}\)/.test(fn.replace(/\s+/g, ' ').replace(/ \(/g, '(')) ||
            /return k<thisKey;/.test(fn),
    'the previous-weeks filter is not "before this week"');
  assert.ok(!/return k!==thisKey;/.test(fn),
    'the filter is back to "anything but this week", which lets next month in');
});

test('the rule itself keeps a future week out and the order newest-first', () => {
  const weeks = { '2026-09-07': 1, '2026-09-14': 1, '2026-09-21': 1, '2026-09-28': 1, '2026-10-05': 1, '2026-11-02': 1 };
  const thisKey = '2026-09-28';
  const prev = Object.keys(weeks).filter((k) => k < thisKey).sort().reverse().slice(0, 6);
  assert.deepStrictEqual(prev, ['2026-09-21', '2026-09-14', '2026-09-07']);
  assert.ok(!prev.includes('2026-10-05') && !prev.includes('2026-11-02'), 'a future week is listed as previous');
  assert.ok(!prev.includes(thisKey), 'this week is listed as previous');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/dashboard-truth\.test\.js/.test(read('package.json')),
    'dashboard-truth.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
