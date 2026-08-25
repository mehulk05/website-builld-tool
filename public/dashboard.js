// Growth99 Beta Site Builder — one-page orchestrator over the existing pipeline.
"use strict";

// ---- auth: attach the admin key (deployed) to every /api/ call ----
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith("/api/")) opts.headers = { ...(opts.headers || {}), "x-admin-key": localStorage.getItem("g99AdminKey") || "" };
  return _fetch(url, opts);
};
// nav.js loads first and owns the branded password screen; this page only keeps
// a fallback for the case where the shell script failed to load, and that
// fallback deliberately does not ask for anything it cannot present properly.
async function ensureAuth() {
  if (window.G99 && window.G99.ensureAuth) return window.G99.ensureAuth();
  // x-login: an empty key counts as a failed login (health checks omit it)
  const r = await fetch("/api/auth-check", { headers: { "x-login": "1" } }).catch(() => null);
  return !!r && r.status !== 401;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const val = (v) => {
  if (Array.isArray(v)) {
    if (v.some((x) => x && typeof x === "object")) return v.map((x) => [x.name, x.title].filter(Boolean).join(" — ") + (x.bio ? ": " + x.bio : "")).join("; ");
    return v.join(", ");
  }
  return v == null ? "" : String(v);
};
const isStructured = (v) => Array.isArray(v) && v.some((x) => x && typeof x === "object");
let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error(`${path} → ${r.status}: ${text.slice(0, 120)}`); }
  if (!r.ok) throw new Error(d.error || `${path} failed (${r.status})`);
  return d;
}

// ---------- state ----------
let ONB = {}, A = {}, composed = null, croBefore = null, croAfter = null, prUrl = null;
const PAGES = [{ key: "home", title: "Home" }, { key: "services", title: "Services" }, { key: "about", title: "About" }, { key: "contact", title: "Contact" }];

// editable fields: [key, label, type]
const FIELDS = [
  ["business_name", "Business name", "input"],
  ["location", "Location", "input"],
  ["existingWebsite", "Existing website (for CRO)", "input", "top"],
  ["phone_for_website", "Phone", "input"],
  ["primary_cta", "Primary CTA", "input"],
  ["brand_aesthetic", "Brand aesthetic", "input"],
  ["hero_headline", "Homepage headline", "input"],
  ["hero_subheadline", "Homepage subheadline", "textarea"],
  ["why_patients_choose", "Why patients choose", "textarea"],
  ["services_offered", "Service categories", "textarea"],
  ["revenue_services", "Featured treatments", "textarea"],
  ["team_roster", "Providers", "textarea"],
  ["financing_offered", "Financing & memberships", "textarea"],
  ["featured_review", "Featured review", "textarea"],
  ["seo_keywords", "SEO keywords", "textarea"],
];

// True when nothing has come in from the platform yet — the screen starts empty
// rather than pre-filled with a stand-in client someone could ship by accident.
const hasResponse = () => !!(A && Object.keys(A).length);

