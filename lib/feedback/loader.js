// The review widget's delivery vehicle for GitOps sites.
//
// On a classic site the widget arrives with `review-plugin.js`, and the PHP
// there does the security work: it redeems `?g99r=` server-side, swaps it for an
// HttpOnly cookie, and proxies every call so the browser never holds a
// credential and never talks to the build tool. That plugin cannot be used here.
// `installReviewPlugin` refuses GitOps sites outright, because their deployer
// promotes only the g99-control package and a plugin written beside it merges
// into git and never runs.
//
// What DOES reach a GitOps site is `resources/cpt/wpcode/<slug>/cpt.json`, whose
// content WPCode prints as an inline <script> on every page. That channel is
// verified live on more than one site. So the widget ships as JavaScript, and
// the token it needs has to live in the browser.
//
// Shipping PHP through the same channel would have kept the stronger model, and
// was deliberately rejected: WPCode runs PHP snippets, so it would have handed
// the build tool arbitrary code execution on every client site, turning a leaked
// deploy credential from defacement into remote code execution on sites we do
// not own. A token in sessionStorage is a real cost; that is a bigger one.
//
// Everything below is the compensation for giving up the cookie:
//
//   * the token is out of the URL before the page finishes loading, so it does
//     not reach history, bookmarks, or the Referer sent to any third-party
//     asset the page loads afterwards;
//   * it lives in sessionStorage, not localStorage, so closing the tab ends it;
//   * it is checked against the tool before any UI is injected, so an expired or
//     forged link shows nothing and stores nothing;
//   * it is bound to this exact host by the tool, which refuses to answer a
//     browser calling from any other origin.
"use strict";

// Same shape check the server applies, so an obviously malformed token is
// dropped in the page rather than sent anywhere.
const fs = require("fs");
const path = require("path");

const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Build the WPCode snippet for one site.
 *
 * @param {object} arg
 * @param {string} arg.toolUrl  public origin of the build tool
 * @param {string} arg.siteId   the site this snippet belongs to, for logging only
 * @returns {string} raw JavaScript — no <script> wrapper, which kses would strip
 */
