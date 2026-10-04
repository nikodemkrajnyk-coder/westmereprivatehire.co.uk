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
const DESIGN_PASS = S30 + S31 + S32;

/* The selector side of a rule block, with declarations removed. */
const selectorsOf = (css) => css.replace(/\{[^}]*\}/g, '\n');

/* Everything that ships markup or writes markup from JS. A class is "real" if
   one of these writes it as a whole word inside quotes or whitespace — which
   is what `class="x"`, `class="a x"` and `cls+=' x'` all look like. */
const SHIPPED = ['westmere-owner.html', 'westmere-admin.html', 'westmere-rider.html',
                 'westmere-driver.html', 'westmere-pay.html', 'wm-compact.js', 'wm-lifecycle.js']
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

test('nothing in the design pass writes a gold literal', () => {
  // Exactly two golds exist, both as tokens; see §1. A literal here is how the
  // third gold gets in.
  const lits = [...DESIGN_PASS.matchAll(/#(?:C9A227|8A6A12)/gi)].map((m) => m[0]);
  assert.deepStrictEqual(lits, [], 'gold written out by hand in the design pass: ' + lits.join(', '));
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
