// Can a stored generation be served back as a walkable website?
//
// The pieces that decide this are pure, so they are tested directly rather than
// through a live server and a live database:
//
//   clientKey()   — two spellings of one beta URL must be one client, or a
//                   client's history silently splits in two and V2 starts over.
//   slugForPath() — the preview has to answer to both the slug we link to and
//                   the site-shaped path someone types or a nav link carries.
//   rewriteNav()  — the ONE thing that stops a preview being browsable. It has
//                   to catch the four site-root links and, just as importantly,
//                   leave everything else byte-identical: this is an archive.
//
// The database half (versioning, gzip storage) is proven by the live run
// recorded in PLAN.md; it needs the RDS and cannot run here.

const assert = require("assert");
const DB = require("./lib/history/db");
const PREVIEW = require("./lib/history/preview");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

console.log("\nclient key");

t("one client, however the beta URL is spelled", () => {
  const want = "nuvoaestheticsclinic.gogroth.com";
  for (const spelling of [
    "https://nuvoaestheticsclinic.gogroth.com",
    "https://nuvoaestheticsclinic.gogroth.com/",
    "http://www.NuvoAestheticsClinic.gogroth.com/",
    "nuvoaestheticsclinic.gogroth.com",
  ]) assert.strictEqual(DB.clientKey(spelling), want, spelling);
});

t("a path keeps two clients on one host apart", () => {
  assert.strictEqual(DB.clientKey("https://x.gogroth.com/a"), "x.gogroth.com/a");
  assert.notStrictEqual(DB.clientKey("https://x.gogroth.com/a"), DB.clientKey("https://x.gogroth.com/b"));
});

t("no URL, no key", () => {
  assert.strictEqual(DB.clientKey(""), "");
  assert.strictEqual(DB.clientKey(null), "");
});

console.log("\npreview paths");

t("the root is the home page", () => {
  assert.strictEqual(PREVIEW.slugForPath(""), "home");
  assert.strictEqual(PREVIEW.slugForPath("/"), "home");
  assert.strictEqual(PREVIEW.slugForPath("/index.html"), "home");
});

t("a page answers to its slug and to its site path", () => {
  for (const spelling of ["services", "/services", "/services/", "/services.html"]) {
    assert.strictEqual(PREVIEW.slugForPath(spelling), "services", spelling);
  }
});

t("home's preview URL ends in a slash, a page's does not", () => {
  assert.strictEqual(PREVIEW.previewUrl("a.com", 3, "home"), "/preview/a.com/v3/");
  assert.strictEqual(PREVIEW.previewUrl("a.com", 3, "about"), "/preview/a.com/v3/about");
});

t("nothing that is not a page name resolves", () => {
  assert.strictEqual(PREVIEW.slugForPath("/../../etc/passwd"), "");
  assert.strictEqual(PREVIEW.slugForPath("/services/dysport/latham"), "");
});

console.log("\nnav rewrite");

const ALL = ["home", "services", "about", "contact"];
const PAGE = [
  "<!doctype html><html><head><style>.u-wrap{max-width:70rem}</style></head><body>",
  '<a href="/"><img src="https://ruma.com/logo.svg" alt="RUMA"></a>',
  '<a href="/services/">Services</a><a href="/about/">About</a><a href="/contact/">Contact</a>',
  '<a href="tel:+18015147650">call</a><a href="mailto:info@ruma.com">mail</a>',
  '<a href="#book">book</a><a href="https://instagram.com/">Instagram</a>',
  '<a href="/services/dysport-injections">a real service page</a>',
  "<script>var x=1;</script></body></html>",
].join("");

t("the four site-root links point at this version", () => {
  const { html, rewrote } = PREVIEW.rewriteNav(PAGE, "a.com", 8, ALL);
  assert.strictEqual(rewrote, 4);
  for (const slug of ALL) {
    assert.ok(html.includes('href="' + PREVIEW.previewUrl("a.com", 8, slug) + '"'), slug + " not rewritten");
  }
});

t("everything else is left exactly as archived", () => {
  const { html } = PREVIEW.rewriteNav(PAGE, "a.com", 8, ALL);
  for (const untouched of [
    'href="tel:+18015147650"', 'href="mailto:info@ruma.com"', 'href="#book"',
    'href="https://instagram.com/"', 'href="/services/dysport-injections"',
    "<style>.u-wrap{max-width:70rem}</style>", "<script>var x=1;</script>",
    'src="https://ruma.com/logo.svg"',
  ]) assert.ok(html.includes(untouched), "changed: " + untouched);
});

t("only the hrefs move — nothing else about the bytes", () => {
  const { html } = PREVIEW.rewriteNav(PAGE, "a.com", 8, ALL);
  const strip = (s) => s.replace(/\shref="[^"]*"/g, " href");
  assert.strictEqual(strip(html), strip(PAGE));
});

t("a page this version never stored becomes a dead link, not a trip to the live site", () => {
  const { html } = PREVIEW.rewriteNav(PAGE, "a.com", 8, ["home", "services"]);
  assert.ok(html.includes('href="' + PREVIEW.previewUrl("a.com", 8, "services") + '"'));
  assert.ok(!html.includes('href="/about/"'), "still points at the live site");
  assert.ok(html.includes('href="#"'), "about/contact should be inert");
});

t("single quotes are rewritten too", () => {
  const { html, rewrote } = PREVIEW.rewriteNav("<a href='/about/'>x</a>", "a.com", 2, ALL);
  assert.strictEqual(rewrote, 1);
  assert.ok(html.includes("/preview/a.com/v2/about"));
});

t("an empty or absent page does not throw", () => {
  assert.strictEqual(PREVIEW.rewriteNav("", "a.com", 1, ALL).rewrote, 0);
  assert.strictEqual(PREVIEW.rewriteNav(null, "a.com", 1, ALL).html, "");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
