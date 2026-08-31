// webgen → GitOps contract test.  Run: node test-webgen.js
//
// Guards the promise the design work was allowed to make: the renderer may
// change how a page LOOKS, but everything downstream of it talks to webgen
// through four HTML files whose body shape the Elementor compiler splits on.
// Break that shape and a build still "succeeds" while shipping a broken site,
// which is the failure mode worth a test.
//
// No network, no AI, no server. Pure render → compile.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const wg = require("./lib/webgen");
const { deriveTheme } = require("./lib/webgen/blocks.js");
const { fallbackKit, themeTokens } = require("./lib/webgen/compose.js");
const { compileGitops } = require("./lib/gitops/compile.js");

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const ELRA = { business_name: "Elra Aesthetic", location: "Scottsdale, AZ",
  tone_clinical_warm: 72, tone_lux_approachable: 35, tone_bold_understated: 68, tone_playful_serious: 70 };
const CLINIC = { business_name: "Northside Dermatology", location: "Chicago, IL",
  tone_clinical_warm: 15, tone_lux_approachable: 80, tone_bold_understated: 20, tone_playful_serious: 30 };

function kitFor(A, withTone = true) {
  const k = fallbackKit(A, {});
  k.theme = themeTokens({ primary: "#2a2a2a", accent: "#8a7a63" });
  if (withTone) k.tone = deriveTheme(A, {});
  return k;
}

// Top-level elements of <body>, the unit compileGitops turns into containers.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function topLevel(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ""])[1];
  let depth = 0; const tops = [];
  const re = /<(\/?)([a-zA-Z0-9-]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body))) {
    const close = m[1], tag = m[2].toLowerCase();
    if (tag === "script" || tag === "style") {
      if (!close) { const end = body.indexOf("</" + tag, re.lastIndex); if (end > -1) re.lastIndex = end; }
      continue;
    }
    if (close) { depth = Math.max(0, depth - 1); continue; }
    if (VOID.has(tag) || m[4]) { if (depth === 0) tops.push(tag); continue; }
    if (depth === 0) tops.push(tag);
    depth++;
  }
  return tops;
}

console.log("tone reaches the rendered page");

ok("tone changes surface treatment, not just the theme object", () => {
  const a = wg.renderHome(kitFor(ELRA));
  const b = wg.renderHome(kitFor(CLINIC));
  const radius = (h) => (h.match(/\.card,\.card-img[^}]*border-radius:([^;}]*)/) || [])[1];
  // The winning .eyebrow rule is the LAST one in the stylesheet; capture the whole
  // declaration block, since accent restraint may set colour and opacity together.
  const eyebrow = (h) => ([...h.matchAll(/\.eyebrow\{([^}]*)\}/g)].pop() || [])[1];
  assert.notStrictEqual(radius(a), radius(b), "radius must differ between these two brands");
  assert.notStrictEqual(eyebrow(a), eyebrow(b), "accent restraint must differ");
  // The understated/luxurious brand is the one that goes left-led and near-square.
  assert.match(radius(a), /^4px$/, "understated+serious brand gets near-square cards");
  assert.ok(/\.center\{text-align:left/.test(a), "quiet brand renders left-led");
  assert.ok(!/\.center\{text-align:left/.test(b), "bold brand keeps the centred treatment");
});

ok("a kit with no tone renders exactly as before (no regression)", () => {
  const bare = kitFor(ELRA, false);
  const html = wg.renderHome(bare);
  assert.ok(!/\.center\{text-align:left/.test(html), "no tone layer is emitted");
  const eyebrow = ([...html.matchAll(/\.eyebrow\{([^}]*)\}/g)].pop() || [])[1];
  assert.strictEqual(eyebrow, "color:var(--accent)", "eyebrow keeps the legacy accent colour");
  assert.strictEqual(wg.renderHome(bare), html, "hash fallback stays deterministic");
});

ok("rendering is deterministic — a rebuild must be byte-identical", () => {
  // The GitOps "no changes, nothing to deploy" path depends on this.
  assert.strictEqual(wg.renderHome(kitFor(ELRA)), wg.renderHome(kitFor(ELRA)));
});

