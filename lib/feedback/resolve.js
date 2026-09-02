// Turning "the designer clicked here" into "this node in this file".
//
// The whole design rests on one property of the generated sites: every section
// carries an Elementor element id that is BOTH in the rendered DOM (as
// `elementor-element-<id>`) and in the page's elementor.json (as the node's
// `id`). compile.js derives it deterministically from slug+role+index, so it
// survives a redeploy of unchanged content.
//
// What this module refuses to do is as important as what it does:
//
//   * It never searches by text, coordinates or selector. If the id is gone,
//     the item is a conflict — because the alternative is confidently editing
//     whatever happens to sit in that position now, which is how an automatic
//     pipeline quietly rewrites the wrong section.
//   * It never trusts the browser's copy of the HTML. The fragment is re-read
//     from the checkout at resolve time, so a stale tab or a tampered payload
//     changes nothing about what gets patched.
//   * It requires the id to be UNIQUE in the document. A duplicated id (two
//     pages merged by hand, a copy-pasted section) makes "the" target
//     meaningless, so that is a conflict too.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const G = require("../../gitops-json");

const hash = (s) => crypto.createHash("sha256").update(String(s == null ? "" : s)).digest("hex").slice(0, 16);

/** Where a page's Elementor document lives in a gitops checkout. */
function pageFile(slug) {
  return `resources/pages/${String(slug || "home")}/elementor.json`;
}

/** Every element id in the document, with how many times each occurs. */
function idCounts(doc) {
  const counts = new Map();
  const visit = (el) => {
    if (!el || typeof el !== "object") return;
    const id = String(el.id || "");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
    (Array.isArray(el.elements) ? el.elements : []).forEach(visit);
  };
  (Array.isArray(doc && doc.elements) ? doc.elements : []).forEach(visit);
  return counts;
}

/**
 * The node an annotation is really about.
 *
 * A reviewer clicks a button; the widget walks up to the nearest element
 * carrying an Elementor id, which on these sites is usually the CONTAINER of a
 * section, whose single child is the `html` widget holding that section's
 * markup. The patchable thing is that widget's `settings.html`, so when the id
 * resolves to a container with exactly one html widget inside, this returns the
 * widget — patching a container's own settings would not change any markup.
 */
function patchTarget(node) {
  if (!node) return null;
  const settings = node.settings && typeof node.settings === "object" ? node.settings : {};
  if (node.elType === "widget" && typeof settings.html === "string") return { node, kind: "html" };
  const kids = Array.isArray(node.elements) ? node.elements : [];
  const widgetKids = kids.filter((k) => k && k.elType === "widget");
  // The html widget has to be the container's ONLY widget. A container holding
  // a heading and an html block is genuinely ambiguous: the reviewer clicked
  // the container itself (its padding, between the two), and silently patching
  // whichever child happens to be HTML would edit something they were not
  // pointing at. Clicking the heading would have resolved to the heading's own
  // id and never reached this branch.
  if (widgetKids.length === 1 && widgetKids[0].widgetType === "html"
    && typeof (widgetKids[0].settings || {}).html === "string") {
    return { node: widgetKids[0], kind: "html" };
  }
  // A native widget (heading/button/image) or a container of several widgets.
  // Both are addressable, but not as one HTML fragment — the caller decides
  // whether it can do anything useful with that.
  if (node.elType === "widget") return { node, kind: "widget" };
  return { node, kind: "container" };
}

/**
 * Resolve one page's worth of annotations against a checkout.
 *
 * @param {string} root      repo checkout root
 * @param {string} slug      page slug ("home", "services", …)
 * @param {object[]} items   normalised annotations (lib/feedback/schema.js)
 * @returns {{file: string, doc: object|null, resolved: object[], conflicts: object[]}}
 */
function resolvePage(root, slug, items) {
  const rel = pageFile(slug);
  const abs = path.join(root, rel);
  const out = { file: rel, doc: null, resolved: [], conflicts: [] };

  if (!fs.existsSync(abs)) {
    for (const it of items) out.conflicts.push({ item: it, reason: `this site has no ${slug} page any more` });
    return out;
  }
  let doc;
  try { doc = G.readJson(abs); }
  catch (e) {
    for (const it of items) out.conflicts.push({ item: it, reason: `${rel} could not be read (${e.message})` });
    return out;
  }
  out.doc = doc;

  const counts = idCounts(doc);
  for (const it of items) {
    const n = counts.get(it.elementId) || 0;
    if (n === 0) {
      out.conflicts.push({ item: it, reason: "the section this note was left on is no longer on the page" });
      continue;
    }
    if (n > 1) {
      out.conflicts.push({ item: it, reason: "this section's id appears more than once on the page, so the note cannot be aimed at one of them" });
      continue;
    }
    const node = G.findById(doc.elements, it.elementId);
    const target = patchTarget(node);
    if (!target || target.kind !== "html") {
      out.conflicts.push({
        item: it,
        reason: target && target.kind === "container"
          ? "this part of the page is a layout container with several widgets in it, not one editable block"
          : "this part of the page is not an editable HTML block",
      });
      continue;
    }
    const html = String(target.node.settings.html || "");
    out.resolved.push({
      item: it,
      containerId: it.elementId,
      widgetId: String(target.node.id || ""),
      html,
      fragmentHash: hash(html),
      // Does the section still contain what the reviewer clicked? Evidence, not
      // identity: a section whose copy was reworded since the note was left is
      // still the right section, but the caller may want to say so.
      evidencePresent: evidenceStillPresent(html, it),
    });
  }
  return out;
}

// Cheap containment check. The browser sent the clicked element's text and tag;
// if neither appears in the fragment any more, the section has been rewritten
// under this note and the model is about to be told about a button that is not
// there. Deliberately forgiving — whitespace and entities differ between the
// rendered DOM and the source — because this only downgrades confidence, it
// does not block the patch.
function evidenceStillPresent(html, item) {
  const t = (item && item.target) || {};
  const text = String(t.text || "").trim();
  if (!text) return true;
  const norm = (s) => String(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ").trim().toLowerCase();
  const hay = norm(html.replace(/<[^>]+>/g, " "));
  const needle = norm(text);
  if (needle.length < 4) return true;                 // too short to mean anything
  if (hay.includes(needle)) return true;
  // A long selection may span nodes; accept a solid prefix rather than demand
  // the whole run, which fails on any inline markup in the middle.
  return hay.includes(needle.slice(0, Math.max(12, Math.floor(needle.length * 0.6))));
}

/**
 * Re-check a resolved target against a fresh checkout before writing.
 *
 * Between accepting a batch and committing it, `main` can move — another
 * feedback run, a regenerated site, a hand edit. Re-resolving by id is not
 * enough on its own: the id can survive while the section it names is replaced
 * wholesale. So the fragment hash recorded at resolve time is compared, and a
 * changed fragment is only accepted when the clicked element is still findable
 * inside it.
 */
function recheck(root, slug, resolvedEntry) {
  const fresh = resolvePage(root, slug, [resolvedEntry.item]);
  if (fresh.conflicts.length) return { ok: false, reason: fresh.conflicts[0].reason };
  const now = fresh.resolved[0];
  if (now.fragmentHash === resolvedEntry.fragmentHash) return { ok: true, entry: now, drifted: false };
  if (now.evidencePresent) return { ok: true, entry: now, drifted: true };
  return { ok: false, reason: "this section changed after the note was left, and what the note points at is no longer in it" };
}

module.exports = { pageFile, idCounts, patchTarget, resolvePage, recheck, evidenceStillPresent, hash };
