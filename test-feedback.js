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
const SCOPE = require("./lib/feedback/scope");
const INTENT = require("./lib/feedback/intent");
const STRUCT = require("./lib/feedback/structure");
const IMG = require("./lib/feedback/image");
const WR = require("./lib/feedback/writers");
const AI = require("./lib/feedback/intentAI");
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


// ---- scope gate --------------------------------------------------------------
// Both directions matter equally. A request wrongly refused costs one rephrase;
// a request wrongly accepted gets quietly reinterpreted and reported as done,
// which is what this gate exists to stop.
{
  const refuses = (label, note, kind) => {
    const v = SCOPE.outOfScope(note);
    ok("refuses " + label, !!v && v.kind === kind);
  };
  const allows = (label, note) => ok("allows " + label, SCOPE.outOfScope(note) === null);

  // The note from PR #114, which was carried out as something else entirely.
  refuses("a new section above a container",
    "Add another section above this container where we show testimonials", "structure:add");
  refuses("a new band between two", "insert a new band between these two", "structure:add");
  refuses("reordering", "Move this section above the hero", "structure:move");
  refuses("deleting a whole section", "Delete this whole section", "structure:remove");
  refuses("a new page", "Create a new page for pricing", "page:new");
  refuses("nav edits", "the main menu should say Services", "nav");
  refuses("metadata", "update the meta description for this page", "seo");
  refuses("a site-wide change", "Make this button red on all pages", "global");

  // Everything below is squarely in scope and must not be caught.
  allows("a colour change", "Make button color to red");
  allows("adding content inside a section", "Add a testimonial quote in this block");
  allows("removing one element", "remove this button");
  allows("a link change", "point this link at /contact");
  // "header" is not a nav word: this is an ordinary section edit.
  allows("header text", "make the header text bigger");
  // Nor is a bare "menu" — a services menu rendered as text is section content.
  allows("the word menu as content", "This section needs a menu of services listed as text");

  const part = SCOPE.partition([
    { localId: "i1", note: "Make button color to red" },
    { localId: "i2", note: "Add a new section below this" },
  ]);
  eq("partition keeps what it can do", part.keep.length, 1);
  eq("partition turns down what it cannot", part.refuse.length, 1);
  ok("the refusal explains itself", /new section/.test(part.refuse[0].reason));
}


// ---- intent routing ----------------------------------------------------------
// The bug this replaces: everything was a section edit, so "add a section above
// this" was handed to the section rewriter, which put the content inside and
// reported it applied. Structural notes must now route, not be reinterpreted.
{
  const is = (label, note, kind, detail) => {
    const v = INTENT.classify(note);
    const got = v.kind === "structure" ? v.op + (v.position ? "/" + v.position : "")
              : v.kind === "refuse" ? v.why : "";
    ok(label, v.kind === kind && got === detail);
  };
  is("routes 'add a section above' to insert", "Add another section above this container", "structure", "insert/before");
  is("routes 'add a band below' to insert", "add a new band below this", "structure", "insert/after");
  is("routes deleting a section", "Delete this whole section", "structure", "remove");
  is("routes a move with a direction", "Move this section above the hero", "structure", "move/before");
  is("turns down a move with no direction", "move this section up", "refuse", "structure:move-vague");
  is("still refuses nav", "the main menu should say Services", "refuse", "nav");
  is("still refuses a new page", "Create a new page for pricing", "refuse", "page:new");

  // Section edits must stay section edits. "add" and "remove" alone are not
  // structural — they are the two most common things done INSIDE a section.
  is("a colour change is a section edit", "Make button color to red", "section", "");
  is("adding content is a section edit", "Add a testimonial quote in this block", "section", "");
  is("removing an element is a section edit", "remove this button", "section", "");

  const r = INTENT.route([
    { localId: "i1", note: "Make button color to red" },
    { localId: "i2", note: "Add a section below this" },
    { localId: "i3", note: "update the meta description" },
  ]);
  eq("route sorts section edits", r.section.length, 1);
  eq("route sorts structural notes", r.structure.length, 1);
  eq("route sorts refusals", r.refuse.length, 1);
}

