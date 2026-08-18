import { head, foot, esc, arr, cover } from "./base.js";

export const meta = { id: "minimal", name: "Soft Minimal", vibe: "airy, quiet, lots of whitespace, hairline details, centered, understated" };

const CSS = `
  body{background:var(--white)}
  h1{font-size:clamp(40px,5.5vw,68px);font-weight:300} h2{font-size:clamp(30px,4vw,48px)} h3{font-size:clamp(20px,2.4vw,26px)}
  .eyebrow{letter-spacing:4px}
  .btn{border:none;border-bottom:1px solid var(--ink);padding:10px 2px}.btn:hover{background:transparent;color:var(--accent);border-color:var(--accent)}
  .btn--light{border-bottom:1px solid #fff}.btn--light:hover{background:transparent;color:#e6d8c4;border-color:#e6d8c4}
  header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(10px)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:90px}
  .nav ul{list-style:none;display:flex;gap:34px}.nav ul a{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--body)}.nav ul a:hover{color:var(--ink)}
  .logo{font-family:var(--serif);font-size:26px;letter-spacing:8px;color:var(--ink);font-weight:300}
  .nav-right{display:flex;align-items:center;gap:24px}.phone{font-size:12px;letter-spacing:1px;color:var(--body)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:22px;height:1px;background:var(--ink)}
  .hero{text-align:center;padding:130px 0 90px}.hero .eyebrow{margin-bottom:26px}.hero h1{max-width:16ch;margin:0 auto 28px}.hero p{max-width:520px;margin:0 auto 36px}
  .hero-media{max-width:1100px;margin:60px auto 0;aspect-ratio:16/8;overflow:hidden;padding:0 28px}
  .hero-media img{width:100%;height:100%;object-fit:cover}
  .section{padding:110px 0}
  .about{padding:40px 0 110px}
  .about-grid{display:grid;grid-template-columns:1fr 1fr;gap:90px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:720px;margin:0 auto;text-align:center}
  .about-grid.solo p{max-width:600px;margin:0 auto 22px}
  .about-copy p{margin-bottom:22px}.about-img{aspect-ratio:1;overflow:hidden}.about-img img{width:100%;height:100%;object-fit:cover}
  .center{text-align:center;max-width:640px;margin:0 auto 70px}.center p{margin-top:22px}
  .hr{width:40px;height:1px;background:var(--accent);margin:0 auto 26px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-block:1px solid var(--line)}
  .card{background:var(--white);padding:0}
  .card-img{aspect-ratio:3/2;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .7s}.card:hover .card-img img{transform:scale(1.05)}
  .card-body{padding:36px 34px 44px;text-align:center}.card--text .card-body{padding-top:56px}.card h3{margin-bottom:14px;font-weight:300}.card p{color:var(--body)}.card .btn{margin-top:22px}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:40px;max-width:1000px;margin:0 auto;text-align:center}
  .member .photo{width:170px;height:170px;border-radius:50%;overflow:hidden;margin:0 auto 22px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:22px;font-weight:300;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .tabs{display:flex;justify-content:center;gap:36px;margin-bottom:52px;flex-wrap:wrap}
  .tab{font-size:11px;letter-spacing:2px;text-transform:uppercase;padding-bottom:8px;border-bottom:1px solid transparent;cursor:pointer;color:var(--body)}.tab.active{color:var(--ink);border-color:var(--accent)}
  .testi{background:var(--cream)}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}
  .quote{background:var(--cream);padding:48px 44px;text-align:center}.quote h4{font-family:var(--serif);font-size:22px;font-weight:300;margin-bottom:18px;color:var(--ink)}.quote p{margin-bottom:20px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);gap:60px;margin-top:64px;text-align:center}
  .feat article{padding:0 10px}.feat h3{margin-bottom:16px;font-weight:300}.feat .btn{margin-top:22px}
  .cta{text-align:center;padding:130px 0;background:var(--cream)}.cta p{max-width:520px;margin:22px auto 34px}.cta .contactline{margin-top:30px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
  footer{padding:80px 0 40px;font-size:13px;border-top:1px solid var(--line);color:var(--body)}
  .foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--sans);color:var(--ink);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px}footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:var(--ink)}
  .foot-bottom{border-top:1px solid var(--line);padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px;letter-spacing:1px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}
    .nav ul.open{display:flex;position:absolute;top:90px;left:0;right:0;background:#fff;flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

export function render(k) {
  const b = k.brand || {};
  const cards = arr(k.specialties?.cards).map((c) => `
      <div class="card${c.image ? "" : " card--text"}">${c.image ? `<div class="card-img">${cover(c.image)}</div>` : ""}<div class="card-body">
        <h3>${esc(c.h3)}</h3><p>${esc(c.p)}</p><a class="btn" href="#cta">Learn More</a></div></div>`).join("");
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
      <div class="nav-right"><a class="phone" href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a><a class="btn" href="#cta">Book a Visit</a>
        <button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button></div>
  </nav></header>
  <section class="hero"><div class="wrap"><p class="eyebrow">${esc(k.hero?.eyebrow)}</p><h1>${esc(k.hero?.h1)}</h1><p>${esc(k.hero?.body)}</p>
      <a class="btn" href="#cta">${esc(k.hero?.cta || "Book a Visit")}</a></div>
      ${k.hero?.image ? `<div class="hero-media">${cover(k.hero.image)}</div>` : ""}</section>
  <section class="about" id="about"><div class="wrap about-grid${hasAbout ? "" : " solo"}">
      <div class="about-copy"><p class="eyebrow">${esc(k.about?.eyebrow)}</p><h2>${esc(k.about?.h2)}</h2>
        <div style="margin-top:24px">${aboutParas}</div><a class="btn" href="#cta">${esc(k.about?.cta || "Book Now")}</a></div>
      ${hasAbout ? `<div class="about-img">${cover(k.about.image)}</div>` : ""}</div></section>
  <section class="section" id="specialties"><div class="wrap"><div class="center"><div class="hr"></div><p class="eyebrow">${esc(k.specialties?.eyebrow)}</p><h2>${esc(k.specialties?.h2)}</h2><p>${esc(k.specialties?.intro)}</p></div>
      <div class="cards">${cards}</div></div></section>
  ${memCount ? `<section class="section" id="providers"><div class="wrap"><div class="center"><div class="hr"></div><p class="eyebrow">${esc(k.providers?.eyebrow)}</p><h2>${esc(k.providers?.h2)}</h2></div>
      <div class="team" style="--cols:${Math.min(memCount, 4)}">${members}</div></div></section>` : ""}
  <section class="section testi" id="testi"><div class="wrap"><div class="center"><div class="hr"></div><p class="eyebrow">${esc(k.testimonials?.eyebrow)}</p><h2>${esc(k.testimonials?.h2)}</h2></div><div class="quotes">${quotes}</div></div></section>
  <section class="section"><div class="wrap"><div class="center"><div class="hr"></div><h2>${esc(k.featured?.h2)}</h2></div><div class="feat">${feat}</div></div></section>
  <section class="cta" id="cta"><div class="wrap"><div class="hr"></div><p class="eyebrow">${esc(k.cta?.eyebrow)}</p><h2>${esc(k.cta?.h2)}</h2><p>${esc(k.cta?.body)}</p>
      <a class="btn" href="tel:${esc(b.phone || "")}">Contact Us</a><div class="contactline">${esc(b.phone || "")}${b.email ? " · " + esc(b.email) : ""}</div></div></section>
  <footer><div class="wrap"><div class="foot-grid">
        <div><div class="logo" style="margin-bottom:18px">${esc(b.name || "")}</div><p>${esc(k.footer?.blurb)}</p></div>
        <div><h5>Explore</h5><ul><li><a href="#about">About</a></li><li><a href="#specialties">Services</a></li></ul></div>
        <div><h5>Company</h5><ul><li><a href="#">Blog</a></li><li><a href="#cta">Contact</a></li></ul></div>
        <div><h5>Visit</h5><ul><li>${esc(b.city || "")}</li><li><a href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a></li></ul></div></div>
      <div class="foot-bottom"><span>© 2026 ${esc(b.name || "")}. All rights reserved.</span><span>Privacy · Terms</span></div></div></footer>
  <script>document.getElementById('burger').addEventListener('click',function(){document.getElementById('menu').classList.toggle('open')});
    document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});t.classList.add('active')})});</script>
  ` + foot();
}
