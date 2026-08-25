// Deterministic Playwright scrape (CommonJS) — ported 1:1 from the standalone
// demo engine. No AI here: grabs ground truth (palette, fonts, images with
// alt/size/kind, text dump, screenshot) for the Gemini extract step.
// Playwright is LAZY-required inside scrape() (not at module load): Render may
// not have the browser/module installed, and a top-level require would crash the
// whole server on boot ("Cannot find module 'playwright'"). Callers that need a
// browser scrape catch this and fall back to the fetch-based scrapeLite.
async function scrape(url) {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (e) { throw new Error("playwright unavailable (" + String(e.message).slice(0, 60) + ") — use scrapeLite"); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(600);

  // auto-scroll to trigger lazy-loaded images (trimmed dwell for speed)
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await sleep(90); }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(200);
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);

  const data = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
    const colorCount = {};
    const bump = (c) => { if (!c || c === "transparent" || c.includes("rgba(0, 0, 0, 0)")) return; colorCount[c] = (colorCount[c] || 0) + 1; };
    document.querySelectorAll("*").forEach((el) => { const s = getComputedStyle(el); bump(s.color); bump(s.backgroundColor); });
    const palette = Object.entries(colorCount).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c]) => c);

    const fontOf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : null; };
    const fonts = { heading: fontOf("h1") || fontOf("h2") || fontOf("h3"), body: getComputedStyle(document.body).fontFamily };

    const imgs = [];
    const seen = new Set();
    const isJunk = (u) => /logo|icon|sprite|favicon|pixel|badge|\.svg($|\?)|svg\+xml|%3csvg|data:|tr\?id=|facebook\.com\/tr|fbevents|google-analytics|googletagmanager|doubleclick|\/collect(\?|$)|\/tr(\?|$)|1x1|spacer/i.test(u);
    const DECOR = /(^|[-_/])(bg|background|texture|pattern|marble|swirl|gradient|banner-?bg|hero-?bg|overlay|backdrop)([-_.\d]|$)/i;
    const PORTRAIT_HINT = /(headshot|portrait|team|staff|provider|-dr-|profile)/i;
    const kindOf = (src, alt, w, h) => {
      if (DECOR.test(src)) return "decorative";
      const name = /^[A-Z][a-z]+ [A-Z][a-z']+/.test(alt);
      if (PORTRAIT_HINT.test(src) || name || (h > w && h > 0 && alt)) return "portrait";
      return "photo";
    };
    const push = (src, alt, w, h) => {
      if (!src || src.startsWith("data:")) return;
      const a = abs(src);
      if (!a || seen.has(a) || isJunk(a)) return;
      seen.add(a);
      alt = (alt || "").trim().slice(0, 120);
      imgs.push({ src: a, alt, w: w || 0, h: h || 0, kind: kindOf(a, alt, w || 0, h || 0) });
    };
    const bestSrc = (i) => {
      const lazy = i.getAttribute("data-src") || i.getAttribute("data-lazy-src") || i.getAttribute("data-original") || "";
      const set = (i.getAttribute("srcset") || i.getAttribute("data-srcset") || "").split(",")[0].trim().split(" ")[0];
      const s = i.currentSrc || i.src || "";
      return (s && !s.startsWith("data:") ? s : "") || lazy || set;
    };
    document.querySelectorAll("img").forEach((i) => {
      const w = i.naturalWidth || i.width, h = i.naturalHeight || i.height;
      if (w && h && (w < 100 || h < 100)) return;
      push(bestSrc(i), i.alt, w, h);
    });
    document.querySelectorAll("*").forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) push(m[1], el.getAttribute("aria-label") || "", 0, 0);
    });

    let logo = null;
    document.querySelectorAll("img").forEach((i) => {
      const hay = ((i.src || "") + " " + (i.alt || "")).toLowerCase();
      if (!logo && hay.includes("logo")) logo = abs(i.currentSrc || i.src);
    });

    const blocks = [];
    document.querySelectorAll("h1,h2,h3,h4,p,li,a").forEach((el) => {
      const t = el.innerText.trim().replace(/\s+/g, " ");
      if (t.length > 1 && t.length < 400) blocks.push(`[${el.tagName}] ${t}`);
    });

    return {
      title: document.title,
      metaDesc: (document.querySelector('meta[name="description"]') || {}).content || "",
      palette, fonts, images: imgs.slice(0, 60), logo, text: blocks.slice(0, 300).join("\n"),
    };
  });

  const screenshot = await page.screenshot({ fullPage: false });
  await browser.close();
  return { url, ...data, screenshotB64: screenshot.toString("base64") };
}

