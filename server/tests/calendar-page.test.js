/**
 * THE CALENDAR IS THE PAGE — run with:
 *   node server/tests/calendar-page.test.js   (also gated by `npm test`)
 *
 * The owner opened the month and found a title, a summary sentence and a card
 * edge above it: the grid began a third of the way down a phone screen, and
 * then only a stub of it fitted. A calendar is the one screen in this app that
 * is ALL content — there is nothing to introduce and nothing to filter — so he
 * asked for the whole page, and for a day to open big rather than as a panel
 * under a grid that now fills the screen.
 *
 * WHAT THIS PINS, and why each one is a thing that can quietly come back:
 *
 *   1. NOTHING ABOVE THE GRID but the month, its arrows and its two figures.
 *      Every other page in both apps opens with a heading block, so the
 *      heading is what gets added back by habit.
 *
 *   2. THE GRID TAKES THE REMAINING HEIGHT — and the weekday strip does NOT.
 *      `grid-auto-rows: 1fr` on its own would stretch the strip to a sixth of
 *      the screen, so the first row is named explicitly as `auto`. That pair
 *      is easy to "tidy" into one line and be wrong.
 *
 *   3. A DAY OPENS BECAUSE HE TAPPED IT. Both builders used to render the day
 *      panel on every redraw — today's, or whatever was last selected. That is
 *      harmless under a grid and wrong over one: paging from October to
 *      November would reopen a day he had just closed.
 *
 *   4. THE CELL STILL SAYS WHAT IT LEARNED TO SAY in the previous pass: the
 *      time, the destination as a code, and the day's count and takings.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { regionFrom, fnBlock, stripComments } = require('./_source.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const THEME = read('westmere-theme.css');
const OWNER_JS = stripComments(OWNER, { html: true });
const ADMIN_JS = stripComments(ADMIN, { html: true });

/* The page's own markup, bounded by the next page — never by a character
   count and never to end-of-file. */
const ownerPage = regionFrom(stripComments(OWNER, { html: true, blank: true }),
  'id="pg-calendar"', [/\n    <div class="pg"/]);
const adminPage = regionFrom(stripComments(ADMIN, { html: true, blank: true }),
  'id="view-calendar"', [/\n    <div class="view"/]);

// ── 1. NOTHING ABOVE THE GRID ─────────────────────────────────────────────

