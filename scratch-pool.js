// Build fallback image pools from 20 real client sites: scan each site's home
// page with Playwright (lazy-scroll so every image loads), classify each photo
// as hero / service / provider, download ~30 per category into image-pool/<cat>/,
// and write a manifest.json. These pools backfill beta sites that have no images.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const SITES = [
  "enchantedmedicalaesthetics.com", "cassisaesthetics.com", "ruma.com", "kdsmile.com",
  "whitecoataesthetics.com", "wwaesthetics.com", "timelessbeautybarwellness.com",
  "therefreshroom.com", "agerejuvenation.com", "vibeaestheticsmedspa.com",
  "secretsaesthetics.com", "skinflectionspa.com", "azureplasticsurgery.com",
  "prettypleaseaesthetics.com", "revengemd.com", "sageandsilence.com",
  "elysianaesthetics.com", "unaaesthetics.com", "eckaholdings.com", "ericksondermatology.com",
];
const ROOT = path.join(__dirname, "image-pool");
const TARGET = 30;          // per category
const PER_SITE_CAP = 4;     // per category per site — keeps the pools varied
const DECOR = /logo|icon|sprite|favicon|spacer|placeholder|blank|pixel|1x1|loader|badge|\/thumbs\/|[-_]bg[-_.]|background|gradient|wave|pattern|texture|divider|swirl|overlay|\.svg(\?|$)|\.gif(\?|$)/i;

function classify(im) {
  const n = (im.src.split("/").pop() || "").toLowerCase() + " " + (im.alt || "").toLowerCase();
  const portraitShape = im.h > im.w * 1.05;
  const wide = im.w >= 1000 && im.w > im.h * 1.25;
  if (/headshot|portrait|team|staff|provider|founder|owner|injector|esthetician|nurse|doctor|dr[-_. ]|md[-_.]|np[-_.]|pa[-_.]/.test(n)) return "providers";
  if (/[a-z]+-[a-z]+-(md|np|pa|rn|bsn|msn)\b/.test(n) || (/^[a-z]+-[a-z]+(-\d+)?\.(jpe?g|png|webp)/.test(n) && portraitShape && im.w < 1200)) return "providers";
  if (/hero|banner|welcome|interior|lobby|reception|storefront|exterior|office|clinic-|space|room|spa[-_. ]/.test(n)) return "hero";
  if (/botox|tox\b|filler|laser|facial|microneedl|inject|peel|\biv\b|drip|sculptra|morpheus|weight|hormone|skin|lip|body|glow|hydra|prp|treatment|massage|derma/.test(n)) return "services";
  if (wide) return "hero";
  if (portraitShape && im.w >= 400 && im.w <= 1100) return "providers";
  return "services";
}

async function scan(browser, domain) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  try {
    const resp = await page.goto("https://" + domain + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
    if (!resp || resp.status() >= 400) throw new Error("HTTP " + (resp ? resp.status() : "?"));
    await page.waitForTimeout(2500);
    await page.evaluate(async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0; y < document.body.scrollHeight; y += 550) { window.scrollTo(0, y); await s(170); }
      await s(600);
    });
    const imgs = await page.evaluate(() =>
      [...document.images]
        .filter((i) => i.naturalWidth >= 500 && i.naturalHeight >= 350)
        .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt || "" }))
    );
    return imgs.filter((i) => i.src && /^https?:/.test(i.src) && !DECOR.test(i.src));
  } finally { await page.close().catch(() => {}); }
}

(async () => {
  for (const c of ["hero", "services", "providers"]) fs.mkdirSync(path.join(ROOT, c), { recursive: true });
  const manifest = [];
  const counts = { hero: 0, services: 0, providers: 0 };
  const hashes = new Set();
  const browser = await chromium.launch();

  for (const domain of SITES) {
    if (counts.hero >= TARGET && counts.services >= TARGET && counts.providers >= TARGET) break;
    process.stdout.write(`→ ${domain} ... `);
    let imgs = [];
    try { imgs = await scan(browser, domain); } catch (e) { console.log("SKIP (" + e.message.slice(0, 40) + ")"); continue; }
    const per = { hero: 0, services: 0, providers: 0 };
    let saved = 0;
    // biggest first so pools get the highest-quality photos
    for (const im of imgs.sort((a, b) => (b.w * b.h) - (a.w * a.h))) {
      const cat = classify(im);
      if (counts[cat] >= TARGET || per[cat] >= PER_SITE_CAP) continue;
      try {
        const r = await fetch(im.src, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Pool" } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 12000 || buf.length > 9_000_000) continue;
        const hash = crypto.createHash("md5").update(buf).digest("hex");
        if (hashes.has(hash)) continue;                       // exact duplicate across sites
        hashes.add(hash);
        const ext = (im.src.match(/\.(jpe?g|png|webp|avif)/i) || [, "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
        const base = (im.src.split("/").pop() || "img").replace(/\?.*$/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9-]/gi, "-").slice(0, 60);
        const file = `${domain.replace(/\.com$/, "")}__${base}.${ext}`;
        fs.writeFileSync(path.join(ROOT, cat, file), buf);
        manifest.push({ file: `${cat}/${file}`, category: cat, site: domain, src: im.src, w: im.w, h: im.h, alt: im.alt, bytes: buf.length });
        counts[cat]++; per[cat]++; saved++;
      } catch (e) { /* skip this image */ }
    }
    console.log(`${imgs.length} imgs → saved ${saved} (hero ${per.hero}, services ${per.services}, providers ${per.providers}) | totals h${counts.hero}/s${counts.services}/p${counts.providers}`);
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`\nDONE → ${ROOT}`);
  console.log(`hero: ${counts.hero} · services: ${counts.services} · providers: ${counts.providers} · manifest: ${manifest.length} entries`);
})().catch((e) => { console.error("POOL FAILED:", e.message); process.exit(1); });
