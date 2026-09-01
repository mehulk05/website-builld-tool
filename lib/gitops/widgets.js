// webgen HTML → native Elementor widgets.
//
// Why this exists: every section used to compile to one `html` widget, so a
// client opening the page in Elementor got a code textarea instead of an
// editable element. This converts the parts of our own markup we can name —
// eyebrow, headings, buttons, images, intro copy — into real Heading / Button /
// Image / Text Editor widgets, and leaves everything it does not recognise as an
// `html` widget. Content is never dropped: an unparsed chunk still ships.
//
// It parses OUR generator's output, not arbitrary HTML. That is the whole reason
// a 40-line tokenizer is enough — the shapes are fixed by render.js.
//
// Styling stays in the stylesheet rather than moving into per-widget controls.
// See bridgeCss(): the moment a heading widget exists, Elementor injects
// `.elementor-widget-heading .elementor-heading-title{font-family;font-weight;
// color}` from the global kit into the page's own stylesheet, above our rules —
// so our selectors have to match its (0,2,0) specificity to keep the design.
// That is what PREFIX buys; everything else (size, line-height, letter-spacing)
// was never contested.
"use strict";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

// Tags whose interior we never walk into looking for convertible nodes.
const OPAQUE = new Set(["script", "style", "svg"]);

// Wrappers whose interior markup must ship byte-for-byte.
//
// Grids are here because it was TRIED and it broke, on the live site: turning
// `.cards` into a container gave it Elementor's `e-con e-parent` classes, whose
// flex rules beat our `display:grid` on a top-level container. The three cards
// stacked vertically (tops 2248/2603/2957 instead of one row), `.card-img`
// collapsed to 0px because the image widget wrapper swallowed its aspect-ratio,
// and the page grew from ~5,000px to 6,902px. Making these editable needs the
// layout expressed in Elementor's own flex controls, not our grid CSS — a
// deliberate piece of work, not a widening of this regex.
//
// The chrome/media wrappers carry parallax and marquee markup, same reasoning.
const OPAQUE_DIV = /^(cards|card|team|member|quotes|quote|gallery|gcell|feat|svc-menu|svc-row|values|value|about-grid|marq|strip|nav|foot|hero-media|hero-bg|page-hero-bg|about-img|photo|card-img|map|form|idx)/;

// ---------------------------------------------------------------- parsing --
// Minimal tree for our own markup. Attribute values are read with quotes
// respected so an inline onerror/style containing ">" cannot end a tag early.
const TAG = /<(\/?)([a-zA-Z0-9-]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;

function parseAttrs(raw) {
  const out = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw || ""))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

