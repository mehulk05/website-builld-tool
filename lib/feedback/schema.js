// The annotation contract — what the browser is allowed to say about a click,
// and what the backend is allowed to believe.
//
// The existing content-review path sends exact text pairs, which can be applied
// in code with no model involved. Design feedback cannot: "make this button
// rounded" names an element and describes an intent. So an annotation carries
// two different kinds of claim, and they are trusted very differently:
//
//   Identity  — the Elementor element id under the click. Deterministic, stable
//               across deploys (compile.js derives it from slug+role+index), and
//               present both in the rendered DOM and as the node's `id` in
//               elementor.json. This is the ONLY thing used to find the target.
//
//   Evidence  — tag name, text, attributes, the child path within the section,
//               the rect. Never used to FIND anything. Used to confirm, at patch
//               time, that the section still holds what the reviewer was looking
//               at — and to tell the model which button of four they meant.
//
// Anything a page could lie about (the HTML itself) is deliberately not part of
// the contract. The backend re-reads the fragment from Git at patch time, so a
// tampered or merely stale browser payload cannot steer what gets written.
"use strict";
const crypto = require("crypto");

// Caps. A batch is one reviewer's session, not an import format.
const MAX_NOTE = 1000;
const MAX_ITEMS = 40;
const MAX_PATH_LEN = 200;
const MAX_TEXT_SAMPLE = 300;
const MAX_ATTRS = 12;
const MAX_ATTR_LEN = 200;
const MAX_CHILD_PATH = 24;

// Elementor ids are 7-char hex from compile.js, but hand-authored pages and
// gitops-json's own newId() produce other lengths — accept the shape, not a
// fixed width, and reject anything that could be a selector in disguise.
const ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const clean = (v, max) => str(v, max).replace(/\s+/g, " ").trim();

// A page path as the widget saw it, normalised the way reviewSwapTiers reads it
// (leading slash, no trailing slash, no query/hash). "/" stays "/" — that is the
// home page, not an empty path.
function normalisePath(p) {
  let s = str(p, MAX_PATH_LEN).trim();
  if (!s) return "/";
  s = s.split("#")[0].split("?")[0];
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+$/, "");
  return s || "/";
}

// The page slug resolve.js keys on.
//
// GitOps stores pages flat — one resources/pages/<slug>/ directory each, with no
// parent modelled anywhere — and a WordPress child page's slug is the LAST
// segment of its URL, not the first. So /services/botox/ is the page `botox`,
// which happens to sit under /services/.
//
// This used to take the FIRST segment, which meant a note left anywhere under
// /services/ was applied to the services listing page instead: the wrong page,
// edited confidently, with nothing in the run to suggest anything was amiss.
//
// A path whose last segment is not a page of its own (pagination, an archive)
// simply will not resolve, and resolve.js reports that as a conflict. Refusing
// is the right answer there — guessing at a parent is how this went wrong.
function pageSlug(p) {
  const parts = normalisePath(p).split("/").filter(Boolean);
  if (!parts.length) return "home";
  return parts[parts.length - 1].toLowerCase();
}

// The clicked element's own description. Evidence only — see the header.
function sanitiseTarget(t) {
  const T = t && typeof t === "object" ? t : {};
  const attrs = {};
  let n = 0;
  for (const [k, v] of Object.entries(T.attrs && typeof T.attrs === "object" ? T.attrs : {})) {
    if (n >= MAX_ATTRS) break;
    if (!/^[a-zA-Z][a-zA-Z0-9:_-]{0,40}$/.test(k)) continue;
    attrs[k] = str(v, MAX_ATTR_LEN);
    n++;
  }
  // Index path from the section wrapper down to the clicked node. Lets the
  // patch step say "the third link in this block" without trusting a selector.
  const childPath = Array.isArray(T.childPath)
    ? T.childPath.slice(0, MAX_CHILD_PATH).map((i) => Math.max(0, Math.min(999, Math.floor(Number(i) || 0))))
    : [];
  const rect = T.rect && typeof T.rect === "object" ? T.rect : {};
  const num = (v) => Math.round(Number(v) || 0);
  return {
    tag: clean(T.tag, 20).toLowerCase().replace(/[^a-z0-9-]/g, ""),
    text: clean(T.text, MAX_TEXT_SAMPLE),
    attrs,
    childPath,
    rect: { x: num(rect.x), y: num(rect.y), w: num(rect.w), h: num(rect.h) },
  };
}

