/**
 * WORK HE DID THAT DID NOT COME THROUGH WESTMERE — run with:
 *   node server/tests/external-earnings.test.js   (also gated by `npm test`)
 *
 * He drives for other operators as well — Uber, Sussex, Southern — and that
 * money is his earnings as much as a Westmere job is. It was nowhere in this
 * system, so the figure he read at the end of a day was his Westmere earnings
 * being mistaken for his day.
 *
 * THE DANGEROUS WAY TO BUILD THIS would have been a booking with no passenger:
 * one row, one list, done. It would also have put work Westmere never did into
 * the turnover, the VAT position, the operator reports and the driver ledger,
 * and there would be no way to get it back out again. So these live in a table
 * of their own, and the first half of this file is about what they must NOT
 * touch — the money figures the business is run from.
 *
 * The second half is what they must do: add to HIS total, stay named and
 * dated, and be removable, because the only correction for a typed figure is
 * taking it off and typing it again.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const TMP = path.join(os.tmpdir(), 'wm-ext-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
const ledger = require('../driver-ledger');
const api = require('../api');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function resp() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(method, routePath, opts) {
  const o = opts || {};
  const l = api.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, method.toUpperCase() + ' ' + routePath + ' is missing');
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, ip: '::1',
                auth: { role: o.role || 'owner', id: 1, type: 'user' } };
  const r = resp();
  for (const h of l.route.stack.map((x) => x.handle)) {
    let next = false;
    await h(req, r, () => { next = true; });
    if (!next) break;
  }
  return r;
}
const add = (body, role) => call('post', '/external-earnings', { body, role });
const clear = () => db.prepare('DELETE FROM external_earnings').run();

// ── 1. IT IS NOT A BOOKING, AND MUST NEVER BECOME ONE ─────────────────────
console.log('\nIt adds to his total and to nothing else');

test('it is kept in its own table, with who and when on every row', () => {
  const cols = db.prepare('PRAGMA table_info(external_earnings)').all().map((c) => c.name);
  for (const c of ['earned_on', 'amount', 'source', 'note', 'created_at', 'created_by']) {
    assert.ok(cols.includes(c), 'external_earnings has no ' + c + ' — it would not be auditable');
  }
  /* The date is a wall-clock string like bookings.date, not an instant.
     CLAUDE.md: Railway runs UTC and his phone does not. */
  const t = db.prepare('PRAGMA table_info(external_earnings)').all().find((c) => c.name === 'earned_on');
  assert.strictEqual(String(t.type).toUpperCase(), 'TEXT', 'the date must be a wall-clock string');
});

test('adding one changes no booking, and no figure the business is run from', async () => {
  clear();
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,fare,payment,status,paid_at)
              VALUES ('WPH-EXT1','A','B','2026-10-05','09:00',95,'card','completed','2026-10-05 10:00')`).run();
  const before = {
    bookings: db.prepare('SELECT COUNT(*) c FROM bookings').get().c,
    turnover: db.prepare(`SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE ${ledger.receivedSql()}`).get().t
  };
  const r = await add({ date: '2026-10-05', amount: '42.50', source: 'Uber' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const after = {
    bookings: db.prepare('SELECT COUNT(*) c FROM bookings').get().c,
    turnover: db.prepare(`SELECT COALESCE(SUM(${ledger.incomeSql()}),0) t FROM bookings WHERE ${ledger.receivedSql()}`).get().t
  };
  assert.strictEqual(after.bookings, before.bookings, 'adding outside earnings created a booking');
  assert.strictEqual(after.turnover, before.turnover,
    'outside work has gone into the turnover — that is money Westmere never took');
});

test('no driver is owed anything out of it', async () => {
  clear();
  await add({ date: '2026-10-05', amount: '80', source: 'Southern' });
  const rows = db.prepare('SELECT * FROM external_earnings').all();
  assert.strictEqual(rows.length, 1);
  for (const k of Object.keys(rows[0])) {
    assert.ok(!/driver|commission|payout|fare|invoice/i.test(k),
      'an outside entry carries a ' + k + ' — it is turning into a booking');
  }
});

test('the route never writes to bookings at all', () => {
  const src = strip(read('server/api.js'));
  const i = src.indexOf("router.post('/external-earnings'");
  const j = src.indexOf("router.delete('/external-earnings/:id'", i);
  assert.ok(i !== -1 && j > i, 'the add route could not be bounded');
  const block = src.slice(i, j);
  assert.ok(!/INTO bookings|UPDATE bookings/i.test(block),
    'the add route touches the bookings table');
  assert.ok(/INSERT INTO external_earnings/.test(block), 'it does not write its own table');
});

// ── 2. WHAT IT REFUSES ────────────────────────────────────────────────────
console.log('\nWhat it will not take');

test('a date, an amount and a name are all required', async () => {
  for (const [body, why] of [
    [{ amount: '20', source: 'Uber' },                         'no date'],
    [{ date: 'tuesday', amount: '20', source: 'Uber' },         'a date that is not a date'],
    [{ date: '2026-10-05', source: 'Uber' },                    'no amount'],
    [{ date: '2026-10-05', amount: '0', source: 'Uber' },       'nothing'],
    [{ date: '2026-10-05', amount: 'abc', source: 'Uber' },     'an amount that is not a number'],
    [{ date: '2026-10-05', amount: '20' },                      'nobody to attribute it to'],
    [{ date: '2026-10-05', amount: '20', source: '   ' },       'a blank name'],
    [{ date: '2026-10-05', amount: '250000', source: 'Uber' },  'a slipped keyboard']
  ]) {
    const r = await add(body);
    assert.strictEqual(r.statusCode, 400, 'accepted ' + why + ': ' + JSON.stringify(body));
  }
});

test('a correction may be negative — there is no other way to undo a typo', async () => {
  clear();
  const r = await add({ date: '2026-10-05', amount: '-15', source: 'Uber', note: 'overstated' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(Number(r.body.entry.amount), -15);
});

test('it is staff only', async () => {
  for (const [m, p, o] of [['post', '/external-earnings', { body: { date: '2026-10-05', amount: '10', source: 'U' } }],
                           ['get',  '/external-earnings', {}],
                           ['delete', '/external-earnings/:id', { params: { id: '1' } }]]) {
    const r = await call(m, p, Object.assign({ role: 'driver' }, o));
    assert.strictEqual(r.statusCode, 403, p + ' is open to a driver');
  }
});

// ── 3. WHAT IT DOES ───────────────────────────────────────────────────────
console.log('\nNamed, dated, totalled and removable');

test('it stores what he typed, and says who typed it and when', async () => {
  clear();
  const r = await add({ date: '2026-10-05', amount: '42.50', source: 'Sussex Executive', note: 'two airport runs' });
  const e = r.body.entry;
  assert.strictEqual(e.earned_on, '2026-10-05', 'the date moved');
  assert.strictEqual(Number(e.amount), 42.5);
  assert.strictEqual(e.source, 'Sussex Executive');
  assert.strictEqual(e.note, 'two airport runs');
  assert.ok(e.created_at, 'nothing records when it was entered');
  assert.strictEqual(e.created_by, 1, 'nothing records who entered it');
  const log = db.prepare(`SELECT * FROM audit_log WHERE action = 'external_earning_added' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(log, 'adding outside earnings is not audited');
  assert.ok(/42\.50/.test(log.detail) && /Sussex Executive/.test(log.detail),
    'the audit line does not say what was added: ' + log.detail);
});

