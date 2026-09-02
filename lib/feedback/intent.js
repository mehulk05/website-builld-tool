// What a note is asking for, decided before anything acts on it.
//
// There are three kinds of note and they need three different pipelines:
//
//   section     change something inside the section it was left on. The original
//               path, and still the overwhelming majority.
//   structure   change which sections exist, or their order. Arithmetic on the
//               page's element array, with only the new markup coming from a
//               model.
//   refuse      something this tool does not do at all — navigation, metadata,
//               a change meant for every page, a new page.
//
// Before this existed, everything was a section edit. A structural request was
// handed to the section rewriter anyway, which did the only thing it could and
// put the content inside; the change was real, so it was reported as applied.
// scope.js stopped that by refusing those notes outright. This goes further: the
// ones that are now possible get routed instead of turned down.
//
// Deliberately still a keyword pass. The routing decision is cheap to get wrong
// in one direction and expensive in the other:
//
//   * A structural note read as a section edit is the old bug, so the patterns
//     for structure are the ones worth being generous with.
//   * A section edit read as structural would rebuild a section that only needed
//     a colour changed, so those patterns must be specific: a position word, or
//     the word "section" itself, and not merely "add" or "move".
//
// When a note matches nothing here it is a section edit, which is both the
// common case and the safe one — the section rewriter changes one node and
// every check downstream already assumes it.
"use strict";
const SCOPE = require("./scope");

// Where a new or moved section should land relative to the one clicked.
const BEFORE = /\b(above|before|on top of|over|preceding)\b/i;
const AFTER = /\b(below|under|beneath|after|underneath)\b/i;

// A section-level noun. "block" and "band" are what designers actually say.
const SECTION_WORD = /\b(section|band|strip|row|block)\b/i;

const ADD = /\b(add|insert|create|put|place|need)\b/i;
const REMOVE = /\b(delete|remove|get rid of|take out|drop)\b/i;

// A removal word inside a sentence that forbids removing.
//
// "add a testimonials section, but don't remove clinical excellence" contains
// every word a removal contains. Read without this, it removed the section the
// reviewer had just asked to keep — the one failure in this pipeline that turns
// a note into the opposite of what it says.
//
// Only the negated verb is masked, not the sentence: "remove the pricing band,
// don't remove anything else" is still a removal, because the first verb
// survives the mask.
const NEGATED_REMOVE =
  /\b(?:don'?t|do not|dont|never|without|instead of|rather than|avoid|not)\b[^.;!?]{0,24}?\b(?:delete|remove|get rid of|take out|drop|removing|deleting|dropping)\b/gi;

/** The note with any forbidden removal blanked out, for the verb tests only. */
function maskNegations(text) {
  return String(text || "").replace(NEGATED_REMOVE, " ");
}
const MOVE = /\b(move|reorder|re-order|shift|rearrange|swap)\b/i;

/**
 * The section a move is aimed at, in the reviewer's own words.
 *
 * "move this above the pricing section" names where it should end up. Reading
 * that is the difference between a move a designer can direct and one that
 * shuffles by a single position and hopes.
 *
 * Only the words BETWEEN the direction and the end are taken — "above the
 * pricing section" yields "pricing" — and the section noun is dropped, because
 * a section's own label is "Pricing", not "Pricing section".
 *
 * Returns "" when the note names nothing, which is the "move it one place"
 * case and stays supported: not every reviewer will name a landmark.
 */
function moveTarget(text, position) {
  const dir = position === "before" ? BEFORE : AFTER;
  const m = String(text || "").match(dir);
  if (!m) return "";
  const after = String(text).slice(m.index + m[0].length);
  return after
    .replace(/[.!?].*$/s, "")
    .replace(/\b(the|a|an|our|its)\b/gi, " ")
    .replace(/\b(section|band|strip|row|block|one)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * The section a removal names, if it names one.
 *
 * "Remove this section" points at the click. "Remove our services section"
 * points at a section by name, and the name has to win: a reviewer who typed
 * the words was more deliberate than a reviewer whose cursor happened to land
 * somewhere. Ignoring them removed the wrong section twice on a live site —
 * once when the note said "this", which was fair, and once when it said
 * "our services", which was not.
 *
 * Returns "" for "this"/"that"/"the" phrasings, which is the click's case and
 * stays supported.
 */
function removeTarget(text) {
  const m = String(text || "").match(
    /\b(?:delete|remove|get rid of|take out|drop)\b\s+(.{1,60}?)\s*(?:section|band|strip|row|block)\b/i);
  if (!m) return "";
  const name = m[1]
    .replace(/\b(the|this|that|a|an|our|its|whole|entire)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.slice(0, 60);
}

/**
 * Read a note.
 *
 * @param {string} note the reviewer's own words
 * @returns {{kind: "section"}
 *          |{kind: "structure", op: "insert"|"remove"|"move", position?: "before"|"after"}
 *          |{kind: "refuse", reason: string, why: string}}
 */
function classify(note) {
  const text = String(note || "");

  // Things this tool does not do at all are decided first, so that "add a new
  // page" is not mistaken for "add a new section".
  const out = SCOPE.outOfScope(text);
  if (out && !out.kind.startsWith("structure:")) {
    return { kind: "refuse", reason: out.reason, why: out.kind };
  }

  // Verb tests read the note with forbidden removals blanked out. Everything
  // else — targets, positions, the markup a model is shown — reads the original.
  const verbs = maskNegations(text);
  const hasSectionWord = SECTION_WORD.test(text);
  const position = BEFORE.test(text) ? "before" : AFTER.test(text) ? "after" : null;

  // Remove is checked before add: "remove this section and add a new one" is
  // two operations, and this pipeline does one per note. Taking the removal
  // leaves the page smaller rather than larger, which is the easier of the two
  // to see and to undo.
  if (hasSectionWord && REMOVE.test(verbs)) {
    return { kind: "structure", op: "remove", target: removeTarget(verbs) };
  }

  // A move needs somewhere to go. Without a position word "move this up" is too
  // vague to act on, and guessing produces a page that changed for no reason the
  // reviewer can trace.
  if (hasSectionWord && MOVE.test(verbs)) {
    if (!position) {
      return {
        kind: "refuse",
        why: "structure:move-vague",
        reason: "it is not clear where this section should move to — say which section it should sit above or below.",
      };
    }
    return { kind: "structure", op: "move", position, target: moveTarget(text, position) };
  }

  // An insert needs both: something section-shaped, and somewhere to put it.
  // "add a testimonial to this block" has the noun but no position, and is an
  // edit inside the section — which is exactly right, and why position is
  // required rather than defaulted.
  if (hasSectionWord && ADD.test(verbs) && position) {
    return { kind: "structure", op: "insert", position };
  }

  return { kind: "section" };
}

/**
 * Sort a batch by which pipeline each note belongs to.
 *
 * @param {object[]} items normalised annotations
 * @returns {{section: object[], structure: object[], refuse: object[]}}
 *          structure items carry `.intent`; refused ones carry `.reason`
 */
function route(items) {
  const section = [];
  const structure = [];
  const refuse = [];
  for (const item of items || []) {
    const verdict = classify(item && item.note);
    if (verdict.kind === "refuse") refuse.push({ item, reason: verdict.reason, kind: verdict.why });
    else if (verdict.kind === "structure") structure.push({ item, intent: verdict });
    else section.push(item);
  }
  return { section, structure, refuse };
}

module.exports = {
  maskNegations, NEGATED_REMOVE, classify, route };
