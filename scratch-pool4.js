// Pass 4 — vision-verified TOP-UP to 30/30/30: crawl home + subpages per site,
// download candidates, vision-classify BEFORE saving (no junk enters the pool).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
  const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEYS = (process.env.GEMINI_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ROOT = path.join(__dirname, "image-pool");
const TARGET = 30;
const DECOR = /logo|icon|sprite|favicon|spacer|placeholder|blank|pixel|1x1|loader|badge|\/thumbs\/|\.svg(\?|$)|\.gif(\?|$)/i;
const SITES = ["agerejuvenation.com", "kdsmile.com", "wwaesthetics.com", "cassisaesthetics.com", "skinflectionspa.com",
  "therefreshroom.com", "secretsaesthetics.com", "timelessbeautybarwellness.com", "ruma.com", "whitecoataesthetics.com",
  "azureplasticsurgery.com", "ericksondermatology.com", "prettypleaseaesthetics.com", "enchantedmedicalaesthetics.com",
  "eckaholdings.com", "sageandsilence.com", "unaaesthetics.com", "vibeaestheticsmedspa.com"];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const counts = { hero: 0, services: 0, providers: 0 };
for (const m of manifest) counts[m.category]++;
const seenSrc = new Set(manifest.map((m) => m.src.split("?")[0]));
const hashes = new Set();
for (const m of manifest) { try { hashes.add(crypto.createHash("md5").update(fs.readFileSync(path.join(ROOT, m.file))).digest("hex")); } catch (e) {} }

async function vision(bufs) {
  const parts = [{ text: `Classify each attached image (in order) for a medical-spa website library. Reply ONLY a JSON array, one string per image: "hero" (wide interior/lifestyle/ambience), "service" (treatment/procedure/device/product photo), "provider" (person portrait/headshot, face visible), or "discard" (logo/graphic/text/map/unusable).` }];
  for (const b of bufs) parts.push({ inlineData: { mimeType: b.mime, data: b.buf.toString("base64") } });
  let last;
  for (const model of ["gemini-flash-latest", "gemini-3.6-flash"]) {
    for (const key of KEYS.slice(0, 4)) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: "application/json" } }),
        });
        const d = await r.json();
        if (!r.ok) { last = model + "→" + r.status; continue; }
        const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        if (t) return JSON.parse(t.trim().replace(/^```json?/i, "").replace(/```$/, "").trim());
      } catch (e) { last = e.message.slice(0, 50); }
    }
  }
  throw new Error(last);
}

(async () => {
  const browser = await chromium.launch();
  for (const domain of SITES) {
    if (counts.hero >= TARGET && counts.services >= TARGET && counts.providers >= TARGET) break;
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    process.stdout.write(`→ ${domain} ... `);
    const cand = [];
    try {
      const pages = ["https://" + domain + "/"];
      await page.goto(pages[0], { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const links = await page.evaluate(() => [...new Set([...document.querySelectorAll("a")]
        .map((a) => ({ href: a.href, t: ((a.textContent || "") + " " + a.href).toLowerCase() }))
        .filter((x) => x.href.startsWith(location.origin) && /about|team|meet|staff|provider|gallery|service|treatment|tour/.test(x.t))
        .map((x) => x.href))].slice(0, 4));
      pages.push(...links);
      for (const u of pages) {
        try {
          if (u !== pages[0]) { await page.goto(u, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {}); await page.waitForTimeout(1400); }
          await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await s(130); } });
          const imgs = await page.evaluate(() => [...document.images].filter((i) => i.naturalWidth >= 450 && i.naturalHeight >= 320)
            .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight })));
          for (const im of imgs) if (im.src && /^https?:/.test(im.src) && !DECOR.test(im.src) && !seenSrc.has(im.src.split("?")[0])) { cand.push(im); seenSrc.add(im.src.split("?")[0]); }
        } catch (e) { /* page skip */ }
      }
    } catch (e) { /* site skip */ }
    // download up to 10 candidates, vision-classify, save what's needed
    const bufs = [];
    for (const im of cand.sort((a, b) => (b.w * b.h) - (a.w * a.h)).slice(0, 24)) {
      try {
        const r = await fetch(im.src, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Pool" } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 12000 || buf.length > 1_800_000) continue;
        const hash = crypto.createHash("md5").update(buf).digest("hex");
        if (hashes.has(hash)) continue;
        const mime = /\.png/i.test(im.src) ? "image/png" : /\.webp/i.test(im.src) ? "image/webp" : "image/jpeg";
        bufs.push({ buf, mime, im, hash });
      } catch (e) { /* skip */ }
    }
    let saved = 0;
    if (bufs.length) {
      try {
        const cats = await vision(bufs);
        bufs.forEach((b, k) => {
          let cat = cats[k] === "provider" ? "providers" : cats[k] === "service" ? "services" : cats[k];
          if (!["hero", "services", "providers"].includes(cat) || counts[cat] >= TARGET) return;
          const ext = (b.im.src.match(/\.(jpe?g|png|webp|avif)/i) || [, "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
          const base = (b.im.src.split("/").pop() || "img").replace(/\?.*$/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9-]/gi, "-").slice(0, 60);
          const file = `${domain.replace(/\.com$/, "")}__${base}.${ext}`;
          fs.writeFileSync(path.join(ROOT, cat, file), b.buf);
          hashes.add(b.hash);
          manifest.push({ file: `${cat}/${file}`, category: cat, site: domain, src: b.im.src, w: b.im.w, h: b.im.h, alt: "", bytes: b.buf.length });
          counts[cat]++; saved++;
        });
      } catch (e) { console.log("vision fail:", e.message.slice(0, 40)); }
    }
    console.log(`+${saved} (verified) | h${counts.hero}/s${counts.services}/p${counts.providers}`);
    await page.close().catch(() => {});
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`\nDONE pass 4 → hero: ${counts.hero} · services: ${counts.services} · providers: ${counts.providers}`);
})().catch((e) => { console.error("POOL4 FAILED:", e.message); process.exit(1); });
