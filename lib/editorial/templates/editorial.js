import { head, foot, esc, arr, cover } from "./base.js";

export const meta = { id: "editorial", name: "Editorial Luxe", vibe: "refined, serif-led, calm luxury with generous whitespace" };

const CSS = `
  h1{font-size:clamp(44px,6vw,72px)} h2{font-size:clamp(34px,5vw,60px)} h3{font-size:clamp(22px,3vw,30px)}
  .topbar{background:var(--ink);color:#cbb8a3;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-align:center;padding:9px}
  header{position:sticky;top:0;z-index:50;background:var(--cream);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:78px}
  .nav ul{list-style:none;display:flex;gap:26px}
  .nav ul a{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ink);font-weight:400}
  .nav ul a:hover{color:var(--accent)}
  .logo{font-family:var(--serif);font-size:30px;letter-spacing:6px;color:var(--ink)}
  .logo span{font-size:9px;letter-spacing:4px;display:block;text-align:center;font-family:var(--sans);color:var(--accent)}
  .nav-right{display:flex;align-items:center;gap:22px}.phone{font-size:13px;color:var(--ink)}
  .burger{display:none;flex-direction:column;gap:5px;cursor:pointer;background:none;border:none}.burger span{width:24px;height:1.5px;background:var(--ink)}
  .hero{position:relative;min-height:88vh;display:flex;align-items:center;color:#fff;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background:linear-gradient(120deg,#3a352e,#6b5d49);z-index:-2}
  .hero-bg img{width:100%;height:100%;object-fit:cover;opacity:.6}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(30,26,20,.55),rgba(30,26,20,.15));z-index:-1}
  .hero .wrap{width:100%}.hero .eyebrow{color:#e6d8c4}
  .hero h1{color:#fff;max-width:640px;margin:14px 0 26px}.hero p{max-width:520px;color:#f2ece2;margin-bottom:32px}
  .about{background:var(--cream);padding:100px 0}
  .about-grid{display:grid;grid-template-columns:1fr 1fr;gap:70px;align-items:center}
  .about-grid.solo{grid-template-columns:1fr;max-width:820px;margin:0 auto;text-align:center}
  .about-grid.solo .about-copy p{max-width:640px;margin:0 auto 20px}
  .about-copy p{margin-bottom:20px}
  .about-img{aspect-ratio:5/6;background:linear-gradient(135deg,#d8c9b4,#b7a488);overflow:hidden}
  .about-img img{width:100%;height:100%;object-fit:cover}
  .strip{background:var(--ink);color:#e6d8c4;padding:26px 0}
  .strip .wrap{display:flex;flex-wrap:wrap;justify-content:center;gap:14px 46px;font-size:12px;letter-spacing:2px;text-transform:uppercase}
  .section{padding:100px 0}.center{text-align:center;max-width:760px;margin:0 auto 56px}.center p{margin-top:22px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}
  .card{background:var(--cream);border:1px solid var(--line);padding:0 0 34px}
  .card:hover{transform:translateY(-6px)}
  .card-img{aspect-ratio:4/3;overflow:hidden}.card-img img{width:100%;height:100%;object-fit:cover}
  .card--text{padding-top:20px}.card--text h3{border-top:2px solid var(--accent);padding-top:24px;display:inline-block;margin-left:26px}
  .card-body{padding:28px 26px 0}.card h3{margin-bottom:14px}.card .btn{margin-top:22px}
  .providers{background:var(--cream)}
  .tabs{display:flex;justify-content:center;gap:34px;margin-bottom:48px;flex-wrap:wrap}
  .tab{font-size:12px;letter-spacing:2px;text-transform:uppercase;padding-bottom:8px;border-bottom:1px solid transparent;cursor:pointer;color:var(--body)}
  .tab.active{color:var(--ink);border-color:var(--accent)}
  .team{display:grid;grid-template-columns:repeat(var(--cols,4),1fr);gap:26px;max-width:1000px;margin:0 auto}
  .member .photo{aspect-ratio:3/4;overflow:hidden;margin-bottom:18px}.member .photo img{width:100%;height:100%;object-fit:cover}
  .member h3{font-size:24px;line-height:1;margin-bottom:6px}.member .role{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
  .testi{background:var(--ink);color:#f2ece2;padding:110px 0}.testi .eyebrow{color:#cbb8a3}.testi h2{color:#fff}
  .quotes{display:grid;grid-template-columns:repeat(2,1fr);gap:34px;margin-top:52px}
  .quote{border:1px solid #4a4339;padding:36px 34px}
  .quote h4{font-family:var(--serif);font-size:22px;color:#fff;margin-bottom:16px}
  .quote p{font-size:14px;color:#d6cdbf;margin-bottom:18px}.quote cite{font-style:normal;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#cbb8a3}
  .feat{display:grid;grid-template-columns:repeat(3,1fr);margin-top:56px;border:1px solid var(--line)}
  .feat article{padding:44px 36px;border-right:1px solid var(--line)}.feat article:last-child{border-right:none}
  .feat h3{margin-bottom:16px}.feat .btn{margin-top:24px}
  .cta{background:var(--cream);text-align:center;padding:110px 0}.cta p{max-width:560px;margin:22px auto 34px}
  .cta .contactline{margin-top:30px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--ink)}
  footer{background:var(--ink);color:#b7a894;padding:70px 0 34px;font-size:13px}
  .foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:50px}
  footer h5{font-family:var(--serif);color:#fff;font-size:14px;letter-spacing:2px;margin-bottom:18px}
  footer ul{list-style:none}footer li{margin-bottom:10px}footer a:hover{color:#fff}
  .foot-bottom{border-top:1px solid #4a4339;padding-top:24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px}
  @media(max-width:900px){.nav ul,.phone{display:none}.burger{display:flex}
    .nav ul.open{display:flex;position:absolute;top:78px;left:0;right:0;background:var(--cream);flex-direction:column;padding:20px 28px;gap:16px;border-bottom:1px solid var(--line)}
    .about-grid,.cards,.team,.feat,.quotes,.foot-grid{grid-template-columns:1fr}.feat article{border-right:none;border-bottom:1px solid var(--line)}}
  @media(max-width:560px){.team{grid-template-columns:1fr 1fr}}
`;