function parseFragment(html) {
  const root = { tag: "#root", attrs: {}, children: [], html: "" };
  const stack = [root];
  let last = 0;
  TAG.lastIndex = 0;
  let m;
  const text = (s) => { if (s) stack[stack.length - 1].children.push({ tag: "#text", text: s, children: [] }); };
  while ((m = TAG.exec(html))) {
    const [full, close, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    text(html.slice(last, m.index));
    last = m.index + full.length;
    if (OPAQUE.has(tag) && !close) {
      const end = html.toLowerCase().indexOf("</" + tag, last);
      const stop = end === -1 ? html.length : end + tag.length + 3;
      stack[stack.length - 1].children.push({ tag, attrs: parseAttrs(rawAttrs), children: [], outer: html.slice(m.index, stop) });
      TAG.lastIndex = last = stop;
      continue;
    }
    if (close) {
      // Unwind to the matching open tag; ignore a stray close rather than
      // corrupting the tree (our markup is well formed, but never crash on it).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack[i].end = m.index + full.length; stack.length = i; break; }
      }
      continue;
    }
    const node = { tag, attrs: parseAttrs(rawAttrs), children: [], start: m.index, open: full };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  text(html.slice(last));
  annotate(root, html);
  return root;
}

// Give every element its own outerHTML, so an unconvertible node can still be
// shipped verbatim inside an html widget.
function annotate(node, src) {
  for (const c of node.children) {
    if (c.tag === "#text" || c.outer) { annotate(c, src); continue; }
    if (typeof c.start === "number") {
      const end = typeof c.end === "number" ? c.end : (VOID.has(c.tag) ? c.start + c.open.length : src.length);
      c.outer = src.slice(c.start, end);
      c.inner = c.outer.slice(c.open.length, VOID.has(c.tag) ? undefined : -(c.tag.length + 3));
    }
    annotate(c, src);
  }
}

const cls = (n) => String((n.attrs && n.attrs.class) || "").split(/\s+/).filter(Boolean);
const hasCls = (n, c) => cls(n).includes(c);
const textOf = (n) => {
  if (n.tag === "#text") return n.text || "";
  return (n.children || []).map(textOf).join("");
};
const isBlank = (n) => n.tag === "#text" && !/\S/.test(n.text || "");

// ------------------------------------------------------------- id + link --
// Ids stay 7-hex like the rest of the compiler, and stable per (page, path) so a
// re-deploy diffs clean instead of renaming every element.
function makeId(crypto, slug, path) {
  return crypto.createHash("md5").update(`${slug}|w|${path.join("/")}`).digest("hex").slice(0, 7);
}

const HREF_MAP = { "index.html": "/", "services.html": "/services/", "about.html": "/about/", "contact.html": "/contact/" };
function wpHref(href) {
  const h = String(href || "");
  if (HREF_MAP[h]) return HREF_MAP[h];
  return h.replace(/^(?:\.\/)?(index|services|about|contact)\.html(#.*)?$/, (_, p, hash) => HREF_MAP[p + ".html"] + (hash || ""));
}

// ------------------------------------------------------------- widgets ----
const widget = (id, type, settings) => ({ id, elType: "widget", settings, elements: [], widgetType: type });

function headingWidget(id, node, tag) {
  const s = { title: textOf(node).trim(), header_size: tag };
  const c = cls(node);
  if (c.length) s._css_classes = c.join(" ");
  return widget(id, "heading", s);
}

// Keeps the element's own tag and class INSIDE the editor content. A Heading
// widget cannot do that — it renders `<div class="eyebrow"><p class=
// "elementor-heading-title">`, so `.eyebrow` and a `.hero-copy p` rule stop
// landing on the same element and any em-based letter-spacing resolves against
// the wrapper's font-size instead of the text's. That is exactly how the eyebrow
// lost its tracking, colour and weight on the live site. Carrying the original
// element verbatim means every existing selector matches as it always did.
function textWidget(id, node) {
  return widget(id, "text-editor", { editor: node.outer || `<p>${node.inner || ""}</p>` });
}

function buttonWidget(id, node) {
  const href = wpHref(node.attrs.href);
  const s = {
    text: textOf(node).trim(),
    link: { url: href, is_external: /^https?:/i.test(href) ? "on" : "", nofollow: "" },
  };
  // .btn carries the design's button styling; keep it so the stylesheet still
  // owns the look, and add Elementor's own class-free size so it does not
  // impose padding of its own.
  const c = cls(node);
  if (c.length) s._css_classes = c.join(" ");
  return widget(id, "button", s);
}

function imageWidget(id, node, wrapperCls) {
  // No attachment id: these are the client's own remote URLs, exactly as the
  // html widget shipped them. MediaResolver only rewrites "media:<ref>", which
  // we do not mint here.
  const s = { image: { url: node.attrs.src || "", id: "" }, image_size: "full" };
  const c = [...(wrapperCls || []), ...cls(node)].filter(Boolean);
  if (c.length) s._css_classes = c.join(" ");
  if (node.attrs.alt) s.alt = node.attrs.alt;
  return widget(id, "image", s);
}

function htmlWidget(id, html, title) {
  const s = { html };
  if (title) s._title = title;
  return widget(id, "html", s);
}

// A single <div class="card-img"><img></div> style wrapper around one image:
// convert to an image widget carrying the wrapper's class, so `.card-img img`
// and `.card-img` rules both still apply.
function loneImage(node) {
  const kids = (node.children || []).filter((c) => !isBlank(c));
  if (kids.length !== 1) return null;
  if (kids[0].tag === "img") return kids[0];
  return null;
}

// ------------------------------------------------------------ conversion --
// Walk a section's children. Anything we recognise becomes a widget; a run of
// anything else is flushed into one html widget so the markup stays contiguous.
function convertChildren(node, ctx, path) {
  const out = [];
  let buf = [];
  const flush = () => {
    const html = buf.map((n) => (n.tag === "#text" ? n.text : n.outer || "")).join("");
    buf = [];
    if (/\S/.test(html)) out.push(htmlWidget(ctx.id(path.concat("h" + out.length)), html));
  };

  for (const child of node.children || []) {
    if (isBlank(child)) { buf.push(child); continue; }
    const w = convertNode(child, ctx, path.concat(String(out.length)));
    if (w) { flush(); out.push(w); } else buf.push(child);
  }
  flush();
  return out;
}

function convertNode(node, ctx, path) {
  const id = () => ctx.id(path);
  switch (node.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return headingWidget(id(), node, node.tag);
    case "p":
      // Anything with nested block markup stays html.
      if ((node.children || []).some((c) => /^(div|section|ul|ol|table)$/.test(c.tag))) return null;
      return textWidget(id(), node);
    case "a":
      if (hasCls(node, "btn")) return buttonWidget(id(), node);
      return null;
    case "cite": case "h4":
      // Carried verbatim: `cite{letter-spacing:.26em}` targets the tag itself,
      // so the tag has to survive into the output.
      return node.tag === "h4" ? headingWidget(id(), node, "h4") : textWidget(id(), node);
    case "img":
      return imageWidget(id(), node, []);
    case "article": case "figure":
    case "div": {
      const img = loneImage(node);
      if (img) return imageWidget(id(), img, cls(node));
      // A classed wrapper holding nothing but text (.role, .svc-n) is a label,
      // not a layout box: carry the element verbatim so `.role{letter-spacing:
      // .22em}` still resolves against its own font-size.
      if (cls(node).length && (node.children || []).length
          && (node.children || []).every((c) => c.tag === "#text")) {
        return textWidget(id(), node);
      }
      // A decorative empty div (.hr hairline, .page-hero-bg, an unfilled
      // .contactline) has no interior to preserve — the class IS the element.
      // As an html widget each one is a code box the client can only break;
      // as an empty container it still renders and styles identically. This is
      // most of the html-widget count on the minimal design.
      if (!(node.children || []).some((c) => !isBlank(c)) && cls(node).length) {
        return container(id(), node, []);
      }
      // A grid keeps its exact CSS-grid markup: turning its cells into
      // containers changes the box model the layout depends on. Those become
      // widgets in a later pass, deliberately, not by accident here.
      if (cls(node).some((c) => OPAQUE_DIV.test(c))) return null;
      // Any other named wrapper (.center, .card-body, .about-copy …) becomes a
      // container carrying the same class, so the stylesheet keeps matching and
      // its children can each be their own widget.
      const kids = convertChildren(node, ctx, path);
      // Look for a native widget anywhere BELOW, not just among the immediate
      // children: a grid's children are card containers, so an immediate-only
      // check made every card grid fall back to one code box.
      if (!kids.some((w) => countWidgets(w).native > 0)) return null;
      return container(id(), node, kids);
    }
    default:
      return null;
  }
}

// A container mirroring one of our wrapper elements, so the stylesheet's
// descendant selectors keep matching. content_width:"full" is what stops
// Elementor adding an inner wrapper div that direct-child selectors would trip
// over.
function container(id, node, children) {
  const settings = {
    flex_direction: "column",
    content_width: "full",
    padding: { unit: "px", top: "0", right: "0", bottom: "0", left: "0", isLinked: false },
  };
  const c = cls(node);
  // A container is an element, not a widget, so its Advanced controls are NOT
  // underscore-prefixed the way a widget's are: `_css_classes` is silently
  // ignored and every wrapper class vanishes from the DOM (which is how
  // `.section`/`.center` — and every rule scoped to them — stopped matching).
  // Emit both spellings: Elementor drops the key it does not own.
  if (c.length) { settings.css_classes = c.join(" "); settings._css_classes = c.join(" "); }
  if (node.attrs && node.attrs.id) { settings.css_id = node.attrs.id; settings._element_id = node.attrs.id; }
  return { id, elType: "container", settings, elements: children, isInner: false };
}

/**
 * Convert one top-level chunk (a <section>, <header>, <footer>, …) into an
 * Elementor container tree.
 *
 * Returns null when the chunk yielded nothing worth converting, so the caller
 * can fall back to its existing single-html-widget behaviour.
 */
function chunkToContainer(chunk, slug, index, crypto) {
  const root = parseFragment(chunk);
  const top = (root.children || []).filter((c) => !isBlank(c));
  if (top.length !== 1 || top[0].tag === "#text") return null;
  const el = top[0];
  const ctx = { id: (path) => makeId(crypto, slug, [String(index), ...path]) };

  // <section class="x"><div class="wrap">…</div></section> — mirror both levels
  // so `.section .wrap` and `.center h2` style the widgets unchanged.
  const build = (node, path, depth) => {
    const kids = (node.children || []).filter((c) => !isBlank(c));
    // A wrapper whose only child is another wrapper: recurse, keeping the class.
    if (depth < 3 && kids.length === 1 && kids[0].tag === "div" && !loneImage(kids[0])) {
      const innerCls = cls(kids[0]);
      // Only mirror wrappers we actually style; an unnamed div is noise.
      if (innerCls.length) {
        return container(ctx.id(path), node, [build(kids[0], path.concat("i"), depth + 1)]);
      }
    }
    return container(ctx.id(path), node, convertChildren(node, ctx, path));
  };

  const tree = build(el, [], 0);
  const widgets = countWidgets(tree);
  // Nothing recognised → let the caller ship the chunk as one html widget
  // rather than wrapping a lone html widget in extra containers.
  if (widgets.native === 0) return null;
  return tree;
}

function countWidgets(node, acc = { native: 0, html: 0 }) {
  if (node.elType === "widget") {
    if (node.widgetType === "html") acc.html++; else acc.native++;
  }
  for (const c of node.elements || []) countWidgets(c, acc);
  return acc;
}

// ----------------------------------------------------------- css bridge ---
// Elementor inserts a widget wrapper between our containers and our elements,
// and ships `.elementor-heading-title{line-height:1;margin:0;padding:0}`, which
// outranks a bare `h2{}` rule. Two mechanical fixes, no declaration touched:
//
//  1. Prefix our selectors with `.elementor` (present on every Elementor page
//     wrapper). Every rule gains exactly one class, so our internal cascade is
//     preserved while all of it now outranks Elementor's base rule.
//  2. Relax the few direct-child selectors that a widget wrapper breaks.
//
// html/body/:root/* stay unprefixed — they sit outside `.elementor`. So do
// keyframe steps (`to`, `from`, `50%`): prefixing those breaks the animation,
// which is how the marquee would have died silently.
// Repeating the class is what buys the specificity: Elementor prints
// `.elementor-widget-heading .elementor-heading-title{font-family;font-weight;color}`
// at (0,2,0) into the same file, and our rules land after it — so matching (0,2,0)
// wins on source order, while one class (0,1,1) silently lost font, weight and
// colour on every heading widget. Verified on the live site.
const PREFIX = ".elementor.elementor";

const UNPREFIXED = /^(?:html|body|:root|\*|::?[a-z-]+|@|from$|to$|[\d.]+%)/i;

function bridgeCss(css) {
  // `.center>p` and `.cards>*` are real on the live page; a widget wrapper
  // between parent and child makes them stop matching.
  let out = css.replace(/\.center\s*>\s*p\b/g, ".center p").replace(/\.cards\s*>\s*\*/g, ".cards > *, .cards > .elementor-element");

  // Split on rule boundaries, prefixing only selector lists. Depth tracking
  // keeps @media/@keyframes blocks intact and their inner rules prefixed.
  return out.replace(/([^{}]+)\{/g, (full, sel) => {
    const s = sel.trim();
    if (!s || s.startsWith("@") || /^\d/.test(s)) return full;            // at-rule or keyframe stop
    const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return full;
    const prefixed = parts.map((p) => (UNPREFIXED.test(p) ? p : `${PREFIX} ${p}`));
    return `${sel.slice(0, sel.length - sel.trimStart().length)}${prefixed.join(",")}{`;
  });
}

module.exports = { chunkToContainer, bridgeCss, countWidgets, parseFragment, wpHref };
