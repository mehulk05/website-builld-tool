// The parts of a site that are not one section's markup.
//
// Every request this pipeline used to refuse traced to the same gap: there was
// code to rewrite a section and code to reorder sections, and nothing that could
// write anywhere else. Understanding the ask worked; finding the target worked;
// only the writers were missing. This file is those writers.
//
// Two of them turned out to be smaller than expected, because the site already
// had a home for what they needed:
//
//   Site-wide CSS   compile.js emits a hidden <div data-g99-css><style> carrier
//                   as the FIRST section of every page. kses strips a stored
//                   <script> or bare <style>, so this carrier is how CSS reaches
//                   the page at all. Writing site-wide rules means writing into
//                   the carrier this system already relies on — not inventing a
//                   second mechanism beside it.
//
//   Navigation      menus.json exists and is empty; nothing reads it on a GitOps
//                   site. The nav is inlined into each page's own markup, which
//                   means a menu change is a section edit applied to every page,
//                   not a new resource type. Writing a menus.json adapter would
//                   have produced a file the site ignores.
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("../../gitops-json");

// ---------------------------------------------------------------- site CSS ---

// The marker compile.js writes around the carrier's contents.
const CSS_OPEN = "/* g99 feedback: site-wide */";
const CSS_CLOSE = "/* end site-wide */";

/**
 * Is this section the hidden stylesheet carrier?
 *
 * Identified by the attribute compile.js writes, not by position: a page whose
 * first section is something else must not have styles written into its hero.
 */
function isCssCarrier(html) {
  return /data-g99-css/i.test(String(html || ""));
}

/**
 * Add or replace this pipeline's block of site-wide CSS on one page.
 *
 * Appended inside the existing <style>, behind its own markers, so the rules
 * compile.js generated stay exactly as they were and a second run replaces only
 * what the first one added.
 *
 * @returns {{html: string}|null} null when the page has no carrier to write into
 */
function writeSiteCss(html, css) {
  const src = String(html || "");
  if (!isCssCarrier(src)) return null;
  const rules = String(css || "").trim();
  if (!rules) return null;

  const block = `\n${CSS_OPEN}\n${rules}\n${CSS_CLOSE}\n`;
  const from = src.indexOf(CSS_OPEN);
  if (from > -1) {
    const to = src.indexOf(CSS_CLOSE, from);
    if (to > -1) return { html: src.slice(0, from) + block.trim() + src.slice(to + CSS_CLOSE.length) };
  }
  // First time: put it at the end of the stylesheet, so it wins over the
  // generated rules by order rather than by having to out-specify them.
  const close = src.lastIndexOf("</style>");
  if (close < 0) return null;
  return { html: src.slice(0, close) + block + src.slice(close) };
}

// -------------------------------------------------------------------- SEO ---

// What each provider calls its two fields. Only Rank Math is seen in practice;
// the map exists so a site on a different plugin fails by writing nothing rather
// than by writing keys that plugin will never read.
const SEO_FIELDS = {
  rank_math: { title: "rank_math_title", description: "rank_math_description" },
  yoast: { title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc" },
};

/**
 * Set a page's meta title or description.
 *
 * @param {string} root  the cloned repository
 * @param {string} slug  page slug
 * @param {{title?: string, description?: string}} fields
 * @returns {{ok: boolean, reason?: string, file?: string, changed?: string[]}}
 */
function writeSeo(root, slug, fields) {
  const rel = `resources/pages/${slug}/seo.json`;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: `this site has no SEO settings for the ${slug} page` };

  let doc;
  try { doc = G.readJson(abs); }
  catch (e) { return { ok: false, reason: `${rel} could not be read (${e.message})` }; }

  const map = SEO_FIELDS[String(doc.provider || "rank_math")];
  if (!map) return { ok: false, reason: `this site uses ${doc.provider} for SEO, which this tool does not write yet` };

  doc.fields = doc.fields || {};
  const changed = [];
  // A meta title over ~60 characters and a description over ~160 are truncated
  // in search results. Trimming quietly would hide that from the reviewer, so
  // the value is written as given and the length is reported instead.
  if (fields.title) { doc.fields[map.title] = String(fields.title).slice(0, 200); changed.push("title"); }
  if (fields.description) { doc.fields[map.description] = String(fields.description).slice(0, 400); changed.push("description"); }
  if (!changed.length) return { ok: false, reason: "that note does not say what the title or description should become" };

  G.writeJson(abs, doc);
  return { ok: true, file: rel, changed };
}

// ------------------------------------------------------------------ pages ---

const RESERVED = new Set(["wp-admin", "wp-content", "wp-json", "wp-includes", "feed", "admin"]);

/** A slug WordPress will accept and nothing else on the site is using. */
function freeSlug(root, wanted) {
  const base = String(wanted || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!base || RESERVED.has(base)) return "";
  const dir = path.join(root, "resources", "pages");
  let slug = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, slug))) { slug = `${base}-${n}`; n++; }
  return slug;
}