export function render(k) {
  const b = k.brand || {};
  const cards = arr(k.specialties?.cards).map((c) => `
      <div class="card${c.image ? "" : " card--text"}">${c.image ? `<div class="card-img">${cover(c.image)}</div>` : ""}<div class="card-body">
        <h3>${esc(c.h3)}</h3><p>${esc(c.p)}</p><a class="btn" href="#cta">Learn More</a></div></div>`).join("");
  const strip = arr(k.strip).map((s) => `<span>${esc(s)}</span>`).join("");
  const tabs = arr(k.providers?.tabs).map((tb, i) => `<div class="tab${i === 0 ? " active" : ""}">${esc(tb)}</div>`).join("");
  const members = arr(k.providers?.members).map((m) => `
      <div class="member">${m.image ? `<div class="photo">${cover(m.image)}</div>` : ""}<h3>${esc(m.name)}</h3><div class="role">${esc(m.role)}</div></div>`).join("");
  const quotes = arr(k.testimonials?.quotes).map((q) => `<div class="quote"><h4>${esc(q.h4)}</h4><p>"${esc(q.p)}"</p><cite>— ${esc(q.cite)}</cite></div>`).join("");
  const feat = arr(k.featured?.items).map((f) => `<article><h3>${esc(f.h3)}</h3><p>${esc(f.p)}</p><a class="btn" href="#cta">Book Now</a></article>`).join("");
  const aboutParas = arr(k.about?.paras).map((p) => `<p>${esc(p)}</p>`).join("");
  const hasAbout = !!(k.about && k.about.image);
  const memCount = arr(k.providers?.members).length;

  return head(k, CSS) + `
  <div class="topbar">${esc(b.topbar || b.city || "")}</div>
  <header><nav class="nav wrap">
      <ul id="menu"><li><a href="#about">About</a></li><li><a href="#specialties">Services</a></li>${memCount ? '<li><a href="#providers">Providers</a></li>' : ""}<li><a href="#testi">Reviews</a></li><li><a href="#cta">Contact</a></li></ul>
      <a class="logo" href="#">${b.logoImg ? `<img class="logo-ic" src="${esc(b.logoImg)}" alt="" onerror="this.remove()"/>` : ""}<span class="logo-tx">${esc(b.name || "MED SPA")}<span>${esc(b.sub || "")}</span></span></a>
      <div class="nav-right"><a class="phone" href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a><a class="btn" href="#cta">Book a Visit</a>
        <button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button></div>
  </nav></header>
  <section class="hero"><div class="hero-bg">${k.hero?.image ? cover(k.hero.image) : ""}</div><div class="wrap">
      <p class="eyebrow">${esc(k.hero?.eyebrow)}</p><h1>${esc(k.hero?.h1)}</h1><p>${esc(k.hero?.body)}</p>
      <a class="btn btn--light" href="#cta">${esc(k.hero?.cta || "Book a Visit")}</a></div></section>
  <section class="about" id="about"><div class="wrap about-grid${hasAbout ? "" : " solo"}">
      <div class="about-copy"><p class="eyebrow">${esc(k.about?.eyebrow)}</p><h2>${esc(k.about?.h2)}</h2>
        <div style="margin-top:24px">${aboutParas}</div><a class="btn" href="#cta">${esc(k.about?.cta || "Book Now")}</a></div>
      ${hasAbout ? `<div class="about-img">${cover(k.about.image)}</div>` : ""}</div></section>
  <div class="strip"><div class="wrap">${strip}</div></div>
  <section class="section" id="specialties"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.specialties?.eyebrow)}</p><h2>${esc(k.specialties?.h2)}</h2><p>${esc(k.specialties?.intro)}</p></div>
      <div class="cards">${cards}</div></div></section>
  ${memCount ? `<section class="section providers" id="providers"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.providers?.eyebrow)}</p><h2>${esc(k.providers?.h2)}</h2></div>
      <div class="tabs">${tabs}</div><div class="team" style="--cols:${Math.min(memCount, 4)}">${members}</div></div></section>` : ""}
  <section class="testi" id="testi"><div class="wrap"><div class="center"><p class="eyebrow">${esc(k.testimonials?.eyebrow)}</p><h2>${esc(k.testimonials?.h2)}</h2></div><div class="quotes">${quotes}</div></div></section>
  <section class="section"><div class="wrap"><div class="center"><h2>${esc(k.featured?.h2)}</h2></div><div class="feat">${feat}</div></div></section>
  <section class="cta" id="cta"><div class="wrap"><p class="eyebrow">${esc(k.cta?.eyebrow)}</p><h2>${esc(k.cta?.h2)}</h2><p>${esc(k.cta?.body)}</p>
      <a class="btn" href="tel:${esc(b.phone || "")}">Contact Us</a><div class="contactline">${esc(b.phone || "")}${b.email ? " · " + esc(b.email) : ""}</div></div></section>
  <footer><div class="wrap"><div class="foot-grid">
        <div><div class="logo" style="color:#fff;margin-bottom:18px">${esc(b.name || "")}</div><p>${esc(k.footer?.blurb)}</p></div>
        <div><h5>Explore</h5><ul><li><a href="#about">About</a></li><li><a href="#specialties">Services</a></li></ul></div>
        <div><h5>Company</h5><ul><li><a href="#">Blog</a></li><li><a href="#cta">Contact</a></li></ul></div>
        <div><h5>Visit</h5><ul><li>${esc(b.city || "")}</li><li><a href="tel:${esc(b.phone || "")}">${esc(b.phone || "")}</a></li></ul></div></div>
      <div class="foot-bottom"><span>© 2026 ${esc(b.name || "")}. All rights reserved.</span><span>Privacy · Terms</span></div></div></footer>
  <script>document.getElementById('burger').addEventListener('click',function(){document.getElementById('menu').classList.toggle('open')});
    document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});t.classList.add('active')})});</script>
  ` + foot();
}