function renderEmptyForm() {
  $("bizChip").textContent = "No client yet";
  $("formGrid").innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:26px 10px 22px">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px">No onboarding response yet</div>
      <p class="desc" style="margin:0 auto 16px;max-width:430px">
        When a client submits the onboarding wizard, the platform posts it here and their answers
        appear in this form, ready to review and build.
      </p>
      <button class="btn sm" id="loadSample">Load the sample response</button>
      <p class="hint" style="margin:9px 0 0">For testing the pipeline without a real submission.</p>
    </div>`;
  $("buildBtn").disabled = true;
  $("saveBtn").disabled = true;
  $("loadSample").onclick = async () => {
    const b = $("loadSample"); b.disabled = true; b.textContent = "Loading…";
    try { await api("/api/onboarding-sample", {}); await loadForm(); toast("Sample response loaded."); }
    catch (e) { b.disabled = false; b.textContent = "Load the sample response"; toast("Could not load it: " + e.message); }
  };
}

async function loadForm() {
  try {
    const r = await fetch("/api/onboarding"); ONB = await r.json(); A = ONB.answers || {};
    if (!hasResponse()) return renderEmptyForm();
    $("buildBtn").disabled = false; $("saveBtn").disabled = false;
    $("bizChip").textContent = `${A.business_name || "Client"}${A.location ? " · " + A.location : ""}`;
    $("formGrid").innerHTML = FIELDS.map(([k, lbl, type, scope]) => {
      const v = scope === "top" ? (ONB[k] || "") : val(A[k]);
      const ro = scope !== "top" && isStructured(A[k]);
      const dis = ro ? " disabled" : "";
      const ctl = type === "textarea"
        ? `<textarea id="f_${k}" rows="2"${dis}>${esc(v)}</textarea>`
        : `<input id="f_${k}" value="${esc(v)}"${dis}>`;
      return `<div class="field" style="${type === "textarea" ? "grid-column:1/-1" : ""}"><label>${esc(lbl)}${ro ? ' <span class="muted">(read-only)</span>' : ""}</label>${ctl}</div>`;
    }).join("");
  } catch (e) { toast("Could not load onboarding: " + e.message); }
}

function collectForm() {
  const answers = {}, top = {};
  for (const [k, , , scope] of FIELDS) {
    const el = $("f_" + k); if (!el) continue;
    if (isStructured(A[k])) continue; // structured object arrays (e.g. team_roster) are display-only — never clobber from text
    let v = el.value;
    // keep list-like fields as arrays if they originally were
    if (Array.isArray(A[k])) v = v.split(",").map((s) => s.trim()).filter(Boolean);
    if (scope === "top") top[k] = v; else answers[k] = v;
  }
  return { answers, top };
}

async function saveForm() {
  const { answers, top } = collectForm();
  $("saveBtn").disabled = true; $("saveHint").innerHTML = '<span class="spin"></span>Saving…';
  try {
    const d = await api("/api/onboarding", { answers, ...top });
    A = { ...A, ...d.answers }; if (top.existingWebsite != null) ONB.existingWebsite = top.existingWebsite;
    $("bizChip").textContent = `${A.business_name || "Client"}${A.location ? " · " + A.location : ""}`;
    $("saveHint").textContent = "Saved ✓";
  } catch (e) { $("saveHint").textContent = ""; toast("Save failed: " + e.message); }
  finally { $("saveBtn").disabled = false; }
}

// ---------- pipeline steps ----------
const STEPS = [
  ["CRO audit — existing site", "Scoring the client's current website for conversion."],
  ["Compose build prompt", "AI writes the brand system + build brief from the CRO findings and site."],
  ["Generate pages (Stitch)", "Building Home, Services, About, Contact."],
  ["WordPress theme + open PR", "Packaging a classic WP theme and opening a GitHub PR."],
  ["Paste the live URL", "Where the pushed site is deployed."],
  ["CRO audit — new site", "Scoring the deployed beta site."],
  ["Before / after comparison", "How much the new site improves conversion."],
];
function renderSteps() {
  $("steps").innerHTML = STEPS.map((s, i) =>
    `<div class="step" id="step${i + 1}"><div class="idx">${i + 1}</div><div class="body"><h3>${esc(s[0])}</h3><div class="st" id="st${i + 1}">${esc(s[1])}</div><div class="out" id="out${i + 1}"></div></div></div>`).join("");
}
function setStep(n, state, msg) {
  const el = $("step" + n); if (!el) return;
  el.classList.remove("run", "done", "err"); if (state) el.classList.add(state);
  if (msg != null) $("st" + n).innerHTML = (state === "run" ? '<span class="spin"></span>' : "") + esc(msg);
}
function out(n, html) { $("out" + n).innerHTML = html; }

// gauge svg (0-100). score == null renders an empty ring + "—", not a fake 0.
function gauge(score, label) {
  const known = typeof score === "number";
  const s = known ? Math.max(0, Math.min(100, score)) : 0;
  const r = 38, c = 2 * Math.PI * r, off = known ? c * (1 - s / 100) : c;
  const col = !known ? "var(--line-light)" : s >= 75 ? "var(--good)" : s >= 50 ? "var(--warn)" : "var(--bad)";
  return `<div class="gauge-item"><div class="gauge"><svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--line-light)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg><div class="n">${known ? s : "—"}</div></div><div class="lbl">${esc(label)}</div></div>`;
}
function catsHtml(rep) {
  return `<div class="cats">${["vision", "ux", "cro", "content"].map((k) => {
    const sc = rep[k] && rep[k].score || 0;
    return `<div class="cat"><span class="cname">${k}</span><span class="bar"><i style="width:${sc}%"></i></span><span class="cv">${sc}/100</span></div>`;
  }).join("")}</div>`;
}
function recsHtml(rep) {
  const recs = (rep.summary && rep.summary.topRecommendations) || [];
  return recs.length ? `<ul class="recs">${recs.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
}