// ---- structural operations ---------------------------------------------------
{
  const mk = () => ({ document_settings: {}, elements: ["a", "b", "c"].map((n) => ({
    id: "sec" + n, elType: "container", elements: [
      { id: "w" + n, elType: "widget", widgetType: "html", settings: { html: "<section>" + n + "</section>" }, elements: [] }],
  })) });
  const order = (d) => d.elements.map((e) => e.id).join(" ");

  // A note carries the WIDGET id, because that is what the DOM exposes.
  eq("finds a section by its widget id", STRUCT.sectionIndexOf(mk().elements, "wb"), 1);
  eq("finds a section by its container id", STRUCT.sectionIndexOf(mk().elements, "secb"), 1);

  {
    const d = mk(); const before = STRUCT.allIds(d.elements);
    const r = STRUCT.insertSection(d, { nearId: "wb", position: "before", html: "<section>new</section>" });
    ok("inserts before the clicked section", r.ok && order(d) === "seca " + r.sectionId + " secb secc");
    ok("the insert survives the node-set check",
      V.checkNodeSet(before, STRUCT.allIds(d.elements), { added: [r.sectionId, r.widgetId] }).ok);
  }
  {
    const d = mk();
    const r = STRUCT.insertSection(d, { nearId: "wb", position: "after", html: "<section>new</section>" });
    ok("inserts after the clicked section", r.ok && order(d) === "seca secb " + r.sectionId + " secc");
  }
  {
    const d = mk(); const before = STRUCT.allIds(d.elements);
    const r = STRUCT.removeSection(d, { id: "wb" });
    ok("removes the clicked section", r.ok && order(d) === "seca secc");
    ok("the removal survives the node-set check",
      V.checkNodeSet(before, STRUCT.allIds(d.elements), { removed: r.removedIds }).ok);
  }
  ok("will not empty the page",
    STRUCT.removeSection({ elements: [mk().elements[0]] }, { id: "wa" }).ok === false);
  {
    const d = mk(); const before = STRUCT.allIds(d.elements);
    // Moving to an earlier index: the naive version reads the target index
    // before lifting the node out and lands one place off.
    const r = STRUCT.moveSection(d, { id: "secc", nearId: "seca", position: "before" });
    ok("moves to the right position", r.ok && order(d) === "secc seca secb");
    ok("a move is allowed only when a reorder was intended",
      V.checkNodeSet(before, STRUCT.allIds(d.elements), { reordered: true }).ok
      && V.checkNodeSet(before, STRUCT.allIds(d.elements), {}).ok === false);
  }
  ok("leaves a page it does not recognise alone",
    STRUCT.insertSection({ elements: [{ id: "x", elType: "widget" }] },
      { nearId: "x", position: "after", html: "<section/>" }).ok === false);

  // The guard on its own.
  ok("catches a section lost silently", V.checkNodeSet(["a", "b", "c"], ["a", "c"], {}).ok === false);
  ok("catches a section added silently", V.checkNodeSet(["a", "b"], ["a", "b", "z"], {}).ok === false);
  ok("accepts an untouched page", V.checkNodeSet(["a", "b"], ["a", "b"], {}).ok);
}


// ---- F1: moving to a section the reviewer named ------------------------------
{
  const named = (note, pos, target) => {
    const v = INTENT.classify(note);
    ok("reads " + JSON.stringify(target) + " out of the note",
      v.kind === "structure" && v.op === "move" && v.position === pos && v.target === target);
  };
  named("Move this section above the pricing section", "before", "pricing");
  named("move this block below the testimonials", "after", "testimonials");
  // No landmark named: still a move, just a one-position one.
  named("Move this section above", "before", "");
}

// ---- F2: adding an image where the section has none ---------------------------
{
  const URL = "https://tool.test/feedback-uploads/photo.png";
  const wrap = '<section class="u-band"><div class="u-wrap"><h2>Team</h2></div></section>';
  const r = IMG.insertImage(wrap, URL);
  ok("adds an image to a section that has none", !!r && r.html.includes(URL));
  ok("puts it inside the wrapper, not after the section",
    !!r && r.html.indexOf("<img") < r.html.indexOf("</div></section>"));
  // The wrapper's own closing tag, not the first one that happens to come along.
  const nested = '<section><div class="u-wrap"><div class="u-split"><div><p>A</p></div></div></div></section>';
  const r2 = IMG.insertImage(nested, URL);
  ok("closes the outer wrapper, not an inner div",
    !!r2 && r2.html.indexOf("<img") > r2.html.indexOf("<p>A</p>")
         && r2.html.indexOf("<img") < r2.html.lastIndexOf("</div>"));
  ok("refuses a url that is not http", IMG.insertImage(wrap, "javascript:alert(1)") === null);
}

