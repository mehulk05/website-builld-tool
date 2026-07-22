// Growth99 Website-Build Tool — prototype server (pure Node, no deps).
// Screens: onboarding Q&A -> prompt/theme editor -> Stitch generate -> preview/export -> SEO audit.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { URL } = require("url");

const DIR = __dirname;

// ---- .env loader (pure Node, no deps) --------------------------------------
// Local dev keeps credentials in ./.env (gitignored). Deployed environments
// (Render etc.) set real env vars in the platform dashboard instead.
(function loadDotEnv() {
  const f = path.join(DIR, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

// Prefer a local ./bin (deploy build step drops the gh binary there).
if (fs.existsSync(path.join(DIR, "bin"))) process.env.PATH = path.join(DIR, "bin") + path.delimiter + process.env.PATH;

const WP_REPO = process.env.WP_REPO || "Growth99Infra/prodteam.gogroth.com";
// Run a shell command (gh reads GH_TOKEN from env; locally it uses your gh login).
function sh(cmd, cwd) {
  return new Promise((resolve) => exec(cmd, { cwd, maxBuffer: 1e8, windowsHide: true },
    (e, stdout, stderr) => resolve({ code: e ? (e.code || 1) : 0, stdout: stdout || "", stderr: stderr || "" })));
}

const GEN = path.join(DIR, "generated");
const PORT = process.env.PORT || 8793;
const API_KEY = process.env.STITCH_API_KEY || "";
const MCP_URL = "https://stitch.googleapis.com/mcp";
const GEMINI_KEYS = (process.env.GEMINI_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
if (!API_KEY) console.warn("⚠ STITCH_API_KEY not set — Stitch generation will fail. Add it to .env or the platform env vars.");
if (!GEMINI_KEYS.length) console.warn("⚠ GEMINI_KEYS not set — all AI features (CRO, prompt, bind, QC) will fail.");
let GEMINI_KEY = GEMINI_KEYS[0];                 // kept for legacy call sites
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
let gkIdx = 0;
// Rotating Gemini caller: cycles across all keys, skipping 429/503 (load-balance
// + free-tier quota multiplied by key count). parts = Gemini content parts array.
async function geminiCall(parts, opts = {}) {
  const model = opts.model || GEMINI_MODEL;
  const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: opts.temperature ?? 0.5, maxOutputTokens: opts.maxOutputTokens ?? 8000 } };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  let lastErr = null;
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[(gkIdx + i) % GEMINI_KEYS.length];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 45000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status === 503) { lastErr = new Error(`${model} ${r.status}`); continue; }
      const d = await r.json();
      if (!r.ok) throw new Error(`gemini ${r.status}: ${(d.error && d.error.message || "").slice(0, 140)}`);
      gkIdx = (gkIdx + i + 1) % GEMINI_KEYS.length;
      const txt = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (!txt) throw new Error("empty response" + (d.candidates?.[0]?.finishReason ? ` (${d.candidates[0].finishReason})` : ""));
      return txt;
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("all Gemini keys exhausted");
}

if (!fs.existsSync(GEN)) fs.mkdirSync(GEN, { recursive: true });

// ---------------------------------------------------------------- Stitch MCP
let PROTO = "2025-06-18";
let rpcId = 0;
let PROJECT = null; // reused across pages within a run

async function rpc(method, params, notify = false, timeoutMs = 90000) {
  const body = { jsonrpc: "2.0", method };
  if (!notify) body.id = ++rpcId;
  if (params) body.params = params;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Goog-Api-Key": API_KEY,
        "MCP-Protocol-Version": PROTO,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `Stitch ${method} timed out after ${timeoutMs}ms` : `Stitch ${method}: ${e.message}`);
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) throw new Error(`Stitch HTTP ${res.status} on ${method}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  if (notify) return {};
  const parsed = parsePayload(await res.text());
  if (parsed && parsed.error) throw new Error(`Stitch RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed ? parsed.result : {};
}
function parsePayload(raw) {
  if (!raw || !raw.trim()) return null;
  const t = raw.trim();
  if (!t.includes("data:")) return JSON.parse(t);
  let last = null;
  for (const line of t.split("\n")) { const l = line.trim(); if (l.startsWith("data:")) { const d = l.slice(5).trim(); if (d) last = d; } }
  return last ? JSON.parse(last) : null;
}
async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r && r.isError) throw new Error(`tool ${name}: ${(r.content || []).map(c => c.text).join("")}`);
  return r;
}
const structured = (r) => (r && r.structuredContent && typeof r.structuredContent === "object") ? r.structuredContent : r;
function collectScreenIds(r) {
  const s = structured(r), ids = [];
  for (const c of (s.outputComponents || []))
    for (const scr of ((c.design && c.design.screens) || [])) {
      let id = scr.id || ""; if (!id && scr.name) { const i = scr.name.indexOf("/screens/"); if (i >= 0) id = scr.name.slice(i + 9); }
      if (id && !ids.includes(id)) ids.push(id);
    }
  return ids;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getScreen(pid, sid) {
  return structured(await callTool("get_screen", { projectId: pid, screenId: sid, name: `projects/${pid}/screens/${sid}` }));
}
let DESIGN_SYSTEM = null; // per-project design system id ("assets/<id>") for cross-page consistency
async function ensureInit() {
  if (PROJECT) return PROJECT;
  const init = await rpc("initialize", { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "g99-tool", version: "0.1" } });
  if (init && init.protocolVersion) PROTO = init.protocolVersion;
  await rpc("notifications/initialized", null, true);
  const proj = await callTool("create_project", { title: "G99 Website Build" });
  const name = structured(proj)?.name || "";
  PROJECT = name.startsWith("projects/") ? name.slice(9) : name;
  if (!PROJECT) throw new Error("no project id");
  DESIGN_SYSTEM = null;
  return PROJECT;
}
// Best-effort: after the first generation, look up the project's design system
// id so subsequent pages reuse the same fonts/colors/components (the Stitch
// schema says designSystem "should always be configured for design consistency").
async function probeDesignSystem(pid) {
  if (DESIGN_SYSTEM) return;
  try {
    const r = await callTool("get_project", { projectId: pid, name: `projects/${pid}` });
    const m = JSON.stringify(structured(r)).match(/assets\/\d+/);
    if (m) { DESIGN_SYSTEM = m[0]; console.log("design system:", DESIGN_SYSTEM); }
  } catch (e) { console.warn("design-system probe failed (non-fatal):", e.message.slice(0, 120)); }
}
// A generation can return several screens: the real page PLUS decorative
// assets (shader/animation backgrounds, hero images) — and the asset can have
// htmlCode too. Never take the first HTML; score every candidate and keep the
// one that looks like an actual content page.
function pageScore(html) {
  if (!html) return -1;
  // NOTE: do NOT disqualify on the STITCH_SHADER_START marker — real pages can
  // EMBED the shader as a decorative background. Content density alone
  // separates pages from standalone assets (canvas-only stubs have ~0 tags).
  const tags = (html.match(/<(h1|h2|h3|p|a|section|nav|footer|img)\b/gi) || []).length;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const words = (text.match(/\b[a-z]{2,}\b/gi) || []).length;
  if (tags < 5 && words < 50) return 0;                                // canvas-only / stub
  return tags * 10 + words;
}
let SCREENS_MADE = 0;
// Stitch intermittently rejects calls ("Request contains an invalid argument")
// or returns zero screens, especially under back-to-back generations. Retry up
// to 3 attempts, rotating to a FRESH project between attempts; also rotate
// proactively once a project accumulates many screens.
async function generateWithRetry(prompt, deviceType) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (SCREENS_MADE > 10) { PROJECT = null; SCREENS_MADE = 0; }
      const pid = await ensureInit();
      const args = { projectId: pid, prompt, deviceType: (deviceType || "DESKTOP").toUpperCase(), modelId: "GEMINI_3_FLASH" };
      if (DESIGN_SYSTEM) args.designSystem = DESIGN_SYSTEM;
      const gen = await callTool("generate_screen_from_text", args);
      const ids = collectScreenIds(gen);
      if (!ids.length) throw new Error("Stitch returned no screen");
      SCREENS_MADE += ids.length;
      await probeDesignSystem(pid);
      return { pid, ids };
    } catch (e) {
      lastErr = e;
      console.warn(`generate attempt ${attempt}/3 failed: ${e.message} — rotating project and retrying`);
      PROJECT = null; SCREENS_MADE = 0;               // fresh project next attempt
      if (attempt < 3) await sleep(8000 * attempt);   // backoff before retry
    }
  }
  throw new Error(`Stitch failed after 3 attempts: ${lastErr.message}`);
}
async function generate(prompt, deviceType) {
  const { pid, ids } = await generateWithRetry(prompt, deviceType);
  let best = null, fallback = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    for (const id of ids) {
      const scr = await getScreen(pid, id);
      if (!fallback) fallback = { id, scr };
      const url = scr?.htmlCode?.downloadUrl || "";
      if (!url) continue;
      const html = (await (await fetch(url)).text());
      const score = pageScore(html);
      console.log(`  screen ${id.slice(0, 8)} html=${html.length}b score=${score}`);
      if (score > (best ? best.score : 0)) best = { id, scr, html, score };
    }
    if (best) break;          // found at least one real page this pass
    await sleep(3500);        // nothing usable yet — html may lag, retry
  }
  if (best) return { projectId: pid, screenId: best.id, html: best.html, screenshotUrl: best.scr?.screenshot?.downloadUrl || "" };
  return { projectId: pid, screenId: fallback.id, html: "", screenshotUrl: fallback.scr?.screenshot?.downloadUrl || "" };
}

// -------------------------------------------- Analyze existing site (screenshot -> Gemini vision)
// Captures the existing/reference site with microlink (no key), then asks Gemini
// vision to extract its design language so we can generate a new site that
// matches it. Returns structured design tokens + a "match brief" for prompts.
async function analyzeExistingSite(url) {
  const target = /^https?:\/\//i.test(url) ? url : "https://" + url;
  const meta = await (await fetch(`https://api.microlink.io/?url=${encodeURIComponent(target)}&screenshot=true&meta=false`)).json();
  const shotUrl = meta?.data?.screenshot?.url;
  if (!shotUrl) throw new Error("could not capture screenshot of " + target);
  const img = Buffer.from(await (await fetch(shotUrl)).arrayBuffer());
  const prompt = "You are a senior brand/web designer. Analyze this screenshot of an existing website and extract its DESIGN LANGUAGE so another designer can build a NEW site in the SAME visual style. Return ONLY minified JSON with keys: primaryColor (hex), secondaryColor (hex), accentColor (hex), backgroundColor (hex), vibe (EXACTLY one of: \"Luxurious & Warm\", \"Clean & Minimalist\", \"Bold & Modern\", \"Clinical & Precise\"), headingFontStyle, bodyFontStyle, layoutStyle, imageryStyle, mood (array of 3-5 adjectives), signatureElements (array of 3-5 short strings).";
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: img.toString("base64") } }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`Gemini vision HTTP ${r.status}: ${(d.error && d.error.message || "").slice(0, 160)}`);
  const txt = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  const analysis = JSON.parse(txt);
  analysis.screenshotUrl = shotUrl;
  const validVibes = ["Luxurious & Warm", "Clean & Minimalist", "Bold & Modern", "Clinical & Precise"];
  if (!validVibes.includes(analysis.vibe)) analysis.vibe = "Luxurious & Warm";
  return analysis;
}
// Turn an analysis into a prompt block that tells the generator to MATCH it.
function matchBriefFrom(a) {
  if (!a) return "";
  return [`★ TOP PRIORITY — MATCH THE ANALYZED REFERENCE SITE'S DESIGN LANGUAGE. This was extracted from a real screenshot of the reference site and OVERRIDES any generic medspa/luxury convention. The new site must look like it belongs to the same brand family as the reference:`,
    `- Vibe: ${a.vibe}. Mood: ${(a.mood || []).join(", ")}.`,
    `- Colors: primary ${a.primaryColor}, secondary ${a.secondaryColor}, accent ${a.accentColor}, background ${a.backgroundColor}.`,
    `- Headings: ${a.headingFontStyle}. Body: ${a.bodyFontStyle}.`,
    `- Layout: ${a.layoutStyle}. Imagery: ${a.imageryStyle}.`,
    `- Signature elements to echo: ${(a.signatureElements || []).join("; ")}.`].join("\n");
}

// -------------------------------------------- Stitch: single project + design system + parallel
const VIBE_FONTS = {
  "Luxurious & Warm": { headlineFont: "PLAYFAIR_DISPLAY", bodyFont: "INTER", roundness: "ROUND_FOUR" },
  "Clean & Minimalist": { headlineFont: "SPACE_GROTESK", bodyFont: "INTER", roundness: "ROUND_TWO" },
  "Bold & Modern": { headlineFont: "SYNE", bodyFont: "INTER", roundness: "ROUND_EIGHT" },
  "Clinical & Precise": { headlineFont: "INTER", bodyFont: "INTER", roundness: "ROUND_TWO" },
};
function designMdFor(theme) {
  return [`## ${theme.displayName || "Brand"}`,
    `Luxury medical-aesthetics / medspa brand.`, ``,
    `## Colors`,
    `- Primary: ${theme.primary}`,
    `- Secondary: ${theme.secondary}`,
    `- Accent: champagne gold / bronze for emphasis only`, ``,
    `## Imagery`,
    `- Only sharp, high-resolution, professional photography of medspa/skincare/wellness/clinicians.`,
    `- NEVER use blurred, grainy, pixelated or out-of-focus images.`,
    `- Photos sit under a subtle gradient overlay so text stays readable.`, ``,
    `## Style`,
    `- ${theme.vibe}. Editorial, spacious, high-contrast hierarchy, gold accents only for emphasis.`].join("\n");
}
async function createDesignSystemForSite(pid, theme) {
  const f = VIBE_FONTS[theme.vibe] || VIBE_FONTS["Luxurious & Warm"];
  const args = {
    projectId: pid,
    designSystem: {
      displayName: (theme.displayName || "Brand").slice(0, 40),
      theme: {
        colorMode: "LIGHT", colorVariant: "FIDELITY",
        headlineFont: f.headlineFont, bodyFont: f.bodyFont, roundness: f.roundness,
        customColor: theme.primary,
        overridePrimaryColor: theme.primary, overrideSecondaryColor: theme.secondary,
        designMd: designMdFor(theme),
      },
    },
  };
  // Stitch intermittently rejects valid requests as "invalid argument" — retry.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ds = await callTool("create_design_system", args);
      const name = (structured(ds)?.name) || "";
      const asset = name.startsWith("assets/") ? name : (name.match(/assets\/\d+/) || [])[0];
      if (!asset) throw new Error("create_design_system returned no asset id");
      return asset;
    } catch (e) { lastErr = e; if (attempt < 3) await sleep(4000 * attempt); }
  }
  throw new Error(`create_design_system failed after retries: ${lastErr.message}`);
}
// generate ONE page inside a FIXED project (no rotation) with the shared design
// system; retries in place on transient "invalid argument".
async function stitchGenerateInProject(pid, designSystem, prompt, deviceType) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Pin a CURRENT model — the API default resolves to GEMINI_3_PRO, now
      // deprecated. GEMINI_3_1_PRO is the reliable current Pro model.
      const args = { projectId: pid, prompt, deviceType: (deviceType || "DESKTOP").toUpperCase(), modelId: "GEMINI_3_FLASH" };
      // Pass the design system only on the first 2 tries (theme consistency);
      // Stitch sometimes rejects a design-system'd generate as "invalid
      // argument", and generation is reliable WITHOUT it — so later retries drop it.
      if (designSystem && attempt <= 2) args.designSystem = designSystem;
      const gen = await callTool("generate_screen_from_text", args);
      const ids = collectScreenIds(gen);
      if (!ids.length) throw new Error("no screen");
      let best = null, fallback = null;
      for (let pass = 1; pass <= 5; pass++) {
        for (const id of ids) {
          const scr = await getScreen(pid, id);
          if (!fallback) fallback = { id, scr };
          const url = scr?.htmlCode?.downloadUrl || "";
          if (!url) continue;
          const html = await (await fetch(url)).text();
          const score = pageScore(html);
          if (score > (best ? best.score : 0)) best = { id, scr, html, score };
        }
        if (best) break;
        await sleep(3500);
      }
      if (best) return { screenId: best.id, html: best.html, screenshotUrl: best.scr?.screenshot?.downloadUrl || "" };
      return { screenId: fallback.id, html: "", screenshotUrl: fallback.scr?.screenshot?.downloadUrl || "" };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(6000 * attempt);
    }
  }
  throw new Error(`stitch page failed: ${lastErr.message}`);
}
// Build the whole Stitch site: ONE project, ONE design system, all pages in
// parallel — consistent theme, single project with many screen ids.
// Live per-page generation progress, polled by the dashboard (GET /api/generate-progress).
// Reset at the start of each whole-site build; keys are page keys.
let GEN_PROGRESS = { phase: "idle", pages: {} };
function genProg(key, status, extra) { GEN_PROGRESS.pages[key] = { status, ...(extra || {}), ts: Date.now() }; }

