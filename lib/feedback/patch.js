// Turning notes into a rewritten section.
//
// Two rules shape this module.
//
// The first is scope. A note is about one section, so the model is shown one
// section — never the page, never the site. Handing it the whole page to change
// one button is how unrelated things break, and on this pipeline nothing
// downstream would catch it. The output is spliced back at the same node id, so
// everything else in the file is byte-identical by construction rather than by
// the model's good behaviour.
//
// The second is coalescing. Several notes often land on the same section ("make
// the button gold", "and the heading smaller"). Sent separately they would each
// rewrite the section from its own starting point and the second would undo the
// first. So all of a section's notes go in one call, and the model is asked to
// report which ones it actually handled.
//
// `ai` is injected rather than imported: it keeps server.js's Gemini plumbing
// out of a module the tests need to run offline, and avoids requiring server.js
// from something server.js requires.
"use strict";
const V = require("./validate");
const INTENT = require("./intent");
const IMG = require("./image");

const MAX_FRAGMENT = 60 * 1024;   // beyond this the section is too big to patch safely

/**
 * A note that can be carried out exactly, with no model involved.
 *
 * Only one shape qualifies today: a link whose destination the reviewer stated
 * outright, on an element that really is a link. That is worth special-casing
 * because it is both the most common piece of design feedback and the one a
 * model is most likely to get subtly wrong (rewriting the anchor's text, or
 * pointing every link in the section at the new URL).
 *
 * Everything else — padding, colour, order, wording — goes to the model. This
 * is not a general-purpose instruction parser and must not grow into one: a
 * half-understood note applied deterministically is worse than one applied by a
 * model that at least reads the sentence.
 */
