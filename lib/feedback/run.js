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
async function applyNotes({ root, items, ai, liveUrl, log = () => {} }) {
  const applied = [];      // {item, what}
  const refused = [];      // {item, reason}
  const filesTouched = new Set();

  for (const group of S.groupByPage(items)) {
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
        if (!v.ok) refused.push({ item: v.item, reason: v.reason || "this note was not applied" });
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

      for (const v of landed) {
        applied.push({
          item: v.item,
          what: out.usedModel ? "rewritten" : "applied exactly",
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