console.log("the contract the Elementor compiler depends on");

ok("every page body is a flat header / section* / footer", () => {
  const pages = wg.renderPages(kitFor(ELRA));
  for (const [name, html] of Object.entries(pages)) {
    const tops = topLevel(html);
    assert.ok(tops.length >= 3, `${name}: expected several top-level elements, got ${tops.length}`);
    assert.strictEqual(tops[0], "header", `${name}: must open with <header>`);
    assert.strictEqual(tops[tops.length - 1], "footer", `${name}: must close with <footer>`);
    // Anything nested deeper would be swallowed into one giant Elementor widget.
    const allowed = new Set(["header", "section", "footer", "main", "div", "a"]);
    for (const t of tops) assert.ok(allowed.has(t), `${name}: unexpected top-level <${t}>`);
  }
});

ok("compileGitops turns a rendered site into valid Elementor JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webgen-test-"));
  try {
    const pages = wg.renderPages(kitFor(ELRA));
    fs.writeFileSync(path.join(dir, "index.html"), pages.home);
    fs.writeFileSync(path.join(dir, "services.html"), pages.services);
    fs.writeFileSync(path.join(dir, "about.html"), pages.about);
    fs.writeFileSync(path.join(dir, "contact.html"), pages.contact);

    const { files, pages: slugs } = compileGitops(dir, ELRA, () => null, { pageTemplate: "elementor_canvas", cssInline: true });
    assert.deepStrictEqual(slugs, ["home", "services", "about", "contact"]);

    for (const [rel, content] of files) {
      if (!rel.endsWith(".json")) continue;
      assert.doesNotThrow(() => JSON.parse(content), `${rel} is not valid JSON`);
    }

    const home = JSON.parse(files.get("resources/pages/home/elementor.json"));
    assert.ok(home.elements.length >= 5, "home should split into several containers, not one blob");
    assert.strictEqual(new Set(home.elements.map((c) => c.id)).size, home.elements.length, "container ids must be unique");
    for (const c of home.elements) {
      assert.strictEqual(c.elType, "container");
      assert.ok(c.elements.length >= 1 && c.elements[0].id, "each container carries an identified widget");
    }
    // Stable ids are what keep a re-deploy from churning every page.
    const again = compileGitops(dir, ELRA, () => null, { pageTemplate: "elementor_canvas", cssInline: true });
    assert.strictEqual(again.files.get("resources/pages/home/elementor.json"), files.get("resources/pages/home/elementor.json"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log("every design styles the markup it actually emits");

ok("a marquee design ships the .track CSS its markup needs", () => {
  // luxe is configured strip:"marquee" so stripSection emits <div class="track">,
  // but only CSS_BOLD ever defined a .track rule — the spans wrapped onto a second
  // line with no animation. Check every design against the markup it produces.
  for (const layout of wg.DESIGN_IDS) {
    const k = kitFor(ELRA);
    k.layout = layout;
    const html = wg.renderHome(k);
    const marquee = /<div class="strip"><div class="track">/.test(html);
    const plain = /<div class="strip"><div class="wrap">/.test(html);
    if (marquee) {
      assert.ok(/\.strip \.track\s*\{[^}]*white-space:\s*nowrap/.test(html),
        `${layout}: emits .track but has no .strip .track { white-space:nowrap } rule`);
      assert.ok(/@keyframes marq/.test(html), `${layout}: animates .track but ships no @keyframes marq`);
    }
    if (plain) {
      assert.ok(/\.strip \.wrap\s*\{/.test(html), `${layout}: emits .wrap but has no .strip .wrap rule`);
    }
  }
});

console.log("internal links work in the preview AND on WordPress");

ok("pages link to each other relatively, so the local bundle is browsable", () => {
  // webgen used to emit WordPress paths ("/services/") directly. Those 404 in the
  // /site/ preview bundle, so every generated site looked like its sub-pages were
  // missing — and BOTH compilers (compileGitops.rewriteLinks and server.js
  // wpRewriteLinks) are built to convert relative .html links, so emitting the
  // final form early skipped the conversion entirely.
  const pages = wg.renderPages(kitFor(ELRA));
  for (const [name, html] of Object.entries(pages)) {
    const abs = [...html.matchAll(/href="(\/[a-z-]*\/?)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(abs, [], `${name}: emits absolute WordPress paths ${abs.join(", ")} — these 404 in the preview`);
    for (const want of ["index.html", "services.html", "about.html", "contact.html"]) {
      assert.ok(html.includes(`href="${want}"`), `${name}: missing a relative link to ${want}`);
    }
  }
});

ok("compileGitops converts those to WordPress paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webgen-links-"));
  try {
    const pages = wg.renderPages(kitFor(ELRA));
    fs.writeFileSync(path.join(dir, "index.html"), pages.home);
    fs.writeFileSync(path.join(dir, "services.html"), pages.services);
    fs.writeFileSync(path.join(dir, "about.html"), pages.about);
    fs.writeFileSync(path.join(dir, "contact.html"), pages.contact);
    const { files } = compileGitops(dir, ELRA, () => null, { pageTemplate: "elementor_canvas", cssInline: true });
    const home = files.get("resources/pages/home/elementor.json");
    for (const want of ['href=\\"/\\"', 'href=\\"/services/\\"', 'href=\\"/about/\\"', 'href=\\"/contact/\\"']) {
      assert.ok(home.includes(want), `compiled output missing ${want}`);
    }
    assert.strictEqual((home.match(/href=\\"[a-z]+\.html\\"/g) || []).length, 0, "no .html link may survive into WordPress");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

ok("the beta review bar never reaches WordPress", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webgen-reviewbar-"));
  try {
    const pages = wg.renderPages(kitFor(ELRA));
    // Exactly what bindSiteSmart prepends to a bundled page (server.js reviewBanner).
    const bar = '<div data-g99-review style="background:#6d4e8c">'
      + '<b>Beta preview</b><a href="branding.html">Branding guide</a>'
      + '<a href="seo.html">SEO report</a></div>';
    for (const [f, html] of [["index.html", pages.home], ["services.html", pages.services],
      ["about.html", pages.about], ["contact.html", pages.contact]]) {
      fs.writeFileSync(path.join(dir, f), html.replace(/<body([^>]*)>/i, "<body$1>" + bar));
    }
    const { files } = compileGitops(dir, ELRA, () => null, { pageTemplate: "elementor_canvas", cssInline: true });
    for (const slug of ["home", "services", "about", "contact"]) {
      const out = files.get(`resources/pages/${slug}/elementor.json`);
      assert.ok(!out.includes("data-g99-review"), `${slug}: review bar reached the compiled page`);
      assert.ok(!out.includes("branding.html"), `${slug}: review-bundle link reached the compiled page`);
      assert.ok(!out.includes("Beta preview"), `${slug}: review bar text reached the compiled page`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log("colour comes from the brand, not from constants");

const PALETTES = {
  "warm gold": { primary: "#2b2118", secondary: "#e7dccb", accent: "#b08d57" },
  "cool clinical": { primary: "#1b2a35", secondary: "#dbe4ea", accent: "#4a90a4" },
  "blush": { primary: "#3a2630", secondary: "#f0dfe4", accent: "#c98b9b" },
  "near-white accent": { primary: "#222222", secondary: "#f4efea", accent: "#F4EFEA" },
  "all light": { primary: "#fbf7f2", secondary: "#f0e9df", accent: "#efe4d6" },
  "green wellness": { primary: "#1f2d24", secondary: "#d8e3da", accent: "#5b8c6e" },
};
const toRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const relLum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
const ratio = (a, b) => { const [x, y] = [relLum(toRgb(a)), relLum(toRgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

ok("every brand gets its own surfaces, not a shared constant", () => {
  // Regression guard with a measured history: the previous mapping produced an
  // identical warm cream for 5 of these 6 palettes, the same bronze accent for
  // 2, and #585858 body copy for all 6.
  const creams = new Set(), accents = new Set(), bodies = new Set();
  for (const p of Object.values(PALETTES)) {
    const t = themeTokens(p);
    creams.add(t.cream); accents.add(t.accent); bodies.add(t.body);
  }
  const n = Object.keys(PALETTES).length;
  assert.strictEqual(creams.size, n, "tint band must be brand-derived, not shared");
  assert.strictEqual(accents.size, n, "accent must not collapse onto a default");
  assert.strictEqual(bodies.size, n, "body copy must be a brand-biased grey");
});

ok("a usable brand accent is never discarded for a default", () => {
  // Blush #c98b9b tripped the old brightness threshold and was replaced with
  // bronze — on a blush brand.
  assert.strictEqual(themeTokens(PALETTES.blush).accent.toLowerCase(), "#c98b9b");
});

ok("body copy clears WCAG AA on every surface it sits on", () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    const t = themeTokens(p);
    assert.ok(ratio(t.body, t.cream) >= 5.5, `${name}: body on tint band is ${ratio(t.body, t.cream).toFixed(2)}:1 — needs 5.5 headroom for design opacity`);
    assert.ok(ratio(t.body, t.white) >= 4.5, `${name}: body on page ground is ${ratio(t.body, t.white).toFixed(2)}:1`);
    assert.ok(ratio(t.ink, t.cream) >= 7, `${name}: headings on tint band is ${ratio(t.ink, t.cream).toFixed(2)}:1`);
  }
});

ok("a missing or broken palette still yields a complete, readable theme", () => {
  for (const input of [{}, { primary: "not-a-colour" }, { accent: "#fff" }]) {
    const t = themeTokens(input);
    for (const k of ["cream", "white", "ink", "body", "line", "accent"]) {
      assert.match(t[k], /^#[0-9a-f]{6}$/i, `${k} must be a hex colour for input ${JSON.stringify(input)}`);
    }
    assert.ok(ratio(t.body, t.cream) >= 4.5, `fallback theme must stay readable: ${JSON.stringify(input)}`);
  }
});

console.log("no client's images can leak into another client's site");

ok("dedupeImages only ever substitutes images from THIS build's map", () => {
  // The live bug: GEN/site was never cleared and localizeImages merges into
  // img-map.json, so the map accumulated every client ever built. dedupeImages'
  // spare pool is "every URL in the map this page isn't using" — so a repeated
  // <img src> pulled in the PREVIOUS client's photograph.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webgen-leak-"));
  try {
    // A page that repeats one image, which is what triggers the substitution.
    const dup = "https://clientB.example.com/own-photo.jpg";
    const page = `<!DOCTYPE html><html><head><style>.x{color:#000}</style></head><body>`
      + `<header>h</header>`
      + `<section><img src="${dup}" alt=""><img src="${dup}" alt=""></section>`
      + `<footer>f</footer></body></html>`;
    for (const f of ["index.html", "services.html", "about.html", "contact.html"]) {
      fs.writeFileSync(path.join(dir, f), page);
    }
    // A map polluted with another client's photo, exactly as accumulation produced.
    const leaked = "https://clientA-PREVIOUS.example.com/their-photo.jpg";
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "img-map.json"), JSON.stringify({
      "assets/img/aaa.jpg": leaked,
      "assets/img/bbb.jpg": dup,
    }));

    const { files } = compileGitops(dir, ELRA, () => null, { pageTemplate: "elementor_canvas", cssInline: true });
    const compiled = files.get("resources/pages/home/elementor.json");
    // This asserts the *shape* of the danger: if a foreign URL reaches the output,
    // the only way it got there is the shared-map substitution.
    assert.ok(!compiled.includes("clientA-PREVIOUS"),
      "another client's image URL reached the compiled page — the img-map is leaking across builds");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log("photography");

ok("stock fills only what the client's own site could not", () => {
  const { stockPick } = require("./lib/webgen/stock.js");
  const O = { origin: "https://tool.example.com", seed: "Elra Aesthetic" };
  const clientPhotos = ["https://elra.com/a.jpg", "https://elra.com/b.jpg"];
  const top = stockPick("services", 3, { ...O, exclude: new Set(clientPhotos) });
  assert.ok(top.every((im) => !clientPhotos.includes(im.src)), "never displaces a client photo");
  assert.ok(top.every((im) => im.stock === true), "stock is flagged so the hero picker can avoid it");
});

console.log(`\n${pass} passed`);
