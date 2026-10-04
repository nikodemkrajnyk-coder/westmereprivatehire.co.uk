/* ── ASKING SOMETHING, IN THE APP'S OWN VOICE ──────────────────────────────
 *
 * window.prompt, window.confirm and window.alert are drawn by the operating
 * system, not by this page. On a phone in night mode they are a black dialog
 * with grey text and no styling hook anywhere in CSS — the one black box no
 * stylesheet can reach. The owner has photographed two of those already, and
 * the booking form and the dispatch sheet had their prompts taken out for the
 * same reason; this is the rest of them.
 *
 * They also BLOCK. A native confirm() freezes the page, which is why half the
 * call sites in these apps read `if(!confirm(...)) return;` inside a function
 * that is otherwise asynchronous. These return promises, so the call sites say
 * `if (!await WMAsk.confirm(...)) return;` and read the same.
 *
 *   WMAsk.confirm(message, opts) → Promise<boolean>
 *   WMAsk.prompt(message, opts)  → Promise<string|null>   (null = cancelled)
 *   WMAsk.tell(message, opts)    → Promise<void>          (replaces alert)
 *
 * opts: { title, ok, cancel, danger, value, placeholder, type, inputmode }
 *
 * One card, the same as every other surface in the system: white paper, navy
 * ink, a rim, and color-scheme:only light so no phone can repaint it. It sits
 * above everything, clears the status bar, and the Escape key and the scrim
 * both cancel. GUARDRAIL: server/tests/no-native-dialogs.test.js
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'wm-ask-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.wm-ask-back{position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;',
        'background:rgba(16,42,67,.42);padding:calc(1.2rem + env(safe-area-inset-top,0px)) 1.2rem calc(1.2rem + env(safe-area-inset-bottom,0px));',
        'color-scheme:only light}',
      '.wm-ask{background:#ffffff;color:#102a43;color-scheme:only light;width:100%;max-width:23rem;',
        'border:1px solid #c8d1d9;border-radius:14px;box-shadow:0 24px 60px rgba(16,42,67,.28);',
        'font-family:var(--sans,inherit);overflow:hidden;max-height:calc(100vh - env(safe-area-inset-top,0px) - 2.4rem);',
        'display:flex;flex-direction:column}',
      '.wm-ask-body{padding:1.15rem 1.2rem .9rem;overflow:auto}',
      '.wm-ask-t{font-family:var(--serif,inherit);font-size:1.08rem;line-height:1.3;color:#102a43;margin:0 0 .35rem}',
      '.wm-ask-m{font-size:.92rem;line-height:1.55;color:rgba(27,27,26,.75);white-space:pre-line;margin:0}',
      '.wm-ask-in{width:100%;box-sizing:border-box;margin-top:.9rem;padding:.65rem .7rem;font-family:inherit;',
        'font-size:1rem;color:#102a43;background:#ffffff;border:1px solid #c8d1d9;border-radius:8px;color-scheme:only light}',
      '.wm-ask-in:focus{outline:none;border-color:#102a43}',
      '.wm-ask-row{display:flex;gap:.6rem;padding:.2rem 1.2rem 1.15rem}',
      '.wm-ask-b{flex:1;padding:.72rem .6rem;border-radius:8px;cursor:pointer;font-family:var(--sans,inherit);',
        'font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;background:#ffffff;color:#102a43;',
        'border:1px solid #c8d1d9}',
      '.wm-ask-b.go{flex:1.3;background:#102a43;color:#ffffff;border-color:#102a43;font-weight:600}',
      '.wm-ask-b.danger{background:#8B2222;color:#ffffff;border-color:#8B2222;font-weight:600}'
    ].join('');
    document.head.appendChild(st);
  }

  var open = null;

  function close(result) {
    if (!open) return;
    var o = open; open = null;
    document.removeEventListener('keydown', o.key, true);
    if (o.el.parentNode) o.el.parentNode.removeChild(o.el);
    if (o.prevOverflow !== undefined) document.body.style.overflow = o.prevOverflow;
    o.resolve(result);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function ask(kind, message, opts) {
    var o = opts || {};
    /* ONE AT A TIME. Two of these on screen would be the native behaviour's
       one redeeming feature lost — the second answer would land on the first
       question. A second ask cancels the first. */
    if (open) close(kind === 'prompt' ? null : false);
    ensureStyle();

    var back = document.createElement('div');
    back.className = 'wm-ask-back';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');

    var isPrompt = kind === 'prompt';
    var okLabel = o.ok || (kind === 'tell' ? 'OK' : isPrompt ? 'Save' : 'Yes');
    var cancelLabel = o.cancel || 'Cancel';

    back.innerHTML =
      '<div class="wm-ask">'
      + '<div class="wm-ask-body">'
        + (o.title ? '<p class="wm-ask-t">' + esc(o.title) + '</p>' : '')
        + '<p class="wm-ask-m">' + esc(message) + '</p>'
        + (isPrompt
            ? '<input class="wm-ask-in" id="wm-ask-input" type="' + esc(o.type || 'text') + '"'
              + (o.inputmode ? ' inputmode="' + esc(o.inputmode) + '"' : '')
              + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '')
              + (o.step ? ' step="' + esc(o.step) + '"' : '')
              + '>'
            : '')
      + '</div>'
      + '<div class="wm-ask-row">'
        + (kind === 'tell' ? '' : '<button type="button" class="wm-ask-b" data-no>' + esc(cancelLabel) + '</button>')
        + '<button type="button" class="wm-ask-b ' + (o.danger ? 'danger' : 'go') + '" data-yes>' + esc(okLabel) + '</button>'
      + '</div></div>';

    var resolve;
    var p = new Promise(function (r) { resolve = r; });
    var prevOverflow = document.body.style.overflow;
    open = { el: back, resolve: resolve, prevOverflow: prevOverflow,
             key: function (e) {
               if (e.key === 'Escape') { e.preventDefault(); close(isPrompt ? null : kind === 'tell'); }
               else if (e.key === 'Enter' && isPrompt) { e.preventDefault(); yes(); }
             } };

    function yes() {
      if (!isPrompt) return close(true);
      var v = back.querySelector('#wm-ask-input').value;
      close(v);
    }
    back.querySelector('[data-yes]').addEventListener('click', yes);
    var no = back.querySelector('[data-no]');
    if (no) no.addEventListener('click', function () { close(isPrompt ? null : false); });
    /* Tapping the scrim is cancelling, the way every other sheet in this app
       behaves — but only the scrim, never the card. */
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(isPrompt ? null : kind === 'tell'); });

    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', open.key, true);

    if (isPrompt) {
      var input = back.querySelector('#wm-ask-input');
      if (o.value !== undefined && o.value !== null) input.value = o.value;
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 30);
    } else {
      setTimeout(function () { try { back.querySelector('[data-yes]').focus(); } catch (e) {} }, 30);
    }
    return p;
  }

  global.WMAsk = {
    confirm: function (m, o) { return ask('confirm', m, o); },
    prompt:  function (m, o) { return ask('prompt', m, o); },
    tell:    function (m, o) { return ask('tell', m, o); },
    /* For a flow that needs more than yes/no — "card, cash, or neither". */
    choose:  function (m, choices, o) {
      var opts = o || {};
      return ask('confirm', m, Object.assign({}, opts, { ok: choices[0].label, cancel: choices[1].label }))
        .then(function (yes) { return yes ? choices[0].value : choices[1].value; });
    }
  };
})(window);
