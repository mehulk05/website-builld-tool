// Phase 0 design-quality checks (DESIGN_QUALITY_PLAN.md).
// Pure functions only — no network, no API keys. Run: node test-design.js
"use strict";
const assert = require("assert");
const S = require("./server.js");

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

console.log("retargetNav — keep the design, fix the words");

// A realistic Stitch header: Tailwind classes, a hover state, a responsive
// breakpoint, a button-shaped CTA, and the hallucinated labels that motivated
// the old delete-the-whole-header behaviour.
const STITCH_HEADER = `<!DOCTYPE html><html><body>
<header class="sticky top-0 z-50 flex items-center justify-between px-10 py-5 backdrop-blur-md">
  <a href="#" class="font-display text-2xl tracking-tight">Wrong Brand</a>
  <nav class="hidden md:flex items-center gap-8">
    <a href="#hero" class="text-sm uppercase tracking-[0.14em] hover:text-amber-600">Hoem</a>
    <a href="#svc" class="text-sm uppercase tracking-[0.14em] hover:text-amber-600">CAREES</a>
    <a href="#team" class="text-sm uppercase tracking-[0.14em] hover:text-amber-600">SKINRALES</a>
    <a href="#c" class="text-sm uppercase tracking-[0.14em] hover:text-amber-600">Cntact</a>
    <a href="#book" class="rounded-md bg-stone-900 px-5 py-3 text-xs font-bold text-white">Book Now</a>
  </nav>
</header>
<main><h1>Hello</h1></main></body></html>`;

const fixed = S.retargetNav(STITCH_HEADER, { displayName: "Élan Aesthetics" });
assert.ok(fixed, "expected a retargeted header");

ok("hallucinated labels are gone", () => {
  for (const bad of ["Hoem", "CAREES", "SKINRALES", "Cntact", "Wrong Brand"]) {
    assert.ok(!fixed.includes(bad), `still contains "${bad}"`);
  }
});

ok("real destinations are wired", () => {
  for (const href of ["index.html", "services.html", "about.html", "contact.html"]) {
    assert.ok(fixed.includes(`href="${href}"`), `missing href="${href}"`);
  }
  assert.ok(!fixed.includes('href="#svc"'), "left a placeholder anchor href in place");
});

// This is the whole point of the change: the design survives.
ok("design is preserved — classes, hover, breakpoint, count", () => {
  for (const cls of [
    "sticky top-0 z-50", "backdrop-blur-md", "hidden md:flex",
    "hover:text-amber-600", "tracking-[0.14em]", "rounded-md bg-stone-900",
  ]) {
    assert.ok(fixed.includes(cls), `lost styling: ${cls}`);
  }
  const before = (STITCH_HEADER.match(/<a\b/g) || []).length;
  const after = (fixed.match(/<a\b/g) || []).length;
  assert.strictEqual(after, before, `anchor count changed ${before} -> ${after}`);
});

ok("brand name and CTA come from onboarding data", () => {
  // onboarding.json is the source; fall back to theme.displayName when absent.
  const a = require("./onboarding.json").answers;
  assert.ok(fixed.includes(a.business_name), "brand wordmark not applied");
  assert.ok(fixed.includes(a.primary_cta), "primary CTA text not applied");
  assert.ok(!fixed.includes("Book Now"), "kept the model's CTA wording");
});

ok("page body is untouched", () => {
  assert.ok(fixed.includes("<main><h1>Hello</h1></main>"), "content was modified");
});

ok("a logo-only strip is not claimed as a nav", () => {
  const strip = `<body><header class="p-4"><a href="/"><img src="logo.png"></a></header></body>`;
  assert.strictEqual(S.retargetNav(strip, {}), null);
});

ok("no header at all returns null so the caller can fall back", () => {
  assert.strictEqual(S.retargetNav("<body><main>no chrome</main></body>", {}), null);
});

