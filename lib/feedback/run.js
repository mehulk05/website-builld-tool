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
const AI = require("./intentAI");
const W = require("./writers");
const SITE = require("./site");
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
 * Carry out one note that is not about a single section's markup.
 *
 * Each branch is a writer, and each reports how far it reached: a site-wide
 * change that touched one page out of twelve is not the same as one that touched
 * all of them, and "applied" alone cannot tell the reviewer which happened.
 */
async function applySiteChange({ root, entry, ai, log }) {
  const { item, intent } = entry;
  const applied = [];
  const refused = [];
  const filesTouched = new Set();
  const done = (what, files) => {
    applied.push({ item, section: item.section || "", what, screenshot: null, modelNotes: "" });
    for (const f of files || []) filesTouched.add(f);
    log(`feedback: ${what} (${item.localId})`);
  };
  const no = (reason) => refused.push({ item, section: item.section || "", reason });

  if (intent.kind === "sitecss") {
    const r = await SITE.applyEverywhere(root, item.note, ai, log);
    if (r.ok) done(`styling applied site-wide, on ${r.pages} page(s)`, r.touched);
    else no(r.reason);

  } else if (intent.kind === "nav") {
    const r = await SITE.applyNav(root, item.note, ai, log);
    if (r.ok) done(`navigation updated on ${r.touched.length} page(s), ${r.links} link(s)`, r.touched);
    else no(r.reason);

  } else if (intent.kind === "seo") {
    const r = W.writeSeo(root, item.slug, { title: intent.title, description: intent.description });
    if (r.ok) done(`page ${r.changed.join(" and ")} updated`, [r.file]);
    else no(r.reason);

  } else if (intent.kind === "page") {
    let made;
    try {
      made = await P.generateSection({
        note: `Write the opening section of a new page titled "${intent.title}". ${item.note}`,
        neighbour: "", page: `/${intent.title}`, ai,
      });
    } catch (e) {
      no(`the new page could not be written (${String(e.message).slice(0, 140)})`);
      return { applied, refused, filesTouched: [...filesTouched] };
    }
    const r = W.createPage(root, { title: intent.title, html: made.html, css: made.css });
    if (r.ok) {
      done(`new page created at /${r.slug}/ — it is not linked from the menu yet`, r.files);
    } else no(r.reason);

  } else if (intent.kind === "image") {
    // An image note with no file attached is not an error to report as one: the
    // reviewer meant to attach something and did not, and saying so is more
    // use than "not applied".
    no(item.imageUrl
      ? "this note reached the wrong path — an attached image is applied to the section it was left on"
      : "no image was attached to this note. Choose a file when leaving it and it will be placed for you.");

  } else {
    no("this tool does not know how to carry out that note yet");
  }

  return { applied, refused, filesTouched: [...filesTouched] };
}

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
    // From the WIDGET the click landed in — a container holding two bands would
    // otherwise name whichever one happens to come first, which is how a report
    // told a reviewer a section had gone that they had never pointed at.
    const clicked = STRUCT.widgetFor(doc.elements, item.elementId);
    const label = clicked ? sectionLabel(clicked.settings.html)
      : (at >= 0 ? sectionLabel(sectionHtml(doc.elements[at])) : "");
    if (at < 0) {
      refused.push({ item, reason: "the section this note was left on is no longer on the page" });
      continue;
    }

    let result;
    let expected;
    let what;

    if (intent.op === "remove") {
      // A note that NAMES a section beats the click that carried it. Removing
      // is the one operation with no undo the reviewer can reach, and a click
      // three levels inside a band is a weaker signal than words someone typed.
      // Ignoring the words took the wrong section off a live site twice.
      let removeId = item.elementId;
      if (intent.target) {
        const hit = matchSection(doc.elements, intent.target, null);
        if (!hit) {
          refused.push({
            item,
            section: label,
            reason: `no section on this page is called "${intent.target}" — the sections here are ${
              sectionNames(doc.elements).join(", ") || "unnamed"}`,
          });
          continue;
        }
        removeId = hit.id;
      }
      // Read the name BEFORE removing it, or there is nothing left to read.
      const target = STRUCT.widgetFor(doc.elements, removeId);
      const which = (target && sectionLabel(target.settings.html)) || label;
      result = STRUCT.removeSection(doc, { id: removeId });
      expected = { removed: result.ok ? result.removedIds : [] };
      what = which ? `section removed — "${which}"` : "section removed";
    } else if (intent.op === "move") {
      // "above the pricing section" names a landmark; "move this up" does not.
      // Both are real requests, so both are served: a named target is matched
      // against the sections actually on the page, and an unnamed one shifts by
      // a single position.
      let nearId = null;
      let where = "";
      if (intent.target) {
        const hit = matchSection(doc.elements, intent.target, clicked && clicked.id);
        if (!hit) {
          refused.push({
            item,
            reason: `no section on this page is called "${intent.target}" — the sections here are ${
              sectionNames(doc.elements).join(", ") || "unnamed"}`,
          });
          continue;
        }
        nearId = hit.id;
        where = ` ${intent.position} ${sectionLabel(sectionHtml(hit)) || "that section"}`;
      } else {
        const neighbour = doc.elements[intent.position === "before" ? at - 1 : at + 1];
        if (!neighbour) {
          refused.push({ item, reason: `this section is already ${intent.position === "before" ? "first" : "last"} on the page` });
          continue;
        }
        nearId = neighbour.id;
        where = intent.position === "before" ? " up" : " down";
      }
      result = STRUCT.moveSection(doc, { id: item.elementId, nearId, position: intent.position });
      expected = { reordered: true };
      what = `section moved${where}`;
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

/**
 * The section on this page a reviewer meant by name.
 *
 * Matched on word overlap rather than equality, because nobody types a section's
 * label back exactly: "the pricing section" against "Pricing & Plans", "meet the
 * team" against "Meet Our Team". Every word of the target must appear somewhere
 * in the label, which is strict enough that "team" does not match "Testimonials"
 * and loose enough to survive the words people actually leave out.
 *
 * The section the note was left on is skipped: a note asking to move a section
 * next to itself is a misread, and acting on it would be a no-op the reviewer
 * could not explain.
 *
 * Matched against the sections that are VISIBLE, not against top-level
 * containers. Where one container holds two bands, a container-level match can
 * only ever name the first of them.
 */
function matchSection(elements, target, skipId) {
  const want = String(target || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!want.length) return null;
  const skip = skipId == null ? "" : String(skipId);
  let best = null;
  let bestScore = 0;
  visibleSections(elements).forEach((el) => {
    if (skip && String(el.id) === skip) return;
    const label = sectionLabel(sectionHtml(el)).toLowerCase();
    if (!label) return;
    if (!want.every((w) => label.includes(w))) return;
    // Prefer the closest fit, so "team" picks "Our Team" over "Meet The Team And
    // Their Credentials" when both contain it.
    const score = want.join(" ").length / label.length;
    if (score > bestScore) { bestScore = score; best = el; }
  });
  return best;
}

/**
 * The markup of a section, for showing a model the house style.
 *
 * Takes either the html widget itself or the container above it. Both are passed
 * from different places, and a container holding two widgets returns the first —
 * which is why the callers that need to name ONE section pass the widget.
 */
function sectionHtml(node) {
  if (node && node.settings && typeof node.settings.html === "string") return node.settings.html;
  const widget = ((node && node.elements) || []).find(
    (k) => k && k.elType === "widget" && k.settings && typeof k.settings.html === "string");
  return widget ? widget.settings.html : "";
}

/**
 * The sections a reviewer can actually see, in page order.
 *
 * Not doc.elements. A top-level container usually holds one html widget and is
 * therefore one section, and on at least one real page it held two — so a list
 * built from containers named seven sections on a page showing nine, and a note
 * matched against that list could resolve to a band the reviewer never clicked.
 *
 * @returns {object[]} the html widget nodes, each one visible band
 */
function visibleSections(elements) {
  const out = [];
  for (const c of elements || []) out.push(...STRUCT.widgetsIn(c));
  return out;
}

/** The names of every visible section, for telling a reviewer what is there. */
function sectionNames(elements) {
  return visibleSections(elements).map((w) => sectionLabel(w.settings.html)).filter(Boolean);
}

async function applyNotes({ root, items, ai, liveUrl, log = () => {} }) {
  const applied = [];      // {item, what}
  const refused = [];      // {item, reason}
  const filesTouched = new Set();

  // Read every note first and send each down the pipeline it belongs to. Doing
  // this before anything is resolved means a note this tool does not handle
  // costs no clone, no screenshot and no model call — and, more importantly,
  // cannot be half-carried-out and then reported as done. See intent.js.
  // Model first, keywords second. Reading the note is where every capability
  // starts, and the keyword pass reads only the phrasings it was written
  // against — "shift the reviews block up a bit" is a move this tool can make
  // and a sentence those patterns do not see. AI.classify never throws and
  // falls back to the keywords on any failure, so a slow or confused model
  // costs a better reading, not the note.
  const routed = { section: [], structure: [], refuse: [], site: [] };
  for (const item of items) {
    const v = await AI.classify(item.note, { ai });
    if (v.kind === "refuse") routed.refuse.push({ item, reason: v.reason, kind: v.why });
    else if (v.kind === "structure") routed.structure.push({ item, intent: v });
    else if (v.kind === "section") routed.section.push(item);
    else routed.site.push({ item, intent: v });   // sitecss, seo, nav, page, image
  }

  for (const r of routed.refuse) {
    // The widget's own reading of the section, because this note is refused
    // before any page is opened and there is nothing else to name it by.
    refused.push({ item: r.item, section: r.item.section || "", reason: r.reason });
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

  // Everything that is not one section's markup and not the page's shape:
  // site-wide styling, metadata, the navigation, a whole new page.
  for (const entry of routed.site) {
    const out = await applySiteChange({ root, entry, ai, log });
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
  // Only page content can be rendered. Until pages could be created, every file
  // this pipeline touched WAS an elementor.json, so the caller's list and "the
  // pages to check" were the same thing. Creating a page writes three files, and
  // handing resource.json to a renderer produces "renders almost nothing" — a
  // true statement about a file that was never a page, and a failed batch whose
  // reported reason points nowhere useful.
  for (const rel of files.filter((f) => /(^|\/)elementor\.json$/.test(f))) {
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
