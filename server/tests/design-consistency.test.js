/**
 * THE DESIGN REACHES EVERY SCREEN — run with:
 *   node server/tests/design-consistency.test.js   (also gated by `npm test`)
 *
 * THE OWNER'S COMPLAINT, which is what this guards: the blue/gold/white pass
 * reached the screens it was built for — drivers, operators, invoices, people
 * — and stopped there. Everything else was still on the old plain look, and he
 * called it blunt. The reason matters, because it decides what a guard can
 * usefully assert: the redesign was applied component by component, while most
 * screens are drawn by JS builders that write their own inline styles. A
 * stylesheet rule cannot reach an inline background, and an inline background
 * outranks the stylesheet anyway. So the treatment went onto the STRUCTURE
 * both apps already share (§30), onto the job card (§31) and onto the two
 * month grids (§32), and the builders' inline styles came out.
 *
 * WHAT THIS CATCHES, in the order the mistakes actually happened:
 *
 *   1. A SELECTOR THAT NAMES NOTHING. §30 first shipped dressing `.cal-head`
 *      and `.cal-dnum`. Neither app has ever written either class — the owner
 *      app's are `.cal-hd` and `.cal-num` — so the calendar was the one screen
 *      §30 never touched, which is exactly how it came back from the owner
 *      still looking like the old app. The stylesheet parsed, the suite was
 *      green, and the rule was addressed to nobody. Three more (.cal-dots,
 *      .cal-job-count, .cal-summary) were dressed in §32 while the owner app
 *      carries rules for them and emits none. So: every class named in these
 *      sections must be one some shipped file actually writes.
 *
 *   2. A BUILDER STILL FILLING. The month cells highlighted a day that had
 *      jobs with a grey wash and drew each job as a grey-blue filled pill,
 *      both from inline styles — against the owner's standing rule that
 *      nothing highlights by filling (§20, guarded in no-fills.test.js, which
 *      does not read calendar cells).
 *
 *   3. A COLOUR WRITTEN OUT BY HAND. The admin's personal-event lines carried
 *      `#102a43` twice, which is the navy token's value typed in.
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

const THEME = read('westmere-theme.css');

/* A §N..§M slice of the stylesheet, as RULES — no prose.
   The marker is inside the section's own banner comment, so the slice opens
   mid-comment and `stripComments` cannot see the `/*` that started it; the
   banner's text would survive and be read as selectors (that is how `.js` in
   "design-consistency.test.js" turned up in the class list). Drop everything
   up to the banner's own close first. */
function section(marker, stops) {
  const raw = regionFrom(THEME, marker, stops);
  const close = raw.indexOf('*/');
  assert.ok(close !== -1, marker + ': section has no banner comment to close');
  return stripComments(raw.slice(close + 2));
}
const SECTION_HEAD = [/\n   §\d+ {1,2}[A-Z]/, /\n   \d+\. [A-Z]/];

const S30 = section('§30  THE HOUSE TREATMENT', SECTION_HEAD);
const S31 = section('§31  A JOB IS A CARD', SECTION_HEAD);
const S32 = section('§32  THE CALENDARS', SECTION_HEAD);
const S33 = section('§33  THE FIGURES', SECTION_HEAD);
const S34 = section('§34  THE ADMIN\'S OWN FOUR SCREENS', SECTION_HEAD);
const DESIGN_PASS = S30 + S31 + S32 + S33 + S34;

/* The selector side of a rule block, with declarations removed. */
const selectorsOf = (css) => css.replace(/\{[^}]*\}/g, '\n');

/* Everything that ships markup or writes markup from JS. A class is "real" if
   one of these writes it as a whole word inside quotes or whitespace — which
   is what `class="x"`, `class="a x"` and `cls+=' x'` all look like. */
const SHIPPED = ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html',
                 'westmere-driver.html', 'westmere-pay.html', 'wm-compact.js', 'wm-lifecycle.js',
                 'wm-buttons.css']
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map(read);

function isWritten(cls) {
  const re = new RegExp('[\'"\\s]' + cls.replace(/-/g, '\\-') + '[\'"\\s]');
  return SHIPPED.some((src) => re.test(src));
}

// ── 1. NO SELECTOR ADDRESSED TO NOBODY ────────────────────────────────────

