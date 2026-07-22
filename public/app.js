"use strict";
// ---- auth: attach the admin key (deployed) to every /api/ call ----
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith("/api/")) opts.headers = { ...(opts.headers || {}), "x-admin-key": localStorage.getItem("g99AdminKey") || "" };
  return _fetch(url, opts);
};

let OB = null, A = {}, baseline = null, genPages = [], curTab = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2800); }
function val(v) {
  if (Array.isArray(v)) return (v.length && typeof v[0] === "object") ? v.map(t => `${t.name} (${t.title})`).join(" · ") : v.join(", ");
  return v;
}
function band(v) { return v >= 80 ? "" : v >= 65 ? "mid" : "low"; }
function bandColor(v) { return v >= 80 ? "var(--good)" : v >= 65 ? "var(--warn)" : "var(--crit)"; }
function setGauge(el, v) { el.style.setProperty("--v", v); el.style.setProperty("--gc", bandColor(v)); }

const PAGES = [
  { key: "home", title: "Home" }, { key: "services", title: "Services" },
  { key: "about", title: "About" }, { key: "contact", title: "Contact" },
];

// ---------------- Step 1: answers ----------------
const LABELS = {
  business_name: ["Business name", "hs"], primary_cta: ["Primary CTA", "ai"], brand_aesthetic: ["Brand aesthetic", "new-client"],
  hero_headline: ["Homepage headline", "new-ai"], hero_subheadline: ["Homepage subheadline", "new-client"],
  seo_keywords: ["SEO keywords", "new-client"], services_offered: ["Service categories", "ai"], revenue_services: ["Featured treatments", "ai"],
  team_roster: ["Providers", "ai"], financing_offered: ["Financing & memberships", "ai"], featured_review: ["Featured review", "ai"],
  booking_platform: ["Booking platform", "ai"], location: ["Location", "ai"], site_love_1_url: ["Inspiration site", "client"],
};
const CHIP = { hs: ['<span class="chip mute">From HubSpot</span>'], ai: ['<span class="chip acc">Your website</span>'], client: ['<span class="chip good">Client</span>'],
  "new-ai": ['<span class="new">NEW</span>', '<span class="chip acc">Your website</span>'], "new-client": ['<span class="new">NEW</span>', '<span class="chip good">Client</span>'] };
function renderAnswers() {
  const order = ["business_name", "brand_aesthetic", "hero_headline", "hero_subheadline",
    "seo_keywords", "services_offered", "revenue_services", "team_roster", "financing_offered", "primary_cta", "booking_platform", "location", "featured_review", "site_love_1_url"];
  $("answers").innerHTML = order.filter(k => A[k] != null).map(k => {
    const [lbl, kind] = LABELS[k] || [k, "ai"]; const isColor = /color/.test(k);
    const v = isColor ? `<span class="swatch" style="background:${esc(A[k])}"></span>${esc(A[k])}` : esc(val(A[k]));
    return `<div class="ans"><span class="k">${esc(lbl)}</span><span class="v">${v}</span><div class="foot">${(CHIP[kind] || CHIP.ai).join("")}</div></div>`;
  }).join("");
}

// ---------------- audit render helpers ----------------
function renderCats(box, cats) {
  box.innerHTML = Object.entries(cats).map(([k, v]) =>
    `<div class="cat"><span>${esc(k)}</span><span class="bar"><i class="${band(v)}" style="width:${v}%"></i></span><span class="val">${v}</span></div>`).join("");
}
function renderIssues(box, issues) {
  box.innerHTML = issues.length ? issues.map(i =>
    `<div class="issue ${i.sev}"><span class="sev"></span><div><h4>${esc(i.title)}</h4><p>${esc(i.desc)}</p></div><span class="fx">${esc(i.fix)}</span></div>`).join("")
    : '<div class="empty">No issues found 🎉</div>';
}
function renderFacts(box, f) {
  box.innerHTML = [["Title", f.titleLen + " ch"], ["Meta desc", f.metaLen ? f.metaLen + " ch" : "—"], ["H1 / H2", f.h1 + " / " + f.h2],
    ["Images w/ alt", f.imagesWithAlt + "/" + f.images], ["Words", f.words], ["JSON-LD", f.jsonld ? "yes" : "no"],
    ["Local schema", f.localBiz ? "yes" : "no"], ["Keywords", f.keywordsMatched + "/" + f.keywordsTotal]]
    .map(([k, v]) => `<div class="fact"><span>${k}</span><b>${esc(v)}</b></div>`).join("");
}
async function audit(url) {
  const r = await fetch("/api/seo-audit", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, keywords: A.seo_keywords || [] }) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error || "audit failed"); return d;
}