function reviewLoaderSource({ toolUrl, siteId }) {
  const TOOL = String(toolUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(TOOL)) throw new Error("reviewLoaderSource needs an absolute toolUrl");
  // JSON.stringify, not quotes, so a stray apostrophe in a site id cannot end
  // the string literal and turn data into code.
  const J = (v) => JSON.stringify(String(v == null ? "" : v));

  return `/* Growth99 review loader — renders nothing unless the visitor arrived
   through a signed review link. Site: ${String(siteId || "").replace(/\*\//g, "")}

   This snippet MUST be saved as a JavaScript snippet. WPCode's default for an
   imported snippet is HTML, and as HTML this file is printed into the page as
   text and never runs — which looks exactly like the snippet not being there
   at all. Observed on a live site: the snippet existed, was active, held the
   right code, and did nothing, until the type was corrected. */
(function () {
  "use strict";
  var TOOL = ${J(TOOL)};
  var KEY = "g99r.token";

  // Take the token from the URL if it is there, and take it OUT of the URL in
  // the same breath. Doing this before the widget loads matters: anything the
  // page fetches afterwards would otherwise carry the token in its Referer.
  var token = null;
  try {
    var m = location.search.match(/[?&]g99r=([^&#]+)/);
    if (m) {
      token = decodeURIComponent(m[1]);
      // Absolute, built from location.origin, NOT relative. A relative URL is
      // resolved against the document's base URI, so on any page carrying a
      // <base> tag replaceState would throw SecurityError for pointing at
      // another origin — and the token would silently stay in the address bar,
      // which is the one thing this code exists to prevent. Observed for real.
      var clean = location.origin + location.pathname
        + location.search.replace(/([?&])g99r=[^&#]*&?/, "$1").replace(/[?&]$/, "")
        + location.hash;
      try { history.replaceState(null, "", clean); } catch (e) { /* older browser: the link still works */ }
    }
  } catch (e) { return; }

  // No token in the URL means either a plain visitor, or a reviewer who has
  // navigated to a second page. Only the second case has something stored.
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else token = sessionStorage.getItem(KEY);
  } catch (e) { /* private mode: reviewing still works, it just won't survive navigation */ }

  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return;

  // Read the reviewer's name and expiry straight out of the token.
  //
  // This is NOT a security check and is not pretending to be one — the
  // signature can only be checked by the server that holds the secret, and it is,
  // on every submission. All this decides is whose name to print and whether to
  // bother showing a panel that has already expired. Believing a forged name here
  // costs nothing: the forger still cannot get a single change applied.
  var claims = null;
  try {
    claims = JSON.parse(decodeURIComponent(escape(atob(
      token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")
    ))));
  } catch (e) { return; }
  if (!claims || !claims.exp || Date.now() > claims.exp) {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing to clear */ }
    return;
  }

  // A link minted against a tunnelled build tool carries where to send the work.
  // Signed, so only someone holding REVIEW_SECRET can move it, and https-only.
  // Without it the snippet's own baked-in address is used, which is the case for
  // every real reviewer.
  var tool = TOOL;
  // Checked without a regex on purpose: this string is emitted through a
  // template literal, where a backslash means something to the literal before
  // it ever means anything to the pattern.
  if (typeof claims.tool === "string"
      && claims.tool.indexOf("https://") === 0
      && claims.tool.indexOf("/", 8) === -1) {
    tool = claims.tool;
  }

  window.G99_REVIEW = {
    rest: tool + "/api/webhook/review",
    path: location.pathname,
    reviewer: claims.reviewer || "Reviewer",
    token: token,
  };

  // The widget itself follows, inlined. It used to be fetched from the build
  // tool, which quietly made the tool a dependency of simply LOOKING at the
  // page: tool slow or down, and no panel appeared at all. Nothing about
  // reading a page, picking an element and writing a note needs a server —
  // notes queue in localStorage and survive navigation on their own. Only
  // pressing Submit needs the tool, and that genuinely does, because that is
  // where the build job runs.
  //
  // The cost of inlining is that each site carries its own copy, so a change to
  // the widget reaches a site only when that site is next pushed. That is worth
  // paying for a reviewer who is never blocked by a service they do not own.
})();
`;
}

/**
 * The GitOps resource file that carries the snippet.
 *
 * Deliberately its own slug rather than an addition to `g99-site-js`: that one
 * is regenerated by compile.js from the site's design, so anything appended to
 * it would disappear on the next build.
 */
/**
 * The complete snippet: the loader above, followed by the widget itself.
 *
 * Read from disk rather than duplicated, so there is exactly one copy of the
 * widget in this repository and no way for the shipped one to drift from the
 * one served at /review-widget.js.
 */
function reviewSnippetSource({ toolUrl, siteId }) {
  const widget = fs.readFileSync(path.join(__dirname, "..", "..", "public", "review-widget.js"), "utf8");
  // WPCode prints this inside a <script> block, so a literal "</script>" in the
  // source would end it early and spill the rest onto the page as text. There is
  // none today; this refuses rather than shipping a broken page if one appears.
  if (/<\/script/i.test(widget)) throw new Error("review-widget.js contains </script> and cannot be inlined");
  return reviewLoaderSource({ toolUrl, siteId }) + "\n" + widget;
}

function reviewLoaderCpt({ toolUrl, siteId }) {
  return {
    schema_version: 1,
    git_id: "cpt-wpcode-g99-review",
    type: "wpcode",
    slug: "g99-review",
    title: "G99 review widget loader",
    status: "publish",
    content: reviewSnippetSource({ toolUrl, siteId }),
    meta: {
      _wpcode_code_type: "js",
      _wpcode_location: "site_wide_footer",
      _wpcode_auto_insert: "1",
      // After the site's own JS, which has no bearing on the widget but keeps
      // the ordering obvious to anyone reading the rendered page.
      _wpcode_priority: "20",
    },
    media: [],
  };
}

module.exports = { reviewLoaderSource, reviewSnippetSource, reviewLoaderCpt, TOKEN_RE };
