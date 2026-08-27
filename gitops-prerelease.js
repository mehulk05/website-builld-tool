// Pre-release checks on a GitOps JSON site (Model B).
//
// The pre-release run was written against Model A: it reads `pg.php`, header.php
// and functions.php, and every auto-fix writes PHP. A Model B repository has no
// theme and no PHP — the site is `resources/**.json`, reconciled into WordPress
// by the g99-control MU plugin — so every check either found nothing or threw.
//
// Two halves live here, and they are deliberately unequal in size:
//
//   The READ half is nearly free. The checks all want HTML, and gitops-json.js
//   already turns an Elementor document into HTML through its ::audit view. So
//   readPages() hands back exactly the shape readSeoPages() does — slug, title,
//   file, php, text, headings, images, links — and findingsInternalLinks,
//   findingsCta, findingsBusinessName, findingsClickable, imageSources and the
//   AI content passes all run against a Model B site with no change at all.
//
//   The WRITE half needs one JSON writer per item, and that is what the rest of
//   this file is. The page-level fixers (name, spelling, CTA, clickable, BLVD,
//   images) are NOT here: they write through page.file, which is a virtual path,
//   so they keep working through GJ.writeVirtualAbs and stay single-sourced.
//
// The rule everything here obeys: never create a site-level resource whose
// absence means "WordPress owns this". custom-css.css absent means the site's
// Additional CSS lives in the database, and writing one would replace it with
// our four lines. Such a check reports instead of fixing, and says why.
"use strict";
const fs = require("fs");
const path = require("path");
const GJ = require("./gitops-json");

