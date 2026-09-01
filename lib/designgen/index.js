// designgen engine — the design-gen methodology, ported into the build tool.
//
// Same pipeline as the standalone design-gen project (scrape a reference site →
// deterministic brand tokens → Gemini writes a design brief → Gemini builds 4
// pages against a vendored premium design system → inject the motion layer), but
// it emits the build tool's GEN/site contract (index/services/about/contact.html
// + assets/site.js) instead of running its own HTTP server, so the existing
// gitops compile → push → PR pipeline ships it unchanged.
//
// The craft (system.css, premium.css, premium.js) is VENDORED in ./assets — it is
// the fixed framework, not per-site output. Everything else is generated fresh
// per job from the reference URL. No dependency on the external design-gen server.
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "assets");
const SYSTEM_CSS = fs.readFileSync(path.join(ASSETS, "system.css"), "utf8");
const PREMIUM_CSS = fs.readFileSync(path.join(ASSETS, "premium.css"), "utf8");
const PREMIUM_JS = fs.readFileSync(path.join(ASSETS, "premium.js"), "utf8");

const KEYS = () => (process.env.GEMINI_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = ["gemini-flash-latest", "gemini-3.6-flash", process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"];
// Stock-image fallback pool (build tool's image-pool). Only used when the
// reference site is image-poor. The pool base URL must be publicly reachable by
// the live WP site — set DESIGNGEN_POOL_BASE to enable; otherwise stock is off
// (a localhost URL would 404 on the deployed site).
const POOL_DIR = path.join(__dirname, "..", "..", "image-pool");
const POOL_BASE = process.env.DESIGNGEN_POOL_BASE || "";

const noop = () => {};

// ---- gemini (key rotation + model fallback + waves) — ported verbatim --------
async function gemini(parts, { temperature = 0.6, maxTokens = 20000, models = MODELS, waves = 1 } = {}) {
  const keys = KEYS();
  if (!keys.length) throw new Error("designgen: GEMINI_KEYS not set");
  let last;
  for (let wave = 0; wave < waves; wave++) {
    if (wave) await new Promise((r) => setTimeout(r, 25000));
    for (const model of models) {
      for (const key of keys) {
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature, maxOutputTokens: maxTokens } }),
          });
          const d = await r.json();
          if (!r.ok) { last = `${model} → ${r.status}`; continue; }
          const t = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map((p) => p.text || "").join("");
          if (t) return { text: t, model };
          last = `${model} → empty (${(d.candidates && d.candidates[0] && d.candidates[0].finishReason) || "?"})`;
        } catch (e) { last = `${model} → ${e.message.slice(0, 60)}`; }
      }
    }
  }
  throw new Error("Gemini failed on every model/key — last: " + last);
}

// ---- stock pool (only when POOL_BASE is configured) --------------------------
function poolPick(category, n) {
  if (!POOL_BASE) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(POOL_DIR, "manifest.json"), "utf8"));
    const items = manifest.filter((m) => m.category === category);
    const out = [];
    const step = Math.max(1, Math.floor(items.length / n));
    for (let i = 0; i < items.length && out.length < n; i += step) out.push(items[i]);
    return out.map((m) => ({ src: `${POOL_BASE.replace(/\/$/, "")}/pool/${m.file}`, w: m.w, h: m.h, alt: m.alt || "", stock: true }));
  } catch (e) { return []; }
}

// ---- overlay killer — ported verbatim ----------------------------------------
async function killOverlays(p) {
  await p.keyboard.press("Escape").catch(() => {});
  await p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    for (const el of document.querySelectorAll("button, a, [role=button], [class*=close], [aria-label]")) {
      const t = (el.textContent || "").trim(), al = el.getAttribute("aria-label") || "";
      const r = el.getBoundingClientRect();
      if (!r.width || r.width > 90 || r.height > 90) continue;
      if (/^(×|x|✕|✖|close|no thanks|dismiss)$/i.test(t) || /close|dismiss/i.test(al)) { try { el.click(); } catch (e) {} }
    }
    const pts = [[vw / 2, vh / 2], [vw / 2, vh * 0.25], [vw / 2, vh * 0.75], [vw * 0.25, vh / 2], [vw * 0.75, vh / 2]];
    for (let round = 0; round < 8; round++) {
      let removed = false;
      for (const [x, y] of pts) {
        let el = document.elementFromPoint(x, y), victim = null;
        while (el && el !== document.body && el !== document.documentElement) {
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          const big = r.width > vw * 0.35 && r.height > vh * 0.35;
          if ((cs.position === "fixed" || cs.position === "absolute") && big &&
              (parseInt(cs.zIndex || "0") > 10 || /modal|popup|overlay|dialog|lightbox/i.test(el.className + " " + el.id) || el.matches("dialog,[role=dialog],[aria-modal=true]"))) victim = el;
          el = el.parentElement;
        }
        if (victim) { victim.remove(); removed = true; }
      }
      for (const el of document.querySelectorAll("dialog[open],[role=dialog],[aria-modal=true],[class*=popup],[id*=popup],[class*=modal],[id*=modal]")) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width > vw * 0.3 && r.height > vh * 0.3 && cs.visibility !== "hidden" && cs.display !== "none") { el.remove(); removed = true; }
      }
      if (!removed) break;
    }
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
  }).catch(() => {});
  await p.waitForTimeout(400);
}

// ---- liveness probe — ported verbatim ----------------------------------------
async function checkUrl(u) {
  const probe = async (method, headers) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 7000);
    try {
      const r = await fetch(u, { method, headers: { "User-Agent": "Mozilla/5.0 DesignGen", ...headers }, redirect: "follow", signal: ac.signal });
      return r.status;
    } catch (e) { return 0; } finally { clearTimeout(t); }
  };
  let st = await probe("HEAD", {});
  if (st === 405 || st === 501 || st === 403) st = await probe("GET", { Range: "bytes=0-256" });
  return (st >= 200 && st < 300) || st === 206;
}

