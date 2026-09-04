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

// Theme Builder types that only exist with Elementor Pro. Their presence in an
// export is the one honest signal available from the repository alone that the
// site can serve a template-driven 404 at all — without Pro, WordPress hands a
// 404 to the theme and no resource we could write would be consulted.
const PRO_TEMPLATE_TYPES = ["header", "footer", "popup", "archive", "single-post", "single-page", "product", "product-archive", "error-404"];
function hasProThemeBuilder(root) {
  for (const slug of subdirs(root, "templates")) {
    const r = readJson(res(root, "templates", slug, "resource.json")) || {};
    if (PRO_TEMPLATE_TYPES.includes(String(r.elementor_template_type || ""))) return true;
  }
  return false;
}

// A branded 404 as a Theme Builder template.
//
// This used to be report-only, on the rule "never create a site-level resource
// whose absence means WordPress owns it" — the rule that stops us writing a
// footer over a live one. It does not apply here, for two reasons. The reconciler
// is scoped to the paths a release actually changed (Reconciler::run's
// $onlyPaths → inScope), so a new templates/error-404/ directory is the only
// resource the deploy touches: it cannot reach header, footer or any page. And
// a 404 template is additive by definition — there is nothing at that condition
// to overwrite, or notFoundTemplate() would have found it.
function fix404(root, brand, businessName) {
  const found = notFoundTemplate(root);
  if (found) return { changed: [], note: `templates/${found} already handles 404s` };
  if (!hasProThemeBuilder(root)) {
    return {
      changed: [], skipped: true,
      note: "no Elementor Pro Theme Builder templates in this export — a 404 template would import but never be served, so the theme's own 404 stands",
    };
  }
  const accent = brand || "#1c1d29";
  const name = String(businessName || "").trim();
  const dir = res(root, "templates", "404");
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "resource.json"), {
    schema_version: 1,
    git_id: "template-404-g99",
    type: "elementor_library",
    slug: "404",
    title: "404 Not Found",
    elementor_template_type: "error-404",
    status: "publish",
    publication_approved: true,
    conditions: ["include/general"],
    is_active_kit: false,
  });
  const html = [
    `<section style="max-width:720px;margin:0 auto;padding:96px 24px;text-align:center">`,
    `<p style="font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:${accent};margin:0 0 12px">404</p>`,
    `<h1 style="font-size:34px;line-height:1.2;margin:0 0 14px">We couldn&#39;t find that page</h1>`,
    `<p style="font-size:17px;color:#555;margin:0 0 30px">The page may have moved.${name ? ` Let&#39;s get you back to ${name}.` : ""}</p>`,
    `<p><a href="{{SITE_URL}}/" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:14px 30px;border-radius:8px;font-weight:600">Back to home</a></p>`,
    `</section>`,
  ].join("");
  writeJson(path.join(dir, "elementor.json"), {
    schema_version: 1,
    elementor_version: "3",
    document_settings: {},
    elements: [{
      id: "g99404c",
      elType: "container",
      settings: { _title: "404", flex_direction: "column", content_width: "full" },
      elements: [{ id: "g99404w", elType: "widget", settings: { html }, widgetType: "html", elements: [] }],
      isInner: false,
    }],
  });
  return {
    changed: [`${RES}/templates/404/resource.json`, `${RES}/templates/404/elementor.json`],
    note: "branded 404 Theme Builder template created (condition: entire site)",
  };
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
// ---- the site-wide JS snippet -----------------------------------------------
// resources/cpt/<type>/g99-site-js is the fleet's own site-level injection point:
// g99-control prints it on wp_footer of every front-end page (Elementor Pro's
// Custom Code module will not render a snippet created by direct DB import, so
// the plugin emits it itself). It is a repo-owned resource, the reconciler is
// scoped to the paths a release changed, and it is the only place on this model
// where markup can be added to every page at once without touching a page.
//
// That matters because a Model B page has no theme footer to append to: the
// header and footer are HTML inside each generated page's own Elementor
// document. Anything site-wide either goes here or is copied onto every page.
const SNIPPET_TYPES = ["elementor_snippet", "wpcode"];
const SNIPPET_SLUG = "g99-site-js";
function snippetPath(root, type) { return res(root, "cpt", type, SNIPPET_SLUG, "cpt.json"); }
function snippetContent(root) {
  for (const type of SNIPPET_TYPES) {
    const j = readJson(snippetPath(root, type));
    if (j && typeof j.content === "string") return j.content;
  }
  return "";
}
// Written to every snippet type the repository already carries, so the two twins
// cannot drift. A repository with neither gets the elementor_snippet one, which
// is what g99-control reads.
function writeSnippet(root, appendJs) {
  const present = SNIPPET_TYPES.filter((t) => fs.existsSync(snippetPath(root, t)));
  const types = present.length ? present : ["elementor_snippet"];
  const changed = [];
  for (const type of types) {
    const abs = snippetPath(root, type);
    const cur = readJson(abs) || {
      schema_version: 1,
      git_id: `cpt-${type.replace(/_/g, "-")}-${SNIPPET_SLUG}`,
      type,
      slug: SNIPPET_SLUG,
      title: "G99 generated site JavaScript",
      status: "publish",
      content: "",
    };
    cur.content = String(cur.content || "").replace(/\s*$/, "\n") + "\n" + appendJs.trim() + "\n";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeJson(abs, cur);
    changed.push(`${RES}/cpt/${type}/${SNIPPET_SLUG}/cpt.json`);
  }
  return changed;
}

