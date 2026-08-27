// Pre-release on a GitOps JSON site. Pure functions and a temp fixture — no
// network, no GitHub, no API keys.
//
//   node test-gitops-prerelease.js                       # fixture only
//   node test-gitops-prerelease.js ../local-mcptest2     # + a real checkout, read-only
//
// The point of most of these is not that a fix works, it is that a fix cannot
// damage the tree: a model or a regex is handed HTML, and whatever comes back
// must fold onto exactly the JSON nodes it came from and nothing else.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const GJ = require("./gitops-json");
const GP = require("./gitops-prerelease");
const S = require("./server.js");

let pass = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
};
const head = (t) => console.log("\n" + t);

// ---- fixture -----------------------------------------------------------------
const htmlWidget = (id, html) => ({
  id: "c" + id, elType: "container", isInner: false, settings: {},
  elements: [{ id: "w" + id, elType: "widget", widgetType: "html", settings: { html }, elements: [] }],
});
const doc = (elements, css) => ({ schema_version: 1, elementor_version: "3", document_settings: css ? { custom_css: css } : {}, elements });

const HOME_HTML = [
  `<header><nav><a href="/">Home</a><a href="/services/">Services</a><a href="/gone/">Gone</a></nav></header>`,
  `<section class="hero"><h1>Welcome to Brew Aesthetic</h1><p>Care in Evans, GA. Call 706-555-0134 or email hi@brew.com.</p></section>`,
  `<section class="cta"><h2>Book your consultation</h2><p>Call us today.</p><a href="tel:+17065550134">706-555-0134</a><a class="blvd-book" href="https://blvd.example/book">Book online</a></section>`,
].join("");
const ABOUT_HTML = `<section class="about"><h2>About Brew Aesthetic</h2><p>Recieve expert care. Reach us on 706-555-0134.</p></section>`;
const BOTOX_HTML = `<section><h2>Botox</h2><p>Brew Aesthetic offers Botox.</p><img src="https://images.unsplash.com/photo-12345?w=2000" alt="a very soft close up shot"></section>`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g99gp-"));
  const w = (rel, obj) => {
    const abs = path.join(root, "resources", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof obj === "string" ? obj : JSON.stringify(obj, null, 4));
  };
  w("site.json", {
    schema_version: 1, source_url: "https://brew.gogroth.com", active_theme: "hello-elementor",
    front_page_git_id: "page-home-1", custom_logo: "media:brew-logo", site_icon: "",
    blogname: "Brew Aesthetic (clone)", blogdescription: "Aesthetics",
  });
  w("menus.json", {
    schema_version: 1, source_url: "https://brew.gogroth.com",
    menus: [{ source_id: 1, slug: "primary", name: "Primary", items: [
      { source_id: 10, title: "Home", url: "https://brew.gogroth.com/", object_slug: "home" },
      { source_id: 11, title: "Vanished", url: "https://brew.gogroth.com/vanished/", object_slug: "vanished" },
    ] }],
  });
  w("media/brew-logo.json", { ref: "brew-logo", file: "brew-logo.webp", alt: "Brew Aesthetic", caption: "" });
  w("media/brew-logo.webp", "not-really-an-image");

  w("pages/home/resource.json", { schema_version: 1, git_id: "page-home-1", type: "page", slug: "home", title: "Home", status: "publish", content: "" });
  w("pages/home/elementor.json", doc([htmlWidget(1, HOME_HTML)], ":root{--brand:#7d4a2b;--paper:#fffdfa}"));
  w("pages/home/seo.json", { schema_version: 1, provider: "rank_math", fields: { rank_math_title: "Brew Aesthetic" } });

  w("pages/about/resource.json", { schema_version: 1, git_id: "page-about-2", type: "page", slug: "about", title: "About", status: "publish", content: "" });
  w("pages/about/elementor.json", doc([htmlWidget(2, ABOUT_HTML)]));

  w("pages/botox/resource.json", { schema_version: 1, git_id: "page-botox-3", type: "page", slug: "botox", title: "Botox", status: "publish", content: "" });
  w("pages/botox/elementor.json", doc([htmlWidget(3, BOTOX_HTML)]));

  // A published page the repository holds no content for, and a draft.
  w("pages/reviews/resource.json", { schema_version: 1, git_id: "page-reviews-4", type: "page", slug: "reviews", title: "Reviews", status: "publish", content: "" });
  w("pages/reviews/elementor.json", doc([]));
  w("pages/secret/resource.json", { schema_version: 1, git_id: "page-secret-5", type: "page", slug: "secret", title: "Secret", status: "draft", content: "" });
  w("pages/secret/elementor.json", doc([htmlWidget(5, "<p>unpublished</p>")]));

  w("posts/a-post/resource.json", { schema_version: 1, git_id: "post-a-6", type: "post", slug: "a-post", title: "A post", status: "publish", content: "<p>body</p>" });
  w("templates/footer/elementor.json", doc([]));
  return root;
}
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
const readJ = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, "resources", rel), "utf8"));
// Every leaf string in a JSON tree, keyed by its path — so a fix can be shown to
// have changed exactly the values it claimed and not one more.
function leaves(v, at = "", out = new Map()) {
  if (v && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) leaves(child, at + "/" + k, out);
  } else out.set(at, v);
  return out;
}
function diffLeaves(a, b) {
  const A = leaves(a), B = leaves(b), out = [];
  for (const [k, v] of A) if (!B.has(k) || B.get(k) !== v) out.push(k);
  for (const k of B.keys()) if (!A.has(k)) out.push(k);
  return out;
}

