// Self-test for the designer feedback loop.
//   node test-feedback.js
//
// Nothing here talks to the network, GitHub or an AI — the model call is a stub.
// The point is the part that must never go wrong on a pipeline that merges its
// own work: a note is applied to the section it was left on, or it is refused
// with a reason. Never to a different section, and never silently.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const S = require("./lib/feedback/schema");
const V = require("./lib/feedback/validate");
const P = require("./lib/feedback/patch");
const R = require("./lib/feedback/resolve");
const ST = require("./lib/feedback/store");
const RUN = require("./lib/feedback/run");
const G = require("./gitops-json");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

// ---- fixture ----------------------------------------------------------------
// A gitops checkout shaped like the real thing: one container per section, each
// holding a single html widget, ids stable per section.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const page = path.join(root, "resources", "pages", "home");
  fs.mkdirSync(page, { recursive: true });
  fs.mkdirSync(path.join(root, "resources", "pages", "services"), { recursive: true });
  const doc = {
    schema_version: 1,
    elementor_version: "3",
    document_settings: { custom_css: "body{margin:0}" },
    elements: [
      {
        id: "sec0001", elType: "container", isInner: false, settings: {},
        elements: [{ id: "w0001", elType: "widget", widgetType: "html", settings: { html: '<header class="c-nav"><a href="/">Home</a><a href="/old">Book Now</a></header>' }, elements: [] }],
      },
      {
        id: "sec0002", elType: "container", isInner: false, settings: {},
        elements: [{ id: "w0002", elType: "widget", widgetType: "html", settings: { html: '<section class="hero"><h1>Welcome</h1><img src="/a.jpg"><a class="c-btn" href="/book">Book a Visit</a></section>' }, elements: [] }],
      },
      // A container with two widgets — addressable, but not one HTML block.
      {
        id: "sec0003", elType: "container", isInner: false, settings: {},
        elements: [
          { id: "w0003", elType: "widget", widgetType: "heading", settings: { title: "Services" }, elements: [] },
          { id: "w0004", elType: "widget", widgetType: "html", settings: { html: "<p>x</p>" }, elements: [] },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(page, "elementor.json"), JSON.stringify(doc, null, 4));
  fs.writeFileSync(path.join(root, "resources", "pages", "services", "elementor.json"),
    JSON.stringify({ schema_version: 1, elements: [{ id: "svc001", elType: "container", settings: {}, elements: [{ id: "sw001", elType: "widget", widgetType: "html", settings: { html: "<section>services</section>" }, elements: [] }] }] }, null, 4));
  fs.writeFileSync(path.join(root, "resources", "site.json"), JSON.stringify({ blogname: "Test" }, null, 4));
  return root;
}

const item = (over) => S.normaliseItem(Object.assign({
  page: "/", elementId: "sec0002", note: "make the button gold",
  target: { tag: "a", text: "Book a Visit", childPath: [0, 2] },
}, over), 0);

// ---- schema -----------------------------------------------------------------
console.log("\nschema");
{
  const b = S.normaliseBatch([
    { page: "/services/?x=1#h", elementId: "abc1234", note: "make button gold", target: { tag: "A", text: "Book Now", childPath: [0, 2] } },
    { page: "/", elementId: "", note: "no id" },
    { page: "/", elementId: "def5678", note: "" },
    { page: "/", elementId: "bad id!", note: "bad id shape" },
  ]);
  eq("keeps only usable items", b.items.length, 1);
  eq("counts dropped", b.dropped, 3);
  eq("strips query and hash", b.items[0].page, "/services");
  eq("derives slug", b.items[0].slug, "services");
  eq("lowercases tag", b.items[0].target.tag, "a");
  eq("home path stays /", S.normalisePath(""), "/");
  eq("home slug", S.pageSlug("/"), "home");
  eq("top-level slug", S.pageSlug("/about"), "about");
  eq("trailing slash", S.pageSlug("/services/"), "services");
  // A child page's slug is the last segment. Taking the first sent every note
  // under /services/ to the services listing page instead — the wrong page,
  // edited without complaint.
  eq("child page uses the last segment", S.pageSlug("/services/botox/"), "botox");
  eq("grandchild page too", S.pageSlug("/services/botox/consult/"), "consult");
  eq("query and hash are dropped", S.pageSlug("/contact?x=1#y"), "contact");
  eq("case is normalised", S.pageSlug("/Services/BOTOX/"), "botox");
  ok("fingerprint is stable",
    S.targetFingerprint({ tag: "a", text: "Book Now", childPath: [0, 2] }) === b.items[0].fingerprint);
  ok("fingerprint moves with the element",
    S.targetFingerprint({ tag: "a", text: "Book Now" }) !== S.targetFingerprint({ tag: "a", text: "Call Us" }));

  const grouped = S.groupByPage(S.normaliseBatch([
    { page: "/", elementId: "a1111111", note: "x" },
    { page: "/services", elementId: "b2222222", note: "y" },
    { page: "/", elementId: "c3333333", note: "z" },
  ]).items);
  eq("groups by page", grouped.length, 2);
  eq("keeps page order", grouped[0].slug, "home");
  eq("groups all of a page together", grouped[0].items.length, 2);

  const bySec = S.groupBySection(S.normaliseBatch([
    { page: "/", elementId: "a1111111", note: "x" },
    { page: "/", elementId: "a1111111", note: "y" },
    { page: "/", elementId: "b2222222", note: "z" },
  ]).items);
  eq("groups by section", bySec.length, 2);
  eq("coalesces same-section notes", bySec[0].items.length, 2);
}

// ---- validate ---------------------------------------------------------------
console.log("\nvalidate");
{
  ok("refuses an unchanged section when nothing else changed", !V.checkHtml("<p>a</p>", "<p>a</p>").ok);
  // A spacing/colour note is correctly answered in CSS alone, and the model
  // returning the markup untouched is the right answer to it. The first live
  // run refused exactly such a note before this case existed.
  ok("accepts unchanged markup when the css carries the change",
    V.checkHtml("<p>a</p>", "<p>a</p>", { cssChanged: true }).ok);
  ok("refuses an empty rewrite", !V.checkHtml("<p>a</p>", "").ok);
  ok("refuses an injected script", !V.checkHtml("<p>a</p>", "<p>a</p><script>x()</script>").ok);
  ok("refuses an injected iframe", !V.checkHtml("<p>a</p>", '<p>a</p><iframe src="x"></iframe>').ok);
  ok("refuses an inline handler", !V.checkHtml("<p>a</p>", '<p onclick="x()">a</p>').ok);
  ok("refuses a javascript: url", !V.checkHtml('<a href="/x">a</a>', '<a href="javascript:x()">a</a>').ok);
  ok("refuses a data: url that is not an image", !V.checkHtml('<a href="/x">a</a>', '<a href="data:text/html,x">a</a>').ok);
  ok("allows a data: image", V.checkHtml('<img src="/x.png">', '<img src="data:image/png;base64,iVBOR">').ok);
  ok("accepts a real edit", V.checkHtml('<p class="a">hi</p>', '<p class="b">hi</p>').ok);
  ok("refuses a dropped image", !V.checkHtml('<div><img src="a"><img src="b"></div>', '<div><img src="a"></div>').ok);
  ok("allows removal when the note asked for it",
    V.checkHtml('<div><img src="a"><img src="b"></div>', '<div><img src="a"></div>', { allowStructural: true }).ok);
  ok("refuses unbalanced markup", !V.checkHtml("<p>a</p>", "<div><p>a</p>").ok);
  ok("refuses a stray close tag", !V.checkHtml("<p>a</p>", "</div><p>a</p>").ok);
  ok("tolerates void tags", V.checkHtml("<p>a</p>", "<p>a<br>b</p>").ok);
  ok("refuses a wholesale rebuild", !V.checkHtml("<p>a</p>", "<p>a</p>" + "<div>x</div>".repeat(40)).ok);

  // Unscoped CSS is CONFINED rather than rejected: rejecting it meant the model
  // could add a class in the HTML, have the rule that gives it meaning thrown
  // away, and the note still report as applied. Prefixing only ever narrows.
  {
    const c1 = V.checkCss(".c-btn{color:red}", "abc1234");
    ok("confines unscoped css", c1.ok && c1.css === ".elementor-element-abc1234 .c-btn{color:red}");
    const c2 = V.checkCss(".elementor-element-abc1234 .c-btn{color:red}", "abc1234");
    ok("leaves already-scoped css alone", c2.ok && c2.css.includes(".elementor-element-abc1234 .c-btn"));
    ok("does not double-scope", (c2.css.match(/elementor-element-abc1234/g) || []).length === 1);
    const c3 = V.checkCss("@media(max-width:600px){.x{color:red}}", "abc1234");
    ok("confines css inside a media query", c3.ok && c3.css.includes("@media") && c3.css.includes(".elementor-element-abc1234 .x"));
    const c4 = V.checkCss(".a,.b{color:red}", "abc1234");
    ok("confines every selector in a list",
      c4.ok && (c4.css.match(/elementor-element-abc1234/g) || []).length === 2);
    ok("refuses @import", !V.checkCss("@import url(x);.a{color:red}", "abc1234").ok);
    ok("refuses a rule aimed at body", !V.checkCss("body{margin:0}", "abc1234").ok);
    ok("refuses a rule aimed at :root", !V.checkCss(":root{--x:1}", "abc1234").ok);
    ok("empty css is fine", V.checkCss("", "abc1234").ok);
  }

  const items = [item(), item({ note: "and make the heading smaller" })];
  items[1].localId = "i2";
  const verdicts = V.checkAddressed("<p>a</p>", "<p>b</p>", "", items, ["i1"]);
  ok("marks an unclaimed note as not addressed", verdicts[1].ok === false);
  ok("marks a claimed note as addressed", verdicts[0].ok === true);
}

// ---- deterministic patch ----------------------------------------------------
console.log("\npatch (deterministic)");
{
  const html = '<div><a href="/old">Book Now</a><a href="/other">Other</a></div>';
  const d = P.deterministicEdit(html, { note: "this should point to /contact", target: { tag: "a", text: "Book Now" } });
  ok("rewrites the clicked anchor", d && d.html.includes('href="/contact">Book Now'));
  ok("leaves the other anchor alone", d && d.html.includes('href="/other"'));
  ok("ignores a non-link target", P.deterministicEdit(html, { note: "point to /x", target: { tag: "div", text: "Book Now" } }) === null);
  ok("ignores a note with no url", P.deterministicEdit(html, { note: "make it gold", target: { tag: "a", text: "Book Now" } }) === null);
  ok("refuses an ambiguous match",
    P.deterministicEdit('<a href="/a">Go</a><a href="/b">Go</a>', { note: "to /c", target: { tag: "a", text: "Go" } }) === null);
  ok("adds href when the anchor had none",
    (P.deterministicEdit('<a class="x">Go</a>', { note: "to /c", target: { tag: "a", text: "Go" } }) || {}).html === '<a class="x" href="/c">Go</a>');
  ok("accepts an absolute url",
    (P.deterministicEdit('<a href="/o">Go</a>', { note: "link it to https://x.com/y", target: { tag: "a", text: "Go" } }) || {}).html.includes("https://x.com/y"));

  ok("strips a json fence", P.parseReply('```json\n{"html":"<p>x</p>","addressed":["i1"]}\n```').html === "<p>x</p>");
  ok("survives a preface", P.parseReply('Sure!\n{"html":"<p>x</p>"}').html === "<p>x</p>");
  let threw = false;
  try { P.parseReply("not json at all"); } catch (e) { threw = true; }
  ok("refuses unusable output", threw);
}

// ---- resolve ----------------------------------------------------------------
console.log("\nresolve");
{
  const root = fixture();
  const r = R.resolvePage(root, "home", [item()]);
  eq("finds the page file", r.file, "resources/pages/home/elementor.json");
  eq("resolves one target", r.resolved.length, 1);
  eq("points at the html widget, not the container", r.resolved[0].widgetId, "w0002");
  eq("keeps the container id for css scoping", r.resolved[0].containerId, "sec0002");
  ok("reads the fragment from git", r.resolved[0].html.includes("Book a Visit"));
  ok("confirms the clicked element is still there", r.resolved[0].evidencePresent === true);

  const gone = R.resolvePage(root, "home", [item({ elementId: "nothere" })]);
  eq("a missing id is a conflict", gone.conflicts.length, 1);
  ok("says why", /no longer on the page/.test(gone.conflicts[0].reason));

  const multi = R.resolvePage(root, "home", [item({ elementId: "sec0003" })]);
  eq("a multi-widget container is a conflict", multi.conflicts.length, 1);
  ok("explains a multi-widget container", /several widgets/.test(multi.conflicts[0].reason));

  const noPage = R.resolvePage(root, "nosuch", [item({ page: "/nosuch" })]);
  eq("a missing page is a conflict", noPage.conflicts.length, 1);

  // A duplicated id makes "the" target meaningless — two sections answer to the
  // same name, so patching either one is a guess.
  {
    const dupRoot = fixture();
    const dupAbs = path.join(dupRoot, "resources/pages/home/elementor.json");
    const d2 = JSON.parse(fs.readFileSync(dupAbs, "utf8"));
    d2.elements.push(JSON.parse(JSON.stringify(d2.elements[1])));   // same id twice
    fs.writeFileSync(dupAbs, JSON.stringify(d2, null, 4));
    const dup = R.resolvePage(dupRoot, "home", [item()]);
    eq("a duplicated id is a conflict", dup.conflicts.length, 1);
    ok("explains a duplicated id", /more than once/.test(dup.conflicts[0].reason));
    fs.rmSync(dupRoot, { recursive: true, force: true });
  }

  ok("spots evidence that has gone",
    R.evidenceStillPresent("<section><h1>Welcome</h1></section>", item()) === false);
  ok("tolerates entity differences",
    R.evidenceStillPresent("<a>Tom&#039;s Diner</a>", item({ target: { tag: "a", text: "Tom’s Diner" } })) === true);

  // drift: the section changed but the clicked element survives
  const abs = path.join(root, "resources/pages/home/elementor.json");
  const before = R.resolvePage(root, "home", [item()]).resolved[0];
  const doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  doc.elements[1].elements[0].settings.html = '<section class="hero"><h1>Welcome back</h1><img src="/a.jpg"><a class="c-btn" href="/book">Book a Visit</a></section>';
  fs.writeFileSync(abs, JSON.stringify(doc, null, 4));
  const rc = R.recheck(root, "home", before);
  ok("accepts drift when the target survives", rc.ok === true && rc.drifted === true);

  doc.elements[1].elements[0].settings.html = "<section><p>completely different</p></section>";
  fs.writeFileSync(abs, JSON.stringify(doc, null, 4));
  const rc2 = R.recheck(root, "home", before);
  ok("refuses drift when the target is gone", rc2.ok === false);

  fs.rmSync(root, { recursive: true, force: true });
}

// ---- store ------------------------------------------------------------------
console.log("\nstore");
{
  const tmp = path.join(os.tmpdir(), `fb-ledger-${Date.now()}.json`);
  ST._reset(tmp);
  const items = S.normaliseBatch([{ page: "/", elementId: "sec0002", note: "gold button" }]).items;
  const a = ST.createBatch({ siteId: "s1", repo: "org/repo", reviewer: "Dee", sessionSig: "sig1", items, idempotencyKey: "k1" });
  ok("creates a batch", !!a.batch.id && a.duplicate === false);
  eq("gives every item an id", a.batch.items.filter((i) => i.id).length, 1);

  const again = ST.createBatch({ siteId: "s1", repo: "org/repo", reviewer: "Dee", sessionSig: "sig1", items, idempotencyKey: "k1" });
  ok("a resubmitted batch is the same batch", again.duplicate === true && again.batch.id === a.batch.id);

  ST.updateItems(a.batch.id, { [a.batch.items[0].id]: { status: "live", detail: "done" } });
  eq("records item outcomes", ST.getBatch(a.batch.id).items[0].status, "live");

  ST.updateBatch(a.batch.id, { prUrl: "https://x/pr/1", status: "done" });
  eq("records the pr", ST.getBatch(a.batch.id).prUrl, "https://x/pr/1");

  ok("locks a repo", ST.acquireRepoLock("org/repo", a.batch.id) === true);
  ok("refuses a second holder", ST.acquireRepoLock("org/repo", "other") === false);
  ok("is re-entrant for the holder", ST.acquireRepoLock("org/repo", a.batch.id) === true);
  ST.releaseRepoLock("org/repo", a.batch.id);
  ok("frees the lock", ST.acquireRepoLock("org/repo", "other") === true);
  ST.releaseRepoLock("org/repo", "other");

  eq("lists a session's batches", ST.batchesForSession("sig1").length, 1);
  ok("survives a reload", (ST._reset(tmp), ST.getBatch(a.batch.id) !== null));
  try { fs.unlinkSync(tmp); } catch (e) { /* fine */ }
}

// ---- patch with a stubbed model ---------------------------------------------
console.log("\npatch (model)");
{
  (async () => {
    const before = '<section class="hero"><h1>Welcome</h1><a class="c-btn" href="/book">Book a Visit</a></section>';
    const good = async () => JSON.stringify({
      html: before.replace('class="c-btn"', 'class="c-btn c-btn--gold"'),
      css: ".elementor-element-sec0002 .c-btn--gold{background:gold}",
      addressed: ["i1"], notes: "",
    });
    const r1 = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: good });
    ok("applies a model patch", r1.html.includes("c-btn--gold") && r1.verdicts[0].ok === true);
    ok("keeps scoped css", r1.css.includes(".elementor-element-sec0002"));

    const unscoped = async () => JSON.stringify({
      html: before.replace('class="c-btn"', 'class="c-btn c-btn--gold"'),
      css: ".c-btn--gold{background:gold}", addressed: ["i1"], notes: "",
    });
    const r2 = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: unscoped });
    ok("confines the model's css instead of dropping it", r2.css.includes(".elementor-element-sec0002 .c-btn--gold"));
    ok("says so", /confined to this section/.test(r2.modelNotes));

    const reaching = async () => JSON.stringify({
      html: before.replace('class="c-btn"', 'class="c-btn c-btn--gold"'),
      css: "body{background:gold}", addressed: ["i1"], notes: "",
    });
    const r2b = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: reaching });
    eq("drops css that cannot be confined", r2b.css, "");
    ok("and says why", /dropped/.test(r2b.modelNotes));

    const injects = async () => JSON.stringify({ html: before + "<script>x()</script>", css: "", addressed: ["i1"] });
    const r3 = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: injects });
    eq("refuses an injected script and keeps the original", r3.html, before);
    ok("reports why", r3.verdicts[0].ok === false && /script/.test(r3.verdicts[0].reason));

    const idle = async () => JSON.stringify({ html: before, css: "", addressed: ["i1"] });
    const r4 = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: idle });
    ok("refuses a no-op rewrite", r4.verdicts[0].ok === false);

    // CSS-only: the markup is untouched and that is correct.
    const cssOnly = async () => JSON.stringify({ html: before, css: ".c-btn{margin-top:2rem}", addressed: ["i1"] });
    const r4b = await P.patchSection({ html: before, items: [item()], containerId: "sec0002", page: "/", ai: cssOnly });
    ok("accepts a css-only change", r4b.verdicts[0].ok === true);
    ok("and confines its css", r4b.css.includes(".elementor-element-sec0002 .c-btn"));

    // a link note never reaches the model
    let called = false;
    const spy = async () => { called = true; return "{}"; };
    const r5 = await P.patchSection({
      html: '<div><a href="/old">Book Now</a></div>',
      items: [item({ note: "this should point to /contact", target: { tag: "a", text: "Book Now" } })],
      containerId: "sec0002", page: "/", ai: spy,
    });
    ok("a link change skips the model", called === false && r5.usedModel === false);
    ok("and lands", r5.html.includes('href="/contact"'));

    // ---- the run ------------------------------------------------------------
    console.log("\nrun");
    {
      const doc = {
        elements: [{ id: "a", elType: "container", settings: {}, elements: [{ id: "w", elType: "widget", widgetType: "html", settings: { html: "<section>hi</section>" }, elements: [] }] }],
        document_settings: { custom_css: "body{margin:0}" },
      };
      const html = RUN.pageHtmlFromDoc(doc);
      ok("assembles a page from its html widgets", html.includes("<section>hi</section>"));
      ok("carries the page css", html.includes("body{margin:0}"));
      const body = RUN.prBody({ reviewer: "Dee", applied: [{ item: { page: "/", elementId: "a1", note: "gold" } }], refused: [], batchId: "fb-1", siteName: "X" });
      ok("the pr body lists what was applied", /Applied \(1\)/.test(body) && /gold/.test(body));
      const body2 = RUN.prBody({ reviewer: "Dee", applied: [], refused: [{ item: { page: "/", elementId: "a1", note: "x" }, reason: "section is gone" }], batchId: "fb-1" });
      ok("and what was refused, with the reason", /Not applied \(1\)/.test(body2) && /section is gone/.test(body2));

      // end to end against the fixture, with a stubbed model
      const root = fixture();
      const items = S.normaliseBatch([
        { page: "/", elementId: "sec0002", note: "make the button gold", target: { tag: "a", text: "Book a Visit" } },
        { page: "/", elementId: "sec0001", note: "this link should point to /contact", target: { tag: "a", text: "Book Now" } },
        { page: "/", elementId: "ghost99", note: "on a section that is gone", target: { tag: "p", text: "x" } },
      ]).items;
      const ai = async () => JSON.stringify({
        html: '<section class="hero"><h1>Welcome</h1><img src="/a.jpg"><a class="c-btn c-btn--gold" href="/book">Book a Visit</a></section>',
        css: ".elementor-element-sec0002 .c-btn--gold{background:gold}",
        addressed: ["i1"], notes: "",
      });
      const out = await RUN.applyNotes({ root, items, ai, log: () => {} });
      eq("applies what it can", out.applied.length, 2);
      eq("refuses what it cannot", out.refused.length, 1);
      ok("names the missing section", /no longer on the page/.test(out.refused[0].reason));
      eq("touches one file", out.filesTouched.length, 1);

      const after = G.readJson(path.join(root, "resources/pages/home/elementor.json"));
      ok("wrote the model's html", after.elements[1].elements[0].settings.html.includes("c-btn--gold"));
      ok("wrote the deterministic link", after.elements[0].elements[0].settings.html.includes('href="/contact"'));
      ok("scoped css landed on the page", (after.document_settings.custom_css || "").includes(".elementor-element-sec0002"));
      ok("kept the page's existing css", (after.document_settings.custom_css || "").includes("body{margin:0}"));
      ok("left the untouched section alone", after.elements[2].elements[1].settings.html === "<p>x</p>");

      // a second batch on the same section replaces its css block rather than stacking
      const items2 = S.normaliseBatch([{ page: "/", elementId: "sec0002", note: "make it bigger", target: { tag: "a", text: "Book a Visit" } }]).items;
      const ai2 = async () => JSON.stringify({
        html: '<section class="hero"><h1>Welcome</h1><img src="/a.jpg"><a class="c-btn c-btn--big" href="/book">Book a Visit</a></section>',
        css: ".elementor-element-sec0002 .c-btn--big{font-size:2rem}", addressed: ["i1"], notes: "",
      });
      await RUN.applyNotes({ root, items: items2, ai: ai2, log: () => {} });
      const after2 = G.readJson(path.join(root, "resources/pages/home/elementor.json"));
      const cssNow = after2.document_settings.custom_css || "";
      eq("one css block per section, not a stack", (cssNow.match(/g99 feedback: sec0002/g) || []).length, 1);
      ok("the newer rule is the one kept", cssNow.includes("c-btn--big") && !cssNow.includes("c-btn--gold"));

      fs.rmSync(root, { recursive: true, force: true });
    }

    // ---- the render gate ----------------------------------------------------
    // judge() is the pure half of visualCheck — the half that decides whether a
    // rendered page is broken. Testable without a browser, and worth testing:
    // it is the only thing standing where a human approving the PR would be.
    console.log("\nvisual gate");
    {
      const VIS = require("./lib/feedback/visualCheck");
      const healthy = { docHeight: 3000, scrollWidth: 1440, clientWidth: 1440, textLength: 2000, images: 6, brokenImages: 0, zeroHeightSections: 0 };
      ok("passes a healthy page", VIS.judge(healthy, null).ok);
      ok("fails a blank page", !VIS.judge({ ...healthy, textLength: 5, docHeight: 40 }, null).ok);
      ok("fails sideways scroll", !VIS.judge({ ...healthy, scrollWidth: 1800 }, null).ok);
      ok("fails a collapsed section", !VIS.judge({ ...healthy, zeroHeightSections: 2 }, null).ok);
      ok("fails a broken image", !VIS.judge({ ...healthy, brokenImages: 1 }, null).ok);
      ok("fails a page that lost half its height", !VIS.judge({ ...healthy, docHeight: 1000 }, healthy).ok);
      ok("fails a page that doubled", !VIS.judge({ ...healthy, docHeight: 7000 }, healthy).ok);
      ok("fails a page that lost its text", !VIS.judge({ ...healthy, textLength: 500 }, healthy).ok);
      // Sideways scroll the site already had is the site's problem, not the patch's.
      ok("ignores overflow that was already there",
        VIS.judge({ ...healthy, scrollWidth: 1800 }, { ...healthy, scrollWidth: 1800 }).ok);
      ok("reports nothing rendered at all", !VIS.judge(null, null).ok);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

// ---- image swap (appended: attachments) --------------------------------------
// Run separately from the async block above; these are pure functions.
{
  const P2 = require("./lib/feedback/patch");
  const S2 = require("./lib/feedback/schema");
  const U2 = require("./lib/feedback/upload");
  console.log("\nimage attachments");

  const html = '<section><img src="https://ruma.com/a.jpg" srcset="https://ruma.com/a-2x.jpg 2x" alt="Reception"><p>hi</p></section>';
  const r = P2.swapImage(html, { imageUrl: "https://tool.test/feedback-uploads/new.png", target: { tag: "img", attrs: { src: "https://ruma.com/a.jpg" } } });
  ok("points the image at the uploaded file", !!r && r.html.includes("new.png"));
  ok("drops srcset so the old picture cannot win", !!r && !/srcset/i.test(r.html));
  ok("keeps the alt text", !!r && r.html.includes('alt="Reception"'));
  ok("leaves the rest of the section alone", !!r && r.html.includes("<p>hi</p>"));

  // data-src must NOT be mistaken for src — the regex lost its word boundary
  // once (a heredoc turned \b into a literal backspace) and this is the case
  // that would have shipped silently.
  const lazy = '<section><img data-src="/lazy.jpg" src="/real.jpg"></section>';
  const r2 = P2.swapImage(lazy, { imageUrl: "https://tool.test/x.png", target: { tag: "img", attrs: { src: "/real.jpg" } } });
  ok("rewrites src, not data-src", !!r2 && r2.html.includes('src="https://tool.test/x.png"') && r2.html.includes('data-src="/lazy.jpg"'));

  ok("refuses an ambiguous section",
    P2.swapImage('<section><img src="/a.jpg"><img src="/b.jpg"></section>', { imageUrl: "https://t/x.png", target: { tag: "div" } }) === null);
  ok("swaps the only image even when the click missed it",
    !!P2.swapImage('<section><img src="/a.jpg"><p>x</p></section>', { imageUrl: "https://t/x.png", target: { tag: "section" } }));
  ok("refuses a non-http url", P2.swapImage(html, { imageUrl: "javascript:alert(1)", target: { tag: "img" } }) === null);

  // an attached picture routes through the deterministic path, never the model
  const det = P2.deterministicEdit(html, { imageUrl: "https://tool.test/x.png", note: "swap this", target: { tag: "img", attrs: { src: "https://ruma.com/a.jpg" } } });
  ok("an attachment is applied without a model", !!det && det.what === "image replaced");

  // contract
  ok("accepts a real png", !!S2.normaliseImage({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", filename: "x.png" }));
  ok("refuses a remote url", S2.normaliseImage({ dataUrl: "https://evil.test/x.png" }) === null);
  ok("refuses svg (it can carry script)", S2.normaliseImage({ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }) === null);
  ok("strips path characters from the filename",
    S2.normaliseImage({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", filename: "../../etc/passwd.png" }).filename.indexOf("/") === -1);

  // the store trusts bytes, not the declared type
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  ok("sniffs a png", (U2.sniff(png) || {}).ext === "png");
  ok("refuses bytes that are not an image", U2.sniff(Buffer.from("not an image at all")) === null);
  const stored = U2.store({ dataUrl: "data:image/png;base64," + png.toString("base64"), filename: "hero.png" }, "https://tool.test");
  ok("stores and returns a public url", !!stored && /^https:\/\/tool\.test\/feedback-uploads\/.+\.png$/.test(stored.url));
  if (stored) { try { fs.unlinkSync(stored.file); } catch (e) { /* fine */ } }
  ok("refuses a file whose bytes are not an image",
    U2.store({ dataUrl: "data:image/png;base64," + Buffer.from("nope").toString("base64"), filename: "x.png" }, "https://t") === null);
}