test('the owner calendar opens on the month, not on a heading', () => {
  const beforeGrid = ownerPage.slice(0, ownerPage.indexOf('id="cal-grid"'));
  assert.ok(beforeGrid.length > 50, 'the grid was not found inside the calendar page');
  for (const junk of ['sec-title', 'sec-sub', 'class="card"']) {
    assert.ok(!beforeGrid.includes(junk), 'the calendar page has ' + junk + ' above the grid again');
  }
  // The month and its arrows are the only things that may be there.
  assert.ok(/id="cal-month"/.test(beforeGrid), 'the month name is gone from the nav');
  assert.ok((beforeGrid.match(/calNav\(/g) || []).length === 2, 'the month needs exactly its two arrows');
});

test('the admin calendar does the same, and keeps the key BELOW the grid', () => {
  const i = adminPage.indexOf('id="adm-cal-grid"');
  assert.ok(i > 0, 'the admin grid was not found');
  const before = adminPage.slice(0, i);
  for (const junk of ['page-hd', 'page-title', 'class="card"']) {
    assert.ok(!before.includes(junk), 'the admin calendar has ' + junk + ' above the grid again');
  }
  assert.ok(adminPage.slice(i).includes('adm-cal-key'), 'the key must stay under the grid, where it is read');
});

test('the month\'s own figures are the only summary, and they sit in the nav', () => {
  for (const [who, page, id] of [['owner', ownerPage, 'cal-sub'], ['admin', adminPage, 'adm-cal-sub']]) {
    const i = page.indexOf('id="' + id + '"');
    assert.ok(i !== -1, who + ' lost the month summary entirely');
    assert.ok(i < page.indexOf(who === 'owner' ? 'id="cal-grid"' : 'id="adm-cal-grid"'),
      who + ': the summary is no longer above the grid');
    assert.ok(/cal-month-sub/.test(page.slice(Math.max(0, i - 120), i)),
      who + ': the summary is not set as the small line under the month name');
  }
});

// ── 2. THE GRID TAKES THE HEIGHT, THE WEEKDAY STRIP DOES NOT ──────────────

test('the calendar page is a column and the grid is what grows', () => {
  assert.ok(/\.pg\.pg-cal\.on\{[^}]*display:\s*flex/.test(THEME) &&
            /\.pg\.pg-cal\.on\{[^}]*flex-direction:\s*column/.test(THEME),
    'the owner calendar page is no longer a column, so nothing can fill it');
  const grid = regionFrom(THEME, '.pg-cal .cal-grid{', [/\n\.[a-z#]/]);
  assert.ok(/flex:\s*1/.test(grid), 'the owner grid does not take the remaining height');
  assert.ok(/grid-template-rows:\s*auto/.test(grid),
    'without an explicit auto first row the WEEKDAY STRIP stretches to a sixth of the screen');
  assert.ok(/grid-auto-rows:\s*minmax\(\s*\d+px\s*,\s*1fr\s*\)/.test(grid),
    'the day rows must share the height down to a floor, not be fixed and not be unbounded');
  const admGrid = regionFrom(THEME, '.view-cal .adm-cal-grid{', [/\n\.[a-z#]/]);
  assert.ok(/flex:\s*1/.test(admGrid) && /grid-template-rows:\s*auto/.test(admGrid) &&
            /grid-auto-rows:\s*minmax\(/.test(admGrid), 'the admin grid does not do the same');
});

test('the floor is the height a stacked chip and the day figures need', () => {
  const floor = /grid-auto-rows:\s*minmax\(\s*(\d+)px/.exec(regionFrom(THEME, '.pg-cal .cal-grid{', [/\n\.[a-z#]/]));
  assert.ok(floor, 'no floor');
  assert.ok(+floor[1] >= 90, 'a row shorter than 90px cannot hold two stacked chips and the footer');
});

// ── 3. A DAY OPENS BECAUSE HE TAPPED IT ───────────────────────────────────

test('the owner day pops out as a page, with a back control and Escape', () => {
  assert.ok(/id="cal-day-page"/.test(OWNER) && /id="cal-day-page-body"/.test(OWNER),
    'the day page markup is missing');
  assert.ok(/class="trip-page" id="cal-day-page"/.test(OWNER),
    'the day page must reuse .trip-page, or it gets none of that chrome\'s behaviour');
  assert.ok(/class="trip-back"[\s\S]{0,170}onclick="closeCalDay\(\)"/.test(OWNER), 'no back control');
  assert.ok(/function openCalDay\(/.test(OWNER_JS) && /function closeCalDay\(/.test(OWNER_JS), 'open/close missing');
  assert.ok(/e\.key==='Escape'[\s\S]{0,90}closeCalDay\(\)/.test(OWNER_JS), 'Escape must close the day page');
  const sel = fnBlock(OWNER_JS, 'selectCalDay');
  assert.ok(/openCalDay\(/.test(sel), 'tapping a day no longer opens it');
  assert.ok(/buildCalendar\(\)/.test(sel), 'the grid must still redraw, so the ring lands on the day he chose');
});

test('nothing opens on its own — neither builder renders a day panel', () => {
  const owner = fnBlock(OWNER_JS, 'buildCalendar');
  assert.ok(!/showCalDay\(/.test(owner),
    'buildCalendar reopens a day on every redraw — paging a month would reopen what he just closed');
  const admin = fnBlock(ADMIN_JS, 'buildAdminCalendar');
  assert.ok(!/admShowDay\(/.test(admin), 'buildAdminCalendar does the same');
  assert.ok(/admShowDay\(/.test(fnBlock(ADMIN_JS, 'admSelectDay')), 'a tap no longer fills the admin dialog');
  assert.ok(/openModal\('modal-cal-day'\)/.test(fnBlock(ADMIN_JS, 'admSelectDay')),
    'a tap no longer opens the admin dialog');
});

test('the admin dialog exists and can be closed', () => {
  assert.ok(/id="modal-cal-day"/.test(ADMIN), 'the admin day dialog is missing');
  assert.ok(/id="modal-cal-day"[\s\S]{0,700}closeModal\('modal-cal-day'\)/.test(ADMIN), 'no close control');
  assert.ok(/id="modal-cal-day"[\s\S]{0,700}id="adm-cal-detail"/.test(ADMIN),
    'the dialog must be where the day detail is written, or admShowDay writes into nothing');
  assert.ok(!/id="adm-cal-detail-card"/.test(ADMIN), 'the old card-below-the-grid is back as well');
});

test('the day page leads with the figures, not with the date it already shows', () => {
  const show = fnBlock(OWNER_JS, 'showCalDay');
  assert.ok(/getElementById\('cal-day-page-body'\)/.test(show), 'showCalDay still writes into the old panel');
  assert.ok(/cal-day-count/.test(show) && /cal-day-total/.test(show), 'the count and the takings are gone');
  const open = fnBlock(OWNER_JS, 'openCalDay');
  assert.ok(/calDayLabel\(key\)/.test(open), 'the page title is not the day');
});

test('the day label is built from the components, never parsed as an instant', () => {
  const fn = fnBlock(OWNER_JS, 'calDayLabel');
  assert.ok(/Date\.UTC\(/.test(fn), 'calDayLabel does not use Date.UTC');
  assert.ok(/getUTCDay\(\)/.test(fn), 'the weekday is read in local time, so it is wrong west of London');
  assert.ok(!/new Date\(key/.test(fn), 'the key is parsed as an instant again');
  // And the same in the admin.
  const adm = fnBlock(ADMIN_JS, 'admShowDay');
  assert.ok(/Date\.UTC\(/.test(adm) && /getUTCDay\(\)/.test(adm),
    'the admin day heading still reads its weekday in local time');
});

// ── 4. THE CELL KEEPS WHAT IT LEARNED ─────────────────────────────────────

test('a day cell says the time and the journey, town to town, and NOTHING else', () => {
  /* THE OWNER'S RULE, in his words: the time, and the route as pickup town →
     destination town. Not the premise, not the terminal, not the airport code
     — that was my fix for a width problem and he reversed it — and not the
     fare or the day's totals either. A month grid is where he reads the SHAPE
     of a week; everything else is one tap away in the day. */
  const build = fnBlock(OWNER_JS, 'buildCalendar');
  assert.ok(/class="cal-chip-t"/.test(build), 'the time line is gone from the chip');
  assert.ok((build.match(/class="cal-chip-w/g) || []).length >= 2,
    'the chip no longer carries BOTH towns');
  assert.ok(/_townAddr\(/.test(build), 'the cell is not reading town labels');
  assert.ok(!/_codeAddr\(/.test(build), 'the airport-code form is back in the cell');
  assert.ok(!/class="cal-sum"/.test(build), "the day's count and takings are back in the cell");
  assert.ok(!/cal-chip[^>]*>[^<]*£/.test(build) && !/chip-w">'\+escH\(fare/.test(build),
    'a fare is back in the cell');
  const adm = fnBlock(ADMIN_JS, 'buildAdminCalendar');
  assert.ok(/_admTownAddr\(/.test(adm), 'the admin cell is not reading town labels');
  assert.ok(!/adm-cal-mini-fare/.test(adm), 'the fare is back in the admin cell');
  assert.ok(!/class="adm-cal-fare"/.test(adm),
    'the month cell is borrowing the day-detail fare class again');
});

test('the abandoned airport-code scheme is gone, not left lying about', () => {
  // It was written for a width problem and the owner reversed the decision.
  // Left exported it is an invitation to put LGW S back in a cell.
  const WMAddr = require(path.join(ROOT, 'address-normalize.js'));
  assert.ok(!WMAddr.codeLabel, 'codeLabel is still exported, with nothing calling it');
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(!/codeLabel/.test(src), who + ' still references codeLabel');
  }
});

test('a town label is the TOWN — not the premise, the street or the county', () => {
  const WMAddr = require(path.join(ROOT, 'address-normalize.js'));
  const t = (s, n) => WMAddr.townLabel(s, n);
  assert.strictEqual(t('London Gatwick Airport, South Terminal'), 'Gatwick');
  assert.strictEqual(t('London Heathrow, Terminal 5, Longford TW6 2GA'), 'Heathrow');
  // The premise is not the town; the town is further in.
  assert.strictEqual(t('Weppons Farm, Chanctonbury Ring Road, Wiston BN44 3DN'), 'Wiston');
  // A street at the end is skipped, and a place named after its town keeps it.
  assert.strictEqual(t('Hove Town Hall, Norton Road'), 'Hove');
  assert.strictEqual(t('Lewes Station, Station Road, Lewes BN7 2UB'), 'Lewes');
  assert.strictEqual(t('Worthing Pier, Marine Parade, Worthing BN11 3PX'), 'Worthing');
  // A numbered detail at the end ("Dock Gate 4") is not a town either.
  assert.strictEqual(t('Southampton Cruise Terminal, Dock Gate 4'), 'Southampton');
  assert.strictEqual(t('Flat 2, 14 Queens Road, Brighton BN1 1AA'), 'Brighton');
  assert.strictEqual(t(''), '');
  assert.strictEqual(t(null), '');
});

test('A COUNTY WITH A POSTCODE STUCK TO IT IS STILL A COUNTY', () => {
  /* Geocoders write "West Sussex RH16 1EA" as one comma-token, which matches
     neither the county pattern nor the postcode one. It therefore survived the
     noise filter and won the "last token" race — the cell said "West Sussex"
     where the town was Haywards Heath. The postcode comes off FIRST now. */
  const WMAddr = require(path.join(ROOT, 'address-normalize.js'));
  assert.strictEqual(WMAddr.townLabel('14 Queens Road, Haywards Heath, West Sussex RH16 1EA', 20),
    'Haywards Heath');
  assert.strictEqual(WMAddr.townLabel('High Street, Billingshurst, Surrey GU1 1AA', 20), 'Billingshurst');
});

test('a long town is abbreviated to a word, never cut mid-word', () => {
  const WMAddr = require(path.join(ROOT, 'address-normalize.js'));
  // Over the budget it drops to the first word...
  assert.strictEqual(WMAddr.townLabel('14 Queens Road, Haywards Heath, West Sussex RH16 1EA', 8),
    'Haywards');
  // ...including across a hyphen, which a space-splitter would miss.
  assert.strictEqual(WMAddr.townLabel('Shoreham-by-Sea, Brunswick Road BN43 5WB', 8), 'Shoreham');
  // ...and a long single word comes back WHOLE rather than sliced: a cell's
  // own ellipsis is a label that ran out of room; "Hurstpierp" is a typo.
  const long = WMAddr.townLabel('Hurstpierpoint, High Street BN6 9RG', 8);
  assert.strictEqual(long, 'Hurstpierpoint');
  assert.ok(!/^Hurstpier.$/.test(long), 'the label was cut mid-word');
});

test('the cell is budgeted at the width that was measured, not a round number', () => {
  // 52px cell − 4 padding − 2 rule − 3 indent = 43px of type, which is eight
  // characters at this size. If the padding grows, the budget has to shrink.
  const build = fnBlock(OWNER_JS, 'buildCalendar');
  assert.ok(/_townAddr\([^)]*,\s*8\)/.test(build), 'the eight-character budget is gone');
  const chip = regionFrom(THEME, '.cal-chip{', [/\n\.[a-z#]/]);
  assert.ok(/padding:\s*1px 0 1px 3px/.test(chip), 'the chip indent changed without the budget changing');
  assert.ok(/border-left:\s*2px/.test(chip), 'the gold rule changed width without the budget changing');
});

test('nothing on the destination line competes with the place name', () => {
  /* An arrow costs seven or eight of the forty-three pixels the town needs,
     however it is drawn — as a character, a ::before, or an absolute mark. The
     journey reads DOWN the cell instead, and the explicit route is in the
     tooltip. */
  const toRule = regionFrom(THEME, '.cal-chip-w.to{', [/\n\.[a-z#]/]);
  assert.ok(!/content:/.test(toRule), 'an arrow is back on the destination line');
  const build = fnBlock(OWNER_JS, 'buildCalendar');
  assert.ok(!/chip-w to">\\u2192|chip-w to">→/.test(build), 'an arrow is back in the destination text');
  assert.ok(/title="'\+escH\(full\)/.test(build), 'the full route is no longer in the tooltip');
});

// ── NEGATIVE ──────────────────────────────────────────────────────────────

test('NEGATIVE: the "nothing above the grid" check can actually fail', () => {
  const bad = '<div class="pg pg-cal" id="pg-calendar"><div class="sec-title">Calendar</div><div id="cal-grid"></div>';
  const before = bad.slice(0, bad.indexOf('id="cal-grid"'));
  assert.ok(before.includes('sec-title'), 'the check would not notice a heading coming back');
});

test('NEGATIVE: a stretched weekday strip would be caught', () => {
  const tidy = '.pg-cal .cal-grid{ flex: 1; grid-auto-rows: minmax(94px, 1fr); }';
  assert.ok(!/grid-template-rows:\s*auto/.test(tidy),
    'the check cannot tell the tidied-but-wrong version from the right one');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/calendar-page\.test\.js/.test(read('package.json')),
    'calendar-page.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