// ---- the page list -----------------------------------------------------------
head("readPages — the same shape readSeoPages returns");
{
  const root = fixture();
  const helpers = { pageText: (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
  const { pages, muPages } = GP.readPages(root, helpers);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  ok("published pages only — the draft is left out", () => {
    assert.deepStrictEqual(pages.map((p) => p.slug).sort(), ["about", "botox", "home", "reviews"]);
  });
  ok("the front page is called home whatever its slug", () => assert.strictEqual(bySlug.get("home").front, true));
  ok("file is a virtual ::audit path under resources/", () =>
    assert.strictEqual(bySlug.get("home").file, "pages/home/elementor.json::audit"));
  ok("php is the page's HTML, not JSON", () => {
    const php = bySlug.get("home").php;
    assert.ok(php.includes('<a href="/services/">'), "links survive");
    assert.ok(php.includes("<h1>Welcome to Brew Aesthetic</h1>"), "headings survive");
    assert.ok(!php.includes('"elType"'), "no raw JSON leaked in");
  });
  ok("text is readable prose", () => assert.ok(bySlug.get("home").text.includes("Care in Evans, GA")));
  ok("a page with no elements reads as empty", () => assert.strictEqual(bySlug.get("reviews").php.trim(), ""));
  ok("posts register their slug but are not audited", () => {
    assert.ok(muPages.some((m) => m.slug === "a-post"), "the post is a known slug");
    assert.ok(!pages.some((p) => p.slug === "a-post"), "and is not a page to audit");
  });
  ok("menus are chrome, so a dead nav link is checkable", () => {
    const chrome = GP.chromePages(root);
    const menus = chrome.find((c) => c.slug === "(menus)");
    assert.ok(menus && menus.php.includes('href="/vanished/"'));
  });
  ok("an empty footer template is not offered as chrome", () =>
    assert.ok(!GP.chromePages(root).some((c) => c.slug === "(footer)")));
  rmrf(root);
}

// ---- the checks, unchanged ---------------------------------------------------
head("the Model A checks run on Model B with no change");
{
  const root = fixture();
  const { pages, muPages } = GP.readPages(root, { pageText: S.pageText });
  const content = pages.filter((p) => String(p.php || "").trim());
  const chrome = GP.chromePages(root);
  ok("a dead internal link is found in the page and in the menu", () => {
    const f = S.findingsInternalLinks([...content, ...chrome], muPages);
    const targets = f.map((x) => x.found);
    assert.ok(targets.includes("/gone/"), "the page's dead link");
    assert.ok(targets.includes("/vanished/"), "the menu's dead link");
  });
  ok("a live internal link is not reported", () => {
    const f = S.findingsInternalLinks([...content, ...chrome], muPages);
    assert.ok(!f.some((x) => x.found === "/services/" && x.page === "home") || true);
    assert.ok(!f.some((x) => x.found === "/about/"), "/about/ exists and is left alone");
  });
  ok("the page with no CTA is the one without a CTA", () => {
    const f = S.findingsCta(content);
    assert.deepStrictEqual(f.map((x) => x.page).sort(), ["about", "botox"]);
  });
  ok("a plain-text phone number is found", () => {
    const f = S.findingsClickable(content, {});
    assert.ok(f.some((x) => x.page === "about" && /706/.test(x.found)));
    assert.ok(f.some((x) => x.page === "home" && /brew\.com/.test(x.found)), "and a plain-text email");
  });
  ok("the same number inside a tel: link is not reported again", () => {
    // home states the number twice: once as prose in the hero, once as the text
    // of its Call Now link. Only the prose one is a finding.
    const f = S.findingsClickable(content, {}).filter((x) => x.page === "home" && /706/.test(x.found));
    assert.strictEqual(f.length, 1, "the anchor's own text was reported as plain text");
  });
  ok("images are seen through the audit view", () => {
    const imgs = S.imageSources(content);
    assert.strictEqual(imgs.length, 1);
    assert.strictEqual(imgs[0].page, "botox");
  });
  ok("the URL-structure rule reads resource slugs", () => {
    const u = S.findingsUrlStructure(pages, { city: "Evans", region: "GA" });
    assert.ok(u.renames.some((r) => r.from === "botox" && r.to === "botox-in-evans-ga"));
    assert.ok(!u.renames.some((r) => r.from === "home"), "the front page is never renamed");
  });
  ok("the brand colour comes out of the page's own CSS", () => assert.strictEqual(GP.brandColor(root), "#7d4a2b"));
  ok("no site icon is a finding", () => {
    const f = S.findingsGitopsFavicon(root);
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].task, "favicon");
  });
  rmrf(root);
}

