/**
 * NO SCREEN IN THIS SYSTEM ASKS A QUESTION THE OS DRAWS — run with:
 *   node server/tests/no-native-dialogs.test.js   (also gated by `npm test`)
 *
 * WHY
 *   window.prompt, window.confirm and window.alert are drawn by the operating
 *   system. On a phone in night mode they are a black dialog with grey text,
 *   and no stylesheet anywhere can reach them: they are the one black box this
 *   repo cannot fix by fixing a colour. The owner photographed two of them.
 *   The booking form and the dispatch sheet had their prompts removed for the
 *   same reason, one complaint at a time; this closes the class.
 *
 *   They also block the page, which is why so many call sites read
 *   `if (!confirm(...)) return;` in the middle of an otherwise asynchronous
 *   function. WMAsk returns promises, so those read the same and behave.
 *
 * WHAT IS GUARDED
 *   1. No app calls a native dialog, in markup or in script.
 *   2. The replacement exists, is loaded by every app, and is a light card
 *      that refuses the phone's repaint — the thing it was built to be.
 *   3. Every await of it is inside an async function, because a bare await in
 *      a callback is a syntax error that takes the whole app down.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments are prose. A guard that finds the thing it forbids inside the
   comment explaining why it is forbidden has proved nothing. */
const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const APPS = ['westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html',
              'westmere-rider.html', 'book.html', 'index.html', 'westmere-pay.html'];
const SCRIPTS = ['booking-app.js', 'wm-picker.js', 'wm-timewheel.js', 'wm-address-lookup.js'];

console.log('\nNothing asks through the operating system');

for (const f of APPS.concat(SCRIPTS)) {
  test(f + ': no native prompt, confirm or alert', () => {
    const src = strip(read(f));
    const hits = [];
    const re = /(?<![A-Za-z0-9_$.])(confirm|prompt|alert)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      /* WMAsk.confirm( and friends are reached through the object, so the
         negative lookbehind on `.` already excludes them — this catches a
         bare call only. */
      hits.push(m[1] + '() at line ' + (src.slice(0, m.index).split('\n').length));
    }
    assert.deepStrictEqual(hits, [],
      f + ' asks through a dialog the operating system draws — black on a phone at night, '
      + 'and unreachable from any stylesheet. Use WMAsk.confirm / .prompt / .tell:\n      ' + hits.join('\n      '));
  });
}

// ── The replacement ──────────────────────────────────────────────────────
test('WMAsk exists and offers the three answers the apps need', () => {
  const s = read('wm-ask.js');
  for (const fn of ['confirm:', 'prompt:', 'tell:']) {
    assert.ok(s.includes(fn), 'wm-ask.js has no ' + fn);
  }
  assert.ok(/return new Promise|new Promise\(/.test(s), 'it must return a promise — the call sites await it');
});

test('it is a light card that refuses the repaint', () => {
  /* The whole point: the thing replacing the black box must not be one. */
  const s = read('wm-ask.js');
  const card = /\.wm-ask\{([^']*)/.exec(s.replace(/',\s*'/g, ''));
  assert.ok(card, 'the card has no style');
  assert.ok(/background:#ffffff/.test(card[1]), 'the card is not on white paper');
  assert.ok(/color:#102a43/.test(card[1]), 'the card has no navy ink');
  assert.ok(/border:1px solid/.test(card[1]), 'a card needs a rim');
  assert.ok(/color-scheme:only light/.test(card[1]),
    'without only-light a phone may repaint it — which is the bug this file exists to end');
  /* And it clears the status bar, like every other layer. */
  assert.ok(/env\(safe-area-inset-top/.test(s), 'the sheet can sit under the notch');
  /* Both buttons are visible: one filled, one framed. */
  assert.ok(/\.wm-ask-b\{/.test(s.replace(/',\s*'/g, '')) && /\.wm-ask-b\.go\{/.test(s.replace(/',\s*'/g, '')),
    'the buttons have no style of their own');
});

test('every app loads it', () => {
  for (const f of ['westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html', 'westmere-rider.html']) {
    assert.ok(/<script src="\/wm-ask\.js"><\/script>/.test(read(f)),
      f + ' calls WMAsk but never loads it');
  }
});

test('every await of it is inside an async function', () => {
  /* A bare await in a plain callback is a SyntaxError, and a syntax error in
     one of these files is a blank app. Parsing the script blocks is the test:
     if any await sits where it may not, this throws. */
  for (const f of ['westmere-owner.html', 'westmere-admin.html', 'westmere-driver.html', 'westmere-rider.html']) {
    const html = read(f);
    const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length, f + ' has no inline script');
    blocks.forEach((b, i) => {
      assert.doesNotThrow(() => new Function(b[1]),
        f + ' script block ' + i + ' does not parse — an await is probably outside an async function');
    });
    assert.ok(/await WMAsk\./.test(html), f + ' no longer asks anything — did a sweep delete the questions?');
  }
});

test('the estimate flow asks in the app, with a number pad and its own button', () => {
  /* The one the owner hit: it used to be a native prompt for the fare. */
  const s = strip(read('westmere-owner.html'));
  const i = s.indexOf('async function ownerSendEstimate');
  assert.ok(i > -1, 'ownerSendEstimate is gone');
  const fn = s.slice(i, s.indexOf('\nasync function', i + 10));
  assert.ok(/await WMAsk\.prompt\(/.test(fn), 'the fare is still asked through the operating system');
  assert.ok(/type:'number'/.test(fn.replace(/\s/g, '')), 'a fare deserves a number keypad');
  assert.ok(/ok:'Sendestimate'/.test(fn.replace(/\s/g, '')), 'the button should say what it does');
});

test('cancelling a booking looks like cancelling a booking', () => {
  const s = strip(read('westmere-owner.html'));
  assert.ok(/danger:true/.test(s.replace(/\s/g, '')), 'no destructive question is marked as one');
  assert.ok(/cancel:'Keepit'/.test(s.replace(/\s/g, '')),
    'the way out of a destructive question should say what it does, not "Cancel" next to "Cancel"');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('no-native-dialogs.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
