/**
 * Westmere real-time client
 * ─────────────────────────
 * Opens a long-lived Server-Sent Events connection to /api/events and:
 *   - plays a soft chime
 *   - shows a toast (uses page's window.showToast() if it exists,
 *     otherwise falls back to a built-in floating pill)
 *   - triggers a desktop Notification (after the user has granted permission
 *     once via the small "Enable alerts" prompt)
 *   - dispatches `wm:event` on window so each page can re-fetch data
 *
 * Page-level usage:
 *   window.addEventListener('wm:event', function(e){
 *     if (e.detail.name === 'booking:created') reloadMyBookings();
 *   });
 *
 * Auto-reconnects on drop. Safe to include from every staff page.
 */
(function(){
  if (window.__WMRT__) return;
  window.__WMRT__ = true;

  var ROLE_LABEL = { admin:'Admin', owner:'Owner', driver:'Driver' };

  // ── Tiny chime via Web Audio (no asset needed) ──────────────────────────
  var _audioCtx = null;
  function chime(){
    try{
      _audioCtx = _audioCtx || new (window.AudioContext||window.webkitAudioContext)();
      // Two-note "ding"
      [880, 1320].forEach(function(freq, i){
        var o = _audioCtx.createOscillator();
        var g = _audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.value = 0;
        o.connect(g); g.connect(_audioCtx.destination);
        var t0 = _audioCtx.currentTime + i*0.14;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.start(t0); o.stop(t0 + 0.34);
      });
    }catch(e){/* user hasn't interacted yet — silent */}
  }

  // ── Built-in fallback toast (only used if page has no showToast) ────────
  function fallbackToast(msg, kind){
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed','top:1.2rem','right:1.2rem','z-index:99999',
      'background:'+(kind==='warn'?'#9C5800':'#0D2545'),
      'color:#fff','padding:.7rem 1rem','border-radius:.5rem',
      'font:500 .85rem/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)','max-width:320px',
      'transition:opacity .3s,transform .3s','opacity:0','transform:translateY(-8px)'
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(function(){
      el.style.opacity='1'; el.style.transform='translateY(0)';
    });
    setTimeout(function(){
      el.style.opacity='0';
      setTimeout(function(){ el.remove(); }, 350);
    }, 5200);
  }
  function toast(msg, kind){
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind === 'warn' ? 'warning' : 'success'); return; } catch(e){}
    }
    fallbackToast(msg, kind);
  }

  // ── Desktop notification (best-effort) ──────────────────────────────────
  function desktopNotify(title, body){
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      var n = new Notification(title, { body: body, tag: 'wm-' + Date.now(), silent: false });
      setTimeout(function(){ try{ n.close(); }catch(e){} }, 7000);
    } catch(e){}
  }

  // ── Small "Enable alerts" pill, shown once if permission isn't decided ─
  function maybeShowPermPrompt(){
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    if (sessionStorage.getItem('wm_perm_dismissed') === '1') return;

    var pill = document.createElement('div');
    pill.style.cssText = [
      'position:fixed','bottom:1rem','right:1rem','z-index:99998',
      'background:#0D2545','color:#fff','padding:.7rem .9rem','border-radius:.6rem',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)','display:flex','gap:.7rem','align-items:center',
      'font:500 .8rem/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');
    pill.innerHTML = '<span>Get desktop alerts for new bookings?</span>'
      + '<button style="background:#B8985A;color:#0D2545;border:none;padding:.4rem .7rem;border-radius:.4rem;font:600 .78rem/1 inherit;cursor:pointer">Enable</button>'
      + '<button style="background:transparent;color:rgba(255,255,255,.6);border:none;padding:.3rem .4rem;cursor:pointer;font-size:1rem">×</button>';
    document.body.appendChild(pill);
    var btns = pill.querySelectorAll('button');
    btns[0].onclick = function(){
      Notification.requestPermission().then(function(){ pill.remove(); });
    };
    btns[1].onclick = function(){
      sessionStorage.setItem('wm_perm_dismissed','1');
      pill.remove();
    };
  }

  // ── Event handlers per event type ───────────────────────────────────────
  function handleEvent(name, payload){
    var msg, title;
    switch (name) {
      case 'booking:created':
        title = 'New booking ' + (payload.ref||'');
        msg = (payload.name||'Guest') + ' \u2014 ' + (payload.pickup||'') + ' \u2192 ' + (payload.destination||'');
        chime(); toast(title, 'ok'); desktopNotify(title, msg);
        break;
      case 'booking:confirmed':
        title = 'Confirmed by Claude';
        msg = (payload.ref||'') + (payload.reason ? ' \u2014 ' + payload.reason : '');
        toast(title + ': ' + (payload.ref||''), 'ok'); desktopNotify(title, msg);
        break;
      case 'booking:flagged':
        title = 'Booking needs attention';
        msg = (payload.ref||'') + (payload.reason ? ' \u2014 ' + payload.reason : '');
        chime(); toast(title + ': ' + (payload.ref||''), 'warn'); desktopNotify(title, msg);
        break;
      case 'booking:assigned':
        toast('Driver assigned', 'ok');
        break;
      case 'booking:declined':
        toast('Booking declined', 'warn');
        break;
      case 'job:offered':
        title = 'Job offered';
        msg = (payload.ref||'') + ' \u2014 awaiting ' + (payload.offered_driver_name||'driver');
        toast(title + ': ' + (payload.ref||''), 'ok'); desktopNotify(title, msg);
        break;
      case 'job:accepted':
        title = 'Offer accepted';
        msg = (payload.ref||'') + ' \u2014 ' + (payload.driver_name||'driver');
        chime(); toast('Accepted by ' + (payload.driver_name||'driver') + ' \u2014 ' + (payload.ref||''), 'ok');
        desktopNotify(title, msg);
        break;
      case 'job:declined':
        title = 'Offer declined';
        msg = (payload.ref||'') + ' \u2014 back to you';
        chime(); toast('Driver declined \u2014 ' + (payload.ref||''), 'warn');
        desktopNotify(title, msg);
        break;
      case 'job:offer_expired':
        title = 'Offer expired';
        msg = (payload.ref||'') + ' \u2014 no reply in 10 min';
        chime(); toast('Offer expired \u2014 ' + (payload.ref||''), 'warn');
        desktopNotify(title, msg);
        break;
      case 'booking:updated':
        // Status changed (active, completed, etc.) — silent refresh
        break;
      case 'booking:deleted':
        // Booking removed — silent refresh
        break;
      case 'job:started':
      case 'job:done':
      case 'job:cancelled':
        // Silent-ish: refresh only, no chime. Admin views will re-render.
        break;
      case 'hello':
        // First handshake — log only
        console.log('[WMRT] connected as', payload.role);
        return;
      default:
        // Unknown event — just relay it
        break;
    }
    // Let the page react (re-fetch its tables)
    try {
      window.dispatchEvent(new CustomEvent('wm:event', { detail: { name: name, payload: payload } }));
    } catch(e){}
  }

  // ── Connection lifecycle (auto-reconnect with backoff) ──────────────────
  var es = null, retry = 0;
  function connect(){
    try { es = new EventSource('/api/events', { withCredentials: true }); }
    catch(e){ scheduleReconnect(); return; }

    var EVENTS = ['hello','booking:created','booking:confirmed','booking:updated','booking:deleted','booking:flagged','booking:assigned','booking:declined',
      'job:offered','job:accepted','job:declined','job:offer_expired','job:started','job:done','job:cancelled'];
    EVENTS.forEach(function(name){
      es.addEventListener(name, function(e){
        var payload = {};
        try { payload = JSON.parse(e.data); } catch(_){}
        handleEvent(name, payload);
      });
    });
    es.onopen = function(){ retry = 0; };
    es.onerror = function(){
      try { es.close(); } catch(_){}
      es = null;
      scheduleReconnect();
    };
  }
  function scheduleReconnect(){
    retry = Math.min(retry + 1, 6);
    var wait = Math.min(30000, 1000 * Math.pow(2, retry));  // up to 30s
    setTimeout(connect, wait);
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  function boot(){
    connect();
    setTimeout(maybeShowPermPrompt, 4000);
    // Unlock the audio context on first user gesture (browsers require it)
    var unlock = function(){
      try { if (!_audioCtx) _audioCtx = new (window.AudioContext||window.webkitAudioContext)(); _audioCtx.resume && _audioCtx.resume(); } catch(e){}
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── PWA: register the service worker if available ──────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (err) {
        console.warn('[WMRT] SW registration failed:', err && err.message);
      });
    });
  }
})();
