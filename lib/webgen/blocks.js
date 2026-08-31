// Block vocabulary — the design space webgen renders from.
//
// WHY THIS EXISTS
// Today a build picks 1 of 6 layouts (AI guess) and 1 of 4 variants
// (hash of the business name), and every layout renders the SAME fixed
// section order. Everything else we know about the client — four tone
// sliders, the scraped design language, their real section flow, their
// photo mix — reaches the renderer only as prose inside a Gemini prompt.
// So 100 clients get 24 skeletons.
//
// This module makes those signals structural. A page is an ordered list of
// BLOCKS, each with layout params; a THEME carries page-wide params. Both
// are derived from inputs we already collect. Code renders the result, so
// output stays deterministic and — because every block is a known type
// with known slots — mappable to native Elementor widgets.
//
// Nothing here renders. This is the vocabulary the renderer and the
// Elementor emitter both read.
"use strict";

// ---------------------------------------------------------------- theme --
// Four tone sliders, four orthogonal design axes. Field `a_b` is 0..100
// where 0 = a and 100 = b (verified: onboarding.sample.json Elra reads
// warm 72 / lux 35 / understated 68 / serious 70 against a brief that says
// "calm, luxurious, physician-led").
//
// Deliberately orthogonal: each slider owns dimensions no other slider
// touches, so two clients who differ on ONE answer still look different.
const THEME_AXES = {
  // clinical (0) ←→ warm (100)
  tone_clinical_warm: {
    mediaShape: [[0, 34, "square"], [35, 69, "soft"], [70, 100, "arch"]],
    typeLed: [[0, 44, "sans"], [45, 100, "serif"]],
  },
  // luxurious (0) ←→ approachable (100)
  tone_lux_approachable: {
    density: [[0, 29, "expansive"], [30, 59, "airy"], [60, 84, "normal"], [85, 100, "tight"]],
    typeScale: [[0, 39, "statement"], [40, 74, "normal"], [75, 100, "restrained"]],
  },
  // bold (0) ←→ understated (100)
  tone_bold_understated: {
    bandRhythm: [[0, 29, "dramatic"], [30, 64, "alternating"], [65, 100, "quiet"]],
    accentIntensity: [[0, 29, "strong"], [30, 64, "moderate"], [65, 100, "minimal"]],
  },
  // playful (0) ←→ serious (100)
  tone_playful_serious: {
    radius: [[0, 24, "pill"], [25, 49, "md"], [50, 74, "sm"], [75, 100, "none"]],
    marquee: [[0, 59, true], [60, 100, false]],
  },
};

const DEFAULT_TONE = 50;
const band = (table, v) => (table.find(([lo, hi]) => v >= lo && v <= hi) || table[table.length - 1])[2];

// Scraped design language can override a slider-derived choice — the client's
// own site is evidence, the slider is an opinion. Only where the evidence is
// unambiguous; everything else leaves the slider's answer alone.
const SIGNATURE_OVERRIDES = [
  [/\barch(ed|way)?\b/i, { mediaShape: "arch" }],
  [/\bsharp\b|\bsquare\b|\bhard[- ]edge/i, { mediaShape: "square", radius: "none" }],
  [/\bpill\b|\brounded\b|\bsoft[- ]corner/i, { radius: "pill" }],
  [/\bhairline\b|\bthin rule\b/i, { accentIntensity: "minimal" }],
  [/\bfull[- ]bleed\b|\bedge[- ]to[- ]edge\b/i, { heroDefault: "bleed" }],
];

/**
 * Page-wide design params from onboarding + the scraped design language.
 * @param {object} A         onboarding answers
 * @param {object} analysis  analyzeExistingSite() result (optional)
 * @returns {object} theme params consumed by the renderer and the Elementor emitter
 */
function deriveTheme(A = {}, analysis = {}) {
  const theme = {};
  for (const [field, axes] of Object.entries(THEME_AXES)) {
    const raw = Number(A[field]);
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : DEFAULT_TONE;
    for (const [param, table] of Object.entries(axes)) theme[param] = band(table, v);
  }
  theme.heroDefault = "split";
  const sig = [].concat(analysis.signatureElements || [], analysis.layoutStyle || [], analysis.imageryStyle || []).join(" ");
  for (const [re, patch] of SIGNATURE_OVERRIDES) if (re.test(sig)) Object.assign(theme, patch);
  return theme;
}