// ---------------- CRO helpers ----------------
const CRO_CATS = [["vision", "Vision & UI"], ["ux", "UX & Usability"], ["cro", "CRO & Sales"], ["content", "Content & Copy"]];
function croCatsToMap(rep) { const m = {}; CRO_CATS.forEach(([k, lbl]) => m[lbl] = (rep[k] && rep[k].score) || 0); return m; }
function sub(title, items, color) {
  if (!items || !items.length) return "";
  return `<div style="font-size:11px;color:var(--ink-3);margin:9px 0 3px;text-transform:uppercase;letter-spacing:.05em">${title}</div>
    <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.65;color:${color || "var(--ink-2)"}">${items.slice(0, 6).map(i => `<li>${esc(i)}</li>`).join("")}</ul>`;
}
function renderChecks(checks) {
  if (!checks || !checks.length) return "";
  return `<div style="font-size:11px;color:var(--ink-3);margin:9px 0 4px;text-transform:uppercase;letter-spacing:.05em">Checks</div>
    <div style="display:flex;flex-direction:column;gap:4px">${checks.slice(0, 8).map(c => {
      const pass = (c.status || "").toLowerCase() === "pass";
      return `<div style="display:flex;gap:8px;font-size:12.5px;align-items:baseline"><span style="color:${pass ? "var(--good)" : "var(--crit)"};font-weight:800">${pass ? "✓" : "✗"}</span><span>${esc(c.label || "")}${c.note ? ` — <span style="color:var(--ink-3)">${esc(c.note)}</span>` : ""}</span></div>`;
    }).join("")}</div>`;
}
function renderCroDetail(box, rep) {
  const s = rep.summary || {};
  const summaryCard = (s.strengths || s.weaknesses || s.topRecommendations) ? `<div class="card pad" style="margin-bottom:12px">
    <span class="eyebrow">Executive summary${rep.pages ? ` · ${rep.pages}-page average` : ""}</span>
    <div class="grid g2" style="margin-top:10px">
      <div>${sub("Strengths", s.strengths, "var(--good)")}</div>
      <div>${sub("Weaknesses", s.weaknesses, "var(--crit)")}</div>
    </div>
    ${sub("Top recommendations", s.topRecommendations, "var(--ink)")}
  </div>` : "";
  box.innerHTML = summaryCard + CRO_CATS.map(([k, lbl]) => {
    const c = rep[k] || {};
    return `<div class="card pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="eyebrow">${esc(lbl)}${c.severity ? ` · ${esc(c.severity)}` : ""}</span><span class="val ${band(c.score)}" style="font-weight:750">${c.score || 0}/100</span></div>
      ${sub("Observations", c.observations, "var(--ink-2)")}
      ${sub("Issues", c.issues, "var(--crit)")}
      ${sub("Recommendations", c.recommendations, "var(--ink-2)")}
      ${renderChecks(c.checks)}
    </div>`;
  }).join("");
}

// ---------------- Step 2: CRO audit of existing site ----------------
let croExisting = null;
async function runCroExisting() {
  const btn = $("baseBtn"); btn.disabled = true;
  $("baseHint").innerHTML = '<span class="spin"></span>Screenshotting &amp; running the CRO audit (~15s)…';
  try {
    const r = await fetch("/api/cro-audit", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("existingUrl").value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "CRO audit failed");
    croExisting = d;
    $("baseEmpty").style.display = "none"; $("baseBox").style.display = "";
    setGauge($("baseGauge"), d.overall); $("baseScoreN").textContent = d.overall;
    $("baseScoreLabel").textContent = d.overall >= 75 ? "Strong" : d.overall >= 55 ? "Room to improve" : "Weak — big opportunity";
    $("baseScoreUrl").textContent = ($("existingUrl").value) + (d.hadScreenshot ? " · with screenshot" : " · HTML-only");
    renderCats($("baseCatBox"), croCatsToMap(d));
    renderCroDetail($("baseCro"), d);
    $("baseHint").textContent = "CRO findings captured — now baked into the Stitch prompt.";
    buildPrompt();
    toast("Existing CRO: " + d.overall + "/100");
  } catch (e) { $("baseHint").textContent = ""; toast("Error: " + e.message); }
  finally { btn.disabled = false; }
}