// A stable fingerprint of the clicked element, independent of where it sits on
// screen. Two things use it: telling one of four identical-looking buttons from
// the others, and detecting that the section changed under a queued item.
function targetFingerprint(target) {
  const t = sanitiseTarget(target);
  const parts = [t.tag, t.text, t.childPath.join("."),
    Object.keys(t.attrs).sort().map((k) => `${k}=${t.attrs[k]}`).join("&")];
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

// A picture the reviewer attached. Only real raster images, only inline data —
// a URL here would let a note point the site at anything on the internet.
const IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;      // ~6MB of image, post-downscale

function normaliseImage(img) {
  if (!img || typeof img !== "object") return null;
  const dataUrl = String(img.dataUrl || "");
  if (!dataUrl || dataUrl.length > MAX_IMAGE_CHARS) return null;
  if (!IMAGE_RE.test(dataUrl)) return null;
  return {
    dataUrl,
    filename: clean(img.filename, 80).replace(/[^A-Za-z0-9._-]/g, "") || "image",
  };
}

/**
 * Normalise one annotation from the browser. Returns null when the item cannot
 * be acted on at all — a missing id or an empty note is not a conflict to
 * report later, it is nothing to do now.
 */
function normaliseItem(raw, i) {
  const R = raw && typeof raw === "object" ? raw : {};
  const elementId = clean(R.elementId, 32);
  const note = str(R.note, MAX_NOTE).trim();
  if (!ID_RE.test(elementId) || !note) return null;
  const target = sanitiseTarget(R.target);
  return {
    // Stable within a batch, so the ledger, the PR body and the widget can all
    // name the same item. Not a global id — the store adds that.
    localId: `i${i + 1}`,
    page: normalisePath(R.page),
    slug: pageSlug(R.page),
    elementId,
    note,
    // What the widget told the reviewer they were pointing at. Evidence, like
    // `target` — never used to FIND anything, only to name it in the report.
    // It matters most for notes refused before the page is read: those never
    // touch the markup, so the section cannot be worked out afterwards.
    section: clean(R.section, 60),
    target,
    fingerprint: targetFingerprint(R.target),
    // A replacement picture the reviewer chose from their own machine. Held as
    // a data URL only until the server writes it to disk — a blob this size has
    // no business in the ledger, so store.js keeps the resulting URL instead.
    image: normaliseImage(R.image),
    status: "queued",
  };
}

/**
 * Normalise a whole submitted batch. `changes` (exact text pairs) stay in their
 * existing shape and are NOT touched here — this module only owns annotations.
 *
 * @returns {{items: object[], dropped: number}}
 */
function normaliseBatch(rawItems) {
  const list = Array.isArray(rawItems) ? rawItems.slice(0, MAX_ITEMS) : [];
  const items = [];
  let dropped = 0;
  list.forEach((raw, i) => {
    const item = normaliseItem(raw, i);
    if (item) items.push(item); else dropped++;
  });
  return { items, dropped };
}

/**
 * Group normalised items by the page they were left on, preserving order.
 * Every downstream step is per-page (resolve reads one elementor.json, the
 * swap tiers are per-page), so this is the shape the rest of the pipeline wants.
 */
function groupByPage(items) {
  const byPage = new Map();
  for (const it of items) {
    if (!byPage.has(it.slug)) byPage.set(it.slug, { slug: it.slug, page: it.page, items: [] });
    byPage.get(it.slug).items.push(it);
  }
  return [...byPage.values()];
}

/** Group one page's items by the section they landed on. */
function groupBySection(items) {
  const byId = new Map();
  for (const it of items) {
    if (!byId.has(it.elementId)) byId.set(it.elementId, { elementId: it.elementId, items: [] });
    byId.get(it.elementId).items.push(it);
  }
  return [...byId.values()];
}

module.exports = {
  MAX_NOTE, MAX_ITEMS, ID_RE, MAX_IMAGE_CHARS,
  normalisePath, pageSlug, sanitiseTarget, targetFingerprint, normaliseImage,
  normaliseItem, normaliseBatch, groupByPage, groupBySection,
};