// ---------------------------------------------------------------- blocks --
// Twelve types. The `kind` column is the SECTION_KINDS label (server.js:10125)
// that scanSiteStructure already assigns to the client's real sections, so a
// scraped page flow maps onto this vocabulary with no extra classification.
//
// `params` lists the per-block knobs and their allowed values; the FIRST value
// is the default. `slots` is the content shape — what the AI fills and what the
// Elementor emitter reads.
//
// `elementor` is PROPOSED, not verified. It has not been checked against a real
// elementor.json from a target repo (that read was blocked on repo access). Two
// numbers settle it per block: settings-key count on one styled widget, and how
// many of those keys need _tablet/_mobile siblings. Verify before building the
// emitter.
const COMMON_PARAMS = {
  band: ["bg", "cream", "dark", "image"],
  width: ["contained", "wide", "bleed"],
  align: ["left", "center"],
  emphasis: ["normal", "quiet", "feature"],
};

const BLOCKS = {
  hero: {
    kind: null,                       // always first, never from the scrape
    params: { ...COMMON_PARAMS, composition: ["split", "bleed", "centered", "bottom"], mediaSide: ["right", "left"], ratio: ["50-50", "60-40", "40-60"] },
    slots: { eyebrow: "text", h1: "text", body: "text", cta: "link", media: "image" },
    elementor: { container: "flex-row|flex-col + bg image + overlay", widgets: ["heading", "text-editor", "button", "image"] },
    minImages: 0,
  },
  split: {
    kind: "about",                    // also the fallback for kind "content"
    params: { ...COMMON_PARAMS, mediaSide: ["right", "left"], ratio: ["50-50", "60-40", "40-60", "70-30"], mediaShape: ["inherit", "square", "arch", "tall", "bleed"] },
    slots: { eyebrow: "text", h2: "text", paras: "text[]", cta: "link", media: "image" },
    elementor: { container: "flex-row, 2 inner containers", widgets: ["heading", "text-editor", "button", "image"] },
    minImages: 1,
  },
  cards: {
    kind: "services",                 // also "financing"
    params: { ...COMMON_PARAMS, columns: [3, 2, 4], mediaShape: ["inherit", "square", "arch", "tall"], numbered: [false, true] },
    slots: { eyebrow: "text", h2: "text", intro: "text", cards: "{h3,p,media,link}[]" },
    elementor: { container: "flex-row wrap, 1 inner container per card", widgets: ["image", "heading", "text-editor"] },
    // ALL-OR-NOTHING (existing rule, render.js:725): a grid with one photo and
    // two blanks reads broken. Either every card gets a unique image or none do.
    minImages: "columns | 0",
  },
  menu: {
    kind: "services",                 // the treatment LIST — no photos, typographic
    params: { ...COMMON_PARAMS, numbered: [true, false], columns: [1, 2], showPrice: [false, true] },
    slots: { eyebrow: "text", h2: "text", intro: "text", rows: "{name,desc,price}[]" },
    elementor: { container: "flex-col", widgets: ["heading", "icon-list | text-editor per row"] },
    minImages: 0,
  },
  people: {
    kind: "team",
    params: { ...COMMON_PARAMS, columns: [3, 2, 4], mediaShape: ["inherit", "square", "arch", "tall"], overlay: [false, true] },
    slots: { eyebrow: "text", h2: "text", members: "{name,role,bio,media}[]" },
    elementor: { container: "flex-row wrap, 1 inner per member", widgets: ["image", "heading", "text-editor"] },
    // Portraits or nothing — a team grid with stock photos of strangers is worse
    // than clean text cards.
    minImages: "members | 0",
  },
  quote: {
    kind: "testimonials",
    params: { ...COMMON_PARAMS, layout: ["single", "grid", "marquee"], columns: [3, 2] },
    slots: { eyebrow: "text", h2: "text", quotes: "{h4,p,cite}[]" },
    elementor: { container: "flex-col|flex-row", widgets: ["testimonial | heading + text-editor"] },
    minImages: 0,
  },
  stat: {
    kind: "stats",
    params: { ...COMMON_PARAMS, columns: [4, 3, 2] },
    slots: { items: "{big,label}[]" },
    elementor: { container: "flex-row", widgets: ["counter | heading + text-editor"] },
    minImages: 0,
  },
  gallery: {
    kind: "before-after",             // also a plain photo strip
    params: { ...COMMON_PARAMS, columns: [4, 3, 2], layout: ["grid", "strip", "compare"], mediaShape: ["inherit", "square", "tall"] },
    slots: { eyebrow: "text", h2: "text", images: "image[]" },
    elementor: { container: "flex-row wrap", widgets: ["image-gallery | image"] },
    minImages: 4,
  },
  marquee: {
    kind: null,                       // rhythm, not content — theme.marquee gates it
    params: { band: ["cream", "dark", "bg"], speed: ["slow", "medium"], italic: [true, false] },
    slots: { items: "text[]" },
    elementor: { container: "flex-row, overflow hidden", widgets: ["html"] },  // no native equivalent
    minImages: 0,
  },
  accordion: {
    kind: "faq",
    params: { ...COMMON_PARAMS, columns: [1, 2] },
    slots: { eyebrow: "text", h2: "text", items: "{q,a}[]" },
    elementor: { container: "flex-col", widgets: ["accordion | toggle"] },
    minImages: 0,
  },
  cta: {
    kind: "cta",
    params: { ...COMMON_PARAMS, band: ["dark", "cream", "image", "bg"] },
    slots: { eyebrow: "text", h2: "text", body: "text", cta: "link", media: "image" },
    elementor: { container: "flex-col + bg", widgets: ["heading", "text-editor", "button"] },
    minImages: 0,
  },
  contact: {
    kind: "contact",                  // also "location"
    params: { ...COMMON_PARAMS, mediaSide: ["left", "right"], showMap: [true, false], showForm: [true, false] },
    slots: { eyebrow: "text", h2: "text", body: "text", address: "text", phone: "text", email: "text", hours: "text", media: "image" },
    elementor: { container: "flex-row", widgets: ["heading", "text-editor", "icon-list", "google-maps", "form"] },
    minImages: 0,
  },

  // ---- added from evidence, not guesswork ---------------------------------
  // Every <h2> across the 127 pages design-gen rebuilt from real client sites
  // was clustered; these six recur and the original twelve had no home for
  // them. Four also need a SECTION_KINDS pattern (see PROPOSED_KINDS) or the
  // scraper flattens them into a generic "content" split.
  instagram: {
    kind: "instagram",                // 16 occurrences ("join us on instagram @…")
    params: { ...COMMON_PARAMS, columns: [6, 4, 3], showHandle: [true, false] },
    slots: { eyebrow: "text", h2: "text", handle: "text", href: "link", images: "image[]" },
    elementor: { container: "flex-row wrap", widgets: ["image | image-gallery", "heading"] },
    minImages: 4,                     // a thin strip reads broken — fall back to a cta
  },
  quiz: {
    kind: "quiz",                     // 11 ("what are your aesthetic goals?")
    params: { ...COMMON_PARAMS, columns: [3, 2, 4], style: ["cards", "chips"] },
    slots: { eyebrow: "text", h2: "text", body: "text", options: "{label,href,media}[]" },
    elementor: { container: "flex-row wrap", widgets: ["button | image + heading"] },
    // Lead-gen, not decoration: each option is a link into booking or a service
    // page. Static routing only — no quiz engine.
    minImages: 0,
  },
  logos: {
    kind: "logos",                    // awards, press, partners, financing brands
    params: { band: ["cream", "bg", "dark"], width: ["contained", "wide"], columns: [5, 4, 6], grayscale: [true, false] },
    slots: { eyebrow: "text", items: "{name,media,href}[]" },
    elementor: { container: "flex-row wrap", widgets: ["image"] },
    minImages: "items",               // a named-but-imageless logo row is just a list
  },
  locations: {
    kind: "location",                 // "two premier locations to serve you"
    params: { ...COMMON_PARAMS, columns: [2, 3], showMap: [true, false] },
    slots: { eyebrow: "text", h2: "text", places: "{name,address,phone,hours,media,href}[]" },
    elementor: { container: "flex-row, 1 inner per place", widgets: ["heading", "icon-list", "image", "google-maps"] },
    minImages: 0,
  },
  form: {
    kind: "form",                     // "join the list", "send us a message"
    params: { ...COMMON_PARAMS, mediaSide: ["left", "right"], fields: ["contact", "newsletter"] },
    slots: { eyebrow: "text", h2: "text", body: "text", submitLabel: "text", media: "image" },
    elementor: { container: "flex-row", widgets: ["heading", "text-editor", "form"] },
    minImages: 0,
  },
  notice: {
    kind: "notice",                   // "accepting new patients! request an appointment"
    params: { band: ["dark", "cream", "bg"], align: ["center", "left"] },
    slots: { text: "text", cta: "link" },
    elementor: { container: "flex-row, tight padding", widgets: ["heading", "button"] },
    minImages: 0,
  },
};