test('every class the design pass dresses is one the apps actually write', () => {
  const named = new Set();
  selectorsOf(DESIGN_PASS).replace(/\.([a-zA-Z][\w-]*)/g, (m, c) => { named.add(c); return m; });
  assert.ok(named.size > 40, 'only ' + named.size + ' classes found — the slice is wrong, not the CSS');
  const dead = [...named].filter((c) => !isWritten(c));
  assert.deepStrictEqual(dead, [],
    'dressed but never written (so the screen never gets the treatment): ' + dead.join(', '));
});

test('the calendar is dressed by the names the two apps emit', () => {
  // The specific pair that failed: hd/num, not head/dnum.
  for (const cls of ['cal-hd', 'cal-num', 'cal-day', 'cal-grid',
                     'adm-cal-hd', 'adm-cal-num', 'adm-cal-day', 'adm-cal-grid']) {
    assert.ok(new RegExp('\\.' + cls + '(?![\\w-])').test(selectorsOf(S30 + S32)),
      '.' + cls + ' — the class the grid actually uses — is not styled by the design pass');
    assert.ok(isWritten(cls), '.' + cls + ' is no longer written by either app');
  }
  for (const ghost of ['cal-head', 'cal-dnum', 'adm-cal-head', 'adm-cal-dnum']) {
    assert.ok(!new RegExp('\\.' + ghost + '\\b').test(selectorsOf(DESIGN_PASS)),
      '.' + ghost + ' is back, and no app has ever written it');
  }
});

// ── 2. THE BUILDERS NO LONGER FILL, OR COLOUR, BY HAND ────────────────────

const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const ownerMonth = fnBlock(stripComments(OWNER, { html: true }), 'buildCalendar');
const adminMonth = fnBlock(stripComments(ADMIN, { html: true }), 'buildAdminCalendar');

test('a day that holds jobs is not washed grey — the month builders set no cell background', () => {
  for (const [who, src] of [['owner', ownerMonth], ['admin', adminMonth]]) {
    const inline = [...src.matchAll(/style="([^"]*)"/g)].map((m) => m[1])
      .filter((s) => /background/i.test(s));
    assert.deepStrictEqual(inline, [],
      who + ' month cells still carry an inline background: ' + inline.join(' | '));
  }
});

test('a job inside a day is a class, not a filled pill written inline', () => {
  assert.ok(/class="cal-chip"/.test(ownerMonth), 'the owner month no longer writes .cal-chip');
  assert.ok(/class="cal-chip ext"/.test(ownerMonth), 'an external event is not marked .ext');
  assert.ok(/class="cal-more"/.test(ownerMonth), 'the "+N more" line is not .cal-more');
  assert.ok(/class="adm-cal-job-mini"/.test(adminMonth), 'the admin month no longer writes .adm-cal-job-mini');
  assert.ok(/class="adm-cal-job-mini ext"/.test(adminMonth), 'an admin external event is not marked .ext');
  assert.ok(/class="adm-cal-more"/.test(adminMonth), 'the admin "+N more" line is not .adm-cal-more');
  // And each of those is actually styled, or the markup is bare.
  for (const sel of ['.cal-chip', '.cal-chip.ext', '.cal-more',
                     '.adm-cal-job-mini', '.adm-cal-job-mini.ext', '.adm-cal-more']) {
    assert.ok(selectorsOf(S32).includes(sel), sel + ' is written by a builder but styled nowhere');
  }
});

test('a chip is held by a rule, not by a fill', () => {
  const chip = regionFrom(S32, '.cal-chip{', [/\n\.[a-z]/]);
  assert.ok(/border-left:\s*2px solid var\(--westmere-gold\)/.test(chip),
    'the job chip lost its gold rule');
  assert.ok(/background:\s*var\(--westmere-white\)/.test(chip),
    'the job chip must state the page white, or it inherits whatever is behind it');
  const mini = regionFrom(S32, '.adm-cal-job-mini{', [/\n\.[a-z]/]);
  assert.ok(/border-left:\s*2px solid var\(--westmere-gold\)/.test(mini),
    'the admin job line lost its gold rule');
});

