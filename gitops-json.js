// GitOps JSON site model — the "virtual file" layer.
//
// Two kinds of website repository exist side by side:
//
//   Model A (classic)  web/app/themes/g99-<slug>/*.php  — the AI edits PHP.
//   Model B (GitOps)   resources/**/*.json              — the site is Elementor
//                      content, deployed into WordPress by the g99-control MU
//                      plugin. There is no theme and no PHP to edit.
//
// The edit pipeline was written for Model A and is good at one thing: handing a
// model some TEXT, taking TEXT back, and writing it to a file. Rather than fork
// that pipeline, this module makes a Model B repository LOOK like text files.
//
// A virtual path is "<real path>::<selector>", e.g.
//   resources/pages/home/elementor.json::doc   every editable string on the page
//   resources/pages/home/elementor.json::css   document_settings.custom_css
//   resources/pages/home/seo.json::seo         the Rank Math fields
//
// Reading expands JSON into text; writing folds text back into the JSON at the
// exact node it came from. The model never sees or writes raw JSON, so it cannot
// corrupt the structure — the worst it can do is write bad prose into a string
// that was always a string.
"use strict";
const fs = require("fs");
const path = require("path");

const SEP = "::";

// ---- marker format ---------------------------------------------------------
// Every editable value in a ::doc view is wrapped in a pair of HTML comments
// carrying the Elementor element id and the settings key it came from. Anything
// outside a marker pair is commentary and is discarded on write, which is what
// lets the view carry its own instructions to the model.
const OPEN = (id, key) => `<!--G99 ${id} ${key}-->`;
const CLOSE = (id) => `<!--/G99 ${id}-->`;
const MARK_RE = /<!--G99 ([A-Za-z0-9_-]+) ([A-Za-z0-9_.-]+)-->([\s\S]*?)<!--\/G99 \1-->/g;

// Settings that hold words a human would recognise on the page. Everything else
// in an Elementor settings bag is layout, colour and spacing — never text, and
// nothing an edit request means when it says "change the headline".
const TEXT_KEYS = [
  "html", "title", "editor", "text", "content", "caption",
  "description_text", "title_text", "tab_title", "item_title", "item_description",
  "testimonial_content", "alert_title", "alert_description", "inner_text",
  "before_text", "after_text", "placeholder", "button_text", "form_name",
];
// The same idea inside a repeater row (icon-list items, accordion items, tabs).
const ITEM_TEXT_KEYS = [
  "text", "title", "item_title", "item_description", "description",
  "content", "tab_title", "tab_content", "testimonial_content",
];

// A value worth showing the model. Numbers, booleans, colours and CSS units are
// not text; neither is a bare URL, which belongs to the link editor.
function isEditableText(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length < 2) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms)?$/i.test(s)) return false;
  if (/^https?:\/\/\S+$/i.test(s)) return false;
  return true;
}

// ---- reading an Elementor document ------------------------------------------
// Walks the element tree in document order and returns one entry per editable
// string, remembering which top-level container each came from so a new block
// can later be inserted in the right place rather than always at the end.
function collectBlocks(doc) {
  const out = [];
  const elements = Array.isArray(doc && doc.elements) ? doc.elements : [];
  elements.forEach((top, topIndex) => {
    const visit = (el) => {
      if (!el || typeof el !== "object") return;
      const id = String(el.id || "");
      const settings = el.settings && typeof el.settings === "object" ? el.settings : {};
      if (id) {
        const entries = [];
        for (const key of TEXT_KEYS) {
          if (isEditableText(settings[key])) entries.push({ key, value: settings[key] });
        }
        for (const [key, val] of Object.entries(settings)) {
          if (!Array.isArray(val)) continue;
          val.forEach((row, i) => {
            if (!row || typeof row !== "object") return;
            for (const sub of ITEM_TEXT_KEYS) {
              if (isEditableText(row[sub])) entries.push({ key: `${key}.${i}.${sub}`, value: row[sub] });
            }
          });
        }
        out.push({ id, elType: String(el.elType || ""), widgetType: String(el.widgetType || ""), settings, entries, topIndex });
      }
      (Array.isArray(el.elements) ? el.elements : []).forEach(visit);
    };
    visit(top);
  });
  return out;
}
// The flat view the edit pipeline reads: one entry per editable string, in
// document order, each remembering which top-level container it came from so a
// new block can later be inserted in the right place rather than at the end.
function collectDoc(doc) {
  const out = [];
  for (const b of collectBlocks(doc)) {
    for (const e of b.entries) out.push({ id: b.id, key: e.key, value: e.value, topIndex: b.topIndex });
  }
  return out;
}

