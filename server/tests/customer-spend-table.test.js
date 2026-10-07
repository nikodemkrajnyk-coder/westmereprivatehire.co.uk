/**
 * CUSTOMER SPEND, AS A SPREADSHEET — run with:
 *   node server/tests/customer-spend-table.test.js   (also gated by `npm test`)
 *
 * The owner said the Customer Spend tab "isn't well organised". What he was
 * looking at was unstyled HTML: .sp-totals, .sp-table, .sp-bar-row and the rest
 * were written by the app and dressed by NOTHING — no rule anywhere in the
 * theme mentioned them — so the browser's defaults drew the whole report, and
 * the table had no declared column widths, so every column was sized by its
 * longest cell and the figures stopped lining up down the page. Which is the
 * one thing a spend report is for.
 *
 * WHY IT SURVIVED FOUR DESIGN PASSES is worth pinning as hard as the fix. The
 * guard that checks this sort of thing looks for selectors the THEME dresses
 * and no app writes — a rule with nothing to style. The opposite case, a class
 * the app writes and the theme has never heard of, looked like every utility
 * class in the system and so looked like nothing at all. The last test in this
 * file is that one, for this page.
 *
 * The table itself is now the shared spreadsheet — the same module Trip History
 * and the journeys list are drawn from — so the three cannot drift about what a
 * row says or what a column is worth.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock, regionFrom } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const C = require('../../wm-compact');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const CSS = read('westmere-theme.css');

// ── 1. IT IS A TABLE, AND THE COLUMNS ARE DECLARED ────────────────────────
console.log('\nAligned columns, not ragged ones');

test('both lists are built from the shared spreadsheet, not by hand', () => {
  assert.ok(/WMCompact\.spendTable\(/.test(strip(ADMIN)),
    'the admin spend report is not the shared table');
  assert.ok(/WMCompact\.customerTable\(/.test(strip(OWNER)),
    "the owner's customer list is not the shared table");
  /* And the hand-written one is gone, with the <tr> strings that went with it. */
  assert.ok(!/<th>Total paid<\/th>/.test(ADMIN), 'the hand-written spend table is still there');
  assert.ok(!/<tr><td class="sp-empty"/.test(ADMIN), 'its loading state is still a table row');
  /* Matched as whole class names: "disp-money" is a different thing and
     contains "sp-money", which an unanchored search reads as a survivor. */
  for (const cls of ['sp-rank', 'sp-money', 'sp-quoted']) {
    assert.ok(!new RegExp('class="[^"]*\\b' + cls + '\\b').test(ADMIN),
      'a class from the hand-written table survives, dressed by nothing: ' + cls);
  }
});

test('every column has a fixed width, and they add to 100', () => {
  for (const [what, cols] of [['spend', C.SPEND_COLUMNS], ['customers', C.CUSTOMER_COLUMNS]]) {
    const sum = cols.reduce((s, c) => {
      assert.ok(/^\d+(\.\d+)?%$/.test(c.w), what + ': ' + c.key + ' has no fixed width (' + c.w + ')');
      assert.ok(c.label, what + ': ' + c.key + ' has no heading');
      return s + parseFloat(c.w);
    }, 0);
    assert.ok(Math.abs(sum - 100) < 0.02,
      what + ' columns add to ' + sum + '% — anything over 100 is a column off the right edge');
  }
});

test('the money columns are right-aligned and tabular — that is what makes them comparable', () => {
  for (const key of ['trips', 'spent']) {
    assert.ok(C.SPEND_COLUMNS.find((c) => c.key === key).num, 'spend: ' + key + ' is not a number column');
    assert.ok(C.CUSTOMER_COLUMNS.find((c) => c.key === key).num, 'customers: ' + key + ' is not a number column');
  }
  for (const key of ['avg', 'quoted']) {
    assert.ok(C.SPEND_COLUMNS.find((c) => c.key === key).num, 'spend: ' + key + ' is not a number column');
  }
  assert.ok(/\.wm-ctab-h\.num, \.wm-ctab-c\.num\{ text-align: right; font-variant-numeric: tabular-nums; \}/.test(CSS),
    'the number columns are not right-aligned in tabular figures');
  assert.ok(/white-space: nowrap;/.test(CSS.slice(CSS.indexOf('.wm-ctab{'), CSS.indexOf('.wm-ctab-h{'))),
    'the spreadsheet wraps — a row that wraps is two rows and the eye loses the column');
  assert.ok(/table-layout: fixed;/.test(CSS), 'the columns are sized by their content again');
});

