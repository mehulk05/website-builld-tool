// Shared elegant, subtle motion layer — dependency-free (CSS + IntersectionObserver).
// Luxury feel: gentle rise-fades, staggered children, soft hovers, hero parallax,
// nav shrink on scroll. Respects prefers-reduced-motion.
export const MOTION_CSS = `
  @media (prefers-reduced-motion: no-preference){
    [data-reveal]{opacity:0;transform:translateY(26px);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}
    [data-reveal].in{opacity:1;transform:none}
    .hero-bg img,.hero-media img{will-change:transform}
    header{transition:padding .4s ease,box-shadow .4s ease,background .4s ease}
    header.shrink{box-shadow:0 6px 30px rgba(0,0,0,.06)}
  }
  a,.btn,.card,.member,.tab{transition:all .35s cubic-bezier(.2,.7,.2,1)}
`;

export const MOTION_JS = `
<script>
(function(){
  var rm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // staggered reveal on scroll
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }});
  }, {threshold:.12, rootMargin:'0px 0px -8% 0px'});
  document.querySelectorAll('section, footer').forEach(function(sec){
    var kids = sec.querySelectorAll('.card,.member,.quote,.feat article,.about-copy,.about-img,.center,.hero .wrap > *,.stat');
    var group = kids.length ? kids : [sec];
    group.forEach(function(el,i){ if(rm) return; el.setAttribute('data-reveal',''); el.style.transitionDelay=(Math.min(i,6)*90)+'ms'; io.observe(el); });
  });
  // hero parallax + nav shrink
  var hero = document.querySelector('.hero-bg img, .hero-media img');
  var head = document.querySelector('header');
  function onScroll(){
    var y = window.scrollY||0;
    if(hero && !rm) hero.style.transform = 'translateY('+(y*0.18)+'px) scale(1.06)';
    if(head) head.classList.toggle('shrink', y>20);
  }
  window.addEventListener('scroll', onScroll, {passive:true}); onScroll();
})();
</script>`;
