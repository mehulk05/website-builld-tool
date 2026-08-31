// composeBrandKit — turns onboarding answers + the client's scanned site into a
// structured BrandKit (our render schema), with quality copy matching the current
// site. One Gemini call; brand identity + theme + team are enforced deterministically
// so a weak/failed model can never corrupt the essentials. CommonJS.

const S = (v) => (v == null ? "" : String(v));

// pull a compact, token-bounded summary of the scanned site for the prompt
function siteSummary(siteStruct) {
  if (!siteStruct || !siteStruct.pages) return "";
  const pick = (p) => ({
    h1: p.h1 || "",
    flow: p.sectionFlow || (p.sections || []).map((s) => s.type || s.heading).filter(Boolean).slice(0, 12),
    headings: (p.sections || []).map((s) => s.heading).filter(Boolean).slice(0, 12),
    images: (p.images || []).slice(0, 12),
  });
  const out = {};
  for (const [k, p] of Object.entries(siteStruct.pages)) out[k] = pick(p);
  return JSON.stringify(out).slice(0, 6000);
}

function fenceStrip(t) {
  return String(t || "").trim().replace(/^```json?/i, "").replace(/```$/, "").trim();
}

// deterministic minimum so a build never dies on a bad AI response
function fallbackKit(A, composed) {
  const services = String(A.services_offered || A.revenue_services || "").split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  const cards = (services.length ? services : ["Aesthetic Injectables", "Skin Health", "Wellness"]).slice(0, 3)
    .map((h3) => ({ h3, p: `Expert ${h3.toLowerCase()} tailored to your goals.`, image: "" }));
  return {
    brand: { name: A.business_name || "Med Spa", sub: "", topbar: A.location || "", phone: A.phone_for_website || "", email: A.email || "", city: A.location || "" },
    hero: { eyebrow: "Medical Aesthetics & Wellness", h1: A.business_name || "Timeless, Natural Results", body: S(A.why_patients_choose).slice(0, 160) || "Advanced aesthetic medicine in a calm, modern space.", cta: A.primary_cta || "Book a Visit", image: "" },
    about: { eyebrow: "About Us", h2: "Where science meets artistry", paras: [S(A.why_patients_choose).slice(0, 400) || "We combine clinical precision with an artistic eye for natural, lasting results."], cta: "Book Now", image: "" },
    strip: cards.map((c) => c.h3),
    specialties: { eyebrow: "Our Specialties", h2: "Comprehensive Care", intro: "", cards },
    providers: { eyebrow: "Our Team", h2: "Meet Our Specialists", tabs: [], members: [] },
    testimonials: { eyebrow: "Reviews", h2: "What Our Patients Say", quotes: A.featured_review ? [{ h4: "A wonderful experience", p: S(A.featured_review).slice(0, 240), cite: "Verified Patient" }] : [] },
    featured: { h2: "Featured Services", items: cards.map((c) => ({ h3: c.h3, p: c.p })) },
    cta: { eyebrow: "Get Started", h2: "Ready to begin?", body: `Schedule your consultation${A.location ? " in " + A.location : ""}.` },
    footer: { blurb: `${A.business_name || "Our practice"} — advanced aesthetics & wellness.`, logo: A.logo || "" },
    layout: "bold",
    servicesPage: { eyebrow: A.business_name || "", h1: "Our Services", body: "" },
    aboutPage: { eyebrow: A.business_name || "", h1: "About Us", body: "" },
    contactPage: { eyebrow: A.business_name || "", h1: "Contact Us", body: "" },
    // Page-specific content so sub-pages stop reusing the home sections:
    // full treatment menu (Services), values/story (About), visit details (Contact).
    servicesMenu: (() => {
      const names = [...new Set([].concat(Array.isArray(A.services_offered) ? A.services_offered : [], Array.isArray(A.revenue_services) ? A.revenue_services : []).map(S).filter(Boolean))];
      return (names.length ? names : cards.map((c) => c.h3)).map((n) => ({ name: n, desc: `Expert ${n.toLowerCase()} tailored to your goals and anatomy.` }));
    })(),
    values: [
      { h3: "Physician-led", p: "Every treatment plan is designed and overseen by our medical team." },
      { h3: "Natural results", p: "Subtle, refined outcomes that enhance your features — never overdone." },
      { h3: "Concierge care", p: "An unhurried, private experience from consultation through aftercare." },
    ],
    contact: {
      address: A.location || "", phone: A.phone_for_website || "", email: A.email || "",
      hours: "Mon–Fri 9–6 · Sat by appointment",
      booking: A.booking_platform || A.primary_cta || "Book a consultation",
    },
  };
}

