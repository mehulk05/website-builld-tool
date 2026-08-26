// Self-test for the GitOps JSON virtual-file layer.
//   node test-gitops-json.js            — runs against a synthetic fixture
//   node test-gitops-json.js <repoRoot> — also round-trips a real site checkout
//
// Nothing here talks to the network, GitHub or an AI. The point is the one thing
// that must never go wrong: a text view written back into JSON changes exactly
// what the text changed, and nothing else.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("./gitops-json");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function throws(name, fn) {
  try { fn(); ok(name, false, "did not throw"); }
  catch (e) { ok(name, true); }
}

// ---- fixture ---------------------------------------------------------------
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gj-"));
  const res = path.join(root, "resources");
  const page = path.join(res, "pages", "home");
  fs.mkdirSync(page, { recursive: true });
  fs.writeFileSync(path.join(res, "site.json"), JSON.stringify({
    schema_version: 1, blogname: "Old Name", blogdescription: "Old tagline",
  }, null, 4));
  fs.writeFileSync(path.join(res, "menus.json"), JSON.stringify({
    schema_version: 1,
    menus: [{ slug: "main", items: [{ source_id: 1, title: "Home" }, { source_id: 2, title: "Services" }] }],
  }, null, 4));
  fs.writeFileSync(path.join(page, "resource.json"), JSON.stringify({
    schema_version: 1, git_id: "page-home-13", type: "page", slug: "home", title: "Home", content: "",
  }, null, 4));
  fs.writeFileSync(path.join(page, "seo.json"), JSON.stringify({
    schema_version: 1, provider: "rank_math",
    fields: { rank_math_title: "Old Title", rank_math_description: "Old description." },
  }, null, 4));
  fs.writeFileSync(path.join(page, "elementor.json"), JSON.stringify({
    schema_version: 1, elementor_version: "3",
    document_settings: { custom_css: ".hero{color:red}" },
    elements: [
      { id: "aaa1111", elType: "container", settings: { padding: "20px" }, elements: [
        { id: "bbb2222", elType: "widget", widgetType: "html", settings: { html: "<h1>Old Headline</h1>" }, elements: [] },
      ] },
      { id: "ccc3333", elType: "container", settings: {}, elements: [
        { id: "ddd4444", elType: "widget", widgetType: "heading", settings: { title: "Our Services", align: "center", header_size: "h2" }, elements: [] },
        { id: "eee5555", elType: "widget", widgetType: "icon-list", settings: {
          icon_list: [{ text: "First item", _id: "x1" }, { text: "Second item", _id: "x2" }],
        }, elements: [] },
      ] },
    ],
  }, null, 4));
  return root;
}

const root = fixture();
const DOC = "resources/pages/home/elementor.json" + G.SEP + "doc";
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

console.log("\ndiscovery");
ok("isGitopsRoot true for a resources tree", G.isGitopsRoot(root));
ok("isGitopsRoot false for anything else", !G.isGitopsRoot(path.join(root, "resources")));

console.log("\nexpandResources");
{
  const { manifest, source } = G.expandResources(root, { prompt: "change the headline" });
  const paths = manifest.map((m) => m.path);
  ok("offers the page doc", paths.includes(DOC));
  ok("offers the page css", paths.includes("resources/pages/home/elementor.json" + G.SEP + "css"));
  ok("offers seo", paths.includes("resources/pages/home/seo.json" + G.SEP + "seo"));
  ok("offers menus", paths.includes("resources/menus.json" + G.SEP + "doc"));
  ok("skips empty values", !paths.includes("resources/pages/home/resource.json" + G.SEP + "content"));
  ok("every offered path is readable", source.every((f) => f.content && f.content.length));
  ok("all paths sit under resources/", paths.every((p) => p.startsWith("resources/")));
}

console.log("\ndoc view");
{
  const view = G.readVirtual(root, DOC);
  eq("one marker per editable string", (view.match(/<!--G99 /g) || []).length, 4);   // html + heading + 2 list rows
  ok("html widget value is present", view.includes("<h1>Old Headline</h1>"));
  ok("heading title is present", view.includes("Our Services"));
  ok("repeater rows are addressed by index", view.includes("icon_list.0.text") && view.includes("icon_list.1.text"));
  ok("layout settings are not exposed", !view.includes("header_size") && !view.includes("padding"));
}