test('a busy day says so in its number, which is the signal that is not a fill', () => {
  assert.ok(/cls\+?=.{0,40}' has'/.test(ownerMonth) || /\+\(hasEvents\?' has':''\)/.test(ownerMonth),
    'the owner month no longer marks a day that holds something');
  assert.ok(/cls\+=' has'/.test(adminMonth), 'the admin month no longer marks a day that holds something');
  assert.ok(/\.cal-day\.has \.cal-num\{[^}]*font-weight/.test(S32), 'a busy owner day reads the same as an empty one');
  assert.ok(/\.adm-cal-day\.has \.adm-cal-num\{[^}]*font-weight/.test(S32), 'a busy admin day reads the same as an empty one');
});

test('today is a gold RING and selected a navy one — neither is a fill', () => {
  const today = regionFrom(S32, '.cal-day.today, .adm-cal-day.today{', [/\n\./]);
  assert.ok(/box-shadow:\s*inset 0 0 0 2px var\(--westmere-gold\)/.test(today), 'today is not a gold ring');
  assert.ok(/background:\s*var\(--westmere-white\)/.test(today),
    'today must repaint the page white, or the old grey wash shows through');
  const sel = regionFrom(S32, '.cal-day.selected, .adm-cal-day.selected{', [/\n\./]);
  assert.ok(/box-shadow:\s*inset 0 0 0 2px var\(--westmere-navy\)/.test(sel), 'selected is not a navy ring');
  assert.ok(/background:\s*var\(--westmere-white\)/.test(sel), 'selected still fills');
});

test('the ring ladder settles every combination: chosen beats today beats needs-a-driver', () => {
  // All three can be true of one admin cell, and all three want the box-shadow.
  // Last-wins, so the order in the file IS the rule.
  const at = (sel) => S32.indexOf(sel);
  const flagged = at('.adm-cal-day.flagged{');
  const todayF = at('.adm-cal-day.today, .adm-cal-day.today.flagged{');
  const selF = at('.adm-cal-day.selected, .adm-cal-day.selected.flagged{');
  const both = at('.adm-cal-day.today.selected, .adm-cal-day.today.selected.flagged{');
  for (const [n, i] of [['flagged', flagged], ['today', todayF], ['selected', selF], ['today+selected', both]]) {
    assert.ok(i !== -1, 'the ' + n + ' rung of the ring ladder is gone');
  }
  assert.ok(flagged < todayF && todayF < selF && selF < both,
    'the ring ladder is out of order, so a selected day that needs a driver shows the wrong ring');
  assert.ok(!/#c8d1d9/.test(S32), 'the flagged ring is back to a literal instead of --westmere-line-strong');
});

test('the admin personal-event line takes the navy from the token, not from #102a43', () => {
  assert.ok(!/#102a43/i.test(adminMonth),
    'the navy is typed out by hand in the admin month builder again');
  assert.ok(/\.adm-cal-job-mini\.ext\{[^}]*var\(--westmere-/.test(S32),
    'the external-event line is not coloured from the token layer');
});

test('nothing in the design pass writes a colour by hand', () => {
  /* THE WHOLE POINT OF A TOKEN LAYER is that a colour is named once. Every
     section of this pass began by typing one out anyway — #102a43 in the
     admin month, #c8d1d9 for the flagged ring, two near-misses of
     --westmere-danger (#9b1c1c, where the token is #9C2828) in three places.
     None of them looked wrong; all of them were a second definition of a
     colour that already had a name. So: NO HEX AT ALL in these sections, and
     an rgba only as a tint of a base this file already names. */
  const hex = [...DESIGN_PASS.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  assert.deepStrictEqual(hex, [], 'colour written out by hand in the design pass: ' + hex.join(', '));
  const ALLOWED_TINTS = [
    '16, 42, 67',    // --westmere-navy, the ramp and every press/hover
    '156, 40, 40'    // --westmere-danger, the time-off hatch
  ];
  const rgba = [...DESIGN_PASS.matchAll(/rgba?\(([^)]*)\)/g)]
    .map((m) => m[1].split(',').slice(0, 3).map((n) => n.trim()).join(', '))
    .filter((base) => !ALLOWED_TINTS.includes(base));
  assert.deepStrictEqual([...new Set(rgba)], [],
    'an rgba tint of something that is not a named token: ' + [...new Set(rgba)].join(' | '));
});

test('the tints really are the tokens they claim to be', () => {
  // A tint only counts as "the token, quieter" if the numbers match it.
  const tok = (name) => {
    const m = new RegExp('--westmere-' + name + ':\\s*(#[0-9a-f]{6})', 'i').exec(THEME);
    assert.ok(m, '--westmere-' + name + ' is not defined');
    const h = m[1];
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
  };
  assert.strictEqual(tok('navy'), '16, 42, 67', '--westmere-navy moved; the ramp is now a different blue');
  assert.strictEqual(tok('danger'), '156, 40, 40', '--westmere-danger moved; the time-off hatch is a second red');
});

// ── 3. §30 AND §31 STILL SAY WHAT THEY CLAIM ──────────────────────────────

test('a section heading sits on a gold rule, in both apps\' own names for it', () => {
  assert.ok(/\.pg > \.sec-title\{[^}]*border-bottom:[^}]*var\(--westmere-gold\)/.test(S30),
    'the owner app\'s section heading lost its gold rule');
  assert.ok(/\.view > \.page-hd\{[^}]*border-bottom:[^}]*var\(--westmere-gold\)/.test(S30),
    'the admin app\'s page heading lost its gold rule');
});