async function buildStitchSite(pages, theme, deviceType) {
  GEN_PROGRESS = { phase: "starting", pages: {} };
  pages.forEach(p => genProg(p.key, "queued"));
  const init = await rpc("initialize", { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "g99-tool", version: "0.2" } });
  if (init && init.protocolVersion) PROTO = init.protocolVersion;
  await rpc("notifications/initialized", null, true);
  // create_project intermittently 400s ("invalid argument") — retry.
  let proj = null, pErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { proj = await callTool("create_project", { title: `Website — ${theme.displayName || "Client"}` }); break; }
    catch (e) { pErr = e; if (attempt < 3) await sleep(4000 * attempt); }
  }
  if (!proj) { GEN_PROGRESS.phase = "error"; throw new Error(`create_project failed after retries: ${pErr.message}`); }
  const pname = structured(proj)?.name || "";
  const pid = pname.startsWith("projects/") ? pname.slice(9) : pname;
  if (!pid) { GEN_PROGRESS.phase = "error"; throw new Error("no project id"); }
  GEN_PROGRESS.phase = "design-system";
  let designSystem = null;
  try { designSystem = await createDesignSystemForSite(pid, theme); console.log("design system:", designSystem); }
  catch (e) { console.warn("design system creation failed (continuing without):", e.message.slice(0, 120)); }

  GEN_PROGRESS.phase = "generating";
  const results = await Promise.all(pages.map(async (p) => {
    genProg(p.key, "generating");
    try {
      const out = await stitchGenerateInProject(pid, designSystem, p.prompt, deviceType);
      genProg(p.key, out.html ? "post-processing" : "error", out.html ? {} : { error: "no HTML" });
      return { key: p.key, ...out };
    } catch (e) { genProg(p.key, "error", { error: e.message.slice(0, 120) }); return { key: p.key, error: e.message, html: "" }; }
  }));
  const meta = { projectId: pid, designSystem, screens: {} };
  results.forEach(r => { if (r.screenId) meta.screens[r.key] = r.screenId; });
  results.forEach(r => { if (r.error) console.warn(`stitch page "${r.key}" failed:`, String(r.error).slice(0, 240)); });
  fs.writeFileSync(path.join(GEN, ".stitch-metadata.json"), JSON.stringify(meta, null, 2));
  const okCount = results.filter(r => r.html).length;
  console.log(`stitch: ${okCount}/${results.length} pages generated (project ${pid})`);
  return { projectId: pid, designSystem, results };
}

// ------------------------------------------------------------ Gemini engine
// Fast alternative to Stitch: one text call (~10-30s) returning complete HTML.
async function geminiGenerate(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const sys = [
    "You are an elite front-end designer for luxury medical-aesthetics / medspa brands.",
    "Return ONLY a complete standalone HTML5 document (<!DOCTYPE html> ... </html>) — no markdown fences, no commentary.",
    "Inline all CSS in a <style> tag; you may also use Tailwind via https://cdn.tailwindcss.com. Use Google Fonts via <link>.",
    "THEME: obey the exact hex colors, fonts, and radius given in the prompt's DESIGN TOKENS block. Use CSS variables (:root{--primary;--secondary;--bg;--ink}) set to those exact hex values and reference them everywhere. Do NOT invent a different palette.",
    "IMAGERY — this is a HEALTH / MEDICAL AESTHETICS business, so every photo must be on-topic: medspa interiors, skincare, facial treatments, injectables, wellness, spa, dermatology, professional clinicians. Use https://loremflickr.com/1600/1000/<comma-tags>/all?lock=<n> with RELEVANT tags per section (hero: luxury,spa,skincare,face ; treatments: skincare,facial,dermatology ; team: doctor,clinic,portrait ; interior: spa,clinic,interior). Give each image a unique lock number so photos differ.",
    "IMAGE QUALITY: use only sharp, high-resolution, professional photography. NEVER use blurred, grainy, pixelated, low-res or out-of-focus images. Always place a subtle gradient/color-wash overlay over photos so text stays readable and the image reads intentional — never a bare stretched photo.",
    "POLISH: cinematic hero with overlay, generous whitespace, elegant serif display + clean sans body, refined hover states, section background-color transitions.",
  ].join(" ");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { maxOutputTokens: 32768, temperature: 0.7 },
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(d.error && d.error.message || "").slice(0, 200)}`);
  let text = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error("Gemini returned no content" + (d.candidates?.[0]?.finishReason ? ` (${d.candidates[0].finishReason})` : ""));
  // strip markdown fences if present despite instructions
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fence && fence[1].includes("<html")) text = fence[1];
  const start = text.indexOf("<!DOCTYPE");
  if (start > 0) text = text.slice(start);
  if (!/<html[\s>]/i.test(text)) throw new Error("Gemini output is not a complete HTML document");
  return text.trim();
}

// theme guidance shared by both engines
const STITCH_IMG_CLAUSE = " IMAGE QUALITY: use only sharp, high-resolution, in-focus, professional photography relevant to a medical-aesthetics / medspa business (skincare, facial treatments, injectables, wellness, luxury clinic interiors, clinicians). NEVER use blurred, grainy, pixelated, or low-resolution images. CRITICAL: every image must be a CLEAN PHOTOGRAPH ONLY — it must NOT contain any text, letters, words, logos, navigation bars, buttons, UI elements, or a website/app screenshot rendered inside the image. Never generate an image that looks like a screenshot of a web page. Place a subtle gradient overlay on hero/section images so overlaid HTML text stays readable.";
const VIBE_FONT_NAMES = {
  "Luxurious & Warm": "Playfair Display (serif headings) + Inter (sans body)",
  "Clean & Minimalist": "Space Grotesk headings + Inter body",
  "Bold & Modern": "Syne headings + Inter body",
  "Clinical & Precise": "Inter headings + Inter body",
};
// If the existing site was CRO-audited, turn its findings into a fix directive
// that steers generation to beat the old site on conversion.
function croBriefText() {
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(GEN, ".cro-existing.json"), "utf8"));
    const recs = (rep.summary && rep.summary.topRecommendations) || [];
    const croIssues = (rep.cro && rep.cro.issues) || [];
    if (!recs.length && !croIssues.length) return "";
    return [`★ CRO DIRECTIVE — the client's CURRENT site scored ${rep.overall}/100 on conversion. The NEW site MUST fix these to convert better:`,
      ...recs.slice(0, 6).map(r => `- ${r}`),
      ...croIssues.slice(0, 4).map(i => `- Fix: ${i}`)].join("\n") + "\n\n";
  } catch (e) { return ""; }
}
function designTokensBlock(theme) {
  theme = theme || {};
  const lead = (theme.matchBrief ? theme.matchBrief + "\n\n" : "") + croBriefText();
  return [lead + `DESIGN TOKENS — obey these EXACTLY (this is the theme configured by the user):`,
    `- Primary color: ${theme.primary || "#E8DCC4"} (backgrounds of accent bands, CTA buttons, highlights)`,
    `- Secondary color: ${theme.secondary || "#2C2C2C"} (dark sections, primary text)`,
    `- Vibe: ${theme.vibe || "Luxurious & Warm"}`,
    `- Fonts: ${VIBE_FONT_NAMES[theme.vibe] || VIBE_FONT_NAMES["Luxurious & Warm"]}`,
    `Set :root CSS variables (--primary, --secondary, --bg, --ink) to these EXACT hex values and reference them throughout. Do NOT invent a different brand palette.`].join("\n");
}

// ------------------------------------------------------------ UX audit + refine loop
// Deterministic UX critique from the HTML (always works, no API needed).
function heuristicAudit(html) {
  const c = [];
  const lc = html.toLowerCase();
  const sections = (html.match(/<section\b/gi) || []).length;
  const ctas = (html.match(/book a consultation|book now|schedule|get started/gi) || []).length;
  const imgs = (html.match(/<img\b/gi) || []).length + (html.match(/background-image:/gi) || []).length;
  const hasTestimonial = /testimonial|review|"[^"]{20,}"|★|5-star|5 star/i.test(html);
  const hasTrust = /board.?certified|physician.?led|years|patients|rating|google/i.test(html);
  const hasFinancing = /financ|membership|cherry|carecredit/i.test(html);
  const h1 = (html.match(/<h1\b/gi) || []).length;
  const words = (html.replace(/<[^>]+>/g, " ").match(/\b[a-z]{3,}\b/gi) || []).length;

  if (sections < 6) c.push("Add more distinct sections — the page feels thin; aim for 8–11 varied sections (intro, signature treatments, stats, providers, testimonial, membership, CTA).");
  if (ctas < 3) c.push("Increase conversion touchpoints — repeat a clear 'Book a consultation' CTA in the hero, mid-page, and a full-width closing band.");
  if (ctas > 8) c.push("Too many competing CTAs — keep one primary action; demote the rest to secondary/text links so the eye is guided.");
  if (!hasTrust) c.push("Add a trust bar near the hero (physician-led, board-certified, years in practice, 5★ Google rating) to build immediate credibility.");
  if (!hasTestimonial) c.push("Add a prominent patient testimonial / social-proof section — aesthetic buyers rely heavily on before/after and reviews.");
  if (!hasFinancing) c.push("Surface financing & membership options (Cherry, VIP membership) — reduces price friction for high-ticket treatments.");
  if (h1 !== 1) c.push(`Fix heading hierarchy — found ${h1} H1s; use exactly one H1 for the main value proposition.`);
  if (imgs < 4) c.push("Use richer imagery — add cinematic hero, provider portraits, and treatment visuals with gradient overlays.");
  if (words < 350) c.push("Expand copy — sections are text-light; add persuasive, benefit-led descriptions for scannability and SEO.");
  c.push("Strengthen visual rhythm — ensure 120–200px spacing between sections and alternate light/dark bands for a premium editorial feel.");
  c.push("Add subtle motion — fade/slide-up reveals on scroll and gentle image zoom on hover to feel high-end (respect reduced-motion).");
  return c.slice(0, 8);
}
// Richer critique via Gemini (text). Falls back to heuristic on quota/error.
async function auditPage(html) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const prompt = "You are a senior UX & conversion designer reviewing a luxury medical-aesthetics (medspa) homepage. Below is its HTML. Give 6-8 SPECIFIC, actionable improvements (layout, hierarchy, spacing, hero, CTA, trust/social-proof, imagery, mobile). Return ONLY a JSON array of short strings, no prose.\n\nHTML:\n" + html.slice(0, 18000);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 900 } }) });
    if (!r.ok) throw new Error("gemini " + r.status);
    const d = await r.json();
    let t = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
    const m = t.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : t);
    if (Array.isArray(arr) && arr.length) return { comments: arr.map(String).slice(0, 8), source: "Gemini UX critique" };
    throw new Error("empty");
  } catch (e) {
    return { comments: heuristicAudit(html), source: "Heuristic audit (Gemini unavailable: " + e.message + ")" };
  }
}
// Refine an existing Stitch screen with the audit comments -> improved screen.
async function stitchRefine(projectId, screenId, comments, deviceType) {
  const init = await rpc("initialize", { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "g99-tool", version: "0.2" } });
  if (init && init.protocolVersion) PROTO = init.protocolVersion;
  await rpc("notifications/initialized", null, true);
  const prompt = "Refine and improve THIS existing screen by applying these specific UX/design fixes while keeping the same brand, palette and content. Do not start over — evolve it:\n- " + comments.join("\n- ") + STITCH_IMG_CLAUSE;
  const gen = await callTool("edit_screens", { projectId, selectedScreenIds: [screenId], prompt, deviceType: (deviceType || "DESKTOP").toUpperCase() });
  let ids = collectScreenIds(gen); if (!ids.length) ids = [screenId];
  let best = null, fallback = null;
  for (let pass = 1; pass <= 5; pass++) {
    for (const id of ids) {
      const scr = await getScreen(projectId, id);
      if (!fallback) fallback = { id, scr };
      const u = scr?.htmlCode?.downloadUrl || "";
      if (!u) continue;
      const h = await (await fetch(u)).text();
      const s = pageScore(h);
      if (s > (best ? best.score : 0)) best = { id, scr, html: h, score: s };
    }
    if (best) break;
    await sleep(3500);
  }
  const pick = best || { id: fallback.id, html: "", scr: fallback.scr };
  return { screenId: pick.id, html: pick.html, screenshotUrl: pick.scr?.screenshot?.downloadUrl || "" };
}

