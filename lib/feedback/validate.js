// The gates a model-written patch has to pass before it can be merged.
//
// Everything in this pipeline auto-merges. That is a deliberate choice — a
// review loop with a human approval step is slower than the email it replaces —
// but it means nothing downstream will catch a bad patch, so the checks have to
// be here and they have to be refusals rather than warnings.
//
// The rules come from two places. Some are safety: a model asked to restyle a
// button must not be able to introduce a <script>, an onclick, an iframe or a
// javascript: URL into a client's live site. The rest are "did it actually do
// the job": a patch that comes back byte-identical, or that rewrites the whole
// section when the note said "make the button gold", is a failure even though
// it is valid HTML — silently shipping it would teach the reviewer their
// feedback works when it does not.
"use strict";

// Grow more than this and the model has rewritten rather than patched.
const MAX_GROWTH = 2.5;
const MAX_BYTES = 200 * 1024;
const MAX_CSS_BYTES = 20 * 1024;

const SCRIPTISH = /<\s*(script|iframe|object|embed|form|meta|base|link)\b/i;
const EVENT_ATTR = /\son[a-z]{3,20}\s*=/i;
// javascript:, data: (anything but images), vbscript: — in href/src/action.
const BAD_URL = /(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*(?:javascript:|vbscript:|data:(?!image\/(?:png|jpe?g|gif|webp|svg\+xml)))/i;
const STYLE_EXPR = /(?:expression\s*\(|@import|behaviou?r\s*:|-moz-binding)/i;

/** Tags whose count must not change — a patch may restyle, not delete content. */
// A section on these sites carries its own <style>: the markup and the rules that
// make it look like anything travel together in one html widget. A rewrite that
// drops the <style> keeps every word and every image and still guts the section,
// which is why it slipped past a check built around content tags. Seen live: one
// card’s wording changed, and all three lost their styling with it.
const COUNTED = ["img", "a", "h1", "h2", "h3", "form", "input", "video", "iframe", "style"];

function countTags(html) {
  const out = {};
  for (const tag of COUNTED) {
    out[tag] = (String(html).match(new RegExp(`<\\s*${tag}\\b`, "gi")) || []).length;
  }
  return out;
}

/** Rough DOM size, used only to spot a patch that collapsed a section. */
function elementCount(html) {
  return (String(html).match(/<[a-zA-Z][^>]*>/g) || []).length;
}

/**
 * Does the patched HTML look like a targeted edit of the original?
 *
 * @param {string} before  fragment as it is in Git
 * @param {string} after   fragment the model returned
 * @param {object} opts    {allowStructural} — set when a note explicitly asks
 *                         to add or remove something, so the counts may move
 * @returns {{ok: boolean, reason?: string}}
 */
function checkHtml(before, after, opts = {}) {
  const b = String(before || ""), a = String(after || "");
  if (!a.trim()) return { ok: false, reason: "the rewritten section came back empty" };
  if (a.length > MAX_BYTES) return { ok: false, reason: "the rewritten section is implausibly large" };
  // Unchanged markup is only a failure when nothing else changed either. Plenty
  // of real notes — spacing, colour, size — are correctly carried out in CSS
  // alone, and the model returning the HTML untouched is the RIGHT answer to
  // them. Rejecting that outright refused a legitimate patch in the first live
  // run ("give this heading more space above it").
  if (a === b && !opts.cssChanged) {
    return { ok: false, reason: "the section came back unchanged — the note was not applied" };
  }
  if (a === b) return { ok: true, cssOnly: true };

  if (SCRIPTISH.test(a) && !SCRIPTISH.test(b)) return { ok: false, reason: "the rewrite introduced a script, iframe or form" };
  if (EVENT_ATTR.test(a) && !EVENT_ATTR.test(b)) return { ok: false, reason: "the rewrite introduced an inline event handler" };
  if (BAD_URL.test(a)) return { ok: false, reason: "the rewrite introduced an unsafe URL" };
  if (STYLE_EXPR.test(a) && !STYLE_EXPR.test(b)) return { ok: false, reason: "the rewrite introduced an unsafe CSS construct" };

  if (b.length && a.length > b.length * MAX_GROWTH) {
    return { ok: false, reason: "the rewrite is much larger than the section it replaces, which usually means it rebuilt rather than edited it" };
  }
  // A patch that halves the DOM has dropped content the note never mentioned.
  const eb = elementCount(b), ea = elementCount(a);
  if (!opts.allowStructural && eb >= 6 && ea < eb * 0.5) {
    return { ok: false, reason: "the rewrite removed much of the section" };
  }
  if (!opts.allowStructural) {
    const cb = countTags(b), ca = countTags(a);
    for (const tag of COUNTED) {
      if (ca[tag] < cb[tag]) {
        return { ok: false, reason: `the rewrite dropped ${cb[tag] - ca[tag]} <${tag}> element(s) the feedback did not ask to remove` };
      }
    }
  }
  // Unbalanced markup would be spliced straight into the page. A cheap depth
  // check catches the common truncation case (a model that ran out of tokens).
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
  let depth = 0;
  for (const m of a.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    if (VOID.test(m[2]) || /\/\s*$/.test(m[3])) continue;
    depth += m[1] ? -1 : 1;
    if (depth < 0) return { ok: false, reason: "the rewritten section has unbalanced HTML" };
  }
  if (depth !== 0) return { ok: false, reason: "the rewritten section has unclosed HTML tags" };
  return { ok: true };
}

/**
 * CSS the model wants added for this section, scoped so it can only affect that
 * section.
 *
 * Unscoped CSS in a page-level stylesheet is how one note about one button
 * silently restyles the whole site, so every rule has to be confined to the
 * section's own Elementor id. The first version of this REJECTED unscoped CSS,
 * which turned out to be worse than useless in practice: the model would add a
 * class to the markup and put the rule that makes the class mean something in
 * the CSS, the CSS would be dropped, and the item still reported as applied —
 * a class that styles nothing, and a reviewer told their change was live.
 *
 * So it is scoped here instead. Prefixing a selector can only ever narrow what
 * it matches, never widen it, so doing it for the model is strictly safer than
 * trusting it to — and it actually carries out the note.
 */
function checkCss(css, containerId) {
  const s = String(css || "");
  if (!s.trim()) return { ok: true, css: "" };
  if (s.length > MAX_CSS_BYTES) return { ok: false, reason: "the added CSS is implausibly large" };
  if (STYLE_EXPR.test(s)) return { ok: false, reason: "the added CSS uses an unsafe construct" };
  if (/<\s*\//.test(s) || /<\s*script/i.test(s)) return { ok: false, reason: "the added CSS contains markup" };

  const scope = `.elementor-element-${containerId}`;
  const bad = [];
  let scopedCount = 0;

  // Brace-aware: @media blocks are descended into rather than rejected (a
  // responsive tweak is legitimate), anything else starting with @ is not
  // something a section-scoped patch has any business emitting.
  const walk = (block) => {
    const out = [];
    let i = 0;
    while (i < block.length) {
      const open = block.indexOf("{", i);
      if (open < 0) { break; }
      const header = block.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < block.length && depth) { if (block[j] === "{") depth++; else if (block[j] === "}") depth--; j++; }
      const body = block.slice(open + 1, j - 1);

      if (/^@media/i.test(header)) {
        const inner = walk(body);
        if (inner.trim()) out.push(`${header}{${inner}}`);
      } else if (/^@/.test(header)) {
        bad.push(header.split(/\s/)[0]);
      } else if (header) {
        const sels = header.split(",").map((x) => x.trim()).filter(Boolean).map((sel) => {
          if (sel.includes(scope)) return sel;
          scopedCount++;
          // `:root`/`html`/`body` cannot be narrowed into a section — a rule on
          // one of those is asking to restyle the page, which is not what a note
          // about one section can authorise.
          if (/^(?::root|html|body)\b/i.test(sel)) { bad.push(sel.slice(0, 60)); return null; }
          return `${scope} ${sel}`;
        }).filter(Boolean);
        if (sels.length) out.push(`${sels.join(",")}{${body}}`);
      }
      i = j;
    }
    return out.join("\n");
  };

  const scoped = walk(s);
  if (bad.length) return { ok: false, reason: `the added CSS tries to reach outside this section (${bad.slice(0, 3).join(", ")})` };
  if (!scoped.trim()) return { ok: true, css: "" };
  return { ok: true, css: scoped, rescoped: scopedCount };
}

/**
 * Did the patch visibly address each note it claimed to?
 *
 * The model is asked to report which item ids it handled. That claim is checked
 * against the diff: a patch that says it fixed three things but changed nothing
 * relevant to two of them would otherwise report success on all three, and the
 * reviewer would believe it.
 *
 * This is intentionally weak evidence — "something about this changed" — because
 * the strong version (understanding whether a padding change is the padding
 * change that was asked for) is the model's job, not a regex's.
 */
/**
 * Rules whose selector cannot match anything in this section.
 *
 * A model asked to recolour a button will sometimes write
 * `.c-btn--red{background:red}` and forget to put `c-btn--red` on the button. The
 * CSS is valid, it passes every syntax check, it ships — and it styles nothing,
 * because the hook it names is not in the markup. That is indistinguishable from
 * success to anything that only asks "did the file change?", which is how a note
 * that did nothing at all came back reported as applied.
 *
 * Only class and id hooks are judged. A rule written against tags or attributes
 * (`a{...}`, `[data-x]{...}`) is left alone: it may well match, and guessing
 * wrong here would reject work that was fine.
 *
 * @param {string} css          already scoped by checkCss
 * @param {string} html         the section's markup AFTER the rewrite
 * @param {string} containerId  the scope prefix to ignore — it names the
 *                              wrapper, which is not part of the fragment
 * @returns {string[]} selectors that hook onto nothing
 */
function deadCssRules(css, html, containerId) {
  const markup = String(html || "");
  const scope = containerId ? new RegExp("\.elementor-element-" + String(containerId).replace(/[^A-Za-z0-9_-]/g, ""), "g") : null;
  // Every class actually present in the markup, from its class attributes only.
  const present = new Set();
  for (const m of markup.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    for (const c of String(m[2] || m[3] || "").split(/\s+/)) if (c) present.add(c);
  }
  for (const m of markup.matchAll(/\bid\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const v = String(m[2] || m[3] || "").trim();
    if (v) present.add("#" + v);
  }

  const dead = [];
  for (const m of String(css || "").matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector || selector.startsWith("@")) continue;
    let probe = selector;
    if (scope) probe = probe.replace(scope, " ");
    const classes = [...probe.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((x) => x[1]);
    const ids = [...probe.matchAll(/#([A-Za-z_][A-Za-z0-9_-]*)/g)].map((x) => "#" + x[1]);
    const hooks = classes.concat(ids);
    if (!hooks.length) continue;                       // tag/attribute rule — not judged
    if (hooks.some((h) => present.has(h))) continue;    // at least one hook is real
    dead.push(selector);
  }
  return dead;
}

function checkAddressed(before, after, css, items, addressedIds, containerId) {
  const claimed = new Set((addressedIds || []).map(String));
  const changedHtml = String(before) !== String(after);
  // CSS counts as a change only when it can actually take effect. See
  // deadCssRules: a rule naming a class nobody wears changes nothing.
  const cssText = String(css || "").trim();
  const dead = cssText ? deadCssRules(cssText, after, containerId) : [];
  const ruleCount = cssText ? [...cssText.matchAll(/[^{}]+\{[^{}]*\}/g)].length : 0;
  const allCssDead = ruleCount > 0 && dead.length >= ruleCount;
  const addedCss = !!cssText && !allCssDead;
  const out = [];
  // Asking the model which notes it handled only means something when it was
  // given more than one. With a single note, the claim adds no information the
  // before-and-after does not already carry, and making it a requirement means a
  // model that echoed a different id — or none — loses a rewrite that was
  // perfectly good. Seen live: the navigation path passes one synthetic note and
  // every correct rewrite came back "the rewrite did not say it addressed this".
  const mustClaim = items.length > 1;
  for (const it of items) {
    if (mustClaim && !claimed.has(String(it.localId)) && !claimed.has(String(it.id))) {
      out.push({ item: it, ok: false, reason: "the rewrite did not say it addressed this note" });
      continue;
    }
    if (!changedHtml && !addedCss) {
      out.push({
        item: it,
        ok: false,
        reason: allCssDead
          ? `the styling written for this note targets ${dead[0]}, which nothing in this section uses — so it would have changed nothing`
          : "nothing changed for this note",
      });
      continue;
    }
    out.push({ item: it, ok: true });
  }
  return out;
}

/**
 * Did a structural edit change exactly what it said it would?
 *
 * Every other check in this file assumes the set of nodes on a page never
 * changes: a section is rewritten in place, so anything that appeared or
 * vanished is a bug by definition. The structural operations break that
 * assumption on purpose, which means they need the assumption restated as an
 * explicit check rather than simply dropped.
 *
 * What this asserts:
 *   - every id that existed before is still there, except the ones the caller
 *     said it was removing;
 *   - nothing appeared that the caller did not say it was adding;
 *   - the relative order of the surviving sections is unchanged, unless the
 *     caller said it was moving one.
 *
 * The order check is what catches the off-by-one that array splicing invites: an
 * insert that lands one position out looks perfectly valid by every other
 * measure, and shows up only as a page whose sections are subtly in the wrong
 * sequence.
 *
 * @param {string[]} before   ids before the edit, in document order
 * @param {string[]} after    ids after
 * @param {object} expected
 * @param {string[]} [expected.added]     ids the operation created
 * @param {string[]} [expected.removed]   ids the operation deleted
 * @param {boolean} [expected.reordered]  true when a move was intended
 * @returns {{ok: boolean, reason?: string}}
 */
function checkNodeSet(before, after, expected = {}) {
  const was = new Set(before || []);
  const now = new Set(after || []);
  const added = new Set((expected.added || []).map(String));
  const removed = new Set((expected.removed || []).map(String));

  for (const id of was) {
    if (!now.has(id) && !removed.has(id)) {
      return { ok: false, reason: `the edit lost ${id}, which nothing asked it to remove` };
    }
  }
  for (const id of now) {
    if (!was.has(id) && !added.has(id)) {
      return { ok: false, reason: `the edit introduced ${id}, which nothing asked it to add` };
    }
  }
  for (const id of removed) {
    if (now.has(id)) return { ok: false, reason: `${id} was meant to be removed and is still on the page` };
  }
  for (const id of added) {
    if (!now.has(id)) return { ok: false, reason: `${id} was meant to be added and is not on the page` };
  }

  if (!expected.reordered) {
    // Compare only what survived, so an insert or a delete does not read as a
    // reorder simply because everything after it shifted.
    const survivingBefore = (before || []).filter((id) => now.has(id) && !added.has(id));
    const survivingAfter = (after || []).filter((id) => was.has(id) && !removed.has(id));
    for (let i = 0; i < survivingBefore.length; i++) {
      if (survivingBefore[i] !== survivingAfter[i]) {
        return { ok: false, reason: "the edit changed the order of sections that nothing asked it to move" };
      }
    }
  }
  return { ok: true };
}

module.exports = {
  MAX_GROWTH, MAX_BYTES, MAX_CSS_BYTES,
  checkHtml, checkCss, checkAddressed, deadCssRules, checkNodeSet, countTags, elementCount,
};