/**
 * The chrome every page on this site carries for itself.
 *
 * There is no shared template here: each page holds its own copy of the hidden
 * stylesheet, the navigation and the footer, inline, as ordinary sections. A
 * page written without them is not a plainer page — it is an unstyled fragment
 * with no way in and no way out, which is exactly what the first version of
 * createPage produced.
 *
 * Ids are regenerated. Every page here has its own ids for its own copies, and
 * two pages sharing one would give the reconciler two homes for the same node.
 */
function chromeFrom(doc) {
  const els = (doc && doc.elements) || [];
  const kind = (el) => {
    const w = (el.elements || []).find((k) => k && k.settings && typeof k.settings.html === "string");
    const h = (w && w.settings.html) || "";
    if (/data-g99-css/i.test(h)) return "css";
    if (/<nav\b/i.test(h)) return "nav";
    if (/<footer\b/i.test(h)) return "footer";
    return "content";
  };
  // Leading chrome is whatever sits before the first content section; trailing
  // chrome is whatever follows the last one. Read by position rather than by a
  // fixed count, because pages differ in how many nav blocks they carry.
  const kinds = els.map(kind);
  const first = kinds.findIndex((k) => k === "content");
  const last = kinds.lastIndexOf("content");
  if (first < 0) return { head: [], tail: [] };
  return {
    head: els.slice(0, first).map(reId),
    tail: els.slice(last + 1).map(reId),
  };
}

/** A deep copy with fresh ids, so nothing is shared between two pages. */
function reId(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.id) n.id = require("./structure").newSectionId();
    (n.elements || []).forEach(walk);
  };
  walk(copy);
  return copy;
}

/**
 * Create a page.
 *
 * A page is four things, and leaving any of them out produces something that
 * imports without error and is broken in a way nobody notices until a client
 * does: the row itself, its content, its metadata, and a way to reach it.
 *
 * The content is placed between the donor page's chrome, and the donor's
 * page-level CSS comes with it — without that stylesheet the markup renders as
 * unstyled text, since every rule this site has lives in the page rather than in
 * a theme.
 *
 * The nav is NOT edited here. Adding a link to it means rewriting the navigation
 * on every page, which is a separate operation with its own failure modes; doing
 * both silently means half a change when one of them fails.
 *
 * @returns {{ok: boolean, reason?: string, slug?: string, files?: string[], linked?: boolean}}
 */
function createPage(root, { title, slug, html, css, donorSlug }) {
  const name = String(title || "").trim();
  if (!name) return { ok: false, reason: "a new page needs a title" };
  const use = freeSlug(root, slug || name);
  if (!use) return { ok: false, reason: `"${slug || name}" cannot be used as a page address` };
  if (!String(html || "").trim()) return { ok: false, reason: "no markup was produced for the new page" };

  // Somewhere to copy the chrome and the stylesheet from. Any real page will do;
  // they all carry the same header and footer.
  const pagesDir = path.join(root, "resources", "pages");
  const candidates = donorSlug ? [donorSlug] : [];
  if (fs.existsSync(pagesDir)) {
    for (const d of fs.readdirSync(pagesDir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== use) candidates.push(d.name);
    }
  }
  let donor = null;
  for (const c of candidates) {
    const abs = path.join(pagesDir, c, "elementor.json");
    if (!fs.existsSync(abs)) continue;
    try {
      const d = G.readJson(abs);
      const chrome = chromeFrom(d);
      if (chrome.head.length) { donor = { doc: d, chrome }; break; }
    } catch (e) { /* try the next one */ }
  }
  if (!donor) return { ok: false, reason: "no existing page on this site could be used as a template for the new one" };

  const dir = path.join(pagesDir, use);
  fs.mkdirSync(dir, { recursive: true });

  const gitId = `page-${use}-g99fb`;
  const ST = require("./structure");
  const content = ST.buildSection(String(html));

  G.writeJson(path.join(dir, "resource.json"), {
    schema_version: 1, git_id: gitId, type: "page", slug: use, title: name,
    status: "publish", publication_approved: true, excerpt: "", menu_order: 0,
    page_template: "elementor_canvas", content: "",
  });
  G.writeJson(path.join(dir, "elementor.json"), {
    schema_version: 1, elementor_version: "3",
    document_settings: {
      // The donor's stylesheet, plus anything written for this page's own
      // content. Without the first, the page renders as unstyled text.
      custom_css: [
        String((donor.doc.document_settings || {}).custom_css || ""),
        String(css || "").trim(),
      ].filter(Boolean).join("\n\n"),
    },
    elements: [...donor.chrome.head, content, ...donor.chrome.tail],
  });
  G.writeJson(path.join(dir, "seo.json"), {
    schema_version: 1, provider: "rank_math",
    fields: { rank_math_title: name, rank_math_description: "" },
  });

  return {
    ok: true, slug: use, linked: false,
    sections: donor.chrome.head.length + 1 + donor.chrome.tail.length,
    files: ["resource.json", "elementor.json", "seo.json"].map((f) => `resources/pages/${use}/${f}`),
  };
}

module.exports = {
  isCssCarrier, writeSiteCss, writeSeo, createPage, freeSlug, chromeFrom, reId,
  CSS_OPEN, CSS_CLOSE, SEO_FIELDS,
};
