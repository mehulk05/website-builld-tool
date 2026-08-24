// Pass 3 — vision re-sort: filename heuristics misfiled ~15-20% (provider
// portraits in hero/, hero shots in providers/). Send each image to Gemini
// vision in batches and re-sort into the correct folder; discard junk.
const fs = require("fs");
const path = require("path");

for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
  const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEYS = (process.env.GEMINI_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ROOT = path.join(__dirname, "image-pool");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

async function gemini(parts) {
  let last;
  for (const model of ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.1-flash-lite"]) {
    for (const key of KEYS.slice(0, 4)) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 2000, responseMimeType: "application/json" } }),
        });
        const d = await r.json();
        if (!r.ok) { last = model + "→" + r.status; continue; }
        const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        if (t) return t;
      } catch (e) { last = e.message.slice(0, 50); }
    }
  }
  throw new Error(last);
}

(async () => {
  const BATCH = 12;
  const results = [];   // {idx, category}
  for (let i = 0; i < manifest.length; i += BATCH) {
    const batch = manifest.slice(i, i + BATCH);
    const parts = [{ text: `Classify each attached image (in order) for a medical-spa website image library. Reply ONLY a JSON array of strings, one per image, each exactly one of:
"hero" = wide lifestyle/interior/clinic/space/ambience shot suitable as a page hero background
"service" = a treatment/procedure/product photo (injection, facial, laser, device, skincare)
"provider" = a PERSON's portrait/headshot (one person or a small team, posed, face visible)
"discard" = logo, graphic, text-banner, screenshot, map, or anything unusable as a real photo` }];
    const idxs = [];
    for (let j = 0; j < batch.length; j++) {
      try {
        const buf = fs.readFileSync(path.join(ROOT, batch[j].file));
        if (buf.length > 1_800_000) { results.push({ idx: i + j, category: batch[j].category }); continue; } // too big to send — keep as-is
        const mime = batch[j].file.endsWith(".png") ? "image/png" : batch[j].file.endsWith(".webp") ? "image/webp" : "image/jpeg";
        parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
        idxs.push(i + j);
      } catch (e) { /* missing file */ }
    }
    if (idxs.length === 0) continue;
    try {
      const txt = (await gemini(parts)).trim().replace(/^```json?/i, "").replace(/```$/, "").trim();
      const arr = JSON.parse(txt);
      idxs.forEach((idx, k) => results.push({ idx, category: arr[k] === "provider" ? "providers" : arr[k] === "service" ? "services" : arr[k] }));
      console.log(`batch ${i / BATCH + 1}: classified ${idxs.length}`);
    } catch (e) {
      console.log(`batch ${i / BATCH + 1}: FAILED (${e.message.slice(0, 60)}) — keeping original categories`);
      idxs.forEach((idx) => results.push({ idx, category: manifest[idx].category }));
    }
  }
  // apply moves
  let moved = 0, discarded = 0;
  const newManifest = [];
  for (const r of results) {
    const m = manifest[r.idx];
    if (!m) continue;
    const from = path.join(ROOT, m.file);
    if (!fs.existsSync(from)) continue;
    if (r.category === "discard") { fs.unlinkSync(from); discarded++; continue; }
    if (!["hero", "services", "providers"].includes(r.category)) { newManifest.push(m); continue; }
    if (r.category !== m.category) {
      const name = path.basename(m.file);
      const to = path.join(ROOT, r.category, name);
      fs.renameSync(from, to);
      m.file = `${r.category}/${name}`; m.category = r.category; moved++;
    }
    newManifest.push(m);
  }
  fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(newManifest, null, 1));
  const c = { hero: 0, services: 0, providers: 0 };
  for (const m of newManifest) c[m.category]++;
  console.log(`\nVISION RE-SORT DONE: moved ${moved}, discarded ${discarded}`);
  console.log(`hero: ${c.hero} · services: ${c.services} · providers: ${c.providers}`);
})().catch((e) => { console.error("POOL3 FAILED:", e.message); process.exit(1); });
