// The ONE AI step for pure-URL mode (CommonJS) — ported 1:1 from the demo engine.
// scrape → BrandKit: classify sections, pick theme, rewrite copy, vision-classify
// images, enforce relevance deterministically, pick the best-fit design.
// LAZY: @google/generative-ai is only needed for the optional pure-scrape vision
// path. Requiring it at module load crashed the whole server on any Render deploy
// where the package isn't installed ("Cannot find module '@google/generative-ai'"
// via index.js -> server.js). Load it on demand; return null if absent so callers
// degrade gracefully (default webgen uses the server's own fetch-based geminiCall,
// and image classification falls back to filename heuristics).
function newGGA(apiKey) {
  let GoogleGenerativeAI;
  try { ({ GoogleGenerativeAI } = require("@google/generative-ai")); }
  catch (e) { console.warn("[webgen] @google/generative-ai unavailable — skipping vision step:", String(e.message).slice(0, 60)); return null; }
  return new GoogleGenerativeAI(apiKey);
}
const { DESIGN_IDS } = require("./render.js");

const VIBES = `"editorial" = refined, serif-led, calm luxury with generous whitespace
"bold" = dramatic, dark, oversized display type, high-contrast, confident
"minimal" = airy, quiet, lots of whitespace, hairline details, understated
"aura" = warm soft luxury, gentle shadows, rounded imagery, inviting
"clinical" = clean modern medical, cool crisp neutrals, structured cards, precise & trustworthy`;

