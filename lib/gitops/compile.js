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
  const noJs = "\n[data-reveal]{opacity:1!important;transform:none!important}\n";
  // The stored custom_css gets HTML-escaped: ">" becomes "&gt;" and kills every
  // child-combinator rule (.cards>* etc.). Our markup nests exactly one level in
  // those spots, so the descendant combinator is a safe equivalent.
  const css = (imports + "\n" + styles + noJs).replace(/\s*>\s*(?=[^{}]*\{)/g, " ");
  return { css, body };
}

function elementorDoc(slug, css, body) {
  return {
    schema_version: 1,
    elementor_version: "3",
    // Elementor Pro page-level Custom CSS — stored in _elementor_page_settings,
    // printed by Pro's CSS file manager, and NOT subject to the html-widget kses.
    document_settings: { custom_css: css },
    elements: [
      {
        id: eid(slug, "root"),
        elType: "container",
        settings: {
          flex_direction: "column",
          content_width: "full",
          padding: { unit: "px", top: "0", right: "0", bottom: "0", left: "0", isLinked: false },
        },
        elements: [
          {
            id: eid(slug, "html"),
            elType: "widget",
            settings: { html: body },
            elements: [],
            widgetType: "html",
          },
        ],
        isInner: false,
      },
    ],
  };
}

function resourceDoc(slug, title, existingGitId) {
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
    page_template: "elementor_canvas",
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
function compileGitops(siteDir, biz, existingGitId = () => null) {
  const files = new Map();
  const mapFile = path.join(siteDir, "assets", "img-map.json");
  const imgMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
  const pages = [];
  for (const p of PAGES) {
    const src = path.join(siteDir, p.file);
    if (!fs.existsSync(src)) continue;
    let html = fs.readFileSync(src, "utf8");
    html = rewriteLinks(dedupeImages(unlocalizeImages(html, imgMap), imgMap));
    const { css, body } = splitHtml(html);
    const dir = `resources/pages/${p.slug}`;
    files.set(`${dir}/elementor.json`, JSON.stringify(elementorDoc(p.slug, css, body), null, 4));
    files.set(`${dir}/resource.json`, JSON.stringify(resourceDoc(p.slug, p.title, existingGitId(p.slug)), null, 4));
    files.set(`${dir}/seo.json`, JSON.stringify(seoDoc(p.title, biz), null, 4));
    pages.push(p.slug);
  }
  if (!pages.length) throw new Error("gitops compile: no pages found in " + siteDir);
  return { files, pages };
}

module.exports = { compileGitops };