// Real sites do not have ONE services section. The heading clusters show 3-6
// category bands — "injectables", "skin health", "body & facial contouring",
// "wellness" — each with its own heading and its own treatments. That is the
// `cards` block repeated with a category per instance, not a new block type,
// but the page planner has to know it is allowed to repeat.
const REPEATABLE = new Set(["cards", "menu", "split", "gallery", "quote"]);

// Scraped section kind → candidate blocks, best first. scanSiteStructure gives
// us the client's REAL page flow; this turns that flow into our vocabulary so
// the section ORDER stops being a hardcoded constant.
const KIND_TO_BLOCKS = {
  about: ["split"],
  services: ["cards", "menu"],
  team: ["people"],
  testimonials: ["quote"],
  stats: ["stat"],
  "before-after": ["gallery"],
  faq: ["accordion"],
  financing: ["logos", "cards"],      // real sites show Cherry/Afterpay as badges, not cards
  location: ["locations", "contact"],
  contact: ["contact", "form"],
  cta: ["cta"],
  content: ["split"],
  // pending a SECTION_KINDS pattern — see PROPOSED_KINDS
  instagram: ["instagram"],
  quiz: ["quiz"],
  logos: ["logos"],
  notice: ["notice"],
  form: ["form"],
};

// Kinds classifySection() emits today (server.js:10125).
const KINDS_TODAY = ["before-after", "testimonials", "team", "services", "faq",
  "financing", "stats", "location", "contact", "about", "cta", "content"];

