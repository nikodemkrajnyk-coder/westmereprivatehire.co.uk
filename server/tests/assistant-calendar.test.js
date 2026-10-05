/**
 * THE ASSISTANT'S CALENDAR DEAD END — run with:
 *   node server/tests/assistant-calendar.test.js   (also gated by `npm test`)
 *
 * The owner photographed his Assistant screen saying, twice:
 *
 *     Could not add to calendar: Google Calendar not connected.
 *     Connect Google Calendar in Settings first
 *
 * The check itself was right — his grant really was down — but the message was
 * a dead end in two ways. It NAMED a screen instead of opening it, and it said
 * the same thing for two situations that need opposite things from him: a
 * calendar that was never linked, and one Google has since signed him out of.
 * A man who has connected his calendar, told to "connect it in Settings
 * first", goes looking for a button that says Disconnect.
 *
 * AND IT LEFT THE WRONG IMPRESSION. A job he CONFIRMS goes on the calendar by
 * itself — server/calendar-sync.js pushes at every change and sweeps behind
 * itself for misses. He never has to add a confirmed job by hand. The only
 * thing the Assistant's calendar button is for is a diary entry WITHOUT a
 * booking, and the message now says so rather than implying the calendar is
 * something he has to keep feeding.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing here can tell whether a particular
 * account's token is alive; that is in his database. What it pins is that the
 * system tells him the truth and hands him the action.
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

const ROUTES = read('server/google-routes.js');
const OWNER = read('westmere-owner.html');
const SRC = strip(OWNER, { html: true });

test('the server says WHICH problem it is, not just that there is one', () => {
  const block = ROUTES.slice(ROUTES.indexOf("router.post('/events'"), ROUTES.indexOf("router.post('/events'") + 1600);
  assert.ok(/needsReconnect/.test(block), 'the route cannot tell the two cases apart');
  assert.ok(/reason:\s*status\.needsReconnect \? 'needs_reconnect' : 'not_connected'/.test(block),
    'the screen has nothing to branch on');
  assert.ok(/signed you out/.test(block), 'a lapsed grant is still described as "not connected"');
  assert.ok(!/Connect Google Calendar in Settings first/.test(block),
    'the dead-end sentence is back');
});

test('both messages say the calendar fills itself once it is working', () => {
  const block = ROUTES.slice(ROUTES.indexOf("router.post('/events'"), ROUTES.indexOf("router.post('/events'") + 1600);
  /* Both branches of the ternary, each ending in the same promise. Matched as
     whole sentences rather than by quote-splitting, which cut one in half. */
  const sentences = block.match(/[A-Z][^'\n]*?Settings[^'\n]*?\./g) || [];
  assert.ok(sentences.length >= 2, 'expected a sentence for each case, found ' + sentences.length);
  for (const t of sentences) {
    assert.ok(/automatically/.test(t), 'this message still implies he must add jobs by hand: ' + t);
  }
});

test('the Assistant opens Settings instead of naming it', () => {
  const fn = fnBlock(SRC, 'assistCalendarProblem');
  assert.ok(/openSettings\(\)/.test(fn), 'the message does not offer a way through');
  assert.ok(/Reconnect/.test(fn) && /Connect/.test(fn), 'it does not say the right word for each case');
  assert.ok(/needsReconnect/.test(fn), 'it cannot tell the two cases apart');
  assert.ok(/openSettings/.test(SRC.slice(SRC.indexOf('function openSettings'), SRC.indexOf('function openSettings') + 40)),
    'openSettings is gone, so the button would do nothing');
});

test('it explains that a CONFIRMED job needs none of this', () => {
  const fn = fnBlock(SRC, 'assistCalendarProblem');
  assert.ok(/on its own/.test(fn) || /automatically/.test(fn),
    'nothing tells him confirmed jobs sync themselves');
  assert.ok(/diary entry without a booking/.test(fn),
    'nothing says what this button is actually for');
});

test('both Assistant calendar paths use it — the card and the voice booking', () => {
  for (const f of ['calOnlyFromData', 'calOnlyAssistBooking']) {
    const fn = fnBlock(SRC, f);
    assert.ok(/assistCalendarProblem\(d\)/.test(fn), f + ' still prints the raw server string');
    assert.ok(/needs_reconnect/.test(fn) && /not_connected/.test(fn),
      f + ' does not branch on the reason');
  }
});

test('the auto-sync it promises actually exists, and covers confirmed jobs', () => {
  const sync = read('server/calendar-sync.js');
  assert.ok(/CALENDAR_STATUSES\s*=\s*\['confirmed'/.test(sync),
    'confirmed jobs are no longer the thing that reaches the calendar');
  assert.ok(/calendar_event_id IS NULL/.test(sync),
    'the sweep no longer catches jobs whose event never landed');
  // And the promise in the message is not a lie about a feature that was removed.
  assert.ok(fs.existsSync(path.join(ROOT, 'server/tests/calendar-auto-sync.test.js')),
    'the auto-sync guard is gone — the Assistant is promising something unguarded');
});

test('Settings still offers the reconnect it sends him to', () => {
  assert.ok(/needsReconnect/.test(SRC), 'the Settings screen no longer detects a lapsed grant');
  assert.ok(/signed you out/.test(OWNER), 'Settings does not explain a lapsed grant');
  assert.ok(/connectGoogleCalendar/.test(SRC), 'there is no reconnect action to land on');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/assistant-calendar\.test\.js/.test(read('package.json')),
    'assistant-calendar.test.js is not in the npm test chain — an unrun guard is no guard');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