// ---- F3: reading a note with a model, keywords as the floor ------------------
{
  const t = (label, reply, want) => AI.classify("anything", { ai: async () => reply })
    .then((v) => ok(label, v.kind === want));
  // Everything below is synchronous in effect: the stub resolves immediately.
  const seen = [];
  const check = (label, reply, want) => {
    AI.classify("Move this section above the hero", { ai: async () => reply })
      .then((v) => seen.push([label, v.kind === want]));
  };
  check("takes a well-formed answer", '{"kind":"sitecss"}', "sitecss");
  check("falls back when the model invents a kind", '{"kind":"teleport"}', "structure");
  check("falls back on unparseable prose", "I think this is a move?", "structure");
  check("falls back when a move names no side", '{"kind":"structure","op":"move"}', "structure");
  setTimeout(() => { for (const [l, o] of seen) ok(l, o); }, 0);
}

// ---- F4 / F7 / F8: the writers ----------------------------------------------
{
  const os = require("os"), fs2 = require("fs"), path2 = require("path");
  const root = fs2.mkdtempSync(path2.join(os.tmpdir(), "g99w-"));
  fs2.mkdirSync(path2.join(root, "resources", "pages", "home"), { recursive: true });
  fs2.writeFileSync(path2.join(root, "resources", "pages", "home", "seo.json"),
    JSON.stringify({ schema_version: 1, provider: "rank_math", fields: { rank_math_title: "T", rank_math_description: "D" } }));
  // A donor page. createPage copies the chrome from one, because on these sites
  // there is no shared template: each page carries its own stylesheet, nav and
  // footer inline. A page written without them is an unstyled fragment.
  const sec = (id, html) => ({ id, elType: "container", settings: {},
    elements: [{ id: id + "w", elType: "widget", widgetType: "html", settings: { html }, elements: [] }] });
  fs2.writeFileSync(path2.join(root, "resources", "pages", "home", "elementor.json"),
    JSON.stringify({ schema_version: 1, elementor_version: "3",
      document_settings: { custom_css: ".c-btn{color:red}" },
      elements: [
        sec("aaa1111", '<div hidden data-g99-css><style>.a{color:red}</style></div>'),
        sec("bbb2222", '<nav class="c-nav"><a href="/">Home</a></nav>'),
        sec("ccc3333", '<section><h2>Hello</h2></section>'),
        sec("ddd4444", '<footer class="c-foot">Footer</footer>'),
      ] }));

  // F4 — the carrier is identified by its attribute, not by being first.
  const carrier = '<div hidden data-g99-css><style>.a{color:red}</style></div>';
  const w1 = WR.writeSiteCss(carrier, ".c-btn{border-radius:999px}");
  ok("writes site css into the carrier", !!w1 && w1.html.includes("border-radius:999px"));
  ok("keeps the rules that were already there", !!w1 && w1.html.includes(".a{color:red}"));
  const w2 = WR.writeSiteCss(w1.html, ".c-btn{border-radius:4px}");
  ok("a second run replaces its own block rather than stacking",
    !!w2 && !w2.html.includes("999px") && w2.html.includes("4px")
         && (w2.html.match(/g99 feedback: site-wide/g) || []).length === 1);
  ok("refuses a section that is not the carrier",
    WR.writeSiteCss("<section><h2>Hi</h2></section>", ".x{color:red}") === null);

  // F7
  const s1 = WR.writeSeo(root, "home", { description: "New description." });
  ok("writes the meta description", s1.ok && s1.changed.includes("description"));
  eq("and it lands in the file",
    JSON.parse(fs2.readFileSync(path2.join(root, "resources", "pages", "home", "seo.json"), "utf8")).fields.rank_math_description,
    "New description.");
  ok("says so when the note names neither field", WR.writeSeo(root, "home", {}).ok === false);
  ok("says so when the page has no seo file", WR.writeSeo(root, "nowhere", { title: "x" }).ok === false);

  // F8
  const p1 = WR.createPage(root, { title: "Pricing", html: "<section><h2>Pricing</h2></section>" });
  ok("creates a page", p1.ok && p1.slug === "pricing");
  ok("with all three of its files", p1.ok && p1.files.length === 3
    && p1.files.every((f) => fs2.existsSync(path2.join(root, f))));
  // The chrome question: a page with only its content section renders as
  // unstyled text with no way in and no way out. Seen live.
  const made = JSON.parse(fs2.readFileSync(path2.join(root, "resources", "pages", "pricing", "elementor.json"), "utf8"));
  const htmlOf = (e) => (e.elements[0].settings.html || "");
  ok("carries the stylesheet carrier", made.elements.some((e) => /data-g99-css/.test(htmlOf(e))));
  ok("carries the navigation", made.elements.some((e) => /<nav\b/.test(htmlOf(e))));
  ok("carries the footer", made.elements.some((e) => /<footer\b/.test(htmlOf(e))));
  ok("puts the content between them", /Pricing/.test(htmlOf(made.elements[2])));
  ok("brings the page stylesheet with it", (made.document_settings.custom_css || "").includes(".c-btn"));
  // Ids must not be shared: two pages holding one id gives the reconciler two
  // homes for the same node.
  const donor = JSON.parse(fs2.readFileSync(path2.join(root, "resources", "pages", "home", "elementor.json"), "utf8"));
  ok("regenerates ids rather than copying them",
    !made.elements.some((e) => donor.elements.some((d) => d.id === e.id)));
  const p2 = WR.createPage(root, { title: "Pricing", html: "<section><h2>Again</h2></section>" });
  ok("does not overwrite a page that already exists", p2.ok && p2.slug === "pricing-2");
  ok("refuses a page with no title", WR.createPage(root, { title: "", html: "<section/>" }).ok === false);
  ok("refuses a reserved address", WR.freeSlug(root, "wp-admin") === "");
  try { fs2.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ }
}