// Lightweight image scrape — plain fetch + regex, NO browser (~2-4s vs ~12s).
// Default mode uses this; the "Pure URL scrape" toggle uses full Playwright scrape().
// Vision classification (classifyPool) still runs on these URLs for relevance.
const DECOR_RE = /(^|[-_/])(bg|background|texture|pattern|marble|swirl|gradient|banner-?bg|hero-?bg|overlay|backdrop)([-_.\d]|$)/i;
const PORTRAIT_RE = /(headshot|portrait|team|staff|provider|-dr-|profile)/i;
function kindOfLite(src, alt) {
  if (DECOR_RE.test(src)) return "decorative";
  if (PORTRAIT_RE.test(src) || /^[A-Z][a-z]+ [A-Z][a-z']+/.test(alt || "")) return "portrait";
  return "photo";
}
async function scrapeLite(url) {
  const full = /^https?:\/\//i.test(url) ? url : "https://" + url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let html = "";
  try {
    const r = await fetch(full, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
    html = await r.text();
  } finally { clearTimeout(t); }
  const abs = (u) => { try { return new URL(u, full).href; } catch { return null; } };
  const isJunk = (u) => /logo|icon|sprite|favicon|pixel|badge|\.svg($|\?)|svg\+xml|%3csvg|data:|tr\?id=|facebook\.com\/tr|fbevents|google-analytics|googletagmanager|doubleclick|\/collect(\?|$)|\/tr(\?|$)|1x1|spacer/i.test(u);
  const imgs = [], seen = new Set();
  // dimensions from WordPress size suffix "name-1024x768.webp" (cheap, no fetch)
  const dimsOf = (u) => { const m = u.match(/-(\d{2,4})x(\d{2,4})\.[a-z]+(\?|$)/i); return m ? { w: +m[1], h: +m[2] } : { w: 0, h: 0 }; };
  // pick the LARGEST candidate from a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg)
  const largestSrcset = (ss) => {
    const c = ss.split(",").map((s) => s.trim()).map((s) => { const [u, w] = s.split(/\s+/); return { u, w: parseInt(w) || 0 }; })
      .filter((x) => x.u && !/^data:|svg/i.test(x.u)); // never a placeholder/data-URI
    return c.sort((a, b) => b.w - a.w)[0]?.u || "";
  };
  const push = (src, alt) => {
    if (!src || src.startsWith("data:")) return;
    const a = abs(src);
    if (!a || seen.has(a) || isJunk(a)) return;
    const { w, h } = dimsOf(a);
    if (w && w < 400) return; // drop small thumbnails that would pixelate in large slots
    seen.add(a);
    alt = (alt || "").trim().slice(0, 120);
    imgs.push({ src: a, alt, w, h, kind: kindOfLite(a, alt) });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const ss = (tag.match(/srcset=["']([^"']+)["']/i) || [, ""])[1];
    const src = largestSrcset(ss)
      || (tag.match(/\b(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [, ""])[1];
    push(src, alt);
  }
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi)) push(m[1], "");
  const logo = (imgs.find((i) => /logo/i.test(i.src)) || {}).src || null;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  return { url: full, title, palette: [], fonts: {}, images: imgs.slice(0, 60), logo, text: "", screenshotB64: "" };
}

module.exports = { scrape, scrapeLite };
