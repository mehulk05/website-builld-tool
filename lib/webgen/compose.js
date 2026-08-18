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
    teamPage: { eyebrow: A.business_name || "", h1: "Meet the Team", body: "" },
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
 "aboutPage":{"eyebrow":"","h1":"","body":""},
 "teamPage":{"eyebrow":"","h1":"","body":""},
 "layout":"editorial | bold | minimal | aura | clinical"
}
CHOOSE THE BEST-FIT LAYOUT for this brand's personality (set "layout" to exactly one):
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
        aboutPage: { ...fb.aboutPage, ...(ai.aboutPage || {}) },
        teamPage: { ...fb.teamPage, ...(ai.teamPage || {}) },
        layout: ["editorial", "bold", "minimal", "aura", "clinical"].includes(ai.layout) ? ai.layout : fb.layout,
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
function themeTokens(composed = {}) {
  const ink = composed.primary && !isLight(composed.primary) ? composed.primary
    : (composed.secondary && !isLight(composed.secondary) ? composed.secondary : "#2a2a2a");
  return {
    cream: composed.primary && isLight(composed.primary) ? composed.primary : "#fffbf5",
    white: "#ffffff",
    ink,
    body: "#585858",
    line: composed.secondary || "#e7e0d5",
    accent: composed.accent || composed.secondary || "#8a7a63",
    serifFont: composed.headingFont || "Cormorant Garamond",
    sansFont: composed.bodyFont || "Montserrat",
    googleFontsHref: fontsHref(composed.headingFont, composed.bodyFont),
  };
}

// crude luminance check so we don't put dark text color as a light background token
function isLight(hex) {
  const m = String(hex).replace("#", "");
  if (m.length < 6) return false;
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
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