function deterministicEdit(html, item) {
  // A replacement picture needs no model at all: the reviewer chose the file,
  // the tool stored it, and the only question is which <img> to point at the new
  // URL. Sending that to a model could only make it worse.
  if (item.imageUrl) return swapImage(html, item);

  const note = String(item.note || "");
  const tag = String((item.target || {}).tag || "").toLowerCase();
  if (tag !== "a") return null;
  // "should go to /contact", "link it to https://…", "point this at /services/"
  const m = note.match(/\b(?:to|at|towards?|→)\s+["'<(]?((?:https?:\/\/|mailto:|tel:|\/)[^\s"'>),]+)/i);
  if (!m) return null;
  const url = m[1].replace(/[.,;]$/, "");
  if (!/^(?:https?:\/\/|mailto:|tel:|\/)/i.test(url)) return null;

  // Which anchor. The reviewer's click carried the link's own text, and that is
  // what distinguishes one of five links in a footer from the others.
  const clickText = String((item.target || {}).text || "").trim();
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (!anchors.length) return null;
  const norm = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  let hit = null;
  if (clickText) {
    const want = norm(clickText);
    const matches = anchors.filter((a) => norm(a[2]) === want);
    // Exactly one, or the edit is ambiguous and belongs to the model.
    if (matches.length === 1) hit = matches[0];
  }
  if (!hit && anchors.length === 1) hit = anchors[0];
  if (!hit) return null;

  const attrs = hit[1];
  const replaced = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(attrs)
    ? attrs.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `href="${url}"`)
    : `${attrs} href="${url}"`;
  const before = hit[0];
  const after = `<a${replaced}>${hit[2]}</a>`;
  if (before === after) return null;
  return { html: html.replace(before, after), what: `link → ${url}` };
}

// Point one <img> at the uploaded file.
//
// Which one: the clicked element if it IS an image, otherwise the only image in
// the section. A section with several pictures and a click that did not land on
// one of them is ambiguous, and an ambiguous picture swap is not something to
// resolve by guessing — it goes back as a refusal instead.
function swapImage(html, item) {
  const url = String(item.imageUrl || "");
  if (!/^https?:\/\//i.test(url)) return null;
  const t = item.target || {};
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
  // Nothing to swap means the reviewer wants a picture here, not a different
  // one. Refusing that was never a decision — it fell out of a function written
  // only to replace, and left "add an image here" as something the tool could
  // not do with a file the reviewer had already attached.
  if (!imgs.length) return IMG.insertImage(html, url);

  let hit = null;
  if (String(t.tag || "").toLowerCase() === "img") {
    const src = String((t.attrs || {}).src || "");
    // The rendered src is absolute; the source may hold either form.
    const tail = src.split("/").pop().split("?")[0];
    const bySrc = tail ? imgs.filter((m) => m[0].includes(tail)) : [];
    if (bySrc.length === 1) hit = bySrc[0];
  }
  if (!hit && imgs.length === 1) hit = imgs[0];
  if (!hit) return null;

  const tag = hit[0];
  const next = /(\s)src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(tag)
    ? tag.replace(/(\s)src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `$1src="${url}"`)
    : tag.replace(/^<img/i, `<img src="${url}"`);
  // srcset would keep serving the OLD picture on most screens — the one thing
  // that would make this look like it silently did nothing.
  const cleaned = next.replace(/\s+(?:srcset|data-srcset|sizes)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  if (cleaned === tag) return null;
  return { html: html.replace(tag, cleaned), what: "image replaced" };
}

/** The instruction the model is given. Deliberately narrow and explicit. */
function buildPrompt({ html, items, containerId, page }) {
  const notes = items.map((it, i) => {
    const t = it.target || {};
    const where = [t.tag ? `<${t.tag}>` : null, t.text ? `“${String(t.text).slice(0, 120)}”` : null]
      .filter(Boolean).join(" ");
    return `${i + 1}. [id ${it.localId}]${where ? ` (they clicked ${where})` : ""} ${it.note}`;
  }).join("\n");

  return [
    "You are editing ONE SECTION of a live website. The section's HTML is below.",
    "",
    `Page: ${page}`,
    "",
    "FEEDBACK from a designer looking at this section:",
    notes,
    "",
    "SECTION HTML:",
    "```html",
    html,
    "```",
    "",
    "Rules:",
    "- Change ONLY what the feedback asks for. Everything else must come back byte-identical.",
    "- Keep every image, link and heading that is there now unless a note explicitly says to remove it.",
    "- Do not add <script>, <iframe>, <form>, event handlers (onclick=…) or javascript: URLs.",
    "- Prefer editing the existing markup over rebuilding it.",
    "- If the section contains a <style> block, return it EXACTLY as it is. Those rules are what make this section look like anything; dropping them leaves the content standing and the design gone.",
    "- A visual change (size, colour, spacing, radius) is usually best as CSS. Put it in \"css\" and target the existing markup — selectors are confined to this section automatically, so plain ones like \".c-btn{border-radius:999px}\" are fine.",
    "- If you add a class in the HTML, you MUST also give it a rule in \"css\". A class with no rule changes nothing on the page.",
    "- And the reverse: if you write a rule for a class, that class MUST appear in the HTML you return. A rule for a class nothing wears is dead and will be rejected.",
    "- If you cannot carry out a note, leave it out of \"addressed\" rather than guessing.",
    "",
    "Reply with ONLY a JSON object, no markdown fence:",
    '{"html":"<the full rewritten section>","css":"<scoped css or empty string>","addressed":["i1","i2"],"notes":"<one line on anything you could not do>"}',
  ].join("\n");
}

/** Pull the JSON object out of a model reply that may be fenced or prefaced. */
function parseReply(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const at = s.indexOf("{");
  if (at > 0) s = s.slice(at);
  const end = s.lastIndexOf("}");
  if (end > 0) s = s.slice(0, end + 1);
  let j;
  try { j = JSON.parse(s); } catch (e) { throw new Error("the model did not return usable JSON"); }
  if (!j || typeof j !== "object") throw new Error("the model did not return an object");
  return {
    html: typeof j.html === "string" ? j.html : "",
    css: typeof j.css === "string" ? j.css : "",
    addressed: Array.isArray(j.addressed) ? j.addressed.map(String) : [],
    notes: typeof j.notes === "string" ? j.notes.slice(0, 300) : "",
  };
}

/**
 * Patch one section.
 *
 * @param {object} arg
 * @param {string} arg.html         current fragment from Git
 * @param {object[]} arg.items      all notes on this section
 * @param {string} arg.containerId  Elementor id, for CSS scoping
 * @param {string} arg.page         page path, for the prompt only
 * @param {function} arg.ai         async (prompt) => string
 * @returns {Promise<{html, css, addressed: string[], verdicts: object[], modelNotes: string, usedModel: boolean}>}
 */
async function patchSection({ html, items, containerId, page, ai }) {
  const before = String(html || "");
  if (before.length > MAX_FRAGMENT) {
    return {
      html: before, css: "", addressed: [], usedModel: false, modelNotes: "",
      verdicts: items.map((it) => ({ item: it, ok: false, reason: "this section is too large to edit safely in one piece" })),
    };
  }

  // Deterministic pass first, so a link change never depends on a model.
  let working = before;
  const doneIds = [];
  const remaining = [];
  for (const it of items) {
    const d = deterministicEdit(working, it);
    if (d) { working = d.html; doneIds.push(it.localId); }
    else remaining.push(it);
  }

  if (!remaining.length) {
    return {
      html: working, css: "", addressed: doneIds, usedModel: false, modelNotes: "",
      verdicts: items.map((it) => ({ item: it, ok: true })),
    };
  }

  const reply = await ai(buildPrompt({ html: working, items: remaining, containerId, page }));
  const out = parseReply(reply);
  if (!out.html.trim()) throw new Error("the model returned no HTML for this section");

  // A note that says to remove or add something is allowed to move the element
  // counts; one about colour or spacing is not. Checked per section, from the
  // notes that actually went to the model.
  //
  // Asked of intent.js rather than of a second word list kept here. The two
  // lists disagreed — this one had never heard of "take it out" — so a note
  // reading "take the photo out from the bottom of this section" was carried
  // out correctly and then rejected for dropping an <img> "the feedback did not
  // ask to remove". Telling a reviewer that about their own sentence leaves them
  // nothing they can do with the answer.
  const allowStructural = remaining.some((it) => INTENT.asksForStructure(it.note));

  // The CSS is confined before the HTML is judged, because "the markup did not
  // change" is only a failure when the CSS did not either — a spacing or colour
  // note is correctly answered in CSS alone.
  const cssCheck = V.checkCss(out.css, containerId);
  const cssChanged = cssCheck.ok && !!String(cssCheck.css || "").trim();

  const htmlCheck = V.checkHtml(working, out.html, { allowStructural, cssChanged });
  if (!htmlCheck.ok) {
    return {
      html: before, css: "", addressed: doneIds, usedModel: true, modelNotes: out.notes,
      verdicts: items.map((it) => (doneIds.includes(it.localId)
        ? { item: it, ok: true }
        : { item: it, ok: false, reason: htmlCheck.reason })),
    };
  }
  if (cssCheck.ok) {
    // Scoped for it where it did not scope its own — see validate.checkCss.
    out.css = cssCheck.css;
    if (cssCheck.rescoped) out.notes = (out.notes ? out.notes + " " : "") + `(${cssCheck.rescoped} rule(s) confined to this section)`;
  } else {
    // Only reaches here for CSS that cannot be confined at all. The HTML may
    // still be fine on its own, but a note whose visible effect lived in that
    // CSS has not been carried out — so this is reported, not swallowed.
    out.css = "";
    out.notes = (out.notes ? out.notes + " " : "") + `(styling was dropped: ${cssCheck.reason})`;
  }

  const claimed = [...doneIds, ...out.addressed];
  // containerId so the scope prefix checkCss added is not mistaken for a hook
  // the section was supposed to carry.
  const verdicts = V.checkAddressed(working, out.html, out.css, items, claimed, containerId)
    .map((v) => (doneIds.includes(v.item.localId) ? { item: v.item, ok: true } : v));

  return { html: out.html, css: out.css, addressed: claimed, verdicts, usedModel: true, modelNotes: out.notes };
}

/**
 * Write ONE new section, in the voice of the page it is joining.
 *
 * Different job from patchSection, and a different prompt for it. There is no
 * "change only what was asked" to lean on here — everything is new — so the
 * guidance that matters is about fitting in: the surrounding markup is shown so
 * the model can reuse the classes and rhythm already on the page rather than
 * inventing a second design language halfway down it.
 *
 * The section is NOT placed here. Where it goes is arithmetic, done in
 * structure.js, because an index a model chose is an index nobody checked.
 *
 * @param {object} arg
 * @param {string} arg.note      what the reviewer asked for
 * @param {string} arg.neighbour markup of the section it will sit beside
 * @param {string} arg.page      page path, for the prompt only
 * @param {function} arg.ai
 * @returns {Promise<{html: string, css: string, notes: string}>}
 */
async function generateSection({ note, neighbour, page, ai }) {
  const prompt = [
    "You are writing ONE new section for a live website.",
    "",
    `Page: ${page}`,
    "",
    "WHAT THE DESIGNER ASKED FOR:",
    String(note || ""),
    "",
    "THE SECTION IT WILL SIT NEXT TO — match its house style, classes and rhythm:",
    "```html",
    String(neighbour || "").slice(0, 8000),
    "```",
    "",
    "Rules:",
    "- Return ONE <section> element. Not a fragment, not several.",
    "- Reuse the utility classes you can see above (u-wrap, u-band, u-eyebrow and so on) rather than inventing a parallel set.",
    "- Real content, in this site's voice. No lorem ipsum, no placeholder brackets.",
    "- Do not add <script>, <iframe>, <form>, event handlers or javascript: URLs.",
    "- Any class you write a rule for MUST appear in the HTML, and any class in the HTML that needs styling MUST have a rule. A rule for a class nothing wears does nothing.",
    "- Keep the CSS to what this section needs. Selectors are confined to it automatically.",
    "",
    "Reply with ONLY a JSON object, no markdown fence:",
    '{"html":"<section>…</section>","css":"<css or empty string>","notes":"<one line on anything you could not do>"}',
  ].join("\n");

  const out = parseReply(await ai(prompt));
  if (!out.html.trim()) throw new Error("the model returned no markup for the new section");
  return { html: out.html, css: out.css, notes: out.notes };
}

module.exports = { patchSection, generateSection, deterministicEdit, swapImage, buildPrompt, parseReply, MAX_FRAGMENT };
