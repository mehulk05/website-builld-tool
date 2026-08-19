// Approach B — map a SCRAPED client page (its real section flow, copy, images)
// onto an ordered blueprint of OUR design blocks, so a sub-page mirrors the
// client's own structure/content while rendering in the home page's rich theme.
// One Gemini call per page. Returns null on any failure so the caller falls back
// to Approach A (the page is never blank).

const S = (v) => (v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
const fenceStrip = (t) => String(t).trim().replace(/^```json?/i, "").replace(/```$/, "").trim();

const BLOCK_TYPES = ["split", "cards", "list", "gallery", "quote", "stat", "cta"];

async function buildBlueprint({ pageKey, title, struct, A = {}, geminiCall, screenshotB64 }) {
  if (!geminiCall || !struct || !Array.isArray(struct.sections) || !struct.sections.length) return null;

  // Compact the scrape: heading + kind + trimmed copy + this section's real images.
  const secs = struct.sections.slice(0, 24).map((s, i) => ({
    i, heading: S(s.heading).slice(0, 90), kind: s.kind,
    copy: S(s.copy).slice(0, 340),
    images: (s.imageUrls || []).slice(0, 4),
  })).filter((s) => s.heading || s.copy || s.images.length);
  if (!secs.length) return null;

  const prompt = `You are a luxury med-spa web designer. Below is the SCRAPED section flow of a real
client page (${pageKey}) — its headings, copy and real image URLs, in order. Rebuild it as an ordered
list of DESIGN BLOCKS for a new, polished page that KEEPS the client's structure, content and images
but is written more elegantly. Do NOT copy sentences verbatim; rewrite in a warm, refined, medically-
credible voice. Do NOT invent sections the client does not have. Preserve the real order.

Return ONLY JSON (no markdown):
{
 "title": "(page hero H1, 2-5 words)",
 "intro": "(1 sentence page-hero subline)",
 "heroImage": "(the single best wide image URL from the scrape for the page hero, or '')",
 "blocks": [
   { "type": "split", "eyebrow":"", "h2":"", "paras":["",""], "image":"(url or '')", "reverse": false },
   { "type": "cards", "eyebrow":"", "h2":"", "intro":"", "cards":[{"h3":"","p":"(~16 words)","image":"(url or '')"}] },
   { "type": "list",  "eyebrow":"", "h2":"", "intro":"", "items":[{"name":"","desc":"(~14 words)"}] },
   { "type": "gallery","eyebrow":"", "h2":"", "images":["url","url"] },
   { "type": "quote", "eyebrow":"", "h2":"", "quotes":[{"h4":"","p":"","cite":""}] },
   { "type": "stat",  "items":[{"big":"","label":""}] },
   { "type": "cta",   "eyebrow":"", "h2":"", "body":"" }
 ]
}
RULES:
- Choose the block whose shape best fits each scraped section: a 2-column text+photo → "split";
  a grid of services/treatments/features → "cards" (with a photo each) or "list" (name + desc, no photos);
  a photo strip → "gallery"; reviews → "quote"; numbers/metrics → "stat"; a closing call-to-action → "cta".
- IMAGES: only use URLs that appear in the scrape below (copy them EXACTLY). Assign each section's own
  images to its block. If a section has no image, use "". Never invent URLs.
- 4-8 blocks total. End with a "cta" block.
- Use the client's real facts: business ${S(A.business_name)}, location ${S(A.location)}, phone ${S(A.phone_for_website)}.
${pageKey === "services"
  ? `- THIS IS THE SERVICES PAGE — its JOB is the treatment MENU. Lead with a "list" (numbered
  services + short benefit copy) and/or "cards" (a photo per treatment). Keep prose/story minimal.
  Do NOT open with a big "about us" split — that belongs on the About page.`
  : pageKey === "about"
  ? `- THIS IS THE ABOUT PAGE — its JOB is STORY + PEOPLE. Lead with "split" blocks (practice story,
  mission, values, providers) and a "quote"/"stat" for proof. Do NOT turn it into a services menu
  ("list"/service "cards") — that belongs on the Services page. Make it read DIFFERENTLY from Services.`
  : ""}

${screenshotB64 ? `A SCREENSHOT of the real page is ATTACHED. Reproduce its VISUAL DESIGN, not just its content:
- Match each section's COMPOSITION: full-bleed vs contained, image on the left vs right (set "reverse"),
  the crop/aspect of images, text alignment, and the SPACING RHYTHM (how much whitespace surrounds a block).
- Match the visual HIERARCHY: oversized editorial headings where the page uses them, quiet where it's quiet.
- Choose the block type + order that RECREATE what the screenshot shows, section by section, top to bottom.
` : ""}SCRAPED PAGE (${struct.url || pageKey}) — title "${S(struct.title)}", h1 "${S(struct.h1)}":
${JSON.stringify(secs)}`;

  let ai;
  try {
    const parts = [{ text: prompt }];
    if (screenshotB64) parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshotB64 } });
    const txt = await geminiCall(parts, { temperature: 0.5, maxOutputTokens: 8000, system: "You output valid JSON only — an ordered list of design blocks that reproduce the reference page's design." });
    ai = JSON.parse(fenceStrip(txt));
  } catch (e) {
    console.warn(`[webgen] blueprint ${pageKey}: AI mapping failed — ${e.message}`);
    return null;
  }
  const blocks = (Array.isArray(ai.blocks) ? ai.blocks : []).filter((b) => b && BLOCK_TYPES.includes(b.type));
  if (!blocks.length) return null;
  return {
    title: S(ai.title) || title || "",
    intro: S(ai.intro) || "",
    heroImage: S(ai.heroImage) || "",
    blocks,
  };
}

module.exports = { buildBlueprint };
