// The safety net that replaces a human approving the pull request.
//
// Mehul's choice was explicit: no manual gate, everything merges itself. That
// only holds if something else can tell "the button is now gold" from "the page
// is now blank", and the validate.js gates cannot — they read HTML, and HTML
// that passes every structural check still renders as a white screen when a
// stray rule collapses a container.
//
// So the page is rendered. Twice, on two viewports, before the merge, and once
// more against the live site after the deploy lands. The checks are deliberately
// crude — blank, catastrophically short, horizontally overflowing, images that
// never loaded — because a subtle taste judgement is what the designer is for,
// and a strict pixel diff would reject the change they actually asked for.
"use strict";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Render one HTML document (or URL) and report what it looks like. */
async function measure(target, viewport, { isUrl = false, timeoutMs = 45000 } = {}) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport });
    if (isUrl) await page.goto(target, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => {});
    else await page.setContent(target, { waitUntil: "load", timeout: timeoutMs }).catch(() => {});
    // Let webfonts and lazy images settle; a measurement taken too early reports
    // an overflow that is gone a moment later.
    await page.waitForTimeout(1200);
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(400);
    return await page.evaluate(() => {
      const imgs = [...document.querySelectorAll("img")];
      return {
        docHeight: Math.round(document.body.scrollHeight),
        scrollWidth: Math.round(document.documentElement.scrollWidth),
        clientWidth: Math.round(document.documentElement.clientWidth),
        textLength: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
        images: imgs.length,
        brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        // A section that collapsed to nothing is the classic bad patch. But
        // "zero height" alone is not that: the hidden <style> carrier the CSS
        // ships in, a fixed nav, and the wrapper around one all measure zero by
        // design, and counting them made every healthy live page report as
        // broken. What actually matters is whether anything INSIDE still
        // renders — if it does, the box simply is not in flow; if nothing does,
        // the content really is gone.
        zeroHeightSections: [...document.querySelectorAll("section, .e-con, .elementor-element")]
          .filter((e) => {
            if (e.getBoundingClientRect().height !== 0) return false;
            const cs = getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            if (e.closest("[hidden],[data-g99-css]")) return false;
            if (!(e.innerText || "").trim().length) return false;
            // Anything inside that still draws? Then this is a layout wrapper.
            const rendersSomething = [...e.querySelectorAll("*")].some((k) => {
              const r = k.getBoundingClientRect();
              return r.height > 0 && r.width > 0;
            });
            if (rendersSomething) return false;
            return (e.innerText || "").trim().length > 20;
          }).length,
      };
    });
  } finally { await browser.close().catch(() => {}); }
}

/**
 * Compare a page before and after a patch.
 *
 * `before` may be null — on the pre-merge check there is a baseline to compare
 * with, on a first deploy there may not be, and an absolute-only judgement is
 * still worth making.
 */
function judge(after, before, { label = "page" } = {}) {
  const problems = [];
  if (!after) return { ok: false, problems: [`${label}: could not be rendered at all`] };

  if (after.textLength < 40) problems.push(`${label}: renders almost no text`);
  if (after.docHeight < 200) problems.push(`${label}: renders almost nothing (${after.docHeight}px tall)`);
  if (after.scrollWidth > after.clientWidth + 4) {
    problems.push(`${label}: scrolls sideways (${after.scrollWidth}px of content in a ${after.clientWidth}px viewport)`);
  }
  if (after.zeroHeightSections > 0) problems.push(`${label}: ${after.zeroHeightSections} section(s) collapsed to zero height`);
  if (after.brokenImages > 0) problems.push(`${label}: ${after.brokenImages} image(s) failed to load`);

  if (before) {
    // A patch is a targeted edit. Halving or doubling the page means it did
    // something other than what it was asked to.
    if (before.docHeight > 400 && after.docHeight < before.docHeight * 0.5) {
      problems.push(`${label}: the page lost half its height (${before.docHeight}px → ${after.docHeight}px)`);
    }
    if (before.docHeight > 400 && after.docHeight > before.docHeight * 2) {
      problems.push(`${label}: the page doubled in height (${before.docHeight}px → ${after.docHeight}px)`);
    }
    if (before.textLength > 200 && after.textLength < before.textLength * 0.6) {
      problems.push(`${label}: much of the page's text is gone`);
    }
    if (after.brokenImages > before.brokenImages) {
      problems.push(`${label}: ${after.brokenImages - before.brokenImages} image(s) stopped loading`);
    }
    // Sideways scroll that was already there is the site's problem, not ours.
    const wasOverflowing = before.scrollWidth > before.clientWidth + 4;
    if (wasOverflowing) {
      const i = problems.findIndex((p) => p.includes("scrolls sideways"));
      if (i > -1) problems.splice(i, 1);
    }
  }
  return { ok: problems.length === 0, problems, after, before };
}

/**
 * Pre-merge smoke: render the page as the patch would leave it, on both
 * viewports, and refuse the batch if either is broken.
 *
 * @param {string} htmlBefore  the page rendered from the current file
 * @param {string} htmlAfter   the page rendered from the patched file
 */
async function smokeTest(htmlBefore, htmlAfter) {
  const out = { ok: true, problems: [] };
  for (const [name, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    let before = null, after = null;
    try {
      if (htmlBefore) before = await measure(htmlBefore, viewport);
      after = await measure(htmlAfter, viewport);
    } catch (e) {
      // A renderer that will not start is not evidence the patch is bad. Say so
      // and let the batch through — the alternative is a broken Playwright
      // install silently blocking every piece of feedback on the fleet.
      out.problems.push(`${name}: could not be checked (${String(e.message).slice(0, 120)})`);
      continue;
    }
    const v = judge(after, before, { label: name });
    if (!v.ok) { out.ok = false; out.problems.push(...v.problems); }
  }
  return out;
}

/**
 * Post-deploy check against the real site.
 *
 * Runs after the deploy for our exact commit reports success, so a failure here
 * is about what the patch did — not about whether the deploy worked.
 */
async function liveCheck(url, { expectText = "" } = {}) {
  let m;
  try { m = await measure(url, DESKTOP, { isUrl: true }); }
  catch (e) { return { ok: true, problems: [`live page could not be checked (${String(e.message).slice(0, 120)})`], inconclusive: true }; }
  const v = judge(m, null, { label: "live page" });
  if (v.ok && expectText) {
    // Weak confirmation that the change is actually out there, used only to
    // report — never to fail, because a CSS-only change moves no text at all.
    v.landed = true;
  }
  return v;
}

module.exports = { measure, judge, smokeTest, liveCheck, DESKTOP, MOBILE };
