// Asking for CSS that applies to the whole site.
//
// The first version of this reused patchSection, which was wrong in two ways
// that only showed up once real rules reached a real page:
//
//   * patchSection confines what it produces to one section. It prefixes every
//     selector with `.elementor-element-<id>`, which is exactly right for a note
//     about one block and exactly wrong here — the rules shipped scoped to a
//     container that does not exist, and did nothing.
//
//   * it was handed an empty <div> as the section to work from, so the model had
//     no idea what the site's markup looks like. Asked to round the buttons it
//     wrote rules for `button`, `.btn` and `[type=submit]`, none of which this
//     site uses. It uses `.c-btn`.
//
// So this asks directly, shows the model markup the site actually contains, and
// does not scope the answer. What it does keep is the safety half of checkCss:
// site-wide is a bigger blast radius than one section, not a smaller one.
"use strict";

// Rules that must never ship, whatever they are scoped to. The section-level
// checker refuses these too; the reasons are the same and worth restating rather
// than importing a scoping function that would undo the point of this file.
const UNSAFE = [
  [/@import\b/i, "@import pulls in a stylesheet from somewhere else"],
  [/expression\s*\(/i, "expression() runs script from a stylesheet"],
  [/javascript:/i, "javascript: URLs do not belong in a stylesheet"],
  [/<\s*\/?\s*(script|style)\b/i, "that is markup, not CSS"],
  [/\bposition\s*:\s*fixed\b/i, "a site-wide fixed position covers the page on every screen"],
];

const MAX_BYTES = 8 * 1024;

/**
 * Check CSS that will apply to every page.
 *
 * Deliberately NOT checkCss: that one confines rules to a section, which is the
 * opposite of the intent here. What carries over is the part about what CSS may
 * contain at all.
 *
 * `html` and `body` selectors are allowed here and refused at section level, for
 * the same reason in both cases: at section level they escape the section, and
 * here escaping is the point.
 */
function checkSiteCss(css) {
  const s = String(css || "").trim();
  if (!s) return { ok: false, reason: "no styling was written" };
  if (s.length > MAX_BYTES) return { ok: false, reason: "that is more styling than one note should produce" };
  for (const [re, why] of UNSAFE) if (re.test(s)) return { ok: false, reason: why };
  if (!/\{[^}]*\}/.test(s)) return { ok: false, reason: "that does not look like CSS rules" };
  return { ok: true, css: s };
}

/**
 * Markup for the model to write selectors against.
 *
 * Real sections from the real site, not a placeholder. Without this the model
 * guesses at class names, and CSS written against classes the site does not use
 * is indistinguishable from CSS that was never applied.
 *
 * Trimmed hard: enough to see the vocabulary, not so much that the useful part
 * is buried.
 */
function markupSample(htmls, budget = 6000) {
  const out = [];
  let used = 0;
  for (const html of htmls) {
    const h = String(html || "");
    // The hidden stylesheet carrier is not page markup and would fill the whole
    // budget with rules the model does not need to read back.
    if (/data-g99-css/i.test(h)) continue;
    const take = h.slice(0, 1800);
    if (used + take.length > budget) break;
    out.push(take);
    used += take.length;
  }
  return out.join("\n\n");
}

function buildPrompt(note, sample) {
  return [
    "You are writing CSS that will apply to EVERY page of one website.",
    "",
    "WHAT THE DESIGNER ASKED FOR:",
    String(note || ""),
    "",
    "MARKUP FROM THIS SITE — write your selectors against the classes you can see here:",
    "```html",
    sample,
    "```",
    "",
    "Rules:",
    "- Use the class names that are actually in the markup above. This site has its own vocabulary; generic selectors like `button` or `.btn` will match nothing.",
    "- Do NOT scope rules to a section. These are meant to apply everywhere.",
    "- Change only what was asked. Site-wide rules are hard to see and easy to regret.",
    "- No @import, no position:fixed, no javascript: URLs.",
    "- Use !important only where the site's own rules would otherwise win.",
    "",
    "Reply with ONLY a JSON object, no markdown fence:",
    '{"css":"<the rules>","targets":"<which classes you targeted and why>"}',
  ].join("\n");
}

/** Pull the object out of a reply that may be fenced or prefaced. */
function parse(text) {
  let s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const at = s.indexOf("{");
  if (at > 0) s = s.slice(at);
  const end = s.lastIndexOf("}");
  if (end > 0) s = s.slice(0, end + 1);
  const j = JSON.parse(s);
  return { css: typeof j.css === "string" ? j.css : "", targets: typeof j.targets === "string" ? j.targets.slice(0, 200) : "" };
}

/**
 * Write site-wide CSS for one note.
 *
 * @param {object} arg
 * @param {string} arg.note
 * @param {string[]} arg.markup  section markup from the site, for vocabulary
 * @param {function} arg.ai
 * @returns {Promise<{ok: boolean, css?: string, targets?: string, reason?: string}>}
 */
async function writeFor({ note, markup, ai }) {
  const sample = markupSample(markup || []);
  if (!sample.trim()) return { ok: false, reason: "this site has no page markup to write styling against" };
  let out;
  try { out = parse(await ai(buildPrompt(note, sample))); }
  catch (e) { return { ok: false, reason: `the styling could not be written (${String(e.message).slice(0, 120)})` }; }

  const check = checkSiteCss(out.css);
  if (!check.ok) return { ok: false, reason: `that styling was rejected: ${check.reason}` };

  // A rule naming a class nothing on the site wears is dead, exactly as it is at
  // section level — and here the reviewer has no single section to look at to
  // notice. The whole sample is the haystack.
  const classes = new Set();
  for (const m of sample.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    for (const c of String(m[2] || m[3] || "").split(/\s+/)) if (c) classes.add(c);
  }
  const dead = [];
  for (const m of check.css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@")) continue;
    const hooks = [...sel.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((x) => x[1]);
    if (!hooks.length) continue;                    // element or attribute selector
    if (hooks.some((h) => classes.has(h))) continue;
    dead.push(sel);
  }
  if (dead.length && dead.length >= [...check.css.matchAll(/[^{}]+\{[^{}]*\}/g)].length) {
    return { ok: false, reason: `the styling targets ${dead[0]}, which nothing on this site uses — so it would have changed nothing` };
  }

  return { ok: true, css: check.css, targets: out.targets };
}

module.exports = { writeFor, checkSiteCss, markupSample, buildPrompt, parse };
