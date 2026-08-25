// GitOps resource compiler — turns the generated GEN/site pages into the G99
// GitOps `resources/` format (mcptest2.gogroth.com template): per page a folder
// resources/pages/<slug>/{resource.json, elementor.json, seo.json}.
//
// Format facts (verified against mcptest2 repo + g99-control plugin source):
// - The reconciler resolves "media:<ref>" only in STRUCTURED fields ({url,id}
//   image objects, featured_image) — raw <img src> inside an `html` widget is
//   NOT rewritten. So v1 references images by absolute source URL (hotlink);
//   assets/img/* local paths are mapped back via GEN/site/assets/img-map.json.
// - `html` widgetType is already used by real pages in the repo → accepted.
// - page_template "elementor_canvas" renders WITHOUT the site's Elementor
//   theme-builder header/footer, so our pages (which carry their own chrome)
//   don't get double headers.
// - git_id must stay stable per WordPress object: when the target repo already
//   has resources/pages/<slug>/resource.json we REUSE its git_id so the import
//   updates the page in place instead of delete+create.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Elementor element ids: 7-char hex, stable per slug+role so re-deploys diff clean.
const eid = (...parts) => crypto.createHash("md5").update(parts.join("|")).digest("hex").slice(0, 7);

const PAGES = [
  { file: "index.html", slug: "home", title: "Home" },
  { file: "services.html", slug: "services", title: "Services" },
  { file: "about.html", slug: "about", title: "About" },
  { file: "contact.html", slug: "contact", title: "Contact" },
];

// Internal links: generated pages link to *.html; on WordPress they are /slug/.
function rewriteLinks(html) {
  const map = { "index.html": "/", "services.html": "/services/", "about.html": "/about/", "team.html": "/about/", "contact.html": "/contact/" };
  let h = html;
  for (const [f, to] of Object.entries(map)) h = h.split(`href="${f}"`).join(`href="${to}"`);
  return h;
}

// assets/img/<md5>.<ext> → original absolute URL (from localizeImages' map).
function unlocalizeImages(html, imgMap) {
  let h = html;
  for (const [local, url] of Object.entries(imgMap)) h = h.split(local).join(url);
  return h;
}

// A card grid sometimes gets the same photo in two slots. Replace repeat
// <img src> occurrences with images from the site's own harvested set that the
// page isn't using yet (decor/logo/svg excluded). Only <img> tags — CSS
// backgrounds are shared chrome and are meant to repeat.
function dedupeImages(html, imgMap) {
  const DECOR = /logo|icon|favicon|sprite|\.svg(\?|$)/i;
  const used = new Set([...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]));
  const spare = Object.values(imgMap).filter((u) => !used.has(u) && !DECOR.test(u));
  const seen = new Set();
  return html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (m, pre, src, post) => {
    if (!seen.has(src) || DECOR.test(src)) { seen.add(src); return m; }
    const alt = spare.shift();
    if (!alt) return m;
    seen.add(alt);
    return pre + alt + post;
  });
}

