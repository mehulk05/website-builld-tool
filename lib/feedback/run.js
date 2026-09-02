// The run: notes in, a merged pull request out.
//
// Written as a module taking its plumbing as arguments rather than reaching
// into server.js, for two reasons. server.js already requires this file, so the
// reverse would be a cycle; and the interesting logic here — resolve, patch,
// gate, splice — is worth being able to test without a clone, a model or a
// network.
//
// The order of operations is the safety argument:
//
//   lock → clone → resolve against HEAD → patch → gate → render → commit
//
// Resolution happens against the freshly cloned tree, never against what the
// browser sent, so a stale tab cannot steer the edit. The gates run before the
// commit, so a rejected patch never reaches a branch. The render runs before
// the merge, so "valid HTML" and "still a working page" are checked separately.
// And the whole run holds a per-repository lock, because two batches patching
// the same page at once is the one race where both would report success and one
// would silently lose.
"use strict";
const fs = require("fs");
const path = require("path");

const S = require("./schema");
const I = require("./intent");
const STRUCT = require("./structure");
const R = require("./resolve");
const P = require("./patch");
const V = require("./validate");
const ST = require("./store");
const SHOT = require("./shot");
const VIS = require("./visualCheck");
const G = require("../../gitops-json");

// Each section's feedback CSS lives in its own marked block, so a second note
// on the same section REPLACES the first block instead of stacking another one
// underneath it — otherwise a section reviewed three times carries three
// generations of contradictory rules, and the oldest ones still win wherever
// they are more specific.
//
// Done with indexOf rather than a built regex on purpose. The first version of
// this composed the pattern from the container id inside a template literal,
// got the escaping subtly wrong, and produced a regex that matched nothing —
// silently, because "no match" and "nothing to replace" look identical. String
// search has no escaping to get wrong.
const CSS_END = "/* end */";
const cssMarker = (id) => `/* g99 feedback: ${id} */`;

function replaceCssBlock(existing, containerId, css) {
  const marker = cssMarker(containerId);
  let out = existing;
  for (;;) {
    const at = out.indexOf(marker);
    if (at < 0) break;
    const end = out.indexOf(CSS_END, at);
    if (end < 0) { out = out.slice(0, at); break; }        // truncated block: drop the tail
    out = out.slice(0, at) + out.slice(end + CSS_END.length);
  }
  return `${out.trim()}\n${marker}\n${css}\n${CSS_END}`.trim();
}

/**
 * Work through one batch of design notes against a checkout.
 *
 * Pure-ish: it reads and writes the checkout, calls the model, and reports —
 * it does not clone, branch, commit or merge. The caller owns git.
 *
 * @param {object} arg
 * @param {string} arg.root      repo checkout
 * @param {object[]} arg.items   normalised annotations
 * @param {function} arg.ai      async (prompt, imageParts) => string
 * @param {string} [arg.liveUrl] site base URL, for screenshots
 * @param {function} [arg.log]
 * @returns {Promise<{applied: object[], refused: object[], filesTouched: string[], cssByPage: object}>}
 */
/**
 * Carry out the structural notes for one page.
 *
 * Every operation is arithmetic on the page's element array (structure.js); the
 * only thing a model contributes is the markup of a section being added. Nothing
 * is written until the resulting node set has been checked against what the
 * operations SAID they would do — see validate.checkNodeSet. That check is not
 * ceremony: an insert that lands one position out passes every other test and
 * shows up only as a page whose sections are subtly in the wrong order.
 *
 * Notes are applied one at a time and the check runs per note, so a single bad
 * operation is refused on its own rather than taking the page's other changes
 * down with it.
 */