// Kinds the scraper cannot currently see. Without these, an Instagram grid, a
// goal quiz, an awards row and an announcement bar all classify as "content"
// and render as generic splits.
//
// SAFE TO APPEND, NOT TO INSERT: classifySection() returns the FIRST matching
// pattern, so appending these to the end of SECTION_KINDS cannot reclassify
// anything that matches today. Only sections currently falling through to
// "content" can newly match. That keeps it strictly additive.
const PROPOSED_KINDS = {
  instagram: /\binstagram\b|\bfollow us\b|@[a-z0-9_.]{3,}\b/i,
  quiz: /\bquiz\b|\byour (aesthetic )?goals?\b|\bfind your\b|\bwhat are you looking for\b/i,
  logos: /\bas seen (in|on)\b|\bawards?\b|\bhighest rated\b|\bcertified\b|\bpartners?\b|\bcherry\b|\bafterpay\b|\bcare ?credit\b/i,
  notice: /\baccepting new patients\b|\bnow open\b|\bannouncement\b|\blimited time\b/i,
  form: /\bjoin the list\b|\bnewsletter\b|\bsend us a message\b|\bsubscribe\b/i,
};

// What each param is allowed to be driven by. The point of writing this down:
// every row is a signal we ALREADY collect and currently discard.
const SIGNAL_MAP = {
  "theme.density": "tone_lux_approachable",
  "theme.typeScale": "tone_lux_approachable",
  "theme.mediaShape": "tone_clinical_warm + analysis.signatureElements",
  "theme.typeLed": "tone_clinical_warm",
  "theme.bandRhythm": "tone_bold_understated",
  "theme.accentIntensity": "tone_bold_understated",
  "theme.radius": "tone_playful_serious + analysis.signatureElements",
  "theme.marquee": "tone_playful_serious",
  "block order": "scanSiteStructure() — the client's real section flow",
  "which blocks exist": "scanSiteStructure() + services/team counts",
  "hero.composition": "reference screenshot + aspect of the best available photo",
  "*.columns": "services_offered/revenue_services count, team_roster length",
  "*.band": "theme.bandRhythm, applied as a page-level rhythm not per block",
  "*.media*": "image pool size, portrait vs wide mix",
};

module.exports = { BLOCKS, THEME_AXES, KIND_TO_BLOCKS, KINDS_TODAY, PROPOSED_KINDS, REPEATABLE, SIGNAL_MAP, deriveTheme };

