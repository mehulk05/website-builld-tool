// Stock photography fallback for webgen.
//
// WHY: a luxury med-spa page with no photographs is a brochure. webgen's
// all-or-nothing image rule (render.js) correctly turns a thin image pool into
// clean text cards rather than a grid with two blanks — but on an image-poor
// reference site that means an entire build ships with almost no photography.
// One observed run shipped 2 images across all four pages.
//
// image-pool/ has held 90 curated, real med-spa photographs (30 hero, 30
// services, 30 providers, with dimensions and alt text) the whole time, and
// server.js already serves them at /pool/<file> — the route comment even says
// generated sites should reference them by absolute URL. Nothing ever called it.
// This is that call.
//
// Images are handed out as absolute tool URLs, so the existing pipeline carries
// them the rest of the way with no new plumbing: localizeImages() downloads them
// into assets/img/ and records the absolute URL in img-map.json, and the GitOps
// compiler's unlocalizeImages() restores it for the Elementor html widget.
"use strict";
const fs = require("fs");
const path = require("path");

const POOL_DIR = path.join(__dirname, "..", "..", "image-pool");
const MANIFEST = path.join(POOL_DIR, "manifest.json");

let CACHE = null;
function manifest() {
  if (CACHE) return CACHE;
  try { CACHE = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch (e) { console.warn("[webgen] stock pool unavailable:", e.message); CACHE = []; }
  return CACHE;
}

// Deterministic per client — same seed, same photos, so a rebuild stays
// byte-identical and the GitOps "no changes" path keeps working.
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

// Aspect requirements per slot. A portrait in a hero band letterboxes badly;
// a landscape in a headshot slot crops to a forehead.
const SHAPE = {
  hero: (im) => im.w > im.h && im.w >= 1000,
  services: (im) => im.w >= 700,
  providers: (im) => im.h >= im.w,
};

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * Deterministic stock photos for a category.
 * @param {string} category  "hero" | "services" | "providers"
 * @param {number} n         how many to return
 * @param {object} opts      {seed, origin, exclude:Set<string>}
 * @returns {{src,w,h,alt,stock:true}[]} — fewer than n if the pool cannot fill it
 */
function stockPick(category, n, opts = {}) {
  if (!(n > 0)) return [];
  const origin = String(opts.origin || "").replace(/\/$/, "");
  const exclude = opts.exclude || new Set();
  const shape = SHAPE[category] || (() => true);

  // hasText is set by the one-time vision QC pass over image-pool/. 33 of the 90
  // photographs carry baked-in text or another practice's branding — Erickson
  // Cosmetic Dermatology appears on six, White Coat Aesthetics on three, plus
  // "Book Now!" overlays and before/after watermarks. Shipping any of those puts
  // a competitor's logo on our client's homepage, so they are excluded outright.
  // An unflagged photo (qc never run) is allowed through, so this degrades to the
  // previous behaviour rather than emptying the pool.
  const items = manifest().filter((m) => m.category === category && !m.hasText && shape(m));
  if (!items.length) return [];

  // Walk the list from a per-client offset, so two clients drawing 3 service
  // photos rarely draw the SAME three — a stock photo that turns up on every
  // site we build is the most visible tell there is.
  //
  // The stride MUST be coprime with the list length or the walk cycles through
  // a subset and never reaches the rest: an earlier version returned 4 of 12
  // usable heroes and 6 of 18 provider shots for exactly this reason.
  const start = seedOf(opts.seed || "g99") % items.length;
  let stride = 1 + (seedOf("s:" + (opts.seed || "g99")) % Math.max(1, items.length - 1));
  while (items.length > 1 && gcd(stride, items.length) !== 1) stride++;
  const out = [];
  for (let i = 0; i < items.length && out.length < n; i++) {
    const m = items[(start + i * stride) % items.length];
    const src = origin + "/pool/" + m.file.split("/").map(encodeURIComponent).join("/");
    if (exclude.has(src) || out.some((x) => x.src === src)) continue;
    out.push({ src, w: m.w, h: m.h, alt: m.alt || "", stock: true });
  }
  return out;
}

// DELIBERATELY NOT EXPORTED FOR TEAM SLOTS.
//
// Stock photography for ambience, treatment rooms and service cards is ordinary
// practice. Stock headshots captioned with a real practice's named providers is
// not — it invents people. `providers` stays in the manifest because a build may
// want a generic care/consultation image, but a named team member with no real
// photo must render as a text card. fillTeam() enforces that by refusing.
function fillTeam() {
  throw new Error("stock.fillTeam: team portraits must be the client's real people or text cards");
}

module.exports = { stockPick, fillTeam, POOL_DIR };

// ------------------------------------------------------------ self-check --
// node lib/webgen/stock.js
if (require.main === module) {
  const assert = require("assert");
  const O = { origin: "https://tool.example.com", seed: "Elra Aesthetic" };

  const hero = stockPick("hero", 1, O);
  assert.strictEqual(hero.length, 1, "pool must cover a hero");
  assert.ok(hero[0].w > hero[0].h && hero[0].w >= 1200, "hero must be wide and large");
  assert.ok(hero[0].src.startsWith("https://tool.example.com/pool/"), "absolute tool URL");
  assert.ok(!/[ ]/.test(hero[0].src), "URL is encoded");

  // Deterministic: same seed, same picks. This is what keeps a rebuild
  // byte-identical and the GitOps no-changes path intact.
  assert.deepStrictEqual(stockPick("services", 3, O), stockPick("services", 3, O));

  // Different clients should not get the same three service photos.
  const a = stockPick("services", 3, O).map((x) => x.src);
  const b = stockPick("services", 3, { ...O, seed: "Northside Dermatology" }).map((x) => x.src);
  assert.notDeepStrictEqual(a, b, "different clients must draw different stock");

  // No repeats within one draw, and exclude is honoured.
  const six = stockPick("services", 6, O);
  assert.strictEqual(new Set(six.map((x) => x.src)).size, six.length, "no duplicates in a draw");
  const ex = stockPick("services", 3, { ...O, exclude: new Set(a) });
  assert.ok(ex.every((x) => !a.includes(x.src)), "exclude respected");

  // The walk must reach EVERY usable photo, not cycle through a subset.
  // Regression guard: a non-coprime stride silently returned a third of them.
  const usable = (c) => manifest().filter((m) => m.category === c && !m.hasText && SHAPE[c](m)).length;
  for (const c of ["hero", "services", "providers"]) {
    assert.strictEqual(stockPick(c, 999, O).length, usable(c), `${c}: walk must cover the whole pool`);
  }

  // No photograph carrying another practice's branding may ever be handed out.
  const flagged = new Set(manifest().filter((m) => m.hasText).map((m) => m.file));
  assert.ok(flagged.size > 0, "the vision QC pass should have flagged some photos — has it been run?");
  for (const c of ["hero", "services", "providers"]) {
    for (const im of stockPick(c, 999, O)) {
      const file = decodeURIComponent(im.src.split("/pool/")[1] || "");
      assert.ok(!flagged.has(file), `${c}: handed out a watermarked photo — ${file}`);
    }
  }

  // Asking for more than exists returns what exists, not padding or throws.
  assert.ok(stockPick("hero", 999, O).length > 0);
  assert.deepStrictEqual(stockPick("nonexistent", 2, O), []);
  assert.deepStrictEqual(stockPick("hero", 0, O), []);

  // Provider portraits are shaped correctly, but the team-fill door stays shut.
  assert.ok(stockPick("providers", 4, O).every((x) => x.h >= x.w), "provider stock is portrait");
  assert.throws(() => fillTeam(), /real people or text cards/);

  console.log(`ok — stock pool: ${manifest().length} photos`);
  console.log(`     hero ${stockPick("hero", 99, O).length} · services ${stockPick("services", 99, O).length} · providers ${stockPick("providers", 99, O).length} usable`);
}
