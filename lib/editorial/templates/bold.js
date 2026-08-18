import { head, foot, esc, arr, cover } from "./base.js";

export const meta = { id: "bold", name: "Bold Modern", vibe: "dramatic, dark, oversized display type, high-contrast, confident" };

const CSS = `
  body{background:var(--ink);color:#d9d2c7}
  h1,h2,h3{color:#fff}
  h1{font-size:clamp(52px,8vw,104px);line-height:.98;letter-spacing:-1px}
  h2{font-size:clamp(38px,5.5vw,72px);letter-spacing:-.5px} h3{font-size:clamp(22px,3vw,30px)}
  .eyebrow{color:var(--accent)}
  .btn{border-color:#fff;color:#fff}.btn:hover{background:#fff;color:var(--ink)}
  header{position:sticky;top:0;z-index:50;background:rgba(20,18,15,.72);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,.08)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:84px}
  .nav ul{list-style:none;display:flex;gap:30px}.nav ul a{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#d9d2c7}.nav ul a:hover{color:var(--accent)}
  .logo{font-family:var(--serif);font-size:28px;letter-spacing:5px;color:#fff}
  .nav-right{display:flex;align-items:center;gap:20px}.phone{font-size:13px;color:#d9d2c7}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1.5px;background:#fff}
  .hero{position:relative;min-height:100vh;display:flex;align-items:flex-end;overflow:hidden;padding-bottom:9vh}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#26221c,#4a4034);z-index:-2}
  .hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.5}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(15,13,10,.85),rgba(15,13,10,.15) 60%);z-index:-1}
  .hero .wrap{width:100%}.hero h1{max-width:12ch;margin:16px 0 24px}.hero p{max-width:520px;color:#e6ddd0;margin-bottom:34px;font-size:17px}
  .section{padding:120px 0}
  .about{background:var(--cream);color:var(--body)}.about h2,.about h3{color:var(--ink)}
  .about-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:80px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:900px;margin:0 auto}
  .about-copy p{margin-bottom:22px;font-size:16px}.about-img{aspect-ratio:4/5;overflow:hidden;background:linear-gradient(135deg,#d8c9b4,#b7a488)}.about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--accent);color:#1c1811;padding:22px 0;overflow:hidden}
  .strip .track{display:flex;gap:60px;white-space:nowrap;font-size:13px;letter-spacing:3px;text-transform:uppercase;font-weight:500;animation:marq 28s linear infinite}
  @keyframes marq{to{transform:translateX(-50%)}}
  @media (prefers-reduced-motion: reduce){.strip .track{animation:none;flex-wrap:wrap;justify-content:center;white-space:normal}}
  .center{max-width:820px;margin:0 auto 64px}.center .eyebrow{text-align:center}.center h2{text-align:center}.center p{margin-top:22px;text-align:center;color:#b7ada0}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08)}
  .card{background:var(--ink);position:relative;overflow:hidden}
  .card-img{aspect-ratio:16/11;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.card:hover .card-img img{transform:scale(1.07)}
  .card-body{padding:34px 30px}.card--text .card-body{padding-top:60px}.card h3{margin-bottom:14px}.card p{color:#b7ada0}.card .btn{margin-top:24px}
  .card .idx{position:absolute;top:20px;right:24px;font-family:var(--serif);font-size:44px;color:rgba(255,255,255,.14)}
  .providers .center h2{color:#fff}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:24px;max-width:1040px;margin:0 auto}
  .member .photo{aspect-ratio:3/4;overflow:hidden;margin-bottom:18px;filter:grayscale(.2)}.member:hover .photo{filter:none}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:26px;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--cream);color:var(--body)}.testi h2,.testi h4{color:var(--ink)}.testi .center p{color:var(--body)}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:30px}
  .quote{background:#fff;border:1px solid var(--line);padding:40px 36px}.quote h4{font-family:var(--serif);font-size:24px;margin-bottom:16px}.quote p{margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:60px}
  .feat article{border:1px solid rgba(255,255,255,.12);padding:44px 34px}.feat h3{margin-bottom:16px}.feat p{color:#b7ada0}.feat .btn{margin-top:24px}
  .cta{text-align:center;padding:140px 0;background:radial-gradient(ellipse at center,#2c271f,var(--ink))}
  .cta p{max-width:560px;margin:22px auto 34px;color:#c9c0b3}.cta .contactline{margin-top:30px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  footer{background:#0f0d0a;color:#8f8578;padding:80px 0 34px;font-size:13px}
  .foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:14px;letter-spacing:2px;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid rgba(255,255,255,.1);padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}
    .nav ul.open{display:flex;position:absolute;top:84px;left:0;right:0;background:var(--ink);flex-direction:column;padding:20px 28px;gap:16px}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

export function render(k) {
  const b = k.brand || {};
  const cards = arr(k.specialties?.cards).map((c, i) => `
      <div class="card${c.image ? "" : " card--text"}"><span class="idx">0${i + 1}</span>${c.image ? `<div class="card-img">${cover(c.image)}</div>` : ""}<div class="card-body">
        <h3>${esc(c.h3)}</h3><p>${esc(c.p)}</p><a class="btn" href="#cta">Learn More</a></div></div>`).join("");
  const stripItems = arr(k.strip).map((s) => `<span>${esc(s)} &nbsp;·</span>`).join("");
  const members = arr(k.providers?.members).map((m) => `
      <div class="member">${m.image ? `<div class="photo">${cover(m.image)}</div>` : ""}<h3>${esc(m.name)}</h3><div class="role">${esc(m.role)}</div></div>`).join("");
  const quotes = arr(k.testimonials?.quotes).map((q) => `<div class="quote"><h4>${esc(q.h4)}</h4><p>"${esc(q.p)}"</p><cite>— ${esc(q.cite)}</cite></div>`).join("");
  const feat = arr(k.featured?.items).map((f) => `<article><h3>${esc(f.h3)}</h3><p>${esc(f.p)}</p><a class="btn" href="#cta">Book Now</a></article>`).join("");
  const aboutParas = arr(k.about?.paras).map((p) => `<p>${esc(p)}</p>`).join("");
  const hasAbout = !!(k.about && k.about.image);
  const memCount = arr(k.providers?.members).length;

  return head(k, CSS) + `
  <header><nav class="nav wrap">
      <ul id="menu"><li><a href="#about">About</a></li><li><a href="#specialties">Services</a></li>${memCount ? '<li><a href="#providers">Team</a></li>' : ""}<li><a href="#testi">Reviews</a></li></ul>
      <a class="logo" href="#">${b.logoImg ? `<img class="logo-ic" src="${esc(b.logoImg)}" alt="" onerror="this.remove()"/>` : ""}<span class="logo-tx">${esc(b.name || "MED SPA")}</span></a>
      <div class="nav-right"><a class="phone" href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a><a class="btn" href="#cta">Book</a>
        <button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button></div>
  </nav></header>
  <section class="hero"><div class="hero-bg">${k.hero?.image ? cover(k.hero.image) : ""}</div><div class="wrap">
      <p class="eyebrow">${esc(k.hero?.eyebrow)}</p><h1>${esc(k.hero?.h1)}</h1><p>${esc(k.hero?.body)}</p>
      <a class="btn btn--light" href="#cta">${esc(k.hero?.cta || "Book a Visit")}</a></div></section>
  <section class="section about" id="about"><div class="wrap about-grid${hasAbout ? "" : " solo"}">
      <div class="about-copy"><p class="eyebrow">${esc(k.about?.eyebrow)}</p><h2>${esc(k.about?.h2)}</h2>
        <div style="margin-top:24px">${aboutParas}</div><a class="btn" href="#cta" style="border-color:var(--ink);color:var(--ink)">${esc(k.about?.cta || "Book Now")}</a></div>
      ${hasAbout ? `<div class="about-img">${cover(k.about.image)}</div>` : ""}</div></section>
  <div class="strip"><div class="track">${stripItems}${stripItems}</div></div>
  <section class="section" id="specialties"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.specialties?.eyebrow)}</p><h2>${esc(k.specialties?.h2)}</h2><p>${esc(k.specialties?.intro)}</p></div>
      <div class="cards">${cards}</div></div></section>
  ${memCount ? `<section class="section providers" id="providers"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.providers?.eyebrow)}</p><h2>${esc(k.providers?.h2)}</h2></div>
      <div class="team" style="--cols:${Math.min(memCount, 4)}">${members}</div></div></section>` : ""}
  <section class="section testi" id="testi"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.testimonials?.eyebrow)}</p><h2>${esc(k.testimonials?.h2)}</h2></div><div class="quotes">${quotes}</div></div></section>
  <section class="section"><div class="wrap"><div class="center"><h2>${esc(k.featured?.h2)}</h2></div><div class="feat">${feat}</div></div></section>
  <section class="cta" id="cta"><div class="wrap"><p class="eyebrow">${esc(k.cta?.eyebrow)}</p><h2>${esc(k.cta?.h2)}</h2><p>${esc(k.cta?.body)}</p>
      <a class="btn btn--light" href="tel:${esc(b.phone || "")}">Contact Us</a><div class="contactline">${esc(b.phone || "")}${b.email ? " · " + esc(b.email) : ""}</div></div></section>
  <footer><div class="wrap"><div class="foot-grid">
        <div><div class="logo" style="margin-bottom:18px">${esc(b.name || "")}</div><p>${esc(k.footer?.blurb)}</p></div>
        <div><h5>Explore</h5><ul><li><a href="#about">About</a></li><li><a href="#specialties">Services</a></li></ul></div>
        <div><h5>Company</h5><ul><li><a href="#">Blog</a></li><li><a href="#cta">Contact</a></li></ul></div>
        <div><h5>Visit</h5><ul><li>${esc(b.city || "")}</li><li><a href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a></li></ul></div></div>
      <div class="foot-bottom"><span>© 2026 ${esc(b.name || "")}. All rights reserved.</span><span>Privacy · Terms</span></div></div></footer>
  <script>document.getElementById('burger').addEventListener('click',function(){document.getElementById('menu').classList.toggle('open')});</script>
  ` + foot();
}