console.log("\nwriteback: the ordinary case");
{
  let view = G.readVirtual(root, DOC);
  view = view.replace("<h1>Old Headline</h1>", "<h1>New Headline</h1>");
  const rep = G.writeVirtual(root, DOC, view);
  eq("one value updated", rep.updated, 1);
  eq("nothing added", rep.added, 0);
  eq("no unknown markers", rep.unknown.length, 0);
  const j = readJson("resources/pages/home/elementor.json");
  eq("the html changed", j.elements[0].elements[0].settings.html, "<h1>New Headline</h1>");
  eq("a sibling did not", j.elements[1].elements[0].settings.title, "Our Services");
  eq("layout settings survived", j.elements[0].settings.padding, "20px");
  eq("css survived", j.document_settings.custom_css, ".hero{color:red}");
  eq("schema_version survived", j.schema_version, 1);
}

console.log("\nwriteback: a repeater row");
{
  let view = G.readVirtual(root, DOC);
  view = view.replace("Second item", "Second thing");
  G.writeVirtual(root, DOC, view);
  const j = readJson("resources/pages/home/elementor.json");
  eq("row 1 changed", j.elements[1].elements[1].settings.icon_list[1].text, "Second thing");
  eq("row 0 did not", j.elements[1].elements[0] && j.elements[1].elements[1].settings.icon_list[0].text, "First item");
  eq("the row's own _id survived", j.elements[1].elements[1].settings.icon_list[1]._id, "x2");
}

console.log("\nwriteback: a partial view (model returns only what it changed)");
{
  const before = readJson("resources/pages/home/elementor.json");
  const rep = G.writeVirtual(root, DOC, "<!--G99 ddd4444 title-->Our Treatments<!--/G99 ddd4444-->");
  eq("only that one applied", rep.updated, 1);
  const after = readJson("resources/pages/home/elementor.json");
  eq("the named value changed", after.elements[1].elements[0].settings.title, "Our Treatments");
  eq("everything absent from the view was left alone",
    JSON.stringify(after.elements[0]), JSON.stringify(before.elements[0]));
}

console.log("\nwriteback: adding a section");
{
  const view = G.readVirtual(root, DOC);
  const withNew = view.replace(
    "<!--/G99 bbb2222-->",
    "<!--/G99 bbb2222-->\n\n<!--G99 new html--><section class=\"promo\">Spring offer</section><!--/G99 new-->");
  const rep = G.writeVirtual(root, DOC, withNew);
  eq("one section added", rep.added, 1);
  const j = readJson("resources/pages/home/elementor.json");
  eq("top-level blocks went from 2 to 3", j.elements.length, 3);
  eq("it landed after the block it followed", j.elements[1].elements[0].settings.html, "<section class=\"promo\">Spring offer</section>");
  ok("it is a real container holding an html widget",
    j.elements[1].elType === "container" && j.elements[1].elements[0].widgetType === "html" && !!j.elements[1].elements[0].id);
}

console.log("\nrefusals and guards");
{
  const view = G.readVirtual(root, DOC);
  throws("an unchanged view is refused rather than committed as an empty diff",
    () => G.writeVirtual(root, DOC, view));
  const rep = G.writeVirtual(root, DOC, view.replace("Our Treatments", "Our Care")
    + "\n\n<!--G99 nosuchid title-->invented<!--/G99 nosuchid-->");
  eq("the real edit still applied", rep.updated, 1);
  eq("the invented marker was reported, not written", rep.unknown.length, 1);
  throws("invalid JSON into a real .json file is refused",
    () => G.writeVirtual(root, "resources/site.json", "{ not json"));
  throws("an unknown resource is refused",
    () => G.writeVirtual(root, "resources/pages/home/nope.json" + G.SEP + "doc", "x"));
}