// ---- scrape — ported verbatim (fetch facts/palette + playwright screenshots) --
async function scrape(url, log) {
  const full = /^https?:\/\//i.test(url) ? url : "https://" + url;
  const r = await fetch(full, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 DesignGen" } });
  if (!r.ok) throw new Error(`reference site returned HTTP ${r.status}`);
  const html = await r.text();
  const abs = (u) => { try { return new URL(u, r.url).href; } catch (e) { return null; } };
  const textOf = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [, ""])[1];
  const og1 = html.match(/property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/i);
  const og2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:image/i);
  let ogImage = abs(((og1 || og2 || [, ""])[1] || "").replace(/&amp;/g, "&")) || "";

  const headings = [...html.matchAll(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => ({ tag: m[1].toLowerCase(), text: textOf(m[2]).slice(0, 90) }))
    .filter((h) => h.text).slice(0, 30);

  const images = [...html.matchAll(/<img\b[^>]*?\b(?:data-lazy-src|data-src|src)=["']([^"']+)["']/gi)]
    .map((m) => abs(m[1])).filter(Boolean)
    .filter((u) => /\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) && !/logo|icon|sprite|favicon|1x1|pixel/i.test(u));
  const uniqImages = [...new Set(images)].slice(0, 20);

  const counts = new Map();
  const countColors = (txt) => {
    for (const m of txt.matchAll(/#([0-9a-f]{6})\b/gi)) { const h = "#" + m[1].toLowerCase(); counts.set(h, (counts.get(h) || 0) + 1); }
    for (const m of txt.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) { const h = "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join(""); counts.set(h, (counts.get(h) || 0) + 1); }
  };
  countColors(html);
  const cssLinks = [...new Set([...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => abs(m[1])).filter(Boolean))].slice(0, 8);
  log(`reading ${cssLinks.length} stylesheet(s) for palette`);
  await Promise.all(cssLinks.map(async (cu) => {
    try { const cr = await fetch(cu, { headers: { "User-Agent": "Mozilla/5.0 DesignGen" } }); if (cr.ok) countColors((await cr.text()).slice(0, 400000)); } catch (e) { /* best effort */ }
  }));
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} (×${n})`).slice(0, 20);

  const fonts = [...html.matchAll(/fonts\.googleapis\.com\/css2?\?[^"']+/gi)].map((m) => decodeURIComponent(m[0]));

  let shots = [], liveImages = [], subShots = [], subFacts = [];
  let brand = { logo: "", videoPoster: "", hasHeroVideo: false };
  try {
    log("capturing screenshots (playwright: top, middle, bottom)");
    const { chromium } = require("playwright");
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1280, height: 1400 } });
    await p.goto(full, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(2200);
    await p.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await s(160); } window.scrollTo(0, 0); await s(400); });
    await killOverlays(p);
    brand = await p.evaluate(() => {
      const out = { logo: "", videoPoster: "", hasHeroVideo: false };
      for (const img of document.querySelectorAll("header img, nav img, [class*=logo] img, img[class*=logo], img[alt*=logo i]")) {
        const src = img.currentSrc || img.src || "";
        if (/userway|widget|accessib|gravatar|captcha|chat/i.test(src)) continue;
        if (src && /^https?:/.test(src) && img.naturalWidth > 40) { out.logo = src; break; }
      }
      const v = [...document.querySelectorAll("video")].find((el) => el.getBoundingClientRect().top < 900);
      if (v) { out.hasHeroVideo = true; out.videoPoster = v.poster && /^https?:/.test(v.poster) ? v.poster : ""; }
      return out;
    }).catch(() => ({ logo: "", videoPoster: "", hasHeroVideo: false }));
    const H = await p.evaluate(() => document.body.scrollHeight);
    for (const y of [0, Math.floor(H * 0.4), Math.max(0, H - 1400)]) {
      await p.evaluate((yy) => window.scrollTo(0, yy), y);
      await p.waitForTimeout(1100);
      shots.push((await p.screenshot({ type: "jpeg", quality: 62 })).toString("base64"));
    }
    const collect = () => [...document.images]
      .filter((i) => i.naturalWidth > 250 && !/logo|icon|sprite|favicon/i.test(i.currentSrc || ""))
      .map((i) => ({ src: i.currentSrc, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt || "" }));
    liveImages = await p.evaluate(collect);
    const subs = await p.evaluate(() => [...document.querySelectorAll("a")]
      .map((a) => ({ href: a.href, t: ((a.textContent || "") + " " + a.href).trim().toLowerCase() }))
      .filter((x) => x.href.startsWith(location.origin) && x.href.replace(/[#?].*$/, "") !== location.href.replace(/[#?].*$/, "")));
    const kindOf = (t) => /service|treatment|menu/.test(t) ? "services" : /about|team|meet|staff|provider/.test(t) ? "about" : /contact|location|visit[-_ ]us/.test(t) ? "contact" : /gallery/.test(t) ? "gallery" : null;
    const picked = new Map();
    for (const s2 of subs) { const k = kindOf(s2.t); if (k && !picked.has(k)) picked.set(k, s2.href); }
    for (const [kind, sub] of [...picked].slice(0, 4)) {
      try {
        await p.goto(sub, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
        await killOverlays(p);
        await p.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await s(140); } window.scrollTo(0, 0); await s(400); });
        liveImages.push(...await p.evaluate(collect));
        subShots.push({ kind, b64: (await p.screenshot({ type: "jpeg", quality: 55 })).toString("base64") });
        const f = await p.evaluate(() => ({
          headings: [...document.querySelectorAll("h1,h2,h3")].map((h) => (h.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90)).filter(Boolean).slice(0, 25),
          text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 3500),
        }));
        subFacts.push({ kind, url: sub, ...f });
        log(`crawled ${kind} page ${sub.replace(full, "/")}`);
      } catch (e) { /* best effort */ }
    }
    await b.close();
    log(`screenshots captured: ${shots.length} shots · ${liveImages.length} live image(s) harvested`);
  } catch (e) { log(`screenshots skipped: ${e.message.slice(0, 80)}`); }

  const seen = new Set();
  const allImages = [];
  for (const im of [...liveImages, ...uniqImages.map((u) => ({ src: u, w: 0, h: 0, alt: "" }))]) {
    const key = im.src.split("?")[0];
    if (!im.src || seen.has(key)) continue;
    seen.add(key); allImages.push(im);
    if (allImages.length >= 30) break;
  }

  log(`validating ${allImages.length} image link(s)`);
  const flags = await Promise.all(allImages.map((im) => checkUrl(im.src)));
  const validImages = allImages.filter((_, i) => flags[i]);
  const brokenCount = allImages.length - validImages.length;
  if (brokenCount) log(`dropped ${brokenCount} of ${allImages.length} broken image link(s)`);
  if (ogImage && !(await checkUrl(ogImage))) ogImage = "";
  if (brand.logo && !(await checkUrl(brand.logo))) brand.logo = "";
  if (brand.videoPoster && !(await checkUrl(brand.videoPoster))) brand.videoPoster = "";
  if (brand.logo) log(`logo found: ${brand.logo.slice(0, 90)}`);

  const text = textOf(html).slice(0, 9000);
  return { url: r.url, title, metaDesc, headings, images: validImages, palette, fonts, text, shots, subShots, subFacts,
    ogImage, logo: brand.logo, videoPoster: brand.videoPoster, hasHeroVideo: brand.hasHeroVideo };
}

// ---- deterministic brand tokens — ported verbatim ----------------------------
function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbHex(c) { return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function lum(c) { const f = c.map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * f[0] + .7152 * f[1] + .0722 * f[2]; }
function chroma(c) { return (Math.max(...c) - Math.min(...c)) / 255; }
function hue(c) {
  const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function mix(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

function brandTokens(palette) {
  const list = palette.map((p) => {
    const m = /^(#[0-9a-f]{6})\s*\(×(\d+)\)/i.exec(p) || /^(#[0-9a-f]{6})/i.exec(p);
    const c = m && hexRgb(m[1]);
    return c ? { hex: m[1].toLowerCase(), c, n: m && m[2] ? +m[2] : 1, L: lum(c), C: chroma(c), H: hue(c) } : null;
  }).filter(Boolean);

  const ink = list.filter((x) => x.L <= .26 && x.C < .3).sort((a, b) => b.n - a.n)[0];
  const INK = ink ? ink.c : hexRgb("#1b1d22");
  const brand = list.filter((x) => x.C >= .06 && x.C <= .45 && x.L > .12 && x.L < .78).sort((a, b) => b.n - a.n)[0];
  const BRAND = brand ? brand.c : hexRgb("#b08d57");
  const BH = hue(BRAND);
  const creamCand = list.filter((x) => x.L >= .84 && x.L <= .975 && x.C >= .02 && x.C <= .22 && hueDist(x.H, BH) <= 42).sort((a, b) => b.n - a.n)[0];
  const CREAM = creamCand ? creamCand.c : mix(hexRgb("#ffffff"), BRAND, .11);
  const BG = mix(hexRgb("#ffffff"), BRAND, .015);
  const ON_BRAND = lum(BRAND) > .52 ? mix(INK, hexRgb("#000000"), .25) : hexRgb("#ffffff");
  return {
    ink: rgbHex(INK), bg: rgbHex(BG), cream: rgbHex(CREAM),
    brand: rgbHex(BRAND), onBrand: rgbHex(ON_BRAND),
    inkBand: rgbHex(mix(INK, hexRgb("#000000"), .28)),
  };
}

// ---- motion layer, adapted for the gitops pipeline ---------------------------
// design-gen links /assets/{system,premium}.css + premium.js. Our gitops compiler
// hoists <style> into WordPress custom_css and strips <script> from html widgets,
// so instead we INLINE the two stylesheets as <style> (system's `.ds` base is
// rewritten to `body`, since the compiler drops the body tag+class), and carry
// premium.js as a page-end <script> for the local preview only (the compiler
// strips it and re-ships it as the site-wide g99-site-js snippet — see the
// assets/site.js the engine writes and compile.js's snippet emission).
const NAV_SHIM = `\n/* mobile nav toggle (design system: .c-nav__links.is-open) */\n(function(){var t=document.querySelector('.c-nav__toggle')||document.getElementById('navToggle');var l=document.querySelector('.c-nav__links')||document.getElementById('navLinks')||document.getElementById('navMenu');if(t&&l)t.addEventListener('click',function(){l.classList.toggle('is-open');l.classList.toggle('is-active');});})();\n`;
const SITE_JS = PREMIUM_JS + NAV_SHIM;
// system.css scopes its base reset + typography under `.ds` (which design-gen puts
// on <body>). The compiler extracts body INNER html and drops the body tag, so the
// `.ds` ancestor would vanish and the base styles with it. `.ds` → `body` keeps the
// exact same intent (whole-page scope) on a selector that survives.
const SYSTEM_CSS_WP = SYSTEM_CSS.replace(/\.ds\b/g, "body");

// Authoritative brand-token block. The build prompt hands the model the exact
// computed tokens, but Gemini still sometimes copies a vendor colour it saw on
// the reference (e.g. ruma.com's #e9e6ed lavender-grey as --cream), which then
// tints every .u-cream band the wrong hue. Appending the real tokens LAST (same
// :root specificity → last wins) makes the palette deterministic regardless.
function tokenOverrideCss(TOK) {
  // 1) lock the six tokens to the computed values (model sometimes copies a vendor
  //    colour into --cream etc.). 2) Palette lock: headings take their band's colour
  //    (white on dark, ink on light — system default) and inline emphasis is the one
  //    brand accent, overriding any off-brand colour the model hardcoded on them
  //    (e.g. a teal heading). h4 is left alone (.c-foot h4 is intentionally #fff).
  return `:root{--ink:${TOK.ink};--bg:${TOK.bg};--cream:${TOK.cream};--brand:${TOK.brand};--on-brand:${TOK.onBrand};--ink-band:${TOK.inkBand};}\n`
    + `body :is(h1,h2,h3){color:inherit!important}\n`
    + `body .u-em{color:var(--brand)!important}`;
}

function withMotionLayer(html, tokensCss = "") {
  // system base first (page CSS may override), premium last (only adds).
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<style data-dg="system">\n${SYSTEM_CSS_WP}\n</style>\n`);
  else html = `<style data-dg="system">\n${SYSTEM_CSS_WP}\n</style>\n` + html;
  // premium motion CSS, then the authoritative token override — injected in this
  // order right before </head> so tokens are the very last rule the compiler sees.
  const premiumStyle = `<style data-dg="premium">\n${PREMIUM_CSS}\n</style>\n`
    + (tokensCss ? `<style data-dg="tokens">\n${tokensCss}\n</style>\n` : "");
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, premiumStyle + "</head>") : premiumStyle + html;
  // page-end script: preview-only; the gitops compiler strips it and re-ships it as
  // the g99-site-js snippet. Guard against a stray </script> in the JS breaking it.
  const scriptTag = `\n<script>\n${SITE_JS.replace(/<\/script>/gi, "<\\/script>")}\n</script>\n`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, scriptTag + "</body>") : html + scriptTag;
  return html;
}

