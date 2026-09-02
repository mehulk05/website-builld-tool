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
const MOVE = /\b(move|reorder|re-order|shift|rearrange|swap)\b/i;

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

  const hasSectionWord = SECTION_WORD.test(text);
  const position = BEFORE.test(text) ? "before" : AFTER.test(text) ? "after" : null;

  // Remove is checked before add: "remove this section and add a new one" is
  // two operations, and this pipeline does one per note. Taking the removal
  // leaves the page smaller rather than larger, which is the easier of the two
  // to see and to undo.
  if (hasSectionWord && REMOVE.test(text)) {
    return { kind: "structure", op: "remove" };
  }

  // A move needs somewhere to go. Without a position word "move this up" is too
  // vague to act on, and guessing produces a page that changed for no reason the
  // reviewer can trace.
  if (hasSectionWord && MOVE.test(text)) {
    if (!position) {
      return {
        kind: "refuse",
        why: "structure:move-vague",
        reason: "it is not clear where this section should move to — say which section it should sit above or below.",
      };
    }
    return { kind: "structure", op: "move", position };
  }

  // An insert needs both: something section-shaped, and somewhere to put it.
  // "add a testimonial to this block" has the noun but no position, and is an
  // edit inside the section — which is exactly right, and why position is
  // required rather than defaulted.
  if (hasSectionWord && ADD.test(text) && position) {
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

module.exports = { classify, route };