// ------------------------------------------------------------ self-check --
// node lib/webgen/blocks.js
if (require.main === module) {
  const assert = require("assert");

  // Elra (onboarding.sample.json): warm 72, lux 35, understated 68, serious 70.
  const elra = deriveTheme({ tone_clinical_warm: 72, tone_lux_approachable: 35, tone_bold_understated: 68, tone_playful_serious: 70 });
  assert.strictEqual(elra.mediaShape, "arch", "warm 72 → arched media");
  assert.strictEqual(elra.density, "airy", "lux 35 → airy");
  assert.strictEqual(elra.typeScale, "statement", "lux 35 → statement type");
  assert.strictEqual(elra.bandRhythm, "quiet", "understated 68 → quiet bands");
  assert.strictEqual(elra.radius, "sm", "serious 70 → near-square");
  assert.strictEqual(elra.marquee, false, "serious 70 → no marquee");

  // A clinical, bold, playful practice must land somewhere genuinely different.
  const clinic = deriveTheme({ tone_clinical_warm: 15, tone_lux_approachable: 80, tone_bold_understated: 20, tone_playful_serious: 30 });
  assert.strictEqual(clinic.mediaShape, "square");
  assert.strictEqual(clinic.density, "normal");
  assert.strictEqual(clinic.bandRhythm, "dramatic");
  assert.strictEqual(clinic.accentIntensity, "strong");
  assert.strictEqual(clinic.radius, "md");
  assert.strictEqual(clinic.marquee, true);

  // The whole point: no shared parameter between two different clients.
  const shared = Object.keys(elra).filter((k) => elra[k] === clinic[k]);
  assert.deepStrictEqual(shared, ["heroDefault"], "only the untouched default may match, got: " + shared);

  // Missing sliders must not throw — an onboarding form can arrive empty.
  const bare = deriveTheme({});
  assert.ok(bare.density && bare.radius && bare.bandRhythm, "defaults fill in");

  // Scraped evidence beats the slider.
  const evid = deriveTheme({ tone_clinical_warm: 90 }, { signatureElements: ["sharp square crops", "hairline rules"] });
  assert.strictEqual(evid.mediaShape, "square", "scrape overrides warm→arch");
  assert.strictEqual(evid.accentIntensity, "minimal", "hairline → minimal accent");

  // Every block's kind must be a label the classifier emits today OR one we
  // have written a proposed pattern for. Anything else is a block no scraped
  // section can ever reach.
  const REACHABLE = new Set([...KINDS_TODAY, ...Object.keys(PROPOSED_KINDS)]);
  for (const [name, b] of Object.entries(BLOCKS)) {
    if (b.kind !== null) assert.ok(REACHABLE.has(b.kind), `${name}.kind "${b.kind}" has no classifier pattern`);
  }
  // And every kind must map to a block, or a scraped section silently vanishes.
  for (const kind of REACHABLE) {
    assert.ok(KIND_TO_BLOCKS[kind] && KIND_TO_BLOCKS[kind].length, `no block for scraped kind "${kind}"`);
    for (const b of KIND_TO_BLOCKS[kind]) assert.ok(BLOCKS[b], `KIND_TO_BLOCKS["${kind}"] names unknown block "${b}"`);
  }
  // Appending PROPOSED_KINDS must not steal a section that already classifies.
  // First-match-wins means a proposed pattern is only safe if no heading it
  // matches is one an existing kind would have claimed first.
  const TODAY_RES = [
    [/\bbefore\s*(&|and|\/|\s)*\s*after\b/i], [/\btestimonial|\breview(s)?\b/i],
    [/\bmeet (the|our)\b|\bour team\b|\bproviders?\b/i], [/\btreatments?\b|\bservices?\b|\bmenu\b/i],
    [/\bfaq\b|frequently asked/i], [/\bfinancing\b|\bmembership\b|\bspecials?\b|\bpackages?\b/i],
  ].flat();
  const SAMPLES = { instagram: "Follow our Instagram", quiz: "What are your aesthetic goals?",
    logos: "Ormond Beach's highest rated medical spa", notice: "Accepting new patients",
    form: "Join the list" };
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    assert.ok(PROPOSED_KINDS[kind].test(sample), `${kind} pattern misses its own sample`);
    const stolen = TODAY_RES.find((re) => re.test(sample));
    assert.ok(!stolen, `"${sample}" already matches an existing kind (${stolen}) — appending would not reach it`);
  }

  // Repeatable blocks must exist. Real sites carry 3-6 service category bands.
  for (const b of REPEATABLE) assert.ok(BLOCKS[b], `REPEATABLE names unknown block "${b}"`);

  console.log(`ok — ${Object.keys(BLOCKS).length} blocks, ${Object.keys(THEME_AXES).length} tone axes, ${Object.keys(elra).length} theme params`);
  console.log(`     ${KINDS_TODAY.length} kinds live, ${Object.keys(PROPOSED_KINDS).length} to append to SECTION_KINDS`);
  console.log("  elra  :", JSON.stringify(elra));
  console.log("  clinic:", JSON.stringify(clinic));
}