async function applyStructure({ root, slug, page, entries, ai, log }) {
  const applied = [];
  const refused = [];
  const filesTouched = new Set();

  const rel = `resources/pages/${slug}/elementor.json`;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    for (const e of entries) refused.push({ item: e.item, reason: `this site has no ${slug} page any more` });
    return { applied, refused, filesTouched: [] };
  }

  let doc;
  try { doc = G.readJson(abs); }
  catch (err) {
    for (const e of entries) refused.push({ item: e.item, reason: `${rel} could not be read (${err.message})` });
    return { applied, refused, filesTouched: [] };
  }

  let wrote = false;
  for (const entry of entries) {
    const { item, intent } = entry;
    const before = STRUCT.allIds(doc.elements);
    const at = STRUCT.sectionIndexOf(doc.elements, item.elementId);
    // Read now: a remove or a move makes this section hard to find afterwards.
    const label = at >= 0 ? sectionLabel(sectionHtml(doc.elements[at])) : "";
    if (at < 0) {
      refused.push({ item, reason: "the section this note was left on is no longer on the page" });
      continue;
    }

    let result;
    let expected;
    let what;

    if (intent.op === "remove") {
      result = STRUCT.removeSection(doc, { id: item.elementId });
      expected = { removed: result.ok ? result.removedIds : [] };
      what = "section removed";
    } else if (intent.op === "move") {
      // Which section to move next to is not something a note states in a form
      // this can read yet, so a move goes one place in the direction asked. That
      // is what "move this up" means often enough to be useful, and it is at
      // least a change the reviewer can see and describe again.
      const neighbourAt = intent.position === "before" ? at - 1 : at + 1;
      const neighbour = doc.elements[neighbourAt];
      if (!neighbour) {
        refused.push({ item, reason: `this section is already ${intent.position === "before" ? "first" : "last"} on the page` });
        continue;
      }
      result = STRUCT.moveSection(doc, { id: item.elementId, nearId: neighbour.id, position: intent.position });
      expected = { reordered: true };
      what = `section moved ${intent.position === "before" ? "up" : "down"}`;
    } else {
      let made;
      try {
        made = await P.generateSection({
          note: item.note,
          neighbour: sectionHtml(doc.elements[at]),
          page,
          ai,
        });
      } catch (err) {
        refused.push({ item, reason: `the new section could not be written (${String(err.message).slice(0, 140)})` });
        continue;
      }
      const htmlCheck = V.checkHtml("", made.html, { allowStructural: true, cssChanged: !!made.css });
      if (!htmlCheck.ok) {
        refused.push({ item, reason: `the new section was rejected: ${htmlCheck.reason}` });
        continue;
      }
      result = STRUCT.insertSection(doc, { nearId: item.elementId, position: intent.position, html: made.html });
      expected = { added: result.ok ? [result.sectionId, result.widgetId] : [] };
      what = `new section added ${intent.position} this one`;
      if (result.ok && made.css && made.css.trim()) {
        const cssCheck = V.checkCss(made.css, result.widgetId);
        if (cssCheck.ok && String(cssCheck.css || "").trim()) {
          doc.document_settings = doc.document_settings || {};
          doc.document_settings.custom_css = replaceCssBlock(
            String(doc.document_settings.custom_css || ""), result.widgetId, cssCheck.css.trim());
        }
      }
    }

    if (!result.ok) {
      refused.push({ item, reason: result.reason });
      continue;
    }

    const guard = V.checkNodeSet(before, STRUCT.allIds(doc.elements), expected);
    if (!guard.ok) {
      // The document is now untrustworthy, so nothing from this page is written.
      // Re-reading from disk would be tidier; refusing the whole page is safer,
      // and a structural note failing this check means a bug worth noticing.
      log(`feedback: ${rel} failed its structure check — ${guard.reason}`);
      for (const e of entries) refused.push({ item: e.item, reason: `this change was undone: ${guard.reason}` });
      return { applied: [], refused, filesTouched: [] };
    }

    wrote = true;
    applied.push({ item, section: label, what, screenshot: null, modelNotes: "" });
    log(`feedback: ${rel} — ${what} (${item.localId})`);
  }

  if (wrote) {
    G.writeJson(abs, doc);
    filesTouched.add(rel);
  }
  return { applied, refused, filesTouched: [...filesTouched] };
}

/**
 * What actually changed, in a few words the reviewer can check against the page.
 *
 * "rewritten" was true of almost every applied note and told nobody anything.
 * This is read from the before and after rather than from what the model claimed
 * to have done, which is the same reason the CSS gate reads the markup rather
 * than the model's word for it.
 *
 * Deliberately coarse. It exists so that "applied" is not the whole report, not
 * to narrate the diff.
 */
function describeChange(before, after, css, usedModel) {
  const b = String(before || "");
  const a = String(after || "");
  const parts = [];

  if (b !== a) {
    const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const tags = (h) => (h.match(/<[a-z][^>]*>/gi) || []).length;
    if (strip(b) !== strip(a)) parts.push("wording changed");
    if (tags(a) > tags(b)) parts.push("markup added");
    else if (tags(a) < tags(b)) parts.push("markup removed");
    // Markup that moved without gaining or losing anything, and without the
    // words changing: an attribute, a class, a link.
    if (!parts.length) parts.push("markup adjusted");
  }
  if (String(css || "").trim()) parts.push("styling added");
  if (!parts.length) parts.push(usedModel ? "rewritten" : "applied exactly");
  return parts.join(", ");
}