// ---- pipeline ----------------------------------------------------------------
const PAGE_DEFS = [
  { key: "", file: "index.html", label: "Home", tokens: 60000, extra: `Build the HOME page: follow the "PAGE: HOME" block of the design prompt exactly — every section, in order, with its assigned images.` },
  { key: "services", file: "services.html", label: "Services", tokens: 50000, extra: `Build the SERVICES page: follow the "PAGE: SERVICES" block of the design prompt exactly — page-header band WITH its assigned background image, every service card WITH its assigned image (grids without full image coverage go elegant text-only), grouped into categories with an editorial, alternating-band layout. This page must look as designed and premium as the home page — never a flat list. End with the CTA band and the same footer as home.` },
  { key: "about", file: "about.html", label: "About", tokens: 45000, extra: `Build the ABOUT page: follow the "PAGE: ABOUT" block of the design prompt exactly — page-header band with its assigned image, story, values, team grid with each assigned [portrait] matched to its named person (all-or-nothing), stats if specified, CTA band, same footer as home.` },
  { key: "contact", file: "contact.html", label: "Contact", tokens: 40000, extra: `Build the CONTACT page: follow the "PAGE: CONTACT" block of the design prompt exactly — page-header band with its assigned image, contact details ONLY from the data (omit anything missing), a simple contact form (non-functional), an embedded Google Maps iframe ONLY if a street address exists in the data (src="https://maps.google.com/maps?q=<url-encoded address>&output=embed"), same footer as home.` },
];
const MIN_KB = 14;