ok("injectCanonicalNav prefers retargeting over substituting", () => {
  const out = S.injectCanonicalNav(STITCH_HEADER, { displayName: "Élan" });
  assert.ok(!out.includes("data-g99-nav"), "fell back to canonicalNav despite a usable header");
  assert.ok(out.includes("backdrop-blur-md"), "did not keep the designed header");
});

ok("injectCanonicalNav still falls back when there is nothing to fix", () => {
  const out = S.injectCanonicalNav("<body><main>x</main></body>", { displayName: "Élan" });
  assert.ok(out.includes("data-g99-nav"), "no fallback nav injected");
});

console.log("\nvibeFor — derive from the brand, not from a field nobody sets");

ok("a serif display face maps to the warm/luxury system", () => {
  // theme.vibe is deliberately absent: that is the production shape.
  assert.strictEqual(S.vibeFor({ headingFont: "Cormorant Garamond" }), "Luxurious & Warm");
  assert.strictEqual(S.vibeFor({ headingFont: "Playfair Display" }), "Luxurious & Warm");
});

ok("a grotesque maps to the minimal system", () => {
  assert.strictEqual(S.vibeFor({ headingFont: "Space Grotesk" }), "Clean & Minimalist");
  assert.strictEqual(S.vibeFor({ headingFont: "Jost" }), "Clean & Minimalist");
});

ok("a display sans maps to the bold system", () => {
  assert.strictEqual(S.vibeFor({ headingFont: "Anton" }), "Bold & Modern");
});

ok("an explicit vibe still wins", () => {
  assert.strictEqual(S.vibeFor({ vibe: "Bold & Modern", headingFont: "Cormorant" }), "Bold & Modern");
});

console.log("\ndesignMdFor — a real design system reaches Stitch");

const md = S.designMdFor({
  displayName: "Élan", primary: "#2C2C2C", secondary: "#E8DCC4", accent: "#B49A6A",
  headingFont: "Cormorant Garamond", bodyFont: "Jost",
});

ok("states the real families verbatim", () => {
  assert.ok(md.includes('"Cormorant Garamond"'), "heading family missing");
  assert.ok(md.includes('"Jost"'), "body family missing");
});

ok("carries the rules the old 12-line brief left unspecified", () => {
  for (const rule of ["Type scale", "Spacing + grid", "Section rhythm", "Components", "Motion"]) {
    assert.ok(md.includes(rule), `no guidance for: ${rule}`);
  }
});

ok("names the generic-output tells so the model can avoid them", () => {
  assert.ok(/No Inter, Roboto, Arial/.test(md), "no anti-slop font clause");
  assert.ok(/purple\/violet gradients/.test(md), "no anti-slop palette clause");
});

ok("does not leak a font-PAIR description into the family slot", () => {
  // Guards the VIBE_FONT_NAMES mix-up: those values read
  // "Playfair Display (serif headings) + Inter (sans body)".
  assert.ok(!md.includes("(serif headings)"), "leaked a pair description as a family name");
  const fallback = S.designMdFor({ displayName: "X", primary: "#111", secondary: "#222" });
  assert.ok(!fallback.includes("(serif headings)"), "leaked a pair description in the fallback path");
});