// A sticky call bar is one element: a tel: link that is itself pinned to the
// viewport. Testing "is anything fixed?" and "is there a tel: link?" separately
// over the whole site passes on any page that has a sticky side rail somewhere
// and a phone number somewhere else — which is every generated page, so the
// check was reporting a bar that does not exist. The two facts have to meet on
// the same element.
function fixedCallLink(src) {
  const telClasses = new Set();
  for (const tag of src.match(/<a\b[^>]*>/gi) || []) {
    if (!/href\s*=\s*["']tel:/i.test(tag)) continue;
    const style = (tag.match(/\bstyle\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    if (/position\s*:\s*fixed/i.test(style)) return "a tel: link is pinned to the viewport by its own inline style";
    const cls = (tag.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    for (const c of cls.split(/\s+/).filter(Boolean)) telClasses.add(c);
  }
  if (!telClasses.size) return "";
  for (const m of src.matchAll(/([^{}]+)\{([^}]*position\s*:\s*fixed[^}]*)\}/gi)) {
    const selector = m[1];
    for (const c of telClasses) {
      const safe = c.replace(/[^\w-]/g, "");
      if (safe && new RegExp("\\." + safe + "(?![\\w-])").test(selector)) {
        return `.${c} is fixed to the viewport and carries the tel: link`;
      }
    }
  }
  return "";
}
function callNowState(root, pages, chrome) {
  const all = [...(pages || []), ...(chrome || [])];
  const src = all.map((p) => String(p.php || "")).join("\n") + "\n" + snippetContent(root);
  if (/g99-call-now/.test(src)) return { ok: true, how: "the call bar markup is already on the site" };
  const how = fixedCallLink(src);
  if (how) return { ok: true, how };
  return { ok: false };
}
// The sticky Call Now bar, as JavaScript on the site-wide snippet rather than as
// markup in a footer this model does not have. Phones only, and it steps aside
// for anything already fixed to the bottom of the viewport.
function fixCallNow(root, pages, chrome, phone, brand) {
  const st = callNowState(root, pages, chrome);
  if (st.ok) return { changed: [], note: st.how };
  if (!phone) return { changed: [], skipped: true, note: "no phone number on the site to call" };
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (!digits) return { changed: [], skipped: true, note: `"${phone}" is not a dialable number` };
  const accent = brand || "#1c1d29";
  const js = [
    "/* g99-call-now — sticky call bar on phones. Added by pre-release: this model",
    "   has no theme footer to put it in, so it rides the site-wide snippet. */",
    "(function () {",
    '  if (document.querySelector(".g99-call-now")) return;',
    '  var css = document.createElement("style");',
    '  css.textContent = ".g99-call-now{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:none;' +
      `background:${accent};color:#fff;text-align:center;padding:14px 16px;font-weight:600;` +
      'text-decoration:none;font-size:16px;letter-spacing:.02em}' +
      "@media(max-width:767px){.g99-call-now{display:block}body{padding-bottom:52px}}\";",
    "  document.head.appendChild(css);",
    '  var a = document.createElement("a");',
    '  a.className = "g99-call-now";',
    `  a.href = "tel:${digits}";`,
    `  a.textContent = "Call ${String(phone).trim()}";`,
    "  document.body.appendChild(a);",
    "})();",
  ].join("\n");
  return { changed: writeSnippet(root, js), note: `sticky Call Now bar added to the site-wide snippet, dialling ${phone}` };
}

function blogState(root) {
  const templates = subdirs(root, "templates");
  const single = templates.filter((t) => /single-post|archive|blog|categor/i.test(t));
  return { has: !!single.length || !!subdirs(root, "posts").length, templates: single };
}
// The blog sidebar is a resource after all — resources/widgets.json carries both
// the widget instances and the sidebar assignment, and WidgetConfig reconciles it.
// What it cannot do is invent a sidebar: `sidebars_widgets` lists the areas the
// active theme registered at export time, and a theme like hello-elementor
// registers none. So this answers one of three ways, and only the middle one is a
// deferral.
const WIDGETS_FILE = "widgets.json";
function fixBlogSidebar(root) {
  const blog = blogState(root);
  if (!blog.has) return { changed: [], skipped: true, note: "this site has no blog — sidebar not applicable" };
  const abs = res(root, WIDGETS_FILE);
  const cfg = readJson(abs);
  if (!cfg || typeof cfg.sidebars_widgets !== "object") {
    return { changed: [], skipped: true, note: `${RES}/${WIDGETS_FILE} is missing or has no sidebars_widgets — nothing to assign into` };
  }
  const areas = Object.keys(cfg.sidebars_widgets).filter((k) => k !== "wp_inactive_widgets");
  if (!areas.length) {
    return { changed: [], note: "the active theme registers no widget areas, so the blog has no sidebar to fill — its layout is the theme's" };
  }
  const target = areas.find((a) => /blog|post|sidebar-1|primary/i.test(a)) || areas[0];
  const current = Array.isArray(cfg.sidebars_widgets[target]) ? cfg.sidebars_widgets[target] : [];
  if (current.length) return { changed: [], note: `${target} already holds ${current.length} widget(s)` };
  // Prefer widgets the site already owns — they carry its own styling and copy —
  // over inventing new instances the export would not recognise.
  const spare = (cfg.sidebars_widgets.wp_inactive_widgets || []).filter((w) => /^block-\d+$/.test(w));
  if (!spare.length) return { changed: [], skipped: true, note: `${target} is empty and there are no inactive widgets to move into it` };
  cfg.sidebars_widgets[target] = spare;
  cfg.sidebars_widgets.wp_inactive_widgets = (cfg.sidebars_widgets.wp_inactive_widgets || []).filter((w) => !spare.includes(w));
  writeJson(abs, cfg);
  return { changed: [`${RES}/${WIDGETS_FILE}`], note: `moved ${spare.length} widget(s) into ${target}` };
}
// custom-css.css is only written when it already exists. Absent, it means the
// site's Additional CSS lives in the database and creating the file would replace
// it with these four lines.
function fixBlogLinkColor(root, brand, mark) {
  const blog = blogState(root);
  if (!blog.has) return { changed: [], note: "this site has no blog", skipped: true };
  if (!brand) return { changed: [], note: "no brand colour detected", skipped: true };
  const abs = res(root, "custom-css.css");
  // Creating this file used to be refused on the grounds that it would replace
  // the site's Additional CSS. It cannot: Exporter::exportCustomCss writes the
  // file from wp_get_custom_css() and DELETES it when the site has none, so an
  // absent file means there is no Additional CSS to lose. CustomCssConfig is also
  // only applied when the release actually touched this path.
  //
  // The one way that reasoning fails is drift — somebody typing into Appearance →
  // Additional CSS without a re-export. That is a pull request a human reads
  // before merging, and the file it adds is four lines long.
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const marker = `${mark}:blog-links`;
  if (cur.includes(marker)) return { changed: [], note: "blog link colour already set" };
  const block = [
    `/* ${marker} — in-content links inherited the theme default, not the brand. */`,
    ".entry-content a:not(.button):not(.btn),", ".elementor-widget-theme-post-content a:not(.button):not(.btn) {",
    `    color: ${brand};`, "    text-decoration: underline;", "}", "",
  ].join("\n");
  fs.writeFileSync(abs, cur.trim() ? cur.replace(/\s*$/, "\n") + "\n" + block : block);
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
  hasProThemeBuilder, fix404,
  fixCallNow, fixBlogSidebar, snippetContent, writeSnippet, fixedCallLink,
};
