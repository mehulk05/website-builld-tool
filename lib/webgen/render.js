// Self-contained multi-design luxury renderer (CommonJS). BrandKit -> full HTML docs.
// Three designs (editorial / bold / minimal) ported from the medspa engine, one shared
// skeleton parameterized per design. 4 pages each (Home/Services/About/Team), real WP-path
// nav, subtle motion, adaptive (no empty placeholders). No external deps.

const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const arr = (a) => (Array.isArray(a) ? a : []);
const cover = (url) => (url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="var p=this.closest('.card-img,.photo,.about-img,.hero-media,.page-hero-bg,.hero-bg');if(p){p.remove();}else{this.remove();}" />` : "");

const SHARED = `
  *{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
  body{font-family:var(--sans);color:var(--body);background:var(--white);font-weight:300;line-height:1.8;font-size:15px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
  img{max-width:100%;display:block}a{color:inherit;text-decoration:none}
  .wrap{max-width:var(--wrap);margin:0 auto;padding:0 28px}
  h1,h2,h3{font-family:var(--serif);color:var(--ink);font-weight:300;letter-spacing:.5px;line-height:1.1}
  .eyebrow{font-family:var(--sans);font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);font-weight:500;margin-bottom:18px}
  .btn{display:inline-block;font-family:var(--sans);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:14px 34px;border:1px solid var(--ink);color:var(--ink);background:transparent;cursor:pointer}
  .btn:hover{background:var(--ink);color:#fff}.btn--light{border-color:#fff;color:#fff}.btn--light:hover{background:#fff;color:var(--ink)}
  .page-hero{position:relative;min-height:44vh;display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;overflow:hidden;padding:90px 0}
  .page-hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#3a352e,#6b5d49);z-index:-2}
  .page-hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.5}
  .page-hero::after{content:"";position:absolute;inset:0;background:rgba(20,17,13,.5);z-index:-1}
  .page-hero .eyebrow{color:#e6d8c4}.page-hero h1{color:#fff;max-width:820px}
  @media (prefers-reduced-motion: no-preference){
    [data-reveal]{opacity:0;transform:translateY(26px);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}
    [data-reveal].in{opacity:1;transform:none}header{transition:box-shadow .4s ease}header.shrink{box-shadow:0 6px 30px rgba(0,0,0,.08)}
  }
  a,.btn,.card,.member{transition:all .35s cubic-bezier(.2,.7,.2,1)}
  .hero-bg img,.page-hero-bg img{will-change:transform}
  @media (prefers-reduced-motion: no-preference){
    [data-reveal].in{transition-timing-function:cubic-bezier(.2,.7,.2,1)}
    .card:hover{box-shadow:0 26px 50px -30px rgba(0,0,0,.35)}
  }
  .gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .gcell{aspect-ratio:1;overflow:hidden;background:var(--line)}
  .gcell img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.gcell:hover img{transform:scale(1.06)}
  @media(max-width:700px){.gallery{grid-template-columns:repeat(2,1fr)}}
  /* sub-page sections — all driven by theme vars so they match the home design */
  .svc-menu{display:grid;gap:0;border-top:1px solid var(--line);max-width:960px;margin:56px auto 0}
  .svc-row{display:grid;grid-template-columns:auto 1fr auto;gap:30px;align-items:center;padding:30px 6px;border-bottom:1px solid var(--line)}
  .svc-row .svc-n{font-family:var(--serif);font-size:24px;color:var(--accent);line-height:1}
  .svc-row h3{font-size:26px;margin-bottom:6px}.svc-row p{color:var(--body);max-width:56ch}
  @media(max-width:640px){.svc-row{grid-template-columns:1fr;gap:10px}.svc-row .btn{justify-self:start}}
  .values{display:grid;grid-template-columns:repeat(3,1fr);gap:34px;max-width:1000px;margin:56px auto 0}
  .value{text-align:center;padding:0 12px}.value h3{font-size:28px;margin-bottom:12px}.value p{color:var(--body)}
  @media(max-width:760px){.values{grid-template-columns:1fr;gap:26px}}
  .contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:start;max-width:1060px;margin:0 auto;text-align:left}
  .contact-info .row{padding:22px 0;border-bottom:1px solid var(--line)}
  .contact-info dt{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
  .contact-info dd{font-family:var(--serif);font-size:21px;color:var(--ink)}
  .contact-map{aspect-ratio:4/3;border:1px solid var(--line);overflow:hidden;background:var(--cream)}
  .contact-map iframe{width:100%;height:100%;border:0;display:block}
  @media(max-width:760px){.contact-grid{grid-template-columns:1fr;gap:34px}}
  .ci-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 26px;margin-top:30px}
  .ci-card{display:flex;gap:15px;align-items:flex-start;padding:18px 0;border-top:1px solid var(--line)}
  .ci-card .ci-ic{font-size:17px;color:var(--accent);line-height:1.5}
  .ci-card dt{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:5px}
  .ci-card dd{font-family:var(--serif);font-size:19px;color:var(--ink);line-height:1.3}
  .contact-map--wide{aspect-ratio:auto;height:440px;border-radius:2px}
  @media(max-width:640px){.ci-grid{grid-template-columns:1fr}}
  /* premium footer */
  footer .foot-top{display:grid;grid-template-columns:1.7fr 1fr 1fr 1.3fr;gap:46px;margin-bottom:46px}
  .foot-logo{max-height:54px;max-width:200px;width:auto;object-fit:contain;margin-bottom:20px;background:rgba(255,255,255,.94);padding:10px 16px;border-radius:6px}
  .foot-brand>p{max-width:34ch;opacity:.85;line-height:1.7}
  .socials{display:flex;gap:12px;margin-top:24px}
  .soc{width:38px;height:38px;border:1px solid rgba(255,255,255,.26);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;letter-spacing:.5px;font-weight:500}
  .soc:hover{background:var(--accent);border-color:var(--accent);color:#1a1a1a}
  @media(max-width:820px){footer .foot-top{grid-template-columns:1fr 1fr;gap:34px}}
  @media(max-width:520px){footer .foot-top{grid-template-columns:1fr}}
`;

// ---- PREMIUM POLISH LAYER (Option 2) — appended AFTER the per-design CSS so it
// lifts the baseline of every design toward an editorial, ruma-grade feel:
// bigger type scale, generous whitespace, refined image treatments + motion. ----
const PREMIUM = `
  :root{--wrap:1240px}
  body{font-size:16px;line-height:1.75;letter-spacing:.002em}
  h1{letter-spacing:-.022em;line-height:1.02}
  h2{letter-spacing:-.012em;line-height:1.08}
  .wrap{padding:0 clamp(22px,3.4vw,44px)}
  .section{padding:clamp(52px,6.5vw,96px) 0}
  main>section+section{padding-top:clamp(40px,5vw,72px)}
  .center{max-width:720px;margin:0 auto clamp(34px,4vw,52px)}
  .center h2{margin-top:12px}
  /* header: logo LEFT (like ruma.com), nav + CTA grouped right — not centered */
  .nav{justify-content:flex-start !important;gap:clamp(20px,3vw,48px)}
  .nav .logo{order:-1;margin-right:auto;text-align:left;white-space:nowrap;font-size:clamp(16px,1.7vw,23px);letter-spacing:2px;line-height:1.1}
  .nav .logo span{text-align:left;letter-spacing:3px}
  .nav>ul#menu{order:0}.nav .nav-right{order:1}
  .nav-right{display:flex;align-items:center;gap:clamp(16px,2vw,30px)}
  .eyebrow{font-size:11px;letter-spacing:.34em;opacity:.92}
  .eyebrow::before{content:"— ";opacity:.55}
  .btn{padding:16px 42px;font-size:11px;letter-spacing:.2em;border-radius:2px;transition:all .4s cubic-bezier(.2,.7,.2,1)}
  .hero p{font-size:1.14rem;line-height:1.7;max-width:34ch}
  .hero h1{margin-bottom:.5em}
  /* editorial image treatments — soft radius, portrait crops, depth */
  .about-img,.card-img,.gcell,.hero-media,.contact-map{border-radius:4px}
  .about-img{aspect-ratio:4/5;box-shadow:0 46px 100px -54px rgba(50,38,22,.55);overflow:hidden}
  .about-img img{transition:transform 1.1s cubic-bezier(.2,.7,.2,1)}
  .about:hover .about-img img,.about-grid:hover .about-img img{transform:scale(1.045)}
  .about-grid{gap:clamp(44px,6vw,96px);align-items:center}
  /* flex-center so an incomplete last row (e.g. 4 cards in a 3-col) doesn't strand a lonely card */
  .cards{display:flex;flex-wrap:wrap;justify-content:center;gap:clamp(22px,2.4vw,36px)}
  .cards>*{flex:1 1 320px;max-width:400px}
  .card{border-radius:5px;overflow:hidden}.card-img{aspect-ratio:3/4}
  .card:hover{transform:translateY(-9px)}
  .svc-row{padding:34px 8px}.svc-row h3{font-size:clamp(24px,2.3vw,32px)}
  .testi{padding:clamp(94px,11vw,152px) 0}
  .quote{padding:clamp(34px,4vw,52px)}
  .value h3{letter-spacing:-.01em}
  @media(min-width:1100px){ .about-grid{grid-template-columns:1.05fr 1fr} }
`;

// ---- LUXE POLISH LAYER — the craft details that read as "expensive": refined
// motion, a unified warm image treatment with an arched editorial mask, hairline
// gold micro-details, and restrained accent use. Appended last so it wins. ----
const LUXE = `
  /* 1 — refined motion: slower, buttery easing + gentle image parallax settle */
  @media (prefers-reduced-motion: no-preference){
    [data-reveal]{opacity:0;transform:translateY(30px);transition:opacity 1.15s cubic-bezier(.16,.84,.34,1),transform 1.15s cubic-bezier(.16,.84,.34,1)}
    [data-reveal].in{opacity:1;transform:none}
    a,.btn{transition:all .45s cubic-bezier(.16,.84,.34,1)}
  }
  /* 2 — unified image treatment: warm overlay, gentle grade, arched editorial mask */
  .about-img,.card-img,.gcell,.hero-media{position:relative;overflow:hidden}
  .about-img img,.card-img img,.gcell img,.hero-media img{filter:saturate(.97) contrast(1.02)}
  .about-img::after,.card-img::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(43,32,18,0) 58%,rgba(43,32,18,.18));mix-blend-mode:multiply}
  /* arched editorial mask ONLY on large split photos; cards get a clean radius that
     matches the card (a rounded image inside a square-corner card looked broken). */
  .about-img{border-radius:clamp(64px,9vw,120px) clamp(64px,9vw,120px) 5px 5px}
  .card{border-radius:16px !important;overflow:hidden}
  .card-img{border-radius:0}
  /* 3 — micro-details: hairline rule under centered headings, hover-underline nav, small-caps labels */
  .center h2::after{content:"";display:block;width:52px;height:1px;background:var(--accent);opacity:.65;margin:22px auto 0}
  .eyebrow{font-variant:all-small-caps;letter-spacing:.36em}
  .nav ul a{position:relative;padding-bottom:3px}
  .nav ul a::after{content:"";position:absolute;left:0;bottom:0;width:0;height:1px;background:var(--accent);transition:width .45s cubic-bezier(.16,.84,.34,1)}
  .nav ul a:hover::after{width:100%}
  .btn{position:relative;border-radius:1px}
  .svc-row{transition:background .45s ease,padding-left .45s ease}
  .svc-row:hover{background:linear-gradient(90deg,rgba(0,0,0,.02),transparent);padding-left:16px}
  .svc-row .svc-n{transition:color .4s} .svc-row:hover .svc-n{color:var(--ink)}
  .quote{position:relative} .quote::before{content:"\\201C";position:absolute;top:8px;left:20px;font-family:var(--serif);font-size:72px;line-height:1;color:var(--accent);opacity:.18}
  /* 4 — restrained colour: only pin headings on KNOWN-LIGHT card surfaces to ink.
     Never touch section bands (.testi/.cats/.band/.final) — those are dark in some
     designs and light in others, and each design already colours its own text; a
     universal override made a light-background testimonials heading white → invisible. */
  .card h3,.svc-row h3,.value h3{color:var(--ink)}
  /* 5 — luxe richness pass: statement typography, alternating section tints, deeper
     hero grade, filled-gold primary CTA — the page reads composed, not flat. */
  .hero h1,.page-hero h1{font-size:clamp(46px,6.4vw,92px);line-height:1.0;letter-spacing:-.024em}
  .hero .eyebrow,.page-hero .eyebrow{margin-bottom:22px}
  .hero::after{background:linear-gradient(90deg,rgba(22,17,11,.62),rgba(22,17,11,.12) 62%,rgba(22,17,11,0))}
  .page-hero::after{background:linear-gradient(180deg,rgba(22,17,11,.34),rgba(22,17,11,.6))}
  main>section:nth-of-type(even):not(.testi):not(.cats):not(.cta){background:var(--cream)}
  main>section{border-top:1px solid transparent}
  main>section:not(:first-child):not(.testi):not(.cats):not(.cta){border-top-color:var(--line)}
  /* filled-gold CTA only on light sections (ink text guarantees contrast); the hero
     stays outlined — a light client accent (e.g. NUVO's #F4EFEA) filled on a dark
     hero washed the button out. */
  .cta .btn{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .cta .btn:hover{background:transparent;color:var(--ink);border-color:var(--ink)}
  /* white-outline hero button only on DARK (overlay/bottom) heroes; the luxe split
     hero is LIGHT, so it gets an ink outline with an accent fill on hover. */
  .hero:not(.hero--split) .btn{background:transparent;border-color:#fff;color:#fff}
  .hero:not(.hero--split) .btn:hover{background:#fff;color:var(--ink)}
  .hero--split .btn{background:transparent;border-color:var(--ink);color:var(--ink)}
  .hero--split .btn:hover{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .hero--split .eyebrow{color:var(--accent)}
  .hero--split p,.hero--split .hero-lead{color:var(--body);max-width:42ch}
  h2{font-size:clamp(34px,4.6vw,58px)}
  .svc-row h3,.card h3{font-weight:400}
  .center>p{font-size:1.06rem;color:var(--body)}
`;

const CSS_EDITORIAL = `
  h1{font-size:clamp(44px,6vw,72px)} h2{font-size:clamp(34px,5vw,60px)} h3{font-size:clamp(22px,3vw,30px)}
  .topbar{background:var(--ink);color:#cbb8a3;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-align:center;padding:9px}
  header{position:sticky;top:0;z-index:50;background:var(--cream);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:78px}
  .nav ul{list-style:none;display:flex;gap:26px}.nav ul a{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ink)}.nav ul a:hover{color:var(--accent)}
  .logo{font-family:var(--serif);font-size:30px;letter-spacing:6px;color:var(--ink)}.logo span{font-size:9px;letter-spacing:4px;display:block;text-align:center;font-family:var(--sans);color:var(--accent)}
  .nav-right{display:flex;align-items:center;gap:22px}.phone{font-size:13px;color:var(--ink)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1.5px;background:var(--ink)}
  .hero{position:relative;min-height:88vh;display:flex;align-items:center;color:#fff;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#3a352e,#6b5d49);z-index:-2}.hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.6}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(30,26,20,.55),rgba(30,26,20,.15));z-index:-1}
  .hero .wrap{width:100%}.hero .eyebrow{color:#e6d8c4}.hero h1{color:#fff;max-width:640px;margin:14px 0 26px}.hero p{max-width:520px;color:#f2ece2;margin-bottom:32px}
  .about{background:var(--cream);padding:100px 0}.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:70px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:820px;margin:0 auto;text-align:center}.about-grid.solo .about-copy p{max-width:640px;margin:0 auto 20px}
  .about-copy p{margin-bottom:20px}.about-img{aspect-ratio:5/6;background:linear-gradient(135deg,#d8c9b4,#b7a488);overflow:hidden}.about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--ink);color:#e6d8c4;padding:26px 0}.strip .wrap{display:flex;flex-wrap:wrap;justify-content:center;gap:14px 46px;font-size:12px;letter-spacing:2px;text-transform:uppercase}
  .section{padding:100px 0}.center{text-align:center;max-width:760px;margin:0 auto 56px}.center p{margin-top:22px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}.card{background:var(--cream);border:1px solid var(--line);padding:0 0 34px}.card:hover{transform:translateY(-6px)}
  .card-img{aspect-ratio:4/3;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover}
  .card--text{padding-top:20px}.card--text h3{border-top:2px solid var(--accent);padding-top:24px;display:inline-block;margin-left:26px}
  .card-body{padding:28px 26px 0}.card h3{margin-bottom:14px}.card .btn{margin-top:22px}
  .providers{background:var(--cream)}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:26px;max-width:1000px;margin:0 auto}
  .member .photo{aspect-ratio:3/4;overflow:hidden;margin-bottom:18px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:24px;line-height:1;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--ink);color:#f2ece2;padding:110px 0}.testi .eyebrow{color:#cbb8a3}.testi h2{color:#fff}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:34px;margin-top:52px}.quote{border:1px solid #4a4339;padding:36px 34px}
  .quote h4{font-family:var(--serif);font-size:22px;color:#fff;margin-bottom:16px}.quote p{font-size:14px;color:#d6cdbf;margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#cbb8a3}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);margin-top:56px;border:1px solid var(--line)}.feat article{padding:44px 36px;border-right:1px solid var(--line)}.feat article:last-child{border-right:none}
  .feat h3{margin-bottom:16px}.feat .btn{margin-top:24px}
  .cta{background:var(--cream);text-align:center;padding:110px 0}.cta p{max-width:560px;margin:22px auto 34px}.cta .contactline{margin-top:30px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--ink)}
  footer{background:var(--ink);color:#b7a894;padding:70px 0 34px;font-size:13px}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:14px;letter-spacing:2px;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid #4a4339;padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}.nav ul.open{display:flex;position:absolute;top:78px;left:0;right:0;background:var(--cream);flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}.feat article{border-right:none;border-bottom:1px solid var(--line)}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

const CSS_BOLD = `
  body{background:var(--ink);color:#d9d2c7}h1,h2,h3{color:#fff}
  h1{font-size:clamp(52px,8vw,104px);line-height:.98;letter-spacing:-1px}h2{font-size:clamp(38px,5.5vw,72px);letter-spacing:-.5px}h3{font-size:clamp(22px,3vw,30px)}
  .eyebrow{color:var(--accent)}.btn{border-color:#fff;color:#fff}.btn:hover{background:#fff;color:var(--ink)}
  .page-hero::after{background:rgba(15,13,10,.6)}
  header{position:sticky;top:0;z-index:50;background:rgba(20,18,15,.72);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,.08)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:84px}
  .nav ul{list-style:none;display:flex;gap:30px}.nav ul a{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#d9d2c7}.nav ul a:hover{color:var(--accent)}
  .logo{font-family:var(--serif);font-size:28px;letter-spacing:5px;color:#fff}
  .nav-right{display:flex;align-items:center;gap:20px}.phone{font-size:13px;color:#d9d2c7}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1.5px;background:#fff}
  .hero{position:relative;min-height:100vh;display:flex;align-items:flex-end;overflow:hidden;padding-bottom:9vh}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#26221c,#4a4034);z-index:-2}.hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.5}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(15,13,10,.85),rgba(15,13,10,.15) 60%);z-index:-1}
  .hero .wrap{width:100%}.hero h1{max-width:12ch;margin:16px 0 24px}.hero p{max-width:520px;color:#e6ddd0;margin-bottom:34px;font-size:17px}
  .section{padding:120px 0}
  .about{background:var(--cream);color:var(--body)}.about h2,.about h3{color:var(--ink)}
  .about-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:80px;align-items:center}.about-grid.solo{grid-template-columns:1fr;max-width:900px;margin:0 auto}
  .about-copy p{margin-bottom:22px;font-size:16px}.about-img{aspect-ratio:4/5;overflow:hidden;background:linear-gradient(135deg,#d8c9b4,#b7a488)}.about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--accent);color:#1c1811;padding:22px 0;overflow:hidden}.strip .track{display:flex;gap:60px;white-space:nowrap;font-size:13px;letter-spacing:3px;text-transform:uppercase;font-weight:500;animation:marq 28s linear infinite}
  @keyframes marq{to{transform:translateX(-50%)}}@media (prefers-reduced-motion: reduce){.strip .track{animation:none;flex-wrap:wrap;justify-content:center;white-space:normal}}
  .center{max-width:820px;margin:0 auto 64px}.center .eyebrow,.center h2{text-align:center}.center p{margin-top:22px;text-align:center;color:#b7ada0}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08)}
  .card{background:var(--ink);position:relative;overflow:hidden}.card-img{aspect-ratio:16/11;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.card:hover .card-img img{transform:scale(1.07)}
  .card-body{padding:34px 30px}.card--text .card-body{padding-top:60px}.card h3{margin-bottom:14px}.card p{color:#b7ada0}.card .btn{margin-top:24px}
  .card .idx{position:absolute;top:20px;right:24px;font-family:var(--serif);font-size:44px;color:rgba(255,255,255,.14)}
  .providers .center h2{color:#fff}.team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:24px;max-width:1040px;margin:0 auto}
  .member .photo{aspect-ratio:3/4;overflow:hidden;margin-bottom:18px;filter:grayscale(.2)}.member:hover .photo{filter:none}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:26px;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--cream);color:var(--body)}.testi h2,.testi h4{color:var(--ink)}.testi .center p{color:var(--body)}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:30px}.quote{background:#fff;border:1px solid var(--line);padding:40px 36px}.quote h4{font-family:var(--serif);font-size:24px;margin-bottom:16px}.quote p{margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:60px}.feat article{border:1px solid rgba(255,255,255,.12);padding:44px 34px}.feat h3{margin-bottom:16px}.feat p{color:#b7ada0}.feat .btn{margin-top:24px}
  .cta{text-align:center;padding:140px 0;background:radial-gradient(ellipse at center,#2c271f,var(--ink))}.cta p{max-width:560px;margin:22px auto 34px;color:#c9c0b3}.cta .contactline{margin-top:30px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  footer{background:#0f0d0a;color:#8f8578;padding:80px 0 34px;font-size:13px}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:14px;letter-spacing:2px;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid rgba(255,255,255,.1);padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}.nav ul.open{display:flex;position:absolute;top:84px;left:0;right:0;background:var(--ink);flex-direction:column;padding:20px 28px;gap:16px}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

const CSS_MINIMAL = `
  body{background:var(--white)}h1{font-size:clamp(40px,5.5vw,68px);font-weight:300}h2{font-size:clamp(30px,4vw,48px)}h3{font-size:clamp(20px,2.4vw,26px)}
  .eyebrow{letter-spacing:4px}.btn{border:none;border-bottom:1px solid var(--ink);padding:10px 2px}.btn:hover{background:transparent;color:var(--accent);border-color:var(--accent)}
  .btn--light{border-bottom:1px solid #fff}.btn--light:hover{background:transparent;color:#e6d8c4;border-color:#e6d8c4}
  header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(10px)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:90px}
  .nav ul{list-style:none;display:flex;gap:34px}.nav ul a{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--body)}.nav ul a:hover{color:var(--ink)}
  .logo{font-family:var(--serif);font-size:26px;letter-spacing:8px;color:var(--ink);font-weight:300}
  .nav-right{display:flex;align-items:center;gap:24px}.phone{font-size:12px;letter-spacing:1px;color:var(--body)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:22px;height:1px;background:var(--ink)}
  .hero{text-align:center;padding:130px 0 90px}.hero .eyebrow{margin-bottom:26px}.hero h1{max-width:16ch;margin:0 auto 28px}.hero p{max-width:520px;margin:0 auto 36px}
  .hero-media{max-width:1100px;margin:60px auto 0;aspect-ratio:16/8;overflow:hidden;padding:0 28px}.hero-media img{width:100%;height:100%;object-fit:cover}
  .section{padding:110px 0}.about{padding:40px 0 110px}.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:90px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:720px;margin:0 auto;text-align:center}.about-grid.solo p{max-width:600px;margin:0 auto 22px}
  .about-copy p{margin-bottom:22px}.about-img{aspect-ratio:1;overflow:hidden}.about-img img{width:100%;height:100%;object-fit:cover}
  .center{text-align:center;max-width:640px;margin:0 auto 70px}.center p{margin-top:22px}.hr{width:40px;height:1px;background:var(--accent);margin:0 auto 26px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-block:1px solid var(--line)}.card{background:var(--white);padding:0}
  .card-img{aspect-ratio:3/2;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .7s}.card:hover .card-img img{transform:scale(1.05)}
  .card-body{padding:36px 34px 44px;text-align:center}.card--text .card-body{padding-top:56px}.card h3{margin-bottom:14px;font-weight:300}.card p{color:var(--body)}.card .btn{margin-top:22px}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:40px;max-width:1000px;margin:0 auto;text-align:center}
  .member .photo{width:170px;height:170px;border-radius:50%;overflow:hidden;margin:0 auto 22px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:22px;font-weight:300;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--cream)}.quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}
  .quote{background:var(--cream);padding:48px 44px;text-align:center}.quote h4{font-family:var(--serif);font-size:22px;font-weight:300;margin-bottom:18px;color:var(--ink)}.quote p{margin-bottom:20px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:60px;margin-top:64px;text-align:center}.feat article{padding:0 10px}.feat h3{margin-bottom:16px;font-weight:300}.feat .btn{margin-top:22px}
  .cta{text-align:center;padding:130px 0;background:var(--cream)}.cta p{max-width:520px;margin:22px auto 34px}.cta .contactline{margin-top:30px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  footer{padding:80px 0 40px;font-size:13px;border-top:1px solid var(--line);color:var(--body)}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--sans);color:var(--ink);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:var(--ink)}
  .foot-bottom{border-top:1px solid var(--line);padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px;letter-spacing:1px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}.nav ul.open{display:flex;position:absolute;top:90px;left:0;right:0;background:#fff;flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

const CSS_AURA = `
  body{background:var(--cream)}
  h1{font-size:clamp(46px,6.2vw,80px);font-weight:400}h2{font-size:clamp(34px,4.6vw,58px);font-weight:400}h3{font-size:clamp(22px,3vw,30px);font-weight:400}
  .eyebrow{letter-spacing:3px}
  .btn{border:1px solid var(--accent);color:var(--ink);padding:15px 36px}.btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn--light{border-color:#fff;color:#fff}.btn--light:hover{background:#fff;color:var(--ink)}
  header{position:sticky;top:0;z-index:50;background:rgba(255,251,245,.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:88px}
  .nav ul{list-style:none;display:flex;gap:30px}.nav ul a{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ink)}.nav ul a:hover{color:var(--accent)}
  .logo{font-family:var(--serif);font-size:30px;letter-spacing:4px;color:var(--ink);font-weight:400}.logo span{font-size:9px;letter-spacing:4px;display:block;font-family:var(--sans);color:var(--accent)}
  .nav-right{display:flex;align-items:center;gap:22px}.phone{font-size:13px;color:var(--ink)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1.5px;background:var(--ink)}
  .hero{position:relative;min-height:92vh;display:flex;align-items:center;color:#fff;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#8a7a63,#b7a488);z-index:-2}.hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.72}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(60,50,40,.5),rgba(60,50,40,.1));z-index:-1}
  .hero .wrap{width:100%}.hero .eyebrow{color:#f0e6d6}.hero h1{color:#fff;max-width:680px;margin:14px 0 26px}.hero p{max-width:540px;color:#f6efe4;margin-bottom:32px;font-size:17px}
  .about{padding:110px 0}.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:800px;margin:0 auto;text-align:center}.about-grid.solo .about-copy p{max-width:640px;margin:0 auto 20px}
  .about-copy p{margin-bottom:20px}.about-img{aspect-ratio:4/5;overflow:hidden;box-shadow:0 30px 60px -30px rgba(90,70,50,.45)}.about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--ink);color:#e6d8c4;padding:26px 0}.strip .wrap{display:flex;flex-wrap:wrap;justify-content:center;gap:14px 46px;font-size:12px;letter-spacing:2px;text-transform:uppercase}
  .section{padding:110px 0}.center{text-align:center;max-width:720px;margin:0 auto 60px}.center p{margin-top:22px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:30px}
  .card{background:var(--white);overflow:hidden;box-shadow:0 24px 50px -32px rgba(90,70,50,.4);border:1px solid var(--line)}
  .card:hover{transform:translateY(-8px);box-shadow:0 34px 64px -30px rgba(90,70,50,.5)}
  .card-img{aspect-ratio:4/3;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .7s}.card:hover .card-img img{transform:scale(1.06)}
  .card--text{padding-top:20px}.card--text h3{color:var(--accent)}.card-body{padding:30px 28px 34px}.card h3{margin-bottom:14px}.card .btn{margin-top:22px}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:30px;max-width:1040px;margin:0 auto;text-align:center}
  .member .photo{aspect-ratio:4/5;overflow:hidden;margin-bottom:18px;box-shadow:0 20px 40px -26px rgba(90,70,50,.5)}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:24px;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--white);padding:110px 0}.quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:30px}
  .quote{background:var(--cream);padding:44px 40px;box-shadow:0 20px 44px -30px rgba(90,70,50,.35)}.quote h4{font-family:var(--serif);font-size:24px;margin-bottom:16px;color:var(--ink)}.quote p{margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:60px}.feat article{background:var(--white);border:1px solid var(--line);padding:40px 34px;box-shadow:0 20px 44px -34px rgba(90,70,50,.35)}.feat h3{margin-bottom:16px}.feat .btn{margin-top:22px}
  .cta{text-align:center;padding:120px 0;background:linear-gradient(160deg,var(--cream),#f0e6d6)}.cta p{max-width:560px;margin:22px auto 34px}.cta .contactline{margin-top:30px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  footer{background:var(--ink);color:#b7a894;padding:74px 0 34px;font-size:13px}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:16px;letter-spacing:2px;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid #4a4339;padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}.nav ul.open{display:flex;position:absolute;top:88px;left:0;right:0;background:var(--cream);flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

const CSS_CLINICAL = `
  h1{font-size:clamp(42px,5.6vw,74px);font-weight:400;letter-spacing:-.5px}h2{font-size:clamp(32px,4.4vw,54px);font-weight:400;letter-spacing:-.3px}h3{font-size:clamp(20px,2.6vw,27px);font-weight:400}
  .eyebrow{letter-spacing:2.5px;display:inline-flex;align-items:center;gap:8px}.eyebrow::before{content:"";width:22px;height:1px;background:var(--accent)}
  .btn{border-radius:6px;font-weight:500}.btn:hover{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn--light{border-color:rgba(255,255,255,.7);color:#fff}.btn--light:hover{background:#fff;color:var(--ink);border-color:#fff}
  header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:82px}
  .nav ul{list-style:none;display:flex;gap:32px}.nav ul a{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--body);font-weight:500}.nav ul a:hover{color:var(--ink)}
  .logo{font-family:var(--serif);font-size:27px;letter-spacing:2px;color:var(--ink);font-weight:500}.logo span{font-size:9px;letter-spacing:3px;display:block;font-family:var(--sans);color:var(--accent)}
  .nav-right{display:flex;align-items:center;gap:22px}.phone{font-size:13px;color:var(--ink);font-weight:500}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:2px;background:var(--ink)}
  .hero{position:relative;min-height:86vh;display:flex;align-items:center;color:#fff;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#2b3138,#4a555f);z-index:-2}.hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.62}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(20,26,32,.7),rgba(20,26,32,.2));z-index:-1}
  .hero .wrap{width:100%}.hero .eyebrow{color:#dfe6ec}.hero .eyebrow::before{background:#fff}.hero h1{color:#fff;max-width:660px;margin:14px 0 24px}.hero p{max-width:520px;color:#eef2f5;margin-bottom:32px;font-size:17px}
  .about{padding:110px 0}.about-grid{display:grid;grid-template-columns:1fr 1.05fr;gap:76px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:800px;margin:0 auto;text-align:center}.about-grid.solo .about-copy p{max-width:640px;margin:0 auto 20px}
  .about-copy p{margin-bottom:20px}.about-img{aspect-ratio:4/3;overflow:hidden;border-radius:10px;border:1px solid var(--line)}.about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--ink);color:#dfe6ec;padding:24px 0}.strip .wrap{display:flex;flex-wrap:wrap;justify-content:center;gap:14px 44px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase}
  .section{padding:104px 0}.center{text-align:center;max-width:720px;margin:0 auto 58px}.center p{margin-top:20px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
  .card{background:var(--white);border:1px solid var(--line);border-radius:12px;overflow:hidden}.card:hover{transform:translateY(-6px);border-color:var(--accent)}
  .card-img{aspect-ratio:4/3;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.card:hover .card-img img{transform:scale(1.05)}
  .card--text .card-body{padding-top:36px}.card-body{padding:28px 28px 32px}.card h3{margin-bottom:12px}.card p{color:var(--body)}.card .btn{margin-top:20px}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:26px;max-width:1040px;margin:0 auto}
  .member .photo{aspect-ratio:1;overflow:hidden;margin-bottom:18px;border-radius:12px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:23px;margin-bottom:5px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);font-weight:500}
  .testi{background:#f4f6f8;padding:104px 0}.quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:26px}
  .quote{background:var(--white);border:1px solid var(--line);border-radius:12px;padding:38px 34px}.quote h4{font-family:var(--serif);font-size:22px;margin-bottom:14px;color:var(--ink)}.quote p{margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);font-weight:500}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:56px}.feat article{border:1px solid var(--line);border-radius:12px;padding:38px 32px}.feat h3{margin-bottom:14px}.feat .btn{margin-top:22px}
  .cta{text-align:center;padding:120px 0;background:linear-gradient(160deg,#f4f6f8,var(--white))}.cta p{max-width:540px;margin:20px auto 32px}.cta .contactline{margin-top:28px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);font-weight:500}
  footer{background:var(--ink);color:#aab4bd;padding:72px 0 34px;font-size:13px}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:48px}
  footer h5{font-family:var(--sans);color:#fff;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid rgba(255,255,255,.12);padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}.nav ul.open{display:flex;position:absolute;top:82px;left:0;right:0;background:#fff;flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

// LUXE — the flagship. A bespoke editorial-luxury system (think $10k agency medspa):
// split hero with statement stacked serif + full-height arched photo in an offset
// hairline gold frame, italic serif marquee, double-framed editorial images,
// oversized pull-quote testimonials, warm layered creams. Built to feel designed,
// not templated.
const CSS_LUXE = `
  h1{font-size:clamp(52px,6.6vw,104px);line-height:.98;letter-spacing:-.02em;font-weight:400}
  h2{font-size:clamp(36px,4.8vw,64px);font-weight:400}h3{font-size:clamp(21px,2.4vw,28px)}
  .topbar{background:var(--ink);color:#d8c9ae;font-size:10px;letter-spacing:.34em;text-transform:uppercase;text-align:center;padding:10px}
  header{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--cream) 88%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:86px}
  .nav ul{list-style:none;display:flex;gap:30px}.nav ul a{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink)}
  .logo{font-family:var(--serif);font-size:26px;letter-spacing:.14em;color:var(--ink)}.logo span{font-size:8px;letter-spacing:.4em;display:block;font-family:var(--sans);color:var(--accent);margin-top:2px}
  .nav-right{display:flex;align-items:center;gap:22px}.phone{font-size:12px;letter-spacing:.06em;color:var(--ink)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1px;background:var(--ink)}
  /* split hero */
  .hero--split{background:linear-gradient(180deg,var(--cream),color-mix(in srgb,var(--cream) 86%,var(--accent)))}
  .hero-grid{display:grid;grid-template-columns:1.02fr .98fr;gap:clamp(40px,5vw,84px);align-items:center;min-height:88vh;padding-top:34px;padding-bottom:60px}
  .hero-copy .eyebrow{margin-bottom:26px}
  .hero-copy h1{color:var(--ink);margin-bottom:28px;max-width:11ch}
  .hero-lead{font-size:1.12rem;line-height:1.75;color:var(--body);max-width:42ch;margin-bottom:38px}
  .hero-actions{display:flex;align-items:center;gap:28px}
  .hero-alt{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink);border-bottom:1px solid var(--accent);padding-bottom:4px}
  .hero-media{position:relative;height:min(76vh,720px)}
  .hero-media img{width:100%;height:100%;object-fit:cover;border-radius:clamp(90px,11vw,170px) clamp(90px,11vw,170px) 6px 6px}
  .hero-frame{position:absolute;inset:-16px 16px 16px -16px;border:1px solid var(--accent);border-radius:clamp(96px,11.5vw,180px) clamp(96px,11.5vw,180px) 8px 8px;opacity:.55;pointer-events:none}
  /* marquee strip in italic serif */
  .strip{background:var(--ink);color:#e7dbc4;padding:20px 0;overflow:hidden}
  .strip .wrap{display:flex;gap:56px;justify-content:center;flex-wrap:wrap;font-family:var(--serif);font-style:italic;font-size:19px;letter-spacing:.04em}
  .section{padding:clamp(84px,10vw,150px) 0}.center{text-align:center;max-width:740px;margin:0 auto 60px}.center p{margin-top:20px}
  .about{background:var(--cream)}
  .about-grid{display:grid;grid-template-columns:1fr 1fr;gap:clamp(48px,6vw,100px);align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:800px;margin:0 auto;text-align:center}
  .about-copy p{margin-bottom:20px}
  .about-img{position:relative;aspect-ratio:4/5;overflow:hidden}.about-img img{width:100%;height:100%;object-fit:cover}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(24px,2.6vw,40px)}
  .card{background:var(--white);border:1px solid var(--line);overflow:hidden}.card:hover{transform:translateY(-8px);box-shadow:0 34px 70px -40px rgba(70,52,30,.45)}
  .card-img{aspect-ratio:3/4;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover}
  .card-body{padding:30px 28px 34px}.card h3{margin-bottom:12px}.card p{font-size:.95rem}.card .btn{margin-top:20px}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:30px;max-width:1040px;margin:0 auto}
  .member .photo{aspect-ratio:3/4;overflow:hidden;margin-bottom:16px;border-radius:clamp(48px,6vw,90px) clamp(48px,6vw,90px) 4px 4px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:22px;margin-bottom:4px}.member .role{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--ink);color:#efe6d6;padding:clamp(100px,12vw,170px) 0}
  .testi .eyebrow{color:#cdbb98}.testi h2{color:#fff}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:36px;margin-top:56px}
  .quote{border:1px solid #4a4234;padding:44px 40px}.quote h4{font-family:var(--serif);font-size:24px;color:#fff;margin-bottom:16px;font-weight:400}
  .quote p{font-family:var(--serif);font-style:italic;font-size:17px;color:#ddd2bd;margin-bottom:18px;line-height:1.6}
  .quote cite{font-style:normal;font-size:10px;letter-spacing:.26em;text-transform:uppercase;color:#cdbb98}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:56px;border:1px solid var(--line);background:var(--white)}
  .feat article{padding:46px 38px;border-right:1px solid var(--line)}.feat article:last-child{border-right:none}
  .feat h3{margin-bottom:14px}.feat .btn{margin-top:22px}
  .cta{background:linear-gradient(180deg,var(--cream),color-mix(in srgb,var(--cream) 82%,var(--accent)));text-align:center;padding:clamp(100px,12vw,170px) 0}
  .cta p{max-width:560px;margin:22px auto 36px}.cta .contactline{margin-top:28px;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink)}
  footer{background:var(--ink);color:#b3a68e;padding:74px 0 34px;font-size:13px}.foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:42px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:15px;letter-spacing:.16em;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid #453d2f;padding-top:22px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:11px;letter-spacing:.08em}
  @media(max-width:900px){.hero-grid{grid-template-columns:1fr;min-height:auto}.hero-media{height:56vh}.about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}
    .nav ul{display:none}.burger{display:flex}.feat article{border-right:none;border-bottom:1px solid var(--line)}}
`;

const DESIGNS = {
  luxe: { css: CSS_LUXE, topbar: true, logoSpan: true, strip: "marquee", hr: false, cardIdx: false, hero: "split", book: "Book a Visit" },
  editorial: { css: CSS_EDITORIAL, topbar: true, logoSpan: true, strip: "plain", hr: false, cardIdx: false, hero: "overlay", book: "Book a Visit" },
  clinical: { css: CSS_CLINICAL, topbar: false, logoSpan: true, strip: "plain", hr: false, cardIdx: false, hero: "overlay", book: "Book a Visit" },
  bold: { css: CSS_BOLD, topbar: false, logoSpan: false, strip: "marquee", hr: false, cardIdx: true, hero: "bottom", book: "Book" },
  minimal: { css: CSS_MINIMAL, topbar: false, logoSpan: false, strip: "none", hr: true, cardIdx: false, hero: "centered", book: "Book a Visit" },
  aura: { css: CSS_AURA, topbar: false, logoSpan: true, strip: "plain", hr: false, cardIdx: false, hero: "overlay", book: "Book a Visit" },
};

const MOTION_JS = `<script>
(function(){var rm=matchMedia('(prefers-reduced-motion: reduce)').matches;
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}})},{threshold:.12,rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll('section,footer').forEach(function(sec){var kids=sec.querySelectorAll('.card,.member,.quote,.feat article,.about-copy,.about-img,.center,.gcell,.hero .wrap>*,.svc-row,.value,.contact-info,.contact-map');var g=kids.length?kids:[sec];g.forEach(function(el,i){if(rm)return;el.setAttribute('data-reveal','');el.style.transitionDelay=(Math.min(i,8)*80)+'ms';io.observe(el);});});
/* FAILSAFE: if the observer never fires (some WP/theme contexts drop or misfire it),
   force every element visible after a short delay so nothing is ever stranded at
   opacity:0. Also reveal immediately anything already on-screen at load. */
function revealInView(){document.querySelectorAll('[data-reveal]:not(.in)').forEach(function(el){var r=el.getBoundingClientRect();if(r.top<innerHeight*0.95){el.classList.add('in');}});}
requestAnimationFrame(revealInView);addEventListener('scroll',revealInView,{passive:true});
setTimeout(function(){document.querySelectorAll('[data-reveal]:not(.in)').forEach(function(el){el.classList.add('in');});},1600);
var h=document.querySelector('header');
var pll=document.querySelectorAll('.hero-bg img,.page-hero-bg img');
function onScroll(){var y=scrollY||0;if(h)h.classList.toggle('shrink',y>20);if(!rm)pll.forEach(function(im){im.style.transform='translateY('+(y*0.15)+'px) scale(1.08)';});}
addEventListener('scroll',onScroll,{passive:true});onScroll();
var b=document.getElementById('burger');if(b)b.addEventListener('click',function(){document.getElementById('menu').classList.toggle('open');});})();</script>`;

// Variant knobs — orthogonal style tweaks applied ON TOP of any base design,
// so 3-4 bases × these variants = many distinct, still-polished looks.
const VARIANTS = {
  classic: { radius: "0", btn: "0", padScale: 1 },
  soft:    { radius: "16px", btn: "999px", padScale: 1 },
  airy:    { radius: "0", btn: "0", padScale: 1.28 },
  plush:   { radius: "20px", btn: "999px", padScale: 1.28 },
};
const VARIANT_IDS = Object.keys(VARIANTS);
// deterministic per-brand pick (no Date/random) so each client gets a stable, varied feel
function variantOf(kit) {
  if (kit && VARIANTS[kit.variant]) return { id: kit.variant, ...VARIANTS[kit.variant] };
  const s = ((kit && kit.brand && kit.brand.name) || "med spa");
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const id = VARIANT_IDS[h % VARIANT_IDS.length];
  return { id, ...VARIANTS[id] };
}
function variantCss(v) {
  return `
  .card,.card-img,.about-img,.hero-media,.quote,.feat article{border-radius:${v.radius}}
  .btn{border-radius:${v.btn}}
  ${v.padScale !== 1 ? `.section,.about,.cta,.testi{padding-top:calc(100px*${v.padScale});padding-bottom:calc(100px*${v.padScale})}` : ""}`;
}

function head(k, d, v) {
  const t = k.theme || {}, b = k.brand || {};
  const fonts = t.googleFontsHref || "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Montserrat:wght@300;400;500;600&display=swap";
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(b.name || "Med Spa")}</title>
<meta name="description" content="${esc((k.hero && k.hero.body) || "")}" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${esc(fonts)}" rel="stylesheet" />
<style>
  :root{--cream:${t.cream || "#fffbf5"};--white:${t.white || "#ffffff"};--ink:${t.ink || "#323232"};--body:${t.body || "#585858"};--line:${t.line || "#e5ddd2"};--accent:${t.accent || "#8a7a63"};--on-accent:${t.onAccent || "#ffffff"};--serif:"${t.serifFont || "Cormorant Garamond"}",Georgia,serif;--sans:"${t.sansFont || "Montserrat"}",sans-serif;--wrap:1200px}
  ${SHARED}${d.css}${variantCss(v || variantOf(k))}${PREMIUM}${LUXE}
</style></head><body>`;
}

function header(k, d) {
  const b = k.brand || {};
  return `${d.topbar ? `<div class="topbar">${esc(b.topbar || b.city || "")}</div>` : ""}
  <header><nav class="nav wrap">
      <ul id="menu"><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li><a href="/about/">About</a></li><li><a href="/contact/">Contact</a></li></ul>
      <a class="logo" href="/">${esc(b.name || "MED SPA")}${d.logoSpan ? `<span>${esc(b.sub || "")}</span>` : ""}</a>
      <div class="nav-right"><a class="phone" href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a><a class="btn" href="/contact/">${esc(d.book)}</a>
        <button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button></div>
  </nav></header>`;
}
const SOCIAL_GLYPH = { instagram: "IG", facebook: "f", twitter: "X", tiktok: "TT", youtube: "YT", linkedin: "in", yelp: "Y", pinterest: "P" };
function footer(k) {
  const b = k.brand || {}, s = b.social || {};
  const logo = b.logo
    ? `<img class="foot-logo" src="${esc(b.logo)}" alt="${esc(b.name || "")}" onerror="var d=document.createElement('div');d.className='logo';d.textContent='${esc(b.name || "")}';this.replaceWith(d)"/>`
    : `<div class="logo" style="margin-bottom:18px">${esc(b.name || "")}</div>`;
  const socials = Object.keys(s).filter((k2) => s[k2]).map((k2) =>
    `<a class="soc" href="${esc(s[k2])}" target="_blank" rel="noopener" aria-label="${esc(k2)}">${SOCIAL_GLYPH[k2] || "·"}</a>`).join("");
  const svc = arr(k.servicesMenu).slice(0, 5).map((x) => `<li><a href="/services/">${esc(x.name)}</a></li>`).join("") || `<li><a href="/services/">Services</a></li>`;
  const hours = k.contact && k.contact.hours;
  return `<footer><div class="wrap"><div class="foot-top">
        <div class="foot-brand">${logo}<p>${esc((k.footer && k.footer.blurb) || "")}</p>${socials ? `<div class="socials">${socials}</div>` : ""}</div>
        <div><h5>Explore</h5><ul><li><a href="/">Home</a></li><li><a href="/about/">About</a></li><li><a href="/services/">Services</a></li><li><a href="/contact/">Contact</a></li></ul></div>
        <div><h5>Services</h5><ul>${svc}</ul></div>
        <div><h5>Visit Us</h5><ul>${b.city ? `<li>${esc(b.city)}</li>` : ""}${b.phone ? `<li><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></li>` : ""}${b.email ? `<li><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>` : ""}${hours ? `<li>${esc(hours)}</li>` : ""}</ul>
          <a class="btn btn--light" style="margin-top:20px" href="/contact/">Book a Visit</a></div></div>
      <div class="foot-bottom"><span>© 2026 ${esc(b.name || "")}. All rights reserved.</span><span>Privacy · Terms · Accessibility</span></div></div></footer>`;
}
const cx = (d) => (d.hr ? `<div class="hr"></div>` : ""); // minimal hairline before centers

function heroSection(k, d) {
  const h = k.hero || {}, img = h.image ? cover(h.image) : "";
  if (d.hero === "split") {
    // luxe: editorial split — statement serif left, full-height arched photo right
    // with an offset hairline gold frame; a thin rule + city line grounds the text.
    return `<section class="hero hero--split"><div class="wrap hero-grid">
        <div class="hero-copy"><p class="eyebrow">${esc(h.eyebrow)}</p><h1>${esc(h.h1)}</h1>
          <p class="hero-lead">${esc(h.body)}</p>
          <div class="hero-actions"><a class="btn" href="/contact/">${esc(h.cta || "Book a Visit")}</a>
            <a class="hero-alt" href="/services/">Explore treatments</a></div></div>
        <div class="hero-media"><div class="hero-frame"></div>${img}</div>
      </div></section>`;
  }
  if (d.hero === "centered") {
    return `<section class="hero"><div class="wrap"><p class="eyebrow">${esc(h.eyebrow)}</p><h1>${esc(h.h1)}</h1><p>${esc(h.body)}</p>
        <a class="btn" href="/contact/">${esc(h.cta || "Book a Visit")}</a></div>${img ? `<div class="hero-media">${img}</div>` : ""}</section>`;
  }
  // overlay (editorial) + bottom (bold) share markup; CSS differs
  return `<section class="hero"><div class="hero-bg">${img}</div><div class="wrap">
      <p class="eyebrow">${esc(h.eyebrow)}</p><h1>${esc(h.h1)}</h1><p>${esc(h.body)}</p>
      <a class="btn btn--light" href="/contact/">${esc(h.cta || "Book a Visit")}</a></div></section>`;
}
function pageHero(k, intro, title) {
  const i = intro || {};
  return `<section class="page-hero"><div class="page-hero-bg">${i.image ? cover(i.image) : ""}</div><div class="wrap">
      <p class="eyebrow">${esc(i.eyebrow || (k.brand && k.brand.name) || "")}</p><h1>${esc(i.h1 || title)}</h1>
      ${i.body ? `<p style="max-width:600px;margin:18px auto 0;color:#f2ece2">${esc(i.body)}</p>` : ""}</div></section>`;
}
function aboutSection(k, d) {
  const a = k.about || {}, hasImg = !!a.image;
  const paras = arr(a.paras).map((p) => `<p>${esc(p)}</p>`).join("");
  const cls = d.hero === "bottom" ? "section about" : "about"; // bold pads about as a section
  return `<section class="${cls}" id="about"><div class="wrap about-grid${hasImg ? "" : " solo"}">
      <div class="about-copy"><p class="eyebrow">${esc(a.eyebrow)}</p><h2>${esc(a.h2)}</h2>
        <div style="margin-top:24px">${paras}</div><a class="btn" href="/contact/">${esc(a.cta || "Book Now")}</a></div>
      ${hasImg ? `<div class="about-img">${cover(a.image)}</div>` : ""}</div></section>`;
}
function stripSection(k, d) {
  const s = arr(k.strip);
  if (!s.length || d.strip === "none") return "";
  if (d.strip === "marquee") {
    const items = s.map((x) => `<span>${esc(x)} &nbsp;·</span>`).join("");
    return `<div class="strip"><div class="track">${items}${items}</div></div>`;
  }
  return `<div class="strip"><div class="wrap">${s.map((x) => `<span>${esc(x)}</span>`).join("")}</div></div>`;
}
function specialtiesSection(k, d) {
  const sp = k.specialties || {};
  const cards = arr(sp.cards).map((c, i) => `
      <div class="card${c.image ? "" : " card--text"}">${d.cardIdx ? `<span class="idx">0${i + 1}</span>` : ""}${c.image ? `<div class="card-img">${cover(c.image)}</div>` : ""}<div class="card-body">
        <h3>${esc(c.h3)}</h3><p>${esc(c.p)}</p><a class="btn" href="/services/">Learn More</a></div></div>`).join("");
  return `<section class="section" id="specialties"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(sp.eyebrow)}</p><h2>${esc(sp.h2)}</h2>${sp.intro ? `<p>${esc(sp.intro)}</p>` : ""}</div>
      <div class="cards">${cards}</div></div></section>`;
}
function providersSection(k, d) {
  const pr = k.providers || {}, members = arr(pr.members);
  if (!members.length) return "";
  const html = members.map((m) => `
      <div class="member">${m.image ? `<div class="photo">${cover(m.image)}</div>` : ""}<h3>${esc(m.name)}</h3><div class="role">${esc(m.role)}</div></div>`).join("");
  return `<section class="section providers" id="providers"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(pr.eyebrow)}</p><h2>${esc(pr.h2)}</h2></div>
      <div class="team" style="--cols:${Math.min(members.length, 4)}">${html}</div></div></section>`;
}
function testimonialsSection(k, d) {
  const t = k.testimonials || {}, q = arr(t.quotes);
  if (!q.length) return "";
  const html = q.map((x) => `<div class="quote"><h4>${esc(x.h4)}</h4><p>"${esc(x.p)}"</p><cite>— ${esc(x.cite)}</cite></div>`).join("");
  // A single review in a 2-col grid stranded itself in the left column. Center it:
  // one centered column, capped width, centered text — reads as an intentional
  // pull-quote instead of a half-empty row. Inline so it wins across all designs.
  const oneStyle = q.length === 1
    ? ` style="grid-template-columns:minmax(0,660px);justify-content:center;text-align:center"`
    : "";
  return `<section class="section testi" id="testi"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(t.eyebrow)}</p><h2>${esc(t.h2)}</h2></div><div class="quotes${q.length === 1 ? " quotes--one" : ""}"${oneStyle}>${html}</div></div></section>`;
}
function featuredSection(k, d) {
  const f = k.featured || {}, items = arr(f.items);
  if (!items.length) return "";
  const html = items.map((x) => `<article><h3>${esc(x.h3)}</h3><p>${esc(x.p)}</p><a class="btn" href="/contact/">Book Now</a></article>`).join("");
  return `<section class="section"><div class="wrap"><div class="center">${cx(d)}<h2>${esc(f.h2)}</h2></div><div class="feat">${html}</div></div></section>`;
}
function ctaSection(k, d) {
  const c = k.cta || {}, b = k.brand || {};
  const btnLight = d.hero === "bottom" ? " btn--light" : "";
  return `<section class="cta" id="cta"><div class="wrap">${cx(d)}<p class="eyebrow">${esc(c.eyebrow)}</p><h2>${esc(c.h2)}</h2><p>${esc(c.body)}</p>
      <a class="btn${btnLight}" href="tel:${esc(b.phone || "")}">Contact Us</a><div class="contactline">${esc(b.phone || "")}${b.email ? " · " + esc(b.email) : ""}</div></div></section>`;
}

function gallerySection(k, d) {
  const g = arr(k.gallery);
  if (g.length < 2) return ""; // only show when there are real extra photos
  const cells = g.map((u) => `<div class="gcell">${cover(u)}</div>`).join("");
  return `<section class="section gallery-sec"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">Gallery</p><h2>A Look Inside</h2></div><div class="gallery">${cells}</div></div></section>`;
}

function designOf(kit) { return DESIGNS[kit && kit.layout] || DESIGNS.editorial; }

function renderHome(kit) {
  const d = designOf(kit);
  return head(kit, d) + header(kit, d) + heroSection(kit, d) + aboutSection(kit, d) + stripSection(kit, d)
    + specialtiesSection(kit, d) + providersSection(kit, d) + gallerySection(kit, d) + testimonialsSection(kit, d) + featuredSection(kit, d) + ctaSection(kit, d)
    + footer(kit) + MOTION_JS + "</body></html>";
}
// ---- sub-page-specific sections (own content, home's theme) ----
function servicesMenuSection(k, d) {
  const m = arr(k.servicesMenu); if (!m.length) return "";
  const sp = k.servicesPage || {};
  const rows = m.map((x, i) => `<article class="svc-row"><span class="svc-n">${String(i + 1).padStart(2, "0")}</span><div><h3>${esc(x.name)}</h3><p>${esc(x.desc)}</p></div><a class="btn" href="/contact/">Book</a></article>`).join("");
  return `<section class="section"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(sp.eyebrow || "Our Services")}</p><h2>Treatments &amp; Services</h2>${sp.body ? `<p>${esc(sp.body)}</p>` : ""}</div><div class="svc-menu">${rows}</div></div></section>`;
}
function valuesSection(k, d) {
  const v = arr(k.values); if (!v.length) return "";
  const items = v.map((x) => `<div class="value"><h3>${esc(x.h3)}</h3><p>${esc(x.p)}</p></div>`).join("");
  return `<section class="section"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">Why ${esc((k.brand && k.brand.name) || "Us")}</p><h2>The difference</h2></div><div class="values">${items}</div></div></section>`;
}
// A pool cursor hands out each scraped client photo once, then repeats — so empty
// image slots get a real photo instead of a gradient placeholder.
function poolCursor(pool) {
  const p = arr(pool).filter(Boolean); let i = 0; const used = new Set();
  return () => { if (!p.length) return ""; for (let k = 0; k < p.length; k++) { const u = p[(i++) % p.length]; if (!used.has(u)) { used.add(u); return u; } } return p[(i++) % p.length]; };
}
// Premium contact: an editorial photo + copy split with icon info-cards and a
// prominent booking CTA, then a wide map. Far richer than a plain address list.
function contactPremium(k, d, next) {
  const c = k.contact || {}, cp = k.contactPage || {};
  const photo = next();
  const ci = (l, v, href, ic) => v ? `<div class="ci-card"><span class="ci-ic">${ic}</span><div><dt>${l}</dt><dd>${href ? `<a href="${href}">${esc(v)}</a>` : esc(v)}</dd></div></div>` : "";
  const map = c.address ? `<section class="section" style="padding-top:0"><div class="wrap"><div class="contact-map contact-map--wide"><iframe loading="lazy" src="https://www.google.com/maps?q=${encodeURIComponent(c.address)}&output=embed" title="Map"></iframe></div></div></section>` : "";
  return `<section class="section about"><div class="wrap"><div class="about-grid">
      ${photo ? `<div class="about-img">${cover(photo)}</div>` : ""}
      <div class="about-copy"><p class="eyebrow">Plan Your Visit</p><h2>${esc(cp.h2 || "We can't wait to welcome you")}</h2>
        <p>${esc(cp.body || "Reach out to schedule a private consultation — our concierge team will help you find the perfect time to visit.")}</p>
        <div class="ci-grid">${ci("Address", c.address, null, "◈")}${ci("Phone", c.phone, "tel:" + esc(c.phone), "☎")}${ci("Email", c.email, "mailto:" + esc(c.email), "✉")}${ci("Hours", c.hours, null, "◷")}</div>
        <a class="btn" style="margin-top:30px" href="tel:${esc(c.phone || "")}">${esc(c.booking || "Book a consultation")}</a></div>
    </div></div></section>${map}`;
}
function renderServices(kit) {
  const d = designOf(kit);
  return head(kit, d) + header(kit, d) + pageHero(kit, kit.servicesPage, "Our Services")
    + `<main>` + servicesMenuSection(kit, d) + featuredSection(kit, d) + ctaSection(kit, d) + `</main>` + footer(kit) + MOTION_JS + "</body></html>";
}
function renderAbout(kit) {
  const d = designOf(kit);
  // Team folds into About (no standalone Team page anymore).
  return head(kit, d) + header(kit, d) + pageHero(kit, kit.aboutPage, "About Us")
    + `<main>` + aboutSection(kit, d) + valuesSection(kit, d) + stripSection(kit, d) + providersSection(kit, d) + gallerySection(kit, d) + testimonialsSection(kit, d) + ctaSection(kit, d) + `</main>` + footer(kit) + MOTION_JS + "</body></html>";
}
function renderContact(kit, pool) {
  const d = designOf(kit);
  const next = poolCursor(pool);
  const cp = kit.contactPage || {};
  const hero = { eyebrow: (kit.brand && kit.brand.name) || "", h1: cp.h1 || "Contact Us", body: cp.body || "", image: cp.image || next() };
  return head(kit, d) + header(kit, d) + pageHero(kit, hero, "Contact Us")
    + `<main>` + contactPremium(kit, d, next) + ctaSection(kit, d) + `</main>` + footer(kit) + MOTION_JS + "</body></html>";
}
// ---- Approach B: render a scraped page from its blueprint, in the home theme ----
function blockSplit(b, d) {
  const paras = arr(b.paras).map((p) => `<p>${esc(p)}</p>`).join("");
  const copy = `<div class="about-copy"><p class="eyebrow">${esc(b.eyebrow)}</p><h2>${esc(b.h2)}</h2>${paras}</div>`;
  const img = b.image ? `<div class="about-img">${cover(b.image)}</div>` : "";
  const inner = img ? (b.reverse ? copy + img : img + copy) : copy;
  return `<section class="section about"><div class="wrap"><div class="about-grid${img ? "" : " solo"}">${inner}</div></div></section>`;
}
function blockCards(b, d) {
  const cs = arr(b.cards); if (!cs.length) return "";
  const html = cs.map((c) => `<div class="card">${c.image ? `<div class="card-img">${cover(c.image)}</div>` : ""}<div class="card-body"><h3>${esc(c.h3)}</h3><p>${esc(c.p)}</p><a class="btn" href="/contact/">Learn More</a></div></div>`).join("");
  return `<section class="section"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(b.eyebrow)}</p><h2>${esc(b.h2)}</h2>${b.intro ? `<p>${esc(b.intro)}</p>` : ""}</div><div class="cards">${html}</div></div></section>`;
}
function blockList(b, d) {
  const it = arr(b.items); if (!it.length) return "";
  const rows = it.map((x, i) => `<article class="svc-row"><span class="svc-n">${String(i + 1).padStart(2, "0")}</span><div><h3>${esc(x.name)}</h3><p>${esc(x.desc)}</p></div><a class="btn" href="/contact/">Book</a></article>`).join("");
  return `<section class="section"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(b.eyebrow)}</p><h2>${esc(b.h2)}</h2>${b.intro ? `<p>${esc(b.intro)}</p>` : ""}</div><div class="svc-menu">${rows}</div></div></section>`;
}
function blockGallery(b, d) {
  const im = arr(b.images).filter(Boolean); if (!im.length) return "";
  const cells = im.slice(0, 6).map((u) => `<div class="gcell">${cover(u)}</div>`).join("");
  return `<section class="section"><div class="wrap">${(b.h2 || b.eyebrow) ? `<div class="center">${cx(d)}<p class="eyebrow">${esc(b.eyebrow)}</p><h2>${esc(b.h2)}</h2></div>` : ""}<div class="gallery">${cells}</div></div></section>`;
}
function blockQuote(b, d) {
  const qs = arr(b.quotes); if (!qs.length) return "";
  const html = qs.map((x) => `<div class="quote"><h4>${esc(x.h4)}</h4><p>"${esc(x.p)}"</p><cite>— ${esc(x.cite)}</cite></div>`).join("");
  const one = qs.length === 1 ? ` style="grid-template-columns:minmax(0,660px);justify-content:center;text-align:center"` : "";
  return `<section class="section testi"><div class="wrap"><div class="center">${cx(d)}<p class="eyebrow">${esc(b.eyebrow)}</p><h2>${esc(b.h2)}</h2></div><div class="quotes${qs.length === 1 ? " quotes--one" : ""}"${one}>${html}</div></div></section>`;
}
function blockStat(b, d) {
  const it = arr(b.items).filter((x) => x && (x.big || x.label)); if (!it.length) return "";
  const cells = it.slice(0, 4).map((x) => `<div class="value"><h3 style="color:var(--accent)">${esc(x.big)}</h3><p style="letter-spacing:1px;text-transform:uppercase;font-size:12px">${esc(x.label)}</p></div>`).join("");
  return `<section class="section"><div class="wrap"><div class="values">${cells}</div></div></section>`;
}
function blockHtml(b, d, k) {
  switch (b.type) {
    case "split": return blockSplit(b, d);
    case "cards": return blockCards(b, d);
    case "list": return blockList(b, d);
    case "gallery": return blockGallery(b, d);
    case "quote": return blockQuote(b, d);
    case "stat": return blockStat(b, d);
    case "cta": return ctaSection({ ...k, cta: { eyebrow: b.eyebrow || "", h2: b.h2 || "Ready to begin?", body: b.body || "" } }, d);
    default: return "";
  }
}
function renderFromBlueprint(kit, bp, title, pool) {
  const d = designOf(kit);
  const next = poolCursor(pool);
  // Prefer the deepened/localized POOL for every image. The AI sometimes picks a
  // stale scrape URL (e.g. ruma's old /wp-content/ path that now 404s), which left
  // the hero blank + a broken-image flicker. Use an AI pick only if it's a known
  // pool URL; otherwise pull the next real pool photo.
  const inPool = (u) => u && arr(pool).includes(u);
  const pick = (u) => (inPool(u) ? u : (next() || u || ""));
  const heroImage = pick(bp.heroImage);
  for (const b of arr(bp.blocks)) {
    if (b.type === "split") b.image = pick(b.image);
    else if (b.type === "cards") {
      // ALL-OR-NOTHING: a card grid with 1 photo + 2 empty cards looks broken. If
      // the pool can't give EVERY card its own photo, render them all as clean
      // text cards instead. Track uniqueness so cards never repeat the same image.
      const cards = arr(b.cards), used = new Set();
      const filled = cards.map((c) => {
        if (inPool(c.image) && !used.has(c.image)) { used.add(c.image); return c.image; }
        for (let k = 0; k < arr(pool).length; k++) { const u = next(); if (u && !used.has(u)) { used.add(u); return u; } }
        return "";
      });
      const allHave = filled.length > 0 && filled.every(Boolean);
      cards.forEach((c, i) => { c.image = allHave ? filled[i] : ""; });
    } else if (b.type === "gallery") { b.images = arr(b.images).map(pick).filter(Boolean); while (b.images.length < 4) { const u = next(); if (!u) break; b.images.push(u); } }
  }
  const hero = { eyebrow: (kit.brand && kit.brand.name) || "", h1: bp.title || title, body: bp.intro || "", image: heroImage };
  const body = arr(bp.blocks).map((b) => blockHtml(b, d, kit)).join("");
  return head(kit, d) + header(kit, d) + pageHero(kit, hero, title) + `<main>` + body + `</main>` + footer(kit) + MOTION_JS + "</body></html>";
}
function renderPages(kit) {
  return { home: renderHome(kit), services: renderServices(kit), about: renderAbout(kit), contact: renderContact(kit) };
}

module.exports = { renderPages, renderHome, renderServices, renderAbout, renderContact, renderFromBlueprint, DESIGN_IDS: Object.keys(DESIGNS) };
