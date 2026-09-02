// Editing the page's shape rather than a section's contents.
//
// Everything else in this pipeline rewrites ONE section's html and writes it
// back to the same node id. That is what makes every other byte of the file
// identical by construction, and it is why a request to add, move or delete a
// section could not be carried out at all: there was no code that was allowed to
// change which nodes exist.
//
// This module is that code, and it is deliberately small and deliberately dumb.
// The operations below are arithmetic on an array — no model decides where a
// section goes, only what a new one says. A model that miscounts an index is a
// page with its sections in the wrong order; a model that writes bad markup is
// one bad section, caught by the checks that already exist.
//
// Shape this relies on, and verifies rather than assumes:
//
//   doc.elements      a flat array of `container` nodes, one per section
//   container.elements  that section's widgets, in practice a single html widget
//
// A page that does not look like that is left alone. Some sites are hand-built
// and some are older than this format, and quietly reorganising one because it
// did not match an assumption is exactly the kind of damage this pipeline exists
// not to do.
"use strict";
const crypto = require("crypto");

/** A container id that will not collide with compile.js's md5-derived ones. */
function newSectionId() {
  return crypto.randomBytes(4).toString("hex").slice(0, 7);
}

/**
 * Which top-level section holds this id.
 *
 * The reviewer clicks a widget, so the id in a note is usually the html widget's
 * rather than its container's. Both are accepted: what is wanted is the section
 * the click landed in.
 *
 * @returns {number} index into `elements`, or -1
 */
function sectionIndexOf(elements, id) {
  const want = String(id || "");
  if (!want) return -1;
  const holds = (node) => {
    if (!node || typeof node !== "object") return false;
    if (String(node.id) === want) return true;
    return (node.elements || []).some(holds);
  };
  return (elements || []).findIndex(holds);
}

/** Every node id in a subtree, in document order. */
function idsIn(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.id) out.push(String(node.id));
  for (const k of node.elements || []) idsIn(k, out);
  return out;
}

/** Every node id on the page, in document order. */
function allIds(elements) {
  const out = [];
  for (const n of elements || []) idsIn(n, out);
  return out;
}

/**
 * Does this page have the shape the operations below assume?
 *
 * Checked before every mutation rather than once at load, because the cost of
 * being wrong is a scrambled page and the check is a few comparisons.
 */
function isEditableShape(doc) {
  if (!doc || !Array.isArray(doc.elements) || !doc.elements.length) return false;
  return doc.elements.every((n) => n && n.elType === "container" && Array.isArray(n.elements));
}

/** A container wrapping one html widget, in the shape compile.js emits. */
function buildSection(html, { id, widgetId } = {}) {
  return {
    id: id || newSectionId(),
    elType: "container",
    settings: {},
    elements: [
      {
        id: widgetId || newSectionId(),
        elType: "widget",
        widgetType: "html",
        settings: { html: String(html || "") },
        elements: [],
      },
    ],
  };
}

/**
 * Put a new section next to an existing one.
 *
 * @param {object} doc         the page document, mutated in place
 * @param {object} arg
 * @param {string} arg.nearId  a node id inside the section to sit beside
 * @param {"before"|"after"} arg.position
 * @param {string} arg.html    the new section's markup
 * @returns {{ok: boolean, reason?: string, sectionId?: string, widgetId?: string}}
 */
function insertSection(doc, { nearId, position, html }) {
  if (!isEditableShape(doc)) return { ok: false, reason: "this page is not laid out as a list of sections, so a section cannot be added to it" };
  if (!String(html || "").trim()) return { ok: false, reason: "no markup was produced for the new section" };
  const at = sectionIndexOf(doc.elements, nearId);
  if (at < 0) return { ok: false, reason: "the section this note was left on is no longer on the page" };

  const section = buildSection(html);
  doc.elements.splice(position === "before" ? at : at + 1, 0, section);
  return { ok: true, sectionId: section.id, widgetId: section.elements[0].id };
}

/**
 * How many separate sections a container actually shows.
 *
 * The assumption that one top-level container is one section held for every page
 * this was built against, and then did not: one container turned out to hold two
 * html widgets rendering two visually distinct bands. Removing the container to
 * satisfy a note about one of them took both.
 *
 * Counted from the markup rather than the tree, because what a reviewer calls a
 * section is what they can see.
 */