// The header is instructions, not content: the writer ignores everything outside
// a marker pair, so this costs nothing and stops a model inventing its own idea
// of the format. The example marker is escaped precisely so the parser does not
// read the instructions as an edit.
function docHeader(rel) {
  return [
    `<!-- G99 EDITABLE VIEW of ${rel}`,
    "",
    "     This page is stored as Elementor JSON. Only the text BETWEEN the G99",
    "     markers below is saved; everything else here is discarded.",
    "",
    "     - Never change, reorder or delete a marker's id or key.",
    "     - Leave any block you were not asked to change exactly as it is.",
    "     - A block whose key is 'html' is raw page HTML: edit it as HTML.",
    "       Any other key is a single Elementor field: plain text or inline HTML.",
    "     - To ADD a new section, insert a new block after the one it should",
    "       follow, using the literal id 'new' and the key 'html':",
    "       &lt;!--G99 new html--&gt; ...your HTML... &lt;!--/G99 new--&gt;",
    "-->",
    "",
  ].join("\n");
}

function renderDoc(rel, entries) {
  return docHeader(rel) + entries.map((e) => OPEN(e.id, e.key) + e.value + CLOSE(e.id)).join("\n\n") + "\n";
}

// ---- writing an Elementor document ------------------------------------------
function setSetting(el, key, value) {
  const parts = key.split(".");
  if (parts.length === 1) { el.settings[key] = value; return true; }
  const [head, idx, sub] = parts;
  const arr = el.settings[head];
  if (!Array.isArray(arr) || !arr[Number(idx)] || typeof arr[Number(idx)] !== "object") return false;
  arr[Number(idx)][sub] = value;
  return true;
}
function findById(elements, id) {
  for (const el of elements || []) {
    if (el && String(el.id) === id) return el;
    const hit = findById(el && el.elements, id);
    if (hit) return hit;
  }
  return null;
}
function newId() {
  return Math.random().toString(16).slice(2, 9);
}
// A container holding one HTML widget — the shape every Design Engine section
// already uses, so an added section is indistinguishable from a generated one.
function newHtmlBlock(html) {
  return {
    id: newId(), elType: "container", isInner: false, settings: {},
    elements: [{ id: newId(), elType: "widget", widgetType: "html", settings: { html }, elements: [] }],
  };
}

// Applies a rewritten ::doc view back onto the parsed JSON. Reports unknown
// markers rather than throwing on them: a model that hallucinates one marker
// should not cost the caller the twelve edits it got right.
function applyDoc(doc, text) {
  const entries = collectDoc(doc);
  const known = new Map(entries.map((e) => [`${e.id}\u0000${e.key}`, e]));
  const seen = new Set();
  const report = { updated: 0, added: 0, unchanged: 0, unknown: [], duplicated: [] };
  const inserts = [];
  let lastTopIndex = -1;

  MARK_RE.lastIndex = 0;
  let m;
  while ((m = MARK_RE.exec(text))) {
    const id = m[1], key = m[2], raw = m[3];
    if (id === "new") { inserts.push({ afterTopIndex: lastTopIndex, html: raw.trim() }); report.added++; continue; }
    const hit = known.get(`${id}\u0000${key}`);
    if (!hit) { report.unknown.push(`${id} ${key}`); continue; }
    if (seen.has(`${id}\u0000${key}`)) { report.duplicated.push(`${id} ${key}`); continue; }
    seen.add(`${id}\u0000${key}`);
    lastTopIndex = hit.topIndex;
    // Only trim when the stored value had no surrounding whitespace of its own:
    // a model habitually adds a newline after the marker, and that newline must
    // not become part of a heading.
    const value = hit.value.trim() === hit.value ? raw.trim() : raw;
    if (value === hit.value) { report.unchanged++; continue; }
    const el = findById(doc.elements, id);
    if (!el || !el.settings) { report.unknown.push(`${id} ${key}`); continue; }
    if (setSetting(el, key, value)) report.updated++;
    else report.unknown.push(`${id} ${key}`);
  }
  // Right to left, so an earlier insertion does not shift a later index.
  inserts.sort((a, b) => b.afterTopIndex - a.afterTopIndex);
  for (const ins of inserts) {
    if (!ins.html) { report.added--; continue; }
    const at = ins.afterTopIndex < 0 ? doc.elements.length : ins.afterTopIndex + 1;
    doc.elements.splice(at, 0, newHtmlBlock(ins.html));
  }
  return report;
}