test('a card is white paper with a hairline, and one card everywhere', () => {
  const card = regionFrom(S30, '.card{', [/\n\.[a-z]/]);
  assert.ok(/background:\s*var\(--westmere-white\)/.test(card), 'the card is no longer white paper');
  assert.ok(/border:[^;]*var\(--westmere-line\)/.test(card), 'the card lost its hairline');
});

test('a job is a card: an edge, a rhythm, and the gold hairline under the glance', () => {
  const job = regionFrom(S31, '.wm-job{', [/\n\.[a-z]/]);
  assert.ok(/border:[^;]*var\(--westmere-line\)/.test(job), 'a job row has no edge again');
  assert.ok(/border-radius/.test(job), 'a job row has no corner');
  assert.ok(/\.wm-job \.wm-glance\{[^}]*border-bottom:[^}]*var\(--westmere-gold\)/.test(S31),
    'the gold hairline under a job\'s glance row is gone');
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/class="wm-job/.test(src) || /'wm-job/.test(src),
      who + ' no longer composes its job rows as .wm-job');
  }
});

test('a cancelled job is quieted, and says so on both surfaces', () => {
  assert.ok(/\.wm-job\.is-cancelled\{/.test(S31), 'a cancelled job reads exactly like a live one');
});

// ── 4. §33 THE FIGURES: ONE HUE, VARYING IN VALUE ─────────────────────────

const adminChart = fnBlock(stripComments(ADMIN, { html: true }), '_renderChart');
const adminBreak = fnBlock(stripComments(ADMIN, { html: true }), '_renderBreakdown');
const adminHeat  = fnBlock(stripComments(ADMIN, { html: true }), '_renderHeatmap');

test('the navy ramp exists, is one hue, and is ordered', () => {
  const steps = [];
  for (let i = 0; i <= 5; i++) {
    const m = new RegExp('--wm-ramp-' + i + ':\\s*([^;]+);').exec(S33);
    assert.ok(m, 'step ' + i + ' of the ramp is missing');
    steps[i] = m[1].trim();
  }
  // Every step is the house navy — as a tint of it, or the ink itself.
  const alpha = steps.map((v) => {
    if (/^var\(--westmere-navy[^)]*\)$/i.test(v)) return 1;
    const m = /^rgba\(\s*16,\s*42,\s*67,\s*([\d.]+)\s*\)$/.exec(v);
    assert.ok(m, 'a ramp step is not a tint of --westmere-navy: ' + v);
    return parseFloat(m[1]);
  });
  for (let i = 1; i < alpha.length; i++) {
    assert.ok(alpha[i] > alpha[i - 1], 'the ramp is not monotonic at step ' + i);
  }
});

test('the heatmap ink flips where the ramp gets dark, and only there', () => {
  // A heat cell carries its count, so each step has to hold type. Navy is
  // legible to step 3; white takes over at 4.
  assert.ok(/\.wm-heat td\.lv4, \.wm-heat td\.lv5\{[^}]*color:\s*var\(--westmere-white\)/.test(S33),
    'the dark steps do not flip to white ink — the count on them is unreadable');
  for (const lv of ['lv1', 'lv2', 'lv3']) {
    assert.ok(new RegExp('\\.wm-heat td\\.' + lv + '\\{[^}]*color:\\s*var\\(--westmere-navy\\)').test(S33),
      'the ' + lv + ' cell does not state navy ink');
  }
});