// ---------------- Step 3: prompt + generate ----------------
function seoRequirements() {
  const kws = val(A.seo_keywords);
  let reqs = [`SEO REQUIREMENTS (make this site technically excellent):`,
    `- Unique, keyword-rich <title> (50–60 chars) and a compelling <meta name="description"> (120–160 chars).`,
    `- Exactly one <h1>; logical <h2>/<h3> structure.`,
    `- Descriptive alt text on every image.`,
    `- A JSON-LD "MedicalBusiness"/"LocalBusiness" schema block with name, address (${A.location}), phone ${A.phone_for_website}, geo and openingHours.`,
    `- <link rel="canonical">, lang attribute, Open Graph tags.`,
    `- Naturally weave in target keywords: ${kws}.`];
  if (baseline) {
    const gaps = baseline.issues.map(i => i.title).filter(t => !/tailwind cdn/i.test(t));
    reqs.push(`The client's current site (scored ${baseline.overall}/100) specifically FAILED on: ${gaps.join("; ") || "minor items"}. Fix all of these.`);
  }
  return reqs.join("\n");
}
const VIBES = {
  "Luxurious & Warm": { look: "Luxury aesthetic medicine · High-end hospitality · Editorial magazine", palette: (c1, c2) => `${c2} near-black, warm ivory, ${c1} warm sand, champagne gold and bronze accents`, photo: "warm cinematic lighting, golden-hour tones" },
  "Clean & Minimalist": { look: "Refined minimalism · Scandinavian calm · Gallery-like restraint", palette: (c1, c2) => `porcelain white, soft warm grey, ${c1} as the single accent, ${c2} for type`, photo: "soft diffused daylight, airy negative space" },
  "Bold & Modern": { look: "Bold contemporary · Fashion-forward · Statement typography", palette: (c1, c2) => `deep charcoal ${c2}, crisp white, vivid ${c1} accent used fearlessly`, photo: "high-contrast dramatic lighting, editorial poses" },
  "Clinical & Precise": { look: "Medical-grade precision · Quiet confidence · Swiss grid discipline", palette: (c1, c2) => `cool white, slate grey ${c2}, ${c1} accent reserved for CTAs`, photo: "clean bright clinical light, precise composition" },
};
function brandPreface(pageName) {
  const vibe = $("vibe").value, c1 = $("c1").value, c2 = $("c2").value, ref = $("ref").value;
  const v = VIBES[vibe] || VIBES["Luxurious & Warm"];
  const city = (A.location || "").split(",").slice(-2).join(",").trim();
  const cats = A.services_offered || [];
  return [
    `Design an ultra-premium desktop ${pageName} for ${A.business_name} in ${city}.`,
    `Create a luxury editorial website inspired by ${ref} (structure and mood only — NEVER copy its text).`,
    ``,
    `Style:`,
    `• ${v.look}`,
    `• Sophisticated minimalism with premium editorial composition`,
    `• Palette: ${v.palette(c1, c2)}`,
    `• Spacious layout with generous white space and 160px section rhythm`,
    `• Elegant serif display typography paired with a clean modern sans-serif`,
    `• Premium photography with ${v.photo} — every image sits under a rich gradient or color-wash overlay so it reads intentional, never flat or blurry`,
    `• Rounded architectural image masks and overlapping curved section shapes`,
    `• Thin gold hairline dividers and refined hover interactions`,
    ``,
    `Brand hierarchy: ${cats[0] || "Aesthetics"} is the primary focus; ${cats[cats.length - 1] || "Wellness"} is secondary.`,
    `Tone: refined, medical yet warm. Primary CTA everywhere: "${A.primary_cta}".`,
  ].join("\n");
}
function designRequirements() {
  return [`LAYOUT SOPHISTICATION — this must look like a top-tier design-agency site, NOT a basic template:`,
    `• Every section must have a DIFFERENT layout — never repeat the same stacked-card pattern. Alternate: asymmetric splits (40/60, 60/40), offset/overlapping image compositions with layered z-index, full-bleed alternating light/dark bands, editorial two-column text, and a horizontal-scroll or staggered grid.`,
    `• Generous vertical rhythm: 120–200px between sections; large negative space; wide margins.`,
    `• Dramatic type scale: oversized serif display headings (clamp ~48–96px), small uppercase kicker/eyebrow labels above each section, refined body at ~17–19px.`,
    `• Structural detail: numbered section markers, thin hairline dividers, a subtle sticky "Book" affordance, and at least one editorial pull-quote.`,
    `• Imagery: mix aspect ratios — a tall portrait, a wide cinematic band, and rounded/arched masks; overlapping images that break the grid; all under tasteful gradient overlays.`,
    `• Motion (subtle): fade/slide-up on scroll reveal, gentle image zoom on hover, animated stat counters. Respect prefers-reduced-motion.`,
    `• Micro-interactions: underline-grow nav links, button hover states, card lift on hover.`,
    `• Color: background transitions between sections (ivory → charcoal → ivory); accent used only for emphasis; minimal or no generic icons.`,
    `• Benchmark: Apple / Aesop / RUMA-level polish, Awwwards-worthy composition. Fully responsive, conversion-focused.`].join("\n");
}
let aiBrief = null;   // Gemini-composed brand+design brief (overrides template preface)
let composedBrand = null;   // {primary,secondary,accent,headingFont,bodyFont}
function themeForDeliverables() {
  return composedBrand || { primary: $("c1").value, secondary: $("c2").value };
}
async function exportWp(btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Building theme…";
  try {
    const r = await fetch("/api/export-wordpress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: themePayload() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "export failed");
    $("delivLinks").insertAdjacentHTML("beforeend", `<span class="chip mute">Theme: ${esc(d.themePath)} · ${d.files.length} files</span>`);
    toast("WordPress theme built: " + d.slug);
  } catch (e) { toast("Error: " + e.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function pushWp(btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Pushing & opening PR…";
  try {
    const r = await fetch("/api/push-wordpress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: themePayload() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "push failed");
    const link = d.prUrl ? `<a class="btn sm" href="${d.prUrl}" target="_blank">↗ View PR (${esc(d.branch)})</a>` : `<span class="chip good">Pushed ${esc(d.branch)}</span>`;
    $("delivLinks").insertAdjacentHTML("beforeend", link);
    toast(d.prUrl ? "PR opened" : "Pushed to " + d.branch);
  } catch (e) { toast("Error: " + e.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function genDeliverable(kind, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Generating…";
  try {
    const r = await fetch("/api/" + kind, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: themeForDeliverables() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "failed");
    const name = kind === "brand-guide" ? "Brand Guide" : "SEO Report";
    $("delivLinks").insertAdjacentHTML("beforeend", `<a class="btn ghost sm" href="${d.url}" target="_blank">↗ ${name}</a>`);
    toast(name + " ready");
  } catch (e) { toast("Error: " + e.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}
function buildPrompt() {
  const preface = aiBrief ? aiBrief : brandPreface("website");
  $("prompt").value = preface + "\n\n" + seoRequirements() + "\n\n" + designRequirements();
}
// AI-compose the brand system + design brief from onboarding + CRO + existing colors
async function composeBrand() {
  const btn = $("composeBtn"); btn.disabled = true;
  $("composeHint").innerHTML = '<span class="spin"></span>Gemini composing brand system &amp; brief…';
  try {
    const colors = ($("c1").value || $("c2").value) ? { primary: $("c1").value, secondary: $("c2").value } : null;
    const r = await fetch("/api/compose-brand", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ colors }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "compose failed");
    if (d.primary) { $("c1").value = d.primary; if ($("c1v")) $("c1v").value = d.primary.slice(0, 7); }
    if (d.secondary) { $("c2").value = d.secondary; if ($("c2v")) $("c2v").value = d.secondary.slice(0, 7); }
    composedBrand = { primary: d.primary, secondary: d.secondary, accent: d.accent, headingFont: d.headingFont, bodyFont: d.bodyFont };
    aiBrief = [
      `Design an ultra-premium, CLEAN, high-converting website for ${A.business_name} in ${(A.location || "").split(",").slice(-2).join(",").trim()}.`,
      d.brief || "",
      `Brand system: primary ${d.primary}, secondary ${d.secondary}, accent ${d.accent || d.primary}. Headings: ${d.headingFont || "elegant serif"}. Body: ${d.bodyFont || "clean sans"}. Use these EXACT colors as CSS :root variables.`,
    ].join("\n\n");
    buildPrompt();
    $("composeHint").textContent = `Brand composed · ${d.primary} / ${d.secondary}`;
    toast("AI brand + prompt composed");
  } catch (e) { $("composeHint").textContent = ""; toast("Error: " + e.message); }
  finally { btn.disabled = false; }
}

function pageSections(key) {
  const headline = $("headline").value, featured = $("featured").value;
  const providers = val(A.team_roster);
  return {
    home: [`Sections (each a DISTINCT layout — do not repeat patterns):`,
      `1. HERO — full-viewport cinematic image under a dark gradient; oversized serif headline "${headline}"; subheadline "${A.hero_subheadline}"; two CTAs ("${A.primary_cta}" + "Explore treatments"); a floating glass trust-bar pinned to the hero bottom (Physician-led · Board-certified · 5★ Google · 5,000+ treatments).`,
      `2. INTRO — asymmetric 45/55 split: a tall arched portrait image offset upward on one side, editorial copy with an uppercase kicker "Our Ethos" and pull-quote on the other: "${A.why_patients_choose}".`,
      `3. SIGNATURE TREATMENTS — staggered/offset editorial grid (not equal cards) for ${featured}; each item large image + name + one-line benefit + hover zoom + "Learn more".`,
      `4. SERVICE CATEGORIES — full-bleed DARK band with a horizontal, numbered list of ${val(A.services_offered)}, each with a thin hairline divider and a hover-reveal image.`,
      `5. STATS / TRUST — animated counters band (Years · Providers · Treatments · 5★ rating) over a subtle textured background.`,
      `6. FEATURE — overlapping curved/circular image masks breaking the grid, with a short benefit statement and accent detail.`,
      `7. PROVIDERS — large offset portraits with credential badges and short bios: ${providers}.`,
      `8. TESTIMONIAL — oversized editorial pull-quote centered over a cinematic full-bleed interior image: "${A.featured_review}".`,
      `9. MEMBERSHIP & FINANCING — elegant two-card band: ${val(A.financing_offered)}.`,
      `10. CLOSING CTA — full-width dramatic image with a large serif call-to-action and "${A.primary_cta}".`,
      `11. FOOTER — refined multi-column footer: ${A.business_name}, ${A.location}, phone ${A.phone_for_website}, hours, quick links, social.`].join("\n"),
    services: [`Sections:`,
      `1. Same transparent navigation as the homepage.`,
      `2. Editorial hero band: "Our Treatments" with a refined intro line.`,
      `3. One editorial section per category — ${val(A.services_offered)} — each with an image (gradient overlay), a short philosophy line, and treatment cards with one-line descriptions and "${A.primary_cta}" CTAs.`,
      `4. Signature treatments spotlight: ${featured}.`,
      `5. Membership & financing band: ${val(A.financing_offered)}.`,
      `6. Full-width consultation CTA. 7. Minimal luxury footer.`].join("\n"),
    about: [`Sections:`,
      `1. Same transparent navigation as the homepage.`,
      `2. Editorial hero: the practice story — "${A.why_patients_choose}"`,
      `3. Meet the team — large-portrait editorial cards: ${providers}, with credential badges.`,
      `4. Philosophy / values section with curved image masks.`,
      `5. Testimonial: ${A.featured_review}`,
      `6. Full-width consultation CTA. 7. Minimal luxury footer.`].join("\n"),
    contact: [`Sections:`,
      `1. Same transparent navigation as the homepage.`,
      `2. Split editorial layout: elegant consultation form (name, email, phone, treatment interest, message) beside luxury imagery.`,
      `3. ${A.booking_platform} online-booking panel.`,
      `4. Location block: map placeholder for ${A.location}, phone ${A.phone_for_website}, hours.`,
      `5. Full-width CTA band. 6. Minimal luxury footer.`].join("\n"),
  }[key];
}
function pagePrompt(key) {
  // the editable textarea is the base brief; per-page sections are appended
  return `${$("prompt").value}\n\n${pageSections(key)}\n\nReturn one complete, responsive, production-quality HTML page with the SEO requirements applied.`;
}
function selectedPages() { return PAGES.filter(p => $("chk_" + p.key).checked); }

// One call per engine generates ALL pages in parallel server-side, in one
// Stitch project with one shared design system (consistent theme). Both engines
// also run in parallel with each other.
let siteAnalysis = null;
function themePayload() {
  return { displayName: A.business_name, primary: $("c1").value, secondary: $("c2").value, vibe: $("vibe").value,
    accent: composedBrand ? composedBrand.accent : undefined,
    headingFont: composedBrand ? composedBrand.headingFont : undefined,
    bodyFont: composedBrand ? composedBrand.bodyFont : undefined,
    matchBrief: siteAnalysis ? siteAnalysis.matchBrief : "" };
}
async function scanSite() {
  const url = $("ref").value.trim();
  if (!url) { toast("Enter a website URL first"); return; }
  const btn = $("scanBtn"); btn.disabled = true;
  $("scanHint").innerHTML = '<span class="spin"></span>Capturing screenshot & analyzing design…';
  try {
    const r = await fetch("/api/analyze-site", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const a = await r.json();
    if (!r.ok) throw new Error(a.error || "scan failed");
    siteAnalysis = a;
    // auto-fill theme from the analysis
    if (a.primaryColor) { $("c1").value = a.primaryColor.toUpperCase(); $("c1v").value = a.primaryColor; }
    if (a.secondaryColor) { $("c2").value = a.secondaryColor.toUpperCase(); $("c2v").value = a.secondaryColor; }
    if (a.vibe) $("vibe").value = a.vibe;
    buildPrompt();
    $("scanHint").textContent = "Design captured — theme auto-filled and applied to the prompt.";
    $("scanResult").style.display = "";
    $("scanResult").innerHTML =
      `<div class="foot" style="margin-bottom:6px">
         <span class="chip acc">${esc(a.vibe)}</span>
         <span class="swatch" style="background:${esc(a.primaryColor)}"></span>
         <span class="swatch" style="background:${esc(a.secondaryColor)}"></span>
         <span class="swatch" style="background:${esc(a.accentColor)}"></span>
       </div>
       <div class="hint" style="margin:0">${esc((a.mood || []).join(" · "))} — ${esc((a.signatureElements || []).slice(0, 3).join("; "))}</div>`;
    toast("Design language captured");
  } catch (e) { $("scanHint").textContent = ""; toast("Scan error: " + e.message); }
  finally { btn.disabled = false; }
}
async function runEngine(engine, pages) {
  const rowIds = pages.map(p => `pi_${engine}_${p.key}`);
  rowIds.forEach(id => { const r = $(id); r.classList.add("run"); r.querySelector(".st").textContent = "…"; r.querySelector(".meta").textContent = "generating…"; });
  let ok = 0;
  try {
    const r = await fetch("/api/generate-site", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine, deviceType: $("device").value, theme: themePayload(),
        pages: pages.map(p => ({ key: p.key, prompt: pagePrompt(p.key) })) }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "generation failed");
    for (const p of pages) {
      const res = (d.pages || []).find(x => x.pageKey === p.key);
      const row = $(`pi_${engine}_${p.key}`);
      if (res && res.previewUrl) {
        row.classList.remove("run"); row.classList.add("done"); row.querySelector(".st").textContent = "✓";
        row.querySelector(".meta").textContent = `${(res.htmlBytes / 1024).toFixed(1)} KB`;
        genPages.push({ ...res, title: p.title, engine, seconds: d.seconds });
        ok++;
      } else {
        row.classList.remove("run"); row.querySelector(".st").textContent = "!";
        row.querySelector(".meta").textContent = String((res && res.error) || "no HTML").slice(0, 70);
      }
    }
    fillPreview();
  } catch (e) {
    rowIds.forEach(id => { const r = $(id); r.classList.remove("run"); r.querySelector(".st").textContent = "!"; r.querySelector(".meta").textContent = String(e.message).slice(0, 70); });
  }
  return ok;
}

let lastEngine = "stitch";
async function generateSite(engine) {
  engine = engine || "stitch";
  const pages = selectedPages();
  if (!pages.length) { toast("Select at least one page"); return; }
  ["genBtn", "genBtnGemini", "genBtnBoth"].forEach(id => { const b = $(id); if (b) b.disabled = true; });
  genPages = []; curTab = 0; lastEngine = engine;
  const engines = engine === "both" ? ["stitch", "gemini"] : [engine];
  $("progress").innerHTML = engines.map(en => pages.map(p =>
    `<div class="pitem" id="pi_${en}_${p.key}"><span class="st">·</span><span class="nm">${p.title} · ${en === "gemini" ? "Gemini" : "Stitch"}</span><span class="meta">queued</span></div>`).join("")).join("");
  $("genHint").innerHTML = `<span class="spin"></span>Generating ${pages.length} page(s) × ${engines.length} engine(s) — engines run in parallel…`;
  const counts = await Promise.all(engines.map(en => runEngine(en, pages)));
  const total = counts.reduce((a, b) => a + b, 0);
  $("genHint").textContent = `Done — ${total}/${pages.length * engines.length} generations succeeded`;
  ["genBtn", "genBtnGemini", "genBtnBoth"].forEach(id => { const b = $(id); if (b) b.disabled = false; });
  if (total) { fillPreview(); toast("Generation complete"); go(4); }
}

async function bindSite(engine) {
  toast("Binding site with AI chrome…");
  try {
    const r = await fetch("/api/bind-site", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine, theme: themePayload() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "bind failed");
    $("siteLinks").style.display = "";
    $("siteOpen").href = d.siteUrl; $("siteZip").href = d.zipUrl;
    $("siteFiles").textContent = `${engine === "gemini" ? "Gemini" : "Stitch"} site · ${d.chromeSource} · ${d.files.join(" · ")}`;
    toast("Bound in " + d.seconds + "s (" + d.chromeSource + ")");
  } catch (e) { toast("Error: " + e.message); }
}
async function assembleSite(engine) {
  if (!genPages.some(g => g.engine === engine)) { toast("No " + engine + " pages generated"); return; }
  try {
    const r = await fetch("/api/assemble", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "assemble failed");
    $("siteLinks").style.display = "";
    $("siteOpen").href = d.siteUrl; $("siteZip").href = d.zipUrl;
    $("siteFiles").textContent = (engine === "gemini" ? "Gemini site: " : "Stitch site: ") + d.files.join(" · ");
    toast("Beta site assembled (" + engine + ")");
  } catch (e) { toast("Error: " + e.message); }
}

// ---------------- Step 4: preview (side-by-side per page) ----------------
let tabKeys = [];
function fillPreview() {
  if (!genPages.length) return;
  $("previewEmpty").style.display = "none"; $("previewBox").style.display = "";
  tabKeys = [...new Set(genPages.map(g => g.pageKey))];
  if (curTab >= tabKeys.length) curTab = 0;
  $("ptabs").innerHTML = tabKeys.map((k, i) => {
    const t = (PAGES.find(p => p.key === k) || {}).title || k;
    const n = genPages.filter(g => g.pageKey === k).length;
    return `<button class="ptab ${i === curTab ? "on" : ""}" onclick="showTab(${i})">${esc(t)}${n > 1 ? " ⚡⚔" : ""}</button>`;
  }).join("");
  showTab(curTab);
  const engines = [...new Set(genPages.map(g => g.engine))];
  $("asmRow").innerHTML = engines.map(en =>
    `<button class="btn" onclick="bindSite('${en}')">✨ Bind site (AI chrome) — ${en === "gemini" ? "Gemini" : "Stitch"}</button>
     <button class="btn ghost" onclick="assembleSite('${en}')">🔗 Basic assemble (${en === "gemini" ? "Gemini" : "Stitch"})</button>`).join("");
}
function frameHtml(g) {
  const eng = g.engine === "gemini" ? "Gemini" : "Stitch";
  return `<div>
    <div class="btnrow" style="margin-bottom:8px;justify-content:space-between">
      <span class="chip ${g.engine === "gemini" ? "good" : "acc"}">${eng} · ${(g.htmlBytes / 1024).toFixed(1)} KB · ${g.seconds}s</span>
      <span class="btnrow" style="gap:6px">
        <a class="btn ghost sm" href="${g.exportUrl}" download="${g.page}.html">⬇ Export</a>
        <a class="btn ghost sm" href="${g.previewUrl}" target="_blank">↗ Open</a>
        ${g.screenshotUrl ? `<a class="btn ghost sm" href="${g.screenshotUrl}" target="_blank">🖼 Mockup</a>` : ""}
      </span>
    </div>
    <div class="frame">
      <div class="chrome"><span class="cd" style="background:#f06055"></span><span class="cd" style="background:#f5bf4f"></span><span class="cd" style="background:#61c554"></span><span class="url">${location.origin + g.previewUrl}</span></div>
      <iframe src="${g.previewUrl}" title="${esc(g.page)}"></iframe>
    </div>
  </div>`;
}
function showTab(i) {
  curTab = i;
  document.querySelectorAll("#ptabs .ptab").forEach((b, j) => b.classList.toggle("on", j === i));
  const items = genPages.filter(g => g.pageKey === tabKeys[i]);
  // stitch left, gemini right for a stable comparison
  items.sort((a, b) => (a.engine === "gemini" ? 1 : 0) - (b.engine === "gemini" ? 1 : 0));
  $("pvGrid").className = items.length > 1 ? "grid g2" : "grid";
  $("pvGrid").innerHTML = items.map(frameHtml).join("");
  // QA & refine is whole-site only (Step 5) — no per-page refine here.
  $("refineRow").innerHTML = `<span class="hint" style="margin:0">Whole-site QA &amp; refine is in <b>Step 5 · QA &amp; Refine</b>.</span>`;
  $("refineOut").innerHTML = "";
}

// ---------------- Step 5: compare ----------------
// ---------------- Step 6: CRO before/after ----------------
async function runCroCompare() {
  if (!croExisting) { toast("Run the Step 2 CRO audit on the existing site first"); return; }
  const btn = $("cmpBtn"); btn.disabled = true;
  $("cmpHint").innerHTML = '<span class="spin"></span>Running the CRO audit on the beta site…';
  try {
    const r = await fetch("/api/cro-audit-beta", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: lastEngine === "gemini" ? "gemini" : "stitch" }) });
    const nw = await r.json();
    if (!r.ok) throw new Error(nw.error || "beta CRO failed");
    renderCroCompare(croExisting, nw);
    $("cmpHint").textContent = `Beta CRO ${nw.overall} vs existing ${croExisting.overall}`;
    toast(`Beta ${nw.overall} vs existing ${croExisting.overall}`);
  } catch (e) { $("cmpHint").textContent = ""; toast("Error: " + e.message); }
  finally { btn.disabled = false; }
}
function renderCroCompare(ex, nw) {
  $("cmpEmpty").style.display = "none"; $("cmpBox").style.display = "";
  setGauge($("gExist"), ex.overall); $("gExistN").textContent = ex.overall;
  setGauge($("gNew"), nw.overall); $("gNewN").textContent = nw.overall;
  const d = nw.overall - ex.overall;
  const db = $("deltaBig"); db.textContent = (d >= 0 ? "+" : "") + d; db.style.color = d >= 0 ? "var(--good)" : "var(--crit)";
  const exM = croCatsToMap(ex), nwM = croCatsToMap(nw);
  $("cmpCats").innerHTML = `<span></span><span class="hd2">Existing</span><span class="hd2">Beta</span>` +
    Object.keys(nwM).map(k => {
      const a = exM[k] ?? 0, b = nwM[k];
      return `<span>${esc(k)}</span>
        <span class="cell"><span class="bar"><i class="${band(a)}" style="width:${a}%"></i></span><span class="v">${a}</span></span>
        <span class="cell"><span class="bar"><i class="${band(b)}" style="width:${b}%"></i></span><span class="v">${b}</span></span>`;
    }).join("");
  const exIssues = (ex.cro && ex.cro.issues || []).concat((ex.summary && ex.summary.weaknesses) || []);
  const nwIssues = (nw.cro && nw.cro.issues || []);
  const still = nwIssues.slice(0, 5);
  $("resolved").innerHTML =
    (exIssues.slice(0, 5).map(t => `<div class="rz"><span class="tick" style="color:var(--good)">✓</span> Addressed: ${esc(t)}</div>`).join("")
      + still.map(t => `<div class="rz"><span class="x" style="color:var(--warn)">•</span> Beta still: ${esc(t)}</div>`).join(""))
    || '<div class="empty">No conversion issues flagged.</div>';
  // full per-discipline reports for both sites (observations, issues, recs, checks, exec summary)
  if ($("cmpDetailNew")) renderCroDetail($("cmpDetailNew"), nw);
  if ($("cmpDetailOld")) renderCroDetail($("cmpDetailOld"), ex);
}

// ---------------- nav / init ----------------
function go(n) {
  document.querySelectorAll(".step").forEach(s => s.classList.toggle("on", s.dataset.step == n));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.dataset.panel == n));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (n == 5) loadStitchPages();
}

// ---------------- Step 5: whole-site QA & Refine (server-backed, survives reload) ----------------
let qaAudit = null;   // last whole-site audit result
async function loadStitchPages() {
  try {
    const d = await (await fetch("/api/stitch-pages")).json();
    const has = (d.pages || []).length > 0;
    $("qaEmpty").style.display = has ? "none" : "";
    $("qaBtn").disabled = !has;
  } catch (e) { toast("Could not load pages: " + e.message); }
}
// 1) audit the whole site
async function runQaSite() {
  const btn = $("qaBtn"); btn.disabled = true;
  $("qaHint").innerHTML = '<span class="spin"></span>Auditing every page of the site…';
  try {
    const r = await fetch("/api/qa-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "audit failed");
    qaAudit = d.pages;
    const src = (d.pages[0] && d.pages[0].source) || "";
    $("qaHint").textContent = `Audited ${d.pages.length} pages · ${src}`;
    $("qaOut").innerHTML = `
      <div class="card pad" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="eyebrow">Whole-site UX feedback (${d.pages.length} pages)</span>
          <button class="btn" id="qaRefineBtn" onclick="runQaRefineSite()">Refine whole site with Stitch →</button>
        </div>
        ${d.pages.map(p => `<div style="margin-top:14px">
          <div style="font-weight:650;font-size:13.5px;text-transform:capitalize;margin-bottom:4px">${esc(p.key)}</div>
          <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:var(--ink-2)">${p.comments.map(c => `<li>${esc(c)}</li>`).join("")}</ol>
        </div>`).join("")}
        <p class="hint">Review the feedback above, then choose whether to refine. Refining regenerates every page via Stitch (~2–3 min).</p>
      </div>`;
    toast("Whole-site audit ready");
  } catch (e) { $("qaHint").textContent = ""; toast("Error: " + e.message); }
  finally { btn.disabled = false; }
}
// 2) refine the whole site (user-triggered)
async function runQaRefineSite() {
  const btn = $("qaRefineBtn"); if (btn) btn.disabled = true;
  const status = document.createElement("p"); status.className = "hint"; status.innerHTML = '<span class="spin"></span>Refining all pages with Stitch (~2–3 min)…';
  $("qaOut").appendChild(status);
  try {
    const r = await fetch("/api/qa-refine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: themePayload() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "refine failed");
    status.remove();
    const rows = d.pages.map(p => {
      const orig = frameHtml({ engine: "stitch", page: p.key, title: p.key + " — original", previewUrl: `/preview/${p.key}`, exportUrl: `/export/${p.key}`, htmlBytes: 0 });
      const ref = p.refinedPreviewUrl
        ? frameHtml({ engine: "stitch", page: p.key + "-refined", title: p.key + " — refined v2", previewUrl: p.refinedPreviewUrl, exportUrl: p.refinedExportUrl, htmlBytes: 0 })
        : `<div class="empty">${esc(p.error || "no HTML")}</div>`;
      return `<div class="grid g2" style="margin-bottom:16px"><div>${orig}</div><div>${ref}</div></div>`;
    }).join("");
    $("qaOut").insertAdjacentHTML("beforeend", `<div class="card pad" style="margin-top:14px"><span class="eyebrow">Refined whole site — original vs v2 (${d.seconds}s)</span></div>${rows}`);
    toast("Whole site refined");
  } catch (e) { status.remove(); toast("Error: " + e.message); if (btn) btn.disabled = false; }
}
document.querySelectorAll(".step").forEach(s => s.addEventListener("click", () => go(s.dataset.step)));
$("c1v").addEventListener("input", e => { $("c1").value = e.target.value.toUpperCase(); buildPrompt(); });
$("c2v").addEventListener("input", e => { $("c2").value = e.target.value.toUpperCase(); buildPrompt(); });
["vibe", "c1", "c2", "ref", "headline", "featured"].forEach(id => $(id).addEventListener("change", buildPrompt));

(async function init() {
  OB = await (await fetch("/api/onboarding")).json(); A = OB.answers;
  $("clientPill").textContent = A.business_name + " · " + A.location;
  renderAnswers();
  $("existingUrl").value = "https://ruma.com";
  $("headline").value = A.hero_headline || "";
  $("featured").value = val(A.revenue_services);
  $("ref").value = OB.referenceWebsite || "ruma.com";
  $("pageChecks").innerHTML = PAGES.map(p => `<label style="text-transform:none;letter-spacing:0;font-weight:550;color:var(--ink);display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="chk_${p.key}" ${["home","services","about","contact"].includes(p.key) ? "checked" : ""}> ${p.title}</label>`).join("");
  buildPrompt();
})();
