/* ── Rotating Google reviews (shared, self-booting) ──────────────────────
 * One component for every page that wants social proof. Drop a mount anywhere:
 *   <section data-reviews="full"></section>     (homepage — prominent)
 *   <section data-reviews="compact"></section>  (other pages — quiet strip)
 * Reviews come ONLY from /api/public/reviews (server-side Google Places proxy)
 * — real Google reviews, no static/placeholder testimonials, ever. Real author
 * name shown beneath each. Gentle ~1.4s fade-out, one review ~6s. Respects
 * prefers-reduced-motion.
 *   2+ real reviews -> rotate through them
 *   1 real review   -> show it, no rotation
 *   0 reviews w/text -> show the genuine rating + count only (no invented text)
 *
 * Loaded standalone (this file) so any page — including the booking page — can
 * show reviews WITHOUT pulling in the form-handling code in frontend.js. Guarded
 * so it only initialises once even if included more than once. */
(function () {
  'use strict';
  if (window.__wmReviewsBooted) return;
  window.__wmReviewsBooted = true;

  var REVIEW_LINK = "https://g.page/r/Ce764VxFTR4VEAE/review";
  function reviewClip(s){s=String(s||'').trim();return s.length>155?s.slice(0,150).replace(/\s+\S*$/,'').replace(/[,.;:!?—-]+$/,'')+'…':s;}
  function initReviews(){
    const mounts=document.querySelectorAll('[data-reviews]');
    if(!mounts.length)return;
    const reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Widget shell — real reviews (or a rating-only line) fill in after the fetch.
    mounts.forEach(m=>{
      m.classList.add('review-wrap');
      if(m.dataset.reviews==='compact')m.classList.add('review-strip');
      m.innerHTML='<div class="container">'
        +'<div class="review-top"><span class="google-g">G</span><span class="eyebrow">Google Review</span><span class="stars">★★★★★</span></div>'
        +'<div class="review-fade"><blockquote class="review-quote"></blockquote><div class="review-note"></div></div>'
        +'<a class="btn review-cta" href="'+REVIEW_LINK+'" target="_blank" rel="noopener">Leave a Review</a>'
        +'</div>';
    });
    fetch('/api/public/reviews').then(r=>r.ok?r.json():null).then(d=>{
      let reviews=[];
      if(d&&d.reviews&&d.reviews.length){
        reviews=d.reviews.map(r=>({text:reviewClip(r.text),note:String(r.author_name||'').trim()})).filter(e=>e.text);
      }
      const rating=(d&&d.rating)?d.rating:null;
      const total=(d&&d.total)?d.total:0;
      mounts.forEach(m=>wireReviewMount(m,reviews,rating,total,reduce));
    }).catch(()=>{mounts.forEach(m=>wireReviewMount(m,[],null,0,reduce));});
  }
  function wireReviewMount(m,reviews,rating,total,reduce){
    const stars=m.querySelector('.stars'),fade=m.querySelector('.review-fade'),q=m.querySelector('.review-quote'),note=m.querySelector('.review-note');
    if(stars&&rating)stars.textContent='★★★★★'.slice(0,Math.round(rating));
    // No real reviews with text -> show the genuine rating + count only. Never
    // invent a testimonial.
    if(!reviews.length){
      if(q)q.textContent='';
      if(note)note.textContent=(rating&&total)?(Number(rating).toFixed(1)+' — based on '+total+' Google review'+(total===1?'':'s')):'';
      return;
    }
    const paint=e=>{if(q)q.textContent='“'+e.text+'”';if(note)note.textContent=e.note?'— '+e.note:'';};
    let idx=0,rot=null;
    paint(reviews[0]);
    // Dwell ~6s, slow ~1.4s fade-OUT (CSS), swap while hidden, gentle fade-IN.
    const step=()=>{if(reviews.length<2)return;idx=(idx+1)%reviews.length;if(reduce||!fade){paint(reviews[idx]);return;}fade.classList.add('is-out');setTimeout(()=>{paint(reviews[idx]);fade.classList.remove('is-out');},1400);};
    const start=()=>{if(rot)clearInterval(rot);if(reviews.length>1&&!reduce)rot=setInterval(step,6000);};
    const stop=()=>{if(rot){clearInterval(rot);rot=null;}};
    m.addEventListener('mouseenter',stop);m.addEventListener('mouseleave',start);
    start();
  }

  // Expose for any page that wants to (re)hydrate manually; harmless otherwise.
  window.initReviews = initReviews;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initReviews);
  else initReviews();
})();
