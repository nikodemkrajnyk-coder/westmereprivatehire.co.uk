/**
 * Westmere — hero photo rotation
 * ──────────────────────────────
 * A slow crossfade between hero photographs, in the same register as the
 * reviews: long dwell, unhurried fade, nothing that draws attention to itself.
 * Timings are deliberately matched to reviews.js — 6s dwell, 1.4s fade — so the
 * two moving things on a page move at the same speed.
 *
 * TO ADD A PHOTO: put one more path in that page's data-hero-photos list. That
 * is the whole job. See DESIGN.md.
 *
 *   <section class="hero center"
 *            style="background-image:linear-gradient(...),url('assets/a.webp')"
 *            data-hero-photos="assets/a.webp | assets/b.webp | assets/c.webp">
 *
 * The FIRST photo must also stay in the inline background-image. That is what
 * paints on first load, before this file has run or if it never runs at all —
 * so the hero is never blank and never waits on JavaScript.
 *
 * WHAT IT DOES NOT DO:
 *   · one photo (or none)          → nothing. No layers, no timer, no flicker.
 *   · prefers-reduced-motion       → nothing. The single inline photo stands.
 *   · a photo that fails to load   → dropped from the rotation, silently.
 *
 * THE SCRIM IS NOT TOUCHED. Every hero carries its own gradient plus the
 * .hero:after wash, and the copy sits above both. The photo layers are inserted
 * BENEATH that, so a light photograph in the rotation cannot wash the heading
 * out — the overlay a page had over one photo is the overlay it has over all of
 * them. GUARDRAIL: server/tests/hero-rotate.test.js
 */
(function () {
  'use strict';

  var DWELL_MS = 6000;   // matches reviews.js
  var FADE_MS  = 1400;   // matches reviews.js (.review-fade.is-out)

  function list(el) {
    return (el.getAttribute('data-hero-photos') || '')
      .split('|')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // Resolve which photos actually exist before showing any of them: a 404
  // fading in as a grey rectangle is worse than one fewer photograph.
  function preload(paths, done) {
    var ok = [], pending = paths.length;
    if (!pending) return done(ok);
    paths.forEach(function (src, i) {
      var img = new Image();
      img.onload = function () { ok[i] = src; if (!--pending) done(ok.filter(Boolean)); };
      img.onerror = function () { if (!--pending) done(ok.filter(Boolean)); };
      img.src = src;
    });
  }

  // THE PAGE'S OWN SCRIM HAS TO TRAVEL WITH THE PHOTOGRAPHS.
  //
  // Each hero's inline background-image is a gradient AND a photo in one
  // declaration — and that gradient is tuned per page (the home hero is a
  // .42→.50 wash, services is a 90deg .66→.25). The photo layers are children,
  // so they paint OVER that inline background: the rotation would have kept
  // only the much lighter shared .hero:after wash, and a bright photograph came
  // out with the tagline barely readable on it. Caught on the countryside shot.
  //
  // So each layer is given the same gradient in front of its own photo. Now the
  // overlay a page had over one photograph really is the overlay it has over
  // every photograph.
  function scrimOf(el) {
    var bg = (el.style && el.style.backgroundImage) || '';
    var out = [], depth = 0, start = -1;
    for (var i = 0; i < bg.length; i++) {
      if (bg.slice(i, i + 16) === 'linear-gradient(' && depth === 0) { start = i; }
      if (bg[i] === '(') depth++;
      else if (bg[i] === ')') { depth--; if (depth === 0 && start !== -1) { out.push(bg.slice(start, i + 1)); start = -1; } }
    }
    return out.length ? out.join(', ') + ', ' : '';
  }

  function rotate(el, photos) {
    // Two stacked layers: one showing, one waiting with the next photo already
    // decoded. Crossfading opacity between them costs no layout and no repaint
    // of the copy above.
    var layers = [0, 1].map(function () {
      var d = document.createElement('div');
      d.className = 'hero-photo';
      el.insertBefore(d, el.firstChild);
      return d;
    });
    var scrim = scrimOf(el);
    layers[0].style.backgroundImage = scrim + 'url(' + photos[0] + ')';
    layers[0].classList.add('is-on');

    var idx = 0, front = 0, timer = null;
    function step() {
      idx = (idx + 1) % photos.length;
      var back = 1 - front;
      layers[back].style.backgroundImage = scrim + 'url(' + photos[idx] + ')';
      // Force a frame so the browser has the new image in place before the
      // opacity transition starts, or the first swap can appear to jump.
      void layers[back].offsetWidth;
      layers[back].classList.add('is-on');
      layers[front].classList.remove('is-on');
      front = back;
    }
    function start() { if (!timer) timer = setInterval(step, DWELL_MS + FADE_MS); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    // A hero the visitor cannot see should not be animating: it costs battery
    // on a phone and achieves nothing.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') start(); else stop();
    });
    start();
  }

  function init() {
    var reduce = false;
    try {
      reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}
    if (reduce) return;                       // the inline photo stands,静 and still

    var heroes = document.querySelectorAll('[data-hero-photos]');
    for (var i = 0; i < heroes.length; i++) {
      (function (el) {
        var photos = list(el);
        if (photos.length < 2) return;        // one photo is a photo, not a slideshow
        preload(photos, function (ok) { if (ok.length > 1) rotate(el, ok); });
      })(heroes[i]);
    }
  }

  // After load, never before: the hero's inline background has already painted,
  // and decoding three photographs must not compete with first paint.
  if (document.readyState === 'complete') setTimeout(init, 0);
  else window.addEventListener('load', function () { setTimeout(init, 0); });
})();