test('the owner asked for these columns and they are all there', () => {
  const spend = C.SPEND_COLUMNS.map((c) => c.key);
  for (const k of ['name', 'trips', 'spent', 'lastTrip']) {
    assert.ok(spend.indexOf(k) !== -1, 'the spend report has no ' + k + ' column');
    assert.ok(C.CUSTOMER_COLUMNS.map((c) => c.key).indexOf(k) !== -1,
      'the phone list has no ' + k + ' column');
  }
});

test('ONE ROW PER CUSTOMER, and the figures come out of the row it was given', () => {
  const html = C.spendTable([
    { name: 'Ben Chan', email: 'ben@example.com', trips: 7, totalSpent: 812.5, avgPerTrip: 116.07, quotedUnpaid: 95, lastTrip: '2026-10-05' },
    { name: 'Mrs Hall', email: 'hall@example.com', trips: 4, totalSpent: 380, avgPerTrip: 95, quotedUnpaid: 0, lastTrip: '2026-09-28' }
  ]);
  const rows = html.match(/<tr class="wm-ctab-r[^"]*"/g) || [];
  assert.strictEqual(rows.length, 2, 'two customers did not make two rows');
  const cells = [...html.matchAll(/<td class="wm-ctab-c[^"]*">([^<]*)<\/td>/g)].map((m) => m[1]);
  assert.ok(cells.includes('Ben Chan') && cells.includes('£812.50') && cells.includes('7'),
    'the first row does not carry what it was given: ' + cells.slice(0, 10).join(' | '));
  assert.ok(cells.includes('1') && cells.includes('2'), 'the rows are not ranked');
  /* An absence reads as an absence, not as nought. */
  assert.ok(cells.includes('—'), 'a customer with nothing quoted shows £0.00 rather than a dash');
});

test('the two screens cannot quote different figures for the same person', () => {
  /* The spend report spells its fields one way and the saved directory another.
     One reader, so a customer worth £380 is £380 on both. */
  const fromReport = C.spendCells({ name: 'Mrs Hall', trips: 4, totalSpent: 380, lastTrip: '2026-09-28' });
  const fromList   = C.spendCells({ id: 3, name: 'Mrs Hall', booking_count: 4, total_spent: 380, last_booking: '2026-09-28' });
  for (const k of ['name', 'trips', 'spent', 'lastTrip']) {
    assert.strictEqual(fromReport[k], fromList[k], k + ' differs between the two screens');
  }
});

// ── 2. THE ROWS THAT GO SOMEWHERE, AND THE ONES THAT DO NOT ───────────────
console.log('\nA report row is not a button');

test('the phone list opens a customer; the desktop report does not pretend to', () => {
  const list = C.customerTable([{ id: 3, name: 'Mrs Hall', booking_count: 4, total_spent: 380 }], 'custOpenDetail');
  /* The id is escaped twice over — JSON for the JavaScript string, then HTML
     for the attribute it sits in — which is what stops a quote in an id from
     ending the attribute early. */
  assert.ok(/onclick="custOpenDetail\(&quot;3&quot;\)"/.test(list),
    'the row does not open the customer: ' + (/onclick="[^"]*"/.exec(list) || ['none'])[0]);
  assert.ok(/tabindex="0" role="button"/.test(list), 'the row is not reachable by keyboard');
  assert.ok(/wm-ctab-chev/.test(list), 'the row has no chevron to say it opens');

  const report = C.spendTable([{ name: 'Mrs Hall', trips: 4, totalSpent: 380 }]);
  assert.ok(!/onclick=/.test(report), 'a spend row is dressed as a button with nowhere to go');
  assert.ok(!/tabindex="0"/.test(report), 'a report row is a tab stop that does nothing');
  assert.ok(!/wm-ctab-chev/.test(report), 'a report row shows a chevron it cannot honour');
  assert.ok(/is-report/.test(report), 'the report rows are not marked as such');
  assert.ok(/\.wm-ctab-r\.is-report\{ cursor: default; \}/.test(CSS),
    'the pointer still promises a report row can be opened');
});

// ── 3. IT IS DRESSED AT ALL ───────────────────────────────────────────────
console.log('\nAnd the page around it has a design');

test('every class the spend page writes is one the theme dresses', () => {
  /* THE BUG THIS FILE IS REALLY ABOUT. design-consistency catches a selector
     the theme dresses and no app writes. This is the mirror: a class the app
     writes that nothing has ever styled — which is how a whole page shipped
     with no design on it at all and survived four passes over everything else. */
  const i = ADMIN.indexOf('<div class="view" id="view-spend">');
  const j = ADMIN.indexOf('<div class="view" id="view-analytics">', i);
  assert.ok(i !== -1 && j > i, 'the spend view could not be bounded');
  const view = ADMIN.slice(i, j);
  const written = new Set();
  for (const m of view.matchAll(/class="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (/^sp-/.test(cls)) written.add(cls);
  }
  /* …and the ones the renderer writes, which are not in the markup. */
  for (const m of fnBlock(strip(ADMIN), 'loadSpend').matchAll(/class="(sp-[a-z-]+)"/g)) written.add(m[1]);
  assert.ok(written.size >= 8, 'only ' + written.size + ' sp- classes found — is this still the spend page?');
  const undressed = [...written].filter((c) => CSS.indexOf('.' + c) === -1);
  assert.deepStrictEqual(undressed, [],
    'the spend page writes classes nothing styles — the browser draws them: ' + undressed.join(', '));
});

test('§37 takes its colours from the tokens, and nothing fills to highlight', () => {
  assert.ok(CSS.indexOf('§37 · CUSTOMER SPEND') !== -1, 'the theme has no section for the spend page');
  /* BOUNDED BY THE NEXT SECTION, not by the end of the file. Written the lazy
     way this read §38 as well the moment one existed, and failed on a rule that
     was never §37's. The project has a helper for exactly this. */
  const sec = regionFrom(CSS, '§37 · CUSTOMER SPEND', [/══ §\d+ ·/]);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(sec), 'a colour is typed into §37 rather than taken from a token');
  assert.ok(/var\(--westmere-gold-ink\)/.test(sec), 'the labels do not use the readable gold');
  /* The chart is the one thing here that paints an area, and it does it with
     §33's navy ramp — one colour at two strengths, because the eye is reading a
     SIZE. Nothing else may fill. */
  const fills = [...sec.matchAll(/background:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const f of fills) {
    assert.ok(/var\(--wm-ramp-|var\(--westmere-white\)/.test(f),
      '§37 fills with something that is not the chart ramp or the paper: ' + f);
  }
});

test('the spend report fits a desktop, and slides rather than squashing on a phone', () => {
  const sec = regionFrom(CSS, '§37 · CUSTOMER SPEND', [/══ §\d+ ·/]);
  assert.ok(/\.wm-ctab-spend\{ min-width: \d+rem; \}/.test(sec),
    'eight columns would be crushed into 390px instead of sliding');
  const i2 = ADMIN.indexOf('<div class="view" id="view-spend">');
  const view = ADMIN.slice(i2, ADMIN.indexOf('<div class="view" id="view-analytics">', i2));
  assert.ok(!/overflow-x:auto/.test(view),
    'a second sideways scroller inside the page — the table brings its own');
  assert.ok(!/<table/.test(view), 'a hand-written table is back in the spend view');
});

test('the phone list keeps the column the row is about', () => {
  /* §28 collapses the FIRST column on a phone, because on a history that
     column is the reference and the drop-off needs the room. On the saved
     customers list the first column is the NAME — collapsing it leaves twelve
     rows of figures with nothing to say whose they are, which is what the first
     render of this showed. The rule is named by table kind now. */
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 480px)'));
  assert.ok(!/^\s*\.wm-ctab col:first-child/m.test(phone),
    'the first column is collapsed on every table, the customers list included');
  assert.ok(!/\.wm-ctab-customers col:first-child\{ width: 0/.test(phone),
    "the customer's name is collapsed to nothing on a phone");
  assert.ok(/\.wm-ctab-customers col:nth-child\(1\)\{ width: 4\d% !important; \}/.test(phone),
    'the name column has no stated width on a phone');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/customer-spend-table\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