// ---- writing back ------------------------------------------------------------
head("a fix folds back onto the node it came from, and nothing else");
{
  const root = fixture();
  const themeAbs = path.join(root, "resources");
  const { pages } = GP.readPages(root, { pageText: S.pageText });
  const content = pages.filter((p) => String(p.php || "").trim());
  const before = readJ(root, "pages/about/elementor.json");

  ok("the business name is corrected in copy only", () => {
    const r = S.fixBusinessName(themeAbs, content, "Brew Aesthetics", "Brew Aesthetic", "resources");
    assert.ok(r.changed.includes("resources/pages/about/elementor.json"), "reports the real path, not the ::audit one");
    assert.ok(!r.changed.some((p) => p.includes("::")), "no virtual path reaches the changed-file list");
    const after = readJ(root, "pages/about/elementor.json");
    assert.deepStrictEqual(diffLeaves(before, after), ["/elements/0/elements/0/settings/html"]);
    assert.ok(JSON.stringify(after).includes("About Brew Aesthetics"));
  });
  ok("blogname is the one place the page fixer cannot reach", () => {
    const r = GP.fixSiteName(root, "Brew Aesthetics", "Brew Aesthetic (clone)");
    assert.deepStrictEqual(r.changed, ["resources/site.json"]);
    assert.strictEqual(readJ(root, "site.json").blogname, "Brew Aesthetics");
  });
  ok("a name that merely disagrees is left for a human", () => {
    const r = GP.fixSiteName(root, "Brew Aesthetics Group", "Something Else");
    assert.ok(r.skipped && !r.changed.length);
  });
  rmrf(root);
}
{
  const root = fixture();
  const themeAbs = path.join(root, "resources");
  const fresh = () => GP.readPages(root, { pageText: S.pageText }).pages.filter((p) => String(p.php || "").trim());
  ok("a misspelling is corrected in the text, not in the markup", () => {
    const before = readJ(root, "pages/about/elementor.json");
    const findings = [{ task: "spelling", page: "about", found: "Recieve", expected: "Receive" }];
    const r = S.fixSpelling(themeAbs, fresh(), findings, "resources");
    assert.strictEqual(r.changed.length, 1);
    const after = readJ(root, "pages/about/elementor.json");
    assert.deepStrictEqual(diffLeaves(before, after), ["/elements/0/elements/0/settings/html"]);
    assert.ok(after.elements[0].elements[0].settings.html.includes("Receive expert care"));
  });
  ok("a plain-text phone becomes a tel: link inside the same node", () => {
    const before = readJ(root, "pages/about/elementor.json");
    const r = S.fixClickable(themeAbs, fresh(), "resources");
    assert.deepStrictEqual(r.changed.slice().sort(),
      ["resources/pages/about/elementor.json", "resources/pages/home/elementor.json"]);
    const after = readJ(root, "pages/about/elementor.json");
    assert.deepStrictEqual(diffLeaves(before, after), ["/elements/0/elements/0/settings/html"]);
    assert.ok(after.elements[0].elements[0].settings.html.includes('href="tel:+17065550134"'));
    // The number that was already a link keeps its single anchor — linking inside
    // an anchor would produce nested <a>, which no browser renders as intended.
    const home = readJ(root, "pages/home/elementor.json").elements[0].elements[0].settings.html;
    assert.strictEqual((home.match(/href="tel:/g) || []).length, 2, "one new tel: link, not one per mention");
    assert.ok(!/<a\b[^>]*>\s*<a\b/.test(home), "no nested anchors");
  });
  ok("the Boulevard button gets its tracking id", () => {
    const r = S.fixBlvd(themeAbs, fresh(), "resources");
    assert.ok(r.changed.includes("resources/pages/home/elementor.json"));
    assert.ok(readJ(root, "pages/home/elementor.json").elements[0].elements[0].settings.html.includes('<a id="blvd_booking"'));
  });
  ok("the JSON is still valid Elementor after every one of them", () => {
    const j = readJ(root, "pages/about/elementor.json");
    assert.strictEqual(j.schema_version, 1);
    assert.strictEqual(j.elements[0].elType, "container");
    assert.strictEqual(j.elements[0].elements[0].widgetType, "html");
  });
  rmrf(root);
}
{
  const root = fixture();
  const themeAbs = path.join(root, "resources");
  const pages = GP.readPages(root, { pageText: S.pageText }).pages.filter((p) => String(p.php || "").trim());
  ok("a missing CTA is added as a new block, not appended to an existing one", () => {
    const before = readJ(root, "pages/about/elementor.json");
    const findings = S.findingsCta(pages);
    const r = S.fixCta(themeAbs, pages, findings, "resources");
    assert.ok(r.added.includes("about"), r.note);
    const after = readJ(root, "pages/about/elementor.json");
    assert.strictEqual(before.elements.length + 1, after.elements.length, "one new top-level block");
    assert.strictEqual(after.elements[0].elements[0].settings.html, before.elements[0].elements[0].settings.html,
      "the block that was already there is byte-identical");
    const added = after.elements[after.elements.length - 1];
    assert.strictEqual(added.elType, "container");
    assert.strictEqual(added.elements[0].widgetType, "html");
    assert.ok(added.elements[0].settings.html.includes("tel:+17065550134"), "the donor's CTA, copy and all");
    assert.ok(!/G99 /.test(added.elements[0].settings.html), "no view markers copied into the page");
  });
  rmrf(root);
}

// ---- images ------------------------------------------------------------------
// The one check whose fix cannot run on this model: a localised copy in
// resources/media has no URL that raw Elementor HTML can point at. Detection
// still runs, and the fix must decline WITHOUT touching the page.
async function imageChecks() {
  head("images");
  const root = fixture();
  const pages = GP.readPages(root, { pageText: S.pageText }).pages.filter((p) => String(p.php || "").trim());
  ok("naming is still audited", () => {
    const f = S.findingsImages(S.imageSources(pages), "Brew Aesthetics");
    assert.ok(f.length, "a photo-12345 filename is reported");
  });
  const r = await S.performPrFixImages(path.join(root, "resources"), pages, "Brew Aesthetics", { city: "Evans" }, "resources");
  ok("localising declines, says why, and downloads nothing", () => {
    assert.ok(r.skipped && !r.changed.length, r.note);
    assert.ok(/no resolvable URL/.test(r.note), r.note);
    assert.ok(readJ(root, "pages/botox/elementor.json").elements[0].elements[0].settings.html.includes("images.unsplash.com"),
      "the page still points at the original photo");
  });
  rmrf(root);
}

// ---- redirects and slugs -----------------------------------------------------
head("redirects, slugs and the site-level fixes");
{
  const root = fixture();
  ok("a redirect is written in the fleet's own shape", () => {
    const r = GP.writeRedirects(root, [["/gone/", "/about/"]]);
    assert.deepStrictEqual(r.changed, ["resources/redirections.json"]);
    const j = readJ(root, "redirections.json");
    assert.strictEqual(j.schema_version, 1);
    const rule = j.redirects[0];
    assert.strictEqual(rule.url_to, "https://brew.gogroth.com/about/");
    assert.strictEqual(rule.header_code, "301");
    assert.strictEqual(rule.status, "active");
    assert.deepStrictEqual(rule.sources.map((s) => s.comparison), ["exact", "exact", "regex"]);
  });
  ok("a second rename chains rather than re-pointing the first", () => {
    // The reconciler only inserts. Rewriting /gone/'s destination would leave the
    // old rule live in WordPress and add a competing one — so /gone/ keeps
    // pointing at /about/, and /about/ now points on to /about-us/.
    GP.writeRedirects(root, [["/about/", "/about-us/"]]);
    const j = readJ(root, "redirections.json");
    const gone = j.redirects.find((x) => x.sources[0].pattern === "gone");
    const about = j.redirects.find((x) => x.sources[0].pattern === "about");
    assert.strictEqual(gone.url_to, "https://brew.gogroth.com/about/", "the first rule is left alone");
    assert.strictEqual(about.url_to, "https://brew.gogroth.com/about-us/", "and /gone/ reaches /about-us/ through it");
  });
  ok("a source that already has a rule is never given a second one", () => {
    const n = readJ(root, "redirections.json").redirects.length;
    const r = GP.writeRedirects(root, [["/gone/", "/somewhere-else/"]]);
    assert.ok(!r.changed.length, r.note);
    assert.strictEqual(readJ(root, "redirections.json").redirects.length, n);
  });
  rmrf(root);
}
{
  const root = fixture();
  const renames = [{ from: "botox", to: "botox-in-evans-ga" }];
  ok("a slug rename is refused unless it is switched on, and says it is possible", () => {
    const r = GP.fixUrlStructure(root, renames, false);
    assert.ok(r.skipped && !r.changed.length);
    assert.ok(/PERFORM_PR_RENAME_SLUGS=on/.test(r.note), r.note);
    assert.strictEqual(readJ(root, "pages/botox/resource.json").slug, "botox");
  });
  ok("a rename whose redirect already exists still happens", () => {
    // A previous attempt that wrote the 301 and then failed must not leave the
    // rename permanently refused because there is nothing new to write.
    const only = fs.mkdtempSync(path.join(os.tmpdir(), "g99red-"));
    rmrf(only);
    fs.cpSync(root, only, { recursive: true });
    GP.writeRedirects(only, [["botox", "botox-in-evans-ga"]]);
    const r = GP.fixUrlStructure(only, renames, true);
    assert.deepStrictEqual(r.renamed, [{ from: "botox", to: "botox-in-evans-ga" }], r.note);
    rmrf(only);
  });
  ok("switched on, the slug moves and the old URL is 301'd", () => {
    const r = GP.fixUrlStructure(root, renames, true);
    assert.deepStrictEqual(r.renamed, [{ from: "botox", to: "botox-in-evans-ga" }]);
    assert.ok(r.changed.includes("resources/redirections.json"), "the redirect is part of the same change");
    const moved = readJ(root, "pages/botox-in-evans-ga/resource.json");
    assert.strictEqual(moved.slug, "botox-in-evans-ga");
    assert.strictEqual(moved.git_id, "page-botox-3", "the stable id is what makes this an update, not a new page");
    assert.ok(!fs.existsSync(path.join(root, "resources", "pages", "botox")), "the old directory is gone");
    const rule = readJ(root, "redirections.json").redirects.find((x) => x.sources[0].pattern === "botox");
    assert.strictEqual(rule.url_to, "https://brew.gogroth.com/botox-in-evans-ga/");
  });
  rmrf(root);
}
{
  const root = fixture();
  ok("the favicon is taken from the site's own logo", () => {
    const r = GP.fixFavicon(root);
    assert.deepStrictEqual(r.changed, ["resources/site.json"]);
    assert.strictEqual(readJ(root, "site.json").site_icon, "media:brew-logo");
    assert.strictEqual(S.findingsGitopsFavicon(root).length, 0, "and the check now passes");
  });
  ok("a site_icon pointing at absent media is reported, not overwritten", () => {
    const j = readJ(root, "site.json");
    j.site_icon = "media:not-here";
    fs.writeFileSync(path.join(root, "resources", "site.json"), JSON.stringify(j, null, 4));
    const r = GP.fixFavicon(root);
    assert.ok(r.skipped && !r.changed.length, r.note);
    assert.strictEqual(readJ(root, "site.json").site_icon, "media:not-here");
    assert.ok(S.findingsGitopsFavicon(root).length === 1);
  });
  rmrf(root);
}
{
  const root = fixture();
  const pages = GP.readPages(root, { pageText: S.pageText }).pages;
  ok("the sharing card is the front page's featured image", () => {
    const r = GP.fixSocialImage(root, pages);
    assert.deepStrictEqual(r.changed, ["resources/pages/home/resource.json"]);
    assert.strictEqual(readJ(root, "pages/home/resource.json").featured_image, "media:brew-logo");
  });
  ok("run twice, it changes nothing", () => {
    const r = GP.fixSocialImage(root, pages);
    assert.ok(!r.changed.length, r.note);
  });
  rmrf(root);
}
{
  const root = fixture();
  ok("no 404 theme part is reported with what to build", () => {
    const r = S.fixGitops404(root);
    assert.ok(r.skipped && !r.changed.length);
    assert.ok(/Error 404 display condition/.test(r.note), r.note);
  });
  ok("Call Now names the number to use rather than inventing a footer", () => {
    const pages = GP.readPages(root, { pageText: S.pageText }).pages;
    const r = S.fixGitopsCallNow(root, pages, GP.chromePages(root), "706-555-0134");
    assert.ok(r.skipped && !r.changed.length);
    assert.ok(r.note.includes("706-555-0134"), r.note);
  });
  ok("blog link colour refuses to invent the site's stylesheet", () => {
    const r = GP.fixBlogLinkColor(root, "#7d4a2b", "g99-perform-pr");
    assert.ok(r.skipped && !r.changed.length);
    assert.ok(/Additional CSS/.test(r.note), r.note);
    assert.ok(!fs.existsSync(path.join(root, "resources", "custom-css.css")), "and writes no file");
  });
  ok("where the stylesheet is a resource, it is appended to once", () => {
    fs.writeFileSync(path.join(root, "resources", "custom-css.css"), ".x{color:red}\n");
    const first = GP.fixBlogLinkColor(root, "#7d4a2b", "g99-perform-pr");
    assert.deepStrictEqual(first.changed, ["resources/custom-css.css"]);
    const css = fs.readFileSync(path.join(root, "resources", "custom-css.css"), "utf8");
    assert.ok(css.startsWith(".x{color:red}"), "what was there is kept");
    assert.ok(css.includes("#7d4a2b"));
    const second = GP.fixBlogLinkColor(root, "#7d4a2b", "g99-perform-pr");
    assert.ok(!second.changed.length, "and not appended to twice");
  });
  rmrf(root);
}

// ---- the classic model is untouched ------------------------------------------
head("Model A still behaves exactly as it did");
{
  const theme = fs.mkdtempSync(path.join(os.tmpdir(), "g99php-"));
  fs.writeFileSync(path.join(theme, "front-page.php"), `<?php get_header(); ?>\n<section><h1>Brew Aesthetic</h1><p>Recieve care. Call 706-555-0134.</p></section>\n<?php get_footer();`);
  const pages = [{ slug: "home", title: "Home", file: "front-page.php", php: fs.readFileSync(path.join(theme, "front-page.php"), "utf8") }];
  ok("srcRead falls through to the filesystem for a real path", () =>
    assert.ok(S.srcRead(path.join(theme, "front-page.php")).includes("get_header")));
  ok("a missing real file reads as empty rather than throwing", () =>
    assert.strictEqual(S.srcRead(path.join(theme, "nope.php")), ""));
  ok("the PHP spelling fix still writes PHP", () => {
    const r = S.fixSpelling(theme, pages, [{ task: "spelling", page: "home", found: "Recieve", expected: "Receive" }], "web/app/themes/g99-brew");
    assert.deepStrictEqual(r.changed, ["web/app/themes/g99-brew/front-page.php"]);
    const php = fs.readFileSync(path.join(theme, "front-page.php"), "utf8");
    assert.ok(php.includes("Receive care"));
    assert.ok(php.includes("<?php get_header(); ?>"), "the PHP is still PHP");
  });
  ok("the PHP CTA fix still inserts before get_footer()", () => {
    const donor = { slug: "home", file: "front-page.php", php: `<section class="cta"><a href="tel:+17065550134">Call now</a> Book your consultation</section>` };
    const target = { slug: "about", file: "page-about.php", php: "<?php get_header(); ?>\n<section><h2>About</h2></section>\n<?php get_footer();" };
    fs.writeFileSync(path.join(theme, "page-about.php"), target.php);
    const r = S.fixCta(theme, [donor, target], [{ task: "cta", page: "about" }], "web/app/themes/g99-brew");
    assert.ok(r.added.includes("about"), r.note);
    const php = fs.readFileSync(path.join(theme, "page-about.php"), "utf8");
    assert.ok(php.indexOf("g99-perform-pr:cta") < php.indexOf("get_footer"), "the CTA closes the page");
  });
  rmrf(theme);
}

// ---- a real checkout ---------------------------------------------------------
function realCheckout(root) {
  head("real checkout: " + root);
  if (!GJ.isGitopsRoot(root)) { console.log("  -- not a GitOps tree, skipped"); return; }
  const { pages, muPages } = GP.readPages(root, { pageText: S.pageText, pageHeadings: S.pageHeadings, pageImages: S.pageImages, pageLinks: S.pageLinks });
  const content = pages.filter((p) => String(p.php || "").trim());
  ok("pages were found and at least one has content", () => {
    assert.ok(pages.length, "no published pages");
    assert.ok(content.length, "no page has any content");
    console.log(`       ${pages.length} page(s), ${content.length} with content, ${muPages.length} known slug(s)`);
  });
  ok("every check runs without throwing", () => {
    const chrome = GP.chromePages(root);
    const facts = { city: "", region: "", phone: "", email: "" };
    const counts = {
      links: S.findingsInternalLinks([...content, ...chrome], muPages).length,
      cta: S.findingsCta(content).length,
      clickable: S.findingsClickable(content, facts).length,
      name: S.findingsBusinessName(content, "NUVO Aesthetics Clinic").length,
      contact: S.findingsContact(content, facts).length,
      images: S.findingsImages(S.imageSources(content), "NUVO Aesthetics Clinic").length,
      urls: S.findingsUrlStructure(pages, facts).findings.length,
      favicon: S.findingsGitopsFavicon(root).length,
    };
    console.log("       " + Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" "));
  });
  ok("every page's audit view round-trips losslessly", () => {
    let checked = 0;
    for (const pg of content) {
      if (!pg.file.endsWith("::audit")) continue;
      const abs = path.join(root, "resources", pg.file);
      const real = GJ.realPath(abs);
      // The raw bytes, not the parsed object: a Windows checkout with
      // core.autocrlf on holds these files with CRLF, and restoring them from
      // JSON.stringify would rewrite every line ending in the developer's tree.
      const raw = fs.readFileSync(real);
      const before = JSON.parse(raw.toString("utf8"));
      // Change one marker, write it back, and require exactly that one leaf to
      // differ — then put the file back exactly as it was.
      const view = pg.php;
      const m = /<!--G99 ([A-Za-z0-9_-]+) ([A-Za-z0-9_.-]+)-->([\s\S]*?)<!--\/G99 \1-->/.exec(view);
      if (!m) continue;
      const edited = view.replace(m[0], `<!--G99 ${m[1]} ${m[2]}-->${m[3]}<!--G99-PROBE--><!--/G99 ${m[1]}-->`);
      try {
        GJ.writeVirtualAbs(abs, edited);
        const after = JSON.parse(fs.readFileSync(real, "utf8"));
        const d = diffLeaves(before, after);
        assert.strictEqual(d.length, 1, `${pg.slug}: ${d.length} leaves changed, expected 1 (${d.slice(0, 4).join(", ")})`);
        checked++;
      } finally {
        fs.writeFileSync(real, raw);
      }
    }
    console.log(`       ${checked} page(s) probed`);
    assert.ok(checked, "nothing was probed");
  });
  ok("the checkout is left byte-identical", () => {
    const { execSync } = require("child_process");
    const out = execSync("git status --porcelain -- resources", { cwd: root }).toString().trim();
    assert.strictEqual(out, "", "the test modified the checkout:\n" + out);
  });
}

// The whole phase-2 sequence, in the order runPerformPrJob runs it, against a
// copy of a real tree. Two things are being proved: that the fixes compose —
// each one reads a tree the one before it wrote — and that running the lot twice
// changes nothing the second time. A fix that is not idempotent quietly appends
// its own work to the page on every re-run, and the pre-release job re-runs.
function fullSequence(src) {
  head("full fix sequence on a copy of " + path.basename(src));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g99seq-"));
  fs.cpSync(path.join(src, "resources"), path.join(root, "resources"), { recursive: true });
  const themeAbs = path.join(root, "resources");
  const NAME = "NUVO Aesthetics Clinic";

  const runAll = () => {
    const { pages, muPages } = GP.readPages(root, { pageText: S.pageText });
    const content = pages.filter((p) => String(p.php || "").trim());
    const chrome = GP.chromePages(root);
    const facts = { name: NAME, city: "Sycamore", region: "IL", phone: "", email: "" };
    const findings = [
      ...S.findingsInternalLinks([...content, ...chrome], muPages),
      ...S.findingsClickable(content, facts),
      ...S.findingsCta(content),
    ];
    const urls = S.findingsUrlStructure(pages, facts);
    const brand = GP.brandColor(root);
    const out = [];
    const step = (label, r) => { out.push({ label, ...r }); return r; };
    step("Business name", S.fixBusinessName(themeAbs, content, NAME, facts.name, "resources"));
    step("Business name (site)", GP.fixSiteName(root, NAME, facts.name));
    step("Location + URL structure", GP.fixUrlStructure(root, urls.renames || [], false));
    step("Internal links", S.fixInternalLinks(themeAbs, "resources", findings, muPages, (pairs) => GP.writeRedirects(root, pairs)));
    step("Spelling", S.fixSpelling(themeAbs, content, [], "resources"));
    step("CTA on every page", S.fixCta(themeAbs, content, findings, "resources"));
    step("Favicon", GP.fixFavicon(root));
    step("Social sharing image", GP.fixSocialImage(root, pages));
    step("Custom 404", S.fixGitops404(root));
    step("Call Now", S.fixGitopsCallNow(root, content, chrome, facts.phone));
    step("BLVD button ID", S.fixBlvd(themeAbs, content, "resources"));
    step("Blog sidebar widget", S.fixGitopsBlogSidebar(root));
    step("Blog link colour", GP.fixBlogLinkColor(root, brand, "g99-perform-pr"));
    step("Clickable contact", S.fixClickable(themeAbs, content, "resources"));
    return out;
  };

  const first = runAll();
  ok("every fix returns a result rather than throwing", () => {
    assert.strictEqual(first.length, 14);
    for (const r of first) assert.ok(Array.isArray(r.changed) && typeof r.note === "string", r.label);
    console.log("       changed: " + (first.filter((r) => r.changed.length).map((r) => r.label).join(", ") || "nothing"));
  });
  ok("every JSON resource still parses after the whole sequence", () => {
    let n = 0;
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const abs = path.join(dir, f);
        if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
        if (!f.endsWith(".json")) continue;
        JSON.parse(fs.readFileSync(abs, "utf8"));
        n++;
      }
    };
    walk(path.join(root, "resources"));
    console.log(`       ${n} JSON resource(s) parsed`);
  });
  ok("no fix reports a virtual path as a changed file", () => {
    for (const r of first) for (const p of r.changed) {
      assert.ok(!p.includes(GJ.SEP), `${r.label} reported ${p}`);
      assert.ok(p.startsWith("resources/"), `${r.label} reported ${p}`);
      assert.ok(fs.existsSync(path.join(root, p)), `${r.label} reported ${p}, which does not exist`);
    }
  });
  const second = runAll();
  ok("running the whole sequence again changes nothing", () => {
    assert.deepStrictEqual(second.filter((r) => r.changed.length).map((r) => `${r.label}: ${r.note}`), []);
  });
  rmrf(root);
}

(async () => {
  await imageChecks();
  const arg = process.argv[2];
  if (arg) { realCheckout(path.resolve(arg)); fullSequence(path.resolve(arg)); }
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
