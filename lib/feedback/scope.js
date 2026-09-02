// What this pipeline cannot do, recognised before it pretends otherwise.
//
// A note is applied by rewriting ONE section's html and writing it back to the
// same node id. That is what keeps every other byte of the page identical by
// construction. It also means a whole class of perfectly reasonable requests
// cannot be carried out: anything about the page's structure rather than a
// section's contents, and anything outside the page altogether.
//
// Until this module existed, those notes were not refused — they were handed to
// the model anyway, which did the only thing available to it and edited the
// section. Asked to "add a section above this", it put the content inside; the
// change was real, so it was reported as applied, and the reviewer walked away
// believing something had happened that had not. A note that quietly means
// something else is worse than a note that is turned down.
//
// This is deliberately a keyword pass and not a classifier. It is wrong in both
// directions and is meant to be:
//
//   * It refuses only phrasings that are unmistakably out of scope. "add a
//     testimonial" stays in scope, because adding content INSIDE a section is
//     something this pipeline does well; "add a new section below this" does
//     not, because it is not.
//   * Anything it fails to catch behaves exactly as it does today. This makes
//     the tool honest more often, not always.
//
// A real intent classifier (plan task A1) replaces this. Until then, being
// conservative is the point: a note wrongly refused costs the reviewer one
// rephrase, and they are told why. A note wrongly accepted costs them their
// trust in every other line of the report.
"use strict";

// Each rule is [name, test, what the reviewer is told].
//
// The reasons are written to the reviewer, not to us: they say what cannot be
// done and, where there is one, what to do instead. Naming the limitation is
// what lets someone work around it rather than repeat themselves.
const RULES = [
  [
    "structure:add",
    // A position word is what makes this structural. Without one, "add a
    // pricing block" is content inside a section, which is fine.
    /\b(add|insert|create|put|place)\b[^.?!]{0,60}?\b(new\s+)?(section|band|row|strip)\b/i,
    "a whole new section can only be added by hand today — this tool rewrites sections that already exist, it cannot create one. Written as a change to an existing section (\"put testimonials in this block\"), it can be done.",
  ],
  [
    "structure:move",
    /\b(move|reorder|re-order|swap|shift|rearrange)\b[^.?!]{0,60}?\b(section|block|band|it|this)\b[^.?!]{0,40}?\b(above|below|before|after|up|down|top|bottom|first|last)\b/i,
    "sections cannot be reordered from here — each note is applied inside the section it was left on, and the order of sections on the page is not something this tool changes.",
  ],
  [
    "structure:remove",
    /\b(delete|remove|get rid of|take out)\b[^.?!]{0,40}?\b(this\s+|the\s+|whole\s+|entire\s+)*(section|band)\b/i,
    "a section cannot be deleted from here. Removing something INSIDE a section (a button, an image, a line) can be, so say which part should go.",
  ],
  [
    "page:new",
    /\b(add|create|make|need)\b[^.?!]{0,40}?\b(new\s+|another\s+)\b[^.?!]{0,20}?\bpage\b/i,
    "new pages are not created from review notes — this tool only edits pages that already exist.",
  ],
  [
    "nav",
    // "header" alone is excluded on purpose: "make the header text bigger" is an
    // ordinary section edit and must not be caught here.
    /\b(nav|navbar|navigation|menu\s*bar|main\s*menu|top\s*menu|footer\s*menu)\b/i,
    "the navigation is not edited from review notes — it lives in the site's menu settings, not in the page this note was left on.",
  ],
  [
    "seo",
    /\b(seo|meta\s*(title|description|tag|keywords)|og:|open\s*graph|schema\s*markup|canonical)\b/i,
    "page metadata is not edited from review notes — it is stored separately from the page's content.",
  ],
  [
    "global",
    /\b(all|every|each)\s+(the\s+|our\s+)?pages?\b|\bsite[\s-]?wide\b|\bacross the (whole )?site\b|\beverywhere on the site\b/i,
    "a note applies to the page it was left on. To change something on several pages, leave the note on each one — or say it once here and it will be applied here only.",
  ],
];

/**
 * Decide whether a note asks for something this pipeline cannot do.
 *
 * @param {string} note the reviewer's own words
 * @returns {{kind: string, reason: string}|null} null when the note is in scope
 */
function outOfScope(note) {
  const text = String(note || "");
  if (!text.trim()) return null;
  for (const [kind, test, reason] of RULES) {
    if (test.test(text)) return { kind, reason };
  }
  return null;
}

/**
 * Split a batch into notes worth attempting and notes to turn down.
 *
 * Done before anything is resolved or sent to a model, so an out-of-scope note
 * costs nothing and cannot half-happen.
 *
 * @param {object[]} items normalised annotations
 * @returns {{keep: object[], refuse: {item: object, reason: string, kind: string}[]}}
 */
function partition(items) {
  const keep = [];
  const refuse = [];
  for (const item of items || []) {
    const verdict = outOfScope(item && item.note);
    if (verdict) refuse.push({ item, reason: verdict.reason, kind: verdict.kind });
    else keep.push(item);
  }
  return { keep, refuse };
}

module.exports = { outOfScope, partition, RULES };