ok("states an actual utility class, not a bare px number", () => {
  // Regression: "14px/28px padding" was fed to a Tailwind-generating model,
  // which read "28" as the utility number (Tailwind's scale is 4px/unit, so
  // py-28 is 112px) and shipped a nav CTA the size of a postcard. Verified on
  // a real generation, 2026-08-05.
  assert.ok(/px-6 py-3|px-\[/.test(md), "button spec no longer names a concrete utility");
  assert.ok(!/\d+px\/\d+px padding/.test(md), "reintroduced the ambiguous 'Npx/Mpx padding' phrasing");
});

console.log("\ndesignMdFor — signature techniques extracted from the client's own reference mockups");

ok("requires the oversized background wordmark, in at least two places", () => {
  // Confirmed on 4 of 4 sampled mockups (Hello Skin, Ruma Medical, Reform MD,
  // Maven Medi Spa), 2026-08-05 — every one bled a giant low-opacity brand
  // wordmark behind a mid-page section AND the footer, never just one.
  assert.ok(/OVERSIZED BACKGROUND WORDMARK/.test(md));
  assert.ok(/AT LEAST TWICE per page/.test(md));
});

ok("requires the two-part heading composition", () => {
  assert.ok(/TWO parts, not one/.test(md));
  assert.ok(/Never ship a bare single-line heading/.test(md));
});

ok("lists the other recurring techniques by name", () => {
  for (const t of ["LAYERED PHOTO COMPOSITION", "CAPTION-ON-PHOTO CARDS", "REAL LEAD FORM", "SOCIAL PROOF STRIP"]) {
    assert.ok(md.includes(t), `missing signature technique: ${t}`);
  }
});

console.log("\nphoto pool — two clients must not ship the same hero");

ok("different clients get different starting photos", () => {
  S.seedCuratedPhotos("Élan Medical Aesthetics");
  const a = S.curatedPhoto();
  S.seedCuratedPhotos("Brew Aesthetics");
  const b = S.curatedPhoto();
  assert.notStrictEqual(a, b, "two clients drew the same first photo");
});

ok("the same client is stable across rebuilds", () => {
  S.seedCuratedPhotos("Élan Medical Aesthetics");
  const first = S.curatedPhoto();
  S.seedCuratedPhotos("Élan Medical Aesthetics");
  assert.strictEqual(S.curatedPhoto(), first, "rebuild produced a different photo");
});

ok("one page never repeats a photo before the pool is exhausted", () => {
  S.seedCuratedPhotos("Some Clinic");
  const seen = new Set();
  for (let i = 0; i < S.CURATED_IMAGES.length; i++) seen.add(S.curatedPhoto());
  assert.strictEqual(seen.size, S.CURATED_IMAGES.length,
    `only ${seen.size} distinct photos across ${S.CURATED_IMAGES.length} draws`);
});

console.log("\nclampViewportHeights — off by default");

ok("a 90vh hero survives to the shipped page", () => {
  const hero = `<section class="min-h-[90vh]"><style>.h{height:100vh}</style></section>`;
  assert.strictEqual(S.clampViewportHeights(hero), hero, "still rewriting vh with CLAMP_VH unset");
});

console.log("\nenforceArbitraryColors — named Tailwind config colors die when <head> is stripped");

ok("rewrites named colors to arbitrary hex, preserving variants and opacity", () => {
  const html = `<a class="border border-secondary text-secondary hover:bg-secondary hover:text-primary/50">Book</a>`;
  const out = S.enforceArbitraryColors(html, { primary: "#000000", secondary: "#B69C76" });
  assert.ok(out.includes("border-[#B69C76]"), "border-secondary not rewritten");
  assert.ok(out.includes("text-[#B69C76]"), "text-secondary not rewritten");
  assert.ok(out.includes("hover:bg-[#B69C76]"), "hover:bg-secondary not rewritten (variant lost)");
  assert.ok(out.includes("hover:text-[#000000]/50"), "hover:text-primary/50 not rewritten (opacity lost)");
  assert.ok(!/\b(?:bg|text|border)-(?:primary|secondary|accent)\b/.test(out), "a named color survived");
});

ok("leaves unrelated custom utility names alone (e.g. text-label)", () => {
  const html = `<a class="text-label border-secondary">x</a>`;
  const out = S.enforceArbitraryColors(html, { primary: "#000", secondary: "#B69C76" });
  assert.ok(out.includes("text-label"), "touched an unrelated utility name outside its color scope");
});

ok("is idempotent — an arbitrary-value class doesn't match twice", () => {
  const once = S.enforceArbitraryColors(`<a class="bg-secondary">x</a>`, { secondary: "#B69C76" });
  const twice = S.enforceArbitraryColors(once, { secondary: "#B69C76" });
  assert.strictEqual(twice, once);
});

ok("leaves a role untouched when its hex isn't known", () => {
  const html = `<a class="bg-accent">x</a>`;
  const out = S.enforceArbitraryColors(html, { primary: "#000", secondary: "#111" }); // no accent
  assert.ok(out.includes("bg-accent"), "rewrote a role with no known hex");
});


console.log("\nsplitPage — shared chrome is the <header>, not the nav inside it");

// The real shape every generated page uses: the nav is NESTED in the header,
// which also carries the logo, the CTA and the fixed/backdrop styling.
const NESTED_CHROME = `<!DOCTYPE html><html><head><title>x</title></head><body>
<header class="fixed top-0 z-50 backdrop-blur-md" id="navbar">
  <a href="/">NUVO</a>
  <nav class="hidden md:flex gap-8"><a href="/services/">Treatments</a></nav>
  <button class="md:hidden">menu</button>
</header>
<main><h1>Hello</h1></main>
<footer class="bg-black">bye</footer></body></html>`;

ok("takes the whole <header>, keeping logo + CTA + fixed styling", () => {
  const p = S.splitPage(NESTED_CHROME);
  assert.ok(/^<header/.test(p.header.trim()), "chrome did not start at <header>");
  assert.ok(p.header.includes("NUVO"), "logo lost from the shared chrome");
  assert.ok(p.header.includes("md:hidden"), "mobile menu button lost from the shared chrome");
  assert.ok(p.header.includes("fixed top-0"), "fixed/backdrop styling lost from the shared chrome");
});

ok("leaves no <header> shell behind in the page body", () => {
  const p = S.splitPage(NESTED_CHROME);
  assert.ok(!/<header/i.test(p.main), "a second header would render under the shared one");
  assert.ok(!/<nav/i.test(p.main), "nav left in the body");
  assert.ok(p.main.includes("<h1>Hello</h1>"), "page content was cut");
});

ok("falls back to <nav> when the page has no <header>", () => {
  const p = S.splitPage(`<html><body><nav class="top">links</nav><main>x</main></body></html>`);
  assert.ok(/^<nav/.test(p.header.trim()), "no chrome extracted from a nav-only page");
  assert.ok(!/<nav/i.test(p.main), "nav left in the body");
});

console.log("\nimage context — the card's heading, not the AI's own alt text");

// Stitch writes a data-alt describing the picture it invented; the service name
// sits in a sibling <h3> in the overlay BELOW the image.
const CARD = `<div class="card"><img class="object-cover" data-alt="A serene portrait of a woman receiving a facial treatment" src="https://x/y.jpg"/>
<div class="overlay"><h3 class="text-white">Botox</h3><span>Starting at $12/unit</span></div></div>`;

ok("reads the label from the heading after the image", () => {
  const at = CARD.indexOf("<img");
  const len = CARD.slice(at).indexOf(">") + 1;
  assert.strictEqual(S.imageContext(CARD, at, len).label, "Botox");
});

ok("falls back to the nearest heading before the image", () => {
  const html = `<section><h2>Meet the Team</h2><img src="https://x/y.jpg"/></section>`;
  const at = html.indexOf("<img");
  const len = html.slice(at).indexOf(">") + 1;
  assert.strictEqual(S.imageContext(html, at, len).label, "Meet the Team");
});

ok("the heading beats the invented alt text — Botox is injectables, not facial", () => {
  const at = CARD.indexOf("<img");
  const len = CARD.slice(at).indexOf(">") + 1;
  const ctx = S.imageContext(CARD, at, len);
  const attrs = CARD.slice(at, at + len);
  assert.strictEqual(S.medspaCategory(attrs), "facial", "precondition: the alt text alone reads as facial");
  assert.strictEqual(S.medspaCategory(ctx.label) || S.medspaCategory(attrs), "injectables");
});

ok("unlabelled images still classify off the surrounding text", () => {
  assert.strictEqual(S.medspaCategory(""), null, "empty label must not match a category");
  assert.strictEqual(S.medspaCategory("laser resurfacing session"), "laser");
});


console.log(`\n${pass} checks passed.`);