// ---- a removal that names a section ------------------------------------------
// Twice on a live site, "Remove our services section" removed a different
// section, because the code read the click and ignored the words. The words are
// the more deliberate signal: a cursor lands somewhere, a sentence is typed.
{
  const t = (label, note, target) => {
    const v = INTENT.classify(note);
    ok(label, v.kind === "structure" && v.op === "remove" && (v.target || "") === target);
  };
  t("reads the section a removal names", "Remove our services section", "services");
  t("reads it past a determiner", "remove the pricing band", "pricing");
  t("reads it from other phrasings", "get rid of the testimonials section", "testimonials");
  // "this" points at the click, and that stays the click's case.
  t("leaves 'this section' to the click", "Delete this whole section", "");
  t("and the note that started all this", "Remove this section. This is lookg pathetic", "");
}


// ---- the three things PR #130 got wrong on a live site -----------------------
// One batch of notes removed two sections when it had been asked for one, named
// a section in the report that the reviewer had never clicked, and read "don't
// remove clinical excellence" as an instruction to remove it. Each of those is
// a separate mistake with a separate cause, so each gets its own test.

// A container holding two html widgets. This is the shape the code assumed could
// not exist, taken from the page where it did: c076a1e held both the services
// band and the one below it.
function twoInOne() {
  return {
    elements: [
      { id: "aaa0001", elType: "container", settings: {}, elements: [
        { id: "w0", elType: "widget", widgetType: "html", settings: { html: '<section><p class="u-eyebrow">Hero</p></section>' }, elements: [] },
      ]},
      { id: "c076a1e", elType: "container", settings: {}, elements: [
        { id: "5c36517", elType: "widget", widgetType: "html", settings: { html: '<section><p class="u-eyebrow">Our Services</p><h2>What we do</h2></section>' }, elements: [] },
        { id: "686470c", elType: "widget", widgetType: "html", settings: { html: '<section><h2>TRUE BEAUTY STARTS FROM WITHIN</h2></section>' }, elements: [] },
      ]},
      { id: "aaa0002", elType: "container", settings: {}, elements: [
        { id: "w2", elType: "widget", widgetType: "html", settings: { html: '<section><p class="u-eyebrow">Testimonials</p></section>' }, elements: [] },
      ]},
    ],
  };
}

{
  const doc = twoInOne();
  ok("counts sections a reviewer can see, not containers",
    doc.elements.reduce((n, c) => n + STRUCT.widgetsIn(c).length, 0) === 4);
  ok("finds the widget an id belongs to",
    (STRUCT.widgetFor(doc.elements, "686470c") || {}).id === "686470c");

  const out = STRUCT.removeSection(doc, { id: "5c36517" });
  ok("removes one section, not the container", out.ok === true);
  ok("its neighbour in the same container survives",
    !!STRUCT.widgetFor(doc.elements, "686470c"));
  ok("and the removed one is gone",
    !STRUCT.widgetFor(doc.elements, "5c36517"));
  ok("the container stays, still holding the survivor",
    doc.elements.length === 3 && doc.elements[1].elements.length === 1);
}

{
  // The container is only removed when taking the widget would empty it.
  const doc = twoInOne();
  STRUCT.removeSection(doc, { id: "w2" });
  ok("an empty container goes with its only section", doc.elements.length === 2);
}

{
  // Bug C: a sentence that forbids a removal is not a removal.
  const kind = (n) => { const v = INTENT.classify(n); return v.kind + (v.op ? "/" + v.op : ""); };
  ok("'but dont remove X' is not a removal",
    kind("add testimonials section. but dont remove clinical excellence") !== "structure/remove");
  ok("nor is 'without removing'",
    kind("please add a section above, without removing the hero") !== "structure/remove");
  ok("a real removal still reads as one",
    kind("remove the our services section") === "structure/remove");
  ok("even alongside a negated one",
    kind("delete the pricing band, do not remove anything else") === "structure/remove");
  ok("the mask leaves the note itself alone",
    INTENT.maskNegations("dont remove the hero").indexOf("hero") > -1);
}