async function extractBrandKit(raw, apiKey, modelName) {
  const genAI = newGGA(apiKey);
  if (!genAI) throw new Error("@google/generative-ai unavailable — cannot run pure-scrape BrandKit");
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
  }, { timeout: 30000 }); // hard 30s cap so a slow/rate-limited call can't hang the build

  const prompt = `You are a luxury brand extractor for a med-spa website builder.
Below is scraped data from a real med-spa site: page text, detected color palette, fonts, and a screenshot.

Return ONLY JSON matching this exact shape (no markdown fence):
{
  "brand": { "name": "", "sub": "", "topbar": "", "phone": "", "email": "", "city": "" },
  "theme": {
    "cream": "#hex", "white": "#ffffff", "ink": "#hex", "body": "#hex",
    "line": "#hex", "accent": "#hex",
    "serifFont": "Font Name", "sansFont": "Font Name",
    "googleFontsHref": "https://fonts.googleapis.com/css2?...&display=swap"
  },
  "hero": { "eyebrow": "", "h1": "", "body": "", "cta": "", "image": "url-or-empty" },
  "about": { "eyebrow": "", "h2": "", "paras": ["", ""], "cta": "", "image": "url-or-empty" },
  "strip": ["", "", "", "", ""],
  "specialties": { "eyebrow": "", "h2": "", "intro": "", "cards": [ { "h3": "", "p": "", "image": "url-or-empty" } ] },
  "providers": { "eyebrow": "", "h2": "", "tabs": ["",""], "members": [ { "name": "", "role": "", "image": "url-or-empty" } ] },
  "testimonials": { "eyebrow": "", "h2": "", "quotes": [ { "h4": "", "p": "", "cite": "" } ] },
  "featured": { "h2": "", "items": [ { "h3": "", "p": "", "image": "url-or-empty" } ] },
  "cta": { "eyebrow": "", "h2": "", "body": "" },
  "footer": { "blurb": "", "logo": "url-or-empty" },
  "servicesPage": { "eyebrow": "", "h1": "", "body": "" },
  "aboutPage": { "eyebrow": "", "h1": "", "body": "" },
  "teamPage": { "eyebrow": "", "h1": "", "body": "" },
  "voice": "one phrase, e.g. warm-clinical-luxe",
  "layout": "one of the ids below"
}

CHOOSE THE BEST-FIT LAYOUT for this brand (set "layout" to exactly one id):
${VIBES}
Pick from the brand's palette + tone (dark/edgy → bold; classic → editorial; calm/clean → minimal).

RULES:
- THEME: pick colors from the detected palette. ink = darkest text color, cream = warm off-white background, accent = the brand's signature hue, line = subtle border. Convert rgb() to hex. Elegant, high-contrast.
- FONTS: identify a serif for headings and sans for body; else defaults (serif "Cormorant Garamond", sans "Montserrat"). Valid Google Fonts href.
- COPY: REWRITE all copy in the brand's voice — do NOT copy sentences verbatim. hero h1 short (2-5 words), card p ~15 words, luxurious & modern.
- Provide 3 cards, 4 providers, 4 testimonial quotes, 3 featured items, 5 strip items, plus short servicesPage/aboutPage/teamPage intros.
- IMAGES: pool below has "alt" + "kind" (portrait|photo|decorative) + a "src" whose filename is a clue. Copy src EXACTLY, never invent. RELEVANCE MANDATORY:
  * decorative may be used ONLY for hero.image. Never in about, cards, featured, providers.
  * PROVIDERS: only person-photos (kind portrait or a "Firstname-Lastname" filename). Output one per real person (3-4); never a treatment/interior/decorative photo; if fewer than 3, output 3 with empty images.
  * CARDS/FEATURED/ABOUT: photos only, topic-fitting. If none fit, "".
  * Never reuse a src across two slots. When unsure, "".

SCRAPED DATA:
title: ${raw.title}
metaDesc: ${raw.metaDesc}
palette: ${JSON.stringify(raw.palette)}
fonts: ${JSON.stringify(raw.fonts)}
logo: ${raw.logo || ""}
IMAGE POOL (assign these exact src values; respect "kind"):
${JSON.stringify(raw.images.map((i) => ({ src: i.src, alt: i.alt, kind: i.kind })).slice(0, 40))}
--- TEXT ---
${raw.text}`;

  let result, lastErr;
  for (let i = 0; i < 2; i++) { // fail fast — 2 tries, short backoff
    try {
      const parts = [prompt];
      if (raw.screenshotB64) parts.push({ inlineData: { mimeType: "image/png", data: raw.screenshotB64 } });
      result = await model.generateContent(parts);
      break;
    } catch (e) {
      lastErr = e;
      if (!/503|429|overload|high demand|unavailable/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  if (!result) throw lastErr;
  const txt = result.response.text().trim().replace(/^```json?/i, "").replace(/```$/, "").trim();
  const kit = JSON.parse(txt);
  const labels = await classifyImages(raw.images, model);
  return sanitizeImages(kit, raw.images, labels);
}

async function fetchB64(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const mime = r.headers.get("content-type") || "";
    if (!r.ok || !/image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3_000_000 || buf.length < 500) return null;
    return { mime, data: buf.toString("base64") };
  } catch { return null; }
}

// Vision ground-truth: label each pool image person|photo|decorative from its pixels.
async function classifyImages(pool, model) {
  const labels = new Map();
  const cap = pool.slice(0, 20); // cover the whole pool (sites often have 12-16 images)
  const parts = [`Classify each image below. Reply ONLY a JSON array of strings, one per image IN ORDER, each exactly one of:
"person" = a HEADSHOT / portrait of ONE individual (head & shoulders). NOT a treatment scene, NOT multiple people.
"photo"  = a treatment, procedure, product, room/interior, or lifestyle photo.
"decorative" = abstract texture, marble, gradient, pattern, or background with no clear single subject.`];
  const fetched = await Promise.all(cap.map((im) => fetchB64(im.src)));
  const order = [];
  cap.forEach((im, i) => { if (!fetched[i]) return; parts.push({ inlineData: { mimeType: fetched[i].mime, data: fetched[i].data } }); order.push(im.src); });
  if (!order.length) return labels;
  try {
    const r = await model.generateContent(parts);
    const arr = JSON.parse(r.response.text().trim().replace(/^```json?/i, "").replace(/```$/, "").trim());
    order.forEach((src, i) => labels.set(src, arr[i]));
  } catch { /* fall back to filename heuristic in sanitize */ }
  return labels;
}

// Build providers from person-photos: the NAME comes from the SAME file as the
// face (so name always matches the photo), only real unique names, max 4. Shared
// by both pure (sanitizeImages) and default (enrichKitImages) modes.
const _file = (s) => (s || "").split("/").pop();
const STOP = /^(headshot|portrait|profile|photo|image|img|pic|scaled|final|edit|edited|cropped|copy|web|webp|min|small|large|new|team|staff|about|our|the|and|of|dr|nuvo|ruma|aesthetics?|clinic|medical|med|spa|wellness|beauty|sycamore|lehi|utah|il|ut|us|inc|llc|specialties|specialty|services?|treatments?|results?|gallery|philosophy|experience|welcome|contact|home|hero|banner|video)$/i;
const _cap1 = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
function nameFromFile(src) {
  const base = decodeURIComponent(_file(src)).replace(/​/g, "").replace(/\.[a-z0-9]+$/i, "");
  const parts = base.split(/[-_ .]+/).filter((w) => w && /[A-Za-z]/.test(w) && !/^\d+$/.test(w) && !STOP.test(w) && !/^[a-z0-9]{8,}$/.test(w));
  return parts.slice(0, 2).map(_cap1).join(" ").trim();
}
const _realName = (n) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test((n || "").trim()) && !/headshot|assistant|specialist|aesthetician|provider|medical|team/i.test(n);
function buildProviders(person, members = []) {
  const seen = new Set(), built = [];
  for (const src of person) {
    const name = nameFromFile(src) || (_realName(members[built.length] && members[built.length].name) ? members[built.length].name : "");
    if (!name || seen.has(name.toLowerCase())) continue; // real, unique names only
    seen.add(name.toLowerCase());
    built.push({ name, role: (members[built.length] && members[built.length].role) || "Aesthetic Specialist", image: src });
    if (built.length >= 4) break;
  }
  return built;
}

// Deterministic relevance enforcement. AI proposes; code decides slot placement,
// derives provider names from filenames, drops empty placeholders.
function sanitizeImages(kit, pool, labels = new Map()) {
  const file = (s) => (s || "").split("/").pop();
  const NAME = /[A-Z][a-z]+[-_ ][A-Z][a-z]+/;
  const NOTPERSON = /space|banner|hero|specialt|treatment|skin|inject|wellness|clinic|medical|logo|bg|background|welcome|circle|gold|marble/i;
  const labelOf = (im) => {
    const v = labels.get(im.src);
    if (v === "person" || v === "photo" || v === "decorative") return v;
    if (im.kind === "decorative") return "decorative";
    if (im.kind === "portrait" && !NOTPERSON.test(file(im.src))) return "person"; // alt-based, but not a section/treatment photo
    return NAME.test(file(im.src)) && !NOTPERSON.test(file(im.src)) ? "person" : "photo";
  };
  // NOTE: "hero"/"banner" are NOT here — a filename like "Hero-Space-Image" or
  // "video-banner" is usually the actual hero photo, not a decorative background.
  const BGFILE = /(^|[-_/.])(bg|background|cta|section|overlay|backdrop|swirl|texture|pattern)([-_/.]|$)/i;
  const person = [], photo = [], decor = [];
  for (const im of [...pool].sort((a, b) => (b.w || 0) - (a.w || 0))) { // biggest first → hero
    const l = labelOf(im);
    if (l === "decorative" || BGFILE.test(file(im.src))) decor.push(im.src);
    else if (l === "person" || (NAME.test(file(im.src)) && !NOTPERSON.test(file(im.src)))) person.push(im.src); // vision-person ∪ Firstname-Lastname filename
    else photo.push(im.src);
  }
  const used = new Set();
  const take = (list) => { for (const s of list) if (!used.has(s)) { used.add(s); return s; } return ""; };

  if (!kit.providers) kit.providers = { eyebrow: "Our Team", h2: "Meet Our Specialists", tabs: [] };
  kit.providers.members = buildProviders(person, kit.providers.members || []);

  const heroPick = (list) => { const h = list.find((s) => !used.has(s) && /hero|banner|space|welcome|main|home/i.test(s)); if (h) { used.add(h); return h; } return take(list); };
  if (kit.hero) kit.hero.image = heroPick(photo) || take(decor) || "";
  for (const c of (kit.specialties && kit.specialties.cards) || []) c.image = take(photo);
  if (kit.about) kit.about.image = take(photo);
  kit.gallery = photo.filter((s) => !used.has(s)).slice(0, 6); // leftover photos → gallery

  if (!DESIGN_IDS.includes(kit.layout)) kit.layout = "bold";
  return kit;
}

// ---- default-mode helpers: reuse the vision + relevance system to place REAL
// scraped images into an onboarding-composed kit WITHOUT rebuilding its content ----
function makeModel(apiKey, modelName) {
  const genAI = newGGA(apiKey);
  if (!genAI) return null;
  return genAI.getGenerativeModel({
    model: modelName, generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  }, { timeout: 25000 });
}
async function classifyPool(pool, apiKey, modelName) {
  const model = makeModel(apiKey, modelName);
  if (!model) return new Map();          // no vision → filename heuristics still place images
  try { return await classifyImages(pool, model); }
  catch { return new Map(); }
}
function splitPool(pool, labels = new Map()) {
  const file = (s) => (s || "").split("/").pop();
  const NAME = /[A-Z][a-z]+[-_ ][A-Z][a-z]+/;
  const NOTPERSON = /space|banner|hero|specialt|treatment|skin|inject|wellness|clinic|medical|logo|bg|background|welcome|circle|gold|marble/i;
  // NOTE: "hero"/"banner" are NOT here — a filename like "Hero-Space-Image" or
  // "video-banner" is usually the actual hero photo, not a decorative background.
  const BGFILE = /(^|[-_/.])(bg|background|cta|section|overlay|backdrop|swirl|texture|pattern)([-_/.]|$)/i;
  const labelOf = (im) => {
    const v = labels.get(im.src);
    if (v === "person" || v === "photo" || v === "decorative") return v;
    if (im.kind === "decorative") return "decorative";
    if (im.kind === "portrait" && !NOTPERSON.test(file(im.src))) return "person"; // alt-based, but not a section/treatment photo
    return NAME.test(file(im.src)) && !NOTPERSON.test(file(im.src)) ? "person" : "photo";
  };
  const person = [], photo = [], decor = [];
  // biggest photos first → hero/large slots get the highest-res image (no pixelation)
  for (const im of [...pool].sort((a, b) => (b.w || 0) - (a.w || 0))) {
    const l = labelOf(im);
    if (l === "decorative" || BGFILE.test(file(im.src))) decor.push(im.src);
    else if (l === "person" || (NAME.test(file(im.src)) && !NOTPERSON.test(file(im.src)))) person.push(im.src); // vision-person ∪ Firstname-Lastname filename
    else photo.push(im.src);
  }
  return { person, photo, decor };
}
// keep the onboarding kit's content + team names; only fill image slots with
// vision-verified scraped photos (providers keep their names, gain real photos).
function enrichKitImages(kit, pool, labels) {
  const { person, photo, decor } = splitPool(pool, labels);
  const used = new Set();
  const take = (list) => { for (const s of list) if (!used.has(s)) { used.add(s); return s; } return ""; };
  // hero: prefer an image whose name signals a hero/banner/space shot, else biggest photo
  const heroPick = (list) => { const h = list.find((s) => !used.has(s) && /hero|banner|space|welcome|main|home/i.test(s)); if (h) { used.add(h); return h; } return take(list); };
  if (kit.hero) kit.hero.image = heroPick(photo) || take(decor) || "";
  for (const c of (kit.specialties && kit.specialties.cards) || []) c.image = take(photo);
  if (kit.about) kit.about.image = take(photo);
  // rebuild providers from the person-photos so each NAME matches its FACE (the file
  // it came from) — never index-assign onboarding names to arbitrary photos.
  if (!kit.providers) kit.providers = { eyebrow: "Our Team", h2: "Meet Our Specialists", tabs: [] };
  kit.providers.members = buildProviders(person, kit.providers.members || []);
  // remaining relevant photos → gallery section (uses more of the site's images)
  kit.gallery = photo.filter((s) => !used.has(s)).slice(0, 6);
  return kit;
}

module.exports = { extractBrandKit, classifyImages, sanitizeImages, classifyPool, enrichKitImages };