/**
 * A name for a section that a person would recognise.
 *
 * An element id is the right handle for the machinery and useless to everyone
 * else: "moved 971554e up" tells the person reading the report nothing about
 * which part of their page moved. Sections carry their own name in their markup
 * — a heading, or the small eyebrow label above it — so it is taken from there
 * rather than invented.
 *
 * Order matters. The eyebrow ("Testimonials", "Our Team") is checked first
 * because it is written to label the section, whereas a heading is written to be
 * read ("A Comprehensive and Personalized Approach to Your Care") and makes a
 * poor short name. Falling back to the heading is still far better than an id.
 */
function sectionLabel(html) {
  const src = String(html || "");
  const text = (m) => m && m[1]
    ? m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
    : "";
  const eyebrow = text(src.match(/<[a-z]+[^>]*class="[^"]*\bu-eyebrow\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i));
  const heading = text(src.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i));
  const pick = eyebrow || heading;
  if (!pick) return "";
  // Title case an all-caps eyebrow: "TRUE BEAUTY STARTS WITHIN" shouted back at
  // the reviewer reads as an error message rather than a place on their page.
  const cased = pick === pick.toUpperCase() && pick.length > 3
    ? pick.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : pick;
  return cased.length > 48 ? cased.slice(0, 47).trimEnd() + "…" : cased;
}

/** The markup of a section, for showing a model the house style. */
function sectionHtml(container) {
  const widget = ((container && container.elements) || []).find(
    (k) => k && k.elType === "widget" && k.settings && typeof k.settings.html === "string");
  return widget ? widget.settings.html : "";
}

async function applyNotes({ root, items, ai, liveUrl, log = () => {} }) {
  const applied = [];      // {item, what}
  const refused = [];      // {item, reason}
  const filesTouched = new Set();

  // Read every note first and send each down the pipeline it belongs to. Doing
  // this before anything is resolved means a note this tool does not handle
  // costs no clone, no screenshot and no model call — and, more importantly,
  // cannot be half-carried-out and then reported as done. See intent.js.
  const routed = I.route(items);
  for (const r of routed.refuse) {
    refused.push({ item: r.item, reason: r.reason });
    log(`feedback: refusing ${r.item.localId} — ${r.kind}`);
  }

  // Structural notes run first, per page. They change which sections exist, so
  // running them after a section rewrite would mean rewriting a section and then
  // possibly deleting it — work thrown away, and a confusing report.
  const structuralPages = S.groupByPage(routed.structure.map((r) => r.item));
  for (const group of structuralPages) {
    const forPage = routed.structure.filter((r) => r.item.slug === group.slug);
    const out = await applyStructure({ root, slug: group.slug, page: group.page, entries: forPage, ai, log });
    applied.push(...out.applied);
    refused.push(...out.refused);
    for (const f of out.filesTouched) filesTouched.add(f);
  }

  for (const group of S.groupByPage(routed.section)) {
    const res = R.resolvePage(root, group.slug, group.items);
    for (const c of res.conflicts) refused.push({ item: c.item, reason: c.reason });
    if (!res.resolved.length) continue;

    // All notes on one section go to the model together. Sent separately, each
    // would start from the section as it was before the other's edit and the
    // second would quietly undo the first.
    const bySection = new Map();
    for (const entry of res.resolved) {
      if (!bySection.has(entry.containerId)) bySection.set(entry.containerId, { entry, items: [] });
      bySection.get(entry.containerId).items.push(entry.item);
    }

    const rel = res.file;
    const abs = path.join(root, rel);
    let doc = res.doc;
    let wrote = false;

    for (const [containerId, section] of bySection) {
      const entry = section.entry;
      // A picture of the section, for the model. Best-effort: a note is worth
      // acting on without one, and a screenshot failure must not fail a batch.
      let shot = null;
      if (liveUrl) {
        const pageUrl = liveUrl.replace(/\/$/, "") + (group.page === "/" ? "/" : group.page + "/");
        shot = await SHOT.captureElement(pageUrl, containerId).catch(() => null);
      }

      let out;
      try {
        out = await P.patchSection({
          html: entry.html,
          items: section.items,
          containerId,
          page: group.page,
          ai: (prompt) => ai(prompt, SHOT.asGeminiPart(shot)),
        });
      } catch (e) {
        for (const it of section.items) refused.push({ item: it, reason: `this section could not be rewritten (${String(e.message).slice(0, 140)})` });
        continue;
      }

      for (const v of out.verdicts) {
        if (!v.ok) refused.push({ item: v.item, section: sectionLabel(entry.html), reason: v.reason || "this note was not applied" });
      }
      const landed = out.verdicts.filter((v) => v.ok);
      if (!landed.length) continue;

      // Splice: only this node's html changes, so every other byte of the file
      // is identical by construction rather than by the model's good behaviour.
      const node = G.findById(doc.elements, entry.widgetId);
      if (!node) {
        for (const v of landed) refused.push({ item: v.item, reason: "the section moved while it was being edited" });
        continue;
      }
      node.settings = node.settings || {};
      node.settings.html = out.html;
      wrote = true;

      if (out.css && out.css.trim()) {
        doc.document_settings = doc.document_settings || {};
        doc.document_settings.custom_css = replaceCssBlock(
          String(doc.document_settings.custom_css || ""), containerId, out.css.trim());
      }

      const label = sectionLabel(entry.html);
      for (const v of landed) {
        applied.push({
          item: v.item,
          section: label,
          what: describeChange(entry.html, out.html, out.css, out.usedModel),
          screenshot: shot ? shot.rel : null,
          modelNotes: out.modelNotes || "",
        });
      }
      log(`feedback: patched ${rel} ${containerId} (${landed.length} note(s))`);
    }

    if (wrote) {
      G.writeJson(abs, doc);
      filesTouched.add(rel);
    }
  }

  return { applied, refused, filesTouched: [...filesTouched] };
}

