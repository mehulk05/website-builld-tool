// Serving a stored generation back as a browsable website.
//
// The pages we store are, by luck and by design, self-contained: their CSS is in
// inline <style> blocks, their JS in one inline <script>, and every image and
// font is an absolute https URL. Nothing has to be fetched from the WordPress
// site the pages were built for. That leaves exactly one thing broken when the
// same bytes are served from /preview/<client>/v<n>/: the site-root nav links.
//
// So this file does the minimum that makes a preview walkable — it rewrites
// those links and touches nothing else. Byte fidelity matters here: the point of
// the archive is to see what was actually generated, not our idea of it.
"use strict";

// slug -> the paths that page answers to on a real WordPress site.
// "home" is the site root; the rest are their own directory.
const ROUTES = {
  home: ["/", "/index.html"],
  services: ["/services", "/services/", "/services.html"],
  about: ["/about", "/about/", "/about.html"],
  contact: ["/contact", "/contact/", "/contact.html"],
};

/** The preview URL for one page of one version. */
function previewUrl(clientKey, version, slug) {
  const base = `/preview/${encodeURIComponent(clientKey)}/v${Number(version)}`;
  return slug === "home" ? base + "/" : `${base}/${encodeURIComponent(slug)}`;
}

/**
 * Which stored slug a preview path is asking for.
 *
 * Accepts the slug directly (/preview/x/v1/services) and the site-shaped
 * spellings a rewritten link or a hand-typed URL might use (/services/,
 * /services.html), so a link we rewrote and a link the user types agree.
 *
 * @returns {string} the slug, or "" if the rest of the path names nothing
 */
function slugForPath(rest) {
  const clean = "/" + String(rest || "").replace(/^\/+/, "");
  if (clean === "/") return "home";
  for (const [slug, paths] of Object.entries(ROUTES)) {
    if (paths.includes(clean)) return slug;
  }
  const bare = clean.replace(/^\//, "").replace(/\/$/, "").replace(/\.html$/i, "");
  return /^[a-z0-9][a-z0-9-]*$/i.test(bare) ? bare : "";
}

/**
 * Point a stored page's root-relative nav links at this version's preview.
 *
 * Deliberately narrow: only href values that are exactly a known site path get
 * touched. An href="/#book" or href="/services/dysport" is left alone — it would
 * 404 either way, and guessing at it risks corrupting markup we are meant to be
 * archiving faithfully.
 *
 * Pages a version does not have are dropped to "#" rather than left pointing at
 * the live site, so a preview can never quietly navigate off the archive.
 *
 * @param {string} html        the stored page, exactly as generated
 * @param {string} clientKey
 * @param {number} version
 * @param {string[]} haveSlugs slugs actually stored for this version
 * @returns {{html: string, rewrote: number}}
 */
function rewriteNav(html, clientKey, version, haveSlugs) {
  const have = new Set(haveSlugs || []);
  let rewrote = 0;
  const out = String(html || "").replace(/(\shref=)(["'])([^"']*)\2/gi, (m, attr, quote, value) => {
    const slug = slugForPath(value);
    // Only exact site paths, and only ones this version actually stored a page
    // for — anything else keeps the bytes it was archived with.
    if (!slug || !ROUTES[slug]) return m;
    if (!ROUTES[slug].includes(value.startsWith("/") ? value : "/" + value)) return m;
    rewrote++;
    const target = have.has(slug) ? previewUrl(clientKey, version, slug) : "#";
    return `${attr}${quote}${target}${quote}`;
  });
  return { html: out, rewrote };
}

module.exports = { ROUTES, previewUrl, slugForPath, rewriteNav };