test('the list comes back newest first, with a total, and can be bounded by date', async () => {
  clear();
  await add({ date: '2026-10-01', amount: '10', source: 'Uber' });
  await add({ date: '2026-10-05', amount: '20', source: 'Southern' });
  await add({ date: '2026-09-28', amount: '30', source: 'Sussex' });

  const all = await call('get', '/external-earnings', {});
  assert.strictEqual(all.body.total, 60, 'the total is wrong');
  assert.deepStrictEqual(all.body.entries.map((e) => e.earned_on),
    ['2026-10-05', '2026-10-01', '2026-09-28'], 'the list is not newest first');

  const oct = await call('get', '/external-earnings', { query: { from: '2026-10-01', to: '2026-10-31' } });
  assert.strictEqual(oct.body.total, 30, 'the date bounds are not applied');
  assert.strictEqual(oct.body.entries.length, 2);
});

test('removing one takes it straight back out, and is audited too', async () => {
  clear();
  const r = await add({ date: '2026-10-05', amount: '25', source: 'Uber' });
  const id = r.body.entry.id;
  const d = await call('delete', '/external-earnings/:id', { params: { id: String(id) } });
  assert.strictEqual(d.statusCode, 200, JSON.stringify(d.body));
  const left = await call('get', '/external-earnings', {});
  assert.strictEqual(left.body.total, 0, 'it is still in the total');
  const log = db.prepare(`SELECT * FROM audit_log WHERE action = 'external_earning_removed' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(log && /25\.00/.test(log.detail), 'removing it is not audited: ' + (log || {}).detail);
  const gone = await call('delete', '/external-earnings/:id', { params: { id: String(id) } });
  assert.strictEqual(gone.statusCode, 404, 'removing it twice is not a 404');
});

// ── 4. THE OWNER APP ──────────────────────────────────────────────────────
console.log('\nAnd it reaches his figures');

const OWNER = strip(read('westmere-owner.html'));

test('the page adds it into today, the week and the month', () => {
  const fn = fnBlock(OWNER, 'buildEarnings');
  assert.ok(fn, 'buildEarnings is gone');
  assert.ok(/extTotalOn\(todayStr\)/.test(fn), "today's card does not include the outside work");
  assert.ok(/extTotalBetween\(_wkStartStr,_wkEndStr\)/.test(fn), 'the week does not');
  assert.ok(/extTotalBetween\(monthPrefix\+'-01'/.test(fn), 'the month does not');
  const card = fnBlock(OWNER, 'setStatCard');
  assert.ok(/amount\+\(outside\|\|0\)/.test(card), 'the card shows the Westmere figure, not his total');
});

test('the split is always visible — the figure can be taken apart again', () => {
  const card = fnBlock(OWNER, 'setStatCard');
  assert.ok(/outside\?[^;]*' outside'/.test(card),
    'a card with outside money in it does not say so: ' + card.slice(-220));
  assert.ok(/outside\?[^;]*:\s*''/.test(card),
    'a day with no outside work must not be given a split to explain');
  /* And the all-time block names both halves rather than one merged figure. */
  const fn = fnBlock(OWNER, 'buildEarnings');
  assert.ok(/Outside Westmere<\/span>/.test(fn) && />Westmere<\/span>/.test(fn),
    'the all-time totals do not separate Westmere from the rest');
});

test('the dates never go through a Date — a day cannot shift', () => {
  const t = fnBlock(OWNER, 'extTotalBetween');
  assert.ok(t, 'extTotalBetween is gone');
  assert.ok(!/new Date\(/.test(t),
    'the date filter builds a Date — a wall-clock day would move with the host timezone');
  const day = fnBlock(OWNER, '_extDay');
  assert.ok(/Date\.UTC\(/.test(day) && /getUTCDate\(\)/.test(day) && /getUTCMonth\(\)/.test(day),
    "the entry's date is not rendered from its literal components (CLAUDE.md)");
  assert.ok(!/toLocaleDateString/.test(day),
    'the date is rendered through a locale — en-GB writes September as "Sept", beside "5 Oct"');
});

test('the sentence under the cards counts the same money the cards do', () => {
  /* It read £106.50 under a card reading £154.50 — a page disagreeing with
     itself about the same week. The week MATHS stays in the shared module; only
     the totals and what follows from them are adjusted. */
  const fn = fnBlock(OWNER, 'buildEarnings');
  assert.ok(/extIntoCompare\(WMLifecycle\.weekCompare\(bookings,earned\)\)/.test(fn),
    'the comparison line leaves the outside work out while the cards include it');
  const into = fnBlock(OWNER, 'extIntoCompare');
  assert.ok(into, 'extIntoCompare is gone');
  for (const f of ['cmp.from,cmp.to', 'cmp.lastFrom,cmp.lastTo']) {
    assert.ok(into.indexOf('extTotalBetween(' + f + ')') !== -1,
      'the comparison does not use the ranges the shared module worked out: ' + f);
  }
  assert.ok(/cmp\.delta=/.test(into) && /cmp\.pct=/.test(into) && /cmp\.direction=/.test(into),
    'the totals move but the change does not follow them');
  assert.ok(!/weekBounds|weekShift|86400000/.test(into),
    'the week maths has been re-implemented here instead of taken from the module');
});

test("the week card says WHICH week's money it is", () => {
  /* The cards at the top include his outside work; this figure is the Westmere
     week the next payment is drawn from. Two numbers both called "this week"
     is how a page stops being trusted. */
  const fn = fnBlock(OWNER, 'buildEarnings');
  assert.ok(/This Week \\u00b7 Westmere/.test(fn),
    'the week card does not say that it is the Westmere figure');
});

test('the entries are fetched before the figures are drawn', () => {
  assert.ok(/extLoad\(\)\.then\(buildEarnings\)/.test(OWNER),
    'the cards would paint once without the outside money and then correct themselves');
});

test('the control is on the page, labelled, and asks for all three things', () => {
  const page = read('westmere-owner.html');
  const i = page.indexOf('<div class="card" id="earn-external">');
  const j = page.indexOf('</div>\n      </div>\n', i);
  assert.ok(i !== -1 && j > i, 'the Outside Westmere card is not on the earnings page');
  const card = page.slice(i, j);
  for (const id of ['ext-amount', 'ext-source', 'ext-date']) {
    assert.ok(card.indexOf('id="' + id + '"') !== -1, 'the form has no ' + id);
  }
  assert.ok(/onclick="extAdd\(\)"/.test(card), 'nothing adds it');
  assert.ok(/<label class="ext-l"/.test(card), 'the fields are unlabelled');
  assert.ok(/list="ext-sources"/.test(card),
    'the names he has used before are not offered back — a typo makes a second operator');
});

test('its styling comes from the theme, in the house colours', () => {
  const css = read('westmere-theme.css');
  assert.ok(/§36 · EARNINGS FROM OUTSIDE WESTMERE/.test(css), 'the theme has no section for it');
  const i = css.indexOf('§36 · EARNINGS FROM OUTSIDE WESTMERE');
  const sec = css.slice(i);
  assert.ok(/\.ext-l\{[^}]*var\(--westmere-gold-ink\)/s.test(sec),
    'the labels do not use the READABLE gold token');
  assert.ok(!/#C9A227|#8A6A12|#102a43/i.test(sec), 'a colour is typed in rather than taken from the tokens');
  assert.ok(!/background:\s*var\(--westmere-gold\)/.test(sec), 'nothing highlights by filling (§20)');
  const page = read('westmere-owner.html');
  const i2 = page.indexOf('<div class="card" id="earn-external">');
  const card = page.slice(i2, page.indexOf('</div>\n      </div>\n', i2));
  assert.ok(!/style="[^"]*color:#/i.test(card), 'the card paints a colour inline instead of using the theme');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/external-earnings\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
