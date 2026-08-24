// Pass 2 — top up hero & providers pools by crawling each site's team/about/
// gallery subpages (headshots and interior shots rarely sit on the home page).
// Continues from pass 1: existing files are hashed so nothing duplicates.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const SITES = [
  "cassisaesthetics.com", "ruma.com", "kdsmile.com", "whitecoataesthetics.com",
  "wwaesthetics.com", "timelessbeautybarwellness.com", "therefreshroom.com",
  "agerejuvenation.com", "secretsaesthetics.com", "skinflectionspa.com",
  "azureplasticsurgery.com", "prettypleaseaesthetics.com", "sageandsilence.com",
  "ericksondermatology.com", "eckaholdings.com", "enchantedmedicalaesthetics.com",
];
const ROOT = path.join(__dirname, "image-pool");
const TARGET = 30;
const PER_SITE_CAP = 3;
const DECOR = /logo|icon|sprite|favicon|spacer|placeholder|blank|pixel|1x1|loader|badge|\/thumbs\/|[-_]bg[-_.]|background|gradient|wave|pattern|texture|divider|swirl|overlay|\.svg(\?|$)|\.gif(\?|$)/i;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const counts = { hero: 0, services: 0, providers: 0 };
for (const m of manifest) counts[m.category]++;
const hashes = new Set();
for (const m of manifest) { try { hashes.add(crypto.createHash("md5").update(fs.readFileSync(path.join(ROOT, m.file))).digest("hex")); } catch (e) {} }
const seenSrc = new Set(manifest.map((m) => m.src.split("?")[0]));

function classify(im) {
  const n = (im.src.split("/").pop() || "").toLowerCase() + " " + (im.alt || "").toLowerCase() + " " + (im.page || "");
  const portraitShape = im.h > im.w * 1.05;
  if (/headshot|portrait|team|staff|provider|founder|owner|injector|esthetician|nurse|doctor|dr[-_. ]/.test(n) && portraitShape) return "providers";
  if (portraitShape && /team|about|meet|staff|provider/.test(im.page || "") && im.w >= 350) return "providers";
  if (/hero|banner|welcome|interior|lobby|reception|storefront|exterior|office|space|room/.test(n) && im.w > im.h) return "hero";
  if (im.w >= 900 && im.w > im.h * 1.15) return "hero";
  if (portraitShape && im.w >= 400) return "providers";
  return "services";
}

async function harvest(page, url, kind) {
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    if (!r || r.status() >= 400) return [];
    await page.waitForTimeout(1800);
    await page.evaluate(async () => { const s = (ms) => new Promise((r2) => setTimeout(r2, ms)); for (let y = 0; y < document.body.scrollHeight; y += 550) { window.scrollTo(0, y); await s(150); } await s(500); });
    const imgs = await page.evaluate(() => [...document.images]
      .filter((i) => i.naturalWidth >= 350 && i.naturalHeight >= 300)
      .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt || "" })));
    return imgs.filter((i) => i.src && /^https?:/.test(i.src) && !DECOR.test(i.src)).map((i) => ({ ...i, page: kind }));
  } catch (e) { return []; }
}

(async () => {
  const browser = await chromium.launch();
  for (const domain of SITES) {
    if (counts.hero >= TARGET && counts.providers >= TARGET) break;
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    process.stdout.write(`→ ${domain} ... `);
    let all = [];
    try {
      // find team/about/gallery links off the home nav
      await page.goto("https://" + domain + "/", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const links = await page.evaluate(() => [...document.querySelectorAll("a")]
        .map((a) => ({ href: a.href, t: ((a.textContent || "") + " " + a.href).toLowerCase() }))
        .filter((x) => x.href.startsWith(location.origin) && /about|team|meet|staff|provider|gallery|our-office|tour/.test(x.t))
        .map((x) => x.href));
      const subs = [...new Set(links)].slice(0, 3);
      for (const sub of subs) {
        const kind = /team|meet|staff|provider/.test(sub) ? "team" : /gallery|office|tour/.test(sub) ? "gallery" : "about";
        all.push(...await harvest(page, sub, kind));
      }
    } catch (e) { /* skip site */ }
    let saved = 0;
    for (const im of all.sort((a, b) => (b.w * b.h) - (a.w * a.h))) {
      if (seenSrc.has(im.src.split("?")[0])) continue;
      const cat = classify(im);
      if (cat === "services") continue;                       // pass 2 only tops up hero/providers
      if (counts[cat] >= TARGET) continue;
      try {
        const r = await fetch(im.src, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Pool" } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 12000 || buf.length > 9_000_000) continue;
        const hash = crypto.createHash("md5").update(buf).digest("hex");
        if (hashes.has(hash)) continue;
        hashes.add(hash); seenSrc.add(im.src.split("?")[0]);
        const ext = (im.src.match(/\.(jpe?g|png|webp|avif)/i) || [, "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
        const base = (im.src.split("/").pop() || "img").replace(/\?.*$/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9-]/gi, "-").slice(0, 60);
        const file = `${domain.replace(/\.com$/, "")}__${base}.${ext}`;
        fs.writeFileSync(path.join(ROOT, cat, file), buf);
        manifest.push({ file: `${cat}/${file}`, category: cat, site: domain, src: im.src, w: im.w, h: im.h, alt: im.alt, bytes: buf.length });
        counts[cat]++; saved++;
        if (saved >= PER_SITE_CAP * 2) break;
      } catch (e) { /* skip */ }
    }
    console.log(`+${saved} | totals h${counts.hero}/s${counts.services}/p${counts.providers}`);
    await page.close().catch(() => {});
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`\nDONE pass 2 → hero: ${counts.hero} · services: ${counts.services} · providers: ${counts.providers} · manifest: ${manifest.length}`);
})().catch((e) => { console.error("POOL2 FAILED:", e.message); process.exit(1); });
