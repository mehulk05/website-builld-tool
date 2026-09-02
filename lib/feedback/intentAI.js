// Reading a note with a model instead of a word list.
//
// The keyword classifier in intent.js works, and will keep working, but it reads
// the phrasings it was written against. A designer writing "shift the reviews
// block up a bit" or "this needs a picture" is asking for something the tool can
// do and getting a section rewrite, because none of the words match.
//
// So the model reads it first and the keywords stay as the fallback. That order
// matters: this call can fail, time out, or come back as prose, and none of
// those should cost the reviewer their note. Every failure lands back on the
// classifier that was already good enough for the common case.
//
// What the model is NOT asked to do:
//
//   * choose an index. Where a section goes is arithmetic, done in structure.js.
//     A model that miscounts produces a page in the wrong order and nothing
//     downstream would catch it.
//   * write markup. That is generateSection's job, with its own checks.
//
// It reads a sentence and returns a shape. Everything it returns is validated
// against a closed set before anything acts on it, because a model that invents
// an operation name should fail into the fallback rather than into a branch
// nobody wrote.
"use strict";
const KEYWORDS = require("./intent");

const OPS = new Set(["section", "structure", "sitecss", "seo", "nav", "page", "image"]);
const STRUCT_OPS = new Set(["insert", "remove", "move"]);
const POSITIONS = new Set(["before", "after"]);

function buildPrompt(note, context) {
  return [
    "Read one instruction from a designer reviewing a web page, and say what kind of change it asks for.",
    "",
    "THE INSTRUCTION:",
    String(note || ""),
    "",
    context && context.sections && context.sections.length
      ? `Sections on this page, in order: ${context.sections.join(", ")}`
      : "",
    "",
    "Answer with ONE of these kinds:",
    '  "section"    change something inside the section they clicked: wording, colour, spacing, a link, an image',
    '  "structure"  add, remove or reorder whole sections of this page',
    '  "sitecss"    a styling change meant for the whole site, not one section ("every button", "all headings")',
    '  "seo"        the page\'s meta title or description',
    '  "nav"        the site navigation or menu',
    '  "page"       create a new page',
    '  "image"      add or replace a picture',
    "",
    "For structure, also give:",
    '  op        "insert" | "remove" | "move"',
    '  position  "before" | "after"   (which side of the clicked section)',
    '  target    the name of the section it should sit next to, if they named one, else ""',
    "",
    "For seo, give whichever of title / description they specified.",
    "For page, give the page title they asked for.",
    "",
    "Rules:",
    "- If it could be a change inside one section, say \"section\". That is the common case.",
    "- Do not guess a position. If they did not say above or below, leave it out.",
    "- Answer only for what is written. Do not infer a second change they did not ask for.",
    "",
    "Reply with ONLY a JSON object, no markdown fence:",
    '{"kind":"section","op":"","position":"","target":"","title":"","description":"","confidence":0.0}',
  ].filter(Boolean).join("\n");
}

/** Pull the object out of a reply that may be fenced or prefaced. */
function parse(text) {
  let s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const at = s.indexOf("{");
  if (at > 0) s = s.slice(at);
  const end = s.lastIndexOf("}");
  if (end > 0) s = s.slice(0, end + 1);
  return JSON.parse(s);
}

/**
 * Turn a model's answer into an intent, or return null.
 *
 * Null is not a failure to handle specially — it is the signal to use the
 * keyword classifier, which is what happens for anything unrecognised. That is
 * why this is strict: a half-understood answer acted on is worse than a
 * well-understood fallback.
 */
function toIntent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").toLowerCase();
  if (!OPS.has(kind)) return null;

  if (kind === "structure") {
    const op = String(raw.op || "").toLowerCase();
    if (!STRUCT_OPS.has(op)) return null;
    const position = POSITIONS.has(String(raw.position || "").toLowerCase())
      ? String(raw.position).toLowerCase() : null;
    // Insert and move need a side to land on. Without one this is not actionable
    // and the keyword path's refusal ("say which section it should sit above or
    // below") is a better answer than a coin toss.
    if ((op === "insert" || op === "move") && !position) return null;
    return { kind: "structure", op, position, target: String(raw.target || "").trim().slice(0, 60) };
  }

  if (kind === "seo") {
    const title = String(raw.title || "").trim();
    const description = String(raw.description || "").trim();
    if (!title && !description) return null;
    return { kind: "seo", title, description };
  }

  if (kind === "page") {
    const title = String(raw.title || "").trim();
    if (!title) return null;
    return { kind: "page", title };
  }

  return { kind };
}

/**
 * Classify one note, model first, keywords second.
 *
 * @param {string} note
 * @param {object} opts
 * @param {function} opts.ai        async (prompt) => string
 * @param {string[]} [opts.sections] section names on the page, to help it read
 *                                   "above the pricing section"
 * @returns {Promise<object>} always an intent; never throws
 */
async function classify(note, { ai, sections } = {}) {
  const fallback = KEYWORDS.classify(note);
  if (typeof ai !== "function") return fallback;
  try {
    const out = toIntent(parse(await ai(buildPrompt(note, { sections }))));
    if (!out) return fallback;
    // A model saying "section" adds nothing over the fallback saying it, and the
    // fallback may have found a structural reading the model missed. Preferring
    // the fallback here costs nothing and keeps the well-tested path in charge
    // of the case it was built for.
    if (out.kind === "section" && fallback.kind !== "section") return fallback;

    // The reverse guard, and the more important one.
    //
    // Removal is the only operation here with no undo the reviewer can reach,
    // and the model reaches for it too readily: "Remove this card" is a change
    // INSIDE a section — a card is not a section — and it was read as an
    // instruction to take the whole band off the page, which is what it then
    // did to a live site.
    //
    // So a removal the model proposes has to be corroborated by the note's own
    // words: the keyword classifier must also have seen a section-level
    // removal, which it only does when the note names something section-shaped
    // and the removal verb is not negated. When it did not, the note is treated
    // as what it most likely is — an edit within the section that was clicked.
    if (out.kind === "structure" && out.op === "remove"
        && !(fallback.kind === "structure" && fallback.op === "remove")) {
      return fallback;
    }
    // A named target the model found is worth keeping even when the words alone
    // did not yield one: "take the reviews band off" is unambiguous about which
    // band, and the keyword extractor only reads the phrasings it was built for.
    if (out.kind === "structure" && out.op === "remove" && !out.target && fallback.target) {
      return { ...out, target: fallback.target };
    }
    return out;
  } catch (e) {
    return fallback;
  }
}

module.exports = { classify, buildPrompt, parse, toIntent, OPS };
