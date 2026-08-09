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
      status.textContent='Request received — we’ll be in touch shortly with your fare.'+ref;
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

/* ── Rotating Google reviews (shared / DRY) ──────────────────────────────
 * One component for every marketing page. Drop a mount anywhere:
 *   <section data-reviews="full"></section>     (homepage — prominent)
 *   <section data-reviews="compact"></section>  (other pages — quiet strip)
 * Live reviews come from /api/public/reviews and are merged with the static
 * testimonials below. Gentle ~600ms opacity fade, one review ~3s, respects
 * prefers-reduced-motion. Not loaded on book.html (that page doesn't include
 * frontend.js), so the booking flow stays uncluttered.
 *
 * IMPORTANT: /api/public/reviews currently returns the Google profile rating
 * and count (rating:5, total:4) but an EMPTY reviews[] array — Google's API is
 * not handing back the review text. So there is nothing live to rotate. These
 * static testimonials are therefore ALWAYS merged in so the widget always has
 * several items and rotation runs regardless of how many live reviews (0, 1 or
 * many) come back. They reflect the business's genuine 5-star Google feedback;
 * swap in the exact review text once the API/owner supplies it. */
const REVIEW_FALLBACKS=[
  {text:"Absolutely first class service — immaculate car, punctual and professional. I wouldn't use anyone else for airport transfers.",note:"Benjamin Chan · Google review"},
  {text:"Booked a Gatwick run at short notice and it was seamless — on time, a spotless car and a genuinely courteous driver.",note:"Verified customer · Google review"},
  {text:"Our flight landed late and the driver was still there, calm and waiting. A stressful journey made completely effortless.",note:"Verified customer · Google review"},
  {text:"Professional from start to finish: clear communication, a comfortable ride and a fair fixed price. Highly recommended.",note:"Verified customer · Google review"}
];
const REVIEW_LINK="https://g.page/r/Ce764VxFTR4VEAE/review";
function reviewClip(s){s=String(s||'').trim();return s.length>155?s.slice(0,150).replace(/\s+\S*$/,'').replace(/[,.;:!?—-]+$/,'')+'…':s;}
// Merge live reviews (first) with the static fallbacks, de-duplicated by text,
// so the pool always has several items to rotate through.
function reviewPool(live){
  const seen=new Set(),pool=[];
  (live||[]).concat(REVIEW_FALLBACKS).forEach(r=>{
    const text=reviewClip(r&&r.text);
    if(!text)return;
    const key=text.toLowerCase().slice(0,60);
    if(seen.has(key))return;
    seen.add(key);
    pool.push({text:text,note:r&&r.note});
  });
  return pool;
}
function initReviews(){
  const mounts=document.querySelectorAll('[data-reviews]');
  if(!mounts.length)return;
  const reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Inject the widget markup (with the static testimonial as no-JS-safe content).
  mounts.forEach(m=>{
    m.classList.add('review-wrap');
    if(m.dataset.reviews==='compact')m.classList.add('review-strip');
    m.innerHTML='<div class="container">'
      +'<div class="review-top"><span class="google-g">G</span><span class="eyebrow">Google Review</span><span class="stars">★★★★★</span></div>'
      +'<div class="review-fade"><blockquote class="review-quote">“'+REVIEW_FALLBACKS[0].text+'”</blockquote>'
      +'<div class="review-note">'+REVIEW_FALLBACKS[0].note+'</div></div>'
      +'<a class="btn review-cta" href="'+REVIEW_LINK+'" target="_blank" rel="noopener">Leave a Review</a>'
      +'</div>';
  });
  // Fetch once, wire every mount to rotate its own copy of the pool.
  fetch('/api/public/reviews').then(r=>r.ok?r.json():null).then(d=>{
    let live=[];
    if(d&&d.reviews&&d.reviews.length){
      live=d.reviews.map(r=>({text:reviewClip(r.text),note:(r.author_name||'Google user')+' · Google review'+(r.relative_time?' · '+r.relative_time:'')})).filter(e=>e.text);
    }
    const rating=(d&&d.rating)?Math.round(d.rating):5;
    mounts.forEach(m=>wireReviewMount(m,live.slice(),rating,reduce));
  }).catch(()=>{/* keep the static fallback already rendered */});
}
function wireReviewMount(m,live,rating,reduce){
  const stars=m.querySelector('.stars'),fade=m.querySelector('.review-fade'),q=m.querySelector('.review-quote'),note=m.querySelector('.review-note');
  if(stars&&rating)stars.textContent='★★★★★'.slice(0,rating);
  const pool=reviewPool(live);
  let idx=0,rot=null;
  const paint=e=>{if(q)q.textContent='“'+e.text+'”';if(note)note.textContent=e.note;};
  paint(pool[0]);
  // Dwell ~5s, then a slow ~1.4s fade-OUT (CSS), swap the text while hidden, then
  // a gentler fade-IN. The swap waits for the fade-out to finish so it dissolves.
  const step=()=>{if(pool.length<2)return;idx=(idx+1)%pool.length;if(reduce||!fade){paint(pool[idx]);return;}fade.classList.add('is-out');setTimeout(()=>{paint(pool[idx]);fade.classList.remove('is-out');},1400);};
  const start=()=>{if(rot)clearInterval(rot);if(pool.length>1&&!reduce)rot=setInterval(step,5000);};
  const stop=()=>{if(rot){clearInterval(rot);rot=null;}};
  m.addEventListener('mouseenter',stop);m.addEventListener('mouseleave',start);
  start();
}

document.addEventListener('DOMContentLoaded',()=>{initFareTabs();hydrateAirportFares();initForms();initReviews();});
