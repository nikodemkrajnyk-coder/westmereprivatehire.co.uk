/* RENDERING THE BOOKING PAGE THE WAY THE CUSTOMER'S PHONE DOES.
   Chrome, headless, at phone width, with BOTH halves of a dark client:
   prefers-color-scheme: dark, and `--force-dark-mode` plus Auto Dark Mode for
   Web Contents — the Android feature that repaints a light-only site itself.
   That second half is the one that produced the black boxes; emulating the
   media query alone renders the page perfectly and proves nothing.

   Returns the elements that come out dark-on-dark (or light-on-light): tag,
   class, the ratio, and what it says. An empty array is the pass.

   Used by server/tests/booking-dark-mode.test.js, which skips it when there is
   no browser on the machine — the cascade guards there run everywhere. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

/* SERVED, NOT OPENED OFF THE DISK. book.html pulls its scripts with
   root-absolute paths — `/wm-picker.js` — which a file:// page cannot resolve:
   the date popup would simply not exist and the half of this sweep that opens
   it would quietly measure nothing. A twenty-line static server costs less
   than a guard that passes for the wrong reason. */
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
                '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serve(root) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Walk every visible element: the ink it declares against the first painted
   background above it. Anything over a background IMAGE is skipped — the
   photograph is the contrast and this cannot measure a photograph. */
const SWEEP = `(function(){
 function lum(c){var m=/rgba?\\((\\d+), ?(\\d+), ?(\\d+)(?:, ?([\\d.]+))?\\)/.exec(c);if(!m)return null;
   var a=m[4]===undefined?1:+m[4]; if(a<0.1)return null;
   var f=[+m[1],+m[2],+m[3]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});
   return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2];}
 function ground(el){var e=el;while(e&&e!==document.documentElement){var cs=getComputedStyle(e);
   if(cs.backgroundImage&&cs.backgroundImage!=='none')return {img:true};
   var l=lum(cs.backgroundColor); if(l!==null)return {l:l}; e=e.parentElement;}return {l:1};}
 var bad=[];
 document.querySelectorAll('body *').forEach(function(el){
   var r=el.getBoundingClientRect(); if(r.width<8||r.height<8)return;
   var cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none')return;
   var own=Array.prototype.filter.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim();}).length;
   var isField=/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
   if(!own&&!isField)return;
   /* A DISABLED CONTROL IS MEANT TO BE FAINT. The dates before today are greyed
      on purpose — that greyness IS the message, and WCAG exempts inactive
      components for the same reason. Anything a customer is expected to read
      or type into is still measured. */
   if(el.disabled||el.getAttribute('aria-disabled')==='true')return;
   var g=ground(el); if(g.img)return;
   var fg=lum(cs.color); if(fg===null)return;
   var ratio=(Math.max(fg,g.l)+0.05)/(Math.min(fg,g.l)+0.05);
   if(ratio<3)bad.push(el.tagName+(typeof el.className==='string'&&el.className?'.'+el.className.split(' ')[0]:'')
     +' at '+ratio.toFixed(2)+':1  ink '+cs.color+'  paper '+g.l.toFixed(3)
     +(el.textContent?('  «'+el.textContent.trim().slice(0,30)+'»'):''));
 });
 return bad;
})()`;

async function renderBookingUnderDark(fileOrUrl) {
  /* THE PORT IS THE BROWSER'S CHOICE, read back out of its own file. Derived
     from the pid it collided with a browser still shutting down from the last
     run, and this guard then attached to the wrong one and reported that the
     page had no date field. */
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wm-darkguard-'));
  let site = null, url;
  if (/^https?:/.test(fileOrUrl)) url = fileOrUrl;
  else {
    site = await serve(path.dirname(path.resolve(fileOrUrl)));
    url = 'http://127.0.0.1:' + site.address().port + '/' + path.basename(fileOrUrl);
  }
  const chrome = spawn(CHROME, [
    '--headless=new', '--force-dark-mode', '--enable-features=WebContentsForceDark',
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--disable-gpu', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' });
  let ws;
  try {
    let port = null;
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !port; i++) {
      try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim() || null; } catch (e) { /* not yet */ }
      if (!port) await sleep(150);
    }
    if (!port) throw new Error('the browser did not start');
    let target = null;
    for (let i = 0; i < 70 && !target; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        target = list.find((t) => t.type === 'page');
      } catch (e) { /* not up yet */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('the browser came up but offered no page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let n = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const send = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} })); });

    await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url });
    const out = [];
    const run = async (expr) => {
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: expr });
      if (r.result && r.result.exceptionDetails) throw new Error('page script failed: ' + (r.result.exceptionDetails.text || ''));
      return r.result.result.value;
    };
    /* WAITED FOR, not slept at. A fixed delay passes on a fast morning and
       reports an empty page on a slow one. */
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = !!(await run("!!document.querySelector('form[data-booking-form] .wm-field')"));
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('the booking form never finished loading (no date field after 15s)');
    out.push.apply(out, (await run(SWEEP)) || []);
    /* …and with the date popup open, which is the surface he photographed.
       Proved open before it is measured: a click that found nothing would have
       this sweep reporting a clean page it never looked at. */
    const opened = await run(
      "(function(){var f=document.querySelector('form[data-booking-form] .wm-field');"
      + "if(!f) return 'no date field — wm-picker.js did not load';"
      + "f.click(); return document.querySelector('.wm-pop') ? 'open' : 'the popup did not open';})()");
    if (opened !== 'open') throw new Error('could not open the date popup: ' + opened);
    await sleep(700);
    out.push.apply(out, (await run(SWEEP)) || []);
    return out;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    chrome.kill();
    if (site) site.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { renderBookingUnderDark };
