/* Westmere Private Hire — public front-end behaviour
 * Wired to the existing backend:
 *   POST /api/public/book   — booking / quote request (runs the server-side fare engine)
 *   POST /api/public/quote  — live fare estimate from the real fare engine
 *   GET  /api/public/fares  — fixed airport fare tables straight from the engine
 */

function toggleMenu(){document.getElementById('mobileMenu').classList.toggle('open')}
document.addEventListener('click',e=>{const m=document.getElementById('mobileMenu');if(m&&m.classList.contains('open')&&!m.contains(e.target)&&!e.target.closest('.burger'))m.classList.remove('open')});

/* ── Airport fare tabs ─────────────────────────────────────────────────── */
function initFareTabs(){
  const buttons=document.querySelectorAll('[data-fare-tab]');
  const panels=document.querySelectorAll('[data-fare-panel]');
  buttons.forEach(b=>b.addEventListener('click',()=>{
    buttons.forEach(x=>x.classList.remove('active'));
    panels.forEach(x=>x.hidden=true);
    b.classList.add('active');
    const panel=document.querySelector('[data-fare-panel="'+b.dataset.fareTab+'"]');
    if(panel)panel.hidden=false;
  }));
}

/* ── Live airport fares from the engine (progressive enhancement) ─────────
 * The static tables in airport-transfers.html mirror the engine and remain
 * a no-JS fallback. When the API answers we refresh the numbers so the page
 * always reflects the real fare engine (server/fare-engine.js FARE_CF). */
async function hydrateAirportFares(){
  const host=document.querySelector('[data-fares-root]');
  if(!host)return;
  try{
    const r=await fetch('/api/public/fares',{headers:{'Accept':'application/json'}});
    if(!r.ok)return;
    const data=await r.json();
    if(!data||!data.towns)return;
    document.querySelectorAll('[data-fare-cell]').forEach(td=>{
      const [town,ap,dir]=td.dataset.fareCell.split(':');
      const row=data.towns[town]&&data.towns[town][ap];
      const amt=td.querySelector('[data-fare-amount]');
      if(row&&row[dir]!=null&&amt){amt.textContent='from £'+row[dir];}
    });
    host.setAttribute('data-fares-live','1');
  }catch(_){/* keep static fallback */}
}

/* ── Booking / quote request → POST /api/public/book ─────────────────────
 * Maps the design's field names onto the exact payload the server expects:
 *   name,email,phone,pickup,destination,date,time,passengers,bags,flight,
 *   fare,payment,notes,source
 * Public bookings are estimate requests: fare is left null and the server
 * runs the fare engine to attach a suggested price for the owner. */
async function submitBookingForm(form){
  const status=form.querySelector('.status');
  const fd=new FormData(form);
  const raw=Object.fromEntries(fd.entries());
  const payload={
    name:raw.name,
    email:raw.email,
    phone:raw.phone,
    pickup:raw.pickup,
    destination:raw.destination,
    date:raw.date||'',
    time:raw.time||'',
    passengers:Number(raw.passengers||1),
    bags:raw.luggage||raw.bags||'',
    flight:raw.flightNumber||raw.flight||'',
    notes:raw.notes||'',
    fare:null,
    payment:'pending',
    source:'website'
  };
  const btn=form.querySelector('button[type="submit"]');
  if(btn)btn.disabled=true;
  if(status){status.style.color='';status.textContent='Sending your request…';}
  try{
    const r=await fetch('/api/public/book',{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const d=await r.json();
    if(r.ok&&d.ok){
      const ref=d.ref?(' Your reference is '+d.ref+'.'):'';
      status.style.color='#2f6b34';
      status.textContent='Thank you for booking with us — we will be in touch shortly.'+ref;
      form.reset();
    }else{
      throw new Error(d.error||'Could not submit your request');
    }
  }catch(err){
    status.style.color='#9a2b2b';
    status.innerHTML='Sorry, we couldn’t submit that ('+(err.message||'network error')+'). Please call <a href="tel:+447930342593">07930 342 593</a> or <a href="https://wa.me/447930342593" target="_blank">WhatsApp us</a>.';
  }finally{
    if(btn)btn.disabled=false;
  }
}

/* ── Live fare estimate (book page) → POST /api/public/quote ──────────────
 * Read-only: calls the real fare engine (calculateFare/computeSuggestedFare)
 * so the customer sees a genuine estimate, clearly marked as indicative. */
async function requestEstimate(form,out){
  const pickup=(form.querySelector('[name="pickup"]')||{}).value;
  const destination=(form.querySelector('[name="destination"]')||{}).value;
  const time=(form.querySelector('[name="time"]')||{}).value;
  if(!pickup||!destination){
    out.textContent='Enter a pickup and destination for an estimate.';
    return;
  }
  out.textContent='Estimating…';
  try{
    const r=await fetch('/api/public/quote',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pickup,destination,time})
    });
    const d=await r.json();
    if(r.ok&&d.ok&&d.fare){
      const dist=d.distance_miles?(' · ~'+d.distance_miles+' mi'):'';
      out.innerHTML='<strong>Estimated fare: from £'+d.fare+'</strong>'+dist+'<br><span class="tiny muted">Indicative only — we’ll confirm the exact price with your request.</span>';
    }else{
      out.innerHTML='<span class="tiny muted">We couldn’t auto-price that route. Submit the form and we’ll send a fare by hand.</span>';
    }
  }catch(_){
    out.innerHTML='<span class="tiny muted">Estimate unavailable right now — submit the form and we’ll price it for you.</span>';
  }
}

function initForms(){
  document.querySelectorAll('form[data-booking-form]').forEach(f=>{
    f.addEventListener('submit',e=>{e.preventDefault();submitBookingForm(f);});
    const estBtn=f.querySelector('[data-estimate-btn]');
    const estOut=f.querySelector('[data-estimate-out]');
    if(estBtn&&estOut)estBtn.addEventListener('click',()=>requestEstimate(f,estOut));
  });
}

/* Rotating Google reviews were extracted into reviews.js (self-booting) so any
 * page — including the booking page — can show social proof without pulling in
 * this file's form-handling. Pages that want reviews load reviews.js directly. */

document.addEventListener('DOMContentLoaded',()=>{initFareTabs();hydrateAirportFares();initForms();});