// Gemini writes each page as an independent document, so the header (nav
// labels, mobile drawer markup, phone/CTA) and footer (columns, hours, socials)
// come out slightly different per page even though they share one design
// system — the site reads as 4 stitched-together sites instead of one. The
// home page's chrome is the canonical version; every other page's <header> and
// <footer> are replaced with it byte-for-byte, keeping only that page's own
// active-nav-link state (aria-current="page" / a matching "is-active" class).
// Brace-aware CSS rule collector: pulls every rule (keeping @media wrappers
// intact) whose selector references one of the given class tokens. Matching
// is substring-based on purpose — a token of "c-btn" also catches the
// "c-btn--light" modifier selector, since ".c-btn--light" contains ".c-btn".
function collectRulesForTokens(css, tokens) {
  if (!tokens.length) return "";
  const testSel = (sel) => tokens.some((t) => sel.includes("." + t));
  const walk = (block) => {
    const out = [];
    let i = 0;
    while (i < block.length) {
      const open = block.indexOf("{", i);
      if (open < 0) break;
      const header = block.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < block.length && depth) { if (block[j] === "{") depth++; else if (block[j] === "}") depth--; j++; }
      const body = block.slice(open + 1, j - 1);
      if (/^@media/.test(header)) { const inner = walk(body); if (inner) out.push(header + "{" + inner + "}"); }
      else if (/^@/.test(header)) { /* @import/@font-face etc — never chrome rules */ }
      else if (testSel(header)) out.push(header + "{" + body + "}");
      i = j;
    }
    return out.join("\n");
  };
  return walk(css);
}

// Merge every :root{...} block in document order, later re-declarations of
// the SAME property winning (mirrors real CSS custom-property cascade) —
// gives one token -> literal-value map for the page.
function collectRootTokens(css) {
  const map = {};
  const rootBlocks = css.match(/:root\s*\{[^}]*\}/g) || [];
  for (const block of rootBlocks) {
    for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  }
  return map;
}

// Resolve simple `var(--token)` references (no fallback arg) to their literal
// value from `tokens`. A rule copied from home can use a custom property that
// is only ever DEFINED on home's own page (e.g. `--dark-band`, a one-off Gemini
// wrote for that page's footer, never added to the shared system tokens) — the
// class-token collector copies the RULE but not the :root declaration behind
// it, so on every other page the property is unset and the value falls back to
// CSS's initial value (transparent, for a background) — the reported bug.
// Resolving to a literal here makes the injected CSS self-contained.
function resolveVars(css, tokens) {
  return css.replace(/var\((--[\w-]+)\)/g, (m, name) => (tokens[name] != null ? tokens[name] : m));
}

