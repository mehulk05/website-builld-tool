// Putting a picture into a section that has none.
//
// The image path was written only to REPLACE: find the <img> the reviewer
// clicked, point it somewhere else. A section with no picture in it fell through
// to `return null`, so "add an image here" — with the file already uploaded and
// a URL already issued — came back as something the tool could not do. That was
// never a decision anyone made; it fell out of the shape of a function.
//
// No model is involved. Where a picture goes in a section built from this
// system's own layout classes has one sensible answer, and a model asked to
// place it would rewrite the surrounding markup to get there.
"use strict";

/**
 * Index of the closing tag matching the element that opens at `from`.
 *
 * Counted, not searched for. The first `</div>` after a wrapper is almost never
 * that wrapper's own, so appending there drops the picture inside whichever
 * child happened to come first rather than in the container the reviewer is
 * looking at.
 *
 * @returns {number} index of the matching closing tag, or -1
 */
function closingTagFor(html, from, tagName) {
  const re = new RegExp("<(/?)" + tagName + "\\b[^>]*>", "gi");
  re.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else if (!/\/>\s*$/.test(m[0])) {
      depth++;
    }
  }
  return -1;
}

/**
 * Add a picture to a section that has none.
 *
 * It goes inside the section's content wrapper, at the end — not after the
 * closing tag, where it would sit outside the section's width and padding and
 * read as a mistake rather than a change.
 *
 * @param {string} html the section's markup
 * @param {string} url  a public URL for the uploaded file
 * @returns {{html: string, what: string}|null} null when there is nowhere sensible to put it
 */
function insertImage(html, url) {
  const src = String(html || "");
  if (!/^https?:\/\//i.test(String(url || ""))) return null;

  // Inline styles rather than a class: a class would need a rule, the rule would
  // need a home in this section's CSS block, and the whole point of this path is
  // that it does not depend on a model getting both halves right.
  const tag = `<img src="${url}" alt="" loading="lazy"`
    + ` style="max-width:100%;height:auto;display:block;margin-top:1.5rem">`;

  // Preferred home: the last .u-wrap, which is this system's content container.
  const wraps = [...src.matchAll(/<div\b[^>]*class="[^"]*\bu-wrap\b[^"]*"[^>]*>/gi)];
  if (wraps.length) {
    const open = wraps[wraps.length - 1];
    const close = closingTagFor(src, open.index, "div");
    if (close > -1) return { html: src.slice(0, close) + tag + src.slice(close), what: "image added" };
  }

  // Otherwise just inside the section itself.
  const sec = src.match(/<section\b[^>]*>/i);
  if (sec) {
    const close = closingTagFor(src, sec.index, "section");
    if (close > -1) return { html: src.slice(0, close) + tag + src.slice(close), what: "image added" };
  }

  return null;
}

module.exports = { insertImage, closingTagFor };