// page prompt builder (ported from the stepper)
function pageSections(key) {
  const headline = A.hero_headline || "", featured = val(A.revenue_services), providers = val(A.team_roster), services = val(A.services_offered);
  const DIRECTIVES = `
PROMPT BLUEPRINT DIRECTIVES (INSPIRED BY RUMA, HELLOSKIN, ER INJECTABLES & AUSTIN AESTHETIC COUTURE):
- PHOTO ENGRAVED TEXT & FLOATING BADGES: High-resolution treatment and provider photography MUST feature floating glassmorphism badges ("4.9★ CLINIC RATED", "BOARD CERTIFIED FACIAL SPECIALISTS") and text written directly ON the photo image under a bottom gradient scrim.
- OVERSIZED PARALLAX BACKGROUND WATERMARK: Render an oversized, 14–22rem 5% opacity brand wordmark watermark bleeding behind Section 3 and the Footer with micro-parallax depth.
- TWO-PART HEADINGS (REQUIRED): Every section heading MUST be a two-part composition. Line 1: Main display serif headline. Line 2 (directly under it in accent gold): an italicized or small-caps sub-line.
- ASYMMETRIC 40/60 LAYOUTS: Avoid plain 3-identical-box grids. Use asymmetric 40/60 splits, arched photo tiles with offset 1px gold borders, and staggered height card grids.
- 60FPS SCROLL ANIMATIONS: Include embedded CSS keyframe animations: @keyframes float, @keyframes pulseGlow, @keyframes fadeInUp. Apply transform: translateY(-8px) scale(1.02) hover states on cards and buttons.
- CONCRETE MEDSPA COPY: Use explicit, non-placeholder MedSpa editorial copy for every section.
- DO NOT: Do NOT use plain white background on 3 consecutive sections. Do NOT use placeholder text. Do NOT use purple/neon gradients.
`;
  return ({
    home: [`Sections (each a DISTINCT layout — do not repeat patterns):`,
      DIRECTIVES,
      `1. HERO — full-viewport cinematic image under a dark gradient; oversized serif headline "${headline || "Refined Aesthetics, Artfully Delivered"}"; subheadline "${A.hero_subheadline || ""}"; two CTAs ("${A.primary_cta || "Book Online"}" + "Explore Treatments"); a floating glass trust-bar with 4.9★ rating.`,
      `2. INTRO — asymmetric 40/60 split with an editorial pull-quote: "${A.why_patients_choose || ""}".`,
      `3. SIGNATURE TREATMENTS — staggered 3D hover card grid for ${featured}. Caption and price sit directly ON the photo under a dark gradient scrim.`,
      `4. SERVICE CATEGORIES — full-bleed dark band listing ${services}.`,
      `5. STATS / TRUST band with animated counter badges. 6. FEATURE with curved image masks and gold borders.`,
      `7. PROVIDERS — offset portraits with credentials: ${providers}.`,
      `8. TESTIMONIAL — oversized pull-quote: "${A.featured_review || ""}".`,
      `9. MEMBERSHIP & FINANCING: ${val(A.financing_offered)}. 10. CLOSING CTA "${A.primary_cta || "Book Online"}".`,
      `11. FOOTER: ${A.business_name || ""}, ${A.location || ""}, phone ${A.phone_for_website || ""}.`].join("\n"),
    services: [`Sections:`, DIRECTIVES, `1. Same transparent nav as home.`, `2. Editorial hero "Our Treatments".`,
      `3. One section per category — ${services} — with cards + "${A.primary_cta || "Book Online"}" CTAs.`,
      `4. Signature spotlight: ${featured}. 5. Financing: ${val(A.financing_offered)}. 6. CTA. 7. Footer.`].join("\n"),
    about: [`Sections:`, DIRECTIVES, `1. Same nav.`, `2. Practice story: "${A.why_patients_choose || ""}".`,
      `3. Meet the team — portrait cards: ${providers}. 4. Values with curved masks.`,
      `5. Testimonial: ${A.featured_review || ""}. 6. CTA. 7. Footer.`].join("\n"),
    contact: [`Sections:`, DIRECTIVES, `1. Same nav.`, `2. Split layout: consultation form beside imagery.`,
      `3. ${A.booking_platform || "Online"} booking panel. 4. Location: ${A.location || ""}, phone ${A.phone_for_website || ""}.`,
      `5. CTA band. 6. Footer.`].join("\n"),
  })[key];
}
function themeFromComposed() {
  return { displayName: A.business_name, primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont };
}