function widgetsIn(container) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.elType === "widget" && n.settings && typeof n.settings.html === "string"
        && /<section\b/i.test(n.settings.html)) out.push(n);
    (n.elements || []).forEach(walk);
  };
  walk(container);
  return out;
}

/**
 * The html widget a given id belongs to.
 *
 * This is the unit a reviewer means by "this section": one widget, one visible
 * band. The container above it may hold several, and acting on the container is
 * how a note about one band removed two.
 */
function widgetFor(elements, id) {
  const want = String(id || "");
  let found = null;
  const walk = (n, holder) => {
    if (!n || typeof n !== "object" || found) return;
    const isWidget = n.elType === "widget" && n.settings && typeof n.settings.html === "string";
    const mine = isWidget ? n : holder;
    if (String(n.id) === want) { found = mine || n; return; }
    (n.elements || []).forEach((k) => walk(k, mine));
  };
  (elements || []).forEach((e) => walk(e, null));
  return found;
}

/**
 * Take a section off the page.
 *
 * Removes ONE visible section: the html widget the note points at, and its
 * container only if that leaves the container holding nothing.
 *
 * The earlier version removed the whole top-level container, on the assumption
 * that one container is one section. That is true of most pages and was not true
 * of the one it ran against: a container held two html widgets rendering two
 * distinct bands, so a note asking to remove one band removed both, and the
 * reviewer was told a section had gone that was not the one they had clicked.
 *
 * Refuses to empty the page. A page with no sections renders as a blank white
 * screen, which is a far larger change than the note asked for and one nobody
 * would notice until a client did.
 */
function removeSection(doc, { id }) {
  if (!isEditableShape(doc)) return { ok: false, reason: "this page is not laid out as a list of sections, so a section cannot be removed from it" };
  const at = sectionIndexOf(doc.elements, id);
  if (at < 0) return { ok: false, reason: "the section this note was left on is no longer on the page" };

  const container = doc.elements[at];
  const widget = widgetFor([container], id);
  const siblings = widgetsIn(container);

  // The ordinary case, and the one the old code got wrong: the container holds
  // more than the section being removed, so only that widget goes.
  if (widget && siblings.length > 1 && siblings.includes(widget)) {
    const parent = parentOf(container, widget.id);
    if (parent) {
      const k = parent.elements.findIndex((n) => n === widget);
      parent.elements.splice(k, 1);
      return { ok: true, removedIds: idsIn(widget), keptContainer: String(container.id) };
    }
  }

  if (doc.elements.length <= 1) return { ok: false, reason: "this is the only section on the page, and removing it would leave the page blank" };
  const [gone] = doc.elements.splice(at, 1);
  return { ok: true, removedIds: idsIn(gone) };
}

/** The node directly holding a child with this id. */
function parentOf(root, id) {
  const want = String(id);
  let hit = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || hit) return;
    if ((n.elements || []).some((k) => k && String(k.id) === want)) { hit = n; return; }
    (n.elements || []).forEach(walk);
  };
  walk(root);
  return hit;
}

/**
 * Move a section to sit beside another one.
 *
 * The target index is read AFTER the section is lifted out, because removing it
 * shifts everything below it up by one. Computing both indices first and then
 * splicing is the classic way to get this wrong by exactly one position.
 */
function moveSection(doc, { id, nearId, position }) {
  if (!isEditableShape(doc)) return { ok: false, reason: "this page is not laid out as a list of sections, so its sections cannot be reordered" };
  const from = sectionIndexOf(doc.elements, id);
  if (from < 0) return { ok: false, reason: "the section this note was left on is no longer on the page" };
  const anchorBefore = sectionIndexOf(doc.elements, nearId);
  if (anchorBefore < 0) return { ok: false, reason: "the section it was meant to move next to is not on this page" };
  if (anchorBefore === from) return { ok: false, reason: "that note asks to move a section next to itself" };

  const [moved] = doc.elements.splice(from, 1);
  const anchor = sectionIndexOf(doc.elements, nearId);   // re-read: indices shifted
  doc.elements.splice(position === "before" ? anchor : anchor + 1, 0, moved);
  return { ok: true, sectionId: String(moved.id) };
}

module.exports = {
  sectionIndexOf, allIds, idsIn, isEditableShape, buildSection, newSectionId,
  widgetsIn, widgetFor, parentOf,
  insertSection, removeSection, moveSection,
};