/**
 * Render a page as it is in the checkout, for the pre-merge smoke test.
 *
 * The page's own HTML is what the site actually serves, which we cannot build
 * here — so this assembles the same thing the compiler does: every html widget
 * in document order, plus the page's custom CSS. Enough to tell "renders" from
 * "does not".
 */
function pageHtmlFromDoc(doc) {
  const parts = [];
  const visit = (el) => {
    if (!el || typeof el !== "object") return;
    const s = el.settings || {};
    if (el.elType === "widget" && el.widgetType === "html" && typeof s.html === "string") parts.push(s.html);
    (Array.isArray(el.elements) ? el.elements : []).forEach(visit);
  };
  (Array.isArray(doc && doc.elements) ? doc.elements : []).forEach(visit);
  const css = String((doc.document_settings || {}).custom_css || "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${parts.join("\n")}</body></html>`;
}

/**
 * Render each touched page before and after, and refuse the batch if the patch
 * broke one. This is what stands in for a human looking at the PR.
 */
async function smokeTouchedPages(rootBefore, rootAfter, files, log = () => {}) {
  const problems = [];
  for (const rel of files) {
    let before = null, after = null;
    try {
      const a = path.join(rootBefore, rel);
      if (fs.existsSync(a)) before = pageHtmlFromDoc(G.readJson(a));
      after = pageHtmlFromDoc(G.readJson(path.join(rootAfter, rel)));
    } catch (e) {
      problems.push(`${rel}: could not be read back after patching (${String(e.message).slice(0, 120)})`);
      continue;
    }
    const v = await VIS.smokeTest(before, after);
    if (!v.ok) problems.push(...v.problems.map((p) => `${rel}: ${p}`));
    else if (v.problems.length) log(`feedback: smoke inconclusive on ${rel} — ${v.problems.join("; ")}`);
  }
  return { ok: problems.length === 0, problems };
}

/** A PR body that says what was asked for and what happened to each item. */
function prBody({ reviewer, applied, refused, batchId, siteName }) {
  const line = (o) => {
    const it = o.item;
    return `- \`${it.page}\` · \`${it.elementId}\` — ${String(it.note).replace(/[`\n]/g, " ").slice(0, 180)}`;
  };
  const out = [
    `Design feedback on **${siteName || "this site"}**, submitted by ${reviewer || "a reviewer"}.`,
    "",
    `Batch: \`${batchId}\``,
    "",
  ];
  if (applied.length) {
    out.push(`**Applied (${applied.length})**`, ...applied.map(line), "");
  }
  if (refused.length) {
    out.push(`**Not applied (${refused.length})**`,
      ...refused.map((o) => `${line(o)}\n  - ${String(o.reason).replace(/[`\n]/g, " ").slice(0, 200)}`), "");
  }
  out.push("Merged automatically — every item above passed the safety and render checks.");
  return out.join("\n");
}

module.exports = { applyNotes, pageHtmlFromDoc, smokeTouchedPages, prBody, replaceCssBlock };