// ---------- step 2: visual brand strip (swatches + fonts) above the prompt ----------
function brandStrip(c) {
  if (!c) return "";
  const sw = (hex, label) => hex ? `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">
      <span style="width:44px;height:44px;border-radius:10px;background:${esc(hex)};border:1px solid var(--line);box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)"></span>
      <span style="font-size:11px;color:var(--muted)">${esc(label)}</span>
      <span style="font-size:11px;font-variant-numeric:tabular-nums">${esc(hex)}</span>
    </div>` : "";
  const font = (name, label) => name ? `<div style="display:flex;flex-direction:column;gap:2px;justify-content:center">
      <span style="font-size:11px;color:var(--muted)">${esc(label)}</span>
      <span style="font-size:16px;font-weight:600">${esc(name)}</span>
    </div>` : "";
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:10px">
    ${sw(c.primary, "Primary")}${sw(c.secondary, "Secondary")}${sw(c.accent, "Accent")}
    <div style="width:1px;align-self:stretch;background:var(--line)"></div>
    ${font(c.headingFont, "Headings")}${font(c.bodyFont, "Body")}
  </div>`;
}

// ---------- step 3 live per-page progress ----------
const PROG_ICON = { queued: "·", generating: "…", "post-processing": "◌", done: "✓", error: "!" };
const PROG_TXT = { queued: "queued", generating: "generating…", "post-processing": "fixing images / SEO…", done: "", error: "" };
function progressRows() {
  return `<div id="pageProg">${PAGES.map((p) =>
    `<div class="cat" id="pp_${p.key}"><span class="cname">${esc(p.title)}</span><span class="cv" style="width:auto" id="pps_${p.key}">· queued</span></div>`).join("")}</div>`;
}
async function updateProgressRows() {
  try {
    const d = await (await fetch("/api/generate-progress")).json();
    for (const p of PAGES) {
      const el = $("pps_" + p.key); if (!el) continue;
      const st = (d.pages || {})[p.key]; if (!st) continue;
      const icon = PROG_ICON[st.status] || "·";
      const txt = st.status === "done" ? `✓ ${((st.bytes || 0) / 1024).toFixed(1)} KB`
        : st.status === "error" ? `! ${st.error || "failed"}`
        : `${icon} ${PROG_TXT[st.status] || st.status}`;
      el.textContent = txt;
      el.style.color = st.status === "done" ? "var(--good)" : st.status === "error" ? "var(--bad)" : "var(--muted)";
    }
  } catch (e) { /* polling is best-effort */ }
}
function progressRowsFinal(okKeys) {
  return `<div class="previews">${PAGES.filter((p) => okKeys.has(p.key)).map((p) => `<a href="/preview/${p.key}" target="_blank">${esc(p.title)} ↗</a>`).join("")}</div>`;
}
// Live scaled thumbnails of the generated pages — shows the actual website, not
// just status. Non-interactive; opens full preview on click. (Serves the current
// generated/ bundle, so accurate for the most-recent build.)
function thumbStrip(keys) {
  const thumb = (k) => `<a href="/preview/${k}" target="_blank" title="${esc(k)}" style="display:inline-block;margin:0 8px 8px 0;text-decoration:none;vertical-align:top">
    <div style="width:180px;height:120px;overflow:hidden;border:1px solid var(--line);border-radius:9px;background:#fff;position:relative">
      <iframe src="/preview/${k}" scrolling="no" tabindex="-1" style="width:900px;height:600px;border:0;transform:scale(.2);transform-origin:top left;pointer-events:none"></iframe>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px;text-align:center;text-transform:capitalize">${esc(k)}</div></a>`;
  return `<div style="margin-top:12px;display:flex;flex-wrap:wrap">${keys.map(thumb).join("")}</div>`;
}

// ---------- step 5 CI watcher: poll build checks every 10s, auto-fix via Gemini ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function watchPrBuilds(prUrl) {
  const MAX_FIXES = 3, MAX_POLLS = 90; // ~15 min ceiling
  let fixes = 0;
  for (let i = 0; i < MAX_POLLS; i++) {
    let st;
    try { st = await api("/api/pr-status", { prUrl }); }
    catch (e) { await wait(10000); continue; }
    const chip = (c) => `<span class="chip ${c.status === "pass" ? "good" : c.status === "fail" ? "bad" : "mute"}" style="display:inline-block;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;margin:2px;color:${c.status === "pass" ? "var(--good)" : c.status === "fail" ? "var(--bad)" : "var(--muted)"}">${esc(c.name)} ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "…"}</span>`;
    if ($("ciChecks")) $("ciChecks").innerHTML = (st.checks || []).map(chip).join("") || '<span class="muted">CI starting…</span>';
    if (st.allPass) {
      if ($("ciHint")) $("ciHint").innerHTML = '<span class="spin"></span>Build checks green ✓ — merging PR…';
      try {
        await api("/api/pr-merge", { prUrl });
        if ($("ciHint")) $("ciHint").textContent = "Merged ✓ — deploy will pick it up from main.";
        setStep(4, "done", `PR merged${fixes ? ` (after ${fixes} auto-fix${fixes > 1 ? "es" : ""})` : ""} — builds green, integration ignored.`);
        return "merged";
      } catch (e) {
        setStep(4, "done", "Builds green but auto-merge failed: " + e.message + " — merge manually.");
        return "merge-failed";
      }
    }
    if (st.anyFail) {
      if (fixes >= MAX_FIXES) {
        setStep(4, "err", `Build still failing after ${MAX_FIXES} auto-fix attempts — check the PR logs.`);
        if ($("ciHint")) $("ciHint").textContent = "Auto-fix limit reached.";
        return;
      }
      fixes++;
      if ($("ciHint")) $("ciHint").innerHTML = `<span class="spin"></span>Build failed — auto-fixing with Gemini (attempt ${fixes}/${MAX_FIXES})…`;
      try {
        const fix = await api("/api/pr-autofix", { prUrl });
        if (!fix.fixed || !fix.fixed.length) {
          setStep(4, "err", `Build failing and auto-fix could not resolve it: ${fix.message || "unknown"}.`);
          return;
        }
        if ($("ciHint")) $("ciHint").innerHTML = `<span class="spin"></span>Fix committed (${esc(fix.fixed.join(", "))}) — waiting for CI to re-run…`;
        await wait(20000); // give CI time to restart on the new commit
        continue;
      } catch (e) {
        setStep(4, "err", "Auto-fix failed: " + e.message);
        return;
      }
    }
    await wait(10000);
  }
  setStep(4, "err", "CI watch timed out (~15 min) — check the PR on GitHub.");
}

