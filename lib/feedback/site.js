// Changes that are not one section on one page.
//
// Site-wide styling, page metadata, the navigation, a new page. Each of these
// was refused for the same reason — nothing wrote to that part of the site — and
// each is small once the question of WHERE it lives is settled. Two of those
// answers were already in the repository and only had to be found:
//
//   Site-wide CSS   lives in the hidden <div data-g99-css><style> carrier that
//                   compile.js emits as the first section of every page. There
//                   was no need for a new mechanism, only for writing into the
//                   one the site already depends on.
//
//   Navigation      is inlined into every page's markup. menus.json exists and
//                   is empty; nothing reads it. So a menu change is a section
//                   edit applied to every page, and an adapter writing
//                   menus.json would have produced a file the site ignores.
//
// Everything here touches more than one page, which is why each operation
// reports how many pages it changed rather than a bare "done": "applied" on a
// site-wide change without a count hides whether it reached one page or twelve.
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("../../gitops-json");
const W = require("./writers");
const CSSW = require("./sitecss");

/** Every page slug in the repository, in a stable order. */
function pageSlugs(root) {
  const dir = path.join(root, "resources", "pages");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const pageFile = (root, slug) => path.join(root, "resources", "pages", slug, "elementor.json");

/** The html widget inside a container, if it has exactly the one. */
function widgetOf(container) {
  return ((container && container.elements) || [])
    .find((k) => k && k.elType === "widget" && k.settings && typeof k.settings.html === "string");
}

/**
 * Write a block of CSS into every page's stylesheet carrier.
 *
 * Applied per page rather than once, because each page carries its own copy of
 * the stylesheet. A page missing the carrier is skipped and counted, not failed:
 * a hand-built page that never had one should not stop the other eleven from
 * getting the change.
 */
function applySiteCss(root, css, log) {
  const touched = [];
  const skipped = [];
  for (const slug of pageSlugs(root)) {
    const abs = pageFile(root, slug);
    if (!fs.existsSync(abs)) continue;
    let doc;
    try { doc = G.readJson(abs); } catch (e) { skipped.push(slug); continue; }

    const carrier = (doc.elements || []).map(widgetOf).find((w) => w && W.isCssCarrier(w.settings.html));
    if (!carrier) { skipped.push(slug); continue; }

    const out = W.writeSiteCss(carrier.settings.html, css);
    if (!out) { skipped.push(slug); continue; }
    carrier.settings.html = out.html;
    G.writeJson(abs, doc);
    touched.push(`resources/pages/${slug}/elementor.json`);
  }
  if (skipped.length) log(`feedback: no stylesheet carrier on ${skipped.join(", ")}`);
  return { touched, skipped };
}

/**
 * Rewrite the navigation on every page.
 *
 * The nav is the same markup repeated per page, so it is rewritten once by the
 * model and then written to each copy. Rewriting each page separately would
 * spend a model call per page and, worse, could produce twelve slightly
 * different navigations.
 */
async function applyNav(root, note, ai, log) {
  const slugs = pageSlugs(root);
  let source = null;
  let sourceSlug = "";
  for (const slug of slugs) {
    const abs = pageFile(root, slug);
    if (!fs.existsSync(abs)) continue;
    let doc;
    try { doc = G.readJson(abs); } catch (e) { continue; }
    const nav = (doc.elements || []).map(widgetOf).find((w) => w && /<nav\b/i.test(w.settings.html));
    if (nav) { source = nav.settings.html; sourceSlug = slug; break; }
  }
  if (!source) return { ok: false, reason: "this site's pages do not carry a navigation block that can be edited" };

  const P = require("./patch");
  const out = await P.patchSection({
    html: source,
    items: [{ localId: "i1", note, target: {} }],
    containerId: "nav",
    page: `/${sourceSlug}`,
    ai,
  });
  if (!out.verdicts.some((v) => v.ok)) {
    return { ok: false, reason: (out.verdicts[0] && out.verdicts[0].reason) || "the navigation could not be rewritten" };
  }
  // The nav is on every page, so a bad rewrite is a bad rewrite twelve times
  // over. It gets the same structural check a section edit gets, and a link
  // count that must not fall: a menu quietly losing an entry is the failure
  // nobody notices until a client cannot find their own contact page.
  const before = (source.match(/<a\b/gi) || []).length;
  const after = (out.html.match(/<a\b/gi) || []).length;
  if (after < before && !/\b(remove|delete|drop|take out)\b/i.test(note)) {
    return { ok: false, reason: `the rewrite would have dropped ${before - after} link(s) from the menu, and nothing in the note asked to remove any` };
  }

  const touched = [];
  for (const slug of slugs) {
    const abs = pageFile(root, slug);
    if (!fs.existsSync(abs)) continue;
    let doc;
    try { doc = G.readJson(abs); } catch (e) { continue; }
    const nav = (doc.elements || []).map(widgetOf).find((w) => w && /<nav\b/i.test(w.settings.html));
    if (!nav) continue;
    nav.settings.html = out.html;
    G.writeJson(abs, doc);
    touched.push(`resources/pages/${slug}/elementor.json`);
  }
  log(`feedback: navigation rewritten on ${touched.length} page(s)`);
  return { ok: true, touched, links: after };
}

/**
 * Write styling that applies to the whole site.
 *
 * Goes through sitecss.js rather than patchSection, and the difference is the
 * whole point: patchSection confines what it writes to one section, and its
 * first use here shipped rules prefixed with `.elementor-element-site` against
 * an empty placeholder div. They were valid CSS, they passed every check, and
 * they styled nothing, because both the scope and the class names were invented.
 *
 * The model is now shown real markup from the site, so it writes selectors
 * against classes the site actually uses.
 */
async function applyEverywhere(root, note, ai, log) {
  // Vocabulary for the model: the markup of the first few sections of each page.
  const markup = [];
  for (const slug of pageSlugs(root)) {
    const abs = pageFile(root, slug);
    if (!fs.existsSync(abs)) continue;
    let doc;
    try { doc = G.readJson(abs); } catch (e) { continue; }
    for (const w of (doc.elements || []).map(widgetOf)) {
      if (w && w.settings.html) markup.push(w.settings.html);
    }
    if (markup.length > 8) break;
  }

  const out = await CSSW.writeFor({ note, markup, ai });
  if (!out.ok) return { ok: false, reason: out.reason };
  if (out.targets) log(`feedback: site-wide styling targets ${out.targets}`);

  const res = applySiteCss(root, out.css, log);
  if (!res.touched.length) return { ok: false, reason: "no page on this site has a stylesheet this tool can write to" };
  return { ok: true, touched: res.touched, pages: res.touched.length, targets: out.targets };
}

module.exports = { pageSlugs, widgetOf, applySiteCss, applyNav, applyEverywhere };
