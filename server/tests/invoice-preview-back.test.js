/**
 * THE INVOICE PREVIEW HAS A WAY OUT — run with:
 *   node server/tests/invoice-preview-back.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   Preview was `window.open(pdfUrl, '_blank')` in BOTH staff apps. That hands
 *   the raw PDF to the browser's own viewer in a NEW browsing context — and a
 *   new context has no history, so Back is greyed out, there is no app chrome
 *   to press, and on a phone or an installed app window there is often no tab
 *   strip either. The owner opened a preview and could not get back.
 *
 * WHAT IS GUARDED, in the owner app AND the admin app
 *   1. Preview no longer throws the PDF into a blank tab.
 *   2. The overlay carries a visible Back control that closes it.
 *   3. The device/browser Back button closes it too — a history entry is
 *      pushed, and popstate closes the overlay.
 *   4. Closing does not go back TWICE when the close came from Back itself.
 *   5. Escape closes it.
 *   6. It is actually reachable: the Preview button still calls it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const APPS = [
  ['westmere-owner.html', 'the owner app'],
  ['westmere-admin.html', 'the admin app']
];
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const src_ = src;
/* The function body, bounded at its own closing brace in column 0 — the same
   way the rest of the suite reads a shipped handler. */
function fnBody(code, name) {
  const i = code.indexOf('function ' + name + '(');
  assert.ok(i > -1, name + ' is gone');
  const end = code.indexOf('\n}', i);
  assert.ok(end > i, name + ' has no closing brace');
  return code.slice(i, end);
}

for (const [file, label] of APPS) {
  test(label + ': preview no longer opens the PDF in a blank tab', () => {
    const body = fnBody(src(file), 'invOpenPdf');
    assert.ok(!/window\.open/.test(body),
      label + ' still calls window.open for the invoice PDF — a new tab has no history, '
      + 'so Back is greyed out and there is no way back to the app');
    assert.ok(/invPreviewOpen\(/.test(body),
      label + ' does not open the in-app preview');
  });

  test(label + ': the overlay has a Back control wired to close it', () => {
    const code = src(file);
    const open = fnBody(code, 'invPreviewOpen');
    assert.ok(/id="pdf-preview-back"/.test(open), label + ': no Back control is rendered');
    assert.ok(/getElementById\('pdf-preview-back'\)\.onclick\s*=\s*function\(\)\{\s*invPreviewClose\(\)/.test(open),
      label + ": the Back control is drawn but not wired to close — a button that does nothing "
      + 'is worse than no button');
  });

  test(label + ': the device Back button closes it, and stays in the app', () => {
    const code = src(file);
    const open = fnBody(code, 'invPreviewOpen');
    assert.ok(/history\.pushState/.test(open),
      label + ': no history entry is pushed, so the device Back button leaves the app entirely '
      + 'instead of closing the preview');
    assert.ok(/addEventListener\('popstate'[\s\S]{0,200}invPreviewClose\(true\)/.test(code),
      label + ': nothing listens for the Back button');
  });

  test(label + ': Back-from-history does not unwind twice', () => {
    /* Closing pops the entry we pushed. If the close CAME from the back button
       the entry is already gone, and calling history.back() again would take
       him off the page he was trying to return to. */
    const close = fnBody(src(file), 'invPreviewClose');
    assert.ok(/fromPop/.test(close),
      label + ': invPreviewClose cannot tell a button-close from a Back-close');
    assert.ok(/if\s*\(!fromPop[\s\S]{0,80}history\.back\(\)/.test(close),
      label + ': it calls history.back() unconditionally — pressing Back would go back twice');
  });

  test(label + ': Escape closes it too', () => {
    const code = src(file);
    assert.ok(/_invPreviewKey[\s\S]{0,160}Escape[\s\S]{0,80}invPreviewClose\(\)/.test(code),
      label + ': Escape does not close the preview');
    assert.ok(/document\.addEventListener\('keydown', _invPreviewKey\)/.test(code)
           && /document\.removeEventListener\('keydown', _invPreviewKey\)/.test(code),
      label + ': the key handler is added but never removed (or vice versa) — it would pile up');
  });

  test(label + ': the overlay still offers the real PDF', () => {
    const open = fnBody(src(file), 'invPreviewOpen');
    assert.ok(/id="pdf-preview-open"/.test(open) && /target="_blank"/.test(open),
      label + ': there is no way to reach the native PDF viewer — a phone will not render a '
      + 'PDF in an iframe, so without this link the preview is blank on mobile');
    assert.ok(/id="pdf-preview-frame"/.test(open), label + ': the PDF is never embedded');
  });

  test(label + ': Preview is still wired to the button', () => {
    const code = src(file);
    assert.ok(/invOpenPdf\(/.test(code.replace(/function invOpenPdf\(/g, '')),
      label + ': nothing calls invOpenPdf any more — the Preview button is dead');
  });
}

for (const [file, label] of APPS) {
  test(label + ': a home-screen app is never navigated away from the overlay', () => {
    /* WHAT ACTUALLY TRAPPED HIM. Both apps ship display:standalone manifests
       and apple-mobile-web-app-capable, so the owner runs this from his home
       screen. In an iOS home-screen app there is no browser chrome — no back
       button, no tab bar, no swipe-back — and target="_blank" therefore does
       not open a tab. It navigates the one webview to the PDF, which has no
       chrome either, so the only way back is to kill the app and restart it.
       That is what he reported, with the back overlay already deployed.

       The escape hatch on the overlay must not be the thing that traps him. */
    const src = fnBody(src_(file), 'invPreviewOpen');
    assert.ok(/_wmStandalone\(\)/.test(src),
      label + ': the overlay does not know whether it is running as an installed app, '
      + 'so it offers target="_blank" — which in a home-screen app navigates away with no way back');
    assert.ok(/_wmStandalone\(\)\s*\?\s*' download'/.test(src),
      label + ': a home-screen app must SAVE the PDF (the share sheet opens over the page) '
      + 'rather than navigate to it');
    assert.ok(/:\s*' target="_blank" rel="noopener"'/.test(src),
      label + ': a real browser should still open the PDF in a new tab');
  });

  test(label + ': the Back control stays on screen', () => {
    const src = fnBody(src_(file), 'invPreviewOpen');
    assert.ok(/position:sticky/.test(src),
      label + ': the header can scroll away — in a home-screen app the Back control on it '
      + 'is the only way out, so it must stay put');
  });

  test(label + ': it can tell a home-screen app from a browser', () => {
    const code = src_(file);
    assert.ok(/function _wmStandalone/.test(code), label + ': the check is missing');
    const fn = fnBody(code, '_wmStandalone');
    assert.ok(/navigator\.standalone/.test(fn),
      label + ': iOS reports a home-screen app through navigator.standalone and nothing else');
    assert.ok(/display-mode: standalone/.test(fn),
      label + ': other platforms report it through the display-mode media query');
  });
}

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('invoice-preview-back.test.js'),
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