// --------------------------------------------- AI bind brain (Gemini now, Claude-swappable)
const BIND_ENGINE = process.env.BIND_ENGINE || "gemini";
// Ask the bind LLM for a polished, self-contained (inline-styled) shared header
// + footer. Small output → safe on flash-lite. Renders identically on any page.
async function aiChrome(theme) {
  const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
  const primary = theme.primary || "#E8DCC4", secondary = theme.secondary || "#2C2C2C";
  const prompt = [
    `You are a senior web designer. Output ONLY a JSON object {"header":"<nav ...>...</nav>","footer":"<footer ...>...</footer>"} for a luxury medical-aesthetics website. No markdown, no commentary.`,
    `Brand: "${a.business_name}". CTA text: "${a.primary_cta}". Location: ${a.location}. Phone: ${a.phone_for_website}. Financing: ${(a.financing_offered || []).join(", ")}.`,
    `HARD RULES:`,
    `- Use INLINE styles ONLY (style="..."). No external CSS classes, no <style> tags — it must render identically injected into any page.`,
    `- Header: a sticky top bar. Left: brand wordmark "${a.business_name}" (serif, elegant). Right: links Home (href="index.html"), Treatments (href="services.html"), Team (href="about.html"), Contact (href="contact.html"), and a "${a.primary_cta}" button (href="contact.html").`,
    `- Footer: refined multi-column — business name, address "${a.location}", phone "${a.phone_for_website}", hours, quick links (same 4), and a financing/membership line.`,
    `- Palette: dark bar background derived from ${secondary}; accent/button ${primary}; ensure high text contrast (light text on dark).`,
    `- Elegant, minimal, premium. Keep total output compact.`,
  ].join("\n");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 4000 } }) });
  if (!r.ok) throw new Error("bind LLM " + r.status);
  const d = await r.json();
  let t = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error("bind LLM: no JSON");
  const obj = JSON.parse(m[0]);
  if (!obj.header) throw new Error("bind LLM: no header");
  return { header: obj.header, footer: obj.footer || "", source: BIND_ENGINE };
}
// Smart bind: AI-generated shared chrome injected into every page + link rewire.
// Falls back to the deterministic canonical nav if the LLM is unavailable.
// ------------------------------------------------------------ WordPress export (classic theme for Bedrock)
const WP_PAGES = [["index", "front-page.php", "/"], ["services", "page-services.php", "/services/"], ["about", "page-about.php", "/about/"], ["contact", "page-contact.php", "/contact/"], ["branding", "page-branding.php", "/branding/"], ["seo", "page-seo.php", "/seo/"]];
function wpRewriteLinks(html) {
  let h = html;
  const map = { "index.html": "/", "services.html": "/services/", "about.html": "/about/", "contact.html": "/contact/", "branding.html": "/branding/", "seo.html": "/seo/" };
  for (const [f, to] of Object.entries(map)) h = h.split(`href="${f}"`).join(`href="${to}"`);
  return h;
}
function stripReviewBar(html) { return html.replace(/<div data-g99-review[\s\S]*?<\/div>\s*/i, ""); }
function splitPage(html) {
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ""])[1];
  let body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  body = stripReviewBar(body);
  const header = (body.match(/<nav\b[\s\S]*?<\/nav>/i) || body.match(/<header\b[\s\S]*?<\/header>/i) || [""])[0];
  const footer = (body.match(/<footer\b[\s\S]*?<\/footer>/i) || [""])[0];
  let main = body;
  if (header) main = main.replace(header, "");
  if (footer) main = main.replace(footer, "");
  return { head: wpRewriteLinks(head), header: wpRewriteLinks(header), footer: wpRewriteLinks(footer), main: wpRewriteLinks(main) };
}
async function buildWpTheme(slug, biz) {
  const siteDir = path.join(GEN, "site");
  if (!fs.existsSync(path.join(siteDir, "index.html"))) throw new Error("Bind the site first (Step 4) — no /site/ bundle found.");
  const themeDir = path.join(GEN, "wp-theme", slug);
  const buildId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""); // YYYYMMDDHHMM — keys one-time auto-activation per deploy
  fs.rmSync(themeDir, { recursive: true, force: true });
  fs.mkdirSync(themeDir, { recursive: true });
  // Use the HOME page's head + header + footer as the shared chrome
  const home = splitPage(fs.readFileSync(path.join(siteDir, "index.html"), "utf8"));
  const written = [];
  const w = (name, content) => { fs.writeFileSync(path.join(themeDir, name), content); written.push(name); };

  w("style.css", `/*\nTheme Name: ${biz} (Growth99)\nTheme URI: https://growth99.com\nAuthor: Growth99\nDescription: AI-generated beta theme for ${biz}. Classic theme for Bedrock WordPress.\nVersion: 1.0.0\nLicense: Proprietary\nText Domain: g99-${slug}\n*/\n`);

  w("functions.php", `<?php

/**
 * ${biz} — Growth99 generated theme.
 */

add_action('after_setup_theme', function () {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('html5', ['search-form', 'gallery', 'caption', 'style', 'script']);
    register_nav_menus(['primary' => 'Primary Menu']);
});

add_action('wp_enqueue_scripts', function () {
    wp_enqueue_style('g99-${slug}', get_stylesheet_uri(), [], '1.0.0');
});

/**
 * On activation, auto-create the site's Pages, assign templates, set the static
 * front page, and build the primary menu. Idempotent — safe to re-run.
 */
add_action('after_switch_theme', function () {
    $pages = [
        ['title' => 'Home', 'slug' => 'home', 'template' => ''],
        ['title' => 'Treatments', 'slug' => 'services', 'template' => 'page-services.php'],
        ['title' => 'Team', 'slug' => 'about', 'template' => 'page-about.php'],
        ['title' => 'Contact', 'slug' => 'contact', 'template' => 'page-contact.php'],
        ['title' => 'Branding', 'slug' => 'branding', 'template' => 'page-branding.php'],
        ['title' => 'SEO', 'slug' => 'seo', 'template' => 'page-seo.php'],
    ];

    $home_id = 0;
    foreach ($pages as $p) {
        $existing = get_page_by_path($p['slug']);
        $id = $existing ? $existing->ID : wp_insert_post([
            'post_title' => $p['title'],
            'post_name' => $p['slug'],
            'post_status' => 'publish',
            'post_type' => 'page',
            'post_content' => '',
        ]);
        if ($id && $p['template']) {
            update_post_meta($id, '_wp_page_template', $p['template']);
        }
        if ($p['slug'] === 'home') {
            $home_id = $id;
        }
    }

    if ($home_id) {
        update_option('show_on_front', 'page');
        update_option('page_on_front', $home_id);
    }

    if (!wp_get_nav_menu_object('Primary')) {
        $menu_id = wp_create_nav_menu('Primary');
        foreach ($pages as $p) {
            $pg = get_page_by_path($p['slug']);
            if ($pg) {
                wp_update_nav_menu_item($menu_id, 0, [
                    'menu-item-title' => $p['title'],
                    'menu-item-object' => 'page',
                    'menu-item-object-id' => $pg->ID,
                    'menu-item-type' => 'post_type',
                    'menu-item-status' => 'publish',
                ]);
            }
        }
        $locations = get_theme_mod('nav_menu_locations', []);
        $locations['primary'] = $menu_id;
        set_theme_mod('nav_menu_locations', $locations);
    }
});
`);

  w("header.php", `<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
${home.head.trim()}
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
${home.header}
`);

  w("footer.php", `${home.footer}
<?php wp_footer(); ?>
</body>
</html>
`);

  // index.php — REQUIRED fallback template (WP marks the theme broken without it)
  w("index.php", `<?php

get_header();

if (have_posts()) {
    while (have_posts()) {
        the_post();
        ?>
        <article <?php post_class(); ?> style="margin-bottom:40px">
            <h1><?php the_title(); ?></h1>
            <div><?php the_content(); ?></div>
        </article>
        <?php
    }
} else {
    ?>
    <p>Nothing here yet.</p>
    <?php
}

get_footer();
`);

  for (const [key, tmpl] of WP_PAGES) {
    const f = path.join(siteDir, key + ".html");
    if (!fs.existsSync(f)) continue;
    const parts = splitPage(fs.readFileSync(f, "utf8"));
    const tmplName = key === "index" ? "" : `<?php /* Template Name: ${key[0].toUpperCase() + key.slice(1)} */ ?>\n`;
    w(tmpl, `${tmplName}<?php get_header(); ?>
<main id="main">
${parts.main.trim()}
</main>
<?php get_footer(); ?>
`);
  }

  w("README.md", `# ${biz} — Growth99 beta theme

Classic WordPress theme generated for the Bedrock repo (\`web/app/themes/g99-${slug}/\`).

## Install (Bedrock + WP-CLI)
1. Copy this folder into \`web/app/themes/g99-${slug}/\`.
2. \`wp theme activate g99-${slug}\`
3. Create Pages: Home, Services, About, Contact, Branding, SEO — assign each the matching "Template" (Settings → Reading: set Home as a static front page).
4. Create a Primary Menu with those pages.

Notes: styling loads Tailwind + Google Fonts from CDN in the page head (beta). For production, compile Tailwind to a static \`assets/app.css\` and enqueue it. Images use stable hosted URLs.
`);

  // Guideline guard: a classic WP theme is "broken" without these. Fail loudly
  // here so we never build/push a theme that WordPress will refuse to render.
  const REQUIRED_THEME_FILES = ["index.php", "style.css"];
  const missing = REQUIRED_THEME_FILES.filter(f => !fs.existsSync(path.join(themeDir, f)));
  if (missing.length) {
    throw new Error(`Refusing to build theme "${slug}": missing required WordPress file(s): ${missing.join(", ")}. Every classic theme MUST ship index.php + style.css or WP marks it "Broken (Template is missing)".`);
  }

  return { slug, themeDir, files: written, buildId };
}

// Must-use plugin (web/app/mu-plugins/) that (1) auto-activates the beta theme
// once per deploy and (2) provisions its Pages + menu once the theme is active.
// Provisioning lives HERE, not in the theme's after_switch_theme hook, because a
// programmatic switch_theme() does not reliably fire that hook — so pages would
// never be created and every non-home URL falls back to index.php ("Nothing here
// yet"). Running on `init` (theme already active, post APIs loaded) is
// deterministic. Idempotent + flag-guarded; delete the file to disable.
function wpActivatorPlugin(slug, biz, buildId) {
  const fn = "g99_provision_" + slug.replace(/[^a-z0-9]+/g, "_"); // php-safe unique fn name
  return `<?php

/**
 * Growth99 beta theme auto-activator + page provisioner for "${biz}".
 *
 * On deploy this activates the "g99-${slug}" theme (once) and creates its Pages,
 * assigns their templates, sets the static front page and builds the primary
 * menu (once). Guarded by per-build option flags so it never fights a later
 * manual change. To disable, delete this file.
 */

add_action('init', function () {
    $slug = 'g99-${slug}';
    $build = '${buildId}';

    $theme = wp_get_theme($slug);
    if (! $theme->exists() || $theme->errors()) {
        return; // never switch to a broken/missing theme
    }

    // 1) Activate once per build.
    if (get_option('g99_autoactivated_' . $slug) !== $build) {
        if (get_stylesheet() !== $slug) {
            switch_theme($slug);
        }
        update_option('g99_autoactivated_' . $slug, $build);
        // Activation takes effect on the next request; pages are provisioned then.
    }

    // 2) Provision Pages + menu once the theme is actually active.
    if (get_stylesheet() === $slug && get_option('g99_provisioned_' . $slug) !== $build) {
        ${fn}();
        update_option('g99_provisioned_' . $slug, $build);
    }
});

if (! function_exists('${fn}')) {
    function ${fn}()
    {
        $pages = [
            ['title' => 'Home', 'slug' => 'home', 'template' => ''],
            ['title' => 'Treatments', 'slug' => 'services', 'template' => 'page-services.php'],
            ['title' => 'Team', 'slug' => 'about', 'template' => 'page-about.php'],
            ['title' => 'Contact', 'slug' => 'contact', 'template' => 'page-contact.php'],
            ['title' => 'Branding', 'slug' => 'branding', 'template' => 'page-branding.php'],
            ['title' => 'SEO', 'slug' => 'seo', 'template' => 'page-seo.php'],
        ];

        $home_id = 0;
        foreach ($pages as $p) {
            $existing = get_page_by_path($p['slug']);
            $id = $existing ? $existing->ID : wp_insert_post([
                'post_title' => $p['title'],
                'post_name' => $p['slug'],
                'post_status' => 'publish',
                'post_type' => 'page',
                'post_content' => '',
            ]);
            if ($id && $p['template']) {
                update_post_meta($id, '_wp_page_template', $p['template']);
            }
            if ($p['slug'] === 'home') {
                $home_id = $id;
            }
        }

        if ($home_id) {
            update_option('show_on_front', 'page');
            update_option('page_on_front', $home_id);
        }

        if (! wp_get_nav_menu_object('Primary')) {
            $menu_id = wp_create_nav_menu('Primary');
            foreach ($pages as $p) {
                $pg = get_page_by_path($p['slug']);
                if ($pg) {
                    wp_update_nav_menu_item($menu_id, 0, [
                        'menu-item-title' => $p['title'],
                        'menu-item-object' => 'page',
                        'menu-item-object-id' => $pg->ID,
                        'menu-item-type' => 'post_type',
                        'menu-item-status' => 'publish',
                    ]);
                }
            }
            $locations = get_theme_mod('nav_menu_locations', []);
            $locations['primary'] = $menu_id;
            set_theme_mod('nav_menu_locations', $locations);
        }
    }
}
`;
}

