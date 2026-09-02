// A picture of the thing the note is about.
//
// Captured here rather than in the browser. The obvious approach — rasterise
// the element client-side with an html2canvas-style library — was tried on
// paper and rejected: it means inlining tens of kilobytes into every review
// page through the mu-plugin's heredoc, and browser rasterisation degrades on
// exactly the content these sites are made of (cross-origin photos taint the
// canvas, webfonts and CSS background-images frequently do not draw). The
// server already runs Playwright for screenshots elsewhere, and a real browser
// rendering the real page has none of those problems.
//
// The capture is best-effort throughout. A note with no picture is worth
// acting on; a batch that fails because a screenshot timed out is not.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SHOT_DIR = path.join(__dirname, "..", "..", "generated", "feedback-shots");
const MAX_BYTES = 1.5 * 1024 * 1024;
const PAD = 24;                 // context around the element, in CSS px

function ensureDir() {
  try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (e) { /* checked by the caller's write */ }
}

/**
 * Screenshot the section a note was left on.
 *
 * @param {string} pageUrl     absolute URL of the live page
 * @param {string} elementId   Elementor element id (without the class prefix)
 * @param {object} [opts]
 * @returns {Promise<{file: string, rel: string, bytes: number}|null>}
 */
async function captureElement(pageUrl, elementId, opts = {}) {
  const url = String(pageUrl || "");
  const id = String(elementId || "");
  if (!/^https?:\/\//i.test(url) || !/^[A-Za-z0-9_-]{4,32}$/.test(id)) return null;

  let browser = null;
  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: opts.width || 1440, height: opts.height || 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs || 45000 });
    // Lazy images only load once their box has been near the viewport, and a
    // section photographed before they arrive is a picture of empty frames.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 70)); }
      scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(900);

    const el = await page.$(`.elementor-element-${id}`);
    if (!el) return null;
    const box = await el.boundingBox();
    if (!box || box.width < 4 || box.height < 4) return null;

    const vw = page.viewportSize() || { width: 1440, height: 900 };
    const full = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.body.scrollHeight }));
    const clip = {
      x: Math.max(0, box.x - PAD),
      y: Math.max(0, box.y - PAD),
      width: Math.min(box.width + PAD * 2, full.w),
      height: Math.min(box.height + PAD * 2, Math.max(200, full.h)),
    };
    // A full-bleed hero can be taller than anything worth sending to a model.
    if (clip.height > 2200) clip.height = 2200;
    if (clip.x + clip.width > full.w) clip.width = Math.max(10, full.w - clip.x);

    ensureDir();
    const name = `${id}-${crypto.randomBytes(4).toString("hex")}.png`;
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({ path: file, clip, fullPage: true });
    const bytes = fs.statSync(file).size;
    if (bytes > MAX_BYTES) { try { fs.unlinkSync(file); } catch (e) { /* nothing to clean */ } return null; }
    return { file, rel: path.join("generated", "feedback-shots", name), bytes };
  } catch (e) {
    console.warn(`feedback: screenshot of ${id} failed — ${String(e.message).slice(0, 140)}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** A captured shot as a Gemini image part, or null. */
function asGeminiPart(shot) {
  if (!shot || !shot.file) return null;
  try {
    return { inlineData: { mimeType: "image/png", data: fs.readFileSync(shot.file).toString("base64") } };
  } catch (e) { return null; }
}

/** Delete captures older than a week; they are debugging aids, not records. */
function prune(maxAgeMs = 7 * 24 * 3600e3) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(SHOT_DIR)) {
      const abs = path.join(SHOT_DIR, f);
      try {
        if (Date.now() - fs.statSync(abs).mtimeMs > maxAgeMs) { fs.unlinkSync(abs); removed++; }
      } catch (e) { /* already gone */ }
    }
  } catch (e) { /* directory absent: nothing to prune */ }
  return removed;
}

module.exports = { captureElement, asGeminiPart, prune, SHOT_DIR };
