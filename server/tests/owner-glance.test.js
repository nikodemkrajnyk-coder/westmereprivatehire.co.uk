/**
 * At-a-glance trip fields — run with:
 *   node server/tests/owner-glance.test.js   (also gated by `npm test`)
 *
 * WHAT THIS PROTECTS
 *   The owner reads his job list from a phone in a cradle while driving. Three
 *   fields carry that glance — DATE, TIME, FARE — and they were the smallest
 *   and faintest text on the card. They now render in their own row, two tiers
 *   up the type scale, in full-strength navy.
 *
 *   That is easy to undo by accident: someone tidies the card, folds the row
 *   back into the meta line, and the fields silently shrink to 13px grey again.
 *   Nobody notices in an office; the owner notices at 5am on the A23. So this
 *   pins BOTH halves of the change:
 *
 *     (a) the markup — all three fields are emitted with the glance classes,
 *         in every surface that shows a trip card;
 *     (b) the size — those classes resolve to a LARGE tier of the type scale,
 *         from a token, and that tier is genuinely bigger than card body text.
 *
 *   It also pins that the sizes are not hardcoded, because the whole reason
 *   this was cheap to do is that the type scale exists (see DESIGN.md).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

const THEME = read('westmere-theme.css');
const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');

// The glance rule block, comments stripped so a comment can never satisfy an
// assertion about the CSS itself.
const CSS = THEME.replace(/\/\*[\s\S]*?\*\//g, '');
const GLANCE = CSS.slice(CSS.indexOf('.wm-glance'));

// rem → number, for comparing tiers of the scale.
function tier(name) {
  const m = THEME.match(new RegExp('\\' + name + ':\\s*([0-9.]+)rem'));
  assert.ok(m, 'the type scale has no ' + name);
  return parseFloat(m[1]);
}

console.log('\nAt a glance — date, time and fare on a trip card');

// ── (b) The size is large, and it comes from the scale ───────────────────
test('the glance fields are styled from ONE rule, so they cannot drift apart', () => {
  const sel = GLANCE.match(/\.wm-glance-date,\s*\n\s*\.wm-glance-time,\s*\n\s*\.wm-glance-fare\s*\{([\s\S]*?)\}/);
  assert.ok(sel, 'date, time and fare must share one declaration block — three separate rules is how one of them gets left behind');
});

test('the glance size is a TOKEN, not a hardcoded number', () => {
  const block = GLANCE.match(/\.wm-glance-date,[\s\S]*?\}/)[0];
  const fs_ = block.match(/font-size:\s*([^;]+);/);
  assert.ok(fs_, 'the glance fields declare no font-size at all');
  assert.ok(/var\(--text-/.test(fs_[1]),
    'the glance size is hardcoded as "' + fs_[1].trim() + '" — it must come off the type scale, ' +
    'or re-tuning it means hunting through markup instead of editing one token');
  assert.ok(/var\(--text-[a-z0-9]+,\s*[0-9.]+rem\)/.test(fs_[1]),
    'the token reference has no literal fallback — a var() that resolves to nothing drops the whole declaration');
});

test('the tier used is a LARGE one — bigger than the card body text', () => {
  const used = GLANCE.match(/\.wm-glance-date,[\s\S]*?font-size:\s*var\((--text-[a-z0-9]+)/)[1];
  const size = tier(used);
  // The card's own body copy sits at .84–.98rem. The glance must clear it by a
  // real margin, not by a rounding error: this is a driver at arm's length.
  assert.ok(size >= 1.4,
    'the glance renders at ' + used + ' = ' + size + 'rem — too small to read at a glance ' +
    '(the card body is already ~0.9rem). Use a tier of at least 1.4rem.');
  assert.ok(size >= tier('--text-base') * 1.5,
    'the glance (' + size + 'rem) is less than 1.5× the base text (' + tier('--text-base') + 'rem) — it will not stand out');
  // And the scale itself must stay ordered, or "larger tier" means nothing.
  assert.ok(tier('--text-xl') > tier('--text-lg') && tier('--text-lg') > tier('--text-base'),
    'the type scale is no longer monotonic — --text-lg/--text-xl must be larger than --text-base');
});

test('the glance is navy on white at a readable weight', () => {
  const block = GLANCE.match(/\.wm-glance-date,[\s\S]*?\}/)[0];
  assert.ok(/color:\s*var\(--westmere-navy/.test(block), 'the glance must use the theme navy, not a literal');
  // §15.2 paints every descendant of #scr-app with -webkit-text-fill-color and
  // !important. Without matching it here, Safari renders the fill colour and
  // ignores `color` — the exact class of bug that hid the pickers twice.
  assert.ok(/-webkit-text-fill-color:\s*var\(--westmere-navy/.test(block),
    'the glance sets color but not -webkit-text-fill-color — Safari will use the blanket fill from §15.2 instead');
  const w = block.match(/font-weight:\s*([^;]+);/);
  assert.ok(w && /var\(--weight-(semi|bold)/.test(w[1]),
    'the glance must be semibold or heavier — Cormorant at regular weight is faint at speed');
});

test('the row wraps rather than shrinking its fields', () => {
  const row = GLANCE.match(/\.wm-glance\s*\{[\s\S]*?\}/)[0];
  assert.ok(/flex-wrap:\s*wrap/.test(row),
    'on a narrow phone the row must wrap; anything that shrinks the type undoes the change');
});

// ── (a) Every trip surface emits the glance ──────────────────────────────
const CLASSES = ['wm-glance-date', 'wm-glance-time', 'wm-glance-fare'];

// The owner's single card renderer. Everything else delegates to it.
const CARD = OWNER.slice(OWNER.indexOf('function jobCardHtml(j){'));
const CARD_BODY = CARD.slice(0, CARD.indexOf('\n}\n'));

// The two list renderers, each sliced to its OWN body — a slice that runs to
// the next function definition would match calls belonging to whatever sits in
// between, and quietly pass.
const LIST_FN = (() => {
  const s = OWNER.slice(OWNER.indexOf('function renderJobList'));
  return s.slice(0, s.indexOf('\n}\n'));
})();
const WEEK_FN = (() => {
  const s = OWNER.slice(OWNER.indexOf('function buildConfirmed'));
  return s.slice(0, s.indexOf('\n}\n'));
})();

test('the owner trip card emits all three glance fields', () => {
  for (const c of CLASSES) {
    assert.ok(CARD_BODY.includes(c), 'jobCardHtml no longer renders .' + c);
  }
  // The values, not just the classes — an empty span passes a class check.
  assert.ok(/wm-glance-date[^]{0,80}_fmtUpcomingDate\(j\.date\)/.test(CARD_BODY), 'the glance date is not fed from j.date');
  assert.ok(/wm-glance-time[^]{0,80}j\.time/.test(CARD_BODY), 'the glance time is not fed from j.time');
  assert.ok(/wm-glance-fare[^]{0,90}j\.fare/.test(CARD_BODY), 'the glance fare is not fed from j.fare');
});

test('the glance carries no inline font-size that would outrank the token', () => {
  const start = CARD_BODY.indexOf('class="wm-glance"');
  const end = CARD_BODY.indexOf("'</div>'", CARD_BODY.indexOf('wm-glance-fare'));
  const row = CARD_BODY.slice(start, end);
  assert.ok(!/font-size/.test(row),
    'the owner card sets an inline font-size on the glance row — an inline style beats the stylesheet, ' +
    'so the token would stop being the dial');
});

test('date, time and fare are no longer left in the small meta line', () => {
  // The old third line rendered them at .84rem in 40% ink. If they reappear
  // there, the big row is duplicating rather than replacing.
  const small = CARD_BODY.match(/font-size:\.84rem;color:rgba\(27,27,26,\.4\)">([\s\S]*?)<\/div>'/);
  assert.ok(small, 'the card meta line has moved — re-point this assertion at it');
  assert.ok(!/j\.time|j\.fare/.test(small[1]),
    'time or fare is still being rendered in the small grey meta line: ' + small[1].trim().slice(0, 120));
});

test('BOTH owner trip lists and the trip page render through that one card', () => {
  // To Confirm (flat list, with date separators), Confirmed (weekly schedule),
  // and the full-screen trip page. All three call jobCardHtml, so all three
  // get the glance — that is why this change is three lines and not thirty.
  // Scoped to each function's OWN body: sliced to the next definition, these
  // would match a jobCardHtml call belonging to some other function in between.
  assert.ok(/jobCardHtml/.test(LIST_FN), 'the flat trip list (To Confirm) no longer renders jobCardHtml');
  assert.ok(/jobCardHtml/.test(WEEK_FN), 'the Confirmed weekly schedule no longer renders jobCardHtml');

  const tripPage = OWNER.slice(OWNER.indexOf('function openTripPage'), OWNER.indexOf('function jobCardHtml'));
  assert.ok(/jobCardHtml\(j\)/.test(tripPage),
    'the full-screen trip page no longer renders jobCardHtml — it would need its own copy of the glance');
});

// ── The date is printed ONCE per trip ────────────────────────────────────
// Once every card carried its own date, the day separators above them were
// printing the same date twice, a line apart. They are gone. What follows
// stops them coming back the next time someone "adds grouping".

test('the flat trip list prints no day separator above the cards', () => {
  assert.ok(!/_fmtUpcomingDate/.test(LIST_FN),
    'renderJobList is formatting a date again — the card already shows it large in the glance row, ' +
    'so a separator prints the same date twice, one line apart');
  assert.ok(!/dateSep|lastDate/.test(LIST_FN),
    'renderJobList has a day-separator variable again');
  assert.ok(/allItems\.map\(jobCardHtml\)/.test(LIST_FN),
    're-point this assertion: the flat list no longer maps straight to jobCardHtml');
});

test('the Confirmed week labels ONLY the days that have no card to label them', () => {
  // The Mon→Sun scaffold has to survive: an empty day still needs its name, or
  // the owner cannot see which day the gap is. A day WITH jobs must not.
  assert.ok(/_fmtDayHeader\(day\)/.test(WEEK_FN), 'the weekly view no longer labels its empty days — the gaps become unreadable');
  const header = WEEK_FN.indexOf('_fmtDayHeader(day)');
  const cards = WEEK_FN.indexOf('dayItems.map(jobCardHtml)');
  assert.ok(cards !== -1, 'the weekly view no longer renders jobCardHtml');
  assert.ok(header > cards,
    'the weekly view prints the day header BEFORE its cards again — that repeats the date the ' +
    'glance row already shows. The header belongs in the empty-day branch only.');
  // And it must be in the branch, not merely later in the function.
  const branch = WEEK_FN.slice(WEEK_FN.indexOf('dayItems.length'));
  const empty = branch.slice(branch.indexOf(': '));
  assert.ok(/_fmtDayHeader\(day\)/.test(empty) && /No jobs/.test(empty),
    'the day label must sit in the "No jobs" branch, alongside the thing it is labelling');
});

test('every remaining group header is a WEEK, not a day', () => {
  // Completed and Cancelled group by ISO week with a count and takings. That is
  // information no card carries, so those headers stay — but if one of them
  // ever starts printing a single day's date, it is a duplicate again.
  for (const fn of ['function buildCompleted', 'function buildAdmCompleted']) {
    const src = (fn.includes('Adm') ? ADMIN : OWNER);
    const s = src.slice(src.indexOf(fn));
    const body = s.slice(0, s.indexOf('\n}\n'));
    if (!body) continue;
    assert.ok(!/_fmtUpcomingDate|_fmtDayHeader|_admGlanceDate/.test(body),
      fn + ' prints a per-day date above its rows — the rows already show it in the glance');
    assert.ok(/groupByWeek/.test(body), fn + ' is no longer grouping by week');
  }
});

// ── The CALENDAR views use the same row ─────────────────────────────────
// The owner reads his day from the Calendar tab as often as from the trip
// list. A glance that only exists on one of them means he has to read two
// different layouts for the same job.
test('the owner calendar shows the glance on jobs AND on calendar events', () => {
  const day = OWNER.slice(OWNER.indexOf('function showCalDay'));
  const dayBody = day.slice(0, day.indexOf('\n}\n'));
  const card = OWNER.slice(OWNER.indexOf('function jobDetailCard'));
  const cardBody = card.slice(0, card.indexOf('\n}\n'));

  for (const c of ['wm-glance-date', 'wm-glance-time']) {
    assert.ok(cardBody.includes(c), "the owner calendar's job entry no longer renders ." + c);
    assert.ok(dayBody.includes(c), "the owner calendar's Google Calendar event no longer renders ." + c);
  }
  assert.ok(/wm-glance-fare[^]{0,90}j\.fare/.test(cardBody), "the calendar job entry's glance fare is not fed from j.fare");
  // A calendar EVENT has no fare. An em-dash there would read as an unpriced
  // job rather than as "not a job", so the fare span must be absent.
  const evRow = dayBody.slice(dayBody.indexOf('wm-glance'), dayBody.indexOf('ev.title'));
  assert.ok(!/wm-glance-fare/.test(evRow),
    'a Google Calendar event is rendering a fare slot — an event has no fare');

  // And the time it shows must be the real one, not a hardcoded placeholder.
  assert.ok(/wm-glance-time[^]{0,80}j\.time/.test(cardBody), 'the calendar job glance time is not fed from j.time');
  assert.ok(/wm-glance-time[^]{0,80}\bwhen\b/.test(evRow), "the calendar event glance time is not fed from the event's own time");
});

test('the admin calendar shows the same glance, and only one fare', () => {
  const d = ADMIN.slice(ADMIN.indexOf('function admShowDay'));
  const body = d.slice(0, d.indexOf('\n}\n'));
  for (const c of CLASSES) {
    assert.ok(body.includes(c), 'the admin calendar entry no longer renders .' + c);
  }
  assert.ok(/wm-glance-date[^]{0,90}_admGlanceDate/.test(body), 'the admin calendar glance date is not formatted from the booking date');
  // The fare moved INTO the glance. The old cell at the end of the row has to
  // go with it, or every entry prints its fare twice.
  assert.ok(!/adm-cal-fare/.test(body),
    'the admin calendar still renders the old .adm-cal-fare cell — the fare now lives in the glance, so it would print twice');
  // The glance is --text-xl and cannot share a 54px column.
  assert.ok(/adm-cal-glance/.test(body) && /\.adm-cal-glance\{[^}]*flex:0 0 100%/.test(ADMIN),
    'the admin glance must take its own full-width line; the old time column was sized for 1rem type');
  assert.ok(/\.adm-cal-detail-job\{[^}]*flex-wrap:wrap/.test(ADMIN),
    'the admin calendar entry row must wrap, or the full-width glance forces the rest off the row');
});

test('the admin job row shows the same glance, for parity', () => {
  const row = ADMIN.slice(ADMIN.indexOf('function admJobRow(b){'));
  const body = row.slice(0, row.indexOf('\n}\n'));
  for (const c of CLASSES) {
    assert.ok(body.includes(c), 'admJobRow no longer renders .' + c + ' — the two staff apps have drifted');
  }
  assert.ok(/wm-glance-date[^]{0,90}_admGlanceDate\(b\.date\)/.test(body), 'the admin glance date is not fed from b.date');
  assert.ok(/wm-glance-time[^]{0,80}b\.time/.test(body), 'the admin glance time is not fed from b.time');
  assert.ok(/wm-glance-fare[^]{0,90}b\.fare/.test(body), 'the admin glance fare is not fed from b.fare');
});

test('both apps load the theme, or the glance has no sizes at all', () => {
  for (const [name, src] of [['westmere-owner.html', OWNER], ['westmere-admin.html', ADMIN]]) {
    assert.ok(/<link[^>]+href="\/westmere-theme\.css"/.test(src),
      name + ' does not load /westmere-theme.css — the glance classes would be unstyled');
  }
});

// ── The admin date helper obeys the wall-clock rule ──────────────────────
test('the admin glance date is built from literal components, not parsed', () => {
  const fn = ADMIN.slice(ADMIN.indexOf('function _admGlanceDate'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/new Date\(\s*(dateStr|String\(dateStr\))/.test(body),
    "_admGlanceDate parses the date string as an instant — new Date('2026-08-25') is UTC midnight " +
    'and renders as the 24th anywhere west of UTC');
  assert.ok(/parseInt\(p\[0\]/.test(body) && /parseInt\(p\[1\]/.test(body),
    '_admGlanceDate must build the date from its YYYY-MM-DD components');
  assert.ok(/sv-SE[\s\S]{0,60}Europe\/London/.test(body),
    "'Today' must be the UK calendar day — toISOString() is still yesterday between 00:00 and 01:00 BST");
});

// It has to actually produce the right label, not merely look right.
test('_admGlanceDate returns the correct weekday for a known date', () => {
  const fn = ADMIN.slice(ADMIN.indexOf('var _ADM_DAYS'));
  const src = fn.slice(0, fn.indexOf('\n}\n') + 2);
  const run = new Function(src + '\nreturn _admGlanceDate;')();
  assert.strictEqual(run('2026-08-25'), 'Tue 25 Aug');      // a Tuesday
  assert.strictEqual(run('2026-01-01'), 'Thu 1 Jan');       // month index, not off by one
  assert.strictEqual(run(''), '—');                          // no date is a dash, not "Invalid Date"
  assert.strictEqual(run('ASAP'), 'ASAP');                   // junk passes through untouched
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