test('the revenue chart draws one hue from the ramp, not a grey and a tailwind blue', () => {
  assert.ok(/var\(--wm-ramp-\$\{/.test(adminChart), 'the chart no longer fills from the ramp');
  for (const lit of ['#6a6a6a', 'rgba(106,106,106', '#3b82f6', '#10b981', '#059669']) {
    assert.ok(!adminChart.includes(lit), 'the chart still writes ' + lit);
    assert.ok(!adminBreak.includes(lit), 'the breakdown key still writes ' + lit);
    assert.ok(!adminHeat.includes(lit), 'the heatmap still writes ' + lit);
  }
  assert.ok(!/statusColors/.test(adminBreak),
    'the six-hue status palette is back — six colours for six values of one field');
});

test('the chart and the heatmap read off the SAME scale', () => {
  assert.ok(/wmRampStep\(/.test(adminChart) && /wmRampStep\(/.test(adminHeat) && /wmRampStep\(/.test(adminBreak),
    'the three figures no longer share one step function, so a busy hour and a big week stop looking alike');
  const step = fnBlock(stripComments(ADMIN, { html: true }), 'wmRampStep');
  assert.ok(/return 0;/.test(step), 'nothing at all must land on step 0, not on the lightest tint');
  assert.ok(/return 5;/.test(step) && /return 1;/.test(step), 'the step function no longer spans the ramp');
});

test('a week start on the chart axis is read as a wall-clock date', () => {
  // `new Date('2026-10-05')` is parsed UTC and read local: west of London the
  // axis labelled every Monday as the Sunday before. CLAUDE.md, timezone.
  assert.ok(!/new Date\(w\.weekStart\)/.test(adminChart),
    'the axis parses a YYYY-MM-DD as an instant again');
  assert.ok(/_anWallDate\(/.test(adminChart), 'the axis no longer builds its label from the components');
  const wall = fnBlock(stripComments(ADMIN, { html: true }), '_anWallDate');
  assert.ok(/Date\.UTC\(/.test(wall), '_anWallDate does not use Date.UTC');
  assert.ok(/timeZone:\s*'UTC'/.test(adminChart), 'the label is not formatted in UTC');
});

// ── 5. THE COMPARISON LINE ────────────────────────────────────────────────

const LIFECYCLE = require(path.join(ROOT, 'wm-lifecycle.js'));
const COMPACT = require(path.join(ROOT, 'wm-compact.js'));

test('last week is cut at the same weekday, so a Tuesday is compared with a Tuesday', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  assert.strictEqual(days(c.from, c.to), days(c.lastFrom, c.lastTo),
    'the two windows are different lengths — a running week measured against a finished one');
  assert.strictEqual(days(c.lastFrom, c.from), 7, 'last week is not the week before this one');
});

test('the comparison counts only the jobs inside each window', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  const jobs = [
    { date: c.from, fare: 100 },                 // this week
    { date: c.to, fare: 50 },                    // this week, today
    { date: c.lastFrom, fare: 40 },              // last week, in window
    { date: c.lastTo, fare: 30 },                // last week, on the cut
    { date: '1999-01-01', fare: 9999 }           // long ago
  ];
  const r = LIFECYCLE.weekCompare(jobs, (j) => Number(j.fare) || 0);
  assert.strictEqual(r.thisWeek.total, 150, 'this week counted the wrong jobs');
  assert.strictEqual(r.lastWeek.total, 70, 'last week counted the wrong jobs');
  assert.strictEqual(r.delta, 80);
  assert.strictEqual(r.direction, 'up');
});

test('a day past the cut in last week is NOT counted', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  if (c.lastTo >= c.lastFrom && c.partial) {
    const after = new Date(Date.parse(c.lastTo + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const r = LIFECYCLE.weekCompare([{ date: after, fare: 500 }], (j) => Number(j.fare) || 0);
    assert.strictEqual(r.lastWeek.total, 0,
      'last week is being counted past the point this week has reached');
  }
});

test('valueOf decides what counts, and null means it does not', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  const r = LIFECYCLE.weekCompare(
    [{ date: c.from, fare: 100, paid: 1 }, { date: c.from, fare: 400, paid: 0 }],
    (j) => (j.paid ? Number(j.fare) : null));
  assert.strictEqual(r.thisWeek.total, 100, 'an uncounted job still reached the total');
  assert.strictEqual(r.thisWeek.jobs, 1);
});

test('no percentage is claimed against a week of nothing', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  const r = LIFECYCLE.weekCompare([{ date: c.from, fare: 100 }], (j) => Number(j.fare) || 0);
  assert.strictEqual(r.pct, null, 'a percentage off a base of zero');
  assert.ok(!/%/.test(COMPACT.compareLine(r)), 'the line prints a percentage it cannot have');
  assert.ok(/nothing in the same stretch last week/.test(COMPACT.compareLine(r)),
    'a week with nothing in it is not said in words');
});

test('the line says up and down in WORDS, never in red and green', () => {
  const c = LIFECYCLE.weekCompare([], () => 0);
  const down = COMPACT.compareLine(LIFECYCLE.weekCompare(
    [{ date: c.from, fare: 50 }, { date: c.lastFrom, fare: 200 }], (j) => Number(j.fare) || 0));
  assert.ok(/down/.test(down), 'a quieter week is not said');
  for (const colour of ['green', 'red', '#0', '#1', '#2', '#d', '#e', '#f', 'rgb']) {
    assert.ok(!down.toLowerCase().includes(colour.toLowerCase()) || colour.length > 4,
      'the comparison line is writing colour: ' + colour);
  }
  assert.ok(!/style=/.test(down), 'the comparison line carries an inline style');
  assert.ok(!/[▲▼↑↓]/.test(down), 'the comparison line is using an arrow instead of a word');
});

test('both apps draw the comparison line, from the shared module', () => {
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/class="wm-compare"/.test(src), who + ' has no place to put the comparison line');
    /* The owner's line is wrapped in extIntoCompare, which adds the work he
       did outside Westmere into the two ranges the module worked out — the
       cards above it include that money, so the sentence has to. What this
       test is for is unchanged: neither app may compute a week of its own.
       GUARDRAIL: server/tests/external-earnings.test.js */
    assert.ok(/WMCompact\.compareLine\((?:extIntoCompare\()?WMLifecycle\.weekCompare\(/.test(src),
      who + ' is not building the line from the shared module');
  }
  assert.ok(/\.wm-compare\{/.test(S33), 'the comparison line is unstyled');
});

test('the owner earnings trio is three white cards, not two and a navy gradient', () => {
  // The middle card was filled with a navy gradient and printed its figure in
  // --navy on top of it. It only showed up at all because §15.2 repaints ink
  // inside the app and happened to reach it.
  const accent = regionFrom(S33, '.earn-stat-card.esk-accent{', [/\n\.[a-z]/]);
  assert.ok(/background:\s*var\(--westmere-white\)/.test(accent),
    'the middle earnings card fills again');
  assert.ok(!/gradient/i.test(accent), 'the navy gradient is back on the middle card');
  assert.ok(/border-top:[^;]*var\(--westmere-gold\)/.test(accent),
    'the card that matters has no emphasis at all now');
  assert.ok(/\.earn-stat-card::before\{[^}]*display:\s*none/.test(S33),
    'the diagonal hatch over the earnings cards is back');
});

// ── 6. §34 THE ADMIN'S OWN FOUR SCREENS ───────────────────────────────────

test('the two bespoke tables lost their grey heading slab', () => {
  const head = regionFrom(S34, '.jtable th, .fare-table th{', [/\n\.[a-z]/]);
  assert.ok(/background:\s*var\(--westmere-white\)/.test(head), 'a column heading fills again');
  assert.ok(/border-bottom:[^;]*var\(--westmere-gold\)/.test(head), 'the heading row lost its gold rule');
  assert.ok(/color:\s*var\(--westmere-gold-ink\)/.test(head), 'a column heading is not the house eyebrow');
  // The page's own rules are what the theme is overriding; if they go, say so.
  assert.ok(/\.jtable th\{/.test(ADMIN) && /\.fare-table th\{/.test(ADMIN),
    'the admin no longer carries these tables — the §34 override is dressing nothing');
});

test('loading, empty and failed are one state, not three inline styles each', () => {
  assert.ok(/\.wm-state\{/.test(S34) && /\.wm-state\.is-bad\{/.test(S34), 'the shared state class is gone');
  assert.ok(/var\(--westmere-danger\)/.test(S34), 'the failed state is not the named danger colour');
  // The four screens must actually use it.
  const screens = ['view-settings', 'view-record-book', 'view-time-off', 'view-fares'];
  const used = screens.filter((v) => {
    const i = ADMIN.indexOf('id="' + v + '"');
    const j = ADMIN.indexOf('<div class="view" id="view-', i + 10);
    return /wm-state|wm-hint|wm-subhead|ch-note/.test(ADMIN.slice(i, j === -1 ? undefined : j));
  });
  assert.ok(used.length >= 3, 'only ' + used.length + ' of the four admin screens use the shared furniture');
});

test('no emoji is left standing in for a label on these screens', () => {
  // 📄 💾 🖨 ＋ were the loudest things on four otherwise quiet screens.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FF01}-\u{FF5E}]/u;
  for (const v of ['view-record-book', 'view-time-off', 'view-fares']) {
    const i = ADMIN.indexOf('id="' + v + '"');
    const j = ADMIN.indexOf('<div class="view" id="view-', i + 10);
    const labels = [...ADMIN.slice(i, j === -1 ? undefined : j).matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
    const loud = labels.filter((t) => emoji.test(t));
    assert.deepStrictEqual(loud, [], v + ' still labels a button with an emoji: ' + loud.join(', '));
  }
});

test('the settings sliders are not left on the browser\'s own blue', () => {
  assert.ok(/input\[type="range"\]\{/.test(S34), 'the range inputs are unstyled');
  assert.ok(/::-webkit-slider-thumb\{[^}]*var\(--westmere-gold\)/.test(S34) &&
            /::-moz-range-thumb\{[^}]*var\(--westmere-gold\)/.test(S34),
    'the thumb is themed in only one engine — it will be blue in the other');
});

test('a wide table scrolls itself, and does not take the window with it', () => {
  /* MEASURED at 1280px: the admin document was 1373 wide and the topbar's New
     Job button sat off the right edge of every screen. The record book's
     fourteen columns were propagating their intrinsic width out through
     `.main`, a flex child, which does not shrink below its content unless it
     is allowed to. Same bug as §29's grid tracks, different box model. */
  for (const sel of ['.main', '.content']) {
    assert.ok(new RegExp('\\' + sel + '\\{[^}]*min-width:\\s*0').test(S34),
      sel + ' may not shrink below its content again — the page will scroll sideways');
  }
  // And the thing that needs to scroll still says so.
  const i = ADMIN.indexOf('id="rb-table"');
  assert.ok(i !== -1, 'the record book table is gone');
  assert.ok(/overflow-x:\s*auto/.test(ADMIN.slice(Math.max(0, i - 400), i)),
    'the record book table is no longer inside an overflow container');
});

// ── NEGATIVE: prove each detector can fail ────────────────────────────────

test('NEGATIVE: the dead-selector check would have caught .cal-head', () => {
  assert.ok(!isWritten('cal-head'), 'something now writes cal-head, so the example is stale');
  assert.ok(isWritten('cal-hd'), 'cal-hd is not written — the check cannot tell the two apart');
});

test('NEGATIVE: the fill check sees an inline background and spares a bare style', () => {
  const filled = '<div class="cal-day" style="background:rgba(106,106,106,.07);">1</div>';
  const plain  = '<div class="cal-day" style="padding:2px">1</div>';
  const bg = (s) => [...s.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).filter((v) => /background/i.test(v));
  assert.strictEqual(bg(filled).length, 1, 'the grey day wash would pass — the check is useless');
  assert.strictEqual(bg(plain).length, 0, 'a harmless inline style is read as a fill');
});

test('NEGATIVE: the literal check sees #102a43 and spares the token', () => {
  assert.ok(/#102a43/i.test('color:#102a43'), 'the navy literal would pass');
  assert.ok(!/#102a43/i.test('color:var(--westmere-navy)'), 'the token is read as a literal');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/design-consistency\.test\.js/.test(read('package.json')),
    'design-consistency.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