// ---- the audit view (pre-release) -------------------------------------------
// The pre-release run does not rewrite a page the way a revision does — it reads
// one, looking for links that 404, images with no name, a phone number that is
// not clickable, a page with no CTA. Those checks were written against PHP
// templates and they all read HTML.
//
// The ::doc view is deliberately austere: markers and nothing else, because a
// model must not be tempted to edit anything it cannot save. That is wrong for
// an audit — a button widget's destination and an image widget's src are exactly
// what the checks are looking for, and neither is a marker.
//
// So ::audit renders the same markers INSIDE inert structural HTML. Writing goes
// through the same applyDoc, which discards everything outside a marker pair, so
// the extra tags are visible to a check and invisible to a save. A page built
// entirely from `html` widgets — which is every page the Design Engine emits —
// renders identically in both views.
const attr = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Where a widget keeps the thing it points at. Elementor stores a link either as
// a bare string or as {url, is_external, nofollow}, under a handful of names.
const LINK_KEYS = ["link", "button_link", "website_link", "url", "link_to", "cta_link"];
function blockLink(settings) {
  for (const k of LINK_KEYS) {
    const v = settings[k];
    if (typeof v === "string" && /^(https?:|\/|tel:|mailto:|#)/i.test(v.trim())) return v.trim();
    if (v && typeof v === "object" && typeof v.url === "string" && v.url.trim()) return v.url.trim();
  }
  return "";
}
const IMAGE_KEYS = ["image", "background_image", "photo", "logo", "site_logo", "before_image", "after_image"];
function blockImage(settings) {
  for (const k of IMAGE_KEYS) {
    const v = settings[k];
    if (v && typeof v === "object" && typeof v.url === "string" && v.url.trim()) {
      return { src: v.url.trim(), alt: typeof v.alt === "string" ? v.alt : "" };
    }
  }
  return null;
}
function renderAudit(blocks) {
  const out = [];
  for (const b of blocks) {
    const inner = b.entries.map((e) => OPEN(b.id, e.key) + e.value + CLOSE(b.id)).join("\n");
    const img = blockImage(b.settings);
    if (img) out.push(`<img src="${attr(img.src)}" alt="${attr(img.alt)}">`);
    if (!inner) continue;
    // An html widget already IS page markup — wrapping it would only give every
    // check a div that is not on the real page.
    if (b.widgetType === "html") { out.push(inner); continue; }
    const href = blockLink(b.settings);
    if (href) { out.push(`<a href="${attr(href)}">${inner}</a>`); continue; }
    const tag = /heading|title/.test(b.widgetType) ? "h2" : "div";
    out.push(`<${tag}>${inner}</${tag}>`);
  }
  return out.join("\n\n") + "\n";
}

// ---- virtual path plumbing ---------------------------------------------------
function isVirtual(rel) { return String(rel).includes(SEP); }
function splitVirtual(rel) {
  const at = String(rel).indexOf(SEP);
  return at < 0 ? { file: String(rel), sel: "" } : { file: String(rel).slice(0, at), sel: String(rel).slice(at + SEP.length) };
}
function readJson(abs) { return JSON.parse(fs.readFileSync(abs, "utf8")); }
// The fleet's own files are 4-space indented, and its exporter writes them with
// NO trailing newline. Writing them back any other way turns a one-word copy fix
// into a diff that also touches the last line of the file — so the file's own
// convention is read off disk rather than assumed.
function writeJson(abs, obj) {
  let tail = "\n";
  try { tail = /\n$/.test(fs.readFileSync(abs, "utf8")) ? "\n" : ""; } catch (_) { /* new file: end it properly */ }
  fs.writeFileSync(abs, JSON.stringify(obj, null, 4) + tail);
}

// Which selectors a given real file offers.
function selectorsFor(rel) {
  const base = path.basename(rel);
  if (base === "elementor.json") return ["doc", "css"];
  if (base === "resource.json") return ["title", "content"];
  if (base === "seo.json") return ["seo"];
  if (base === "site.json") return ["blogname", "blogdescription"];
  if (base === "menus.json") return ["doc"];
  return [];
}

function readVirtual(root, rel) {
  const s = splitVirtual(rel);
  const abs = path.join(root, s.file);
  if (!fs.existsSync(abs)) return null;
  if (!s.sel) return fs.readFileSync(abs, "utf8");
  const base = path.basename(s.file);
  const j = readJson(abs);
  if (base === "elementor.json") {
    if (s.sel === "css") return String((j.document_settings || {}).custom_css || "");
    if (s.sel === "audit") {
      const blocks = collectBlocks(j).filter((b) => b.entries.length || blockImage(b.settings) || blockLink(b.settings));
      return blocks.length ? renderAudit(blocks) : "";
    }
    const entries = collectDoc(j);
    return entries.length ? renderDoc(s.file, entries) : "";
  }
  if (base === "resource.json") return String(j[s.sel === "title" ? "title" : "content"] || "");
  if (base === "seo.json") {
    const f = j.fields || {};
    const rows = Object.entries(f).filter((kv) => typeof kv[1] === "string" && kv[1].trim());
    if (!rows.length) return "";
    return `<!-- G99 EDITABLE VIEW of ${s.file} — SEO fields. Keep every marker; edit only the text inside. -->\n\n`
      + rows.map((kv) => OPEN("seo", kv[0]) + kv[1] + CLOSE("seo")).join("\n\n") + "\n";
  }
  if (base === "site.json") return String(j[s.sel] || "");
  if (base === "menus.json") {
    const out = [];
    for (const menu of j.menus || []) {
      for (const it of menu.items || []) {
        if (typeof it.title === "string" && it.title.trim()) {
          const id = `${menu.slug}-${it.source_id}`;
          out.push(OPEN(id, "title") + it.title + CLOSE(id));
        }
      }
    }
    if (!out.length) return "";
    return `<!-- G99 EDITABLE VIEW of ${s.file} — menu labels only. A link's destination is owned by the page it points at. -->\n\n`
      + out.join("\n\n") + "\n";
  }
  return null;
}

function writeVirtual(root, rel, content) {
  const s = splitVirtual(rel);
  const abs = path.join(root, s.file);
  if (!s.sel) {
    // A real file. JSON must still parse afterwards or the deployment rejects
    // the whole tree — refusing here costs one edit, not a site.
    if (/\.json$/i.test(s.file)) {
      try { JSON.parse(content); } catch (e) { throw new Error(`${s.file}: AI produced invalid JSON (${e.message})`); }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { updated: 1 };
  }
  if (!fs.existsSync(abs)) throw new Error(`${s.file} does not exist in this repository`);
  const base = path.basename(s.file);
  const j = readJson(abs);
  let report = { updated: 0 };
  if (base === "elementor.json") {
    if (s.sel === "css") {
      j.document_settings = j.document_settings || {};
      j.document_settings.custom_css = content;
      report = { updated: 1 };
    } else {                                        // ::doc and ::audit both fold back through applyDoc
      report = applyDoc(j, content);
      if (!report.updated && !report.added) {
        throw new Error(`${s.file}: nothing changed — every G99 marker came back identical`);
      }
    }
  } else if (base === "resource.json") {
    j[s.sel === "title" ? "title" : "content"] = s.sel === "title" ? content.trim() : content;
    report = { updated: 1 };
  } else if (base === "seo.json") {
    j.fields = j.fields || {};
    MARK_RE.lastIndex = 0;
    let m, n = 0;
    while ((m = MARK_RE.exec(content))) { if (m[1] === "seo") { j.fields[m[2]] = m[3].trim(); n++; } }
    if (!n) throw new Error(`${s.file}: no G99 markers came back`);
    report = { updated: n };
  } else if (base === "site.json") {
    j[s.sel] = content.trim();
    report = { updated: 1 };
  } else if (base === "menus.json") {
    const byKey = new Map();
    for (const menu of j.menus || []) for (const it of menu.items || []) byKey.set(`${menu.slug}-${it.source_id}`, it);
    MARK_RE.lastIndex = 0;
    let m, n = 0;
    while ((m = MARK_RE.exec(content))) {
      const it = byKey.get(m[1]);
      if (it && m[2] === "title") { it.title = m[3].trim(); n++; }
    }
    if (!n) throw new Error(`${s.file}: no menu labels came back`);
    report = { updated: n };
  } else {
    throw new Error(`${s.file}: not an editable resource`);
  }
  writeJson(abs, j);
  return report;
}

function existsVirtual(root, rel) {
  return fs.existsSync(path.join(root, splitVirtual(rel).file));
}

// The pre-release fixers are handed an absolute path they built themselves with
// path.join(themeAbs, page.file) and know nothing about roots. Splitting the
// selector off the end and treating the file's own directory as the root lets
// those fixers read and write a virtual path with no idea that they are.
function isVirtualAbs(abs) { return String(abs).includes(SEP); }
function readVirtualAbs(abs) {
  const s = splitVirtual(abs);
  return readVirtual(path.dirname(s.file), path.basename(s.file) + (s.sel ? SEP + s.sel : ""));
}
function writeVirtualAbs(abs, content) {
  const s = splitVirtual(abs);
  return writeVirtual(path.dirname(s.file), path.basename(s.file) + (s.sel ? SEP + s.sel : ""), content);
}
// What a virtual path is really a change to, for the diff, the changed-file list
// and the report — "…/elementor.json", not "…/elementor.json::audit".
function realPath(rel) { return splitVirtual(rel).file; }

// ---- discovery ---------------------------------------------------------------
function isGitopsRoot(root) {
  return fs.existsSync(path.join(root, "resources", "site.json"));
}

// Distinctive words from the request, used to pull the right resources into the
// bounded source budget. A site can hold hundreds of posts and products; the
// planner must not be handed all of them, and the ones it needs are almost
// always the ones the sender named.
function promptTerms(prompt) {
  const stop = ["page", "text", "with", "that", "this", "from", "please", "change", "update",
    "make", "into", "their", "there", "should", "website", "site", "section", "button", "instead"];
  return String(prompt || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !stop.includes(w));
}

// Order matters: pages and templates are what a revision almost always means, so
// they get the byte budget first. Everything else is pulled in only when the
// request names it.
const TIERS = [
  { dir: "pages", always: true }, { dir: "templates", always: true },
  { dir: "astra-portfolios", always: false }, { dir: "posts", always: false }, { dir: "products", always: false },
];

function expandResources(root, opts) {
  const O = opts || {};
  const maxBytes = O.maxBytes || 500000;
  const res = path.join(root, "resources");
  const manifest = [], source = [];
  let used = 0;
  const terms = promptTerms(O.prompt);
  const add = (rel) => {
    let content;
    try { content = readVirtual(root, rel); }
    catch (e) { return; }                                   // malformed resource: it simply offers nothing
    if (content === null || !String(content).trim()) return;
    manifest.push({ path: rel, bytes: Buffer.byteLength(content) });
    if (used + content.length > maxBytes) return;           // listed, not read
    used += content.length;
    source.push({ rel, content });
  };

  for (const t of TIERS) {
    const dir = path.join(res, t.dir);
    if (!fs.existsSync(dir)) continue;
    for (const slug of fs.readdirSync(dir)) {
      const abs = path.join(dir, slug);
      if (!fs.statSync(abs).isDirectory()) continue;
      // A resource the request names by slug is always read, whatever its tier.
      const named = terms.some((w) => slug.includes(w));
      if (!t.always && !named) continue;
      for (const f of fs.readdirSync(abs)) {
        for (const sel of selectorsFor(f)) add(`resources/${t.dir}/${slug}/${f}${SEP}${sel}`);
      }
    }
  }
  for (const pair of [["site.json", ["blogname", "blogdescription"]], ["menus.json", ["doc"]]]) {
    if (fs.existsSync(path.join(res, pair[0]))) for (const sel of pair[1]) add(`resources/${pair[0]}${SEP}${sel}`);
  }
  if (fs.existsSync(path.join(res, "custom-css.css"))) add("resources/custom-css.css");
  return { manifest, source };
}

module.exports = {
  SEP, isGitopsRoot, expandResources, isVirtual, splitVirtual,
  readVirtual, writeVirtual, existsVirtual, selectorsFor,
  isVirtualAbs, readVirtualAbs, writeVirtualAbs, realPath,
  // The feedback resolver needs to find one element by its Elementor id and
  // read/replace that node's own settings, which is a narrower thing than the
  // ::doc text view — it must not rewrite the whole page to change one section.
  findById, setSetting, readJson, writeJson,
  // exported for tests
  collectDoc, collectBlocks, applyDoc, renderDoc, renderAudit,
};