function unifyChrome(pages, siteDir, log) {
  const home = pages.home;
  if (!home) return;
  const extract = (html, tag) => {
    const m = html.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "i"));
    return m ? m[0] : null;
  };
  // The nav bar is NOT reliably a `<header>` tag — one generation used
  // `<header class="c-hero">` for the HOME PAGE'S OWN HERO SECTION (nav was a
  // bare `<nav>`), and blindly copying "the first <header>" replaced every
  // other page's unique hero/pagehead with home's hero, deleting their real
  // nav entirely (reported live: every page but home lost its header). Identify
  // the nav TAG NAME by content (must link to >=2 of the site's own pages, must
  // NOT contain an <h1> — a hero/pagehead always has the page's h1, a nav bar
  // never does) via cheerio, then extract the exact raw substring by REGEX using
  // that tag name — cheerio's serialized re-render is not guaranteed byte-
  // identical to the source, and a substring replace on a near-match silently
  // no-ops, so cheerio here is only ever used to pick which tag to trust, never
  // as the text that gets spliced back in.
  const navTagOf = (html) => {
    const cheerio = require("cheerio");
    const $ = cheerio.load(html);
    const pagePat = /(^|\/)(index\.html|services\.html|about\.html|contact\.html)(#|$|\?)|^\/(services|about|contact)?\/?$/i;
    for (const el of [...$("header, nav")]) {
      const $el = $(el);
      if ($el.find("h1").length) continue;
      const hrefs = new Set($el.find("a[href]").map((_, a) => $(a).attr("href")).get().filter((h) => pagePat.test(h)));
      if (hrefs.size >= 2) return el.tagName && el.tagName.toLowerCase();
    }
    return null;
  };
  const homeNavTag = navTagOf(home);
  const homeHeader = homeNavTag && extract(home, homeNavTag);
  const homeFooterRaw = extract(home, "footer");
  // Defense in depth on footer too: a footer should never carry the page's
  // main heading either.
  const homeFooter = homeFooterRaw && !/<h1\b/i.test(homeFooterRaw) ? homeFooterRaw : null;
  if (homeFooterRaw && !homeFooter) log("unifyChrome: home's <footer> contains an <h1> — skipping footer unification as unsafe");
  if (!homeHeader && !homeFooter) { log("unifyChrome: could not confidently identify a shared nav or footer — skipping chrome unification"); return; }
  // Same markup still renders differently if the SHARED class (.c-btn--light,
  // .c-nav) is styled differently in each page's own <style> block — Gemini
  // writes CSS per page too. Home's header/footer classes are the source of
  // truth; their rules get appended (after the page's own <style>, so equal
  // specificity resolves to home's value) to every other page.
  const classTokens = (html) => [...new Set((html.match(/class="([^"]+)"/g) || [])
    .flatMap((m) => m.slice(7, -1).split(/\s+/)).filter(Boolean)
    .map((c) => c.split("__")[0].split("--")[0]))];
  const chromeTokens = [...new Set([...classTokens(homeHeader || ""), ...classTokens(homeFooter || "")])];
  const homeCss = (home.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).map((s) => s.replace(/^<style[^>]*>|<\/style>$/gi, "")).join("\n");
  const rootTokens = collectRootTokens(homeCss);
  const chromeCss = resolveVars(collectRulesForTokens(homeCss, chromeTokens), rootTokens);
  for (const [key, html] of Object.entries(pages)) {
    if (key === "home") continue;
    let out = html;
    if (homeHeader) {
      // Independently identify THIS page's own nav — it can use a different
      // tag than home's (defensive; same job usually keeps one convention, but
      // guessing wrong here is exactly the bug that shipped last time).
      const pageNavTag = navTagOf(out);
      const pageHeader = pageNavTag && extract(out, pageNavTag);
      if (pageHeader) {
        // carry over ONLY this page's active-link marking, so the nav still
        // highlights the page you're on
        // Scope to the <nav> sub-block: the header also holds a phone link and
        // a "Book a Visit" CTA that can coincidentally share the page's href
        // (a CTA pointing at /contact.html on the contact page itself) — tagging
        // those with aria-current="page" too triggers the site's global
        // `[aria-current]{color:var(--brand)}` rule and recolours the button.
        const pageNav = extract(pageHeader, "nav") || pageHeader;
        const activeHref = (pageNav.match(/<a\b[^>]*\bhref="([^"]+)"[^>]*\baria-current="page"/i) || [])[1];
        // strip HOME's own active marker first — otherwise "Home" stays lit on
        // every page (the bug this replaced: the copied header kept index.html's
        // aria-current, and the new one was only ever added alongside it).
        let header = homeHeader.replace(/\s*aria-current="page"/gi, "");
        if (activeHref) {
          const homeNav = extract(header, "nav") || header;
          const esc = activeHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const navOut = homeNav.replace(new RegExp(`(<a\\b[^>]*\\bhref="${esc}"[^>]*?)(\\s*/?>)`, "i"), (m, pre, close) => pre + ` aria-current="page"` + close);
          header = header === homeNav ? navOut : header.replace(homeNav, navOut);
        }
        if (out.includes(pageHeader)) out = out.replace(pageHeader, header);
        else log(`unifyChrome: ${key} nav substring not found verbatim — skipping header swap for this page (left as generated)`);
      } else {
        log(`unifyChrome: could not confidently find ${key}'s own nav — leaving its header untouched`);
      }
    }
    if (homeFooter) {
      const pageFooter = extract(out, "footer");
      if (pageFooter && !/<h1\b/i.test(pageFooter)) {
        if (out.includes(pageFooter)) out = out.replace(pageFooter, homeFooter);
      }
    }
    if (chromeCss && !out.includes("g99 canonical chrome styles")) {
      out = out.replace(/<\/style>(?![\s\S]*<\/style>)/i, `\n/* g99 canonical chrome styles (from home) */\n${chromeCss}\n</style>`);
    }
    if (out !== html) {
      pages[key] = out;
      const pg = PAGE_DEFS.find((p) => (p.key || "home") === key);
      if (pg) fs.writeFileSync(path.join(siteDir, pg.file), out);
      log(`unified header/footer on ${key || "home"}`);
    }
  }
}

/**
 * Generate a 4-page site from a reference URL and write it into siteDir in the
 * build tool's GEN/site contract (index/services/about/contact.html + assets/site.js).
 * @param {object} o
 * @param {string} o.referenceUrl   the design reference (e.g. https://ruma.com)
 * @param {string} o.siteDir        GEN/site — where to write the pages
 * @param {function} [o.log]        progress logger
 * @returns {{pages:object, prompt:string, tokens:object, warnings:string[]}}
 */