async function composeBrandKit({ siteStruct, A = {}, composed = {}, team = [], geminiCall }) {
  const fb = fallbackKit(A, composed);
  let kit = fb;

  if (geminiCall) {
    const prompt = `You are a luxury med-spa website content writer. Produce structured JSON for a brand-new
site that MATCHES the client's current site content (below) but rewritten to be polished and modern —
do NOT copy sentences verbatim, and do NOT invent sections the client clearly does not have.

Return ONLY JSON (no markdown) in EXACTLY this shape:
{
 "hero":{"eyebrow":"","h1":"(2-6 words)","body":"(1-2 sentences)","cta":"","image":"url-or-empty"},
 "about":{"eyebrow":"","h2":"","paras":["",""],"cta":"","image":"url-or-empty"},
 "strip":["","","","",""],
 "specialties":{"eyebrow":"","h2":"","intro":"","cards":[{"h3":"","p":"(~15 words)","image":"url-or-empty"}]},
 "testimonials":{"eyebrow":"","h2":"","quotes":[{"h4":"","p":"","cite":""}]},
 "featured":{"h2":"","items":[{"h3":"","p":""}]},
 "cta":{"eyebrow":"","h2":"","body":""},
 "servicesPage":{"eyebrow":"","h1":"","body":"(1 sentence intro)"},
 "servicesMenu":[{"name":"(a real service)","desc":"(~12 words, benefit-led)"}],
 "aboutPage":{"eyebrow":"","h1":"","body":"(1-2 sentences)"},
 "values":[{"h3":"(2-3 words)","p":"(~14 words)"}],
 "contactPage":{"eyebrow":"","h1":"","body":"(1-2 warm, inviting sentences)"},
 "layout":"luxe | editorial | bold | minimal | aura | clinical"
}
CHOOSE THE BEST-FIT LAYOUT for this brand's personality (set "layout" to exactly one):
- "luxe" = the flagship: statement editorial luxury — oversized stacked serif split hero, arched
  photos in hairline gold frames, italic serif marquee, dark pull-quote band. PREFER this for any
  premium/luxury med-spa or aesthetics brand unless the brand is clearly clinical or playful.
- "editorial" = refined, serif-led, calm luxury with generous whitespace (classic med-spas).
- "bold" = dramatic, dark, oversized display type, high-contrast, confident (modern/edgy brands).
- "minimal" = airy, quiet, lots of whitespace, hairline details, understated (clean/wellness brands).
- "aura" = warm soft luxury, gentle shadows, rounded imagery, inviting (spa/wellness/glow brands).
- "clinical" = clean modern medical, cool crisp neutrals, structured cards, precise & trustworthy (dermatology/med-clinic brands).
Pick from the brand's palette + tone (dark/edgy → bold; classic → editorial; clean/calm → minimal; warm/soft → aura; medical/precise → clinical).
RULES:
- 3 specialty cards, 3 featured items, up to 4 testimonial quotes, 5 strip items.
- IMAGES: only use URLs from the image list below (copy exactly), placed where relevant (hero = a strong
  interior/treatment/lifestyle photo; cards = treatment photos). If none fit, use "". Never invent URLs.
- Voice: warm, refined, medically-credible luxury.

CLIENT ONBOARDING:
business_name: ${S(A.business_name)}
location: ${S(A.location)}
services_offered: ${S(A.services_offered)}
revenue_services: ${S(A.revenue_services)}
why_patients_choose: ${S(A.why_patients_choose)}
featured_review: ${S(A.featured_review)}
primary_cta: ${S(A.primary_cta)}

CURRENT SITE STRUCTURE + IMAGES (JSON):
${siteSummary(siteStruct) || "(no scan available — compose from onboarding only)"}`;

    try {
      const txt = await geminiCall([{ text: prompt }], { temperature: 0.6, maxOutputTokens: 8000, system: "You write concise, elegant, structured website copy. Output valid JSON only." });
      const ai = JSON.parse(fenceStrip(txt));
      // merge AI content over the fallback (AI wins for content; fallback fills gaps)
      kit = {
        ...fb,
        hero: { ...fb.hero, ...(ai.hero || {}) },
        about: { ...fb.about, ...(ai.about || {}) },
        strip: (ai.strip && ai.strip.length) ? ai.strip : fb.strip,
        specialties: { ...fb.specialties, ...(ai.specialties || {}), cards: (ai.specialties && ai.specialties.cards && ai.specialties.cards.length) ? ai.specialties.cards : fb.specialties.cards },
        testimonials: { ...fb.testimonials, ...(ai.testimonials || {}) },
        featured: { ...fb.featured, ...(ai.featured || {}) },
        cta: { ...fb.cta, ...(ai.cta || {}) },
        servicesPage: { ...fb.servicesPage, ...(ai.servicesPage || {}) },
        servicesMenu: (ai.servicesMenu && ai.servicesMenu.length) ? ai.servicesMenu : fb.servicesMenu,
        aboutPage: { ...fb.aboutPage, ...(ai.aboutPage || {}) },
        values: (ai.values && ai.values.length) ? ai.values : fb.values,
        contactPage: { ...fb.contactPage, ...(ai.contactPage || {}) },
        contact: fb.contact,   // visit facts are onboarding-derived, never AI-invented
        layout: ["luxe", "editorial", "bold", "minimal", "aura", "clinical"].includes(ai.layout) ? ai.layout : fb.layout,
      };
    } catch (e) {
      console.warn("[webgen] composeBrandKit: AI content failed, using deterministic fallback —", e.message);
    }
  }

  // --- enforce essentials deterministically (never trust AI for these) ---
  kit.brand = fb.brand; // identity from onboarding, authoritative
  kit.theme = themeTokens(composed); // step-2 palette + fonts drive the site
  // real team from onboarding roster (names + roles); no photos in onboarding → text cards (adaptive)
  if (Array.isArray(team) && team.length) {
    kit.providers = { eyebrow: "Our Team", h2: "Meet Our Specialists", tabs: [], members: team.slice(0, 4).map((m) => ({ name: m.name, role: m.role || "Specialist", image: m.image || "" })) };
  }
  kit.footer.logo = A.logo || kit.footer.logo || "";
  return kit;
}