console.log("\nother views");
{
  const cssRel = "resources/pages/home/elementor.json" + G.SEP + "css";
  G.writeVirtual(root, cssRel, ".hero{color:blue}");
  eq("css writes through", readJson("resources/pages/home/elementor.json").document_settings.custom_css, ".hero{color:blue}");
  ok("css write left the elements alone", readJson("resources/pages/home/elementor.json").elements.length === 3);

  const seoRel = "resources/pages/home/seo.json" + G.SEP + "seo";
  let seo = G.readVirtual(root, seoRel);
  seo = seo.replace("Old Title", "New Title");
  G.writeVirtual(root, seoRel, seo);
  const sj = readJson("resources/pages/home/seo.json");
  eq("seo title changed", sj.fields.rank_math_title, "New Title");
  eq("seo description untouched", sj.fields.rank_math_description, "Old description.");
  eq("seo provider untouched", sj.provider, "rank_math");

  const menuRel = "resources/menus.json" + G.SEP + "doc";
  let menu = G.readVirtual(root, menuRel);
  menu = menu.replace(">Services<", ">Treatments<");
  G.writeVirtual(root, menuRel, menu);
  const mj = readJson("resources/menus.json");
  eq("menu label changed", mj.menus[0].items[1].title, "Treatments");
  eq("other label untouched", mj.menus[0].items[0].title, "Home");

  G.writeVirtual(root, "resources/site.json" + G.SEP + "blogname", "New Name");
  const st = readJson("resources/site.json");
  eq("blogname changed", st.blogname, "New Name");
  eq("blogdescription untouched", st.blogdescription, "Old tagline");

  G.writeVirtual(root, "resources/pages/home/resource.json" + G.SEP + "title", "Welcome");
  const rj = readJson("resources/pages/home/resource.json");
  eq("page title changed", rj.title, "Welcome");
  eq("git_id survived", rj.git_id, "page-home-13");
  eq("slug survived", rj.slug, "home");
}

console.log("\nformatting");
{
  const raw = fs.readFileSync(path.join(root, "resources/pages/home/seo.json"), "utf8");
  ok("4-space indented", raw.includes('\n    "provider"'));
  // The fixture was written the way the fleet exporter writes: no trailing
  // newline. A write must keep that, or every edit also touches the last line.
  ok("the file's trailing-newline convention is preserved", raw.endsWith("}") && !raw.endsWith("}\n"));
  {
    fs.mkdirSync(path.join(root, "resources", "nl"), { recursive: true });
    const withNl = path.join(root, "resources", "nl", "site.json");
    fs.writeFileSync(withNl, '{\n    "schema_version": 1,\n    "blogname": "x"\n}\n');
    G.writeVirtual(root, "resources/nl/site.json" + G.SEP + "blogname", "y");
    ok("a file that had a trailing newline keeps it", fs.readFileSync(withNl, "utf8").endsWith("}\n"));
  }
}

// ---- optional: a real checkout ----------------------------------------------
const realRoot = process.argv[2];
if (realRoot && G.isGitopsRoot(realRoot)) {
  console.log("\nreal checkout: " + realRoot);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gj-real-"));
  fs.cpSync(path.join(realRoot, "resources"), path.join(work, "resources"), { recursive: true });
  const { manifest, source } = G.expandResources(work, { prompt: "" });
  ok("something was found", manifest.length > 0);
  console.log(`       ${manifest.length} view(s), ${source.length} read`);
  let checked = 0, clean = 0;
  for (const f of source) {
    if (!f.rel.endsWith(G.SEP + "doc") || !f.rel.includes("elementor.json")) continue;
    checked++;
    const real = f.rel.split(G.SEP)[0];
    const before = fs.readFileSync(path.join(work, real), "utf8");
    // Re-rendering a view and writing it back unchanged must be refused, which
    // proves the round trip is lossless: every marker came back identical.
    try { G.writeVirtual(work, f.rel, f.content); }
    catch (e) { if (/nothing changed/.test(e.message)) clean++; }
    const after = fs.readFileSync(path.join(work, real), "utf8");
    if (before !== after) { fail++; console.log("  FAIL round trip modified " + real); }
  }
  eq("every real page round-trips losslessly", clean, checked);
  fs.rmSync(work, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