// Bug A: the model may not talk the pipeline into a removal on its own.
(async () => {
  const says = (o) => async () => JSON.stringify(o);
  const removeAll = says({ kind: "structure", op: "remove", target: "Our Services" });

  const a = await AI.classify("Remove this card", { ai: removeAll });
  ok("a card is not a section, whatever the model says", a.kind === "section");

  const b = await AI.classify("add testimonials section. but dont remove clinical excellence", { ai: removeAll });
  ok("nor is a note that forbids removing", b.kind === "section");

  const c = await AI.classify("remove the our services section", { ai: says({ kind: "structure", op: "remove", target: "" }) });
  ok("a removal the words agree with still goes through", c.kind === "structure" && c.op === "remove");
  ok("and keeps the target the words found", c.target === "services");
})();

// ---- one vocabulary for "this note changes what is there" -------------------
// patch.js kept its own word list for deciding whether the element counts may
// move, and the two lists disagreed. "Take the photo out from the bottom of
// this section" was carried out correctly and then rejected for dropping an
// <img> "the feedback did not ask to remove" — a sentence the reviewer cannot
// act on, about their own words.
{
  const asks = (n) => INTENT.asksForStructure(n);
  ok("reads a split verb", asks("Take the photo out from the bottom of this section"));
  ok("and the plain ones", asks("remove the our services section") && asks("get rid of the testimonials"));
  ok("and an addition", asks("add another card saying botox"));
  ok("and a replacement", asks("replace this image with the one attached"));
  // Styling notes must NOT unlock it, or a rewrite may quietly drop content.
  ok("a colour note does not", !asks("change the button colour to navy"));
  ok("nor a spacing note", !asks("give this heading more space above it"));
  // Negation is masked here too: permission comes from what was asked for.
  ok("a forbidden removal grants nothing", !asks("dont remove the hero, just recolour it"));
  ok("nor does 'without removing'", !asks("without removing anything, make the text darker"));

  // The guard is looser than the classifier ON PURPOSE. The classifier picks an
  // operation and can take a whole band off a live page; this only unlocks a
  // check on markup a model already wrote. So the same sentence reads as a
  // section edit and still allows the counts to move.
  const v = INTENT.classify("Take the photo out from the bottom of this section — keep the three cards as they are.");
  ok("the same note is still a section edit, not a removal", v.kind === "section");
}

// ---- the note #137 refused, put back through the checker --------------------
// Not a test of the word list — a test of the failure it caused. The model's
// rewrite was correct and the guard threw it away, so the shape below is the
// one that actually shipped: a band of cards with one picture under them, and a
// note asking for that picture to go.
{
  const before = '<section class="g99-sec u-band"><div class="u-wrap">'
    + '<span class="u-eyebrow">Curated Therapies</span><h2>Featured Medical Service</h2>'
    + '<div class="u-grid"><div class="c-card"><h3>One</h3><a href="/a/">Learn</a></div>'
    + '<div class="c-card"><h3>Two</h3><a href="/b/">Learn</a></div>'
    + '<div class="c-card"><h3>Three</h3><a href="/c/">Learn</a></div></div>'
    + '<img src="https://tool.example/feedback-uploads/x.jpg" alt="" loading="lazy">'
    + '</div></section>';
  const after = before.replace(/<img\b[^>]*>/i, "");
  const note = "Take the photo out from the bottom of this section — keep the three cards as they are.";

  // What #137 ran: patch.js's own list, which had never heard of "take it out".
  const oldList = /\b(remove|delete|drop|add|insert|extra|another|duplicate|reorder|move|swap|split|merge)\b/i;
  const wasRefused = V.checkHtml(before, after, { allowStructural: oldList.test(note) });
  ok("the old word list refused a note that asked for exactly this",
    !wasRefused.ok && /did not ask to remove/.test(wasRefused.reason || ""), wasRefused.reason);

  const now = V.checkHtml(before, after, { allowStructural: INTENT.asksForStructure(note) });
  ok("the shared vocabulary lets it through", now.ok === true, now.reason);

  // And the guard still holds where it should: the same rewrite, from a note
  // that only asked about colour, is still a picture disappearing unasked.
  const styling = V.checkHtml(before, after,
    { allowStructural: INTENT.asksForStructure("make the card headings navy") });
  ok("a styling note still may not drop a picture", styling.ok === false);
}