// Thin, self-contained beta review bar shown on every bundled page + review page.
function reviewBanner() {
  const link = (href, label) => `<a href="${href}" style="color:#fff;text-decoration:none;opacity:.85;margin:0 10px;font-weight:600">${label}</a>`;
  return `<div data-g99-review style="position:relative;z-index:100000;background:#6d4e8c;color:#fff;font-family:system-ui,sans-serif;font-size:12.5px;letter-spacing:.02em;padding:8px 20px;text-align:center">
  <b style="letter-spacing:.12em;text-transform:uppercase;font-size:11px;margin-right:6px">Beta preview</b>
  ${link("index.html", "Site")} ·${link("branding.html", "Branding guide")} ·${link("seo.html", "SEO report")}
</div>`;
}
async function bindSiteSmart(engineSuffix, theme) {
  const sfx = engineSuffix ? `-${engineSuffix}` : "";
  const read = (k) => { const f = path.join(GEN, k + sfx + ".html"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };
  const pages = [["home", "index.html"], ["services", "services.html"], ["about", "about.html"], ["contact", "contact.html"]];
  const present = pages.filter(([k]) => read(k));
  if (!present.length) throw new Error(`no ${engineSuffix || "stitch"} pages generated yet`);
  let chrome = null, source = "canonical (fallback)";
  try { chrome = await aiChrome(theme || {}); source = chrome.source + " chrome"; }
  catch (e) { console.warn("aiChrome failed, using canonical nav:", e.message.slice(0, 120)); }
  const dirName = engineSuffix ? `site-${engineSuffix}` : "site";
  const siteDir = path.join(GEN, dirName);
  if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
  const banner = reviewBanner();
  const written = [];
  for (const [k, out] of present) {
    let html = read(k);
    html = stripSiteChrome(html);
    if (chrome) {
      html = html.replace(/<body[^>]*>/i, (mm) => mm + "\n" + banner + "\n" + chrome.header);
      if (chrome.footer) html = html.replace(/<\/body>/i, chrome.footer + "\n</body>");
    } else {
      html = html.replace(/<body[^>]*>/i, (mm) => mm + "\n" + banner + "\n" + canonicalNav(theme || {}));
    }
    html = rewireLinks(html);
    fs.writeFileSync(path.join(siteDir, out), html);
    written.push(out);
  }
  // Ship the two client review pages inside the bundle (branding.html + seo.html)
  const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
  const brandFull = { primary: theme.primary || "#E8DCC4", secondary: theme.secondary || "#2C2C2C", accent: theme.accent || "#B49A6A", headingFont: theme.headingFont || "Playfair Display", bodyFont: theme.bodyFont || "Inter" };
  const withBanner = (h) => h.replace(/<body[^>]*>/i, (m) => m + banner);
  try { fs.writeFileSync(path.join(siteDir, "branding.html"), withBanner(await brandGuideHtml(brandFull, a))); written.push("branding.html"); } catch (e) { console.warn("brand guide in bundle failed:", e.message.slice(0, 100)); }
  try { fs.writeFileSync(path.join(siteDir, "seo.html"), withBanner(await seoReportHtml(brandFull, a, dirName))); written.push("seo.html"); } catch (e) { console.warn("seo report in bundle failed:", e.message.slice(0, 100)); }
  const base = engineSuffix ? `/site-${engineSuffix}/` : "/site/";
  return { files: written, siteUrl: base, zipUrl: "/export-site" + (engineSuffix ? `?engine=${engineSuffix}` : ""), chromeSource: source };
}

// Rebuild the default /site/ bundle from the newest generated pages so Export
// and Push can never ship a theme older than the current preview. buildWpTheme
// always reads generated/site/, so we rebind that (stitch) bundle. If nothing
// has been generated yet but a previous bundle exists, keep it (warn) instead
// of failing the export.
async function ensureFreshSite(theme) {
  try {
    return await bindSiteSmart("", theme || {});
  } catch (e) {
    if (fs.existsSync(path.join(GEN, "site", "index.html"))) {
      console.warn("auto-rebind skipped, using existing /site/:", e.message.slice(0, 120));
      return null;
    }
    throw e;
  }
}

// Which Stitch pages exist (project + screen ids + generated html on disk).
function stitchPageKeys() {
  const metaFile = path.join(GEN, ".stitch-metadata.json");
  if (!fs.existsSync(metaFile)) return { projectId: null, screens: {}, keys: [] };
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const keys = Object.keys(meta.screens || {}).filter(k => fs.existsSync(path.join(GEN, k + ".html")));
  return { projectId: meta.projectId, screens: meta.screens || {}, keys };
}

// ------------------------------------------------------------ Site assembler
// Turn per-page screens into ONE navigable site: canonical nav+footer from the
// home page injected everywhere, nav links rewired to real files, bundled
// under generated/site/ (served at /site/, zipped at /export-site).
const NAV_MAP = [
  [/treatment|service/i, "services.html"], [/team|about|provider|meet/i, "about.html"],
  [/book|contact|consult/i, "contact.html"], [/membership|financ/i, "services.html"],
  [/^home$|logo/i, "index.html"],
];
function rewireLinks(html) {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
    const text = inner.replace(/<[^>]+>/g, " ").trim();
    for (const [re, target] of NAV_MAP) {
      if (re.test(text)) {
        const newAttrs = /href=/i.test(attrs)
          ? attrs.replace(/href=["'][^"']*["']/i, `href="${target}"`)
          : attrs + ` href="${target}"`;
        return `<a${newAttrs}>${inner}</a>`;
      }
    }
    return m;
  });
}
function extractBlock(html, tag) {
  const m = html.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "i"));
  return m ? m[0] : null;
}
function assembleSite(engineSuffix) {
  const sfx = engineSuffix ? `-${engineSuffix}` : "";
  const read = (k) => { const f = path.join(GEN, k + sfx + ".html"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };
  const home = read("home");
  if (!home) throw new Error(`no home${sfx}.html generated yet`);
  const nav = extractBlock(home, "nav") || extractBlock(home, "header");
  const footer = extractBlock(home, "footer");
  const siteDir = path.join(GEN, engineSuffix ? `site-${engineSuffix}` : "site");
  if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
  const pages = [["home", "index.html"], ["services", "services.html"], ["about", "about.html"], ["contact", "contact.html"]];
  const written = [];
  for (const [key, out] of pages) {
    let html = read(key);
    if (!html) continue;
    if (key !== "home") {
      // swap in the canonical nav + footer so every page matches home
      const ownNav = extractBlock(html, "nav") || extractBlock(html, "header");
      if (nav && ownNav) html = html.replace(ownNav, nav);
      const ownFooter = extractBlock(html, "footer");
      if (footer && ownFooter) html = html.replace(ownFooter, footer);
    }
    html = rewireLinks(html);
    fs.writeFileSync(path.join(siteDir, out), html);
    written.push(out);
  }
  const base = engineSuffix ? `/site-${engineSuffix}/` : "/site/";
  return { files: written, siteUrl: base, zipUrl: "/export-site" + (engineSuffix ? `?engine=${engineSuffix}` : "") };
}

// ------------------------------------------------------------ Stitch image sharpener
// Stitch's AI images live on lh3.googleusercontent.com and, WITHOUT a size
// suffix, Google serves a ~512px thumbnail — which stretched to a full-width
// hero looks blurry. Appending a size param returns the native 1376x768 render
// (4x the pixels). This rewrites every such URL to request full resolution.
function sharpenStitchImages(html) {
  if (!html) return html;
  return html.replace(/https:\/\/lh3\.googleusercontent\.com\/aida-public\/[A-Za-z0-9_\-]+/g,
    (u) => (/=[ws]\d/.test(u) ? u : u + "=w1600"));
}

// Curated, clean, text-free, on-topic replacement photos (validated to load).
const CURATED_IMAGES = [
  "photo-1570172619644-dfd03ed5d881", "photo-1512290923902-8a9f81dc236c", "photo-1519824145371-296894a0daa9",
  "photo-1616394584738-fc6e612e71b9", "photo-1600334129128-685c5582fd35", "photo-1544161515-4ab6ce6db874",
  "photo-1515377905703-c4788e51af15", "photo-1596755094514-f87e34085b2c", "photo-1487412720507-e7ab37603c6f",
  "photo-1629909613654-28e377c37b09", "photo-1552693673-1bf958298935", "photo-1571019613454-1cb2f99b2d8b",
  "photo-1583900985737-6d0495555783", "photo-1512207736890-6ffed8a84e8d",
].map(id => `https://images.unsplash.com/${id}?w=1600&q=80&auto=format&fit=crop`);

// Guarantee no broken images: Stitch sometimes emits session-bound
// lh3.googleusercontent.com/aida/... URLs that fail in the browser (and even
// /aida-public/ ones expire). Replace any image that isn't a stable, loading
// image with a curated topical photo. Deterministic, no LLM needed.
async function fixImages(html) {
  const urls = [...new Set((html.match(/https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-\/=]+/g) || []))];
  if (!urls.length) return html;
  let ci = 0;
  for (const u of urls) {
    let replace = false;
    if (!/\/aida-public\//.test(u)) {
      replace = true;                       // /aida/ screenshot-type → browser-unreliable
    } else {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(u, { signal: ctl.signal }); clearTimeout(t);
        if (!r.ok || !((r.headers.get("content-type") || "").startsWith("image"))) replace = true;
      } catch (e) { replace = true; }
    }
    if (replace) { const c = CURATED_IMAGES[ci++ % CURATED_IMAGES.length]; html = html.split(u).join(c); console.log(`  img fix: ${u.slice(40, 56)}… -> curated`); }
  }
  return html;
}
// Ask Gemini vision whether an image contains baked-in text / UI / a website
// mockup (Stitch sometimes renders a fake nav bar INTO the photo pixels).
async function imageHasText(url) {
  try {
    const img = Buffer.from(await (await fetch(url)).arrayBuffer());
    const body = {
      contents: [{ role: "user", parts: [
        { text: "Does this image contain any readable text, words, letters, logos, navigation menus, buttons, or a website/app screenshot baked into it? Answer with ONLY one word: YES or NO." },
        { inline_data: { mime_type: "image/jpeg", data: img.toString("base64") } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 5 },
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    const t = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("").toUpperCase();
    return t.includes("YES");
  } catch (e) { return false; }   // on error, leave the image alone
}
// QC every unique Stitch image; replace any with baked-in text by a curated photo.
async function qcStitchImages(html) {
  const urls = [...new Set((html.match(/https:\/\/lh3\.googleusercontent\.com\/aida-public\/[A-Za-z0-9_\-]+(?:=w\d+)?/g) || []))];
  if (!urls.length) return html;
  const flags = await Promise.all(urls.map(u => imageHasText(u)));
  let ci = 0;
  urls.forEach((u, i) => {
    if (flags[i]) {
      const repl = CURATED_IMAGES[ci++ % CURATED_IMAGES.length];
      html = html.split(u).join(repl);
      console.log(`  QC: replaced text-in-image ${u.slice(-16)} -> curated`);
    }
  });
  return html;
}

// ------------------------------------------------------------ Canonical chrome
// Stitch/Gemini frequently hallucinate nav labels ("CAREES", "SKINRALES") and
// bake a blurry logo image into the header. Never trust the model's chrome:
// replace the header/nav on EVERY page with a clean, deterministic bar built
// from real onboarding data — text logo, correct labels, working links, theme
// colors. Guarantees correct + consistent nav across all pages and engines.
function lum(hex) {
  const c = String(hex || "").replace("#", "");
  if (c.length < 6) return 0;
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function canonicalNav(theme) {
  let biz = theme.displayName || "Brand", cta = "Book a consultation";
  try { const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers; biz = a.business_name || biz; cta = a.primary_cta || cta; } catch (e) {}
  const primary = theme.primary || "#E8DCC4", secondary = theme.secondary || "#2C2C2C";
  // contrast-safe bar: pick a genuinely dark background so the logo/links are visible
  const darker = lum(secondary) <= lum(primary) ? secondary : primary;
  const barBg = lum(darker) < 0.45 ? darker : "#1b1b1b";
  const ctaBg = lum(primary) > lum(secondary) ? primary : secondary;
  const ctaText = lum(ctaBg) > 0.6 ? "#1b1b1b" : "#ffffff";
  const link = (href, label) => `<a href="${href}" style="color:#fff;text-decoration:none;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-family:system-ui,-apple-system,sans-serif;opacity:.92">${label}</a>`;
  return `<nav data-g99-nav style="position:sticky;top:0;z-index:99999;display:flex;align-items:center;justify-content:space-between;padding:16px 40px;background:${barBg}">
  <a href="index.html" style="color:#fff;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:600;letter-spacing:.04em;text-decoration:none">${biz}</a>
  <div style="display:flex;align-items:center;gap:26px">
    ${link("index.html", "Home")}${link("services.html", "Treatments")}${link("about.html", "Team")}${link("contact.html", "Contact")}
    <a href="contact.html" style="background:${ctaBg};color:${ctaText};padding:9px 18px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;font-family:system-ui,sans-serif">${cta}</a>
  </div>
</nav>`;
}
// Remove ALL top-of-site chrome the model produced (it may emit several: a
// fixed bar, a mobile menu, a duplicate) so ours is the ONLY header — then
// inject one canonical nav. In-content sub-navs (category tabs) are left alone.
function stripSiteChrome(html) {
  html = html.replace(/<header\b[\s\S]*?<\/header>/gi, "");
  html = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (m) => {
    const head = m.slice(0, 240).toLowerCase();
    const isSiteNav = /fixed|sticky|top-0|z-\[?[59]0|backdrop|header|data-g99-nav/.test(head)
      || /book|consult|home<\/a>|home\s*<|menu/i.test(m);
    return isSiteNav ? "" : m;
  });
  return html;
}
function injectCanonicalNav(html, theme) {
  html = stripSiteChrome(html);
  const nav = canonicalNav(theme);
  return html.replace(/<body[^>]*>/i, (m) => m + "\n" + nav);
}

// ------------------------------------------------------------ SEO enhance
// Stitch is a DESIGN generator — it reliably ignores meta/schema instructions
// in prompts. Apply the technical SEO deterministically after generation
// (mirrors the real pipeline, where the SEO stage optimizes the built site).
function seoEnhance(html, pageKey) {
  const ob = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8"));
  const a = ob.answers;
  const kws = a.seo_keywords || [];
  const city = (a.location || "").split(",").slice(-2).join(",").trim();

  // lang attribute
  if (!/<html[^>]+lang=/i.test(html)) html = html.replace(/<html/i, '<html lang="en"');

  // <title>
  if (!/<title[^>]*>[^<]{5,}/i.test(html)) {
    const title = `${a.business_name} | MedSpa in ${city}`.slice(0, 63);
    html = /<title[^>]*>[\s\S]*?<\/title>/i.test(html)
      ? html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
      : html.replace(/<head([^>]*)>/i, `<head$1>\n<title>${title}</title>`);
  }

  const headInjects = [];
  // meta description
  if (!/<meta[^>]+name=["']description["']/i.test(html)) {
    let desc = `${a.business_description || a.business_name} Serving ${city}. ${a.primary_cta} today.`;
    if (desc.length > 160) desc = desc.slice(0, 157).replace(/\s+\S*$/, "") + "…";
    headInjects.push(`<meta name="description" content="${desc.replace(/"/g, "&quot;")}">`);
  }
  // canonical + Open Graph
  const canonical = `https://elanaesthetics.com/${pageKey === "home" ? "" : pageKey}`;
  if (!/rel=["']canonical["']/i.test(html)) headInjects.push(`<link rel="canonical" href="${canonical}">`);
  if (!/property=["']og:title["']/i.test(html)) {
    headInjects.push(`<meta property="og:title" content="${a.business_name.replace(/"/g, "&quot;")}">`);
    headInjects.push(`<meta property="og:type" content="website">`);
    headInjects.push(`<meta property="og:url" content="${canonical}">`);
  }
  // JSON-LD LocalBusiness/MedicalBusiness
  if (!/application\/ld\+json/i.test(html)) {
    const ld = {
      "@context": "https://schema.org", "@type": "MedicalBusiness",
      name: a.business_name, description: a.business_description,
      telephone: a.phone_for_website, url: canonical,
      address: { "@type": "PostalAddress", addressLocality: "Scottsdale", addressRegion: "AZ", streetAddress: a.location },
      openingHours: "Mo-Fr 09:00-18:00 Sa 09:00-14:00",
      priceRange: "$$$",
    };
    headInjects.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  }
  if (headInjects.length) html = html.replace(/<\/head>/i, headInjects.join("\n") + "\n</head>");

  // exactly one H1: promote the first H2 if no H1 exists
  if (!/<h1[\s>]/i.test(html) && /<h2[\s>]/i.test(html)) {
    html = html.replace(/<h2(\s[^>]*)?>/i, "<h1$1>").replace(/<\/h2>/i, "</h1>");
  }

  // alt text on every image
  let altN = 0;
  html = html.replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
    if (/\balt\s*=/i.test(attrs)) return m;
    altN++;
    return `<img${attrs} alt="${a.business_name} — aesthetic treatment in ${city} (${altN})">`;
  });

  // service-area line so target keyword phrases exist in body copy
  if (kws.length && !kws.every(k => html.toLowerCase().includes(k.toLowerCase()))) {
    const strip = `<p style="text-align:center;font-size:12px;opacity:.65;padding:14px 20px 26px;margin:0">Serving ${city}: ${kws.map(k => k.replace(/\b\w/g, c => c.toUpperCase())).join(" · ")}</p>`;
    html = /<\/footer>/i.test(html) ? html.replace(/<\/footer>/i, strip + "</footer>") : html.replace(/<\/body>/i, strip + "\n</body>");
  }
  return html;
}

// ------------------------------------------------------------ Client deliverables (brand guide + SEO report)
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function delimHead(title, brand) {
  const hf = brand.headingFont || "Playfair Display", bf = brand.bodyFont || "Inter";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(hf)}:wght@400;600;700&family=${encodeURIComponent(bf)}:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
   :root{--p:${brand.primary || "#E8DCC4"};--s:${brand.secondary || "#2C2C2C"};--a:${brand.accent || brand.primary || "#B49A6A"};--ink:#20242b;--mut:#6b7280;--line:#e7e5e0;--bg:#faf9f6}
   *{box-sizing:border-box}body{margin:0;font-family:'${bf}',system-ui,sans-serif;color:var(--ink);background:var(--bg);line-height:1.65}
   .wrap{max-width:1000px;margin:0 auto;padding:0 28px}
   h1,h2,h3{font-family:'${hf}',Georgia,serif;font-weight:600;letter-spacing:-.01em;margin:0}
   .hero{background:var(--s);color:#fff;padding:90px 0 70px;text-align:center}
   .hero .kick{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--p);margin-bottom:16px}
   .hero h1{font-size:52px;line-height:1.05}.hero p{max-width:60ch;margin:16px auto 0;opacity:.82;font-size:16px}
   section{padding:56px 0;border-bottom:1px solid var(--line)}
   .ey{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--a);font-weight:600;margin-bottom:6px}
   section>.wrap>h2{font-size:30px;margin-bottom:20px}
   .lead{color:var(--mut);max-width:70ch;font-size:16px}
   .sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-top:22px}
   .swatch{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
   .swatch .c{height:110px}.swatch .m{padding:12px 14px}.swatch .m b{display:block;font-size:14px}.swatch .m span{font-size:12px;color:var(--mut);font-family:ui-monospace,monospace}
   .type-row{padding:18px 0;border-bottom:1px dashed var(--line)}
   .grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
   .card{border:1px solid var(--line);border-radius:14px;padding:22px;background:#fff}
   .pill{display:inline-block;padding:8px 18px;border-radius:999px;font-weight:600;font-size:13px}
   ul{margin:8px 0 0;padding-left:20px}li{margin:5px 0;color:var(--mut)}
   .foot{padding:40px 0;text-align:center;color:var(--mut);font-size:13px}
   .logo-box{display:flex;gap:20px;flex-wrap:wrap;margin-top:20px}
   .logo-tile{flex:1;min-width:220px;border:1px solid var(--line);border-radius:12px;padding:34px;display:grid;place-items:center;font-family:'${hf}',serif;font-size:24px;font-weight:700}
  </style></head><body>`;
}
async function brandGuideHtml(brand, a) {
  const city = (a.location || "").split(",").slice(-2).join(",").trim();
  let c = {};
  try {
    const t = await geminiCall([{ text:
      `Write brand-guideline copy for "${a.business_name}", a ${a.brand_aesthetic || "luxury"} medical-aesthetics practice in ${city}. Audience: ${a.ideal_patient || "premium clients"}. Return ONLY JSON: {"tagline":"short brand tagline","story":"2-3 sentence brand story","voice":["4 voice/tone adjectives"],"colorUse":{"primary":"how/where to use","secondary":"...","accent":"..."},"typographyNote":"1-2 sentences on the type system","iconStyle":"1 sentence","imageryStyle":"1-2 sentences on photography style","rationale":"2-3 sentence design rationale for the client"}` }],
      { temperature: 0.6, maxOutputTokens: 1200 });
    c = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
  } catch (e) { c = {}; }
  const sw = (name, hex, use) => `<div class="swatch"><div class="c" style="background:${hex}"></div><div class="m"><b>${name}</b><span>${hex}</span>${use ? `<div style="font-size:12px;color:var(--mut);margin-top:6px">${esc(use)}</div>` : ""}</div></div>`;
  const H = brand.headingFont || "Playfair Display", B = brand.bodyFont || "Inter";
  return delimHead(`${a.business_name} — Brand Guidelines`, brand) + `
  <div class="hero"><div class="wrap"><div class="kick">Brand Guidelines</div><h1>${esc(a.business_name)}</h1><p>${esc(c.tagline || a.hero_subheadline || "")}</p></div></div>
  <section><div class="wrap"><div class="ey">Brand Story</div><h2>Who we are</h2><p class="lead">${esc(c.story || a.why_patients_choose || "")}</p>
    <div style="margin-top:16px">${(c.voice || (a.brand_aesthetic || "").split(" ")).map(v => `<span class="pill" style="background:var(--p);color:var(--s);margin-right:8px">${esc(v)}</span>`).join("")}</div></div></section>
  <section><div class="wrap"><div class="ey">Logo</div><h2>Logo usage</h2>
    <div class="logo-box">
      <div class="logo-tile" style="background:#fff;color:var(--s)">${a.logo_file ? `<img src="${esc(a.logo_file)}" alt="logo" style="max-height:60px;max-width:180px">` : esc(a.business_name)}</div>
      <div class="logo-tile" style="background:var(--s);color:#fff">${esc(a.business_name.split(" ")[0])}</div>
      <div class="logo-tile" style="background:var(--p);color:var(--s)">${esc(a.business_name.split(" ")[0])}</div>
    </div><p class="lead" style="margin-top:14px">Maintain clear space around the mark. Use the dark or light variant depending on background contrast. Do not stretch, recolor outside the palette, or add effects.</p></div></section>
  <section><div class="wrap"><div class="ey">Color</div><h2>Color palette</h2>
    <div class="sw">${sw("Primary", brand.primary, c.colorUse && c.colorUse.primary)}${sw("Secondary", brand.secondary, c.colorUse && c.colorUse.secondary)}${sw("Accent", brand.accent || brand.primary, c.colorUse && c.colorUse.accent)}${sw("Surface", "#FAF9F6", "Backgrounds")}${sw("Ink", "#20242B", "Body text")}</div></div></section>
  <section><div class="wrap"><div class="ey">Typography</div><h2>Type system</h2><p class="lead">${esc(c.typographyNote || "")}</p>
    <div style="margin-top:18px">
      <div class="type-row"><div style="font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">Display · ${esc(H)}</div><div style="font-family:'${H}',serif;font-size:44px;font-weight:600">Refined by science.</div></div>
      <div class="type-row"><div style="font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">Heading · ${esc(H)}</div><div style="font-family:'${H}',serif;font-size:28px">Aesthetic medicine, elevated</div></div>
      <div class="type-row"><div style="font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">Body · ${esc(B)}</div><div style="font-family:'${B}',sans-serif;font-size:16px;color:var(--mut)">The quick brown fox jumps over the lazy dog. Physician-led care with an unhurried, warm experience.</div></div>
    </div></div></section>
  <section><div class="wrap"><div class="grid2">
    <div class="card"><div class="ey">Iconography</div><h3 style="margin:4px 0 8px">Icon style</h3><p style="color:var(--mut);margin:0">${esc(c.iconStyle || "Thin-line, minimal icons with rounded terminals; used sparingly for emphasis.")}</p></div>
    <div class="card"><div class="ey">Photography</div><h3 style="margin:4px 0 8px">Imagery</h3><p style="color:var(--mut);margin:0">${esc(c.imageryStyle || "Warm, cinematic photography of treatments, clinicians and interiors under subtle gradient overlays.")}</p></div>
  </div></div></section>
  <section><div class="wrap"><div class="ey">Components</div><h2>Buttons</h2>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px">
      <span class="pill" style="background:var(--s);color:#fff;padding:13px 26px">${esc(a.primary_cta || "Book a consultation")}</span>
      <span class="pill" style="background:var(--p);color:var(--s);padding:13px 26px">${esc(a.primary_cta || "Book a consultation")}</span>
      <span class="pill" style="background:transparent;color:var(--s);border:1px solid var(--s);padding:12px 25px">Explore treatments</span>
    </div></div></section>
  <section><div class="wrap"><div class="ey">Rationale</div><h2>Why this direction</h2><p class="lead">${esc(c.rationale || "")}</p></div></section>
  <div class="foot">Brand guidelines for ${esc(a.business_name)} · generated by Growth99</div></body></html>`;
}
function seoReportData(dirName) {
  const cand = ["home", "services", "about", "contact"];
  const useDir = dirName || (fs.existsSync(path.join(GEN, "site", "index.html")) ? "site" : null);
  const dir = useDir && fs.existsSync(path.join(GEN, useDir, "index.html")) ? useDir : null;
  const pages = [];
  const files = dir ? [["Home", "index"], ["Services", "services"], ["About", "about"], ["Contact", "contact"]] : cand.map(k => [k, k]);
  for (const [name, key] of files) {
    const f = dir ? path.join(GEN, dir, key + ".html") : path.join(GEN, key + ".html");
    if (!fs.existsSync(f)) continue;
    const html = fs.readFileSync(f, "utf8");
    const a = audit(html, []);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const metaTag = (html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i) || [""])[0];
    const meta = (metaTag.match(/content=["']([^"']*)["']/i) || [])[1] || "";
    pages.push({ name, title: title.trim(), meta: meta.trim(), score: a.overall, h1: a.facts.h1, jsonld: a.facts.jsonld, alt: a.facts.imagesWithAlt + "/" + a.facts.images });
  }
  return pages;
}
async function seoReportHtml(brand, a, dirName) {
  const pages = seoReportData(dirName);
  const overall = pages.length ? Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length) : 0;
  const kws = a.seo_keywords || [];
  let c = {};
  try {
    const t = await geminiCall([{ text: `Write an SEO report explanation for "${a.business_name}" (medspa in ${a.location}), target keywords: ${kws.join(", ")}. Return ONLY JSON: {"summary":"2-3 sentence overview of SEO work done","technicalRecs":["5 technical SEO recommendations"],"contentOptimization":"2-3 sentences","explanation":"2-3 sentences explaining the AI SEO work in client-friendly language"}` }], { temperature: 0.5, maxOutputTokens: 1200 });
    c = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
  } catch (e) { c = {}; }
  const row = (p) => `<tr><td style="font-weight:600">${esc(p.name)}</td><td>${esc(p.title || "—")}</td><td style="color:var(--mut)">${esc((p.meta || "—").slice(0, 90))}</td><td>${p.jsonld ? "✓" : "—"}</td><td>${esc(p.alt)}</td><td style="font-weight:700;color:${p.score >= 80 ? "#2e7d5b" : p.score >= 65 ? "#a9760f" : "#be382b"}">${p.score}</td></tr>`;
  return delimHead(`${a.business_name} — SEO Report`, brand) + `
  <div class="hero"><div class="wrap"><div class="kick">SEO Report</div><h1>${esc(a.business_name)}</h1><p>Search-optimization summary for the new site — keywords, on-page SEO, schema, and technical health.</p>
    <div style="margin-top:26px;display:inline-grid;place-items:center;width:150px;height:150px;border-radius:50%;background:conic-gradient(var(--p) ${overall * 3.6}deg,rgba(255,255,255,.15) 0)"><div style="width:118px;height:118px;border-radius:50%;background:var(--s);display:grid;place-items:center"><div><div style="font-size:40px;font-weight:700;font-family:'${brand.headingFont || "Playfair Display"}',serif">${overall}</div><div style="font-size:11px;opacity:.7">/ 100 SEO</div></div></div></div></div></div>
  <section><div class="wrap"><div class="ey">Overview</div><h2>What we optimized</h2><p class="lead">${esc(c.summary || "")}</p></div></section>
  <section><div class="wrap"><div class="ey">Keywords</div><h2>Target keywords</h2>
    <div style="margin-top:14px">${kws.map(k => `<span class="pill" style="background:var(--p);color:var(--s);margin:0 8px 8px 0">${esc(k)}</span>`).join("")}</div></div></section>
  <section><div class="wrap"><div class="ey">On-page</div><h2>Meta titles &amp; descriptions</h2>
    <div style="overflow-x:auto;margin-top:14px"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;border-bottom:2px solid var(--line)"><th style="padding:8px">Page</th><th style="padding:8px">Title</th><th style="padding:8px">Meta description</th><th style="padding:8px">Schema</th><th style="padding:8px">Img alt</th><th style="padding:8px">Score</th></tr></thead>
      <tbody>${pages.map(row).join("")}</tbody></table></div></div></section>
  <section><div class="wrap"><div class="ey">Schema</div><h2>Structured data</h2><p class="lead">JSON-LD <b>MedicalBusiness</b> schema (name, address, phone, hours, geo) is embedded on every page for rich results and local SEO.</p></div></section>
  <section><div class="wrap"><div class="grid2">
    <div class="card"><div class="ey">Technical SEO</div><h3 style="margin:4px 0 10px">Recommendations</h3><ul>${(c.technicalRecs || ["Compress hero images to WebP", "Add canonical tags", "Enable sitemap.xml", "Optimize Core Web Vitals", "Add internal links between services"]).map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>
    <div class="card"><div class="ey">Content</div><h3 style="margin:4px 0 10px">Content optimization</h3><p style="color:var(--mut);margin:0">${esc(c.contentOptimization || "")}</p></div>
  </div></div></section>
  <section><div class="wrap"><div class="ey">Summary</div><h2>AI SEO work explained</h2><p class="lead">${esc(c.explanation || "")}</p></div></section>
  <div class="foot">SEO report for ${esc(a.business_name)} · generated by Growth99</div></body></html>`;
}

// ------------------------------------------------------------ CRO audit
// Agency-style conversion audit across 4 disciplines (ported from g99-web-audit
// MasterDesignAgent). Works on a live URL (adds a screenshot for vision) or on
// raw HTML (beta site, not hosted). Same rubric both ways → fair before/after.
const CRO_WEIGHTS = { vision: 0.2, ux: 0.3, cro: 0.35, content: 0.15 };
async function croScreenshot(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);   // don't let microlink hang the audit
  try {
    const api = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
    const r = await fetch(api, { signal: ctl.signal }); if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("image")) return null;            // error/redirect, not an image
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 1000 ? buf.toString("base64") : null;
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}
async function croAudit(src) {
  let html = src.html || "", shotB64 = null, label = src.label || src.url || "page";
  if (src.url) {
    try { html = await (await fetch(src.url)).text(); } catch (e) {}
    shotB64 = await croScreenshot(src.url);
  }
  const prompt = [
    `You are an elite, agency-level Design, UX & CRO team writing a high-end $10,000 conversion-rate-optimization (CRO) audit of a LUXURY MEDICAL-AESTHETICS / MEDSPA website: ${label}.`,
    shotB64 ? `A screenshot of the page is attached; also consider the HTML below.` : `Analyze the page from its HTML below.`,
    `Be EXTREMELY detailed and specific — a senior consultant, not generic tips. Evaluate FOUR disciplines:`,
    `- vision  = Visual design & UI (hierarchy, spacing, typography, colour, imagery, brand polish)`,
    `- ux      = UX & usability (navigation, flow, clarity, mobile, friction)`,
    `- cro     = CRO & sales (CTAs, trust signals, social proof, offers, lead capture, conversion path)`,
    `- content = Content & copy (messaging, value proposition, persuasion, scannability)`,
    `Return ONLY valid JSON, no markdown. Each discipline object MUST have:`,
    `{"score":0-100,"severity":"low|medium|high|critical",`,
    `"observations":["3-5 detailed multi-sentence findings"],`,
    `"issues":["4-6 concrete problems, each with WHY it hurts conversion"],`,
    `"recommendations":["4-6 step-by-step actionable fixes"],`,
    `"checks":[{"label":"specific check","status":"pass|fail","note":"short"} ... 6-8 checks]}`,
    `Top object: {"vision":{...},"ux":{...},"cro":{...},"content":{...},`,
    `"summary":{"strengths":["3"],"weaknesses":["3"],"topRecommendations":["5 highest-impact, ranked"]}}`,
    `HTML:\n` + html.replace(/<script[\s\S]*?<\/script>/gi, " ").slice(0, 16000),
  ].join("\n");
  const parts = [{ text: prompt }];
  if (shotB64) parts.push({ inline_data: { mime_type: "image/png", data: shotB64 } });
  let obj;
  try {
    const t = await geminiCall(parts, { temperature: 0.4, maxOutputTokens: 8000 });
    obj = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
  } catch (e) { throw new Error("CRO audit failed: " + e.message); }
  const cats = ["vision", "ux", "cro", "content"];
  cats.forEach(c => { obj[c] = obj[c] || { score: 0, issues: [], recommendations: [], observations: [], checks: [] }; });
  const overall = Math.round(cats.reduce((s, c) => s + (Number(obj[c].score) || 0) * CRO_WEIGHTS[c], 0));
  return { label, overall, hadScreenshot: !!shotB64, vision: obj.vision, ux: obj.ux, cro: obj.cro, content: obj.content, summary: obj.summary || {} };
}
// Average several CRO reports into one (whole-site scoring).
function croAverage(reports, label) {
  const cats = ["vision", "ux", "cro", "content"];
  const avg = { label, overall: Math.round(reports.reduce((s, r) => s + r.overall, 0) / reports.length), hadScreenshot: reports.some(r => r.hadScreenshot), pages: reports.length };
  cats.forEach(c => {
    avg[c] = {
      score: Math.round(reports.reduce((s, r) => s + (r[c].score || 0), 0) / reports.length),
      observations: [], issues: [], recommendations: [], checks: [],
    };
    // merge unique issues/recs/observations across pages
    ["observations", "issues", "recommendations"].forEach(k => {
      const seen = new Set();
      reports.forEach(r => (r[c][k] || []).forEach(x => { const key = String(x).slice(0, 60); if (!seen.has(key)) { seen.add(key); avg[c][k].push(x); } }));
      avg[c][k] = avg[c][k].slice(0, 6);
    });
    reports.forEach(r => (r[c].checks || []).forEach(ch => avg[c].checks.push(ch)));
    avg[c].checks = avg[c].checks.slice(0, 8);
  });
  const strengths = new Set(), weaknesses = new Set(), recs = new Set();
  reports.forEach(r => { (r.summary?.strengths || []).forEach(x => strengths.add(x)); (r.summary?.weaknesses || []).forEach(x => weaknesses.add(x)); (r.summary?.topRecommendations || []).forEach(x => recs.add(x)); });
  avg.summary = { strengths: [...strengths].slice(0, 4), weaknesses: [...weaknesses].slice(0, 4), topRecommendations: [...recs].slice(0, 6) };
  return avg;
}

// ---------------------------------------------------------------- SEO audit
function audit(html, kw) {
  const lc = html.toLowerCase();
  const find = (re) => (html.match(re) || []);
  const title = (find(/<title[^>]*>([\s\S]*?)<\/title>/i)[1] || "").trim();
  // attribute order varies (<meta content=... name=...>): find the tag first, then read content
  const metaTag = (html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i) || [""])[0];
  const metaDesc = ((metaTag.match(/content=["']([^"']*)["']/i) || [])[1] || "").trim();
  const h1 = find(/<h1[\s>]/gi).length;
  const h2 = find(/<h2[\s>]/gi).length;
  const imgs = find(/<img\b[^>]*>/gi);
  const imgsAlt = imgs.filter(t => /\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const words = (text.match(/\b[a-z]{2,}\b/gi) || []).length;
  const hasViewport = /name=["']viewport["']/i.test(html);
  const hasLang = /<html[^>]+lang=/i.test(html);
  const hasCanonical = /rel=["']canonical["']/i.test(html);
  const jsonld = /application\/ld\+json/i.test(html);
  const localBiz = /"@type"\s*:\s*"(LocalBusiness|MedicalBusiness|HealthAndBeautyBusiness|Dentist|MedicalClinic)"/i.test(html);
  const extScripts = find(/<script[^>]+src=["']https?:\/\/[^"']+/gi).length;
  const extCss = find(/<link[^>]+href=["']https?:\/\/[^"']+\.css/gi).length + (/(cdn\.tailwindcss\.com)/i.test(html) ? 1 : 0);
  const cdnTailwind = /cdn\.tailwindcss\.com/i.test(html);
  const phone = /\(\d{3}\)\s*\d{3}-\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}/.test(html);
  const kws = (kw || []).map(k => k.toLowerCase());
  const kwInTitle = kws.filter(k => title.toLowerCase().includes(k.split(" ")[0])).length;
  const kwInBody = kws.filter(k => lc.includes(k)).length;

  const bytes = Buffer.byteLength(html, "utf8");
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const cats = {
    "On-page SEO": clamp(
      (title ? 25 : 0) + (title.length >= 30 && title.length <= 65 ? 10 : 0) +
      (metaDesc ? 22 : 0) + (metaDesc.length >= 110 && metaDesc.length <= 165 ? 8 : 0) +
      (h1 === 1 ? 15 : h1 > 1 ? 6 : 0) + (h2 >= 2 ? 10 : 0) + (kwInTitle ? 10 : 0)),
    "Technical SEO": clamp(
      (hasViewport ? 20 : 0) + (hasLang ? 15 : 0) + (hasCanonical ? 20 : 0) +
      (jsonld ? 25 : 0) + (extScripts <= 2 ? 20 : extScripts <= 4 ? 10 : 0)),
    "Content quality": clamp(
      (words >= 500 ? 45 : words >= 300 ? 32 : words >= 120 ? 18 : 6) +
      (h2 >= 2 ? 20 : 8) + (kwInBody / Math.max(1, kws.length) * 35)),
    "Accessibility": clamp(
      (imgs.length === 0 ? 45 : (imgsAlt / imgs.length) * 45) + (hasLang ? 25 : 0) +
      (hasViewport ? 15 : 0) + 15),
    "Local SEO": clamp(
      (phone ? 25 : 0) + (localBiz ? 35 : 0) + (lc.includes("scottsdale") ? 25 : 0) + (kwInBody ? 15 : 0)),
    "Performance": clamp(Math.min(cdnTailwind ? 62 : 100,
      (cdnTailwind ? 38 : 74) + (bytes < 40000 ? 20 : bytes < 80000 ? 12 : 4) +
      (extScripts <= 1 ? 16 : extScripts <= 3 ? 8 : 0) + (extCss <= 1 ? 10 : 0))),
  };
  const weights = { "On-page SEO": .22, "Technical SEO": .18, "Content quality": .18, "Accessibility": .14, "Local SEO": .14, "Performance": .14 };
  const overall = Math.round(Object.entries(cats).reduce((s, [k, v]) => s + v * weights[k], 0));

  const issues = [];
  if (cdnTailwind) issues.push({ sev: "crit", title: "Runtime Tailwind CDN in production", desc: "Page depends on cdn.tailwindcss.com at runtime — compile Tailwind to a static CSS file and self-host.", fix: "Build CSS" });
  if (!metaDesc) issues.push({ sev: "warn", title: "Missing meta description", desc: "No <meta name=description> — search snippets will be auto-generated.", fix: "Generate" });
  else if (metaDesc.length < 110 || metaDesc.length > 165) issues.push({ sev: "warn", title: "Meta description length", desc: `Description is ${metaDesc.length} chars — aim for 120–160.`, fix: "Rewrite" });
  if (!localBiz) issues.push({ sev: "warn", title: "No LocalBusiness schema", desc: "Add JSON-LD LocalBusiness with NAP + hours for local ranking.", fix: "Add" });
  if (imgs.length && imgsAlt < imgs.length) issues.push({ sev: "warn", title: "Images missing alt text", desc: `${imgs.length - imgsAlt} of ${imgs.length} images have no alt attribute.`, fix: "Generate" });
  if (h1 !== 1) issues.push({ sev: "warn", title: h1 === 0 ? "No H1 heading" : "Multiple H1 headings", desc: `Found ${h1} <h1> — pages should have exactly one.`, fix: "Fix headings" });
  if (!hasCanonical) issues.push({ sev: "info", title: "No canonical URL", desc: "Add <link rel=canonical> to avoid duplicate-content dilution.", fix: "Add" });
  if (kwInBody < kws.length) issues.push({ sev: "info", title: "Target keywords under-used", desc: `${kwInBody}/${kws.length} target keywords appear in the copy.`, fix: "Suggest" });

  return {
    overall, cats,
    facts: { title, titleLen: title.length, metaDesc, metaLen: metaDesc.length, h1, h2, images: imgs.length, imagesWithAlt: imgsAlt, words, bytes, jsonld, localBiz, extScripts, cdnTailwind, phone, keywordsMatched: kwInBody, keywordsTotal: kws.length },
    issues,
  };
}

// ---------------------------------------------------------------- HTTP
function send(res, code, type, body) { res.writeHead(code, { "Content-Type": type }); res.end(body); }
function json(res, code, obj) { send(res, code, "application/json", JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); }); }
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const p = u.pathname;

    // ---- auth gate: active only when ADMIN_PASSWORD is set (i.e. deployed).
    // Every /api/* call must carry the password (header set by the frontend).
    // /api/auth-check itself is exempt only for health checks WITHOUT a key;
    // with a key present it validates it (the frontend uses this to log in).
    const ADMIN = process.env.ADMIN_PASSWORD || "";
    if (p === "/api/auth-check") {
      const supplied = req.headers["x-admin-key"] || "";
      if (ADMIN && supplied && supplied !== ADMIN) return json(res, 401, { error: "unauthorized" });
      if (ADMIN && !supplied && req.headers["x-login"] === "1") return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { ok: true, gated: !!ADMIN });
    }
    if (ADMIN && p.startsWith("/api/") && (req.headers["x-admin-key"] || "") !== ADMIN) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (p === "/" || p === "/index.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "index.html")));
    if (p === "/app.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "app.js")));
    if (p === "/styles.css") return send(res, 200, "text/css", fs.readFileSync(path.join(DIR, "public", "styles.css")));
    if (p === "/dashboard" || p === "/dashboard.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "dashboard.html")));
    if (p === "/dashboard.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "dashboard.js")));

    if (p === "/api/onboarding" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const file = path.join(DIR, "onboarding.json");
      const cur = JSON.parse(fs.readFileSync(file, "utf8"));
      if (body.answers && typeof body.answers === "object") cur.answers = { ...cur.answers, ...body.answers };
      if (typeof body.existingWebsite === "string") cur.existingWebsite = body.existingWebsite;
      if (typeof body.referenceWebsite === "string") cur.referenceWebsite = body.referenceWebsite;
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
      return json(res, 200, { ok: true, answers: cur.answers });
    }
    if (p === "/api/onboarding") return send(res, 200, "application/json", fs.readFileSync(path.join(DIR, "onboarding.json")));

    // Live per-page generation progress for the dashboard (poll ~2s during step 3).
    if (p === "/api/generate-progress") return json(res, 200, GEN_PROGRESS);

    if (p === "/api/generate" && req.method === "POST") {
      const { prompt, deviceType, page } = JSON.parse(await readBody(req) || "{}");
      if (!prompt || !prompt.trim()) return json(res, 400, { error: "prompt required" });
      const key = (page || "home").replace(/[^a-z0-9_-]/gi, "");
      let fullPrompt = prompt.trim();
      if (key !== "home") {
        fullPrompt += `\n\nConsistency: this page belongs to the SAME website as the pages already generated in this project. Reuse the exact same fonts, color palette, navigation and footer design as the previous screens — do not introduce a new theme.`;
      }
      const t0 = Date.now();
      const out = await generate(fullPrompt, deviceType);
      if (out.html) out.html = seoEnhance(out.html, key);
      if (out.html) fs.writeFileSync(path.join(GEN, key + ".html"), out.html);
      return json(res, 200, {
        page: key, projectId: out.projectId, screenId: out.screenId,
        htmlBytes: out.html.length, screenshotUrl: out.screenshotUrl,
        previewUrl: out.html ? `/preview/${key}` : "", exportUrl: out.html ? `/export/${key}` : "",
        seconds: ((Date.now() - t0) / 1000).toFixed(1),
      });
    }

    if (p === "/api/generate-gemini" && req.method === "POST") {
      const { prompt, page } = JSON.parse(await readBody(req) || "{}");
      if (!prompt || !prompt.trim()) return json(res, 400, { error: "prompt required" });
      const key = ((page || "home").replace(/[^a-z0-9_-]/gi, "")) + "-gemini";
      let fullPrompt = prompt.trim();
      // Theme consistency: home establishes the design; every other page gets a
      // strict contract carrying home's actual head (fonts/palette) + nav + footer.
      if (!key.startsWith("home")) {
        const homeF = path.join(GEN, "home-gemini.html");
        if (fs.existsSync(homeF)) {
          const home = fs.readFileSync(homeF, "utf8");
          const head = ((home.match(/<head[\s\S]*?<\/head>/i) || [""])[0]).slice(0, 7000);
          const nav = (extractBlock(home, "nav") || extractBlock(home, "header") || "").slice(0, 5000);
          const footer = (extractBlock(home, "footer") || "").slice(0, 5000);
          fullPrompt += `\n\nSTRICT DESIGN CONTRACT — this page belongs to an EXISTING website. It must be visually identical in theme to the homepage:\n` +
            `1) Reuse this exact <head> (same fonts, colors, tailwind config, css variables) changing only title/meta text:\n${head}\n` +
            (nav ? `2) Reproduce this exact navigation markup:\n${nav}\n` : "") +
            (footer ? `3) Reproduce this exact footer markup:\n${footer}\n` : "") +
            `Do NOT invent a new palette, new fonts, or a different nav/footer.`;
        }
      }
      const t0 = Date.now();
      let html = await geminiGenerate(fullPrompt);
      html = seoEnhance(html, key);
      fs.writeFileSync(path.join(GEN, key + ".html"), html);
      return json(res, 200, {
        page: key, engine: "gemini", htmlBytes: html.length, screenshotUrl: "",
        previewUrl: `/preview/${key}`, exportUrl: `/export/${key}`,
        seconds: ((Date.now() - t0) / 1000).toFixed(1),
      });
    }

    if (p === "/api/analyze-site" && req.method === "POST") {
      const { url } = JSON.parse(await readBody(req) || "{}");
      if (!url) return json(res, 400, { error: "url required" });
      const analysis = await analyzeExistingSite(url);
      analysis.matchBrief = matchBriefFrom(analysis);
      return json(res, 200, analysis);
    }

    // AI-composed brand system + website design brief (Gemini). Uses onboarding
    // + CRO findings + existing-site colors (refined). Drives the Stitch prompt.
    if (p === "/api/compose-brand" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const onb = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8"));
      const a = onb.answers;
      const siteUrl = onb.existingWebsite || a.existingWebsite || "";

      // 1) Existing-site brand theme — reuse passed analysis, else cache, else scan.
      let analysis = body.analysis || null;
      if (!analysis) { try { analysis = JSON.parse(fs.readFileSync(path.join(GEN, ".site-analysis.json"), "utf8")); } catch (e) {} }
      if (!analysis && siteUrl) {
        try { analysis = await analyzeExistingSite(siteUrl); fs.writeFileSync(path.join(GEN, ".site-analysis.json"), JSON.stringify(analysis, null, 2)); }
        catch (e) { console.warn("compose: site analysis failed:", e.message.slice(0, 120)); }
      }

      // 2) Full CRO report (per-discipline issues, not just top recs).
      let cro = null; try { cro = JSON.parse(fs.readFileSync(path.join(GEN, ".cro-existing.json"), "utf8")); } catch (e) {}

      // 3) Assemble ALL context for Gemini.
      const list = (v) => Array.isArray(v) ? v.map(x => (x && typeof x === "object") ? [x.name, x.title].filter(Boolean).join(" — ") : x).join(", ") : (v || "");
      const onboardingBlock = [
        `Business: ${a.business_name} — ${a.location}.`,
        a.business_description ? `About: ${a.business_description}` : "",
        a.why_patients_choose ? `Why patients choose them: ${a.why_patients_choose}` : "",
        a.ideal_patient ? `Ideal patient: ${a.ideal_patient}` : "",
        `Service categories: ${list(a.services_offered)}.`,
        `Featured / revenue treatments: ${list(a.revenue_services)}.`,
        a.team_roster ? `Providers: ${list(a.team_roster)}.` : "",
        a.financing_offered ? `Financing & memberships: ${list(a.financing_offered)}.` : "",
        a.booking_platform ? `Booking platform: ${a.booking_platform}.` : "",
        `Primary CTA: ${a.primary_cta}.`,
        a.featured_review ? `Featured review: ${a.featured_review}` : "",
        a.hero_headline ? `Client's headline idea: "${a.hero_headline}" / sub: "${a.hero_subheadline || ""}".` : "",
        `Desired brand aesthetic: ${a.brand_aesthetic || "Luxurious & Warm"}.`,
        (a.tone_clinical_warm || a.tone_lux_approachable) ? `Tone signals: clinical↔warm=${a.tone_clinical_warm || "?"}, lux↔approachable=${a.tone_lux_approachable || "?"}, bold↔understated=${a.tone_bold_understated || "?"}, playful↔serious=${a.tone_playful_serious || "?"}.` : "",
        a.seo_keywords ? `Target SEO keywords: ${list(a.seo_keywords)}.` : "",
      ].filter(Boolean).join("\n");

      const themeBlock = analysis ? [
        `EXISTING SITE BRAND THEME (extracted from ${siteUrl}) — keep the brand's DNA but elevate it:`,
        `- Colors: primary ${analysis.primaryColor}, secondary ${analysis.secondaryColor}, accent ${analysis.accentColor}, background ${analysis.backgroundColor}.`,
        `- Vibe: ${analysis.vibe}. Headings: ${analysis.headingFontStyle}. Body: ${analysis.bodyFontStyle}.`,
        `- Layout style: ${analysis.layoutStyle}. Imagery style: ${analysis.imageryStyle}.`,
        `- Mood: ${(analysis.mood || []).join(", ")}. Signature elements: ${(analysis.signatureElements || []).join("; ")}.`,
        `REFINE these colors into a clean, WCAG-accessible, premium palette (keep the brand feel, fix contrast/harmony).`,
      ].join("\n") : `No existing site to analyze — CHOOSE a clean, tasteful, on-brand palette and type system for this business.`;

      const croBlock = cro ? [
        `CURRENT SITE CRO AUDIT — overall ${cro.overall}/100 (vision ${cro.vision?.score}, ux ${cro.ux?.score}, cro ${cro.cro?.score}, content ${cro.content?.score}). The NEW site MUST fix these:`,
        ...["vision", "ux", "cro", "content"].flatMap(k => ((cro[k] && cro[k].issues) || []).slice(0, 3).map(i => `- [${k}] ${typeof i === "object" ? (i.issue || i.title || JSON.stringify(i)) : i}`)),
        ...((cro.summary && cro.summary.topRecommendations) || []).slice(0, 6).map(r => `- [priority] ${r}`),
      ].join("\n") : `No CRO audit available — apply conversion best practices (clear hero value prop, prominent CTAs, trust/social proof, fast scannable layout, mobile-first).`;

      const prompt = [
        `You are a senior brand & web-design director for luxury medical-aesthetics brands. Produce a COMPLETE brand system + detailed build brief for a NEW, high-converting website. Use ALL the context below — do not be generic or brief.`,
        `\n== BUSINESS & ONBOARDING ==\n${onboardingBlock}`,
        `\n== ${themeBlock}`,
        `\n== ${croBlock}`,
        `\n== IMAGERY DIRECTION (REQUIRED) ==\nSpecify a cohesive, HIGH-QUALITY photographic art direction: editorial, photorealistic medical-aesthetic photography — real clinic interiors, close-up treatment/skin/results shots, warm authentic provider & patient portraits. Describe subjects, lighting (soft natural / golden), color grade, and composition so every section has intentional, premium imagery. NO low-resolution, cartoonish, or generic clip-art stock. Images must reinforce trust and the luxury feel.`,
        `\n== OUTPUT ==\nReturn ONLY minified JSON with these keys:`,
        `{"primary":"#hex","secondary":"#hex","accent":"#hex","headingFont":"a Google serif display font name","bodyFont":"a clean Google sans font name","imageryDirection":"2-3 sentences of concrete photographic art direction","brief":"a DETAILED, multi-paragraph art-direction + build brief (250-400 words) written as concrete design directives: overall look & feel, layout sophistication and section rhythm, typographic system, color usage, component styling, the specific imagery to use per section, and the exact CRO fixes this new site must implement based on the audit above. Be specific, not vague."}`,
      ].join("\n");
      try {
        const t = await geminiCall([{ text: prompt }], { temperature: 0.6, maxOutputTokens: 4000 });
        const obj = JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
        // Fold imagery direction into the brief so downstream generation always sees it.
        if (obj.imageryDirection && obj.brief && !obj.brief.includes(obj.imageryDirection.slice(0, 30))) {
          obj.brief += `\n\nIMAGERY: ${obj.imageryDirection}`;
        }
        obj.usedAnalysis = !!analysis; obj.usedCro = !!cro;
        return json(res, 200, obj);
      } catch (e) { return json(res, 502, { error: "compose failed: " + e.message }); }
    }

    // Client deliverable: Brand Guidelines page
    if (p === "/api/brand-guide" && req.method === "POST") {
      const { theme } = JSON.parse(await readBody(req) || "{}");
      const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
      const brand = { primary: (theme && theme.primary) || "#E8DCC4", secondary: (theme && theme.secondary) || "#2C2C2C", accent: (theme && theme.accent) || "#B49A6A", headingFont: (theme && theme.headingFont) || "Playfair Display", bodyFont: (theme && theme.bodyFont) || "Inter" };
      const html = await brandGuideHtml(brand, a);
      fs.writeFileSync(path.join(GEN, "brand-guide.html"), html);
      return json(res, 200, { url: "/preview/brand-guide", exportUrl: "/export/brand-guide" });
    }
    // Client deliverable: SEO Report page
    if (p === "/api/seo-report" && req.method === "POST") {
      const { theme } = JSON.parse(await readBody(req) || "{}");
      const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
      if (!seoReportData().length) return json(res, 400, { error: "No generated pages — build & bind the site first." });
      const brand = { primary: (theme && theme.primary) || "#E8DCC4", secondary: (theme && theme.secondary) || "#2C2C2C", accent: (theme && theme.accent) || "#B49A6A", headingFont: (theme && theme.headingFont) || "Playfair Display", bodyFont: (theme && theme.bodyFont) || "Inter" };
      const html = await seoReportHtml(brand, a);
      fs.writeFileSync(path.join(GEN, "seo-report.html"), html);
      return json(res, 200, { url: "/preview/seo-report", exportUrl: "/export/seo-report" });
    }

    if (p === "/api/generate-site" && req.method === "POST") {
      const { engine, pages, deviceType, theme } = JSON.parse(await readBody(req) || "{}");
      if (!Array.isArray(pages) || !pages.length) return json(res, 400, { error: "pages[] required" });
      const t0 = Date.now();
      if (engine === "gemini") {
        const tokens = designTokensBlock(theme);
        const geminiOne = async (pg, contract) => {
          const key = pg.key.replace(/[^a-z0-9_-]/gi, "") + "-gemini";
          try {
            let html = await geminiGenerate(tokens + "\n\n" + pg.prompt + (contract || ""));
            html = seoEnhance(html, key);
            html = injectCanonicalNav(html, theme || {});
            fs.writeFileSync(path.join(GEN, key + ".html"), html);
            return { page: key, pageKey: pg.key, engine: "gemini", htmlBytes: html.length, previewUrl: `/preview/${key}`, exportUrl: `/export/${key}`, screenshotUrl: "" };
          } catch (e) { return { pageKey: pg.key, engine: "gemini", error: e.message }; }
        };
        // Consistent mode: build HOME first, then contract its exact head/nav/footer
        // into the remaining pages (which still run in parallel with each other).
        const home = pages.find(p => p.key === "home");
        let out;
        if (home) {
          const homeRes = await geminiOne(home);
          let contract = "";
          const homeFile = path.join(GEN, "home-gemini.html");
          if (fs.existsSync(homeFile)) {
            const h = fs.readFileSync(homeFile, "utf8");
            const head = ((h.match(/<head[\s\S]*?<\/head>/i) || [""])[0]).slice(0, 7000);
            const nav = (extractBlock(h, "nav") || extractBlock(h, "header") || "").slice(0, 5000);
            const footer = (extractBlock(h, "footer") || "").slice(0, 5000);
            contract = `\n\nSTRICT DESIGN CONTRACT — this page is part of an EXISTING website and must look visually identical to the homepage.\n` +
              `1) Reuse this EXACT <head> (same fonts, css, tailwind config, :root variables) — change only the <title>/meta text:\n${head}\n` +
              (nav ? `2) Reproduce this EXACT navigation markup and its classes:\n${nav}\n` : "") +
              (footer ? `3) Reproduce this EXACT footer markup and its classes:\n${footer}\n` : "") +
              `Do NOT invent a new palette, new fonts, a new brand name, or a different nav/footer.`;
          }
          const rest = pages.filter(p => p.key !== "home");
          const restOut = await Promise.all(rest.map(pg => geminiOne(pg, contract)));
          out = [homeRes, ...restOut];
        } else {
          out = await Promise.all(pages.map(pg => geminiOne(pg)));
        }
        return json(res, 200, { engine: "gemini", pages: out, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
      }
      // stitch: single project + design system + parallel screens
      const built = await buildStitchSite(pages.map(pg => ({ key: pg.key.replace(/[^a-z0-9_-]/gi, ""), prompt: pg.prompt + "\n\n" + designTokensBlock(theme) + STITCH_IMG_CLAUSE })), theme || {}, deviceType);
      const out = await Promise.all(built.results.map(async r => {
        if (!r.html) return { pageKey: r.key, engine: "stitch", error: r.error || "no HTML" };
        let html = sharpenStitchImages(r.html);
        html = await fixImages(html);                // replace broken/expiring image URLs with stable photos
        html = await qcStitchImages(html);          // swap any text-baked images for clean photos
        html = seoEnhance(html, r.key);
        html = injectCanonicalNav(html, theme || {});
        fs.writeFileSync(path.join(GEN, r.key + ".html"), html);
        genProg(r.key, "done", { bytes: html.length });
        return { page: r.key, pageKey: r.key, engine: "stitch", htmlBytes: html.length, previewUrl: `/preview/${r.key}`, exportUrl: `/export/${r.key}`, screenshotUrl: r.screenshotUrl || "" };
      }));
      GEN_PROGRESS.phase = "done";
      return json(res, 200, { engine: "stitch", projectId: built.projectId, designSystem: built.designSystem, pages: out, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    }

    if (p === "/api/stitch-pages") {
      const metaFile = path.join(GEN, ".stitch-metadata.json");
      let pages = [];
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        pages = Object.keys(meta.screens || {}).filter(k => fs.existsSync(path.join(GEN, k + ".html")))
          .map(k => ({ key: k, previewUrl: `/preview/${k}`, refinedExists: fs.existsSync(path.join(GEN, k + "-refined.html")) }));
      }
      return json(res, 200, { pages });
    }

    // CRO audit of the EXISTING site (URL). Caches findings to feed generation.
    if (p === "/api/cro-audit" && req.method === "POST") {
      const { url } = JSON.parse(await readBody(req) || "{}");
      if (!url) return json(res, 400, { error: "url required" });
      const rep = await croAudit({ url, label: url });
      fs.writeFileSync(path.join(GEN, ".cro-existing.json"), JSON.stringify(rep, null, 2));
      return json(res, 200, rep);
    }
    // CRO audit of the generated BETA site (not hosted). Audits EVERY bound page
    // and averages → whole-site before/after score.
    if (p === "/api/cro-audit-beta" && req.method === "POST") {
      const { engine } = JSON.parse(await readBody(req) || "{}");
      const dir = engine === "gemini" ? "site-gemini" : "site";
      const siteDir = path.join(GEN, dir);
      let files = [];
      if (fs.existsSync(siteDir)) files = ["index", "services", "about", "contact"].map(k => path.join(siteDir, k + ".html")).filter(f => fs.existsSync(f));
      if (!files.length && fs.existsSync(path.join(GEN, "home.html"))) files = ["home", "services", "about", "contact"].map(k => path.join(GEN, k + ".html")).filter(f => fs.existsSync(f));
      if (!files.length) return json(res, 400, { error: "No beta site yet — generate & bind first." });
      const reports = [];
      for (const f of files) { reports.push(await croAudit({ html: fs.readFileSync(f, "utf8"), label: path.basename(f) })); await sleep(800); }
      const avg = croAverage(reports, `Beta site (${reports.length} pages avg)`);
      fs.writeFileSync(path.join(GEN, ".cro-beta.json"), JSON.stringify(avg, null, 2));
      return json(res, 200, avg);
    }

    // Step 6: CRO of the LIVE pushed URL, stored as the "after" result. Kept in
    // a separate cache (.cro-beta.json) so it never clobbers the "before" audit.
    if (p === "/api/cro-audit-url" && req.method === "POST") {
      const { url } = JSON.parse(await readBody(req) || "{}");
      if (!url) return json(res, 400, { error: "url required" });
      const rep = await croAudit({ url, label: url });
      fs.writeFileSync(path.join(GEN, ".cro-beta.json"), JSON.stringify(rep, null, 2));
      return json(res, 200, rep);
    }

    // Whole-site QA audit: critique every Stitch page, cache comments for refine.
    if (p === "/api/qa-audit" && req.method === "POST") {
      const { keys } = stitchPageKeys();
      if (!keys.length) return json(res, 400, { error: "No Stitch pages — generate the site with Stitch first." });
      // sequential (not parallel) so free-tier Gemini RPM isn't tripped
      const results = [];
      for (const k of keys) {
        const a = await auditPage(fs.readFileSync(path.join(GEN, k + ".html"), "utf8"));
        results.push({ key: k, comments: a.comments, source: a.source });
        await sleep(1500);
      }
      const cache = {}; results.forEach(r => cache[r.key] = r.comments);
      fs.writeFileSync(path.join(GEN, ".qa-audit.json"), JSON.stringify(cache, null, 2));
      return json(res, 200, { pages: results });
    }

    // Whole-site refine: apply each page's cached QA comments via Stitch (parallel).
    if (p === "/api/qa-refine" && req.method === "POST") {
      const { theme } = JSON.parse(await readBody(req) || "{}");
      const { projectId, screens, keys } = stitchPageKeys();
      if (!keys.length) return json(res, 400, { error: "No Stitch pages to refine." });
      const cacheFile = path.join(GEN, ".qa-audit.json");
      const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
      const t0 = Date.now();
      const results = await Promise.all(keys.map(async k => {
        const comments = cache[k] && cache[k].length ? cache[k] : heuristicAudit(fs.readFileSync(path.join(GEN, k + ".html"), "utf8"));
        try {
          const out = await stitchRefine(projectId, screens[k], comments, "DESKTOP");
          const rkey = k + "-refined";
          if (out.html) {
            let h = sharpenStitchImages(out.html); h = await fixImages(h); h = await qcStitchImages(h); h = seoEnhance(h, rkey); h = injectCanonicalNav(h, theme || {});
            fs.writeFileSync(path.join(GEN, rkey + ".html"), h);
            return { key: k, refinedPreviewUrl: `/preview/${rkey}`, refinedExportUrl: `/export/${rkey}` };
          }
          return { key: k, error: "no HTML" };
        } catch (e) { return { key: k, error: e.message }; }
      }));
      return json(res, 200, { pages: results, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    }

    // Whole-site SEO: audit every generated page, return per-page + averaged aggregate.
    if (p === "/api/seo-site" && req.method === "POST") {
      const { keywords } = JSON.parse(await readBody(req) || "{}");
      const cand = ["home", "services", "about", "contact"];
      const pages = [];
      for (const k of cand) {
        const f = path.join(GEN, k + ".html");
        if (fs.existsSync(f)) { const a = audit(fs.readFileSync(f, "utf8"), keywords || []); pages.push({ key: k, overall: a.overall, cats: a.cats, issues: a.issues }); }
      }
      if (!pages.length) return json(res, 400, { error: "No generated pages to audit." });
      const catNames = Object.keys(pages[0].cats);
      const cats = {}; catNames.forEach(c => cats[c] = Math.round(pages.reduce((s, p) => s + p.cats[c], 0) / pages.length));
      const overall = Math.round(pages.reduce((s, p) => s + p.overall, 0) / pages.length);
      // union of issues across pages (dedup by title)
      const seen = new Set(), issues = [];
      pages.forEach(p => p.issues.forEach(i => { if (!seen.has(i.title)) { seen.add(i.title); issues.push(i); } }));
      return json(res, 200, { aggregate: { overall, cats, issues }, pages: pages.map(p => ({ key: p.key, overall: p.overall, cats: p.cats })) });
    }

    if (p === "/api/audit-refine" && req.method === "POST") {
      const { page, theme } = JSON.parse(await readBody(req) || "{}");
      const key = (page || "home").replace(/[^a-z0-9_-]/gi, "");
      const metaFile = path.join(GEN, ".stitch-metadata.json");
      if (!fs.existsSync(metaFile)) return json(res, 400, { error: "No Stitch project found — generate with Stitch first (refine is Stitch-only)." });
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      const screenId = meta.screens && meta.screens[key];
      if (!meta.projectId || !screenId) return json(res, 400, { error: `No Stitch screen for '${key}' — generate it with Stitch first.` });
      const srcFile = path.join(GEN, key + ".html");
      const srcHtml = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, "utf8") : "";
      const t0 = Date.now();
      const audit = await auditPage(srcHtml);            // 1) critique
      let out = await stitchRefine(meta.projectId, screenId, audit.comments, "DESKTOP");  // 2) refine via Stitch
      const rkey = key + "-refined";
      if (out.html) {
        let h = sharpenStitchImages(out.html);
        h = await fixImages(h);
        h = await qcStitchImages(h);
        h = seoEnhance(h, rkey);
        h = injectCanonicalNav(h, theme || {});
        fs.writeFileSync(path.join(GEN, rkey + ".html"), h);
        out.html = h;
      }
      return json(res, 200, {
        page: rkey, sourcePage: key, comments: audit.comments, auditSource: audit.source,
        refinedPreviewUrl: out.html ? `/preview/${rkey}` : "", refinedExportUrl: out.html ? `/export/${rkey}` : "",
        screenshotUrl: out.screenshotUrl || "", seconds: ((Date.now() - t0) / 1000).toFixed(1),
      });
    }

    if (p === "/api/export-wordpress" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
      const slug = (a.business_name || "client").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
      await ensureFreshSite(body.theme); // rebind /site/ from newest generation — never ship stale
      const out = await buildWpTheme(slug, a.business_name);
      return json(res, 200, { slug: out.slug, themePath: `web/app/themes/g99-${out.slug}/`, files: out.files });
    }

    if (p === "/api/push-wordpress" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
      const slug = (a.business_name || "client").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
      if (!body.skipRebind) await ensureFreshSite(body.theme); // rebind /site/ from newest generation — never ship stale (dashboard binds itself and passes skipRebind)
      const built = await buildWpTheme(slug, a.business_name);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");   // YYYYMMDDHHMMSS
      const uniq = Date.now().toString(36).slice(-4);                              // avoid same-second collisions
      let branch = (body.branch || `g99/beta-theme-${slug}-${stamp}-${uniq}`).replace(/[^a-zA-Z0-9._\/\-]/g, "");
      const tmp = path.join(os.tmpdir(), "g99repo-" + Date.now());
      const rel = `web/app/themes/g99-${slug}`;
      const steps = [];
      const run = async (cmd, cwd) => { const r = await sh(cmd, cwd); steps.push({ cmd, code: r.code, err: (r.stderr || "").slice(-300) }); return r; };
      const runRetry = async (cmd, cwd, tries = 3) => {
        let r;
        for (let i = 1; i <= tries; i++) { r = await run(cmd, cwd); if (!r.code) return r; if (i < tries) await sleep(3000 * i); }
        return r;
      };
      try {
        // gh repo clone hits api.github.com/graphql, which flaky DNS occasionally
        // refuses; retry, then fall back to a plain git clone over github.com.
        let r = await runRetry(`gh repo clone ${WP_REPO} "${tmp}" -- --depth 1`);
        // Fallback avoids api.github.com (flaky DNS). With GH_TOKEN (deployed),
        // embed it so the plain clone is authenticated too.
        const cloneUrl = process.env.GH_TOKEN
          ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${WP_REPO}.git`
          : `https://github.com/${WP_REPO}.git`;
        if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
        if (r.code) throw new Error("clone failed (network — could not reach GitHub): " + r.stderr.slice(-200));
        // Deployed (headless) git push must authenticate via the token URL too.
        if (process.env.GH_TOKEN) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
        const dest = path.join(tmp, rel);
        // Delete-then-copy so an UPDATE PR also shows file removals (copy alone
        // would leave stale templates from earlier merged builds in the repo).
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        for (const f of built.files) fs.copyFileSync(path.join(built.themeDir, f), path.join(dest, f));
        // Must-use plugin so the deploy auto-activates the theme (no manual click).
        const muRel = "web/app/mu-plugins";
        const muFile = `g99-activate-${slug}.php`;
        fs.mkdirSync(path.join(tmp, muRel), { recursive: true });
        fs.writeFileSync(path.join(tmp, muRel, muFile), wpActivatorPlugin(slug, a.business_name, built.buildId));
        await run(`git checkout -b "${branch}"`, tmp);
        await run(`git add -A "${rel}" "${muRel}/${muFile}"`, tmp);
        r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "Add ${a.business_name} beta theme + auto-activator (Growth99 generated)"`, tmp);
        if (r.code) throw new Error("commit failed: " + (r.stderr || r.stdout).slice(-200));
        r = await run(`git push -u origin "${branch}"`, tmp);
        if (r.code) {
          // Remote ref already exists / non-fast-forward — retry once on a guaranteed-unique branch.
          const alt = `${branch}-${Date.now().toString(36)}`;
          await run(`git branch -m "${branch}" "${alt}"`, tmp);
          branch = alt;
          r = await run(`git push -u origin "${branch}"`, tmp);
          if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
        }
        const title = `Add ${a.business_name} beta theme (Growth99 generated)`;
        const prBody = `AI-generated classic WordPress theme for **${a.business_name}**, added at \`${rel}/\`.\\n\\nShips a must-use plugin (\`${muRel}/${muFile}\`) that auto-activates the theme once on deploy — no manual wp-admin click. Delete that file to disable auto-activation.\\n\\nGenerated by the Growth99 Website Build Tool. Beta: styling loads Tailwind + fonts from CDN; compile to static CSS before production.`;
        r = await runRetry(`gh pr create --repo ${WP_REPO} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body "${prBody}"`, tmp);
        const prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
        fs.rmSync(tmp, { recursive: true, force: true });
        if (!prUrl && r.code) throw new Error("PR create failed: " + r.stderr.slice(-200));
        return json(res, 200, { branch, prUrl, themePath: rel + "/", files: built.files.length });
      } catch (e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
        return json(res, 500, { error: e.message, steps });
      }
    }

    // PR CI status — BUILD checks only (integration `test` intentionally ignored).
    // The dashboard polls this every 10s after opening a PR.
    if (p === "/api/pr-status" && req.method === "POST") {
      const { prUrl } = JSON.parse(await readBody(req) || "{}");
      const prNum = ((prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
      if (!prNum) return json(res, 400, { error: "prUrl with /pull/<n> required" });
      const r = await sh(`gh pr checks ${prNum} --repo ${WP_REPO}`);
      // output lines: <name>\t<pass|fail|pending|skipping>\t<duration>\t<url>
      const rows = (r.stdout || "").split("\n").map(l => l.split("\t")).filter(c => c.length >= 2);
      const builds = rows.filter(c => /^build/i.test(c[0].trim()))
        .map(c => ({ name: c[0].trim(), status: c[1].trim(), url: (c[3] || "").trim() }));
      // aggregate duplicates (push + pull_request runs share names): fail > pending > pass
      const byName = {};
      for (const b of builds) {
        const cur = byName[b.name];
        const rank = (s) => s === "fail" ? 2 : (s === "pending" ? 1 : 0);
        if (!cur || rank(b.status) > rank(cur.status)) byName[b.name] = b;
      }
      const list = Object.values(byName);
      return json(res, 200, {
        prNum, checks: list,
        anyFail: list.some(b => b.status === "fail"),
        anyPending: list.some(b => b.status === "pending"),
        allPass: list.length > 0 && list.every(b => b.status === "pass"),
      });
    }

    // Merge the PR (squash — matches repo history) once builds are green.
    // Called by the dashboard automatically when /api/pr-status reports allPass.
    if (p === "/api/pr-merge" && req.method === "POST") {
      const { prUrl } = JSON.parse(await readBody(req) || "{}");
      const prNum = ((prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
      if (!prNum) return json(res, 400, { error: "prUrl with /pull/<n> required" });
      const r = await sh(`gh pr merge ${prNum} --repo ${WP_REPO} --squash --delete-branch`);
      if (r.code) return json(res, 500, { error: "merge failed: " + (r.stderr || r.stdout).slice(-300) });
      return json(res, 200, { merged: true, prNum });
    }

    // Is the generated theme ACTIVE on the live site? The mu-plugin activates it
    // after deploy; once active, WP enqueues /themes/g99-<slug>/style.css — that
    // asset path in the homepage HTML is the definitive activation signal.
    if (p === "/api/theme-live" && req.method === "POST") {
      const { url, slug } = JSON.parse(await readBody(req) || "{}");
      if (!url || !slug) return json(res, 400, { error: "url and slug required" });
      try {
        const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Cache-Control": "no-cache" } });
        const html = r.ok ? await r.text() : "";
        return json(res, 200, { active: html.includes(`/themes/g99-${slug}/`), httpStatus: r.status });
      } catch (e) { return json(res, 200, { active: false, error: e.message.slice(0, 120) }); }
    }

    // Auto-fix a failing PR build: read the failing CI log, identify the offending
    // generated file(s), ask Gemini for a corrected version, commit to the PR branch.
    if (p === "/api/pr-autofix" && req.method === "POST") {
      const { prUrl } = JSON.parse(await readBody(req) || "{}");
      const prNum = ((prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
      if (!prNum) return json(res, 400, { error: "prUrl with /pull/<n> required" });
      const branch = (await sh(`gh pr view ${prNum} --repo ${WP_REPO} --json headRefName --jq .headRefName`)).stdout.trim();
      if (!branch) return json(res, 500, { error: "could not resolve PR branch" });
      // find a failing build check and its run id
      const checks = (await sh(`gh pr checks ${prNum} --repo ${WP_REPO}`)).stdout.split("\n").map(l => l.split("\t"));
      const failing = checks.find(c => /^build/i.test((c[0] || "").trim()) && (c[1] || "").trim() === "fail");
      if (!failing) return json(res, 200, { fixed: [], message: "no failing build check found" });
      const runId = ((failing[3] || "").match(/\/runs\/(\d+)/) || [])[1];
      const log = runId ? (await sh(`gh run view ${runId} --repo ${WP_REPO} --log-failed`)).stdout.slice(-8000) : "";
      // offending files: Pint prints "⨯ path/to/file.php" (often truncated with …) — also accept any .php path in the log
      const raw = [...new Set([...log.matchAll(/[⨯x]\s+(\S+?\.php)|((?:web|config)\/[\w\/.-]+?\.php)/g)].map(m => (m[1] || m[2])).filter(Boolean))];
      // resolve truncated paths against the branch tree
      const tree = (await sh(`gh api repos/${WP_REPO}/git/trees/${branch}?recursive=1 --jq ".tree[].path"`)).stdout.split("\n");
      const files = [...new Set(raw.map(f => tree.find(t => t === f) || tree.find(t => t.startsWith(f.replace(/…$/, ""))) || null).filter(Boolean))].slice(0, 3);
      if (!files.length) return json(res, 200, { fixed: [], message: "could not identify offending file from log", log: log.slice(-1500) });
      const fixed = [];
      for (const f of files) {
        const meta = JSON.parse((await sh(`gh api "repos/${WP_REPO}/contents/${f}?ref=${branch}"`)).stdout || "{}");
        if (!meta.content) continue;
        const content = Buffer.from(meta.content, "base64").toString("utf8");
        const prompt = [
          `This PHP file failed the repo's CI (Laravel Pint, PER preset code style). Fix ONLY what is needed to pass — do not change behavior, structure, or content.`,
          `CI failure log (tail):\n${log.slice(-3000)}`,
          `File: ${f}\n----- FILE CONTENT START -----\n${content}\n----- FILE CONTENT END -----`,
          `Return ONLY the complete corrected file content. No markdown fences, no commentary.`,
        ].join("\n\n");
        let fixedContent = await geminiCall([{ text: prompt }], { temperature: 0.1, maxOutputTokens: 16000, timeoutMs: 60000 });
        fixedContent = fixedContent.replace(/^```(?:php)?\n?/, "").replace(/\n?```\s*$/, "");
        if (!fixedContent.trim().startsWith("<?php") && content.trim().startsWith("<?php")) continue; // sanity: don't commit garbage
        if (fixedContent.trim() === content.trim()) continue; // nothing changed
        const b64 = Buffer.from(fixedContent, "utf8").toString("base64");
        const put = await sh(`gh api -X PUT "repos/${WP_REPO}/contents/${f}" -f message="Auto-fix CI build failure (Gemini)" -f content="${b64}" -f sha="${meta.sha}" -f branch="${branch}"`);
        if (!put.code) fixed.push(f);
      }
      return json(res, 200, { fixed, branch, message: fixed.length ? `committed fix to ${fixed.join(", ")}` : "Gemini produced no usable fix", log: fixed.length ? undefined : log.slice(-1500) });
    }

    if (p === "/api/bind-site" && req.method === "POST") {
      const { engine, theme } = JSON.parse(await readBody(req) || "{}");
      const t0 = Date.now();
      const out = await bindSiteSmart(engine === "gemini" ? "gemini" : "", theme || {});
      return json(res, 200, { ...out, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    }

    if (p === "/api/assemble" && req.method === "POST") {
      const { engine } = JSON.parse(await readBody(req) || "{}");
      const out = assembleSite(engine === "gemini" ? "gemini" : "");
      return json(res, 200, out);
    }

    const siteM = p.match(/^\/(site(?:-gemini)?)(?:\/(.*))?$/);
    if (siteM) {
      const rel = (siteM[2] || "index.html").replace(/[^a-z0-9._-]/gi, "") || "index.html";
      const f = path.join(GEN, siteM[1], rel);
      if (fs.existsSync(f)) return send(res, 200, MIME[path.extname(f)] || "text/html", fs.readFileSync(f));
      return send(res, 404, "text/html", "<h1>Site not assembled yet</h1>");
    }

    if (p === "/export-site") {
      const engine = (u.searchParams.get("engine") || "").replace(/[^a-z]/g, "");
      const dirName = engine ? `site-${engine}` : "site";
      const siteDir = path.join(GEN, dirName);
      if (!fs.existsSync(siteDir)) return json(res, 404, { error: "assemble first" });
      const zip = path.join(GEN, dirName + ".zip");
      await new Promise((resolve, reject) => {
        require("child_process").execFile("powershell.exe",
          ["-NoProfile", "-Command", `Compress-Archive -Path '${siteDir}\\*' -DestinationPath '${zip}' -Force`],
          (e) => e ? reject(new Error("zip failed: " + e.message)) : resolve());
      });
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="beta-site${engine ? "-" + engine : ""}.zip"` });
      return res.end(fs.readFileSync(zip));
    }

    if (p.startsWith("/preview/")) {
      const f = path.join(GEN, p.slice(9).replace(/[^a-z0-9_-]/gi, "") + ".html");
      if (fs.existsSync(f)) return send(res, 200, "text/html", fs.readFileSync(f));
      return send(res, 404, "text/html", "<h1>Not generated yet</h1>");
    }
    if (p.startsWith("/export/")) {
      const key = p.slice(8).replace(/[^a-z0-9_-]/gi, "");
      const f = path.join(GEN, key + ".html");
      if (!fs.existsSync(f)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "text/html", "Content-Disposition": `attachment; filename="${key}.html"` });
      return res.end(fs.readFileSync(f));
    }

    if (p === "/api/seo-audit" && req.method === "POST") {
      const { url, keywords } = JSON.parse(await readBody(req) || "{}");
      if (!url) return json(res, 400, { error: "url required" });
      const abs = url.startsWith("http") ? url : `http://localhost:${PORT}${url}`;
      const r = await fetch(abs, { redirect: "follow", headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      } });
      if (!r.ok) return json(res, 502, { error: `fetch ${abs} -> ${r.status}` });
      const html = await r.text();
      return json(res, 200, { auditedUrl: abs, ...audit(html, keywords || []) });
    }

    return send(res, 404, "text/plain", "not found");
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`G99 Website Build Tool → http://localhost:${PORT}`));
}
module.exports = { seoEnhance, audit, sharpenStitchImages, injectCanonicalNav, qcStitchImages, fixImages };
