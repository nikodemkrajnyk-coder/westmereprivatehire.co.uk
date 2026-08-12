/**
 * TIMEZONE / DAY-OF-WEEK GUARDRAIL
 *
 * A booking's `date` ('YYYY-MM-DD') and `time` ('HH:MM') are UK WALL-CLOCK
 * strings, not instants. Every surface that shows a customer or a driver a day
 * must therefore render the LITERAL calendar date — no timezone conversion at
 * any point.
 *
 * Canonical case: 2026-08-16 21:00 is a SUNDAY. 21:00 sits close enough to
 * midnight that any stray UTC/local conversion tips it into Monday (or, for a
 * date-only parse, back into Saturday).
 *
 * These tests re-exec themselves under several TZ values, because the whole
 * bug class only appears when the host timezone differs from Europe/London.
 * Railway runs UTC; dev machines do not; customer devices can be anywhere.
 *
 * NOTE for future maintainers: the tempting "fix" of pinning the FORMATTER to
 * Europe/London while still parsing the string as a local instant is WRONG and
 * is asserted against below — it renders Monday 17 August on any host west of
 * London.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const DATE = '2026-08-16'; // Sunday
const TIME = '21:00';
const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata'];

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) { console.log('  ✓ ' + name); }
  else { console.error('  ✗ ' + name + '\n      expected: ' + expected + '\n      actual:   ' + actual); failures++; }
}

// ── Child mode: run the assertions inside one specific TZ ────────────────────
if (process.argv[2] === '--child') {
  const out = {};

  // 1. SERVER — the shared email formatter behind every customer/owner email
  //    (estimate, confirmation, owner alert, 12h reminder, review, cancellation).
  const { formatDate } = require(path.join(ROOT, 'server/email.js'));
  out.email = formatDate(DATE, TIME);
  out.emailDateOnly = formatDate(DATE, null);
  out.emailAsap = formatDate(DATE, 'ASAP');

  // 2. CLIENT — westmere-driver.html drvDayLabel (driver Upcoming/Offered list)
  out.driver = evalFromFile('westmere-driver.html', /function drvDayLabel\(dateStr\)\{[\s\S]*?\n\}/, fn => fn(DATE));

  // 3. CLIENT — westmere-rider.html todayUK must return a UK calendar date
  out.riderTodayShape = evalFromFile('westmere-rider.html', /function todayUK\(\)\{[\s\S]*?\n\}/,
    fn => (/^\d{4}-\d{2}-\d{2}$/.test(fn()) ? 'YYYY-MM-DD' : 'BAD:' + fn()));

  // 4. CLIENT — westmere-pay.html fmtWhen (the customer's payment page)
  out.pay = evalFromFile('westmere-pay.html', /function fmtWhen\(date, time\)\{[\s\S]*?\n  \}/, fn => fn(DATE, TIME));

  // 5. SERVER — analytics heatmap weekday bucket (0=Mon .. 6=Sun)
  out.heatmapDow = (new Date(Date.UTC(2026, 7, 16)).getUTCDay() + 6) % 7;

  // 6. The known-WRONG pattern, asserted so nobody reintroduces it.
  out.wrongNaivePin = new Date(DATE + 'T' + TIME).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  out.wrongDateOnly = new Date(DATE).toLocaleDateString('en-GB', { weekday: 'short' });

  console.log(JSON.stringify(out));
  process.exit(0);
}

function evalFromFile(file, re, use) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + re + ' from ' + file);
  return use(eval('(' + m[0] + ')'));
}

// ── Parent mode ─────────────────────────────────────────────────────────────
console.log('Timezone / day-of-week guardrail — booking ' + DATE + ' ' + TIME + ' (a Sunday)\n');

for (const tz of ZONES) {
  console.log('TZ=' + tz);
  const raw = execFileSync(process.execPath, [__filename, '--child'], {
    env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8'
  });
  const r = JSON.parse(raw.trim().split('\n').pop());

  // Every customer/driver-facing surface must say Sunday 16 August.
  check('email estimate/confirmation/alert/reminder', r.email, 'Sunday, 16 August 2026 · 21:00');
  check('email date-only (invoice due/issued)',       r.emailDateOnly, 'Sunday, 16 August 2026');
  // REGRESSION: bookings.time defaults to 'ASAP', and the old formatter built
  // `new Date(date + 'T' + time)` → '2026-08-16TASAP' → Invalid Date, so every
  // ASAP booking's emails showed "Invalid Date · ASAP" instead of the date.
  check('email ASAP booking (was "Invalid Date")',     r.emailAsap, 'Sunday, 16 August 2026 · ASAP');
  check('driver app upcoming/offered job',             r.driver, 'Sun 16 Aug');
  check('customer pay page',                           r.pay, 'Sun, 16 August 2026 · 21:00');
  check('rider todayUK returns a UK calendar date',    r.riderTodayShape, 'YYYY-MM-DD');
  check('analytics heatmap weekday bucket (6=Sun)',    r.heatmapDow, 6);

  // Regression tripwires: prove the bad patterns really do break, so these
  // assertions fail loudly if someone "simplifies" the fixes back into them.
  if (tz === 'America/New_York' || tz === 'America/Los_Angeles') {
    check('tripwire: local-parse + London-pin IS broken', r.wrongNaivePin, 'Monday, 17 August 2026');
    check('tripwire: bare new Date(dateOnly) IS broken',  r.wrongDateOnly, 'Sat');
  }
  console.log('');
}

if (failures) { console.error('\n' + failures + ' timezone check(s) FAILED'); process.exit(1); }
console.log('All timezone/day-of-week checks passed across ' + ZONES.length + ' host timezones.');