async function generateDesigngenSite(o) {
  const log = o.log || noop;
  const referenceUrl = o.referenceUrl;
  const siteDir = o.siteDir;
  if (!referenceUrl) throw new Error("designgen: referenceUrl is required");
  if (!siteDir) throw new Error("designgen: siteDir is required");
  const warnings = [];

  log(`scraping reference site ${referenceUrl}`);
  const s = await scrape(referenceUrl, log);
  log(`scrape complete: "${s.title.slice(0, 60)}" · ${s.headings.length} headings · ${s.images.length} images · ${s.palette.length} colours`);

  // top up from stock pool when image-poor (no-op unless DESIGNGEN_POOL_BASE set)
  const portraits = s.images.filter((im) => im.w && im.h > im.w * 1.02).length;
  const wides = s.images.filter((im) => im.w >= 900 && im.w > im.h).length;
  const added = [];
  if (wides < 2) added.push(...poolPick("hero", 2 - wides));
  if (portraits < 3) added.push(...poolPick("providers", 4));
  if (s.images.length + added.length < 10) added.push(...poolPick("services", 10 - s.images.length - added.length));
  if (added.length) { s.images.push(...added); log(`added ${added.length} stock image(s) from the pool`); }
  else if (!POOL_BASE && (wides < 2 || portraits < 3)) warnings.push("reference is image-poor and DESIGNGEN_POOL_BASE is not set — no stock fallback");

  // hero selection (deterministic + vision verify) — ported verbatim
  const logoish = (u) => /logo|social[-_]?share|og[-_]|favicon|icon|badge|ajax|\?action=/i.test(u || "");
  let heroIm = null;
  if (s.videoPoster && !logoish(s.videoPoster)) heroIm = { src: s.videoPoster, w: 0, h: 0, alt: "hero video poster" };
  else if (s.ogImage && !logoish(s.ogImage) && s.images.some((im) => im.src.split("?")[0] === s.ogImage.split("?")[0])) heroIm = { src: s.ogImage, w: 0, h: 0, alt: "og:image" };
  if (heroIm && !s.images.some((im) => im.src.split("?")[0] === heroIm.src.split("?")[0])) s.images.unshift(heroIm);
  const own = s.images.filter((im) => !im.stock && !logoish(im.src));
  const heroSrc = (heroIm
    || own.filter((im) => im.w >= 900 && im.w > im.h).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    || own.filter((im) => im.w >= 600 && im.w >= im.h).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    || own.sort((a, b) => b.w * b.h - a.w * a.h)[0]
    || s.images.filter((im) => im.w >= 900 && im.w > im.h && !logoish(im.src))[0]
    || s.images.find((im) => !logoish(im.src)) || s.images[0] || {}).src;
  let heroFinal = heroSrc;
  if (!heroIm) {
    const shortlist = own.filter((im) => im.w >= 500).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 6);
    if (shortlist.length > 1) {
      try {
        const parts = [{ text: `Pick the best HERO background image for a premium medical-spa homepage from the attached candidates (in order, 1-indexed).
Reject any image that is a logo, wordmark, device/brand graphic, text banner, screenshot, chart, or product packaging shot.
Prefer a wide, atmospheric photograph: clinic interior, treatment room, lifestyle, or a person receiving care.
Reply ONLY JSON: {"best": <1-based index of the best usable photo, or 0 if none qualify>}` }];
        const bufs = [];
        for (const im of shortlist) {
          try {
            const rr = await fetch(im.src, { headers: { "User-Agent": "Mozilla/5.0 DesignGen" } });
            if (!rr.ok) continue;
            const buf = Buffer.from(await rr.arrayBuffer());
            if (buf.length < 6000 || buf.length > 3_500_000) continue;
            const mime = /\.png/i.test(im.src) ? "image/png" : /\.webp/i.test(im.src) ? "image/webp" : "image/jpeg";
            parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
            bufs.push(im);
          } catch (e) { /* skip */ }
        }
        if (bufs.length > 1) {
          const v = await gemini(parts, { temperature: 0.1, maxTokens: 200, models: MODELS.slice(0, 2), waves: 2 });
          const pick = JSON.parse(v.text.trim().replace(/^```json?/i, "").replace(/```$/, "").trim());
          if (pick.best > 0 && bufs[pick.best - 1]) { heroFinal = bufs[pick.best - 1].src; log(`hero verified by vision: candidate ${pick.best}/${bufs.length}`); }
          else if (pick.best === 0) { const sh = poolPick("hero", 1)[0]; if (sh) { s.images.unshift(sh); heroFinal = sh.src; warnings.push("no usable hero on reference — using stock"); } }
        }
      } catch (e) { log(`hero vision check skipped: ${e.message.slice(0, 60)}`); }
    }
  }
  const heroSrcFinal = heroFinal;
  if (heroSrcFinal) log(`hero image: ${heroSrcFinal.slice(0, 90)}`);

  // step 1 — Gemini writes the design brief
  log("asking Gemini to write the design brief (1st AI call)");
  const metaPrompt = `You are an elite art director. Below is scraped data from a reference website${s.shots.length ? " plus " + s.shots.length + " attached screenshots of its HOME page (top, middle, bottom)" : ""}${s.subShots.length ? " and " + s.subShots.length + " screenshot(s) of its inner pages (" + s.subShots.map((x) => x.kind).join(", ") + ") — study how the reference designs its INNER pages, not just its home" : ""}.

Write a DETAILED DESIGN & BUILD PROMPT that a second AI will follow to build a NEW 4-page website
(Home, Services, About, Contact) that belongs to the same design family as this reference and looks
just as premium. The prompt must specify, concretely:
1. TYPOGRAPHY — exact font pairing (Google Fonts only; if the reference declares fonts use those, else the
   visually nearest Google fonts), the full type scale (hero size → body), weights, letter-spacing, casing.
2. COLOUR SYSTEM — background tints, ink, accent, on-accent, hover states, section band colours. Use the real
   scraped palette below (pick the true brand tones; ignore vendor defaults like Elementor purple/orange).
3. LAYOUT & COMPOSITION — section by section from the screenshots/headings: hero composition (split? full-bleed?
   centered?), image shapes (arches? rounded? sharp?), grid patterns, spacing rhythm, section order.
4. COMPONENTS — nav style, button shapes, cards, dividers/ornament, footer structure.
5. MOTION — reveal style, hover behaviours, timing.
6. IMAGERY — how photos are treated (crops, overlays, frames). Assign SPECIFIC scraped image URLs to specific
   slots: hero, each service card, about, and EACH provider/team member (use the portrait-shaped images —
   marked [portrait] below — for people; match alt text to names where possible).
7. CONTENT — rewrite the reference's actual content (headings below) elegantly; keep its information architecture.
8. SECTION INVENTORY (MANDATORY) — the prompt must enumerate EVERY section the reference has, in order, and the
   built page must include ALL of them. If the screenshots/headings/text show testimonials or reviews, a
   providers/team section, stats, FAQs, or a gallery — they MUST appear in the prompt with their real content
   (pull actual review quotes and provider names from the page text below). Do not drop sections.
9. BRANDING — ${s.logo ? "the nav and footer MUST use the logo image URL given below (an <img>, never recreate it as text)" : "no logo image was found; design a tasteful text wordmark"}.
   The image marked [HERO] below MUST be the hero image${s.hasHeroVideo ? " (the real site uses a background VIDEO in the hero — apply a slow Ken-Burns zoom on the [HERO] image to evoke that motion)" : ""}.
10. PER-PAGE SPECS (MANDATORY) — the prompt MUST contain four blocks titled exactly "PAGE: HOME",
   "PAGE: SERVICES", "PAGE: ABOUT", "PAGE: CONTACT". Each block lists that page's sections IN ORDER with real
   content AND a SPECIFIC image URL assigned to every image slot (no slot left "choose any"). Rules per page:
   - SERVICES: a compact page-header band with an assigned background image, then EVERY service/treatment found
     in the data (home + services-page data below), grouped into categories; assign a treatment-appropriate
     image URL to EVERY service card — if there aren't enough images for a whole grid, mark that grid TEXT-ONLY
     (elegant typographic cards). Rich, editorial layout — alternating bands, not one flat list.
   - ABOUT: page-header band with assigned image, story, values/process, team grid with each [portrait] image
     assigned to a named person from the data, stats if present.
   - CONTACT: page-header band with assigned image, real contact details from the data only.
   Every page ends with the same pre-footer CTA band + footer as home. These inner pages must feel as
   designed and premium as the home page — mirror the inner-page screenshots where given.

Output ONLY the prompt text (no preamble, no markdown fences). Make it precise enough that the page could be
rebuilt without ever seeing the reference.

SCRAPED DATA
URL: ${s.url}
Title: ${s.title}
Meta: ${s.metaDesc}
Declared fonts: ${s.fonts.join(" | ") || "(none declared — infer nearest Google fonts from screenshots)"}
Logo image: ${s.logo || "(none found)"}
Palette (by frequency): ${s.palette.join(", ")}
Headings in order: ${s.headings.map((h) => `${h.tag}:"${h.text}"`).join(" · ")}
Images (use these EXACT URLs; [portrait] = person-shaped, use for providers/team):
${s.images.map((im) => `${im.src}${im.src === heroSrcFinal ? " [HERO — assign this EXACT image to the hero slot]" : ""}${im.stock ? " [STOCK]" : ""}${im.w && im.h && im.h > im.w ? " [portrait]" : ""}${im.alt ? ` (alt: ${im.alt.slice(0, 60)})` : ""}${im.w ? ` ${im.w}x${im.h}` : ""}`).join("\n")}
NOTE: [STOCK] images are generic med-spa library photos — use them ONLY to fill slots the reference's own images
cannot cover (e.g. missing provider headshots or hero); always prefer the reference's real images first.
Page text (for content — real reviews and provider names are in here): ${s.text.slice(0, 6000)}
${s.subFacts.map((f) => `--- INNER ${f.kind.toUpperCase()} PAGE (${f.url}) ---\nHeadings: ${f.headings.join(" · ")}\nText: ${f.text.slice(0, 2500)}`).join("\n")}`;

  const parts1 = [{ text: metaPrompt }];
  for (const b64 of s.shots) parts1.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
  for (const ss of s.subShots) parts1.push({ inlineData: { mimeType: "image/jpeg", data: ss.b64 } });
  const p1 = await gemini(parts1, { temperature: 0.5, maxTokens: 16000, models: MODELS.slice(0, 2), waves: 3 });
  const brief = p1.text.trim();
  log(`design brief ready (${p1.model} · ${brief.length} chars)`);

  // step 2 — Gemini builds 4 pages from that brief
  const TOK = brandTokens(s.palette);
  log(`brand tokens: ink ${TOK.ink} · brand ${TOK.brand} · tint ${TOK.cream}`);
  // Nav links use the build tool's page-file convention so the gitops compiler
  // rewrites them to WordPress paths (index.html→/, services.html→/services/, …).
  const NAV = `NAVIGATION (IDENTICAL on every page — same links, same labels, same order, same count): exactly these
  four links and NOTHING else — "Home" → "index.html" · "Services" → "services.html" · "About" → "about.html" ·
  "Contact" → "contact.html" — plus the same booking CTA button on the right on every page. Use these exact
  labels and casing (never "Our Services", never extra links like Shop/Clinics). Mark the current page's link active.`;
  const COMMON = `Build a COMPLETE, production-quality, single-file HTML page following the design prompt below EXACTLY.

=== PREMIUM DESIGN SYSTEM (already loaded — USE IT, do not re-invent it) ===
A stylesheet with fluid type, spacing rhythm and hand-crafted components is linked into this page
automatically. Write SEMANTIC MARKUP USING THESE CLASSES. Only set the six brand tokens plus fonts in your
own <style>; never redefine spacing scales, card/hero/nav/footer CSS, or type sizes it already provides.

Tokens — these hex values are COMPUTED FROM THE CLIENT'S OWN SITE. Copy them EXACTLY; do not substitute your
own colours, do not add extra background/tint colours, and never introduce a grey or tint from outside this set:
  :root{ --ink:${TOK.ink}; --bg:${TOK.bg}; --cream:${TOK.cream}; --brand:${TOK.brand}; --on-brand:${TOK.onBrand};
         --font-display:'<Display Google Font>',Georgia,serif; --font-body:'<Body Google Font>',system-ui,sans-serif; }
Every surface on the page is one of exactly these: --bg, --cream (tint band), or --ink (dark band). No other
background colour may appear anywhere.

Layout:  .u-wrap (page container) · .u-band / .u-band--tight (vertical section rhythm) · .u-cream (tint band)
         .u-dark (dark band) · .u-split (+ --wide-l / --wide-r / --flip) · .u-grid (+ --2/--3/--4/--auto)
         .u-stack · .u-center · .u-read
Type:    .u-eyebrow · .u-display · h1/h2/h3 (already scaled) · .u-lead · .u-sub · .u-em · .u-rule
Nav:     .c-nav (+ --light) > .c-nav__logo, ul.c-nav__links (a[aria-current] marks the active page), .c-nav__toggle
Hero:    .c-hero.c-hero--full > .c-hero__media > img + .c-hero__body   (full-bleed image hero, scrim built in)
         .c-hero.c-hero--split > .u-wrap > .u-split > (.c-hero__body | .c-arch.c-arch--outline > img)
Inner:   .c-pagehead > .c-pagehead__media > img + .c-pagehead__body (+ .c-crumb)
Media:   .c-arch (arched frame) · .c-frame (+ --tall/--wide)
Blocks:  .c-marquee > .c-marquee__row > span (repeat the row TWICE for a seamless loop)
         .c-card > .c-card__media > img + .c-card__body (+ .c-card__link) · .c-card--quiet (text-only variant)
         .c-pillar > .c-arch + text  ·  .c-editorial (+ .c-editorial__num) · .c-chips > .c-chip
         .c-menu > .c-menu__row > (.c-menu__name, .c-menu__desc, .c-menu__price)
         .c-member > .c-member__media > img + .c-member__name + .c-member__role
         .c-quote > .c-quote__mark + .c-quote__text + .c-quote__by  ·  .c-stat > .c-stat__n + .c-stat__l
         details.c-acc__item > summary.c-acc__q + .c-acc__a (wrap in .c-acc)
Forms:   .c-field · .c-panel · .c-map > iframe
Footer:  .c-foot > .u-wrap > grid + .c-foot__logo + .c-social > a + .c-foot__bar
Extra:   .c-btn (+ --ghost / --square) inside .c-btns
         NEVER use .c-book-tab or any other fixed/sticky side booking tab — the header's own "Book a Visit" button is the only persistent booking CTA.

         .c-person > img + .c-person__meta > (.c-person__name + .c-person__role) + .c-person__go  (overlay team card)
         .c-bleed (+ --tall) > img  (full-bleed edge-to-edge photograph)

=== HOUSE STYLE — measured against the best real sites in this category ===
These are not suggestions; ignoring them is what makes a page read as a template.
1. LEFT-ALIGN by default. Big headlines sit left, asymmetric, with the eye led down the page.
   Reserve .u-center for a quote band or one deliberate statement moment — never for every section.
2. ACCENT RESTRAINT. The reference sites colour roughly 5% of their text with the brand tone. Use --brand for
   CTA buttons and at most ONE emphasis per section (an italic word in a headline, a link). Body copy,
   eyebrows, rules, numbers and headings stay ink/muted. Never a gold eyebrow above every heading.
3. LIGHT DISPLAY TYPE at large size — the system already sets weight 200-300 with open tracking. Do not
   override headings to bold. Big and thin reads expensive; big and heavy reads cheap.
4. SQUARE EDGES and BARE IMAGES. No border-radius, no drop shadows, no bordered boxes around everything.
   Photographs sit directly on the page (.c-card is bare by default; .c-card--panel only when a panel is
   genuinely the right call). Use .c-bleed for at least one full-width photograph per page.
5. EMPTINESS IS THE LUXURY. Fewer, larger sections. Let bands breathe; never pack the page.
6. IMAGES AT FULL SIZE. When you have photographs, show them big — a large image beats three small ones.

Compose freely — vary which components each page uses, their order, and the split/grid ratios so no two
sites look alike. But the CSS craft comes from the system, not from you.

Rules:
- One file: inline <style> (tokens + a few page-specific touches only) and inline <script>. Google Fonts <link> allowed.
- Fully responsive (mobile menu included). Semantic HTML.
- DO NOT write your own scroll-reveal / fade-in code and never ship elements at opacity:0. A premium motion
  layer (scroll reveals, split-headline animation, image scroll-scale, hover choreography, sticky-nav
  behaviour, stat counters) is injected into this page automatically — write static, visible markup and let
  it animate. Your job is composition, type, colour and spacing; motion is handled for you.
- Be generous with spacing and scale: major sections get 140-180px vertical padding on desktop, display
  headings 64-104px, section headings 44-64px, generous line-height and letter-spacing on eyebrows.
- Use ONLY the image URLs given in the prompt or raw data (hotlink them; add onerror handlers that hide broken images).
- IMAGE GRIDS ARE ALL-OR-NOTHING: in any card/team/gallery grid, either EVERY card gets a real image or NO
  card gets one (then use a clean text-only card design). Never mix filled and empty image slots.
- USE THE PHOTOGRAPHS YOU HAVE. If the image list can cover a grid, it MUST be illustrated — do not fall back
  to text-only cards while unused images remain. Text-only is for when there genuinely aren't enough photos.
- ${NAV}
- No lorem ipsum — use the content provided. NEVER invent phone numbers, emails, street addresses or reviews;
  omit anything the data doesn't provide.
- NEVER render placeholder or scaffolding labels. Anything of the form "Category A/B/C", "Category 01/02/03",
  "Section 1", "Service 2", "Primary Service 03", "Featured Item", "TBD" must NOT appear — an eyebrow above a
  heading names the real thing ("AESTHETIC INJECTABLES", "FUNCTIONAL WELLNESS"), it never numbers or labels a
  slot. If the design prompt used a placeholder or numbered name, replace it with the real category name.
- LOGO CONTRAST: the logo image may be a light/white variant or a dark variant. Whatever band it sits on
  (nav, footer, mobile menu) MUST contrast with it — a white logo needs a dark or tinted band behind it, a
  dark logo needs a light band. Never leave the logo washed out or invisible; do not apply CSS filters to
  recolour it. Give the nav a solid (not transparent) background wherever the logo would otherwise vanish.
- Output ONLY the HTML document, starting with <!DOCTYPE html>. No markdown fences, no commentary.`;
  const FACTS = `RAW SITE DATA (content source):
Title: ${s.title}
Headings: ${s.headings.map((h) => h.text).join(" · ")}
Logo: ${s.logo || "(none)"}
Images:
${s.images.map((im) => `${im.src}${im.w && im.h && im.h > im.w ? " [portrait]" : ""}${im.alt ? ` (${im.alt.slice(0, 50)})` : ""}`).join("\n")}
Page text: ${s.text.slice(0, 5000)}
${s.subFacts.map((f) => `--- ${f.kind.toUpperCase()} PAGE DATA ---\n${f.headings.join(" · ")}\n${f.text.slice(0, 2000)}`).join("\n")}`;

  fs.mkdirSync(siteDir, { recursive: true });
  fs.mkdirSync(path.join(siteDir, "assets"), { recursive: true });
  const pages = {};
  for (const pg of PAGE_DEFS) {
    log(`building ${pg.label} page (AI call)`);
    const bp = `${COMMON}\n\n${pg.extra}\n\nDESIGN PROMPT:\n${brief}\n\n${FACTS}`;
    let html = "", model = "", attempt = 0;
    while (attempt < 3) {
      attempt++;
      const p2 = await gemini([{ text: bp }], {
        temperature: 0.55, maxTokens: pg.tokens,
        models: attempt < 3 ? MODELS.slice(0, 2) : MODELS,
        waves: attempt < 3 ? 2 : 1,
      });
      let h = p2.text.trim().replace(/^```html?/i, "").replace(/```$/, "").trim();
      if (!/^<!doctype/i.test(h)) { const i = h.search(/<!doctype/i); if (i > -1) h = h.slice(i); }
      const ok = /^<!doctype/i.test(h) && h.length >= MIN_KB * 1024 && /<\/html>/i.test(h);
      if (ok || attempt === 3) { html = h; model = p2.model; if (ok) break; }
      log(`${pg.label} too thin (${Math.round(h.length / 1024)}kb by ${p2.model}) — rebuilding (attempt ${attempt})`);
    }
    if (!/^<!doctype/i.test(html)) throw new Error(pg.label + " page: model did not return an HTML document");
    // Defense in depth: the prompt now tells Gemini never to write a fixed side
    // booking tab, but strip any it emits anyway — the header's own CTA is the
    // only persistent booking button the design should show.
    html = html.replace(/<a\b[^>]*\bclass="[^"]*\bc-book-tab\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");
    html = withMotionLayer(html, tokenOverrideCss(TOK));
    fs.writeFileSync(path.join(siteDir, pg.file), html);
    pages[pg.key || "home"] = html;
    log(`${pg.label} page generated (${Math.round(html.length / 1024)}kb by ${model})`);
  }
  // Gemini writes each page's <header>/<footer> from scratch, so nav labels,
  // column layout, and copy drift page to page even though the design system
  // is shared — the site reads as 4 different sites stitched together. The
  // home page's chrome is canonical; every other page gets it byte-for-byte.
  unifyChrome(pages, siteDir, log);

  // the site-wide JS (premium motion engine + nav toggle) → g99-site-js snippet
  fs.writeFileSync(path.join(siteDir, "assets", "site.js"), SITE_JS);

  return { pages, prompt: brief, tokens: TOK, warnings };
}

module.exports = { generateDesigngenSite, brandTokens, withMotionLayer, SITE_JS, unifyChrome };  // unifyChrome exported for tests