function splitHtml(html) {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  // Google Fonts must survive without any "&" — WordPress HTML-escapes the stored
  // custom_css ("&"→"&amp;", ">"→"&gt;"), which breaks multi-family URLs. One
  // @import per family, no query separators.
  const fontHrefs = [...html.matchAll(/<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com\/css2?[^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const families = new Set();
  for (const u of fontHrefs) for (const m of u.matchAll(/family=([^&]+)/g)) families.add(m[1]);
  const imports = [...families].map((f) => `@import url('https://fonts.googleapis.com/css2?family=${f}');`).join("\n");
  let body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  // The import runs with no WP user → no unfiltered_html → Elementor kses-strips
  // <style>/<script> TAGS from widget html (their inner text then renders as page
  // text — the "CSS printed on the page" bug). So: no tags in the widget at all.
  // CSS ships via document_settings.custom_css; scripts are dropped, with a
  // no-JS override so reveal-on-scroll content is never left hidden.
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  body = unwrapMain(body);   // position classes baked in → sections become splittable
  const noJs = "\n[data-reveal]{opacity:1!important;transform:none!important}\n";
  // WordPress stores Additional CSS through wp_slash()/wp_unslash(), which eats a
  // lone backslash: content:"\201C" comes back as content:"201C" and the plugin's
  // exact-match verify then rolls the whole deploy back. Decode CSS unicode
  // escapes to the literal character (\201C → “) so no backslash ships at all.
  // Keep the stylesheet plain ASCII too: WordPress round-trips Additional CSS
  // through kses + wp_slash and the plugin then compares the stored string byte
  // for byte, so every character that WP might re-encode is a rollback risk.
  // Comments go (they only carried em-dashes), and typographic glyphs become
  // their ASCII equivalents — content:"“" is emitted as content:'"'.
  const deEscape = (s) => s
    .replace(/\\([0-9a-fA-F]{2,6})\s?/g, (m, hex) => { const ch = String.fromCodePoint(parseInt(hex, 16)); return /["'\\]/.test(ch) ? "" : ch; })
    .replace(/\\/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(["'])[\u201C\u201D]\1/g, "'\"'")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x00-\x7F]/g, "");
  // The stored custom_css gets HTML-escaped: ">" becomes "&gt;" and kills every
  // child-combinator rule (.cards>* etc.). Our markup nests exactly one level in
  // those spots, so the descendant combinator is a safe equivalent.
  const css = deEscape((imports + "\n" + classifyMainCss(styles) + noJs).replace(/\s*>\s*(?=[^{}]*\{)/g, " "));
  return { css, body };
}

// Split the page body into its top-level elements (header, each <section>, the
// marquee strips between them, footer) with a small balanced-tag scanner, so
// each one can become its own Elementor container — editable per-section in
// the WP editor instead of one giant blob.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function topLevelChunks(body) {
  const chunks = [];
  let depth = 0, start = -1;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(body))) {
    const closing = !!m[1], tag = m[2].toLowerCase();
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(m[3])) continue;   // void / self-closing: no depth change
    if (!closing) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start > -1) {
        chunks.push(body.slice(start, m.index + m[0].length));
        start = -1;
      }
    }
  }
  return chunks.filter((c) => c.trim());
}

// Sub-pages wrap their sections in <main>, whose CSS uses sibling-positional
// selectors (main>section+section, nth-of-type(even), :not(:first-child)) for
// alternating tints and separators. Those only work when the sections stay
// siblings in one block — which blocked per-section splitting. So: bake the
// position into classes on each section, rewrite the CSS to those classes, and
// unwrap <main> so every section becomes its own top-level (splittable) chunk.
function addClass(tagHtml, cls) {
  return /\bclass=["']/.test(tagHtml)
    ? tagHtml.replace(/\bclass=(["'])/, `class=$1${cls} `)
    : tagHtml.replace(/^<([a-zA-Z0-9-]+)/, `<$1 class="${cls}"`);
}
function unwrapMain(body) {
  const m = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!m) return body;
  const chunks = topLevelChunks(m[1]);
  if (!chunks.length) return body;
  let secIdx = 0;
  const annotated = chunks.map((c) => {
    if (!/^<section\b/i.test(c)) return c;
    const classes = ["g99-sec"];
    if (secIdx > 0) classes.push("g99-sec-next");        // section+section / :not(:first-child)
    if (secIdx % 2 === 1) classes.push("g99-sec-even");  // nth-of-type(even) = 2nd, 4th…
    secIdx++;
    return c.replace(/^<section\b[^>]*>/i, (tag) => addClass(tag, classes.join(" ")));
  });
  return body.replace(m[0], annotated.join("\n"));
}
function classifyMainCss(css) {
  return css
    .replace(/main\s*>\s*section\s*\+\s*section/g, ".g99-sec-next")
    .replace(/main\s*>\s*section:nth-of-type\(even\)/g, ".g99-sec-even")
    .replace(/main\s*>\s*section:not\(:first-child\)/g, ".g99-sec-next")
    .replace(/main\s*>\s*section/g, ".g99-sec");
}

// Human name for the Elementor navigator: Header / Hero / Specialties / Footer…
function chunkTitle(chunk, i) {
  const tag = (chunk.match(/^<([a-zA-Z0-9-]+)/) || [, ""])[1].toLowerCase();
  if (tag === "header") return "Header";
  if (tag === "footer") return "Footer";
  const id = (chunk.match(/\bid=["']([^"']+)["']/) || [, ""])[1];
  if (id) return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const h = (chunk.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i) || [, ""])[1].replace(/<[^>]+>/g, "").trim();
  if (h) return h.slice(0, 40);
  const cls = ((chunk.match(/\bclass=["']([^"']+)/i) || [, ""])[1] || "").split(/\s+/).find((c) => c && !/^g99-/.test(c));
  return cls ? cls.replace(/[-_]+/g, " ") : `Section ${i + 1}`;
}

function elementorDoc(slug, css, body, cssInline = false) {
  const chunks = topLevelChunks(body);
  const parts = chunks.length ? chunks : [body];   // scanner failure → whole page (never drop content)
  if (cssInline) parts.unshift(`<div hidden data-g99-css><style>\n${css}\n</style></div>`);
  return {
    schema_version: 1,
    elementor_version: "3",
    // Elementor Pro page-level Custom CSS — stored in _elementor_page_settings,
    // printed by Pro's CSS file manager, and NOT subject to the html-widget kses.
    document_settings: { custom_css: css },
    elements: parts.map((chunk, i) => ({
      id: eid(slug, "sec", String(i)),
      elType: "container",
      settings: {
        _title: chunkTitle(chunk, i),
        flex_direction: "column",
        content_width: "full",
        padding: { unit: "px", top: "0", right: "0", bottom: "0", left: "0", isLinked: false },
      },
      elements: [
        {
          id: eid(slug, "html", String(i)),
          elType: "widget",
          settings: { html: chunk },
          elements: [],
          widgetType: "html",
        },
      ],
      isInner: false,
    })),
  };
}

// Split a stylesheet into top-level pieces: @import statements, plain rules and
// whole @media blocks (brace-depth aware, so nested rules stay with their block).
function cssBlocks(css) {
  const blocks = [];
  let depth = 0, paren = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth <= 0) { depth = 0; blocks.push(css.slice(start, i + 1).trim()); start = i + 1; }
    } else if (c === ";" && depth === 0 && paren === 0) {
      // Statement end (@import / @charset). The paren guard matters: a Google
      // Fonts URL carries ";" between font weights inside url(...), and splitting
      // there truncated the @import mid-URL.
      blocks.push(css.slice(start, i + 1).trim()); start = i + 1;
    }
  }
  const tail = css.slice(start).trim();
  if (tail) blocks.push(tail);
  return blocks.filter(Boolean);
}

// One site-wide stylesheet for all pages. Page-level custom_css is an Elementor
// PRO feature — on a site running free Elementor it is stored but never printed,
// which renders every page unstyled. The Customizer's "Additional CSS"
// (resources/custom-css.css → wp_update_custom_css_post) is WordPress core, so
// it works on every site. @imports are hoisted: CSS requires them first.
function mergeCss(cssList) {
  const imports = [], rules = [], seen = new Set();
  for (const css of cssList) {
    for (const b of cssBlocks(css)) {
      if (seen.has(b)) continue;
      seen.add(b);
      (b.startsWith("@import") ? imports : rules).push(b);
    }
  }
  return imports.concat(rules).join("\n");
}

function resourceDoc(slug, title, existingGitId, pageTemplate = "elementor_canvas") {
  return {
    schema_version: 1,
    git_id: existingGitId || `page-${slug}-g99gen`,
    type: "page",
    slug,
    title,
    status: "publish",
    publication_approved: true,
    excerpt: "",
    menu_order: 0,
    page_template: pageTemplate,
    content: "",
  };
}

function seoDoc(title, biz) {
  const name = biz.business_name || "";
  const loc = biz.location || "";
  return {
    schema_version: 1,
    provider: "rank_math",
    fields: {
      rank_math_title: `${title === "Home" ? name : title + " | " + name}${loc ? " | " + loc.split(",")[0] : ""}`.slice(0, 70),
      rank_math_description: (biz.tagline || biz.about_blurb || `${name} — premium medical aesthetics${loc ? " in " + loc : ""}.`).slice(0, 160),
    },
  };
}

/**
 * Compile GEN/site → map of repo-relative resource files.
 * @param {string} siteDir           GEN/site
 * @param {object} biz               onboarding answers (business_name, location, tagline)
 * @param {function} existingGitId   (slug) => git_id|null — from the cloned target repo
 * @returns {{files: Map<string,string>, pages: string[]}}
 */
function compileGitops(siteDir, biz, existingGitId = () => null, opts = {}) {
  const pageTemplate = opts.pageTemplate || "elementor_canvas";
  // cssInline: carry the stylesheet inside the page itself, in a hidden wrapper
  // (<div hidden><style>…</style></div>). A <style> tag survives only where the
  // importer is allowed unfiltered HTML; where it is stripped, the leftover CSS
  // text stays inside the hidden div instead of printing across the page — so
  // this is safe to attempt on a site whose Additional CSS channel is unusable.
  const cssInline = !!opts.cssInline;
  const files = new Map();
  const mapFile = path.join(siteDir, "assets", "img-map.json");
  const imgMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
  const pages = [];
  const cssList = [];
  for (const p of PAGES) {
    const src = path.join(siteDir, p.file);
    if (!fs.existsSync(src)) continue;
    let html = fs.readFileSync(src, "utf8");
    html = rewriteLinks(dedupeImages(unlocalizeImages(html, imgMap), imgMap));
    const { css, body } = splitHtml(html);
    cssList.push(css);
    const dir = `resources/pages/${p.slug}`;
    files.set(`${dir}/elementor.json`, JSON.stringify(elementorDoc(p.slug, css, body, cssInline), null, 4));
    files.set(`${dir}/resource.json`, JSON.stringify(resourceDoc(p.slug, p.title, existingGitId(p.slug), pageTemplate), null, 4));
    files.set(`${dir}/seo.json`, JSON.stringify(seoDoc(p.title, biz), null, 4));
    pages.push(p.slug);
  }
  if (!pages.length) throw new Error("gitops compile: no pages found in " + siteDir);
  files.set("resources/custom-css.css", mergeCss(cssList));
  return { files, pages };
}

module.exports = { compileGitops };