const RES = "resources";
const res = (root, ...parts) => path.join(root, RES, ...parts);
function readJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, "utf8")); } catch (_) { return null; }
}
// Same trailing-newline and indent convention as gitops-json.js writes with: the
// fleet's exporter writes 4-space JSON with no final newline, and a one-field
// change must not also touch the last line of the file.
function writeJson(abs, obj) {
  let tail = "\n";
  try { tail = /\n$/.test(fs.readFileSync(abs, "utf8")) ? "\n" : ""; } catch (_) { /* new file */ }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(obj, null, 4) + tail);
}
function subdirs(root, kind) {
  const dir = res(root, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((s) => !s.startsWith(".") && fs.statSync(path.join(dir, s)).isDirectory())
    .sort();
}
function siteJson(root) { return readJson(res(root, "site.json")) || {}; }
// The destination host, for the absolute URLs redirections.json stores. The
// repo states it once, in site.json, rather than each caller passing a live URL
// that may be the beta domain on one run and the real one on the next.
function siteUrl(root) {
  return String(siteJson(root).source_url || "").replace(/\/+$/, "");
}

// ---- the page list -----------------------------------------------------------
// `file` is a VIRTUAL path relative to resources/, which is what themePath points
// at for a Model B repo. path.join(themeAbs, page.file) therefore produces
// "<tmp>/resources/pages/home/elementor.json::audit", and the shared fixers read
// and write it through GJ without knowing it is not a file.
function readPages(root, helpers) {
  const H = helpers || {};
  const text = H.pageText || ((h) => String(h || ""));
  const front = String(siteJson(root).front_page_git_id || "");
  const pages = [], muPages = [];
  for (const slug of subdirs(root, "pages")) {
    const r = readJson(res(root, "pages", slug, "resource.json")) || {};
    // A draft is not on the site, so auditing it produces findings nobody can act
    // on and a missing-pages comparison that counts pages the public cannot see.
    if (String(r.status || "publish") !== "publish") continue;
    const hasDoc = fs.existsSync(res(root, "pages", slug, "elementor.json"));
    const rel = hasDoc
      ? `pages/${slug}/elementor.json${GJ.SEP}audit`
      : `pages/${slug}/resource.json${GJ.SEP}content`;
    let php = "";
    try { php = GJ.readVirtualAbs(path.join(root, RES, rel)) || ""; } catch (_) { php = ""; }
    // The front page answers on "/" whatever its slug is. Calling it "home" is
    // what lets the missing-pages comparison match the live site's "/" and keeps
    // the URL-structure rule from demanding a location in the home page's slug.
    const isFront = front && String(r.git_id || "") === front;
    const pageSlug = isFront ? "home" : String(r.slug || slug).toLowerCase();
    const title = String(r.title || slug);
    pages.push({
      slug: pageSlug, title, file: rel, php,
      text: text(php),
      headings: H.pageHeadings ? H.pageHeadings(php) : [],
      images: H.pageImages ? H.pageImages(php) : [],
      links: H.pageLinks ? H.pageLinks(php) : [],
      gitId: String(r.git_id || ""), dir: slug, front: !!isFront,
    });
    muPages.push({ title, slug: pageSlug, template: rel, kind: "page" });
  }
  // Posts, products and portfolios are not audited — a 44-post blog would bury
  // the report and none of the checks are about a blog post. Their slugs are
  // still registered, so a link to /some-post/ is not reported as a dead link
  // pointing at a page this site does not have. They carry their own `kind`
  // because being a known URL and being a sensible redirect target are different
  // things: a nav link to a missing /emsella/ service page should not 301 to a
  // blog article that happens to mention Emsella.
  for (const kind of ["posts", "products", "astra-portfolios"]) {
    for (const slug of subdirs(root, kind)) {
      const r = readJson(res(root, kind, slug, "resource.json")) || {};
      if (String(r.status || "publish") !== "publish") continue;
      muPages.push({ title: String(r.title || slug), slug: String(r.slug || slug).toLowerCase(), template: "", kind });
    }
  }
  return { pages, muPages };
}

// The Model B answer to themeChromePages(): a bad link in the header or footer
// is on every page, and on this model that markup is a template resource rather
// than header.php. Templates the export left empty are skipped — an empty
// elements[] means WordPress still owns that part, and it has nothing to check.
const CHROME = ["header", "footer", "mobile-menu"];
function chromePages(root) {
  const out = [];
  for (const slug of CHROME) {
    const abs = res(root, "templates", slug, "elementor.json");
    if (!fs.existsSync(abs)) continue;
    let php = "";
    try { php = GJ.readVirtualAbs(abs + GJ.SEP + "audit") || ""; } catch (_) { php = ""; }
    if (!php.trim()) continue;
    out.push({ slug: `(${slug})`, file: `templates/${slug}/elementor.json${GJ.SEP}audit`, php });
  }
  // The navigation is a resource of its own, and a menu item pointing at a page
  // that no longer exists is the same defect as a dead link in the header.
  const menus = readJson(res(root, "menus.json"));
  if (menus) {
    const host = siteUrl(root);
    const links = [];
    for (const menu of menus.menus || []) {
      for (const it of menu.items || []) {
        let href = String(it.url || "");
        if (host && href.startsWith(host)) href = href.slice(host.length) || "/";
        if (!href) continue;
        links.push(`<a href="${href.replace(/"/g, "&quot;")}">${String(it.title || "").replace(/</g, "&lt;")}</a>`);
      }
    }
    if (links.length) out.push({ slug: "(menus)", file: "menus.json", php: links.join("\n") });
  }
  return out;
}

// ---- brand colour ------------------------------------------------------------
// Model A reads style.css and header.php. Here the design lives in the page's own
// document_settings.custom_css — the Design Engine writes a :root block with the
// palette in it — so the same "declared variable first, most-used non-neutral hex
// second" heuristic applies to a different pile of CSS.
function brandColor(root) {
  let src = "";
  const global = res(root, "custom-css.css");
  if (fs.existsSync(global)) src += fs.readFileSync(global, "utf8");
  for (const slug of subdirs(root, "pages").slice(0, 6)) {
    const j = readJson(res(root, "pages", slug, "elementor.json"));
    if (j) src += "\n" + String((j.document_settings || {}).custom_css || "");
  }
  const varHit = src.match(/--(?:brand|primary|accent)[a-z-]*\s*:\s*(#[0-9a-f]{3,8})/i);
  if (varHit) return varHit[1];
  const counts = new Map();
  for (const m of src.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const hex = "#" + m[1].toLowerCase();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 24 || max > 240 || max < 24) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex)[0] || "";
}

// ---- media -------------------------------------------------------------------
// A media reference is "media:<ref>", and <ref>.json next to the binary is what
// the reconciler resolves. Nothing here may invent a ref: pointing site_icon at
// a file the tree does not contain fails referential validation and rolls the
// whole deployment back.
function mediaRefExists(root, ref) {
  const bare = String(ref || "").replace(/^media:/, "");
  return !!bare && fs.existsSync(res(root, "media", bare + ".json"));
}
function findMediaRef(root, patterns) {
  const dir = res(root, "media");
  if (!fs.existsSync(dir)) return "";
  const refs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  for (const re of patterns) {
    const hit = refs.find((r) => re.test(r));
    if (hit) return hit;
  }
  return "";
}

// ---- favicon -----------------------------------------------------------------
// site.json owns the site icon on this model, and WordPress prints it — there is
// no header.php to emit a <link rel="icon"> from and nothing should try.
function hasFavicon(root) {
  const icon = String(siteJson(root).site_icon || "").trim();
  return !!icon && mediaRefExists(root, icon);
}
function fixFavicon(root) {
  if (hasFavicon(root)) return { changed: [], note: "site.json already sets a site icon" };
  const site = siteJson(root);
  const declared = String(site.site_icon || "").trim();
  if (declared && !mediaRefExists(root, declared)) {
    return { changed: [], skipped: true, note: `site.json points at ${declared}, which is not in resources/media — fix the media reference, not the icon` };
  }
  const logo = String(site.custom_logo || "").replace(/^media:/, "");
  const ref = (logo && mediaRefExists(root, logo)) ? logo : findMediaRef(root, [/favicon/i, /(^|[-_])icon([-_]|$)/i, /logo/i]);
  if (!ref) return { changed: [], skipped: true, note: "no favicon, icon or logo in resources/media to point site_icon at — reported instead" };
  site.site_icon = "media:" + ref;
  writeJson(res(root, "site.json"), site);
  return { changed: [`${RES}/site.json`], note: `site_icon set to media:${ref}` };
}

// ---- social sharing image ----------------------------------------------------
// Rank Math owns Open Graph on this model. Its per-page override is
// rank_math_facebook_image; with none set it falls back to the page's featured
// image, which is a resource field. Setting the featured image is the fleet's own
// way to give the home page a sharing card, and on an elementor_canvas page it
// changes nothing that renders.
function socialImageState(root, pages) {
  const home = (pages || []).find((p) => p.front) || (pages || []).find((p) => p.slug === "home");
  if (!home) return { ok: false, reason: "no front page found in resources/pages" };
  const seo = readJson(res(root, "pages", home.dir, "seo.json")) || {};
  const f = seo.fields || {};
  if (String(f.rank_math_facebook_image || f.rank_math_twitter_image || "").trim()) return { ok: true, home };
  const r = readJson(res(root, "pages", home.dir, "resource.json")) || {};
  if (String(r.featured_image || "").trim()) return { ok: true, home };
  return { ok: false, home, reason: "the front page has neither a Rank Math sharing image nor a featured image" };
}
function fixSocialImage(root, pages) {
  const st = socialImageState(root, pages);
  if (st.ok) return { changed: [], note: "a sharing image is already set for the front page" };
  if (!st.home) return { changed: [], skipped: true, note: st.reason };
  const site = siteJson(root);
  const logo = String(site.custom_logo || "").replace(/^media:/, "");
  const ref = (logo && mediaRefExists(root, logo)) ? logo : findMediaRef(root, [/logo/i, /hero/i]);
  if (!ref) return { changed: [], skipped: true, note: "no logo or hero image in resources/media to use as the sharing card" };
  const abs = res(root, "pages", st.home.dir, "resource.json");
  const r = readJson(abs);
  if (!r) return { changed: [], skipped: true, note: "the front page's resource.json could not be read" };
  r.featured_image = "media:" + ref;
  writeJson(abs, r);
  return { changed: [`${RES}/pages/${st.home.dir}/resource.json`], note: `front page featured image set to media:${ref}, which Rank Math serves as og:image` };
}

// ---- custom 404 --------------------------------------------------------------
// Detection only. A branded 404 on this model is an Elementor theme part with an
// error-404 display condition — creating one means inventing conditions the
// reconciler validates and a layout nobody reviewed, on a page every visitor who
// mistypes a URL will see. That is a build, not a fix.
function notFoundTemplate(root) {
  for (const slug of subdirs(root, "templates")) {
    if (/404|not-?found/i.test(slug)) return slug;
    const r = readJson(res(root, "templates", slug, "resource.json")) || {};
    if (/404|not\s*found/i.test(String(r.title || ""))) return slug;
    if (/error_404|error404/i.test(JSON.stringify(r))) return slug;
  }
  return "";
}

// ---- redirects ---------------------------------------------------------------
// redirections.json is the fleet's own redirect resource (Rank Math's), and it is
// the only place on this model a 301 can be written from a pull request.
//
// It behaves differently from the PHP map in one way that matters. The
// reconciler (RedirectionsConfig::apply) only ever INSERTS: it looks for a row
// with the same sources AND the same destination, and adds one if there is none.
// It never updates a row. So the PHP map's trick — a page renamed twice has its
// first redirect re-pointed at the newest destination — cannot work here: a
// rewritten url_to is a new pair, and the reconciler would insert a SECOND rule
// for the same source while leaving the stale one live.
//
// The right shape for an insert-only backend is a chain. A renamed twice: /a/ →
// /b/ is written on the first run, /b/ → /c/ on the second, and /a/ still arrives
// at /c/ in two hops. So a source that already has a rule is left exactly as it
// is, and each rename only ever adds its own.
const REDIRECT_FILE = "redirections.json";
function redirectPath(p) { return "/" + String(p || "").replace(/^\/+|\/+$/g, "") + "/"; }
function redirectEntry(from, toUrl) {
  const bare = String(from).replace(/^\/+|\/+$/g, "");
  return {
    sources: [
      { pattern: bare, comparison: "exact" },
      { pattern: bare + "/", comparison: "exact" },
      { pattern: bare + "/?$", comparison: "regex" },
    ],
    url_to: toUrl,
    header_code: "301",
    status: "active",
  };
}
// `ok` is "every one of these URLs now has a 301", which is NOT the same as
// "this call wrote a file". A caller that must not proceed without redirects —
// the slug rename — needs the first question answered, and on a re-run after a
// half-finished attempt the answer is yes with nothing to write.
function writeRedirects(root, pairs) {
  const host = siteUrl(root);
  if (!host) return { ok: false, changed: [], entries: 0, note: "site.json has no source_url — a redirect needs an absolute destination" };
  const abs = res(root, REDIRECT_FILE);
  const cur = readJson(abs) || { schema_version: 1, redirects: [] };
  if (!Array.isArray(cur.redirects)) cur.redirects = [];
  // Keyed on the first exact source, which is how this file identifies a rule.
  const byFrom = new Map();
  for (const rule of cur.redirects) {
    const first = ((rule.sources || [])[0] || {}).pattern;
    if (first) byFrom.set(redirectPath(first), rule);
  }
  let n = 0, kept = 0;
  for (const [from, to] of pairs) {
    const f = redirectPath(from), t = redirectPath(to);
    if (!f || !t || f === t) continue;
    // Somebody — a previous run, or a human in wp-admin — already decided where
    // this URL goes. Overwriting that would not replace the live rule, it would
    // add a competing one.
    if (byFrom.has(f)) { kept++; continue; }
    const rule = redirectEntry(f, host + t);
    cur.redirects.push(rule);
    byFrom.set(f, rule);
    n++;
  }
  if (!n) return { ok: true, changed: [], entries: cur.redirects.length, note: "every redirect was already in place" };
  writeJson(abs, cur);
  return {
    ok: true, changed: [`${RES}/${REDIRECT_FILE}`], entries: cur.redirects.length,
    note: `${n} redirect(s) written${kept ? `, ${kept} left as already set` : ""}`,
  };
}

// ---- URL structure -----------------------------------------------------------
// On Model A this fix is deliberately inert: the slug lives in the WordPress
// database, the mu-plugin seeds pages once, and a changed slug there produced
// 301s into 404s. On Model B the slug lives in resource.json and the reconciler
// keys the page off its stable git_id, so renaming it really does move the page
// — the reason the Model A fix was disabled does not apply here.
//
// It is still gated on the same environment switch, because a first run should
// never silently change a live site's URLs. What changes on this model is that
// turning it on now works.
function fixUrlStructure(root, renames, enabled) {
  if (!renames || !renames.length) return { changed: [], note: "every service URL already carries the location", skipped: true, renamed: [] };
  if (!enabled) {
    return {
      changed: [], skipped: true, renamed: [],
      note: `${renames.length} URL(s) need the location. On a GitOps site the slug is in resource.json and can be renamed here — set PERFORM_PR_RENAME_SLUGS=on to apply it`,
    };
  }
  const applied = [];
  for (const r of renames) {
    const from = String(r.from || ""), to = String(r.to || "");
    if (!from || !to || from === to) continue;
    const dir = subdirs(root, "pages").find((d) => {
      const j = readJson(res(root, "pages", d, "resource.json")) || {};
      return String(j.slug || d).toLowerCase() === from.toLowerCase();
    });
    if (!dir) continue;
    if (fs.existsSync(res(root, "pages", to))) continue;      // a page already lives there
    applied.push({ ...r, dir });
  }
  if (!applied.length) return { changed: [], note: "no matching page resources to rename", skipped: true, renamed: [] };
  // Redirects first: if the map cannot be written the rename is abandoned rather
  // than shipped without a way back from the old URL.
  const red = writeRedirects(root, applied.map((r) => [r.from, r.to]));
  if (!red.ok) return { changed: [], note: `redirects could not be written (${red.note}) — slugs left alone`, skipped: true, renamed: [] };
  const changed = [...red.changed];
  const renamed = [];
  for (const r of applied) {
    const abs = res(root, "pages", r.dir, "resource.json");
    const j = readJson(abs);
    if (!j) continue;
    j.slug = r.to;
    writeJson(abs, j);
    // The directory carries the slug on this model, and the WordPress → Git
    // exporter deletes the old path on a slug change. Leaving pages/<old>/ behind
    // would mean the next admin sync fights this pull request.
    let dir = r.dir;
    if (dir !== r.to) {
      try { fs.renameSync(res(root, "pages", dir), res(root, "pages", r.to)); dir = r.to; }
      catch (_) { /* keep the old directory: the slug field is what the reconciler reads */ }
    }
    changed.push(`${RES}/pages/${dir}/resource.json`);
    renamed.push({ from: r.from, to: r.to });
  }
  if (!renamed.length) return { changed: [], note: "no page resource could be rewritten", skipped: true, renamed: [] };
  return { changed: [...new Set(changed)], renamed, note: `${renamed.length} URL(s) given the location, each 301'd from the old path` };
}

// ---- the business's own name -------------------------------------------------
// The page-level rename is the shared fixer's job. This is the one place it
// cannot reach: blogname is what WordPress prints in the title tag, the RSS feed
// and every theme that asks for the site name.
function fixSiteName(root, correct, wrong) {
  const site = siteJson(root);
  const cur = String(site.blogname || "").trim();
  if (!cur || !correct) return { changed: [], skipped: true, note: "site.json has no blogname to check" };
  if (cur === correct) return { changed: [], note: `site.json already names the site "${correct}"` };
  // Only the exact stale name is swapped. A site deliberately trading under a
  // shorter name than its client record is normal, and is a decision.
  if (wrong && cur.toLowerCase() !== String(wrong).toLowerCase()) {
    return { changed: [], skipped: true, note: `site.json says "${cur}", the record says "${correct}" — left for a human` };
  }
  site.blogname = correct;
  writeJson(res(root, "site.json"), site);
  return { changed: [`${RES}/site.json`], note: `blogname "${cur}" → "${correct}"` };
}

// ---- Growth99 theme conventions ----------------------------------------------
// Call Now and the blog sidebar are markup that belongs on every page. On Model A
// that is functions.php. On Model B the equivalent is a footer or global theme
// part — and in every repository seen so far those templates export EMPTY, which
// means WordPress still owns them. Writing elements into an empty template would
// not add a call bar, it would replace the live footer with one. So both report.
function callNowState(root, pages, chrome) {
  const all = [...(pages || []), ...(chrome || [])];
  const src = all.map((p) => String(p.php || "")).join("\n");
  if (/g99-call-now/.test(src)) return { ok: true, how: "the call bar markup is already on the site" };
  // A sticky bar is a fixed-position tel: link; a plain tel: link in the header
  // is not the same thing and does not answer this check.
  if (/position\s*:\s*fixed[^}]*}/i.test(src) && /href\s*=\s*["']tel:/i.test(src)) {
    return { ok: true, how: "a fixed-position tel: link is already present" };
  }
  return { ok: false };
}
function blogState(root) {
  const templates = subdirs(root, "templates");
  const single = templates.filter((t) => /single-post|archive|blog|categor/i.test(t));
  return { has: !!single.length || !!subdirs(root, "posts").length, templates: single };
}
// custom-css.css is only written when it already exists. Absent, it means the
// site's Additional CSS lives in the database and creating the file would replace
// it with these four lines.
function fixBlogLinkColor(root, brand, mark) {
  const blog = blogState(root);
  if (!blog.has) return { changed: [], note: "this site has no blog", skipped: true };
  if (!brand) return { changed: [], note: "no brand colour detected", skipped: true };
  const abs = res(root, "custom-css.css");
  if (!fs.existsSync(abs)) {
    return { changed: [], skipped: true, note: "the site's CSS lives in WordPress, not resources/custom-css.css — set the blog link colour in Additional CSS" };
  }
  const cur = fs.readFileSync(abs, "utf8");
  const marker = `${mark}:blog-links`;
  if (cur.includes(marker)) return { changed: [], note: "blog link colour already set" };
  fs.writeFileSync(abs, cur.replace(/\s*$/, "\n") + [
    "", `/* ${marker} — in-content links inherited the theme default, not the brand. */`,
    ".entry-content a:not(.button):not(.btn),", ".elementor-widget-theme-post-content a:not(.button):not(.btn) {",
    `    color: ${brand};`, "    text-decoration: underline;", "}", "",
  ].join("\n"));
  return { changed: [`${RES}/custom-css.css`], note: `blog links set to ${brand}` };
}

module.exports = {
  RES, res, readJson, writeJson, subdirs, siteJson, siteUrl,
  readPages, chromePages, brandColor,
  mediaRefExists, findMediaRef,
  hasFavicon, fixFavicon,
  socialImageState, fixSocialImage,
  notFoundTemplate,
  writeRedirects, fixUrlStructure,
  fixSiteName, callNowState, blogState, fixBlogLinkColor,
};