// Map the confirmed step-2 palette → template tokens, FAITHFULLY:
//   primary = the dark ink/text (and the bold design's dark background)
//   accent  = highlight / CTA color
//   secondary = a muted line/border tint
//   background stays a light neutral (the palette carries foreground colors, not a bg)
// The chosen design decides how these are used (e.g. bold paints the page with --ink).
// ---- colour maths ------------------------------------------------------------
// Real relative luminance (sRGB, gamma-corrected) rather than the 0.299/0.587
// weighted average, which over-reports mid-tone brightness and was rejecting
// perfectly usable accents. Chroma and hue let us keep every derived surface in
// the brand's own colour family instead of falling back to a constant.
const rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lum = (c) => {
  const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const chroma = (c) => (Math.max(...c) - Math.min(...c)) / 255;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// WCAG contrast ratio — used to guarantee body copy stays readable on every surface.
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const WHITE = [255, 255, 255];

/**
 * Confirmed step-2 palette → renderer tokens.
 *
 * Previously this fell back to two hardcoded constants and a hardcoded grey,
 * which meant most clients shipped the SAME warm cream tint band on every
 * section regardless of brand — a cool clinical blue and a green wellness
 * practice both got warm cream — and any accent scoring over a crude
 * brightness threshold was replaced with the same bronze. Measured: 5 of 6
 * representative palettes produced an identical `cream`, 2 of 6 an identical
 * `accent`, 6 of 6 an identical `body`.
 *
 * Now every surface is derived FROM the brand, so it always sits in the
 * client's own colour family. Output keys are unchanged — this is a swap of
 * the maths behind them, not of the contract.
 */
function themeTokens(composed = {}) {
  const P = rgb(composed.primary), S = rgb(composed.secondary), A = rgb(composed.accent);

  // INK — the darkest thing the brand gave us. A light-only palette carries no
  // text colour, so derive one from the accent rather than defaulting to grey.
  const inks = [P, S, A].filter(Boolean).filter((c) => lum(c) < 0.22).sort((a, b) => lum(a) - lum(b));
  const INK = inks[0] || (A || P || S ? mix(A || P || S, [0, 0, 0], 0.82) : [42, 42, 42]);

  // ACCENT — must carry visual weight on a light ground, but the old threshold
  // threw away usable pastels (blush #c98b9b was rejected and replaced with
  // bronze). Judge it by contrast against the page, not raw brightness, and
  // deepen a too-light accent instead of discarding the brand's hue.
  const usable = (c) => c && chroma(c) >= 0.04 && contrast(c, WHITE) >= 1.9;
  let ACCENT = [A, S, P].find(usable);
  if (!ACCENT) {
    const src = [A, S, P].find((c) => c && chroma(c) >= 0.03);
    ACCENT = src ? mix(src, [0, 0, 0], 0.42) : rgb("#8a7a63");
  }

  // CREAM — the tint band, on every other section. Held inside the accent's own
  // hue family by construction: it is white carrying a little of the brand.
  // Prefer a light palette colour the client actually gave us, if there is one.
  const given = [P, S].find((c) => c && lum(c) > 0.72 && chroma(c) <= 0.24);
  const CREAM = given || mix(WHITE, ACCENT, 0.1);

  // The page ground: not pure white, a barely-tinted white. A hair of the brand
  // is what separates a chosen neutral from an inherited one.
  const BG = mix(WHITE, ACCENT, 0.015);

  // BODY — ink lifted toward the ground, so running text is a hue-biased grey
  // from this brand rather than #585858 on every site.
  //
  // The floor is 5.5:1, not the 4.5:1 AA minimum, because the design layer dims
  // text on top of this: eyebrows carry opacity .92 and footer copy .85. Aiming
  // at exactly 4.5 measured 4.13 in the browser once those applied. The headroom
  // is what makes AA hold at the pixel rather than in the token.
  let BODY = mix(INK, CREAM, 0.42);
  for (let i = 0; i < 20 && contrast(BODY, CREAM) < 5.5; i++) BODY = mix(BODY, INK, 0.25);

  // Hairlines and borders: the same family, barely there.
  const LINE = mix(CREAM, INK, 0.12);

  return {
    cream: hex(CREAM),
    white: hex(BG),
    ink: hex(INK),
    body: hex(BODY),
    line: hex(LINE),
    accent: hex(ACCENT),
    serifFont: composed.headingFont || "Cormorant Garamond",
    sansFont: composed.bodyFont || "Montserrat",
    googleFontsHref: fontsHref(composed.headingFont, composed.bodyFont),
  };
}

function fam(name) { return String(name || "").trim().replace(/\s+/g, "+"); }
function fontsHref(heading, body) {
  const fams = [];
  if (heading) fams.push(`family=${fam(heading)}:wght@300;400;500;600`);
  if (body && body !== heading) fams.push(`family=${fam(body)}:wght@300;400;500;600`);
  if (!fams.length) return "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Montserrat:wght@300;400;500;600&display=swap";
  return `https://fonts.googleapis.com/css2?${fams.join("&")}&display=swap`;
}

module.exports = { composeBrandKit, fallbackKit, themeTokens };