// ---------- step 6: watch the live site until the mu-plugin activates the theme ----------
// Signal = /themes/g99-<slug>/ asset path appears in the homepage HTML.
async function watchThemeLive(slug) {
  const MAX = 40; // 40 × 15s ≈ 10 min
  for (let i = 0; i < MAX; i++) {
    const url = ($("liveUrl") && $("liveUrl").value || "").trim() || "https://prodteam.gogroth.com/";
    try {
      const d = await api("/api/theme-live", { url, slug });
      if (d.active) {
        if ($("liveHint")) $("liveHint").textContent = "Theme is live and active ✓";
        setStep(5, "done", "Theme activated on " + url);
        return true;
      }
      if ($("liveHint")) $("liveHint").innerHTML = `<span class="spin"></span>Deploy in progress — theme not active yet (check ${i + 1}/${MAX}, HTTP ${d.httpStatus || "?"})…`;
    } catch (e) { /* keep polling */ }
    await wait(15000);
  }
  return false;
}

// ---------- orchestrator: auto steps 1→4 ----------
let building = false;
async function buildBetaSite() {
  if (building) return;
  if (!hasResponse()) { toast("There's no onboarding response to build from yet."); return; }
  // Multi-minute pipeline that spends Gemini + Stitch credits and opens a PR —
  // never on a single stray click.
  const { answers } = collectForm();
  const ok = await window.G99.confirm({
    title: "Build the beta site?",
    body: "Studio audits the current site, composes the brand, generates every page, creates the WordPress theme and opens a pull request. This takes several minutes and spends AI credits.",
    details: {
      Business: answers.business_name || "(unnamed)",
      "Audits": ONB.existingWebsite || answers.existingWebsite || "(none set)",
      Pages: "Home, Services, About, Contact",
    },
    confirmLabel: "Build beta site",
  });
  if (!ok) return;

  building = true;
  $("buildBtn").disabled = true; $("saveBtn").disabled = true;
  renderSteps();
  try {
    // Save any edits first
    const { answers, top } = collectForm();
    await api("/api/onboarding", { answers, ...top });
    A = { ...A, ...answers }; if (top.existingWebsite != null) ONB.existingWebsite = top.existingWebsite;

    // Step 1 — CRO existing
    setStep(1, "run", "Auditing the current site…");
    const site = ONB.existingWebsite || A.existingWebsite;
    if (!site) throw new Error("No existing website URL — add one in the form (step 1 needs it).");
    croBefore = await api("/api/cro-audit", { url: site });
    setStep(1, "done", `Current site scores ${croBefore.overall}/100.`);
    out(1, `<div class="gauges">${gauge(croBefore.overall, "Existing site")}<div>${catsHtml(croBefore)}</div></div>${recsHtml(croBefore)}`);

    // Step 2 — compose prompt
    setStep(2, "run", "Scanning existing site + composing the brand system & brief…");
    composed = await api("/api/compose-brand", {});
    const src = [composed.usedAnalysis ? "existing-site theme" : null, composed.usedCro ? "CRO report" : null].filter(Boolean).join(" + ") || "onboarding";
    setStep(2, "done", `Prompt ready (${src}).`);
    out(2, `${brandStrip(composed)}<textarea class="promptbox" id="briefBox">${esc(composed.brief || "")}</textarea><div class="hint">Auto-composed. This exact brief drives generation.</div>`);

    // Step 3 — generate pages (Stitch) with live per-page progress
    setStep(3, "run", "Generating 4 pages with Stitch…");
    out(3, progressRows());
    if ($("briefBox")) composed.brief = $("briefBox").value;
    const theme = themeFromComposed();
    const pages = PAGES.map((p) => ({ key: p.key, prompt: `${composed.brief}\n\n${pageSections(p.key)}\n\nReturn one complete, responsive, production-quality HTML page with the SEO requirements applied.` }));
    const poll = setInterval(updateProgressRows, 2000);
    let gen;
    try { gen = await api("/api/generate-site", { engine: "", deviceType: "DESKTOP", theme, pages }); }
    finally { clearInterval(poll); await updateProgressRows(); }
    const results = (gen.pages || gen.results || []);
    const okPages = Array.isArray(results) ? results.filter((x) => x && !x.error) : [];
    if (!okPages.length) {
      const firstErr = ((Array.isArray(results) && results.find((x) => x && x.error)) || {}).error || "Stitch returned no screens";
      throw new Error(`Stitch generated 0 pages — ${firstErr}. Stitch is flaky/rate-limited; click Build again to retry.`);
    }
    const okKeys = new Set(okPages.map((x) => x.page || x.pageKey));

    // Assemble the pages into one coherent site (Gemini AI chrome) + preview link
    setStep(3, "run", `Generated ${okPages.length}/${PAGES.length} — assembling site with Gemini…`);
    const bound = await api("/api/bind-site", { engine: "", theme });
    setStep(3, "done", `Generated ${okPages.length} of ${PAGES.length} pages · site assembled (${bound.chromeSource || "AI chrome"}).`);
    out(3, `${thumbStrip([...okKeys])}${progressRowsFinal(okKeys)}<div style="margin-top:12px"><a class="prlink" href="${esc(bound.siteUrl || "/site/")}" target="_blank">↗ Preview assembled site</a></div>${okPages.length < PAGES.length ? `<div class="hint">⚠ ${PAGES.length - okPages.length} page(s) failed in Stitch — retry Build for a full set.</div>` : ""}`);

    // Step 4 — WP theme + PR (site already bound above; skipRebind avoids doing it twice)
    setStep(4, "run", "Building WordPress theme, pushing, opening PR…");
    const push = await api("/api/push-wordpress", { theme, skipRebind: true });
    prUrl = push.prUrl;
    const slug = ((push.themePath || "").match(/g99-([a-z0-9-]+)\//) || [])[1] || "";
    let merged = false;
    if (!prUrl) {
      setStep(4, "done", `Pushed to ${push.branch || "branch"} — no PR URL returned, check GitHub.`);
    } else {
      out(4, `<a class="prlink" href="${esc(prUrl)}" target="_blank">↗ View pull request</a><div class="hint" id="ciHint"><span class="spin"></span>Watching CI build checks…</div><div id="ciChecks" style="margin-top:8px"></div>`);
      setStep(4, "run", `PR opened — watching CI build checks (every 10s)…`);
      merged = (await watchPrBuilds(prUrl)) === "merged";   // green builds → auto-merge (integration ignored)
    }

    // Step 5 — after merge, watch the live site for theme activation, then
    // run the after-audit automatically. Manual input stays as fallback.
    out(5, `<div class="urlrow"><input id="liveUrl" placeholder="https://prodteam.gogroth.com/" value="https://prodteam.gogroth.com/"><button class="btn sm" onclick="runAfter()">Run after-audit →</button></div><div class="hint" id="liveHint"></div>`);
    if (merged && slug) {
      setStep(5, "run", "Merged — waiting for deploy + theme activation on the live site…");
      const activated = await watchThemeLive(slug);
      if (activated) { await runAfter(); return; } // runs steps 6 + 7
      setStep(5, "run", "Theme not detected yet — deploy may still be running. Paste/confirm the URL and click Run after-audit.");
    } else {
      setStep(5, "run", merged ? "Merged — paste the live URL below." : "Merge & deploy the PR, then paste the live URL below.");
      toast("Pipeline paused at step 5 — confirm the live URL.");
    }
  } catch (e) {
    // mark the running step as errored
    const running = document.querySelector(".step.run");
    if (running) { const n = running.id.replace("step", ""); setStep(n, "err", "Error: " + e.message); }
    toast("Build stopped: " + e.message);
  } finally {
    building = false; $("buildBtn").disabled = false; $("saveBtn").disabled = false;
  }
}

// ---------- steps 6 & 7 ----------
async function runAfter() {
  const url = ($("liveUrl") && $("liveUrl").value || "").trim();
  if (!url) { toast("Enter the live URL first"); return; }
  setStep(5, "done", "Live URL: " + url);
  setStep(6, "run", "Auditing the deployed beta site…");
  try {
    croAfter = await api("/api/cro-audit-url", { url });
    setStep(6, "done", `New site scores ${croAfter.overall}/100.`);
    out(6, `<div class="gauges">${gauge(croAfter.overall, "New site")}<div>${catsHtml(croAfter)}</div></div>${recsHtml(croAfter)}`);
    renderComparison();
  } catch (e) { setStep(6, "err", "Error: " + e.message); toast("After-audit failed: " + e.message); }
}
function shot(url) {
  if (!url) return "";
  return "https://api.microlink.io/?url=" + encodeURIComponent(url) + "&screenshot=true&embed=screenshot.url&meta=false";
}
function renderComparison() {
  if (!croBefore || !croAfter) return;
  const d = croAfter.overall - croBefore.overall;
  const verdict = d >= 20 ? "a major improvement" : d >= 8 ? "a significant improvement" : d > 0 ? "an improvement" : d === 0 ? "no change" : "a regression";
  setStep(7, "done", d >= 0 ? `Conversion score up ${d} points.` : `Score down ${Math.abs(d)} points.`);
  const cats = ["vision", "ux", "cro", "content"].map((k) => {
    const b = croBefore[k] && croBefore[k].score || 0, a = croAfter[k] && croAfter[k].score || 0, dd = a - b;
    return `<div class="cat"><span class="cname">${k}</span><span class="bar"><i style="width:${a}%"></i></span><span class="cv">${b}→${a} <b style="color:${dd >= 0 ? "var(--good)" : "var(--bad)"}">${dd >= 0 ? "+" : ""}${dd}</b></span></div>`;
  }).join("");
  const bImg = shot(croBefore.label), aImg = shot(croAfter.label);
  const shots = (bImg || aImg) ? `<div class="ba-shots">
      <figure><img src="${bImg}" alt="before" loading="lazy"><figcaption>Before</figcaption></figure>
      <figure><img src="${aImg}" alt="after" loading="lazy"><figcaption>After</figcaption></figure>
    </div>` : "";
  out(7, `<div class="ba-hero">
      <div class="ba-score"><div class="ba-num" style="color:${croBefore.overall >= 75 ? "var(--good)" : croBefore.overall >= 50 ? "var(--warn)" : "var(--bad)"}">${croBefore.overall}</div><div class="ba-lbl">Before</div></div>
      <div class="ba-mid"><div class="ba-delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲ +" : "▼ "}${d}</div><div class="ba-verdict">${verdict}</div></div>
      <div class="ba-score"><div class="ba-num" style="color:${croAfter.overall >= 75 ? "var(--good)" : croAfter.overall >= 50 ? "var(--warn)" : "var(--bad)"}">${croAfter.overall}</div><div class="ba-lbl">After</div></div>
    </div>
    ${shots}
    <div class="cats">${cats}</div>`);
}

// ---------- monitor mode: render a server-side webhook job onto this UI ----------
// /dashboard?job=<draftId> — read-only view of a run driven by the job runner.
const MONITOR_ID = new URLSearchParams(location.search).get("job");
const RANK = { pending: 0, done: 1, running: 2, error: 3 };
const CLS = { pending: "", done: "done", running: "run", error: "err" };
function worst(...steps) {
  return steps.reduce((w, s) => (RANK[s.status] > RANK[w.status] ? s : w));
}
function detailOf(...steps) {
  // prefer the most-advanced step's detail so combined rows read naturally
  const active = [...steps].reverse().find((s) => s.status !== "pending");
  return active ? active.detail : steps[0].detail;
}
let monRendered = { form: false, before: false, compose: false, pageInit: false, pageFinal: false, site: false, pr: false, after: false, compare: false, final: false };
function monitorJob(id) {
  const desc = document.querySelector("#pipeCard .desc");
  $("buildBtn").disabled = true; $("saveBtn").disabled = true;
  const tick = async () => {
    let d;
    try { d = await (await fetch("/api/jobs")).json(); } catch (e) { return; }
    const j = (d.jobs || []).find((x) => x.draftId === id);
    if (!j) { desc.innerHTML = `Webhook job <b>${esc(id)}</b> not found — it may have been lost on a server restart. <a href="/jobs">← all jobs</a>`; return; }
    desc.innerHTML = `Monitoring webhook job <b>${esc(id)}</b> — ${esc(j.businessName)} · <b>${esc(j.status.toUpperCase())}</b> · <a href="/jobs">← all jobs</a>`;

    // one-time: overlay the job's answers onto the form
    if (!monRendered.form && j.payload && j.payload.answers) {
      for (const [k, , , scope] of FIELDS) {
        const el = $("f_" + k); if (!el) continue;
        const v = scope === "top" ? j.payload.existingWebsite : j.payload.answers[k];
        if (v != null && !el.disabled) el.value = val(v);
      }
      $("bizChip").textContent = j.businessName + (j.payload.answers.location ? " · " + j.payload.answers.location : "");
      monRendered.form = true;
    }

    const s = j.steps; // server steps s0..s7 → dashboard steps d1..d6
    setStep(1, CLS[s[0].status], s[0].detail || s[0].label);
    if (!monRendered.before && j.before) { out(1, `<div class="gauges">${gauge(j.before.overall, "Existing site")}<div>${catsHtml(j.before)}</div></div>${recsHtml(j.before)}`); monRendered.before = true; }
    // Step 2 — brand strip + the composed build prompt (read-only), like the live run.
    setStep(2, CLS[s[1].status], s[1].detail || s[1].label);
    if (!monRendered.compose && j.composed) {
      out(2, `${brandStrip(j.composed)}<textarea class="promptbox" readonly style="margin-top:8px">${esc(j.composed.brief || "")}</textarea><div class="hint">Auto-composed from CRO + onboarding + reference site. This exact brief drove generation.</div>`);
      monRendered.compose = true;
    }
    // Step 3 — per-page rows: live while generating, snapshot once done.
    const d3 = worst(s[2], s[3]);
    setStep(3, CLS[d3.status], detailOf(s[2], s[3]) || d3.label);
    if (!monRendered.pageInit && s[2].status !== "pending") { out(3, progressRows()); monRendered.pageInit = true; }
    if (monRendered.pageInit && s[2].status === "running") { updateProgressRows(); }        // live poll of /api/generate-progress
    if (!monRendered.pageFinal && s[2].status === "done") {
      // freeze final per-page state from the job's own snapshot (survives later jobs)
      for (const p of PAGES) {
        const el = $("pps_" + p.key); if (!el) continue;
        const st = (j.pages || {})[p.key];
        if (st) { el.textContent = st.status === "error" ? `! ${st.error || "failed"}` : `✓ ${((st.bytes || 0) / 1024).toFixed(1)} KB`; el.style.color = st.status === "error" ? "var(--bad)" : "var(--good)"; }
      }
      monRendered.pageFinal = true;
    }
    // assembled-site preview (append after the per-page rows, don't overwrite them)
    if (!monRendered.site && j.siteUrl) {
      $("out3").insertAdjacentHTML("beforeend", `${thumbStrip(PAGES.map((p) => p.key))}<div style="margin-top:8px"><a class="prlink" href="${esc(j.siteUrl)}" target="_blank">↗ Preview assembled site</a></div>`);
      monRendered.site = true;
    }
    const d4 = worst(s[4], s[5]);
    setStep(4, CLS[d4.status], detailOf(s[4], s[5]) || d4.label);
    if (!monRendered.pr && j.prUrl) { out(4, `<a class="prlink" href="${esc(j.prUrl)}" target="_blank">↗ View pull request</a>`); monRendered.pr = true; }
    setStep(5, CLS[s[6].status], s[6].detail || s[6].label);
    setStep(6, CLS[s[7].status], s[7].detail || s[7].label);
    if (!monRendered.after && j.after) { out(6, `<div class="gauges">${gauge(j.after.overall, "New site")}<div>${catsHtml(j.after)}</div></div>${recsHtml(j.after)}`); monRendered.after = true; }
    if (!monRendered.compare && j.after) {
      croBefore = j.before; croAfter = j.after;
      renderComparison();
      if (j.reportUrl) $("out7").insertAdjacentHTML("beforeend", `<div style="margin-top:12px"><a class="prlink" href="${esc(j.reportUrl)}" target="_blank">↗ Before/after report</a></div>`);
      monRendered.compare = true;
    }

    if ((j.status === "done" || j.status === "error") && !monRendered.final) {
      monRendered.final = true;
      $("buildBtn").disabled = false; $("saveBtn").disabled = false;
      clearInterval(monTimer);
      if (j.status === "error" && j.error) toast("Job failed: " + j.error);
    }
  };
  const monTimer = setInterval(tick, 3000);
  tick();
}

renderSteps();
ensureAuth().then((ok) => {
  if (!ok) { toast("Unauthorized — reload and enter the admin password."); return; }
  loadForm().then(() => { if (MONITOR_ID) monitorJob(MONITOR_ID); });
});
