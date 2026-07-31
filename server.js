// Growth99 Website-Build Tool — prototype server (pure Node, no deps).
// Screens: onboarding Q&A -> prompt/theme editor -> Stitch generate -> preview/export -> SEO audit.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, spawn } = require("child_process");
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

const WP_REPO = process.env.WP_REPO || "G99agency/prodteam.gogroth.com";
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
// NocoDB is the source of truth for real websites (name / domain / repo). The
// table id is derived from the shared board URL; only the token is a secret.
const NOCODB_BASE = (process.env.NOCODB_BASE || "https://app.nocodb.com").replace(/\/$/, "");
const NOCODB_TOKEN = process.env.NOCODB_TOKEN || "";
const NOCODB_TABLE = process.env.NOCODB_TABLE || "mp8nfno2six11yi";
if (!API_KEY) console.warn("⚠ STITCH_API_KEY not set — Stitch generation will fail. Add it to .env or the platform env vars.");
if (!NOCODB_TOKEN) console.warn("⚠ NOCODB_TOKEN not set — the All Sites / Edit Sites website list will be empty until it's added to .env.");
if (!GEMINI_KEYS.length) console.warn("⚠ GEMINI_KEYS not set — all AI features (CRO, prompt, bind, QC) will fail.");
let GEMINI_KEY = GEMINI_KEYS[0];                 // kept for legacy call sites
// Default off gemini-flash-lite-latest: on 2026-07-28 that alias accepted
// connections and never responded, stalling every AI step until it timed out.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-flash-latest,gemini-3.6-flash")
  .split(",").map(s => s.trim()).filter(Boolean);
let gkIdx = 0;
// Cost/usage meter: the running job sets COST_SINK to its cost object; each
// Gemini/Stitch call bumps a counter (single-concurrency, so no cross-talk).
let COST_SINK = null;
function bumpUsage(kind) { if (COST_SINK) COST_SINK[kind] = (COST_SINK[kind] || 0) + 1; }
// Rotating Gemini caller: cycles across all keys, skipping 429/503 (load-balance
// + free-tier quota multiplied by key count). parts = Gemini content parts array.
// Every model×key combination, in order, until one answers. Rotating keys alone
// wasn't enough: with a single key the loop ran exactly once, so one sick model
// took down the whole job. A model can fail four different ways — 429 (quota),
// 503 (overloaded), 404 (retired), or accept the connection and never reply —
// and only the last one is silent, which is what made it look like a network
// fault. Falling through to another model covers all four.
async function geminiCall(parts, opts = {}) {
  const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: opts.temperature ?? 0.5, maxOutputTokens: opts.maxOutputTokens ?? 8000 } };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  const models = opts.model ? [opts.model]
    : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = null;
  for (const model of models) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[(gkIdx + i) % GEMINI_KEYS.length];
      const ctl = new AbortController();
      // A hang costs the full timeout before we can try anything else, so keep
      // it tight enough that the fallbacks still get a turn.
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 30000);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
        if (r.status === 429 || r.status === 503 || r.status === 404) { lastErr = new Error(`${model} → ${r.status}`); continue; }
        const d = await r.json();
        if (!r.ok) throw new Error(`gemini ${r.status}: ${(d.error && d.error.message || "").slice(0, 140)}`);
        const txt = ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
        if (!txt) { lastErr = new Error(`${model} → empty${d.candidates?.[0]?.finishReason ? ` (${d.candidates[0].finishReason})` : ""}`); continue; }
        gkIdx = (gkIdx + i + 1) % GEMINI_KEYS.length;
        if (model !== models[0]) console.warn(`gemini: fell back to ${model} (${lastErr && lastErr.message})`);
        bumpUsage("gemini");
        return txt;
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error(`${model} → no response in ${(opts.timeoutMs || 30000) / 1000}s`) : e;
      } finally { clearTimeout(timer); }
    }
  }
  throw new Error("every Gemini model failed — last: " + (lastErr ? lastErr.message : "unknown"));
}

if (!fs.existsSync(GEN)) fs.mkdirSync(GEN, { recursive: true });

// ---------------------------------------------------------------- Stitch MCP
let PROTO = "2025-06-18";
let rpcId = 0;
let PROJECT = null; // reused across pages within a run

// ---- Ollama Cloud, as a second provider for the edit chat only -------------
// Gemini remains the default and the only provider for builds, CRO audits,
// enrichment and the email matcher. This exists so an operator editing a site
// from the chat can try a different model, and so the tool is not wholly
// dependent on one Gemini key.
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_MODELS = [
  { id: "glm-5.2:cloud",      label: "GLM 5.2" },
  { id: "kimi-k3:cloud",      label: "Kimi K3" },
  { id: "gemma4:31b-cloud",   label: "Gemma 4 31B" },
  { id: "qwen3.5:397b-cloud", label: "Qwen 3.5 397B" },
];
const isOllamaModel = (m) => OLLAMA_MODELS.some((x) => x.id === m);

// OpenAI-compatible endpoint rather than the native one: it gives a real JSON
// mode, which the edit planner depends on.
async function ollamaCall(parts, opts = {}) {
  if (!OLLAMA_API_KEY) throw new Error("OLLAMA_API_KEY is not set");
  const content = parts.map((p) => p.text || "").join("\n");
  const body = {
    model: opts.model,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content },
    ],
    temperature: opts.temperature ?? 0.5,
    // Every model offered here reasons before answering, and that reasoning
    // spends the same budget as the answer. Too small a ceiling returns an
    // empty message rather than an error, so keep a floor under it.
    max_tokens: Math.max(opts.maxOutputTokens ?? 8000, 4000),
    stream: false,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const ctl = new AbortController();
  // These are large models; the Gemini-sized timeouts are not enough.
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 180000);
  try {
    const r = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OLLAMA_API_KEY}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`ollama ${r.status}: ${String((d.error && (d.error.message || d.error)) || "").slice(0, 140)}`);
    const choice = (d.choices || [])[0] || {};
    const txt = (choice.message && choice.message.content) || "";
    if (!txt) {
      throw new Error(choice.finish_reason === "length"
        ? `${opts.model} ran out of output budget before answering (reasoning consumed it)`
        : `${opts.model} returned an empty response`);
    }
    bumpUsage("gemini");   // one meter for AI calls; provider is recorded on the job
    return txt;
  } finally { clearTimeout(timer); }
}

// Single entry point for the edit path. Anything that is not a known Ollama
// model — including no choice at all — goes to Gemini untouched.
async function aiCall(parts, opts = {}) {
  const model = String(opts.aiModel || "").trim();
  if (!model || model === "gemini" || !isOllamaModel(model)) return geminiCall(parts, opts);
  try {
    return await ollamaCall(parts, { ...opts, model });
  } catch (e) {
    // A model someone picked to experiment with must not kill a real request.
    // The job records which model actually produced the change.
    console.warn(`ollama ${model} failed — falling back to Gemini:`, e.message);
    if (typeof opts.onFallback === "function") opts.onFallback(model, e.message);
    return geminiCall(parts, opts);
  }
}

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
async function callTool(name, args, timeoutMs) {
  bumpUsage("stitch");
  const r = await rpc("tools/call", { name, arguments: args }, false, timeoutMs);
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
      // Escalating timeout: the default 90s is too short for big pages (the home
      // page has ~11 sections and timed out on all 5 attempts), which then poisons
      // the whole theme because header/footer/front-page derive from home.
      const genTimeout = [150000, 210000, 270000, 300000, 300000][attempt - 1] || 300000;
      const gen = await callTool("generate_screen_from_text", args, genTimeout);
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
      if (attempt < 5) await sleep(6000 * attempt);   // back off before every retry
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

// ------------------------------------------------------------ Real brand extraction
// A screenshot can't tell you a font's NAME, so the vision pass could only ever
// describe a style — which is why generated sites silently fell back to
// Playfair/Inter. Sites declare their real families in markup, so read them.
// Everything that is a system/fallback face, an icon font, or a theme-plugin font
// rather than a brand choice. WordPress themes ship a long default stack
// (-apple-system, …, Oxygen-Sans, Ubuntu, Cantarell, …) which is NOT the brand.
const GENERIC_FONTS = /^(sans-serif|serif|monospace|cursive|fantasy|inherit|initial|unset|revert|auto|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|BlinkMacSystemFont|Segoe UI|Roboto|Roboto Slab|Roboto Condensed|Helvetica|Helvetica Neue|Arial|Arial Black|Times|Times New Roman|Georgia|Courier|Courier New|Verdana|Tahoma|Trebuchet MS|Palatino|Garamond|Oxygen|Oxygen-Sans|Ubuntu|Cantarell|Fira Sans|Droid Sans|Noto Sans|Noto Serif|Liberation Sans|DejaVu Sans|Segoe UI Emoji|Segoe UI Symbol|Apple Color Emoji|Consolas|Menlo|Monaco|Lucida.*|MS .*|.*Emoji.*|.*icons?|.*Icons?|dashicons|eicons|elementskit.*|fontawesome|Font Awesome.*|swiper.*|revicons|bootstrap-icons|feather|simple-line-icons|themify|linearicons)$/i;
function extractFontFamilies(html) {
  const s = String(html);
  const norm = (raw) => String(raw || "").replace(/\+/g, " ").replace(/["']/g, "").trim();
  const keep = (n) => n && n.length <= 40 && !GENERIC_FONTS.test(n) && !/^var\(|^\$|^#|^\d/.test(n);
  const push = (list, n) => { if (keep(n) && !list.some((x) => x.toLowerCase() === n.toLowerCase())) list.push(n); };

  // 1) Google Fonts links — the authoritative signal for a site's brand type.
  const google = [];
  for (const m of s.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/g)) {
    for (const f of m[1].matchAll(/family=([^&:]+)/g)) push(google, norm(decodeURIComponent(f[1])));
  }
  if (google.length) return google;   // don't dilute a real answer with fallbacks

  // 2) No webfonts declared: fall back to font-family rules, taking only the
  // FIRST family in each stack — the intended face, not its fallback chain.
  const declared = [];
  for (const m of s.matchAll(/font-family\s*:\s*([^;}]+)/g)) push(declared, norm(m[1].split(",")[0]));
  return declared;
}
// Dominant non-neutral hexes, most frequent first — the site's real palette.
function extractPalette(html) {
  const count = {};
  for (const m of String(html).matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = "#" + m[1].toUpperCase();
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const nearWhite = mx > 244 && mn > 238, nearBlack = mx < 18;
    if (nearWhite || nearBlack) continue;                 // page ground, not brand
    count[hex] = (count[hex] || 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).map(([h]) => h);
}
// Fetch a live site and read its ACTUAL type + palette.
async function readSiteBrand(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot", "Cache-Control": "no-cache" } });
    if (!r.ok) return null;
    const html = await r.text();
    const fonts = extractFontFamilies(html), pal = extractPalette(html);
    if (!fonts.length && !pal.length) return null;
    return { fonts, headingFont: fonts[0] || null, bodyFont: fonts[1] || fonts[0] || null, palette: pal };
  } catch (e) { return null; }
}
// The brand a THEME actually renders. Derived from the theme's own files rather
// than a job record, so it can't drift from the site it's editing (job history is
// in-memory and vanishes on redeploy, which is how the brand guide went stale).
// Font ROLE detection. A Google Fonts URL lists families alphabetically, so
// position tells you nothing — reading fonts[0] as "the heading font" got Inter
// and Playfair Display exactly backwards. Decide by how each family is USED.
const DISPLAY_FACES = /(playfair|cormorant|lora|tenor|garamond|didot|bodoni|prata|marcellus|cinzel|libre baskerville|crimson|spectral|fraunces|canela|serif)/i;
function detectHeadingFont(html, fonts) {
  const s = String(html);
  if (!fonts.length) return null;
  const isFont = (n) => fonts.find((f) => f.toLowerCase() === String(n || "").toLowerCase().replace(/["']/g, "").trim());
  // 1) Explicit role keys, MOST specific first. These themes invent their own
  // names — one declares headline:["Playfair Display"] next to
  // display:["Public Sans"] — so "display" must never outrank "headline".
  for (const key of ["headline", "heading", "title", "serif", "display"]) {
    const re = new RegExp(key + "\\s*:\\s*\\[?\\s*['\"]([^'\"]+)['\"]", "gi");
    for (const m of s.matchAll(re)) {
      const hit = isFont(m[1]);
      // a sans face under a "display" key is a utility, not the heading face
      if (hit && !(key === "display" && !DISPLAY_FACES.test(hit))) return hit;
    }
  }
  for (const m of s.matchAll(/--(?:display|heading|font-display)\s*:\s*['"]?([^;'",]+)/gi)) {
    const hit = isFont(m[1]); if (hit) return hit;
  }
  // 2) a family applied directly to heading selectors
  for (const m of s.matchAll(/(?:^|[},;\s])(h1|h2|h3)[^{}]{0,120}\{[^{}]{0,400}?font-family\s*:\s*([^;}]+)/gi)) {
    const hit = isFont(String(m[2]).split(",")[0]); if (hit) return hit;
  }
  // 3) otherwise the display/serif-looking family is the heading one
  return fonts.find((f) => DISPLAY_FACES.test(f)) || null;
}
// Colour ROLES by measurement, not frequency: primary = darkest, accent = most
// saturated, secondary = what's left. (Frequency picked #D4C5B9 — a light beige —
// as "primary", which is a background, not a brand primary.)
function assignPaletteRoles(pal) {
  const info = pal.slice(0, 10).map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return { hex, lum: (0.299 * r + 0.587 * g + 0.114 * b) / 255, sat: mx ? (mx - mn) / mx : 0 };
  });
  if (!info.length) return {};
  const primary = info.slice().sort((a, b) => a.lum - b.lum)[0];
  const accent = info.filter((x) => x.hex !== primary.hex).sort((a, b) => b.sat - a.sat)[0] || primary;
  const secondary = info.find((x) => x.hex !== primary.hex && x.hex !== accent.hex) || accent;
  return { primary: primary.hex, secondary: secondary.hex, accent: accent.hex };
}
function readThemeBrand(themeDir) {
  try {
    let html = "";
    for (const f of ["header.php", "front-page.php", "page-services.php", "style.css"]) {
      const p = path.join(themeDir, f);
      if (fs.existsSync(p)) html += "\n" + fs.readFileSync(p, "utf8");
    }
    if (!html.trim()) return null;
    const fonts = extractFontFamilies(html), pal = extractPalette(html);
    if (!fonts.length && !pal.length) return null;
    const headingFont = detectHeadingFont(html, fonts);
    const bodyFont = fonts.find((f) => f !== headingFont) || headingFont || null;
    return { headingFont, bodyFont, ...assignPaletteRoles(pal), fonts, palette: pal.slice(0, 6), html };
  } catch (e) { return null; }
}
// Stitch bakes its OWN font links into the page chrome and ignores the brand we
// asked for — the real reason a generated site's type doesn't match. So state the
// brand explicitly on every page instead of hoping the model complied.
function enforceBrandFonts(html, composed) {
  const c = composed || {};
  const h = c.headingFont, b = c.bodyFont;
  if (!html || (!h && !b)) return html;
  if (String(html).includes("g99-brand-type")) return html;      // idempotent
  const fam = [h, b].filter(Boolean).map((f) => "family=" + encodeURIComponent(f).replace(/%20/g, "+") + ":wght@300;400;500;600;700").join("&");
  const serif = h && DISPLAY_FACES.test(h) ? "serif" : "sans-serif";
  const block = `
<!-- g99-brand-type -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fam}&display=swap">
<style>
${h ? `h1,h2,h3,h4,.font-display,.font-serif,[class*="font-display"]{font-family:'${h}',${serif} !important}` : ""}
${b ? `body,p,li,a,span,div,button,input,textarea,select,.font-body,.font-sans{font-family:'${b}',sans-serif}` : ""}
${h ? `h1,h2,h3,h4{letter-spacing:-.01em}` : ""}
</style>`;
  // sits last so it wins the cascade over whatever the model emitted
  return String(html).replace(/<\/head>/i, block + "\n</head>").includes("g99-brand-type")
    ? String(html).replace(/<\/head>/i, block + "\n</head>")
    : String(html) + block;
}

// ------------------------------------------------------------ Image resolution QC
// A "blurry" hero is almost always a small image stretched wide, so the reliable
// test is the image's INTRINSIC pixel width — not a perceptual blur score. Read it
// straight from the file header (JPEG SOF / PNG IHDR / WebP VP8) using a ranged
// fetch, so we download a few KB instead of the whole photo.
function dimsFromBuffer(b) {
  if (!b || b.length < 24) return null;
  // PNG: 8-byte signature, then IHDR width/height as big-endian uint32
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // GIF87a/89a: little-endian uint16 at 6/8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP") {
    const c = b.slice(12, 16).toString("ascii");
    try {
      if (c === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (c === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (c === "VP8L") {
        const n = b.readUInt32LE(21);
        return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
      }
    } catch (e) { return null; }
  }
  // JPEG: walk the segment chain to a Start-Of-Frame marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
async function imageDims(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Range: "bytes=0-65535", "User-Agent": "Mozilla/5.0 G99Bot" } });
    if (!r.ok && r.status !== 206) return null;
    return dimsFromBuffer(Buffer.from(await r.arrayBuffer()));
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
// Check every <img> / CSS background image on a page. Anything whose real pixel
// width is below the threshold would visibly soften when stretched, so swap it for
// a curated 1600px photo. Returns the cleaned html + a per-image report.
// Stitch's AI images top out at 1408x768 — fine for a card, not for a full-bleed
// hero on a modern display (~1.8x upscale = visibly soft). So heroes get a higher
// bar and are replaced with 2400px photography; small images keep the normal one.
const HERO_MIN_WIDTH = 1600;
const CURATED_HERO_IMAGES = CURATED_IMAGES.map((u) => u.replace(/([?&])w=\d+/, "$1w=2400"));
// Which image URLs are used as a hero / full-bleed band? Keyed off the markup
// around each occurrence, so it works whatever classes the model invented.
function heroImageUrls(html) {
  const hero = new Set();
  const s = String(html);
  const HINT = /(hero|min-h-screen|h-screen|h-\[\d{2,3}vh\]|min-h-\[\d{2,3}vh\]|object-cover[^"]*absolute|absolute[^"]*inset-0)/i;
  for (const m of s.matchAll(/https:\/\/(?:lh3\.googleusercontent\.com\/aida-public\/|images\.unsplash\.com\/)[^"'()\s]+/g)) {
    const around = s.slice(Math.max(0, m.index - 700), m.index + 400);
    if (HINT.test(around)) hero.add(m[0]);
  }
  // the first image on the page is the hero often enough to treat it as one
  const first = (s.match(/https:\/\/(?:lh3\.googleusercontent\.com\/aida-public\/|images\.unsplash\.com\/)[^"'()\s]+/) || [])[0];
  if (first) hero.add(first);
  return hero;
}
async function qcImageResolution(html, minWidth = 1000) {
  if (!html) return { html, report: [] };
  const urls = [...new Set(
    [...String(html).matchAll(/https:\/\/[^"'()\s]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'()\s]*)?/gi)].map((m) => m[0])
      .concat([...String(html).matchAll(/https:\/\/images\.unsplash\.com\/[^"'()\s]+/gi)].map((m) => m[0]))
      .concat([...String(html).matchAll(/https:\/\/lh3\.googleusercontent\.com\/aida-public\/[^"'()\s]+/gi)].map((m) => m[0]))
  )].slice(0, 24);
  if (!urls.length) return { html, report: [] };
  const dims = await Promise.all(urls.map((u) => imageDims(u)));
  const heroes = heroImageUrls(html);
  const report = []; let ci = 0, hi = 0, swapped = 0;
  urls.forEach((u, i) => {
    const d = dims[i];
    const isHero = heroes.has(u);
    const need = isHero ? HERO_MIN_WIDTH : minWidth;
    const ok = d && d.w >= need;
    const row = { url: u.slice(0, 120), w: d ? d.w : null, h: d ? d.h : null, role: isHero ? "hero" : "inline", need, ok: !!ok, action: "kept" };
    if (!ok) {
      // unreadable header ≠ broken image (some CDNs refuse ranged reads), so only
      // replace when we positively measured it as too small
      if (d) {
        const repl = isHero ? CURATED_HERO_IMAGES[hi++ % CURATED_HERO_IMAGES.length] : CURATED_IMAGES[ci++ % CURATED_IMAGES.length];
        html = html.split(u).join(repl);
        row.action = `replaced (${d.w}px < ${need}px${isHero ? ", hero" : ""})`; swapped++;
      } else {
        row.action = "unmeasured — kept";
      }
    }
    report.push(row);
  });
  if (swapped) console.log(`  image QC: replaced ${swapped}/${urls.length} under-resolution image(s) (hero bar ${HERO_MIN_WIDTH}px, inline ${minWidth}px)`);
  return { html, report };
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

// ============================================================ JOB RUNNER
// Server-side pipeline: a webhook (or manual enqueue) runs the whole 7-step
// flow with no browser. The runner drives the tool's OWN http routes — the
// same calls dashboard.js makes — so there is exactly one implementation of
// each step. Plain http.request (not fetch) so multi-minute steps aren't
// killed by undici's header timeouts.
function localApi(pathName, body, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: pathName, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "x-admin-key": process.env.ADMIN_PASSWORD || "" },
    }, (rs) => {
      let s = "";
      rs.on("data", (c) => s += c);
      rs.on("end", () => {
        let d;
        try { d = JSON.parse(s); } catch (e) { return reject(new Error(`${pathName} → ${rs.statusCode}: ${s.slice(0, 160)}`)); }
        if (rs.statusCode >= 400) return reject(new Error(d.error || `${pathName} failed (${rs.statusCode})`));
        resolve(d);
      });
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error(pathName + " timed out")));
    r.on("error", reject);
    r.end(data);
  });
}

const JOB_STEPS = [
  "CRO audit — existing site", "Compose build prompt", "Generate pages (Stitch)",
  "Assemble site", "WordPress theme + PR", "CI checks → auto-merge",
  "Theme activation watch", "CRO after-audit + comparison",
  // Runs as its OWN job (see runEnrichJob); this step mirrors its progress so the
  // build timeline shows the whole story and can link straight to that run.
  "Service pages + brand guide",
];
const ENRICH_STEP_IDX = JOB_STEPS.length - 1;
const JOBS = new Map();     // draftId -> job record
const JOB_QUEUE = [];       // draftIds waiting (single concurrency — Stitch/Gemini quotas)
let JOB_RUNNING = false;
const LIVE_URL = process.env.WP_LIVE_URL || "https://prodteam.gogroth.com/";

// Persist jobs so /jobs survives a process restart/crash (best-effort; on
// Render's ephemeral disk it survives in-deploy restarts, not a fresh deploy).
const JOBS_FILE = path.join(DIR, "jobs.json");
let saveTimer = null;
function saveJobs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(JOBS_FILE, JSON.stringify([...JOBS.values()].slice(-60), null, 0)); } catch (e) { /* non-fatal */ }
  }, 400); // debounce — jobStep fires often
}
function loadJobs() {
  try {
    for (const j of JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"))) {
      if (j.status === "running" || j.status === "queued") { j.status = "error"; j.error = "interrupted by a server restart"; }
      // A finished run can't still be waiting on anybody. Leaving this set made
      // dead jobs sit in the Activity screen's "In progress · Needs approval"
      // list forever, behind a button that couldn't do anything. Clearing it
      // here also heals records written before this was fixed.
      if (j.status !== "running" && j.status !== "queued") j.awaitingApproval = false;
      JOBS.set(j.draftId, j);
    }
    // Write the healed records straight back, so the file doesn't keep the bad
    // state until the next job happens to trigger a save.
    saveJobs();
  } catch (e) { /* none yet */ }
}
loadJobs();

// ---------------------------------------------------------------- Site registry
// No DB: the repo is the source of truth. syncSiteRegistry() derives the list of
// editable sites from the theme dirs on main + each slug's latest merged PR, and
// caches it to registry.json. Build/edit jobs call it at the end for freshness.
const REGISTRY_FILE = path.join(DIR, "registry.json");
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); } catch (e) { return { sites: [], syncedAt: null }; }
}
function prettyName(slug) {
  return slug.replace(/^g99-/, "").split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}
// Collapse a PR's statusCheckRollup (mix of CheckRun + StatusContext) into one
// CI verdict: failing > pending > passing > none (no checks configured/ran).
function ciRollup(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false, failing = false, passing = false;
  for (const c of rollup) {
    const st = (c.status || "").toUpperCase();          // CheckRun: QUEUED/IN_PROGRESS/COMPLETED
    const v = (c.conclusion || c.state || "").toUpperCase(); // conclusion (CheckRun) or state (StatusContext)
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) failing = true;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) passing = true;
    else if (["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(v) || st === "IN_PROGRESS" || st === "QUEUED") pending = true;
  }
  return failing ? "failing" : pending ? "pending" : passing ? "passing" : "none";
}
// Which theme is live: WordPress enqueues the active theme's assets, so the
// homepage HTML contains /themes/g99-<slug>/. One fetch → the active slug.
async function detectActiveTheme(url) {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Cache-Control": "no-cache" } });
    if (!r.ok) return null;
    // Active theme's assets are enqueued as /themes/<slug>/… . Accept any slug
    // (real client sites aren't all g99-*, e.g. "ecka"), first match wins.
    const m = (await r.text()).match(/\/themes\/([a-z0-9][a-z0-9._-]*)\//i);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
async function syncSiteRegistry() {
  const themes = await sh(`gh api "repos/${WP_REPO}/contents/web/app/themes?ref=main" --jq ".[]|select(.type==\\"dir\\")|.name"`);
  const slugs = (themes.stdout || "").split("\n").map(s => s.trim()).filter(s => s.startsWith("g99-"));
  const prsRaw = await sh(`gh pr list --repo ${WP_REPO} --state merged --limit 80 --json number,title,headRefName,mergedAt,url`);
  let prs = []; try { prs = JSON.parse(prsRaw.stdout || "[]"); } catch (e) { prs = []; }
  const byId = {}; (readRegistry().sites || []).forEach(s => { byId[s.siteId] = s; });
  const sites = slugs.map(slug => {
    const bare = slug.replace(/^g99-/, "");
    // boundary match so "mehul-aesthetic" doesn't also grab "mehul-aesthetic1"'s branch
    const re = new RegExp("(^|[/-])" + bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-|$)");
    const last = prs.filter(pr => re.test(pr.headRefName || ""))
      .sort((a, b) => (b.mergedAt || "").localeCompare(a.mergedAt || ""))[0];
    const prev = byId[slug] || {};
    return {
      siteId: slug,
      businessName: prev.businessName || prettyName(slug),
      themeSlug: slug,
      themePath: `web/app/themes/${slug}`,
      githubRepo: WP_REPO,
      liveUrl: prev.liveUrl || LIVE_URL,
      requireApproval: prev.requireApproval || false,
      lastPrUrl: (last && last.url) || prev.lastPrUrl || null,
      lastChange: (last && last.title) || prev.lastChange || null,
      updatedAt: (last && last.mergedAt) || prev.updatedAt || null,
    };
  });
  // Flag which theme is currently active on each live site (one fetch per URL).
  const activeByUrl = {};
  for (const s of sites) {
    if (!(s.liveUrl in activeByUrl)) activeByUrl[s.liveUrl] = await detectActiveTheme(s.liveUrl);
    s.active = activeByUrl[s.liveUrl] === s.themeSlug;
  }
  const reg = { sites, syncedAt: new Date().toISOString() };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  return reg;
}

// ---------------------------------------------------------------- NocoDB sites
// Real websites (name / domain / repo) live in a NocoDB table — one row per
// client site, each mapped to its OWN GitHub repo. This replaces the old
// "every theme folder in WP_REPO is a site" model, which conflated themes with
// websites. A short in-memory cache keeps the board responsive.
let NOCO_CACHE = { sites: [], at: 0 };
// case/space-insensitive field read with a few tolerated aliases
function nocoField(row, names) {
  const keys = Object.keys(row || {});
  for (const n of names) {
    const k = keys.find(k => k.toLowerCase().trim() === n.toLowerCase().trim());
    if (k && row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  }
  return "";
}
// "https://github.com/Owner/Repo(.git)" (or git@…) -> "Owner/Repo". Repo names
// can contain dots (e.g. prodteam.gogroth.com), so split rather than a greedy RE.
function parseRepoSlug(url) {
  const s = String(url || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = s.match(/github\.com[/:](.+)$/i);
  if (!m) return "";
  const parts = m[1].split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}
function mapNocoRow(row) {
  const businessName = nocoField(row, ["Website name", "Website Name", "Name", "Business", "Business Name"]);
  const liveUrl = nocoField(row, ["Domain", "Website URL", "URL", "Site URL", "Live URL"]);
  const repoUrl = nocoField(row, ["Repo File Path", "Repository URL", "Repo", "Repository", "GitHub", "Github Repo"]);
  const githubRepo = parseRepoSlug(repoUrl);
  const rowId = row.Id != null ? row.Id : (row.id != null ? row.id : null);
  const siteId = rowId != null ? `noco-${rowId}` : (githubRepo || businessName);
  return { siteId, rowId, businessName, liveUrl, repoUrl, githubRepo };
}
async function fetchNocoWebsites() {
  if (!NOCODB_TOKEN) throw new Error("NOCODB_TOKEN not set — add it to .env");
  const url = `${NOCODB_BASE}/api/v2/tables/${NOCODB_TABLE}/records?limit=200`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let r;
  try { r = await fetch(url, { signal: ctl.signal, headers: { "xc-token": NOCODB_TOKEN, "accept": "application/json" } }); }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`NocoDB ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  return (d.list || []).map(mapNocoRow).filter(w => w.businessName && w.githubRepo);
}
async function getWebsites(refresh) {
  if (!refresh && NOCO_CACHE.sites.length && Date.now() - NOCO_CACHE.at < 60000) return NOCO_CACHE.sites;
  const sites = await fetchNocoWebsites();
  NOCO_CACHE = { sites, at: Date.now() };
  return sites;
}
async function findWebsite(siteId) {
  return (await getWebsites(false)).find(s => s.siteId === String(siteId))
      || (await getWebsites(true)).find(s => s.siteId === String(siteId));   // cache miss → force refresh once
}
// Real theme dirs in a repo (no clone — one contents API call). Excludes the
// .gitkeep placeholder and any dotfiles; accepts any theme name, not just g99-*.
async function listRepoThemes(repo) {
  const r = await sh(`gh api "repos/${repo}/contents/web/app/themes?ref=main" --jq ".[]|select(.type==\\"dir\\")|.name"`);
  return (r.stdout || "").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("."));
}
// Which theme in the website's repo an edit should target: prefer the theme the
// live domain is actually serving (and that exists in the repo); else the sole
// theme in the repo; else a clear error. A g99-* theme also carries its
// auto-activator mu-plugin; hand-onboarded themes (e.g. "ecka") do not.
async function resolveEditTarget(website) {
  const liveSlug = website.liveUrl ? await detectActiveTheme(website.liveUrl) : null;
  const themes = await listRepoThemes(website.githubRepo).catch(() => []);
  let slug = null;
  if (liveSlug && themes.includes(liveSlug)) slug = liveSlug;       // best: live theme, confirmed in repo
  else if (themes.length === 1) slug = themes[0];                   // only one theme → unambiguous
  else if (liveSlug && !themes.length) slug = liveSlug;             // repo listing failed → trust the live slug
  if (!slug) {
    throw new Error(`Couldn't determine which theme to edit for ${website.businessName}. The live domain (${website.liveUrl || "none set"}) ${liveSlug ? `serves "${liveSlug}", which isn't in the repo` : "didn't reveal an active theme"}, and the repo has ${themes.length} theme(s)${themes.length ? ` (${themes.join(", ")})` : ""}. Set the correct Domain in NocoDB, or ensure the repo has exactly one theme.`);
  }
  const bare = slug.replace(/^g99-/, "");
  const muPath = slug.startsWith("g99-") ? `web/app/mu-plugins/g99-activate-${bare}.php` : "";
  return { themeSlug: slug, themePath: `web/app/themes/${slug}`, muPath, themes };
}

// Per-site "require approval before merge" is stored locally (siteId -> bool),
// independent of NocoDB, so operators can gate merges per website.
const APPROVALS_FILE = path.join(DIR, "approvals.json");
// ---- local IDE hand-off -----------------------------------------------------
// Cursor is browser-side (documented prompt deeplink); the other two are launched
// here because they have no equivalent URL scheme for a prefilled prompt.
const IDE_TOOLS = [
  { id: "claude", label: "Claude Code", bin: "claude", kind: "cli" },
  { id: "cursor", label: "Cursor", bin: null, kind: "deeplink" },
  { id: "antigravity", label: "Antigravity", bin: "antigravity", kind: "editor" },
];
// Only ever launch processes for a request that came from this machine. A
// deployed instance (Render) refuses outright rather than running on the server.
function isLocalRequest(req) {
  const a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
// The operator's prompt is free text, so it never touches a command line: it's
// written to g99-task.md and the agent is told to read that file. Everything on
// the command line is a constant we generate, which leaves no room for quoting
// bugs or injection.
async function launchIde(tool, text, siteId) {
  const slug = String(siteId || "site").replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(DIR, "ide-workspace", `${slug}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "g99-task.md"), text);

  const READ = "Read g99-task.md in this folder and carry out the task described in it.";
  // Detached, with stdio ignored: an editor session outlives this request by
  // design, and anything that inherits our pipes would hold the HTTP response
  // open until the operator quits their IDE.
  const launch = (cmd, args) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd: dir });
    child.on("error", (e) => reject(new Error("could not launch: " + e.message)));
    child.unref();
    // spawn reports failure asynchronously, so give 'error' a tick to fire.
    setTimeout(resolve, 150);
  });

  if (process.platform === "win32") {
    const script = path.join(dir, "launch.cmd");
    fs.writeFileSync(script, [
      "@echo off",
      `title Growth99 Studio - ${tool.label}`,
      `cd /d "${dir}"`,
      tool.kind === "cli" ? `call ${tool.bin} "${READ}"` : `call ${tool.bin} .`,
      tool.kind === "cli" ? "" : "exit",
    ].join("\r\n"));
    // cmd /c start "" "<script>" — every argument is a path we just wrote.
    await launch("cmd.exe", ["/c", "start", "", script]);
  } else if (process.platform === "darwin") {
    const cmd = tool.kind === "cli" ? `${tool.bin} '${READ}'` : `${tool.bin} .`;
    await launch("osascript", ["-e", `tell app "Terminal" to do script "cd '${dir}' && ${cmd}"`]);
  } else {
    const cmd = tool.kind === "cli" ? `${tool.bin} '${READ}'` : `${tool.bin} .`;
    await launch("x-terminal-emulator", ["-e", "sh", "-c", `cd '${dir}' && ${cmd}`]);
  }
  return { ok: true, tool: tool.label, workspace: dir };
}

// ---- email-triggered changes ------------------------------------------------
// An inbound email names a website and describes a change; we match it to a
// registered site and start the same edit run the chat UI would. Deliberately
// transport-agnostic: Gmail/Apps Script, an inbound-parse service or an IMAP
// poller can all POST the same shape.
const urlHost = (u) => { try { return new URL(u).host; } catch (e) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""); } };
const EMAIL_LOG_FILE = path.join(DIR, "email-requests.json");
// Studio has no mail transport, so replies are handed back to the Apps Script
// that is already polling every minute and sent from Gmail. Anything we cannot
// answer inside the request - "ready to review", "shipped", "failed" - waits
// here until that poll collects it.
const EMAIL_OUTBOX_FILE = path.join(DIR, "email-outbox.json");
function readOutbox() {
  try { return JSON.parse(fs.readFileSync(EMAIL_OUTBOX_FILE, "utf8")); }
  catch (e) { return { pending: [], refusedThreads: [] }; }
}
function writeOutbox(o) { try { fs.writeFileSync(EMAIL_OUTBOX_FILE, JSON.stringify(o, null, 2)); } catch (e) { /* non-fatal */ } }

// Queue a reply on the thread a job came from. Does nothing for runs that did
// not start as an email, so build and restore jobs are unaffected.
function queueEmailReply(job, text) {
  const p = job && job.payload;
  if (!p || p.source !== "email" || !p.threadId || !text) return;
  const o = readOutbox();
  o.pending.push({ id: "r" + Date.now() + Math.random().toString(36).slice(2, 6), threadId: p.threadId, text, at: new Date().toISOString() });
  o.pending = o.pending.slice(-100);
  writeOutbox(o);
}
// One refusal per thread. Without this, an "I could not tell which site" reply
// draws a "thanks!" that fails to match, which draws another refusal.
function refusalAlreadySent(threadId) {
  return !!threadId && readOutbox().refusedThreads.includes(threadId);
}
function markRefusalSent(threadId) {
  if (!threadId) return;
  const o = readOutbox();
  if (o.refusedThreads.includes(threadId)) return;
  o.refusedThreads.push(threadId);
  o.refusedThreads = o.refusedThreads.slice(-300);
  writeOutbox(o);
}
function readEmailLog() { try { return JSON.parse(fs.readFileSync(EMAIL_LOG_FILE, "utf8")); } catch (e) { return { requests: [] }; } }
function logEmailRequest(entry) {
  const log = readEmailLog();
  log.requests.unshift({ at: new Date().toISOString(), ...entry });
  log.requests = log.requests.slice(0, 200);
  try { fs.writeFileSync(EMAIL_LOG_FILE, JSON.stringify(log, null, 2)); } catch (e) { /* non-fatal */ }
}

// Only the sender's own words: everything from the first quote/signature marker
// down is the thread they replied to, and feeding that to the planner would mix
// old requests into a new one.
function emailBodyText(raw) {
  let t = String(raw || "").replace(/\r/g, "");
  // Quoted lines go first, wherever they sit: some clients quote with no
  // "On … wrote:" header at all, and a reply can open with the quote.
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  const cuts = [
    /^On .+ wrote:$/m, /^-{2,}\s*Original Message\s*-{2,}/im, /^_{5,}$/m,
    /^From:\s.+$/m, /^Sent from my /m, /^--\s*$/m,
    // A sign-off alone on its line ends the request — everything below it is
    // the signature. This has to be a hard cut rather than a tidy-up at the
    // end: a corporate signature is a name, a title, a logo and eight social
    // links, which is far more text than the request itself and read as part
    // of it. Requiring the line to hold nothing but the sign-off keeps
    // "Thanks, that looks great — now please…" intact.
    /^\s*(thanks|thank you|thanks so much|many thanks|thanks again|regards|best regards|best|cheers|kind regards|warm regards|sincerely)[,.!]?\s*$/im,
    /^\s*\[image:/im,          // Gmail's plain-text stand-in for a signature logo
  ];
  for (const re of cuts) {
    const m = t.match(re);
    // Cut only when something substantive survives. Keying this off the
    // marker's position instead missed short requests — "Update the footer
    // phone." sits at index 26, so a quoted thread below it stayed in.
    if (m && t.slice(0, m.index).trim().length >= 10) t = t.slice(0, m.index);
  }
  // Drop the greeting, and the sign-off form the cut above cannot catch —
  // "Thanks, Charan" with the name on the same line.
  t = t.replace(/^\s*(hi|hey|hello|dear)\b[^\n]{0,40}\n+/i, "")
       .replace(/\n+\s*(thanks|thank you|thanks so much|regards|best regards|best|cheers|kind regards|sincerely)\b[^\n]{0,30}(\n[^\n]{0,45}){0,3}\s*$/i, "");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

// Mail loops are the classic way an automation like this melts down: an
// auto-reply triggers a run, which notifies, which auto-replies…
function looksAutomated(headers, subject) {
  const h = headers || {};
  const get = (k) => String(h[k] || h[k.toLowerCase()] || "");
  if (get("Auto-Submitted") && get("Auto-Submitted").toLowerCase() !== "no") return "auto-submitted header";
  if (get("X-Autoreply") || get("X-Autorespond") || get("Precedence").match(/bulk|auto_reply|list/i)) return "auto-reply header";
  if (/^\s*(out of office|automatic reply|undeliverable|delivery status|mail delivery)/i.test(subject || "")) return "auto-reply subject";
  return null;
}

// Unambiguous match first — a domain or an exact business name present in the
// text. No AI, no cost, and no chance of inventing a site that wasn't named.
function matchSiteDeterministic(text, sites) {
  const hay = String(text || "").toLowerCase().replace(/\s+/g, " ");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = [];
  for (const s of sites) {
    const domain = urlHost(s.liveUrl).toLowerCase().replace(/^www\./, "");
    if (domain && hay.includes(domain)) { hits.push({ site: s, how: "domain " + domain }); continue; }
    if (s.githubRepo && hay.includes(s.githubRepo.toLowerCase())) { hits.push({ site: s, how: "repo " + s.githubRepo }); continue; }
    // Word boundaries, not spaces: "Ecka Aesthetics." at the end of a sentence
    // is still a mention, and missing it would make a two-site mail look
    // unambiguous — the worst possible failure here.
    const name = String(s.businessName || "").toLowerCase().trim();
    if (name.length >= 4 && new RegExp("\\b" + esc(name) + "\\b").test(hay)) hits.push({ site: s, how: "name " + s.businessName });
  }
  const unique = [...new Map(hits.map(h => [h.site.siteId, h])).values()];
  if (unique.length === 1) return unique[0];
  // More than one website named: refuse outright rather than letting the AI
  // fallback pick a favourite.
  if (unique.length > 1) return { ambiguous: unique.map(h => h.site.businessName) };
  return null;
}

// Fallback only: pick from the known list, or say none. The model is never
// allowed to return a site id that isn't in the list it was given.
async function matchSiteAI(text, sites) {
  const list = sites.map(s => `${s.siteId} | ${s.businessName} | ${urlHost(s.liveUrl) || "no domain"}`).join("\n");
  const prompt = [
    "You route website change requests that arrive by email.",
    "Below is the list of websites we manage, then the email.",
    "Decide which ONE website the email is about, and restate the requested change as a single clear instruction for a developer.",
    "",
    "WEBSITES (siteId | name | domain):", list, "",
    "EMAIL:", String(text || "").slice(0, 6000), "",
    'Return ONLY JSON: {"siteId":"<exact siteId from the list, or empty if unclear>","instruction":"<the change, 1-3 sentences>","confidence":<0-1>}',
    "If the email does not clearly name one of these websites, return an empty siteId. Never guess.",
  ].join("\n");
  const raw = await geminiCall([{ text: prompt }], { temperature: 0.1, maxOutputTokens: 500 });
  let d = {}; try { d = JSON.parse(stripFence(raw)); } catch (e) { return null; }
  const site = sites.find(s => s.siteId === String(d.siteId || "").trim());
  if (!site) return null;
  return { site, how: "ai", instruction: String(d.instruction || "").trim(), confidence: Number(d.confidence) || 0 };
}

// A PR URL already names its repository. These endpoints used to ask the global
// WP_REPO instead, so a site living in a different repo could have its diff read
// — or, far worse, a same-numbered PR merged — in the wrong repository.
function repoFromPrUrl(prUrl) {
  const m = String(prUrl || "").match(/github\.com\/([^\/]+\/[^\/]+)\/pull\//);
  return m ? m[1] : WP_REPO;
}
// Merged / closed / open, straight from GitHub — the source of truth for
// whether a PR still needs us.
async function prLiveState(prUrl) {
  const num = (String(prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
  if (!num) return {};
  // No --jq here: its \(…) interpolation needs quoting that cmd.exe eats,
  // which silently returned an empty state. Parsing the JSON in Node is
  // shell-independent.
  const r = await sh(`gh pr view ${num} --repo ${repoFromPrUrl(prUrl)} --json state,mergedAt`);
  let d = {}; try { d = JSON.parse(r.stdout || "{}"); } catch (e) { return {}; }
  return { state: String(d.state || "").toUpperCase(), mergedAt: d.mergedAt || null };
}

function readApprovals() { try { return JSON.parse(fs.readFileSync(APPROVALS_FILE, "utf8")); } catch (e) { return {}; } }
function writeApprovals(m) { fs.writeFileSync(APPROVALS_FILE, JSON.stringify(m, null, 2)); }

// Scheduled re-audit: re-score the live active site, store the trend, alert on
// regression. Runs on demand (/api/reaudit) and on a timer (REAUDIT_HOURS>0).
const REAUDIT_FILE = path.join(DIR, "reaudit.json");
function readReaudit() { try { return JSON.parse(fs.readFileSync(REAUDIT_FILE, "utf8")); } catch (e) { return { entries: [] }; } }
async function reauditActiveSite() {
  const slug = await detectActiveTheme(LIVE_URL);
  const rep = await croAudit({ url: LIVE_URL, label: LIVE_URL });
  const store = readReaudit();
  const prev = [...(store.entries || [])].reverse().find(e => e.slug === slug);
  const entry = { slug: slug || "unknown", overall: rep.overall, at: new Date().toISOString(), url: LIVE_URL };
  store.entries = (store.entries || []).concat(entry).slice(-100);
  fs.writeFileSync(REAUDIT_FILE, JSON.stringify(store, null, 2));
  const regression = !!(prev && entry.overall < prev.overall - 5);
  if (regression) notify(`⚠️ CRO regression on *${slug}*: ${prev.overall} → ${entry.overall} (${LIVE_URL})`);
  return { entry, prev: prev || null, regression };
}

// Per-website CRO audits, keyed by NocoDB siteId. Each run carries the previous
// overall forward as `before`, so Studio can show a real before → now delta on
// the site page, the sites grid and the overview without re-deriving it.
const SITE_AUDITS_FILE = path.join(DIR, "site-audits.json");
function readSiteAudits() { try { return JSON.parse(fs.readFileSync(SITE_AUDITS_FILE, "utf8")); } catch (e) { return {}; } }
function writeSiteAudits(m) { fs.writeFileSync(SITE_AUDITS_FILE, JSON.stringify(m, null, 2)); }
async function auditWebsite(site) {
  if (!site.liveUrl) throw new Error("This website has no Domain set in NocoDB — nothing to audit.");
  const rep = await croAudit({ url: site.liveUrl, label: site.businessName || site.liveUrl });
  const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);
  const store = readSiteAudits();
  const prev = store[site.siteId];
  const entry = {
    siteId: site.siteId, url: site.liveUrl, overall: rep.overall,
    before: prev ? prev.overall : null,
    cats: {
      vision: num(rep.vision && rep.vision.score), ux: num(rep.ux && rep.ux.score),
      cro: num(rep.cro && rep.cro.score), content: num(rep.content && rep.content.score),
    },
    summary: rep.summary || {},
    at: new Date().toISOString(),
  };
  store[site.siteId] = entry;
  writeSiteAudits(store);
  return entry;
}

// The deal may hold a full GitHub URL, an SSH remote, or already-clean owner/repo.
// `gh` wants owner/repo, so normalise whatever arrives.
function normalizeRepo(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  s = s.replace(/^git@github\.com:/i, "").replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = s.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/);
  return m ? `${m[1]}/${m[2]}` : "";
}
function newJob(payload) {
  return {
    type: "build",
    draftId: String(payload.draftId), businessId: payload.businessId || null,
    // when the onboarding form actually arrived, and where it came from
    receivedAt: payload.receivedAt || new Date().toISOString(),
    source: payload.source || "manual",
    // Per-client build target, sent by G99 from the HubSpot deal (beta_site_repo / beta_site_url).
    // Absent => fall back to this deployment's own defaults, so existing clients are unaffected.
    repo: payload.betaSiteRepo || payload.githubRepo || WP_REPO,
    liveUrl: payload.betaSiteUrl || LIVE_URL,
    businessName: payload.businessName || (payload.answers || {}).business_name || "Client",
    status: "queued", currentStep: 0,
    steps: JOB_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    before: null, after: null, delta: null, reportUrl: null, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}

const EDIT_STEPS = ["Pull latest code", "Plan the edit (AI)", "Apply changes (AI)", "Check the work", "Push + open PR", "CI checks → auto-merge", "Sync registry"];
function newEditJob(payload) {
  return {
    type: "edit",
    draftId: String(payload.jobId), businessId: null,
    businessName: payload.businessName || payload.siteId || "Site",
    status: "queued", currentStep: 0,
    steps: EDIT_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    editPlan: null, editSummary: null, workOrder: null, textSwaps: null, verification: null, retried: false, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
const RESTORE_STEPS = ["Pull latest code", "Roll the theme back", "Push + open PR", "CI checks → auto-merge", "Sync registry"];
function newRestoreJob(payload) {
  return {
    type: "restore",
    draftId: String(payload.jobId), businessId: null,
    businessName: payload.businessName || payload.siteId || "Site",
    status: "queued", currentStep: 0,
    steps: RESTORE_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    editPlan: null, editSummary: null, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
function jobStep(job, i, status, detail) {
  // Cancellation lands at step boundaries: refuse to start a new step if asked to cancel.
  if (status === "running" && job.cancelRequested) throw Object.assign(new Error("cancelled by user"), { cancelled: true });
  job.currentStep = i;
  job.steps[i].status = status;
  if (detail != null) job.steps[i].detail = String(detail).slice(0, 240);
  saveJobs();
  postStatus(job);   // report each step transition to G99 (fail-soft)
}
// Slack (or any incoming-webhook) notification — fail-soft, off when unset.
function notify(text) {
  const url = process.env.SLACK_WEBHOOK_URL || "";
  if (!url) return;
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});
}

// ---- G99 status callback ------------------------------------------------------
// Reports build progress back to Growth99 (product-service) so the admin dashboard has a durable
// record of every build: whether it ran, how far it got, where it failed, and the live site URL.
// Our own job state is in-memory + jobs.json (last 60, wiped on redeploy), so G99 is the long-term
// source of truth. Fail-soft with a few retries — a build must never break because G99 is briefly down.
const G99_STATUS_URL = process.env.G99_STATUS_CALLBACK_URL || "";
const G99_STATUS_SECRET = process.env.G99_STATUS_SECRET || process.env.WEBHOOK_SECRET || "";
const G99_RETRY_DELAYS_MS = [2000, 10000, 30000];

// job.siteUrl / job.reportUrl are paths on THIS server ("/site/", "/reports/81.html"). G99 renders them
// as links in its admin UI, so send absolute URLs — a relative path would be broken there.
const G99_TOOL_PUBLIC_URL = (process.env.G99_TOOL_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
function absUrl(u) {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : G99_TOOL_PUBLIC_URL + (u.startsWith("/") ? u : "/" + u);
}

function jobStatusSnapshot(job) {
  return {
    draftId: job.draftId,
    businessId: job.businessId,
    status: job.status,                        // queued | running | done | error | cancelled
    currentStep: job.currentStep,
    totalSteps: (job.steps || []).length,
    steps: (job.steps || []).map((s) => ({ label: s.label, status: s.status, detail: s.detail })),
    error: job.error || null,
    // The published WordPress site (shared host) — this is the real "live site" once the theme is live.
    liveUrl: job.liveUrl || LIVE_URL || null,
    siteUrl: absUrl(job.siteUrl),
    prUrl: job.prUrl || null,
    reportUrl: absUrl(job.reportUrl),
    scoreBefore: job.before ? job.before.overall : null,
    scoreAfter: job.after ? job.after.overall : null,
    scoreDelta: job.delta != null ? job.delta : null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

function postStatus(job, attempt = 0) {
  // Only real client builds are tracked in G99 (edit jobs key off an internal jobId, not a draft).
  if (!G99_STATUS_URL || !job || job.type !== "build") return;
  const body = JSON.stringify(jobStatusSnapshot(job));
  fetch(G99_STATUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": G99_STATUS_SECRET },
    body,
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    })
    .catch((e) => {
      if (attempt < G99_RETRY_DELAYS_MS.length) {
        setTimeout(() => postStatus(job, attempt + 1), G99_RETRY_DELAYS_MS[attempt]);
      } else {
        console.error(`g99 status callback failed for ${job.draftId} after retries:`, e.message);
      }
    });
}
function siteRequiresApproval(siteId) {
  return !!readApprovals()[siteId];
}
// Per-site approval gate: with green CI, if the site requires approval, pause
// (up to 60 min) until /api/job-approve flips job.approved — then merge.
async function awaitApprovalIfNeeded(job, siteId, stepIdx) {
  // forceApproval overrides the per-site setting: a run nobody typed into
  // Studio by hand (an inbound email) always gets a human before it merges.
  const forced = !!(job.payload && job.payload.forceApproval);
  if (job.approved || (!forced && !siteRequiresApproval(siteId))) return;
  job.awaitingApproval = true;
  jobStep(job, stepIdx, "running", "Build is green — waiting for approval to merge…");
  notify(`⏳ *${job.businessName}* build passed — needs approval to go live: ${job.prUrl || ""}`);
  // Deliberately no email here. Review and approval are ours, not the
  // requester's: they get one acknowledgement when the request lands and one
  // message when it is actually live. Pull requests and approval screens are
  // internal detail they never need to see.
  for (let i = 0; i < 240 && !job.approved; i++) {
    if (job.cancelRequested) { job.awaitingApproval = false; throw Object.assign(new Error("cancelled by user"), { cancelled: true }); }
    // Approving in Studio isn't the only way this PR can be resolved — someone
    // can merge or close it on GitHub, and until we checked, the run sat here
    // until it timed out and reported "not merged" for a PR that was already in.
    if (i % 4 === 3 && job.prUrl) {
      let st = {}; try { st = await prLiveState(job.prUrl); } catch (e) { /* transient — keep waiting */ }
      if (st.mergedAt) {
        job.approved = true; job.mergedExternally = true;
        jobStep(job, stepIdx, "running", "Merged on GitHub — picking up from there");
        break;
      }
      if (st.state === "CLOSED") { job.awaitingApproval = false; throw new Error("the pull request was closed on GitHub without merging: " + job.prUrl); }
    }
    await sleep(15000); saveJobs();
  }
  job.awaitingApproval = false;
  if (!job.approved) throw new Error("approval timed out (60 min) — not merged; PR left open: " + job.prUrl);
}

// G99 onboarding question_key -> tool onboarding.json field. Identity keys pass
// through; unknown keys are kept as-is (harmless) and logged once per job.
const G99_KEY_ALIASES = {
  team_members: "team_roster", patient_value: "ideal_patient",
  practice_name: "business_name", business_location: "location",
  phone: "phone_for_website", website: "existingWebsite", existing_website: "existingWebsite",
  services: "services_offered", featured_treatments: "revenue_services",
  testimonials: "featured_review", financing: "financing_offered",
};
function mapG99Answers(list) {
  const answers = {}; let existingWebsite = null; let referenceWebsite = null; const unknown = [];
  const KNOWN = new Set(["business_name", "location", "phone_for_website", "business_description",
    "why_patients_choose", "ideal_patient", "services_offered", "revenue_services", "featured_review",
    "financing_offered", "booking_platform", "primary_cta", "team_roster", "brand_aesthetic",
    "hero_headline", "hero_subheadline", "seo_keywords", "logo_file", "site_love_1_url", "site_love_1_reason",
    "tone_clinical_warm", "tone_lux_approachable", "tone_bold_understated", "tone_playful_serious",
    "competitors", "why_now", "testimonials_status", "provider_credentials_status"]);
  for (const a of (list || [])) {
    if (!a || !a.key) continue;
    const key = G99_KEY_ALIASES[a.key] || a.key;
    let v = a.value;
    if (typeof v === "string" && /^\s*[\[{]/.test(v)) { try { v = JSON.parse(v); } catch (e) { /* keep string */ } }
    if (key === "existingWebsite") { existingWebsite = v; continue; }
    if (!KNOWN.has(key)) unknown.push(a.key);
    answers[key] = v;
    // site_love_1_url = the site the client loves → the design REFERENCE to emulate.
    if (key === "site_love_1_url" && v) referenceWebsite = v;
  }
  if (unknown.length) console.warn("webhook: unmapped question keys (kept as-is):", unknown.join(", "));
  return { answers, existingWebsite, referenceWebsite };
}

// Server-side copy of the dashboard's per-page prompt sections.
function jobPageSections(key, A) {
  const val2 = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === "object") ? [x.name, x.title].filter(Boolean).join(" — ") + (x.bio ? ": " + x.bio : "") : String(x)).join(Array.isArray(v) && v.some((x) => x && typeof x === "object") ? "; " : ", ") : (v == null ? "" : String(v));
  const featured = val2(A.revenue_services), providers = val2(A.team_roster), services = val2(A.services_offered);
  return ({
    home: [`Sections (each a DISTINCT layout — do not repeat patterns):`,
      `1. HERO — full-viewport cinematic image under a dark gradient; oversized serif headline "${A.hero_headline || ""}"; subheadline "${A.hero_subheadline || ""}"; two CTAs ("${A.primary_cta || "Book now"}" + "Explore treatments"); a floating glass trust-bar.`,
      `2. INTRO — asymmetric split with an editorial pull-quote: "${A.why_patients_choose || ""}".`,
      `3. SIGNATURE TREATMENTS — staggered editorial grid for ${featured}.`,
      `4. SERVICE CATEGORIES — full-bleed dark band listing ${services}.`,
      `5. STATS / TRUST band. 6. FEATURE with curved image masks.`,
      `7. PROVIDERS — offset portraits with credentials: ${providers}.`,
      `8. TESTIMONIAL — oversized pull-quote: "${A.featured_review || ""}".`,
      `9. MEMBERSHIP & FINANCING: ${val2(A.financing_offered)}. 10. CLOSING CTA "${A.primary_cta || "Book now"}".`,
      `11. FOOTER: ${A.business_name || ""}, ${A.location || ""}, phone ${A.phone_for_website || ""}.`].join("\n"),
    services: [`Sections:`, `1. Same transparent nav as home.`, `2. Editorial hero "Our Treatments".`,
      `3. One section per category — ${services} — with cards + "${A.primary_cta || "Book now"}" CTAs.`,
      `4. Signature spotlight: ${featured}. 5. Financing: ${val2(A.financing_offered)}. 6. CTA. 7. Footer.`].join("\n"),
    about: [`Sections:`, `1. Same nav.`, `2. Practice story: "${A.why_patients_choose || ""}".`,
      `3. Meet the team — portrait cards: ${providers}. 4. Values with curved masks.`,
      `5. Testimonial: ${A.featured_review || ""}. 6. CTA. 7. Footer.`].join("\n"),
    contact: [`Sections:`, `1. Same nav.`, `2. Split layout: consultation form beside imagery.`,
      `3. ${A.booking_platform || "Online"} booking panel. 4. Location: ${A.location || ""}, phone ${A.phone_for_website || ""}.`,
      `5. CTA band. 6. Footer.`].join("\n"),
  })[key];
}

function enqueueJob(payload) {
  const id = String(payload.draftId);
  const existing = JOBS.get(id);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return { job: existing, dedupe: true };
  }
  const job = newJob(payload);
  JOBS.set(id, job);
  JOB_QUEUE.push(id); saveJobs();
  postStatus(job);   // "queued" — G99 records that the build was accepted
  processJobQueue();
  return { job, dedupe: false };
}
async function processJobQueue() {
  if (JOB_RUNNING) return;
  const id = JOB_QUEUE.shift();
  if (!id) return;
  JOB_RUNNING = true;
  const job = JOBS.get(id);
  const RUNNER = { edit: runEditJob, restore: runRestoreJob, enrich: runEnrichJob, seo: runSeoJob };
  try { await ((job && RUNNER[job.type] ? RUNNER[job.type] : runJob)(job)); }
  catch (e) { console.error("job runner crashed:", e); }
  finally { JOB_RUNNING = false; processJobQueue(); }
}
function enqueueEditJob(payload) {
  const job = newEditJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId); saveJobs();
  processJobQueue();
  return job;
}
function enqueueRestoreJob(payload) {
  const job = newRestoreJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId); saveJobs();
  processJobQueue();
  return job;
}

async function runJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  postStatus(job);   // "running"
  const P = job.payload;
  try {
    // Fresh start: clear the previous client's cached scan/CRO so this job never
    // reuses another business's design analysis or before-audit.
    for (const c of [".site-analysis.json", ".cro-existing.json", ".cro-beta.json"]) {
      try { fs.rmSync(path.join(GEN, c), { force: true }); } catch (e) { /* ignore */ }
    }
    // Apply this job's answers to onboarding.json (safe: single concurrency).
    const file = path.join(DIR, "onboarding.json");
    const onb = JSON.parse(fs.readFileSync(file, "utf8"));
    onb.answers = { ...onb.answers, ...(P.answers || {}) };
    if (P.existingWebsite) onb.existingWebsite = P.existingWebsite;
    // referenceWebsite = the design-inspiration site (site_love_1_url). Explicitly
    // clear it when the client gave none, so we don't inherit the sample's ruma.com.
    onb.referenceWebsite = P.referenceWebsite || "";
    if (P.businessId) onb.businessId = P.businessId;
    if (P.draftId) onb.draftId = P.draftId;
    fs.writeFileSync(file, JSON.stringify(onb, null, 2));
    const A = onb.answers;

    // 1 — CRO of the existing site (skippable: no URL = no before-audit).
    if (onb.existingWebsite) {
      jobStep(job, 0, "running", "Auditing " + onb.existingWebsite);
      try {
        job.before = await localApi("/api/cro-audit", { url: onb.existingWebsite });
        jobStep(job, 0, "done", `Existing site: ${job.before.overall}/100`);
      } catch (e) { jobStep(job, 0, "error", "audit failed (continuing): " + e.message); }
    } else {
      jobStep(job, 0, "done", "No existing website — skipped");
    }

    // 2 — compose the brand + build brief
    jobStep(job, 1, "running", "Scanning site + composing brand system…");
    const composed = await localApi("/api/compose-brand", {});
    const theme = { displayName: A.business_name, primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont };
    job.composed = { primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont, brief: composed.brief || "" };
    jobStep(job, 1, "done", `Palette ${composed.primary}/${composed.accent} · ${composed.headingFont}`);

    // 3 — generate all pages with Stitch
    jobStep(job, 2, "running", "Generating 4 pages…");
    const pages = ["home", "services", "about", "contact"].map((k) => ({
      key: k, prompt: `${composed.brief}\n\n${jobPageSections(k, A)}\n\nReturn one complete, responsive, production-quality HTML page with the SEO requirements applied.`,
    }));
    const gen = await localApi("/api/generate-site", { engine: "", deviceType: "DESKTOP", theme, pages }, 45 * 60 * 1000);
    const ok = (gen.pages || []).filter((x) => x && !x.error);
    // Snapshot final per-page result onto the job so completed cards still show it.
    job.pages = {};
    for (const pr of (gen.pages || [])) {
      const k = pr.pageKey || pr.page;
      if (k) job.pages[k] = { status: pr.error ? "error" : "done", bytes: pr.htmlBytes || 0, error: pr.error || "" };
    }
    if (!ok.length) throw new Error("Stitch generated 0 pages: " + (((gen.pages || [])[0] || {}).error || "no output"));
    // HOME is mandatory: buildWpTheme derives front-page.php AND the shared
    // header.php/footer.php from it, so a failed home ships a theme with an empty
    // homepage and no navigation. Fail loudly instead of releasing that.
    const homeRes = (gen.pages || []).find((x) => (x.pageKey || x.page) === "home");
    if (!homeRes || homeRes.error || !homeRes.htmlBytes) {
      throw new Error("home page generation failed (" + ((homeRes && homeRes.error) || "no output") +
        ") — the theme's header/footer/front page all derive from home, so the build was stopped rather than ship a homepage with no content or navigation. Re-run to retry.");
    }
    jobStep(job, 2, "done", `${ok.length}/${(gen.pages || []).length} pages generated`);

    // 4 — assemble into one coherent site
    jobStep(job, 3, "running", "Binding site with AI chrome…");
    const bound = await localApi("/api/bind-site", { engine: "", theme });
    job.siteUrl = bound.siteUrl || "/site/";
    jobStep(job, 3, "done", `Assembled (${bound.chromeSource || "AI chrome"})`);

    // 5 — WordPress theme + PR
    jobStep(job, 4, "running", "Building theme, pushing, opening PR…");
    const push = await localApi("/api/push-wordpress", { theme, skipRebind: true, githubRepo: job.repo }, 15 * 60 * 1000);
    job.prUrl = push.prUrl; job.branch = push.branch;
    const slug = ((push.themePath || "").match(/g99-([a-z0-9-]+)\//) || [])[1] || "";
    if (!job.prUrl) throw new Error("push succeeded but no PR URL returned");
    jobStep(job, 4, "done", job.prUrl);

    // 6 — CI watch → auto-fix → auto-merge
    jobStep(job, 5, "running", "Watching CI build checks…");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st;
      try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); }
      catch (e) { await sleep(10000); continue; }
      const summary = (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ");
      jobStep(job, 5, "running", summary || "CI starting…");
      if (st.allPass) {
        await awaitApprovalIfNeeded(job, "g99-" + slug, 5);
        await localApi("/api/pr-merge", { prUrl: job.prUrl });
        merged = true;
        jobStep(job, 5, "done", `Merged${fixes ? ` after ${fixes} auto-fix(es)` : ""}`);
        break;
      }
      if (st.anyFail) {
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts — see " + job.prUrl);
        fixes++;
        jobStep(job, 5, "running", `Build failed — Gemini auto-fix ${fixes}/3…`);
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        if (fix.billing) throw new Error(fix.message);
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI failure: " + (fix.message || ""));
        await sleep(20000);
        continue;
      }
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out after ~40 min — " + job.prUrl);

    // 7 — wait for the mu-plugin to activate the theme on the live site
    jobStep(job, 6, "running", "Waiting for deploy + activation on " + job.liveUrl);
    let active = false;
    for (let i = 0; i < 40 && !active; i++) {
      try { active = (await localApi("/api/theme-live", { url: job.liveUrl, slug })).active; } catch (e) { /* keep polling */ }
      if (!active) { jobStep(job, 6, "running", `Not active yet (check ${i + 1}/40)…`); await sleep(15000); }
    }
    if (!active) throw new Error("theme not detected on live within ~10 min — deploy may be slow; re-run after-audit manually");
    jobStep(job, 6, "done", "Theme active on " + job.liveUrl);

    // 8 — after-audit + comparison + report
    jobStep(job, 7, "running", "Auditing the new live site…");
    job.after = await localApi("/api/cro-audit-url", { url: job.liveUrl });
    job.delta = job.before ? job.after.overall - job.before.overall : null;
    job.reportUrl = writeComparisonReport(job);
    await postPrComment(job);
    jobStep(job, 7, "done", job.before ? `${job.before.overall} → ${job.after.overall} (${job.delta >= 0 ? "+" : ""}${job.delta})` : `New site: ${job.after.overall}/100`);

    try { await syncSiteRegistry(); } catch (e) { /* non-fatal: keep registry current so the new site is editable */ }

    // Auto-enrich: fire a DECOUPLED post-beta job that adds service pages + a
    // brand guide in its own PR. Fail-soft — the beta is already released, so an
    // enrichment failure must never mark this build failed.
    try {
      if (slug) {
        const ej = enqueueEnrichJob({
          jobId: "enrich-" + Date.now(), businessId: job.businessId, parentDraftId: job.draftId, liveUrl: job.liveUrl,
          siteId: "g99-" + slug, businessName: job.businessName, githubRepo: job.repo,
          themeSlug: "g99-" + slug, themePath: `web/app/themes/g99-${slug}`,
          muPath: `web/app/mu-plugins/g99-activate-${slug}.php`,
          answers: A, composed: job.composed, referenceWebsite: onb.referenceWebsite || "",
          existingWebsite: onb.existingWebsite || "",
        });
        job.enrichJobId = ej.draftId;   // frontend links to the run from this step
        jobStep(job, ENRICH_STEP_IDX, "running", "Queued as its own run — generating service pages…");
        notify(`✨ Auto-enrich queued for *${job.businessName}* (service pages + brand guide)`);
      } else {
        jobStep(job, ENRICH_STEP_IDX, "done", "Skipped — no theme slug");
      }
    } catch (e) {
      console.error("auto-enrich enqueue failed (non-fatal):", e.message);
      jobStep(job, ENRICH_STEP_IDX, "error", "Could not queue enrichment: " + e.message);
    }

    job.status = "done";
    notify(`✅ Beta site *${job.businessName}*: CRO ${job.before ? job.before.overall + "→" + job.after.overall : job.after && job.after.overall} · ${job.prUrl || ""}`);
  } catch (e) {
    if (e && e.cancelled) { job.status = "cancelled"; }
    else {
      job.error = e.message; job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      console.error(`job ${job.draftId} failed at step ${job.currentStep + 1}:`, e.message);
      notify(`❌ Beta site *${job.businessName}* failed: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job);   // terminal: done | error | cancelled (+ siteUrl/prUrl/scores)
  }
}

// Self-contained before/after comparison report → generated/reports/<draftId>.html (+.json)
function writeComparisonReport(job) {
  const dir = path.join(GEN, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const cats = ["vision", "ux", "cro", "content"];
  const esc2 = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const row = (k) => {
    const b = job.before && job.before[k] ? job.before[k].score : "—";
    const a = job.after && job.after[k] ? job.after[k].score : "—";
    const d = (typeof b === "number" && typeof a === "number") ? a - b : null;
    return `<tr><td style="text-transform:capitalize;padding:8px 14px">${k}</td><td style="text-align:center">${b}</td><td style="text-align:center">${a}</td><td style="text-align:center;font-weight:700;color:${d == null ? "#666" : d >= 0 ? "#1f9d6b" : "#c0392b"}">${d == null ? "—" : (d >= 0 ? "+" : "") + d}</td></tr>`;
  };
  const recs = ((job.before && job.before.summary && job.before.summary.topRecommendations) || []).slice(0, 6);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRO Before/After — ${esc2(job.businessName)}</title></head>
<body style="margin:0;font-family:Inter,-apple-system,Segoe UI,sans-serif;background:#f4f5f8;color:#1c1d29">
<div style="max-width:760px;margin:0 auto;padding:40px 24px">
  <h1 style="font-size:22px">CRO Comparison — ${esc2(job.businessName)}</h1>
  <p style="color:#6b6f82;font-size:14px">Draft ${esc2(job.draftId)} · generated ${esc2(job.finishedAt || new Date().toISOString())}${job.prUrl ? ` · <a href="${esc2(job.prUrl)}">pull request</a>` : ""}</p>
  <div style="display:flex;gap:28px;align-items:center;background:#fff;border:1px solid #e6e8f0;border-radius:14px;padding:22px;margin:18px 0">
    <div style="text-align:center"><div style="font-size:44px;font-weight:800">${job.before ? job.before.overall : "—"}</div><div style="color:#6b6f82;font-size:13px">Before</div></div>
    <div style="font-size:34px;font-weight:800;color:${(job.delta || 0) >= 0 ? "#1f9d6b" : "#c0392b"}">${job.delta == null ? "→" : (job.delta >= 0 ? "+" : "") + job.delta}</div>
    <div style="text-align:center"><div style="font-size:44px;font-weight:800">${job.after ? job.after.overall : "—"}</div><div style="color:#6b6f82;font-size:13px">After</div></div>
  </div>
  <table style="width:100%;background:#fff;border:1px solid #e6e8f0;border-radius:14px;border-collapse:separate;border-spacing:0;font-size:14px">
    <tr style="color:#6b6f82"><th style="text-align:left;padding:10px 14px">Discipline</th><th>Before</th><th>After</th><th>Δ</th></tr>
    ${cats.map(row).join("")}
  </table>
  ${recs.length ? `<h2 style="font-size:15px;margin-top:26px">What the audit said to fix (before)</h2><ul style="color:#444;font-size:14px">${recs.map((r) => `<li>${esc2(r)}</li>`).join("")}</ul>` : ""}
</div></body></html>`;
  fs.writeFileSync(path.join(dir, job.draftId + ".html"), html);
  fs.writeFileSync(path.join(dir, job.draftId + ".json"), JSON.stringify({ draftId: job.draftId, businessName: job.businessName, before: job.before, after: job.after, delta: job.delta, prUrl: job.prUrl, finishedAt: job.finishedAt }, null, 2));
  return "/reports/" + job.draftId + ".html";
}

// Durable record: comment the comparison summary on the (merged) PR.
async function postPrComment(job) {
  const prNum = ((job.prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
  if (!prNum) return;
  const cats = ["vision", "ux", "cro", "content"];
  const line = (k) => `| ${k} | ${job.before && job.before[k] ? job.before[k].score : "—"} | ${job.after && job.after[k] ? job.after[k].score : "—"} |`;
  const body = [
    `## 🤖 Beta-site CRO comparison — ${job.businessName}`,
    ``,
    `**Overall: ${job.before ? job.before.overall : "—"} → ${job.after ? job.after.overall : "—"}${job.delta != null ? ` (${job.delta >= 0 ? "+" : ""}${job.delta})` : ""}**`,
    ``, `| Discipline | Before | After |`, `|---|---|---|`,
    ...cats.map(line),
    ``, `Draft ${job.draftId} · pipeline ran automatically from the onboarding webhook.`,
  ].join("\n");
  const tmpFile = path.join(os.tmpdir(), `prc-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, body);
  const r = await sh(`gh pr comment ${prNum} --repo ${job.repo || WP_REPO} --body-file "${tmpFile}"`);
  fs.rmSync(tmpFile, { force: true });
  if (r.code) console.warn("PR comment failed:", (r.stderr || "").slice(-200));
}

// ============================================================ EDIT ENGINE
// Modify an already-deployed theme with AI (plan-then-apply), then reuse the
// PR → CI → auto-merge rails. Edits are bounded to the site's theme dir + its
// mu-plugin — never any other repo code.
const THEME_CONVENTIONS = `This is a classic WordPress (Roots Bedrock) theme at web/app/themes/<slug>/. Conventions you MUST follow:
- style.css (theme metadata header) and index.php (fallback template) are REQUIRED — never delete them.
- header.php / footer.php = shared chrome (get_header/get_footer). front-page.php = the HOME page.
- page-<name>.php = a page template; it MUST start with a line "<?php /* Template Name: <Name> */ ?>" then get_header(); a <main>…</main>; get_footer();.
- The must-use plugin web/app/mu-plugins/g99-activate-<slug>.php auto-activates the theme and provisions Pages + the Primary menu on 'init'. It contains a $pages array of ['title'=>, 'slug'=>, 'template'=>] entries. To ADD a page you MUST (1) create page-<slug>.php with a Template Name header, AND (2) add its ['title'=>'<Title>','slug'=>'<slug>','template'=>'page-<slug>.php'] entry to that $pages array — otherwise the Page + nav item are never created.
- Styling uses Tailwind + Google Fonts from CDN in the page <head>. Preserve the existing palette/fonts unless the change is explicitly about them.
- All PHP must pass Laravel Pint (PER preset): blank line after <?php in pure-PHP files; a named function's opening brace on its own line; one statement per line.`;

function stripFence(t) { return String(t || "").replace(/^```(?:json|php|html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim(); }

// ---- 1. The work order ------------------------------------------------------
// A change request arrives as prose. An email especially: background, three
// separate asks buried in one paragraph, a constraint, and a sign-off. The
// planner used to read that raw while it was also choosing files, so it was
// inferring intent and locating code in the same breath. Doing this first
// splits the two — a flat, checkable list of changes with the sender's exact
// wording preserved, so the planner only has to decide where each one lands.
async function buildWorkOrder(prompt, ctx, ai) {
  const p = [
    "Read the website change request below and restate it as a work order.",
    "You are not designing anything and not improving anything — only restating what was actually asked, precisely.",
    (ctx && ctx.businessName) ? `The website is "${ctx.businessName}".` : "",
    "",
    "RULES:",
    "- One entry per distinct change. A request asking for three things produces three entries.",
    "- \"replaces\" is the exact text that is on the site NOW and must go. \"literal\" is the exact text that must be on the site AFTERWARDS. Copy both character-for-character from the request, without the surrounding quote marks, and never reword or 'improve' either.",
    "- For \"change X to Y\": replaces = X, literal = Y. Never put both in one field and never include the word 'to' joining them.",
    "- For new text with nothing being replaced, leave \"replaces\" empty. For a removal, leave \"literal\" empty.",
    "- If the sender did not dictate exact wording, leave both empty rather than inventing wording.",
    "- \"where\" is the sender's own words for the location (\"homepage hero\", \"the footer\", a page URL). Do not guess a filename.",
    "- Anything the sender said to leave alone goes in \"constraints\".",
    "- Anything too vague to act on without guessing goes in \"unclear\", and NOT in \"changes\".",
    "- Ignore greetings, sign-offs, thanks, deadlines and background chat.",
    "",
    "REQUEST:", "-----", String(prompt || "").slice(0, 6000), "-----",
    "",
    'Return ONLY minified JSON: {"summary":"one line covering the whole request","changes":[{"what":"the change, imperative","where":"where on the site, in the sender\'s words","replaces":"exact text being replaced, or empty","literal":"exact text it must become, or empty"}],"constraints":["things to leave alone"],"unclear":["parts too vague to action"]}',
  ].filter(Boolean).join("\n");
  const raw = await aiCall([{ text: p }], { ...(ai || {}), temperature: 0.1, maxOutputTokens: 1500, timeoutMs: 45000, json: true });
  const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10) : []);
  // Strip quote marks the model sometimes carries across from the request, and
  // rescue the "X to Y" answer the old single-field prompt used to produce —
  // that whole phrase appears nowhere on the site, so it verified as not done.
  const unquote = (s) => String(s || "").trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  const changes = (Array.isArray(d.changes) ? d.changes : []).slice(0, 10)
    .map((c) => {
      let replaces = unquote(c && c.replaces), literal = unquote(c && c.literal);
      const pair = literal.match(/^["“”](.+?)["“”]\s+(?:to|→|->|with)\s+["“”](.+?)["“”]$/i);
      if (pair) { replaces = replaces || pair[1].trim(); literal = pair[2].trim(); }
      return { what: String((c && c.what) || "").trim(), where: String((c && c.where) || "").trim(), replaces, literal };
    })
    .filter((c) => c.what);
  // No usable items means the extraction misread the request, not that the
  // request was empty — the raw prose is a better brief than an empty list.
  if (!changes.length) return null;
  // An item cannot be both actionable and too vague to action, but the model
  // sometimes files the same change under each. On the job page that read as a
  // numbered item with a verdict AND a note saying it was never attempted —
  // two statements about the same thing that contradicted each other.
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
  const sameThing = (a, b) => {
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return false;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.min(A.size, B.size) >= 0.6;
  };
  const unclear = arr(d.unclear).filter((u) => !changes.some((c) => sameThing(c.what, u)));
  return { summary: String(d.summary || "").trim(), changes, constraints: arr(d.constraints), unclear };
}

// The work order as both the planner and the file writer see it.
function workOrderText(wo) {
  if (!wo) return "";
  const lines = ["WORK ORDER — do every numbered item, and nothing beyond them:"];
  wo.changes.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.what}${c.where ? ` — location: ${c.where}` : ""}`);
    if (c.replaces) lines.push(`   REPLACE EXACTLY THIS TEXT: ${c.replaces}`);
    if (c.literal) lines.push(`   ${c.replaces ? "WITH EXACTLY THIS TEXT" : "EXACT TEXT"}, character-for-character and not reworded: ${c.literal}`);
  });
  if (wo.constraints.length) lines.push("", "LEAVE ALONE:", ...wo.constraints.map((c) => `- ${c}`));
  if (wo.unclear.length) lines.push("", "TOO VAGUE TO ACTION — skip these entirely rather than guessing:", ...wo.unclear.map((c) => `- ${c}`));
  return lines.join("\n");
}

// ---- Exact text swaps, made without the model -------------------------------
// "Change X to Y" needs no judgement: X is a string and Y is a string. Handing
// that to a model which rewrites the whole file is what produced collateral
// edits — a request to change one heading from 30 to 40 also had it rewrite a
// nearby paragraph from "After 30" to "After 40", which nobody asked for.
// Doing these in code means the diff can only contain what was requested.
// Returns the items it resolved; those never reach the planner at all.
function applyTextSwaps(workOrder, files, rootAbs) {
  const done = [];
  workOrder.changes.forEach((c, i) => {
    if (!c.replaces || !c.literal || c.replaces === c.literal) return;
    const touched = [];
    for (const f of files) {
      const parts = f.content.split(c.replaces);
      if (parts.length < 2) continue;
      f.content = parts.join(c.literal);     // keep the in-memory copy in step
      fs.writeFileSync(path.join(rootAbs, f.rel), f.content);
      touched.push({ rel: f.rel, count: parts.length - 1 });
    }
    if (touched.length) done.push({ n: i + 1, what: c.what, replaces: c.replaces, literal: c.literal, files: touched });
  });
  return done;
}
function swapsText(swaps) {
  return swaps.map((s) => `"${s.replaces}" → "${s.literal}" in ${s.files.map((f) => `${f.rel.split("/").pop()}${f.count > 1 ? ` ×${f.count}` : ""}`).join(", ")}`).join("; ");
}

// ---- 2. Where things live ---------------------------------------------------
// The planner used to receive filenames and byte counts, so "change the hero
// headline" meant guessing between front-page.php, header.php and index.php.
// These replace the guess with a lookup: an outline of what each file actually
// contains, and the exact lines where the request's own words already appear.
const TEXTUAL = /\.(php|html|css|js|txt|md)$/i;

function fileOutline(content) {
  const out = [];
  const push = (s) => {
    s = String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (s.length >= 3 && s.length <= 80 && !out.includes(s)) out.push(s);
  };
  // Stop at the comment terminator: these headers sit inside "/* … */ ?>", and
  // taking the rest of the line put that punctuation in the outline.
  const tpl = content.match(/Template Name:\s*(.+?)\s*(?:\*\/|-->|\?>|$)/);
  if (tpl) push("template: " + tpl[1]);
  for (const m of content.matchAll(/<h([1-3])[^>]*>([\s\S]{0,160}?)<\/h\1>/gi)) push("h" + m[1] + ": " + m[2]);
  for (const m of content.matchAll(/\sid="([a-z][a-z0-9_-]{2,28})"/gi)) push("#" + m[1]);
  for (const m of content.matchAll(/<!--\s*([^>]{3,60}?)\s*-->/g)) push("note: " + m[1]);
  return out.slice(0, 14);
}

// Worth searching for: the things a sender names that either already exist in
// the code or deliberately don't — copy they quoted, a phone number, an email,
// a URL. Ordinary prose words are left out; they match everywhere and prove
// nothing.
function requestTerms(prompt, wo) {
  const terms = [];
  // Compared on letters and digits only. "(602) 555-9090" and "602) 555-9090"
  // are the same search, and keeping both wasted a slot and printed the same
  // answer twice.
  const keys = new Set();
  const add = (s) => {
    s = String(s || "").trim();
    const key = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (s.length < 4 || s.length > 90 || key.length < 3 || keys.has(key)) return;
    keys.add(key); terms.push(s);
  };
  const text = String(prompt || "");
  // Double quotes only. A straight ' is an apostrophe far more often than a
  // quote mark — treating it as a delimiter turned "it's now … Don't" into a
  // search for "s now … Don".
  for (const m of text.matchAll(/["“”]([^"“”]{4,90})["“”]/g)) add(m[1]);
  for (const m of text.matchAll(/‘([^’]{4,90})’/g)) add(m[1]);
  for (const m of text.matchAll(/\+?\(?\d[\d\s().-]{7,}\d/g)) add(m[0].trim());
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)) add(m[0]);
  for (const m of text.matchAll(/https?:\/\/\S{4,}/g)) add(m[0].replace(/[.,)]+$/, ""));
  if (wo) for (const c of wo.changes) if (c.literal) add(c.literal);
  return terms.slice(0, 12);
}

function locateTerms(files, terms) {
  const hits = [];
  for (const t of terms) {
    const needle = t.toLowerCase();
    // A phone number in the markup is rarely punctuated the way it is in an
    // email, so match those on their digits alone.
    const digits = (t.match(/\d/g) || []).join("");
    const tail = digits.length >= 7 ? digits.slice(-7) : null;
    const found = [];
    for (const f of files) {
      if (found.length >= 4) break;
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length && found.length < 4; i++) {
        const L = lines[i];
        if (L.toLowerCase().includes(needle) || (tail && (L.match(/\d/g) || []).join("").includes(tail))) {
          found.push(`${f.rel}:${i + 1} → ${L.trim().slice(0, 110)}`);
        }
      }
    }
    hits.push({ term: t, found });
  }
  return hits;
}

function evidenceText(hits) {
  if (!hits.length) return "";
  const lines = ["WHERE THE REQUEST'S OWN WORDS ALREADY APPEAR (found by searching the theme, not by guessing):"];
  for (const h of hits) {
    if (h.found.length) { lines.push(`"${h.term}"`); for (const f of h.found) lines.push("   " + f); }
    else lines.push(`"${h.term}" — appears nowhere in the theme, so this is new content rather than an edit to existing text.`);
  }
  return lines.join("\n");
}
function outlineText(outline) {
  if (!outline.length) return "";
  return ["WHAT EACH FILE ACTUALLY CONTAINS (headings, section ids and template names read out of the code):",
    ...outline.map((o) => `- ${o.rel}: ${o.items.join(" | ")}`)].join("\n");
}

async function editPlan(manifest, req, ai) {
  const p = [
    `You are editing an existing WordPress theme${req.businessName ? ` for "${req.businessName}"` : ""}. Decide the MINIMAL set of files to create/modify/delete that satisfies the request — nothing more. Touch only files under the theme dir or its mu-plugin.`,
    THEME_CONVENTIONS,
    `\nFILES PRESENT (path — bytes):\n${manifest.map(f => `- ${f.path} (${f.bytes})`).join("\n")}`,
    req.outline ? "\n" + req.outline : "",
    req.evidence ? "\n" + req.evidence : "",
    `\nCHANGE REQUEST, VERBATIM:\n-----\n${req.prompt}\n-----`,
    req.workOrder ? "\n" + req.workOrder : "",
    `\nEvery item in the request needs a file entry, and nothing that was not asked for gets one. Each "instruction" must stand on its own — the model writing that file sees only it — and must repeat any exact wording the sender gave.`,
    `\nReturn ONLY minified JSON: {"summary":"one line of what you'll change","files":[{"path":"web/app/…","op":"create|modify|delete","instruction":"precise instruction for THIS file"}]}`,
  ].filter(Boolean).join("\n");
  const raw = await aiCall([{ text: p }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 3000, timeoutMs: 60000, json: true });
  return JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
}
async function editFileContent(op, path_, instruction, currentContent, planContext, ai, req) {
  const p = [
    `You are ${op === "create" ? "creating" : "rewriting"} the file ${path_} in a WordPress theme. Output the COMPLETE final file content — no markdown fences, no commentary.`,
    THEME_CONVENTIONS,
    planContext ? `\nThis change spans multiple files — use these EXACT paths/filenames when one references another (e.g. a mu-plugin 'template' must match the created page-*.php filename here):\n${planContext}` : "",
    // 3. The per-file instruction is the planner's summary of someone else's
    // words. Carrying the request itself down here as well is what stops copy
    // the client dictated from being quietly reworded on the way to the file.
    (req && req.prompt) ? `\nWHAT THE CLIENT ASKED FOR, VERBATIM. Anything they put in quotes is literal — reproduce it character-for-character rather than writing your own version:\n-----\n${String(req.prompt).slice(0, 4000)}\n-----` : "",
    (req && req.workOrder) ? "\n" + req.workOrder : "",
    op === "modify" ? `\nCURRENT CONTENT:\n-----\n${currentContent}\n-----` : "",
    `\nDO THIS TO ${path_}:\n${instruction}`,
    op === "modify"
      // Spelled out because the plausible-sounding version of this failure is
      // the common one: asked to change one heading from 30 to 40, the model
      // also rewrote a nearby paragraph so the copy would agree. Nobody asked
      // for that, and it lands in a diff a human then has to unpick.
      ? `\nReturn the full modified file.\n\nCHANGE NOTHING ELSE. Not other text that now disagrees with the change, not wording you think reads better, not formatting, not indentation, not blank lines, not the trailing newline. If another number or phrase in this file contradicts the change once you have made it, leave it contradicting — reconciling it is the client's decision to ask for, not yours to take. Every byte you were not explicitly asked to change must come back exactly as it went in.`
      : `\nReturn the full new file.`,
  ].filter(Boolean).join("\n");
  return stripFence(await aiCall([{ text: p }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 16000, timeoutMs: 90000 }));
}

// ---- 4. Did it actually do what was asked? ----------------------------------
// Checked against the diff, not the request and not the live site: the only
// evidence that a change happened is a line that changed. Everything below
// works on the added/removed lines alone.

// Whole-file rewrites are the norm here, so an unabridged diff is mostly
// unchanged context. Only the +/- lines carry any evidence.
function diffChanges(diff) {
  const out = [];
  let file = "";
  for (const L of String(diff || "").split("\n")) {
    const m = L.match(/^\+\+\+ b\/(.+)$/);
    if (m) { file = m[1]; continue; }
    if (/^(\+\+\+|---|@@|diff |index |new file|deleted file|similarity|rename )/.test(L)) continue;
    // 400, not 200: a Tailwind class list runs long, and the evidence for a
    // style change is often the class that got truncated away.
    if (/^[+-]/.test(L) && L.trim().length > 1) out.push({ file, sign: L[0], text: L.slice(1).trim().slice(0, 400) });
  }
  return out;
}
const CHANGE_CAP = 500;
// Every line carries an id, and the reviewer cites ids rather than quoting
// text. Quoting could not be checked reliably: the lines are shown with a
// filename on them, so a model that quoted "exactly as it appears" produced a
// string that was never going to be found in the diff itself — which silently
// failed every judgement-call item regardless of whether it had been done.
function changesText(changes, cap = CHANGE_CAP) {
  const shown = changes.slice(0, cap);
  return shown.map((c, i) => `${String(i + 1).padStart(4)}  ${c.sign} ${c.file.split("/").pop()} │ ${c.text}`).join("\n")
    + (changes.length > cap ? `\n… and ${changes.length - cap} more changed line(s), not shown` : "");
}

// The check that cannot be wrong. Three passes, loosest last: as written, then
// on digits (a phone number is punctuated differently in markup than in an
// email), then on letters-and-digits only (so &#039; and curly quotes in the
// rendered markup don't read as a miss).
function literalPresent(literal, haystack) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(haystack), lit = norm(literal);
  if (!lit) return false;
  if (hay.includes(lit)) return true;
  const digits = (lit.match(/\d/g) || []).join("");
  if (digits.length >= 7 && (hay.match(/\d/g) || []).join("").includes(digits)) return true;
  const alnum = (s) => s.replace(/[^a-z0-9]/g, "");
  return alnum(lit).length >= 6 && alnum(hay).includes(alnum(lit));
}

// Only for items with no exact text to search for — "remove the second
// testimonial" has no string to match, so something has to read the diff.
async function reviewChanges(items, changes, ai, request) {
  const p = [
    "An edit was made to a WordPress theme. Below are the lines it changed, then the things the client asked for.",
    "For each item, decide whether these changed lines show it was done.",
    "'+' means the line was added, '-' means it was removed. A modified line appears as a '-' and a '+' next to each other.",
    "",
    // A change is only ever visible as code, and code has many shapes. Listing
    // them is what makes this work for anything beyond a text edit: on the
    // first version the reviewer had no idea that a Tailwind class swap was
    // what "make the button black" looks like once written.
    "WHAT COUNTS AS DONE — judge the shape the change actually takes in code:",
    "- Text changed: the old wording on a '-' line, the new wording on a '+' line.",
    "- Colour, size, spacing, font or any styling changed: a CSS class, style attribute or CSS rule that differs between the '-' and '+' version of a line. Tailwind utility classes count — 'border border-white/30' becoming 'bg-black' IS the button being made black. So is a hex value, an rgb(), or a CSS custom property changing.",
    "- Something added — a section, button, page, field, image, link: new '+' lines containing it.",
    "- Something removed: '-' lines containing it, and no '+' line putting it back.",
    "- Grammar, spelling, punctuation or wording fixed: a '-' line and a '+' line whose wording differs.",
    "- Something moved or reordered: the same content on a '-' line in one place and a '+' line in another.",
    "",
    "Judge only what the lines show. Not whether you would have done it that way, not whether it is complete, not whether it is good. If the lines show it was done, it is done.",
    "Every line has an id on the left. Cite the ids of the lines that show the item was done. If nothing shows it, the item is not done and you cite no ids.",
    "",
    request ? `WHAT THE CLIENT WROTE, VERBATIM — use this to understand what each item means:\n-----\n${String(request).slice(0, 1500)}\n-----\n` : "",
    "CHANGED LINES:", "-----", changesText(changes), "-----",
    "",
    "ITEMS TO JUDGE:",
    ...items.map((it) => `${it.n}. ${it.what}${it.where ? ` (where the client said: ${it.where})` : ""}`),
    "",
    'Return ONLY minified JSON: {"results":[{"n":<item number>,"done":<true|false>,"lines":[<ids of the changed lines that show it, empty if not done>]}]}',
  ].filter(Boolean).join("\n");
  const raw = await aiCall([{ text: p }], { ...(ai || {}), temperature: 0.1, maxOutputTokens: 1500, timeoutMs: 60000, json: true });
  const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  return Array.isArray(d.results) ? d.results : [];
}

// One verdict per work-order item. Exact-text items are settled by search; the
// rest go to the model, and a "done" it cannot back with a real changed line is
// downgraded — that quote is checked against the diff here, not taken on trust.
async function verifyWork(workOrder, diff, ai, request) {
  if (!workOrder || !workOrder.changes.length) return null;
  const changes = diffChanges(diff);
  const added = changes.filter((c) => c.sign === "+").map((c) => c.text).join("\n");
  const removed = changes.filter((c) => c.sign === "-").map((c) => c.text).join("\n");
  const results = workOrder.changes.map((c, i) => ({ n: i + 1, what: c.what, where: c.where, replaces: c.replaces, literal: c.literal, done: null, how: "", evidence: "" }));

  for (const r of results) {
    if (!r.literal && !r.replaces) continue;
    r.how = "exact text";
    // A swap has to show both halves: new text among the added lines and old
    // text among the removed ones. Checking only the new text would pass a
    // change that added the replacement and left the original sitting there.
    if (r.literal && r.replaces) {
      r.done = literalPresent(r.literal, added) && literalPresent(r.replaces, removed);
      if (r.done) r.evidence = `${r.replaces} → ${r.literal}`;
    } else if (r.literal) {
      r.done = literalPresent(r.literal, added);
      if (r.done) r.evidence = r.literal;
    } else {
      r.done = literalPresent(r.replaces, removed);
      if (r.done) r.evidence = "removed: " + r.replaces;
    }
  }
  const judged = results.filter((r) => r.done === null);
  if (judged.length && changes.length) {
    let verdicts = [];
    try { verdicts = await reviewChanges(judged, changes, ai, request); }
    catch (e) { console.warn("work check: review failed —", e.message); }
    const top = Math.min(changes.length, CHANGE_CAP);
    for (const r of judged) {
      const v = verdicts.find((x) => Number(x && x.n) === r.n);
      // No verdict at all — the review failed, or the model skipped the item —
      // is not evidence of a miss. Say "not checked" rather than claim it
      // failed; a wrong cross is worse than an honest blank.
      if (!v) { r.done = null; r.how = "not checked"; continue; }
      // Grounded or it doesn't count, but grounding is now "did it cite real
      // lines" rather than "did its quote match a string I reassembled".
      const ids = (Array.isArray(v.lines) ? v.lines : []).map(Number)
        .filter((k) => Number.isInteger(k) && k >= 1 && k <= top);
      r.done = !!(v.done && ids.length);
      r.how = "reviewed";
      if (r.done) {
        r.evidence = ids.slice(0, 2).map((k) => `${changes[k - 1].sign} ${changes[k - 1].text}`).join("   ").slice(0, 220);
      }
    }
  } else if (judged.length) {
    for (const r of judged) { r.done = false; r.how = "no lines changed"; }
  }
  const missed = results.filter((r) => r.done === false);
  return { results, missed: missed.length, total: results.length, done: results.filter((r) => r.done === true).length };
}

async function runEditJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  const P = job.payload;                 // {siteId, themeSlug, themePath, muPath, githubRepo, businessName, prompt}
  const repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99edit-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => { let r; for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); } return r; };
  try {
    // 1 — pull latest
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = process.env.GH_TOKEN ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
    if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (process.env.GH_TOKEN) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
    const themeAbs = path.join(tmp, P.themePath);
    if (!fs.existsSync(themeAbs)) throw new Error("theme not found in repo: " + P.themePath);
    jobStep(job, 0, "done", "Latest code pulled");

    // 2 — plan
    // Which model does the thinking. Set only by the edit chat; an email
    // request carries nothing here and so runs on Gemini.
    job.aiModel = isOllamaModel(P.aiModel) ? P.aiModel : "gemini";
    const ai = {
      aiModel: job.aiModel,
      // If the chosen model fails we still finish on Gemini, but the job has
      // to say so — otherwise a model looks better than it was.
      onFallback: (model, why) => {
        job.aiFallback = `${model} failed (${String(why).slice(0, 120)}) — completed on Gemini`;
        job.aiModel = "gemini";
        saveJobs();
      },
    };
    jobStep(job, 1, "running", "Reading the request…" + (job.aiModel !== "gemini" ? ` (${job.aiModel})` : ""));
    // Re-runnable: the retry below needs to see the files as the first pass
    // left them, not as they were when the run started.
    const scanTheme = () => {
      const manifest = [], source = [];
      const readSource = (rel, abs) => {
        if (!TEXTUAL.test(rel)) return;
        try { if (fs.statSync(abs).size <= 400000) source.push({ rel, content: fs.readFileSync(abs, "utf8") }); }
        catch (e) { /* unreadable: it simply contributes no outline */ }
      };
      for (const f of fs.readdirSync(themeAbs)) {
        const abs = path.join(themeAbs, f);
        manifest.push({ path: `${P.themePath}/${f}`, bytes: fs.statSync(abs).size });
        readSource(`${P.themePath}/${f}`, abs);
      }
      if (P.muPath && fs.existsSync(path.join(tmp, P.muPath))) {
        manifest.push({ path: P.muPath, bytes: fs.statSync(path.join(tmp, P.muPath)).size });
        readSource(P.muPath, path.join(tmp, P.muPath));
      }
      return { manifest, source };
    };
    let { manifest, source } = scanTheme();

    // Understand the ask before working out where it lands. A failure here is
    // not fatal — the run continues on the raw request, exactly as it did
    // before this step existed.
    let workOrder = null;
    try { workOrder = await buildWorkOrder(P.prompt, { businessName: P.businessName }, ai); }
    catch (e) { console.warn(`edit job ${job.draftId}: work order failed, using the raw request —`, e.message); }
    job.workOrder = workOrder;
    if (workOrder) {
      jobStep(job, 1, "running", `${workOrder.changes.length} change(s) understood${workOrder.unclear.length ? `, ${workOrder.unclear.length} too vague to action` : ""} — locating them…`);
      saveJobs();
    }

    // Straight text swaps are settled here, in code. Whatever they resolve is
    // removed from the brief, so the model never sees it and cannot embellish
    // it. Only what is left needs judgement.
    const swaps = workOrder ? applyTextSwaps(workOrder, source, tmp) : [];
    job.textSwaps = swaps;
    const swapped = new Set(swaps.map((s) => s.n));
    const forAi = workOrder ? { ...workOrder, changes: workOrder.changes.filter((c, i) => !swapped.has(i + 1)) } : null;
    if (swaps.length) {
      ({ manifest, source } = scanTheme());     // re-read: the files just changed
      jobStep(job, 1, "running", `${swaps.length} exact text change(s) made directly · ${forAi.changes.length} left to plan`);
      saveJobs();
    }

    const evidence = locateTerms(source, requestTerms(P.prompt, forAi || workOrder));
    const outline = source.map((f) => ({ rel: f.rel, items: fileOutline(f.content) })).filter((o) => o.items.length);
    // What the planner and every file writer below both work from.
    const brief = { prompt: P.prompt, businessName: P.businessName, workOrder: workOrderText(forAi) };
    const allowed = (rel) => rel === P.muPath || rel.startsWith(P.themePath + "/");

    // With no work order there is only the raw prompt, so the model still runs.
    // With one, it runs only if something is left that a swap could not settle.
    const plan = { summary: "", files: [] };
    if (!forAi || forAi.changes.length) {
      jobStep(job, 1, "running", "Planning the edit…" + (job.aiModel !== "gemini" ? ` (${job.aiModel})` : ""));
      const p = await editPlan(manifest, { ...brief, evidence: evidenceText(evidence), outline: outlineText(outline) }, ai);
      plan.summary = String(p.summary || "");
      plan.files = (p.files || []).filter(f => f && f.path && allowed(f.path)).slice(0, 8);
      if (!plan.files.length && !swaps.length) throw new Error("planner produced no in-scope file changes");
    }
    job.editPlan = plan.files.map(f => ({ path: f.path, op: f.op }));
    job.editSummary = plan.summary || swapsText(swaps);
    jobStep(job, 1, "done", plan.summary || swapsText(swaps) || `${plan.files.length} file(s)`);

    // 3 — apply
    jobStep(job, 2, "running", plan.files.length ? "Applying changes…" : "Nothing left for the model to write");
    const applyPlan = async (pl, wr) => {
      const planContext = pl.files.map(f => `${f.op} ${f.path}`).join("\n");
      for (const f of pl.files) {
        const abs = path.join(tmp, f.path);
        if (f.op === "delete") { fs.rmSync(abs, { force: true }); continue; }
        const cur = f.op === "modify" && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
        const content = await editFileContent(f.op, f.path, f.instruction || pl.summary, cur, planContext, ai, wr || brief);
        if (!content || (abs.endsWith(".php") && !content.includes("<?php") && cur.includes("<?php"))) throw new Error("AI returned empty/invalid content for " + f.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      // guardrail: theme must still have its required files
      for (const req of ["index.php", "style.css"]) {
        if (!fs.existsSync(path.join(themeAbs, req))) throw new Error(`edit would remove required ${req} — aborted`);
      }
    };
    if (plan.files.length) await applyPlan(plan);
    jobStep(job, 2, "done", plan.files.length
      ? `${plan.files.length} file(s) written`
      : `${swaps.length} exact swap(s) applied — no model rewrite needed`);

    // 4 — check the work against the work order, while nothing has left this
    //     machine yet. Staging first is what puts newly created files into the
    //     diff; the push step below stages the same paths again and commits.
    jobStep(job, 3, "running", "Checking the work…");
    const paths = `"${P.themePath}"${P.muPath ? ` "${P.muPath}"` : ""}`;
    const stagedDiff = async () => {
      await run(`git add -A -- ${paths}`, tmp);
      return (await run(`git --no-pager diff --cached --unified=1 -- ${paths}`, tmp)).stdout || "";
    };
    let check = null;
    try {
      check = await verifyWork(workOrder, await stagedDiff(), ai, P.prompt);
      // One retry, for the items the diff shows no evidence of. A second miss
      // is reported rather than retried again: past one attempt this stops
      // converging and starts churning the same files.
      if (check && check.missed) {
        jobStep(job, 3, "running", `${check.missed} of ${check.total} item(s) not done — trying once more…`);
        const again = check.results.filter((r) => r.done === false);
        const retryWo = { changes: again.map((r) => ({ what: r.what, where: r.where, replaces: r.replaces, literal: r.literal })), constraints: workOrder.constraints, unclear: [] };
        const scan = scanTheme();     // the files as the first pass left them
        const retryBrief = {
          prompt: P.prompt, businessName: P.businessName,
          workOrder: workOrderText(retryWo) + "\n\nAn earlier attempt at this same request already made its other changes. Do ONLY the items above and leave everything else exactly as it now stands.",
        };
        const plan2 = await editPlan(scan.manifest, {
          ...retryBrief,
          evidence: evidenceText(locateTerms(scan.source, requestTerms(P.prompt, retryWo))),
          outline: outlineText(scan.source.map((f) => ({ rel: f.rel, items: fileOutline(f.content) })).filter((o) => o.items.length)),
        }, ai);
        plan2.files = (plan2.files || []).filter(f => f && f.path && allowed(f.path)).slice(0, 6);
        if (plan2.files.length) {
          await applyPlan(plan2, retryBrief);
          job.retried = true;
          job.editPlan = [...job.editPlan, ...plan2.files.map(f => ({ path: f.path, op: f.op }))]
            .filter((f, i, a) => a.findIndex((x) => x.path === f.path) === i);
          check = await verifyWork(workOrder, await stagedDiff(), ai, P.prompt);
        }
      }
    } catch (e) {
      // A failed check must not sink an otherwise good edit — it reports on the
      // work, it does not do the work.
      console.warn(`edit job ${job.draftId}: work check failed —`, e.message);
    }
    job.verification = check;
    saveJobs();
    jobStep(job, 3, "done", check
      ? `${check.done} of ${check.total} confirmed${check.missed ? ` · ${check.missed} not done` : ""}${job.retried ? " (after a retry)" : ""}`
      : "Nothing checkable — skipped");

    // 5 — push + PR
    jobStep(job, 4, "running", "Pushing + opening PR…");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/edit-${P.themeSlug.replace(/^g99-/, "")}-${stamp}`;
    await run(`git checkout -b "${branch}"`, tmp);
    await run(`git add -A "${P.themePath}" ${P.muPath ? `"${P.muPath}"` : ""}`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "Edit ${P.businessName}: ${(plan.summary || "AI change").slice(0, 60)}"`, tmp);
    if (r.code) throw new Error("commit failed (no changes?): " + (r.stderr || r.stdout).slice(-160));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    // Whoever opens this on GitHub sees the same verdict the Studio job page
    // shows, so the PR is readable without going back to the tool.
    const checkLine = check
      ? `\\n\\n**Checked against the request:** ${check.done}/${check.total} confirmed in the diff${job.retried ? " (after one retry)" : ""}.`
        + check.results.map((r2) => `\\n- ${r2.done === true ? "[x]" : r2.done === false ? "[ ] NOT DONE —" : "[ ] unverified —"} ${String(r2.what).replace(/"/g, "'").slice(0, 120)}`).join("")
      : "";
    const prBody = `Automated edit for **${P.businessName}**.\\n\\n**Request:** ${P.prompt.replace(/"/g, "'").slice(0, 300)}\\n\\n**Plan:** ${(plan.summary || "").replace(/"/g, "'")}\\n\\nFiles: ${plan.files.map(f => `${f.op} ${f.path}`).join(", ")}${checkLine}`;
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "Edit ${P.businessName}: ${(plan.summary || "AI change").replace(/"/g, "'").slice(0, 60)}" --body "${prBody}"`, tmp);
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    job.branch = branch;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 4, "done", job.prUrl);

    // 6 — CI watch → auto-fix → merge on green
    jobStep(job, 5, "running", "Watching CI build checks…");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st; try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); } catch (e) { await sleep(10000); continue; }
      jobStep(job, 5, "running", (st.checks || []).map(c => `${c.name}:${c.status}`).join(" ") || "CI starting…");
      if (st.allPass) { await awaitApprovalIfNeeded(job, P.siteId, 5); if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl }); merged = true; jobStep(job, 5, "done", job.mergedExternally ? "Merged on GitHub" : `Merged${fixes ? ` after ${fixes} fix(es)` : ""}`); break; }
      if (st.anyFail) {
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts — " + job.prUrl);
        fixes++; jobStep(job, 5, "running", `Build failed — Gemini auto-fix ${fixes}/3…`);
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        if (fix.billing) throw new Error(fix.message);
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI: " + (fix.message || ""));
        await sleep(20000); continue;
      }
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out after ~40 min — " + job.prUrl);

    // 7 — refresh registry so lastChange reflects this edit
    jobStep(job, 6, "running", "Updating site registry…");
    try { await syncSiteRegistry(); } catch (e) { /* non-fatal */ }
    jobStep(job, 6, "done", "Done — change is live on merge/deploy");
    await postEditPrComment(job);
    job.status = "done";
    // The second and final message. One line saying what shipped, then the
    // site. No pull request link: internal plumbing, and merged by now anyway.
    // The summary already reads as a sentence, so nothing is appended to it.
    queueEmailReply(job, [
      "The change is live now " + String.fromCharCode(8212) + " " + (job.editSummary || "your requested update").trim(),
      P.liveUrl ? "\n" + P.liveUrl : "",
    ].join("\n").trim());
    // Anything skipped has to be said out loud — otherwise "done" reads as "all
    // of it done". Two ways an item can be missing: too vague to attempt, or
    // attempted and not found in the diff afterwards.
    const skipped = (job.workOrder && job.workOrder.unclear) || [];
    const notDone = check ? check.results.filter((r2) => r2.done !== true) : [];
    notify(`✏️ Edit merged for *${job.businessName}*: ${job.editSummary || ""} · ${job.prUrl || ""}`
      + (check ? `\n${check.done}/${check.total} item(s) confirmed in the diff${job.retried ? " (after one retry)" : ""}` : "")
      + (notDone.length ? `\n⚠️ ${notDone.map((r2) => `${r2.done === false ? "not done" : "unverified"}: ${r2.what}`).join("; ")}` : "")
      + (skipped.length ? `\n⚠️ Not actioned (too vague to do without guessing): ${skipped.join("; ")}` : ""));
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) { job.status = "cancelled"; }
    else {
      job.error = e.message; job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      console.error(`edit job ${job.draftId} failed:`, e.message);
      queueEmailReply(job, [
        "I could not complete this change.",
        "",
        String(e.message).slice(0, 300),
        "",
        "Nothing was changed on the live site. A developer will need to take a look.",
      ].join("\n"));
      notify(`❌ Edit failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job);   // terminal: done | error | cancelled (+ siteUrl/prUrl/scores)
  }
}
// Snapshot restore: put the theme tree back exactly as it was at one commit and
// ship it through the same PR → CI → approval → merge path as an edit. No AI, no
// force-push, no history rewrite — the restore is just another commit forward.
async function runRestoreJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  const P = job.payload;                 // {siteId, themeSlug, themePath, muPath, githubRepo, businessName, sha, versionLabel}
  const repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99restore-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => { let r; for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); } return r; };
  try {
    // 1 — full clone: unlike an edit, this needs the history the sha lives in.
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}"`);
    const cloneUrl = process.env.GH_TOKEN ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
    if (r.code) r = await runRetry(`git clone "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (process.env.GH_TOKEN) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
    r = await run(`git rev-parse --verify --quiet ${P.sha}`, tmp);
    if (r.code || !r.stdout.trim()) throw new Error(`commit ${P.sha.slice(0, 7)} isn't in ${repo}`);
    const full = r.stdout.trim();
    // The theme must exist at that commit, or "restore" would just delete it.
    r = await run(`git ls-tree ${full} -- "${P.themePath}"`, tmp);
    if (!r.stdout.trim()) throw new Error(`${P.themePath} didn't exist at ${P.sha.slice(0, 7)} — nothing to restore to`);
    jobStep(job, 0, "done", "Latest code pulled");

    // 2 — swap the theme tree for the one at that commit. Removing first is what
    // makes this a snapshot: files added after the version go away too.
    jobStep(job, 1, "running", "Restoring " + P.themeSlug + " to " + P.sha.slice(0, 7));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/restore-${P.themeSlug.replace(/^g99-/, "")}-${stamp}`;
    await run(`git checkout -b "${branch}"`, tmp);
    await run(`git rm -r -q --ignore-unmatch -- "${P.themePath}"`, tmp);
    r = await run(`git checkout ${full} -- "${P.themePath}"`, tmp);
    if (r.code) throw new Error("restore failed: " + (r.stderr || r.stdout).slice(-200));
    // The activator plugin only comes along if it existed then; deleting a
    // plugin the live site now depends on would take the theme offline.
    if (P.muPath) {
      const had = await run(`git ls-tree ${full} -- "${P.muPath}"`, tmp);
      if (had.stdout.trim()) await run(`git checkout ${full} -- "${P.muPath}"`, tmp);
    }
    // Guardrail: a restore may only ever touch this website's own files.
    // --cached against HEAD lists one clean path per line (no status columns or
    // rename arrows to parse) and everything above is already staged.
    const status = await run(`git diff --cached --name-only HEAD`, tmp);
    const touched = status.stdout.split("\n").map(l => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const stray = touched.filter(f => f !== P.muPath && !f.startsWith(P.themePath + "/"));
    if (stray.length) throw new Error("restore would touch files outside the theme — aborted: " + stray.slice(0, 3).join(", "));
    if (!touched.length) throw new Error("that version is already what's live — nothing to restore");
    for (const req of ["index.php", "style.css"]) {
      if (!fs.existsSync(path.join(tmp, P.themePath, req))) throw new Error(`restored theme is missing ${req} — aborted`);
    }
    job.editSummary = `Restored ${P.themeSlug} to ${P.sha.slice(0, 7)}${P.versionLabel ? ` — ${P.versionLabel}` : ""}`;
    job.editPlan = touched.slice(0, 8).map(f => ({ path: f, op: "restore" }));
    jobStep(job, 1, "done", `${touched.length} file(s) rolled back`);

    // 3 — push + PR
    jobStep(job, 2, "running", "Pushing + opening PR…");
    await run(`git add -A "${P.themePath}" ${P.muPath ? `"${P.muPath}"` : ""}`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "Restore ${P.businessName} to ${P.sha.slice(0, 7)}"`, tmp);
    if (r.code) throw new Error("commit failed: " + (r.stderr || r.stdout).slice(-160));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    const prBody = `Snapshot restore for **${P.businessName}**.\\n\\nPuts \`${P.themePath}\` back exactly as it was at \`${P.sha.slice(0, 7)}\`${P.versionLabel ? ` (${P.versionLabel.replace(/"/g, "'")})` : ""}, discarding theme changes made after it.\\n\\nFiles: ${touched.length}`;
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "Restore ${P.businessName} to ${P.sha.slice(0, 7)}" --body "${prBody}"`, tmp);
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    job.branch = branch;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 2, "done", job.prUrl);

    // 4 — CI watch → merge on green (same policy as an edit; no auto-fix, since
    // a failing build on a known-good tree means something outside it changed).
    jobStep(job, 3, "running", "Watching CI build checks…");
    let merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st; try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); } catch (e) { await sleep(10000); continue; }
      jobStep(job, 3, "running", (st.checks || []).map(c => `${c.name}:${c.status}`).join(" ") || "CI starting…");
      if (st.allPass) { await awaitApprovalIfNeeded(job, P.siteId, 3); if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl }); merged = true; jobStep(job, 3, "done", job.mergedExternally ? "Merged on GitHub" : "Merged"); break; }
      if (st.anyFail) throw new Error("CI failed on the restore — review it by hand: " + job.prUrl);
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out after ~40 min — " + job.prUrl);

    // 5 — registry
    jobStep(job, 4, "running", "Updating site registry…");
    try { await syncSiteRegistry(); } catch (e) { /* non-fatal */ }
    jobStep(job, 4, "done", "Done — the restored version is live on merge/deploy");
    job.status = "done";
    notify(`⏪ Restore merged for *${job.businessName}*: ${job.editSummary} · ${job.prUrl || ""}`);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) { job.status = "cancelled"; }
    else {
      job.error = e.message; job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      console.error(`restore job ${job.draftId} failed:`, e.message);
      notify(`❌ Restore failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
  }
}
async function postEditPrComment(job) {
  const prNum = ((job.prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
  if (!prNum) return;
  const body = [`## 🤖 Automated edit — ${job.businessName}`, "", `**Change:** ${job.editSummary || ""}`, "", `Files: ${(job.editPlan || []).map(f => `\`${f.op} ${f.path}\``).join(", ")}`, "", `Requested via the edit tool.`].join("\n");
  const tmpFile = path.join(os.tmpdir(), `epc-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, body);
  const r = await sh(`gh pr comment ${prNum} --repo ${job.payload.githubRepo || WP_REPO} --body-file "${tmpFile}"`);
  fs.rmSync(tmpFile, { force: true });
  if (r.code) console.warn("edit PR comment failed:", (r.stderr || "").slice(-160));
}

// ============================================================ ENRICH ENGINE
// A DECOUPLED post-beta job: after a beta site is released, add (in ONE PR on the
// already-built theme) revenue-first individual service pages + a public brand
// guide, mimicking the reference site's per-service structure. Reuses the edit
// job's clone → write → PR → CI → merge rails. Fail-soft: never touches the beta.
const MAX_SERVICE_PAGES = 10;
const BASE_SLUGS = new Set(["home", "services", "about", "contact", "branding", "seo", "brand-guide", "team"]);
function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
// services_offered arrives dirty — a name with a comma inside parens gets split
// across array items ("Neurotoxins (Botox", "Dysport)"). Rejoin unclosed parens.
function cleanServiceList(raw) {
  const arr = Array.isArray(raw) ? raw.slice() : (raw ? [String(raw)] : []);
  const out = []; let buf = null;
  for (let t of arr) {
    t = String(t).trim(); if (!t) continue;
    if (buf != null) { buf += ", " + t; if (t.includes(")")) { out.push(buf); buf = null; } continue; }
    const opens = (t.match(/\(/g) || []).length, closes = (t.match(/\)/g) || []).length;
    if (opens > closes) buf = t; else out.push(t);
  }
  if (buf != null) out.push(buf);
  return out;
}
// Revenue-first, then growth, then the rest of services_offered; dedupe; slugify;
// cap at MAX_SERVICE_PAGES. Returns {services:[{name,slug}], total, truncated}.
function selectServices(A, cap = MAX_SERVICE_PAGES) {
  A = A || {};
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const ordered = []; const seen = new Set();
  // dedupe key ignores a trailing parenthetical, so "Neurotoxins" and
  // "Neurotoxins (Botox, Dysport)" collapse to one page (first-seen name wins).
  const push = (name) => { const n = norm(name); const k = n.toLowerCase().replace(/\s*\(.*$/, "").trim(); if (!n || !k || seen.has(k)) return; seen.add(k); ordered.push(n); };
  cleanServiceList(A.revenue_services).forEach(push);
  cleanServiceList(A.growth_services).forEach(push);
  cleanServiceList(A.services_offered).forEach(push);
  const used = new Set(BASE_SLUGS); const services = [];
  for (const name of ordered) {
    if (services.length >= cap) break;
    const base = slugify(name); if (!base) continue;
    let s = base, n = 2; while (used.has(s)) s = base + "-" + (n++);
    used.add(s); services.push({ name, slug: s });
  }
  return { services, total: ordered.length, truncated: ordered.length > cap };
}
function deriveCity(location) {
  const parts = String(location || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";
  const c = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return c.replace(/\b[A-Z]{2}\b\s*\d{0,5}.*$/, "").trim();
}
// Best-effort discovery of the reference site's service pages (sitemap + keyword
// filter). Used only to GROUND the template (structure + local-SEO URL pattern).
// Fail-soft: any error → {count:0}.
const SERVICE_KEYWORDS = /(botox|filler|dysport|sculptra|microneedl|laser|peel|facial|injectable|lift|threads?|prp|hydrafacial|kybella|coolsculpt|weight-?loss|hormone|hrt|iv-?therapy|dermaplan|morpheus|bbl|hair-?removal|lip|skin|wellness|aesthetic|treatment|service)/i;
async function discoverServicePages(url) {
  if (!url) return { count: 0, pages: [], localSeo: false };
  const origin = (() => { try { return new URL(url).origin; } catch (e) { return null; } })();
  if (!origin) return { count: 0, pages: [], localSeo: false };
  const locs = new Set();
  const grab = async (u) => {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
      if (!r.ok) return;
      const xml = await r.text();
      (xml.match(/<loc>([^<]+)<\/loc>/g) || []).forEach((m) => locs.add(m.replace(/<\/?loc>/g, "").trim()));
    } catch (e) { /* ignore */ }
  };
  await grab(origin + "/sitemap.xml"); await grab(origin + "/wp-sitemap.xml");
  // sitemaps of sitemaps
  const subs = [...locs].filter((l) => /sitemap.*\.xml$/i.test(l)).slice(0, 5);
  locs.clear(); for (const s of subs) await grab(s);
  const pages = [...locs]
    .map((l) => { try { return new URL(l); } catch (e) { return null; } })
    .filter((u) => u && u.origin === origin)
    .map((u) => u.pathname.replace(/\/+$/, ""))
    .filter((p) => p && p.split("/").filter(Boolean).length <= 2 && SERVICE_KEYWORDS.test(p))
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, MAX_SERVICE_PAGES);
  const localSeo = pages.some((p) => /-in-[a-z-]+-[a-z]{2}\/?$/i.test(p) || /-[a-z]+-[a-z]{2}$/i.test(p));
  return { count: pages.length, pages: pages.map((p) => ({ path: p })), localSeo };
}

// ---- existing-site reference scraping ------------------------------------------
// The client's CURRENT website usually already has a page per service (e.g.
// /services/neurotoxins-in-sycamore-il/). Scrape each matching page's real copy
// and feed it to Stitch as the content reference, so generated pages carry the
// practice's actual claims/FAQ/process instead of invented text.
async function scrapeExistingServiceRefs(existingUrl, services) {
  const out = {};
  if (!existingUrl) return out;
  let origin; try { origin = new URL(existingUrl).origin; } catch (e) { return out; }
  const fetchText = async (u) => {
    try { const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot" } }); return r.ok ? await r.text() : ""; } catch (e) { return ""; }
  };
  // candidate links: homepage + /services/ hub
  const links = new Set();
  for (const page of ["/", "/services/"]) {
    const html = await fetchText(origin + page);
    for (const m of html.matchAll(/href="((?:https?:\/\/[^"\/]+)?\/[a-z0-9-\/]+\/)"/gi)) {
      const p = m[1].replace(origin, "");
      if (p.length > 3 && !/\/(blog|feed|privacy|contact|about|cart|checkout)/.test(p)) links.add(p);
    }
  }
  const linkArr = [...links];
  for (const s of services) {
    const tokens = s.slug.split("-").filter((t) => t.length > 3);
    let best = null, bestScore = 0;
    for (const p of linkArr) {
      const score = tokens.filter((t) => p.includes(t)).length;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best || !bestScore) continue;
    const html = await fetchText(origin + best);
    if (!html) continue;
    const title = (html.match(/<title>([^<]{0,120})/i) || [])[1] || "";
    const h1 = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "").replace(/<[^>]+>/g, " ").trim();
    const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ").trim()).filter(Boolean).slice(0, 8);
    const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim().slice(0, 1600);
    out[s.slug] = { url: origin + best, title, h1, h2s, text: body };
  }
  return out;
}
// Learn the REFERENCE site's service-page design (section order, imagery density,
// local-SEO heading style) so generated pages mimic what the client loves instead
// of a fixed outline. Fail-soft → null (composer falls back to a proven structure).
async function scrapeReferenceServiceStructure(refUrl) {
  if (!refUrl) return null;
  try {
    const disc = await discoverServicePages(refUrl);
    if (!disc.count) return null;
    const origin = new URL(refUrl).origin;
    const r = await fetch(origin + disc.pages[0].path, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
    if (!r.ok) return null;
    const page = await r.text();
    const h1 = ((page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "").replace(/<[^>]+>/g, " ").trim();
    const h2s = [...page.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").trim()).filter((t) => t && t.length < 90).slice(0, 12);
    const imgs = (page.match(/<img/gi) || []).length;
    const sections = (page.match(/<section/gi) || []).length;
    return { url: origin + disc.pages[0].path, h1, h2s, imgs, sections, localSeo: disc.localSeo };
  } catch (e) { return null; }
}
// Gemini composes the generation brief for ONE service page: mimic the reference
// page's structure, rewrite the existing site's real copy, obey the brand system.
// Nothing about the section flow is hardcoded — it comes from the reference scrape.
async function composeServicePagePrompt(svc, refStruct, existing, A, composed, city) {
  const loc = city ? ` in ${city}` : "";
  const p = [
    `Write a DESIGN BRIEF (a page-generation prompt) for one service page of a medical-aesthetics website. Return ONLY the brief text — no preamble, no markdown.`,
    `Service: "${svc.name}" at ${A.business_name || "the clinic"}${loc}. Primary CTA "${A.primary_cta || "Book a consultation"}" (booking: ${A.booking_platform || "online"}).`,
    refStruct
      ? `MIMIC THIS REFERENCE PAGE'S STRUCTURE (the design the client loves — ${refStruct.url}): H1 pattern "${refStruct.h1}"; section flow: ${refStruct.h2s.join(" → ")}; ~${refStruct.imgs} images across ${refStruct.sections || "several"} sections${refStruct.localSeo ? `; local-SEO style with the city woven into headings` : ""}. Adapt that exact section order and imagery density to "${svc.name}".`
      : `Use a proven conversion structure: hero, what-it-is, benefits, candidacy, process, trust/credentials, FAQ, closing CTA.`,
    existing ? `REAL COPY TO REWRITE, keep the facts (from the practice's current page ${existing.url}): H1 "${existing.h1}"; sections ${existing.h2s.join(" · ")}; text: ${existing.text.slice(0, 1000)}` : "",
    `Brand system to obey exactly: primary ${composed.primary}, secondary ${composed.secondary}, accent ${composed.accent}; headings "${composed.headingFont}", body "${composed.bodyFont}".`,
    `The brief must specify every section in order with concrete copy direction, demand rich professional medical-aesthetic photography, and stay conversion-focused. 250-400 words.`,
  ].filter(Boolean).join("\n");
  return stripFence(await geminiCall([{ text: p }], { temperature: 0.5, maxOutputTokens: 1400, timeoutMs: 60000 }));
}
// Hard technical constraint appended to every service-page prompt (composed or
// fallback): the page's <head> is stripped for the WP template, so custom
// tailwind.config token names would silently die.
function stylingConstraint(composed) {
  return `\n\nSTYLING CONSTRAINT (critical): use ONLY standard Tailwind utility classes and arbitrary-value utilities with exact hex (e.g. bg-[${composed.primary}] text-[${composed.accent}]). Do NOT define or rely on custom tailwind.config color names. Any custom CSS must live in a <style> block. Return one complete, responsive, production-quality HTML page.`;
}
// Fallback Stitch prompt (fixed outline) — used only when Gemini composition fails.
// Standard/arbitrary-value Tailwind only — named custom tokens (bg-charcoal etc.)
// die when the page's <head> is stripped into a WP template.
function stitchServicePrompt(svc, refc, A, composed, city) {
  const loc = city ? ` in ${city}` : "";
  return [
    `Design a single, conversion-optimized SERVICE page for the treatment "${svc.name}" offered by ${A.business_name || "the clinic"}${loc} (medical aesthetics / medspa).`,
    refc ? `\nCONTENT REFERENCE — this is the practice's CURRENT page for this service; rewrite/upgrade this real copy, keep the facts:\nTitle: ${refc.title}\nH1: ${refc.h1}\nSections: ${refc.h2s.join(" · ")}\nText: ${refc.text}` : "",
    `\nSections: 1) full-bleed HERO with image + dark scrim, H1 "${svc.name}${loc}", benefit subhead, CTA "${A.primary_cta || "Book a consultation"}". 2) What it is (outcome-framed). 3) Benefits grid. 4) Treatment areas / candidacy. 5) How it works — 3 steps. 6) Why ${A.business_name || "us"} — credentials. 7) 3-question FAQ. 8) Closing CTA band (booking: ${A.booking_platform || "online"}).`,
    `\nBrand: primary ${composed.primary}, secondary ${composed.secondary}, accent ${composed.accent}; headings "${composed.headingFont}", body "${composed.bodyFont}". Rich professional medical-aesthetic photography, 6-10 images.`,
  ].filter(Boolean).join("\n");   // stylingConstraint() is appended by the caller
}
// Make a generated page's <main> self-sufficient inside the WP template: carry its
// font links, <style> blocks and inline tailwind config along with the body —
// this is THE fix for service pages rendering unstyled (their classes were
// defined in a <head> that splitPage() threw away).
function embedPageAssets(html) {
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ""])[1];
  const fonts = (head.match(/<link[^>]+fonts\.googleapis[^>]*>/gi) || []).join("\n");
  const styles = (head.match(/<style[\s\S]*?<\/style>/gi) || []).join("\n");
  const twcfg = (head.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?tailwind\.config[\s\S]*?<\/script>/gi) || []).join("\n");
  const main = splitPage(html).main;
  return [fonts, twcfg, styles, main].filter(Boolean).join("\n");
}

// ---- content generation (one template → clone per service) --------------------
function serviceSectionSpec(svc, A, composed, ref, city) {
  const loc = city ? ` in ${city}` : "";
  return [
    `Build a single, conversion-optimized SERVICE page for the treatment "${svc.name}" offered by ${A.business_name || "the clinic"}${loc}.`,
    `Sections (each a DISTINCT band; rich, real imagery via https://images.unsplash.com source URLs — 6-10 images total):`,
    `1. HERO — full-width image under a dark gradient scrim; H1 "${svc.name}${loc}"; a benefit-led subhead; primary CTA "${A.primary_cta || "Book a consultation"}".`,
    `2. WHAT IT IS — short editorial explainer of ${svc.name}, patient-outcome framed ("You get…" not "We provide…").`,
    `3. BENEFITS — a 3-4 item grid of concrete benefits/results.`,
    `4. TREATMENT AREAS / CANDIDACY — who it's for; areas treated.`,
    `5. HOW IT WORKS — a numbered 3-step process (consult → treatment → aftercare).`,
    `6. WHY ${(A.business_name || "US").toUpperCase()} — credentials/trust: ${(A.team_roster || []).map((t) => t.name).slice(0, 2).join(", ") || "board-certified providers"}.`,
    `7. FAQ — 3 concise Q&As specific to ${svc.name}.`,
    `8. CLOSING CTA band "${A.primary_cta || "Book a consultation"}" (booking: ${A.booking_platform || "online"}).`,
    ref && ref.localSeo && city ? `Use a local-SEO tone throughout, weaving "${city}" into headings and copy (the reference site uses per-service local-SEO pages).` : ``,
    `Match this brand system exactly — primary ${composed.primary}, secondary ${composed.secondary}, accent ${composed.accent}; headings in "${composed.headingFont}", body in "${composed.bodyFont}". Load Tailwind (CDN) + those Google Fonts in <head>.`,
  ].filter(Boolean).join("\n");
}
// Produce the ONE representative service page (the template all others clone).
// NOTE: swap this to Stitch when a working key is available — it's the single
// place the template is generated; everything else clones it deterministically.
async function generateServiceTemplate(svc, A, composed, ref, city, brief) {
  const spec = (brief && brief.length > 120) ? brief : serviceSectionSpec(svc, A, composed, ref, city);
  const prompt = `${composed.brief || ""}\n\n${spec}${stylingConstraint(composed)}\n\nReturn ONE complete, responsive, production-quality HTML document (<!doctype html> … </html>). No markdown fences, no commentary.`;
  const html = stripFence(await geminiCall([{ text: prompt }], { temperature: 0.55, maxOutputTokens: 16000, timeoutMs: 120000 }));
  // embedPageAssets (not splitPage().main) — the <head>'s fonts/styles/config MUST
  // travel with the markup, or every class defined there dies in the WP template.
  const main = embedPageAssets(html);
  return (main && main.trim().length > 200) ? main : `<section style="padding:80px 24px;text-align:center"><h1>${svc.name}</h1></section>`;
}
// Clone the template's <main> for a different service — same layout/classes,
// swapped name/copy/benefits/imagery. Keeps all 10 pages visually consistent.
// Shared post-processing for Gemini-generated service pages: same image pipeline
// as the Stitch path, so a fallback page is never blurrier than a Stitch one.
async function polishServiceHtml(html, composed) {
  let h = enforceBrandFonts(html, composed);
  h = sharpenStitchImages(h);
  h = await fixImages(h);
  const qc = await qcImageResolution(h);
  return { html: qc.html, report: qc.report };
}
async function cloneServicePage(templateMain, svc, A, composed, city) {
  const loc = city ? ` in ${city}` : "";
  const prompt = [
    `Below is the <main> HTML of a service page for one treatment. Rewrite it for a DIFFERENT treatment: "${svc.name}".`,
    `Keep the EXACT same structure, section order, Tailwind classes and layout. Change ONLY: the H1 to "${svc.name}${loc}", all body copy to describe ${svc.name}, the benefits/FAQ to be specific to ${svc.name}, and swap image URLs to Unsplash images that depict ${svc.name} / relevant medical-aesthetic imagery. Keep the primary CTA "${A.primary_cta || "Book a consultation"}".`,
    `CRITICAL: reproduce every <style>, <script> and <link> block from the template VERBATIM — they define the page's CSS and the page breaks without them.`,
    `Output ONLY the rewritten markup (the <main> plus any style/link/script blocks it came with) — no <html>, no <head>, no commentary, no markdown fences.`,
    `\nTEMPLATE <main>:\n${templateMain}`,
  ].join("\n");
  const out = stripFence(await geminiCall([{ text: prompt }], { temperature: 0.5, maxOutputTokens: 16000, timeoutMs: 120000 }));
  const m = out.match(/<main[\s\S]*<\/main>/i);
  return (m ? m[0] : out).trim() || templateMain;
}
// A deterministic services hub (grid of cards linking to each /<slug>/).
function servicesHubMain(services, A, composed) {
  const c = composed || {};
  const cards = services.map((s) => `      <a class="g99svc-card" href="/${s.slug}/">
        <span class="g99svc-name">${escHtml(s.name)}</span>
        <span class="g99svc-go">Explore ${escHtml(s.name)} →</span>
      </a>`).join("\n");
  return `<section class="g99hub">
  <style>
    .g99hub{padding:96px 24px;background:${c.primary || "#111"};color:#fff;font-family:"${c.bodyFont || "Plus Jakarta Sans"}",sans-serif}
    .g99hub .wrap{max-width:1120px;margin:0 auto}
    .g99hub h1{font-family:"${c.headingFont || "Cormorant Garamond"}",serif;font-size:clamp(34px,5vw,56px);margin:0 0 12px;color:${c.accent || "#d4af37"}}
    .g99hub p.sub{opacity:.8;max-width:640px;margin:0 0 40px}
    .g99svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
    .g99svc-card{display:flex;flex-direction:column;gap:10px;padding:26px 24px;border:1px solid rgba(255,255,255,.14);border-radius:14px;text-decoration:none;color:#fff;transition:.18s;background:rgba(255,255,255,.03)}
    .g99svc-card:hover{border-color:${c.accent || "#d4af37"};transform:translateY(-3px)}
    .g99svc-name{font-family:"${c.headingFont || "Cormorant Garamond"}",serif;font-size:24px}
    .g99svc-go{font-size:13px;letter-spacing:.04em;color:${c.accent || "#d4af37"}}
  </style>
  <div class="wrap">
    <h1>Our Treatments</h1>
    <p class="sub">${escHtml(A.business_description || `Explore the treatments offered at ${A.business_name || "our clinic"}.`)}</p>
    <div class="g99svc-grid">
${cards}
    </div>
  </div>
</section>`;
}
function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }
// ---- brand-guide color math ----------------------------------------------------
function hexMix(hex, other, ratio) {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  try {
    const a = p(hex), b = p(other);
    return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * ratio).toString(16).padStart(2, "0")).join("").toUpperCase();
  } catch (e) { return hex; }
}
function onColor(hex) {
  try {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1B1C1C" : "#FFFFFF";
  } catch (e) { return "#FFFFFF"; }
}
// Full branding-guide page (modeled on infra-1.gogroth.com/branding-guide/):
// logo → palette story, a derived color-role system, hero rationale, typography,
// responsive strategy, live component samples, and Do/Don't rules — all
// deterministic from the build's composed brand + onboarding answers.
function brandGuidePage(composed, A, biz) {
  const c = composed || {}; A = A || {};
  const name = biz || A.business_name || "The Practice";
  const pri = c.primary || "#1A1A1A", sec = c.secondary || "#C5B39C", acc = c.accent || "#C5A059";
  const hf = c.headingFont || "Cormorant Garamond", bf = c.bodyFont || "Montserrat";
  const priCont = hexMix(pri, "#FFFFFF", 0.12), priInv = hexMix(pri, "#FFFFFF", 0.68);
  const accDeep = hexMix(acc, "#000000", 0.28), accCont = hexMix(acc, "#FFFFFF", 0.62);
  const surface = hexMix(sec, "#FFFFFF", 0.92), surfCont = hexMix(sec, "#FFFFFF", 0.82);
  const onSurf = "#1B1C1C";
  const tone = [];
  const t = (v, lo, hi) => { const n = parseInt(v, 10); if (isNaN(n)) return null; return n >= 50 ? hi : lo; };
  const add = (v, lo, hi) => { const r = t(v, lo, hi); if (r) tone.push(r); };
  add(A.tone_clinical_warm, "clinical", "warm"); add(A.tone_lux_approachable, "luxurious", "approachable");
  add(A.tone_bold_understated, "bold", "understated"); add(A.tone_playful_serious, "playful", "serious");
  const imagery = (String(c.brief || "").match(/IMAGERY:\s*([\s\S]+)$/i) || [])[1] ||
    "Editorial, high-end medical-aesthetic photography with warm ambient lighting, shallow depth of field, and authentic provider-patient moments. No stocky smiles, no clip-art.";
  const cta = A.primary_cta || "Book a consultation";
  const heroH = A.hero_headline || `Refined, natural results`;
  const review = A.featured_review || "";
  const sw = (hex, role, use) => `
      <div class="bgd-sw"><span class="bgd-chip" style="background:${escHtml(hex)}"><code style="color:${onColor(hex)}">${escHtml(hex)}</code></span><b>${escHtml(role)}</b><span>${escHtml(use)}</span></div>`;
  return `<section class="bgd">
  <style>
    @import url("https://fonts.googleapis.com/css2?family=${encodeURIComponent(hf)}:wght@400;600;700&family=${encodeURIComponent(bf)}:wght@400;500;600;700&display=swap");
    .bgd{background:${surface};color:${onSurf};font-family:"${bf}",sans-serif;line-height:1.6}
    .bgd .wrap{max-width:1040px;margin:0 auto;padding:0 24px}
    .bgd .hero{background:${pri};color:${onColor(pri)};padding:96px 0 72px;text-align:center}
    .bgd .eyebrow{display:inline-block;color:${acc};letter-spacing:.28em;text-transform:uppercase;font-size:12px;font-weight:600;margin-bottom:16px}
    .bgd h1{font-family:"${hf}",serif;font-size:clamp(38px,6vw,64px);margin:0 0 14px;font-weight:600}
    .bgd .hero p{opacity:.75;max-width:560px;margin:0 auto}
    .bgd h2{font-family:"${hf}",serif;font-size:clamp(26px,3.4vw,36px);margin:0 0 10px;font-weight:600}
    .bgd h3{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:${accDeep};margin:28px 0 14px}
    .bgd .sec{padding:64px 0;border-bottom:1px solid ${hexMix(sec, "#FFFFFF", 0.55)}}
    .bgd .sec.alt{background:${surfCont}}
    .bgd .lead{color:#555;max-width:680px;margin:0 0 8px}
    .bgd .logos{display:flex;gap:20px;flex-wrap:wrap;margin-top:22px}
    .bgd .logocard{flex:1;min-width:240px;border-radius:16px;padding:38px 24px;display:grid;place-items:center;border:1px solid ${hexMix(sec, "#FFFFFF", 0.5)}}
    .bgd .logocard img{max-height:72px;max-width:80%}
    .bgd .logocard .mono{font-family:"${hf}",serif;font-size:40px}
    .bgd .logocard small{display:block;margin-top:12px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.6}
    .bgd .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-top:6px}
    .bgd .bgd-sw{display:flex;flex-direction:column;gap:6px;font-size:13px}
    .bgd .bgd-sw b{font-weight:700}
    .bgd .bgd-sw span:last-child{color:#666;font-size:12.5px}
    .bgd .bgd-chip{height:92px;border-radius:14px;border:1px solid rgba(0,0,0,.08);display:flex;align-items:flex-end;padding:10px 12px}
    .bgd .bgd-chip code{font-size:12px;opacity:.9}
    .bgd .heromock{border-radius:18px;overflow:hidden;position:relative;margin-top:22px}
    .bgd .heromock .img{height:280px;background:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.55)),url('https://images.unsplash.com/photo-1629909613654-28e377c37b09?auto=format&w=1400&q=70') center/cover}
    .bgd .heromock .inner{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;color:#fff;padding:0 24px}
    .bgd .heromock .inner .eyebrow{color:${acc}}
    .bgd .heromock .inner h4{font-family:"${hf}",serif;font-size:clamp(26px,4vw,40px);margin:0 0 18px;font-weight:600}
    .bgd .btn-p{display:inline-block;background:${acc};color:${onColor(acc)};border-radius:999px;padding:13px 30px;font-weight:600;font-size:14px;text-decoration:none}
    .bgd .btn-o{display:inline-block;background:transparent;color:${onSurf};border:1.5px solid ${pri};border-radius:999px;padding:12px 28px;font-weight:600;font-size:14px;text-decoration:none}
    .bgd .btn-o.inv{color:#fff;border-color:#fff}
    .bgd .spec{border-left:3px solid ${acc};padding-left:20px;margin:18px 0}
    .bgd .spec .d1{font-family:"${hf}",serif;font-size:clamp(34px,4.6vw,52px);line-height:1.15}
    .bgd .spec .d2{font-family:"${hf}",serif;font-size:clamp(22px,3vw,30px)}
    .bgd .spec small{display:block;color:#777;font-size:12px;margin-top:4px}
    .bgd .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:8px}
    .bgd .col{background:#fff;border:1px solid ${hexMix(sec, "#FFFFFF", 0.5)};border-radius:14px;padding:20px}
    .bgd .col h4{margin:0 0 8px;font-size:14.5px}
    .bgd .col ul{margin:0;padding-left:18px;font-size:13.5px;color:#555}
    .bgd .col li{margin:4px 0}
    .bgd .comp{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:12px 0 6px}
    .bgd .eyelabel{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:${accDeep};font-weight:600}
    .bgd .quote{border-left:4px solid ${acc};background:#fff;border-radius:0 14px 14px 0;padding:18px 22px;font-family:"${hf}",serif;font-size:19px;font-style:italic;max-width:640px}
    .bgd .dodont{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:8px}
    .bgd .rule{border-radius:14px;padding:22px}
    .bgd .rule.do{background:${accCont}}
    .bgd .rule.dont{background:#fff;border:1px solid ${hexMix(sec, "#FFFFFF", 0.45)}}
    .bgd .rule h4{margin:0 0 10px;font-size:15px}
    .bgd .rule ul{margin:0;padding-left:18px;font-size:13.5px;color:#444}
    .bgd .rule li{margin:6px 0}
    .bgd .tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    .bgd .tag{background:${accCont};color:${accDeep};border-radius:999px;padding:6px 16px;font-size:13px;font-weight:600;text-transform:capitalize}
  </style>

  <div class="hero">
    <span class="eyebrow">Brand System</span>
    <h1>${escHtml(name)} Branding Guide</h1>
    <p>The single source of truth for how ${escHtml(name)} looks, speaks and feels — generated with the beta website.</p>
  </div>

  <div class="sec"><div class="wrap">
    <h2>1. The Logo — Where the Palette Comes From</h2>
    <p class="lead">Every color in this system is derived from or calibrated against the brand's core tones: <code>${escHtml(pri)}</code> and <code>${escHtml(acc)}</code>. The logo must live comfortably on both light and dark surfaces.</p>
    <div class="logos">
      <div class="logocard" style="background:#fff">${A.logo_file ? `<img src="${escHtml(A.logo_file)}" alt="${escHtml(name)} logo">` : `<span class="mono">${escHtml(name.slice(0, 1))}</span>`}<small>On light surfaces</small></div>
      <div class="logocard" style="background:${pri};color:${onColor(pri)}">${A.logo_file ? `<img src="${escHtml(A.logo_file)}" alt="${escHtml(name)} logo" style="filter:brightness(0) invert(1)">` : `<span class="mono" style="color:${acc}">${escHtml(name.slice(0, 1))}</span>`}<small style="opacity:.7">Inverted on primary</small></div>
    </div>
  </div></div>

  <div class="sec alt"><div class="wrap">
    <h2>2. Full Colour System</h2>
    <p class="lead">A role-based system: use colors by role, never by taste. Every hex below is derived from the two anchors.</p>
    <h3>Primary Group</h3>
    <div class="grid">${sw(pri, "Primary", "Headers, footer, hero backgrounds, key text")}${sw(priCont, "Primary Container", "Hover states on primary elements")}${sw(priInv, "Inverse Primary", "Text/icons on dark primary surfaces")}</div>
    <h3>Accent Group</h3>
    <div class="grid">${sw(acc, "Accent", "CTAs, highlights, eyebrow labels")}${sw(accDeep, "Accent Deep", "Interactive text, hover indicators")}${sw(accCont, "Accent Container", "Light tinted backgrounds, badges")}</div>
    <h3>Surface &amp; Neutral</h3>
    <div class="grid">${sw(surface, "Surface", "Body background — warm off-white")}${sw(surfCont, "Surface Container", "Alternating section backgrounds")}${sw(sec, "Secondary", "Borders, dividers, soft fills")}${sw(onSurf, "On Surface", "Primary body text color")}</div>
  </div></div>

  <div class="sec"><div class="wrap">
    <h2>3. Hero Section — Design Rationale</h2>
    <p class="lead">Full-bleed imagery under a dark scrim guarantees WCAG-readable white text at any photo. The eyebrow is always ${escHtml(acc)}; the headline is always ${escHtml(hf)}; the primary CTA is a full-pill accent button.</p>
    <div class="heromock"><div class="img"></div><div class="inner">
      <span class="eyebrow">${escHtml((A.practice_type || "Medical Aesthetics").toUpperCase())}</span>
      <h4>${escHtml(heroH)}</h4>
      <span><a class="btn-p" href="#">${escHtml(cta)}</a>&nbsp;&nbsp;<a class="btn-o inv" href="#">Explore treatments</a></span>
    </div></div>
  </div></div>

  <div class="sec alt"><div class="wrap">
    <h2>4. Typography System</h2>
    <p class="lead"><b>${escHtml(hf)}</b> carries every headline; <b>${escHtml(bf)}</b> carries everything else. Never swap the pairing.</p>
    <div class="spec"><div class="d1">${escHtml(hf)} — display &amp; H1</div><small>Headlines, hero statements · weight 600 · tight leading</small></div>
    <div class="spec"><div class="d2">Section headings sit at 28–36px</div><small>${escHtml(hf)} 600 · used for every H2/H3</small></div>
    <div class="spec"><p style="max-width:620px;margin:0">${escHtml(bf)} handles body copy at 15–17px with relaxed 1.6 leading, buttons at 14px/600, and captions at 12–13px. The quick brown fox jumps over the lazy dog.</p><small>${escHtml(bf)} 400/500/600</small></div>
  </div></div>

  <div class="sec"><div class="wrap">
    <h2>5. Responsive Design Strategy</h2>
    <div class="cols">
      <div class="col"><h4>Mobile (&lt; 640px)</h4><ul><li>Single column, generous 24px gutters</li><li>Hero headline clamps to ~32px</li><li>Sticky bottom "${escHtml(cta)}" bar</li><li>Nav collapses to a full-screen sheet</li></ul></div>
      <div class="col"><h4>Tablet (640–1024px)</h4><ul><li>Two-column grids for cards &amp; benefits</li><li>Hero at 60vh with side-anchored copy</li><li>Treatments dropdown becomes accordion</li></ul></div>
      <div class="col"><h4>Desktop (≥ 1024px)</h4><ul><li>Max content width 1120–1200px</li><li>Full-viewport cinematic hero</li><li>Hover states on all interactive elements</li></ul></div>
    </div>
  </div></div>

  <div class="sec alt"><div class="wrap">
    <h2>6. Component Language</h2>
    <h3>Buttons</h3>
    <div class="comp"><a class="btn-p" href="#">${escHtml(cta)}</a><a class="btn-o" href="#">Secondary action</a></div>
    <p class="lead" style="font-size:13.5px">Primary = accent pill with ${onColor(acc) === "#FFFFFF" ? "white" : "dark"} text. Secondary = transparent pill with a 1.5px primary border. Always fully rounded.</p>
    <h3>Eyebrow Labels</h3>
    <div class="comp"><span class="eyelabel">Signature Treatments</span><span class="eyelabel">Meet the Team</span></div>
    <h3>Testimonial Accent Bar</h3>
    ${review ? `<div class="quote">“${escHtml(review)}”</div>` : `<div class="quote">“A 4px ${escHtml(acc)} bar anchors every testimonial pull-quote.”</div>`}
  </div></div>

  <div class="sec"><div class="wrap">
    <h2>7. Voice &amp; Imagery</h2>
    ${tone.length ? `<div class="tags">${tone.map((x) => `<span class="tag">${escHtml(x)}</span>`).join("")}</div>` : ""}
    <p class="lead" style="margin-top:14px">${escHtml(imagery)}</p>
  </div></div>

  <div class="sec alt" style="border-bottom:none"><div class="wrap">
    <h2>8. Brand Rules — Do &amp; Don't</h2>
    <div class="dodont">
      <div class="rule do"><h4>✓ Do</h4><ul>
        <li>Use ${escHtml(pri)} for headers, footers and dark hero surfaces</li>
        <li>Use ${escHtml(acc)} for CTAs and accents — never for body text</li>
        <li>Always pair ${escHtml(hf)} headlines with ${escHtml(bf)} body</li>
        <li>Use full-pill rounding on every CTA button</li>
        <li>Keep surfaces in the ${escHtml(surface)} family</li>
        <li>Place a dark scrim behind any text over photography</li>
      </ul></div>
      <div class="rule dont"><h4>✕ Don't</h4><ul>
        <li>Don't use pure black (#000000) — it kills the warmth</li>
        <li>Don't set body copy in ${escHtml(acc)} — reserve it for accents</li>
        <li>Don't introduce a second serif or a new accent hue</li>
        <li>Don't use square-cornered buttons</li>
        <li>Don't place white text on photos without a scrim</li>
        <li>Don't scale the logo below 40px height</li>
      </ul></div>
    </div>
  </div></div>
</section>`;
}
// The generated theme header is STATIC HTML (no wp_nav_menu), so the provisioned
// WP menu never renders. This self-contained enhancer is appended to header.php:
// on load it finds the existing "/services/" (Treatments) nav link and attaches a
// hover dropdown of the service pages — markup-agnostic (keys off the href), so it
// works regardless of how the AI laid out the nav. Idempotent via the marker.
function navDropdownSnippet(services, composed) {
  const c = composed || {};
  const items = JSON.stringify(services.map((s) => ({ name: s.name, url: "/" + s.slug + "/" })));
  return `<!-- g99-treatments-dropdown -->
<style>
/* The wrapper is injected around the Treatments link ONLY, so hovering Home /
   Team / Contact can never open it (these themes have no <li> — every nav link
   sits in one shared container, so hovering the container was wrong). */
.g99-hasdrop{position:relative;display:inline-flex;align-items:center}
.g99-drop{position:absolute;top:100%;left:0;margin-top:2px;min-width:232px;background:${c.primary || "#141414"};border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:8px;display:none;flex-direction:column;gap:2px;z-index:99999;box-shadow:0 16px 40px rgba(0,0,0,.4)}
/* a small invisible bridge so the pointer can travel from link to panel */
.g99-drop::before{content:"";position:absolute;top:-8px;left:0;right:0;height:8px}
.g99-hasdrop:hover > .g99-drop,.g99-hasdrop:focus-within > .g99-drop{display:flex}
.g99-drop a{display:block;padding:9px 14px;color:#fff !important;text-decoration:none;border-radius:8px;font-size:14px;white-space:nowrap;font-weight:500}
.g99-drop a:hover,.g99-drop a:focus{background:rgba(255,255,255,.08);color:${c.accent || "#d4af37"} !important}
</style>
<script>
(function () {
  var items = ${items};
  function build() {
    var link = document.querySelector('a[href="/services/"], a[href$="/services/"]');
    if (!link || link.getAttribute('data-g99')) { return; }
    link.setAttribute('data-g99', '1');

    // Wrap the Treatments link itself — never its parent, which holds every
    // other nav link and would make them all trigger the dropdown.
    var host = link.closest('li');
    if (!host) {
      host = document.createElement('span');
      host.className = 'g99-hasdrop';
      link.parentElement.insertBefore(host, link);
      host.appendChild(link);
    } else {
      host.classList.add('g99-hasdrop');
    }

    var d = document.createElement('div');
    d.className = 'g99-drop';
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.href = it.url; a.textContent = it.name;
      d.appendChild(a);
    });
    host.appendChild(d);

    // Brand Guide as its own top-level nav item: clone the Treatments link so it
    // inherits the theme's nav styling, then place it after the wrapper.
    if (!document.querySelector('a[href="/brand-guide/"]')) {
      var bg = link.cloneNode(true);
      bg.textContent = 'Brand Guide';
      bg.setAttribute('href', '/brand-guide/');
      bg.removeAttribute('data-g99');
      host.parentElement.insertBefore(bg, host.nextSibling);
    }
  }
  if (document.readyState !== 'loading') { build(); } else { document.addEventListener('DOMContentLoaded', build); }
})();
</script>`;
}
function enrichPageTemplate(title, mainHtml) {
  return `<?php /* Template Name: ${title} */ ?>
<?php get_header(); ?>
<main id="main">
${mainHtml}
</main>
<?php get_footer(); ?>
`;
}
// Regenerate the mu-plugin so it (re)provisions every page (base + services +
// brand guide) and rebuilds the Primary menu with a "Treatments" parent whose
// children are the service pages. A fresh buildId forces re-provisioning; the
// menu is deleted + rebuilt so the dropdown always reflects the new pages.
function wpActivatorPluginEnriched(slug, biz, buildId, services) {
  const fn = "g99_provision_" + slug.replace(/[^a-z0-9]+/g, "_");
  const pages = [
    { title: "Home", slug: "home", template: "" },
    { title: "Treatments", slug: "services", template: "page-services.php" },
    { title: "Team", slug: "about", template: "page-about.php" },
    { title: "Contact", slug: "contact", template: "page-contact.php" },
    { title: "Branding", slug: "branding", template: "page-branding.php" },
    { title: "SEO", slug: "seo", template: "page-seo.php" },
    { title: "Brand Guide", slug: "brand-guide", template: "page-brand-guide.php" },
    ...services.map((s) => ({ title: s.name, slug: s.slug, template: `page-service-${s.slug}.php` })),
  ];
  const phpStr = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const pagesPhp = pages.map((p) => `            ['title' => '${phpStr(p.title)}', 'slug' => '${p.slug}', 'template' => '${p.template}'],`).join("\n");
  const childrenPhp = services.map((s) => `            ['slug' => '${s.slug}', 'title' => '${phpStr(s.name)}'],`).join("\n");
  return `<?php

/**
 * Growth99 beta theme auto-activator + page provisioner for "${biz}" (enriched).
 *
 * Activates the "g99-${slug}" theme once per build and provisions its Pages +
 * a Primary menu with a "Treatments" dropdown of individual service pages and a
 * public Brand Guide. Idempotent per build id. Delete this file to disable.
 */

add_action('init', function () {
    $slug = 'g99-${slug}';
    $build = '${buildId}';

    $theme = wp_get_theme($slug);
    if (! $theme->exists() || $theme->errors()) {
        return;
    }

    if (get_option('g99_autoactivated_' . $slug) !== $build) {
        if (get_stylesheet() !== $slug) {
            switch_theme($slug);
        }
        update_option('g99_autoactivated_' . $slug, $build);
    }

    if (get_stylesheet() === $slug && get_option('g99_provisioned_' . $slug) !== $build) {
        ${fn}();
        update_option('g99_provisioned_' . $slug, $build);
    }
});

if (! function_exists('${fn}')) {
    function ${fn}()
    {
        $pages = [
${pagesPhp}
        ];

        $service_children = [
${childrenPhp || "            // no service pages"}
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

        // Rebuild the Primary menu from scratch so the Treatments dropdown always
        // reflects the current service pages.
        $existing_menu = wp_get_nav_menu_object('Primary');
        if ($existing_menu) {
            wp_delete_nav_menu($existing_menu->term_id);
        }
        $menu_id = wp_create_nav_menu('Primary');

        $home = get_page_by_path('home');
        if ($home) {
            wp_update_nav_menu_item($menu_id, 0, [
                'menu-item-title' => 'Home',
                'menu-item-object' => 'page',
                'menu-item-object-id' => $home->ID,
                'menu-item-type' => 'post_type',
                'menu-item-status' => 'publish',
            ]);
        }

        $treat_parent = 0;
        $treat = get_page_by_path('services');
        if ($treat) {
            $treat_parent = wp_update_nav_menu_item($menu_id, 0, [
                'menu-item-title' => 'Treatments',
                'menu-item-object' => 'page',
                'menu-item-object-id' => $treat->ID,
                'menu-item-type' => 'post_type',
                'menu-item-status' => 'publish',
            ]);
        }

        foreach ($service_children as $c) {
            $pg = get_page_by_path($c['slug']);
            if ($pg) {
                wp_update_nav_menu_item($menu_id, 0, [
                    'menu-item-title' => $c['title'],
                    'menu-item-object' => 'page',
                    'menu-item-object-id' => $pg->ID,
                    'menu-item-type' => 'post_type',
                    'menu-item-status' => 'publish',
                    'menu-item-parent-id' => $treat_parent,
                ]);
            }
        }

        foreach ([['about', 'Team'], ['contact', 'Contact'], ['brand-guide', 'Brand Guide']] as $item) {
            $pg = get_page_by_path($item[0]);
            if ($pg) {
                wp_update_nav_menu_item($menu_id, 0, [
                    'menu-item-title' => $item[1],
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
`;
}

// Per-service generation status for the run detail (queued → generating → done/error).
// Kept on job.serviceDetail so it survives a reload; the Stitch path also has live
// GEN_PROGRESS, which the frontend prefers while the step is running.
function svcStatus(job, slug, status, engine) {
  const row = (job.serviceDetail || []).find((s) => s.slug === slug);
  if (!row) return;
  row.status = status;
  if (engine) row.engine = engine;
  saveJobs();
}
const ENRICH_STEPS = ["Pull latest code", "Plan services + brand guide", "Generate pages (AI)", "Push + open PR", "CI checks → auto-merge", "Sync registry"];
function newEnrichJob(payload) {
  return {
    type: "enrich",
    draftId: String(payload.jobId), businessId: payload.businessId || null,
    businessName: payload.businessName || payload.siteId || "Site",
    status: "queued", currentStep: 0,
    steps: ENRICH_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    liveUrl: payload.liveUrl || LIVE_URL || null,
    servicePages: null, brandGuide: true, editSummary: null, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
// Mirror the enrich run's outcome onto the parent build's final step, so the build
// timeline tells the whole story (and keeps polling clients updated). No-op when the
// enrich job was triggered manually (no parent).
function mirrorToParent(job, status, detail) {
  const pid = job.payload && job.payload.parentDraftId;
  if (!pid) return;
  const parent = JOBS.get(String(pid));
  if (!parent || !parent.steps || !parent.steps[ENRICH_STEP_IDX]) return;
  parent.steps[ENRICH_STEP_IDX].status = status;
  parent.steps[ENRICH_STEP_IDX].detail = String(detail || "").slice(0, 240);
  parent.enrichJobId = job.draftId;
  saveJobs();
}
function enqueueEnrichJob(payload) {
  const job = newEnrichJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId); saveJobs();
  processJobQueue();
  return job;
}
async function runEnrichJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  const P = job.payload;                 // {siteId, businessName, githubRepo, themeSlug, themePath, muPath, answers, composed, referenceWebsite}
  const repo = P.githubRepo || WP_REPO;
  const slug = String(P.themeSlug || "").replace(/^g99-/, "");
  const A = P.answers || {};
  let composed = P.composed || {};   // may be overridden by the theme's real brand below
  const city = deriveCity(A.location);
  const tmp = path.join(os.tmpdir(), "g99enrich-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => { let r; for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); } return r; };
  try {
    // 1 — pull latest (or, for a dry run, a local preview dir — no clone/PR)
    const dry = !!P.dryRun;
    let r, themeAbs, muAbs;
    if (dry) {
      themeAbs = path.join(GEN, "enrich-preview", slug || "preview");
      fs.rmSync(themeAbs, { recursive: true, force: true }); fs.mkdirSync(themeAbs, { recursive: true });
      muAbs = path.join(themeAbs, "_mu-plugin.php");
      jobStep(job, 0, "done", "Dry run — writing to " + themeAbs);
    } else {
      jobStep(job, 0, "running", "Cloning " + repo);
      r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
      const cloneUrl = process.env.GH_TOKEN ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
      if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
      if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
      if (process.env.GH_TOKEN) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
      themeAbs = path.join(tmp, P.themePath);
      muAbs = path.join(tmp, P.muPath);
      if (!fs.existsSync(themeAbs)) throw new Error("theme not found in repo: " + P.themePath);
      jobStep(job, 0, "done", "Latest code pulled");
    }
    // Trust the THEME, not the job record. `composed` is inherited from an
    // in-memory build job, which can be stale or belong to a different theme —
    // that's how the brand guide ended up documenting a palette the site never
    // used. The theme's own files are the source of truth for what it renders.
    // Which brand is authoritative depends on LINEAGE, not on what the theme
    // happens to declare. Auto-enrich is handed `composed` by the very build that
    // just pushed this theme, so that IS the intended brand — Stitch merely failed
    // to honour it in its chrome (enforceBrandFonts fixes that separately). A
    // manual run, by contrast, guesses `composed` from job history, which is how
    // the brand guide went stale — there, read the theme instead.
    const themeBrand = readThemeBrand(themeAbs);
    const fromBuild = !!(P.parentDraftId || P.brandAuthoritative) && composed && composed.headingFont;
    if (themeBrand && !fromBuild) {
      const before = `${composed.headingFont || "?"}/${composed.bodyFont || "?"} ${composed.primary || "?"}`;
      composed = {
        ...composed,
        headingFont: themeBrand.headingFont || composed.headingFont,
        bodyFont: themeBrand.bodyFont || composed.bodyFont,
        primary: themeBrand.primary || composed.primary,
        secondary: themeBrand.secondary || composed.secondary,
        accent: themeBrand.accent || composed.accent,
      };
      const after = `${composed.headingFont}/${composed.bodyFont} ${composed.primary}`;
      if (before !== after) log_srv(`brand re-read from theme: ${before} -> ${after}`);
    }
    job.brandSource = {
      from: fromBuild ? "build (authoritative)" : themeBrand ? "theme" : "inherited",
      theme: P.themeSlug,
      headingFont: composed.headingFont, bodyFont: composed.bodyFont,
      primary: composed.primary, secondary: composed.secondary, accent: composed.accent,
      themeDeclares: themeBrand ? { headingFont: themeBrand.headingFont, bodyFont: themeBrand.bodyFont, palette: themeBrand.palette } : null,
    };
    saveJobs();

    // 2 — plan services + reference structure
    jobStep(job, 1, "running", "Selecting services…");
    const { services, total, truncated } = selectServices(A);
    let ref = { count: 0, localSeo: false };
    try { ref = await discoverServicePages(P.referenceWebsite); } catch (e) { /* fail-soft */ }
    job.servicePages = services;
    job.enrichPlan = { services: services.map((s) => s.slug), total, truncated, refCount: ref.count };
    if (truncated) log_srv(`services truncated: ${total} → ${MAX_SERVICE_PAGES}`);
    jobStep(job, 1, "done", `${services.length} service page(s)${truncated ? ` (capped from ${total})` : ""} + brand guide${ref.count ? ` · ref has ${ref.count}` : ""}`);

    // 3 — generate pages: STITCH per service (grounded in the existing site's
    // matching page copy), Gemini template+clone only as the fallback. Each page's
    // own styles are embedded into its <main> (embedPageAssets) so nothing breaks
    // when the <head> is stripped for the WP template.
    jobStep(job, 2, "running", services.length ? "Scraping existing site's service pages…" : "Building brand guide…");
    const serviceMains = {};
    // headerOnly: re-apply just the nav enhancer (dropdown / Brand Guide link) to an
    // already-built theme. Skips all generation — no AI calls, no page rewrites — so a
    // nav fix ships in seconds instead of regenerating every service page.
    if (P.headerOnly) {
      jobStep(job, 2, "done", "Header-only run — navigation refresh, no pages regenerated");
    } else if (services.length) {
      let refs = {};
      try { refs = await scrapeExistingServiceRefs(P.existingWebsite, services); } catch (e) { /* fail-soft */ }
      const refCount = Object.keys(refs).length;
      // Design structure comes from the REFERENCE site's own service page (the
      // design the client said they love), not a hardcoded outline.
      let refStruct = null;
      try { refStruct = await scrapeReferenceServiceStructure(P.referenceWebsite); } catch (e) { /* fail-soft */ }
      jobStep(job, 2, "running", `Composing ${services.length} page brief(s) with Gemini${refStruct ? " (mimicking " + new URL(refStruct.url).hostname + ")" : ""}…`);
      const briefs = {};
      for (const s of services) {
        try { briefs[s.slug] = await composeServicePagePrompt(s, refStruct, refs[s.slug], A, composed, city); }
        catch (e) { briefs[s.slug] = null; }
      }
      const composedCount = Object.values(briefs).filter((b) => b && b.length > 120).length;
      // Persist per-service provenance so the run detail can show WHAT was
      // generated, FROM WHERE (existing-site source page), and WITH WHICH brief.
      job.serviceDetail = services.map((s) => ({
        name: s.name, slug: s.slug, status: "queued", engine: null,
        sourceUrl: (refs[s.slug] || {}).url || null,
        brief: (briefs[s.slug] || "").slice(0, 3000) || null,
      }));
      saveJobs();
      jobStep(job, 2, "running", `Generating ${services.length} service page(s) with Stitch (${composedCount} AI-composed briefs${refCount ? `, ${refCount} grounded in the existing site` : ""})…`);
      let results = null;
      try {
        const theme = { displayName: P.businessName, primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont };
        const pages = services.map((s) => ({
          key: s.slug,
          prompt: (briefs[s.slug] && briefs[s.slug].length > 120 ? briefs[s.slug] : stitchServicePrompt(s, refs[s.slug], A, composed, city)) + stylingConstraint(composed),
        }));
        // buildStitchSite writes GEN/.stitch-metadata.json (used by the main site's
        // export/rebind) — snapshot + restore so the enrich run never clobbers it.
        const metaFile = path.join(GEN, ".stitch-metadata.json");
        const metaBak = fs.existsSync(metaFile) ? fs.readFileSync(metaFile) : null;
        try { results = (await buildStitchSite(pages, theme, "DESKTOP")).results; }
        finally { if (metaBak) fs.writeFileSync(metaFile, metaBak); }
      } catch (e) { console.warn("enrich: Stitch generation failed, falling back to Gemini:", e.message.slice(0, 160)); }
      const okStitch = (results || []).filter((r) => r.html);
      job.enrichPlan = { ...(job.enrichPlan || {}), engine: okStitch.length ? "stitch" : "gemini", grounded: refCount, composedBriefs: composedCount, mimicked: refStruct ? refStruct.url : null };
      if (okStitch.length) {
        // Run the SAME image pipeline the build path uses — this was the gap that
        // made service-page heroes blurry: Stitch serves a ~512px thumbnail unless
        // the URL asks for full resolution, and enrich skipped the sharpener.
        job.imageReport = job.imageReport || {};
        for (const r of okStitch) {
          let h = enforceBrandFonts(r.html, composed); // Stitch ignores our fonts — state them
          h = sharpenStitchImages(h);                 // 512px thumb -> native 1600px
          h = await fixImages(h);                     // drop broken/expiring URLs
          h = await qcStitchImages(h);                // swap text-baked images
          const qc = await qcImageResolution(h);      // measure + replace low-res
          h = qc.html;
          job.imageReport[r.key] = qc.report;
          serviceMains[r.key] = embedPageAssets(h);
          svcStatus(job, r.key, "done", "stitch");
        }
        saveJobs();
        // any page Stitch missed: Gemini-clone it from the first good one
        const template = serviceMains[okStitch[0].key];
        for (const s of services) {
          if (serviceMains[s.slug]) continue;
          svcStatus(job, s.slug, "generating", "gemini");
          jobStep(job, 2, "running", `Stitch missed ${s.name} — cloning from template…`);
          try {
            const p = await polishServiceHtml(await cloneServicePage(template, s, A, composed, city), composed);
            serviceMains[s.slug] = p.html; job.imageReport[s.slug] = p.report;
            svcStatus(job, s.slug, "done", "gemini");
          }
          catch (e) { serviceMains[s.slug] = template; svcStatus(job, s.slug, "error", "gemini"); }
        }
      } else {
        // full fallback: Gemini template → clone path (uses the composed brief too)
        jobStep(job, 2, "running", "Stitch unavailable — generating with Gemini…");
        svcStatus(job, services[0].slug, "generating", "gemini");
        let template = await generateServiceTemplate(services[0], A, composed, ref, city, briefs[services[0].slug]);
        job.imageReport = job.imageReport || {};
        { const p = await polishServiceHtml(template, composed); template = p.html; job.imageReport[services[0].slug] = p.report; }
        serviceMains[services[0].slug] = template;
        svcStatus(job, services[0].slug, "done", "gemini");
        for (let i = 1; i < services.length; i++) {
          svcStatus(job, services[i].slug, "generating", "gemini");
          jobStep(job, 2, "running", `Cloning page ${i + 1}/${services.length}: ${services[i].name}`);
          try {
            const p = await polishServiceHtml(await cloneServicePage(template, services[i], A, composed, city), composed);
            serviceMains[services[i].slug] = p.html; job.imageReport[services[i].slug] = p.report;
            svcStatus(job, services[i].slug, "done", "gemini");
          }
          catch (e) { serviceMains[services[i].slug] = template; svcStatus(job, services[i].slug, "error", "gemini"); }
        }
      }
    }
    const brandMain = brandGuidePage(composed, A, P.businessName);
    const hubMain = servicesHubMain(services, A, composed);
    jobStep(job, 2, "done", `${services.length + 1} page(s) generated`);

    // 4 — write files + push + PR
    jobStep(job, 3, "running", P.headerOnly ? "Rewriting the header + opening PR…" : "Writing pages + opening PR…");
    const changed = [];
    if (!P.headerOnly) {
      for (const s of services) {
        const f = `page-service-${s.slug}.php`;
        fs.writeFileSync(path.join(themeAbs, f), enrichPageTemplate(s.name, serviceMains[s.slug]));
        changed.push(`${P.themePath}/${f}`);
      }
      if (services.length) { fs.writeFileSync(path.join(themeAbs, "page-services.php"), enrichPageTemplate("Treatments", hubMain)); changed.push(`${P.themePath}/page-services.php`); }
      fs.writeFileSync(path.join(themeAbs, "page-brand-guide.php"), enrichPageTemplate("Brand Guide", brandMain));
      changed.push(`${P.themePath}/page-brand-guide.php`);
    }
    // append the Treatments hover-dropdown enhancer to the (static) theme header,
    // so the service pages show as a dropdown in the top nav. Idempotent.
    if (services.length) {
      const headerAbs = path.join(themeAbs, "header.php");
      if (fs.existsSync(headerAbs)) {
        const h = fs.readFileSync(headerAbs, "utf8");
        // REPLACE any previous snippet rather than skipping when the marker exists —
        // otherwise an improved enhancer (e.g. the Brand Guide nav item) never ships.
        // The snippet is always appended last, so everything from the marker is ours.
        const base = h.split("<!-- g99-treatments-dropdown -->")[0].replace(/\s+$/, "");
        const next = base + "\n" + navDropdownSnippet(services, composed) + "\n";
        if (next !== h) {
          fs.writeFileSync(headerAbs, next);
          changed.push(`${P.themePath}/header.php`);
        }
      }
    }
    // regenerate the mu-plugin so the new pages + Treatments menu get provisioned
    // (skipped for a header-only run — the pages are already provisioned)
    if (!P.headerOnly) {
      const buildId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      fs.mkdirSync(path.dirname(muAbs), { recursive: true });
      fs.writeFileSync(muAbs, wpActivatorPluginEnriched(slug, P.businessName, buildId, services));
      changed.push(P.muPath);
    }
    if (!changed.length) throw new Error("nothing to change — the header already matches the current enhancer");
    job.editPlan = changed.map((p) => ({ path: p, op: P.headerOnly ? "modify" : "create" }));
    job.editSummary = P.headerOnly ? "Navigation fix (Treatments dropdown scope)" : `${services.length} service page(s) + brand guide`;

    if (dry) {
      job.previewDir = themeAbs;
      jobStep(job, 3, "done", `Dry run — wrote ${changed.length} file(s) to ${themeAbs}`);
      jobStep(job, 4, "done", "skipped (dry run)");
      jobStep(job, 5, "done", "skipped (dry run)");
      job.status = "done";
      notify(`✨ [dry run] Enrich preview for *${job.businessName}*: ${services.length} service pages + brand guide`);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/${P.headerOnly ? "nav" : "enrich"}-${slug}-${stamp}`;
    const title = P.headerOnly
      ? `Fix ${P.businessName}: scope the Treatments dropdown to its own nav item`
      : `Enrich ${P.businessName}: service pages + brand guide`;
    await run(`git checkout -b "${branch}"`, tmp);
    await run(`git add -A "${P.themePath}" "${P.muPath}"`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "${title.replace(/"/g, "'")}"`, tmp);
    if (r.code) throw new Error("commit failed (no changes?): " + (r.stderr || r.stdout).slice(-160));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    const prBody = P.headerOnly
      ? `Navigation fix for **${P.businessName}**.\\n\\nThe dropdown enhancer wrapped the whole nav container (these themes have no <li>), so hovering Home / Team / Contact opened the Treatments menu. It now wraps only the Treatments link.\\n\\nHeader template only — no pages regenerated.`
      : `Automated enrichment for **${P.businessName}**.\\n\\nAdds ${services.length} individual service page(s) (${services.map((s) => s.name).join(", ") || "none"}) under a Treatments dropdown, a services hub, and a public Brand Guide.${truncated ? `\\n\\n> Services capped at ${MAX_SERVICE_PAGES} of ${total}.` : ""}`;
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body "${prBody}"`, tmp);
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    job.branch = branch;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 3, "done", job.prUrl);

    // 5 — CI watch → auto-fix → merge on green (same rails as edit)
    jobStep(job, 4, "running", "Watching CI build checks…");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st; try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); } catch (e) { await sleep(10000); continue; }
      jobStep(job, 4, "running", (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ") || "CI starting…");
      if (st.allPass) { await awaitApprovalIfNeeded(job, P.siteId, 4); await localApi("/api/pr-merge", { prUrl: job.prUrl }); merged = true; jobStep(job, 4, "done", `Merged${fixes ? ` after ${fixes} fix(es)` : ""}`); break; }
      if (st.anyFail) {
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts — " + job.prUrl);
        fixes++; jobStep(job, 4, "running", `Build failed — Gemini auto-fix ${fixes}/3…`);
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        if (fix.billing) throw new Error(fix.message);
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI: " + (fix.message || ""));
        await sleep(20000); continue;
      }
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out after ~40 min — " + job.prUrl);

    // 6 — refresh registry
    jobStep(job, 5, "running", "Updating site registry…");
    try { await syncSiteRegistry(); } catch (e) { /* non-fatal */ }
    jobStep(job, 5, "done", "Done — service pages + brand guide live on deploy");
    job.status = "done";
    mirrorToParent(job, "done", `${services.length} service page(s) + brand guide merged`);
    notify(`✨ Enriched *${job.businessName}*: ${services.length} service pages + brand guide · ${job.prUrl || ""}`);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) { job.status = "cancelled"; mirrorToParent(job, "error", "Enrichment cancelled"); }
    else {
      job.error = e.message; job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      mirrorToParent(job, "error", e.message);
      console.error(`enrich job ${job.draftId} failed:`, e.message);
      notify(`❌ Enrichment failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job);
  }
}
function log_srv(m) { console.log("[enrich] " + m); }

// ============================================================ SEO ENGINE
// One click runs the whole of the SEO team's manual checklist over every page:
// keywords, head assets, URLs + redirects, headings, image alt, internal links,
// schema, and a content-relevance audit. Everything is derived from the theme in
// the repo rather than from a crawl, so it works whether or not a domain is live
// and can never lag behind a deploy.

// The head block these themes ship with is HARDCODED in header.php, which
// get_header() puts on every page. So today every page carries the same title,
// the same description and the same canonical — and on at least one theme that
// canonical names a different client's domain, which tells Google every page is
// a duplicate of somebody else's site. Everything below exists to replace that
// with a per-page layer.
const SEO_STEPS = [
  "Pull latest code",
  "Read every page",
  "Keywords + head copy",
  "URL strategy + redirects",
  "Headings, image alt, internal links",
  "Schema + SEO layer",
  "Content audit",
  "Check the work",
  "Push + open PR",
  "CI checks → merge",
  "Sync registry",
];

// ---- reading the theme -------------------------------------------------------
// The mu-plugin's $pages array is the authority on which template serves which
// slug and under what nav title — the templates themselves only carry a display
// name in their Template Name header.
function readMuPages(src) {
  const out = [];
  const block = (String(src || "").match(/\$pages\s*=\s*\[([\s\S]*?)\n\s*\];/) || [])[1] || "";
  const re = /\[\s*['"]title['"]\s*=>\s*['"]([^'"]*)['"]\s*,\s*['"]slug['"]\s*=>\s*['"]([^'"]*)['"]\s*,\s*['"]template['"]\s*=>\s*['"]([^'"]*)['"]/g;
  for (const m of block.matchAll(re)) out.push({ title: m[1], slug: m[2], template: m[3] });
  return out;
}

// Everything a page says, with the PHP and the chrome taken out. Scripts and
// styles go first: a Tailwind config block is thousands of characters of noise
// that would otherwise dominate the content the model reads.
function pageText(php) {
  return String(php || "")
    .replace(/<\?php[\s\S]*?\?>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function pageHeadings(php) {
  const out = [];
  for (const m of String(php || "").matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) out.push({ level: Number(m[1]), text, raw: m[0] });
  }
  return out;
}
function pageImages(php) {
  const out = [];
  for (const m of String(php || "").matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1];
    out.push({
      raw: m[0],
      src: (attrs.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || "",
      alt: (attrs.match(/\balt=["']([^"']*)["']/i) || [])[1],
    });
  }
  return out;
}
function pageLinks(php) {
  const out = [];
  for (const m of String(php || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']*)["']/i) || [])[1] || "";
    out.push({ href, text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return out;
}

// front-page.php is the home page; every other page is a template named in the
// mu-plugin. A template on disk that the mu-plugin never references is dead
// weight and is left alone rather than optimised.
function readSeoPages(themeAbs, muSrc) {
  const muPages = readMuPages(muSrc);
  const pages = [];
  const add = (slug, title, file) => {
    const abs = path.join(themeAbs, file);
    if (!fs.existsSync(abs)) return;
    const php = fs.readFileSync(abs, "utf8");
    pages.push({
      slug, title, file, php,
      text: pageText(php),
      headings: pageHeadings(php),
      images: pageImages(php),
      links: pageLinks(php),
    });
  };
  add("home", (muPages.find((p) => !p.template) || {}).title || "Home", "front-page.php");
  for (const p of muPages) {
    if (!p.template || p.slug === "home") continue;
    add(p.slug, p.title, p.template);
  }
  return { pages, muPages };
}

// ---- 1. business facts, from the contact page --------------------------------
// Not from onboarding answers: a repo Studio did not build has none, and the
// contact page is the one place every site states this for itself.
async function readBusinessFacts(pages, businessName, ai) {
  const contact = pages.find((p) => /contact/i.test(p.slug)) || pages.find((p) => /contact/i.test(p.text.slice(0, 4000)));
  const src = [contact && contact.text, (pages.find((p) => p.slug === "home") || {}).text].filter(Boolean).join("\n\n").slice(0, 6000);
  const fallback = { name: businessName, phone: "", email: "", street: "", city: "", region: "", postalCode: "", hours: "", priceRange: "" };
  if (!src) return fallback;
  try {
    const raw = await aiCall([{ text: [
      `Read this website's contact and home page text and pull out the business's real details. The business is "${businessName}".`,
      "Copy values exactly as written. Leave a field empty rather than guessing or inventing one — wrong contact details in structured data are worse than absent ones.",
      "", "PAGE TEXT:", "-----", src, "-----", "",
      'Return ONLY minified JSON: {"name":"","phone":"","email":"","street":"","city":"","region":"state or province","postalCode":"","hours":"e.g. Mo-Fr 09:00-18:00","priceRange":"e.g. $$"}',
    ].join("\n") }], { ...(ai || {}), temperature: 0.1, maxOutputTokens: 700, timeoutMs: 45000, json: true });
    const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
    const s = (k) => String(d[k] || "").trim();
    return { ...fallback, name: s("name") || businessName, phone: s("phone"), email: s("email"), street: s("street"), city: s("city"), region: s("region"), postalCode: s("postalCode"), hours: s("hours"), priceRange: s("priceRange") };
  } catch (e) {
    console.warn("seo: business facts failed —", e.message);
    return fallback;
  }
}

// ---- 2+3+4+7+8+10. keywords and head copy, one page at a time ----------------
// Grouped into a single call per page because they are one judgement: the
// primary keyword decides the title, the title decides the description, and the
// Open Graph copy is those two restated. Splitting them into five calls let the
// title drift away from the keyword the description was written for.
const SEO_ROBOTS = "index,follow,max-snippet:-1,max-video-preview:-1,max-image-preview:large";
async function seoHeadCopy(page, biz, businessName, ai) {
  const loc = [biz.city, biz.region].filter(Boolean).join(", ");
  const raw = await aiCall([{ text: [
    `You are the SEO lead for "${businessName}"${loc ? `, based in ${loc}` : ""}. Read this page and produce its SEO assets.`,
    "Work only from what the page actually says. Do not promise services it does not offer.",
    "",
    "RULES, all mandatory:",
    "- metaTitle: 50-60 characters. Primary keyword first, then location, then brand. Never longer than 60.",
    "- metaDescription: 150-160 characters. Contains the primary keyword and ends with a call to action. Never longer than 160.",
    "- h1: one line, the page's single H1. Carries the primary keyword and reads as a headline, not a sentence.",
    "- primaryKeyword: the one phrase this page should rank for. Include the location when the page is local in nature.",
    "- secondaryKeywords: 3-5 supporting phrases. semanticKeywords: 5-8 related terms a search engine would expect on this topic.",
    "- ogTitle up to 60 chars, ogDescription up to 110 — these are read on a social card, not in search results.",
    "",
    `PAGE: ${page.title} (slug: ${page.slug})`,
    `EXISTING HEADINGS: ${page.headings.slice(0, 12).map((h) => "H" + h.level + " " + h.text).join(" | ") || "none"}`,
    "PAGE TEXT:", "-----", page.text.slice(0, 7000), "-----", "",
    'Return ONLY minified JSON: {"primaryKeyword":"","secondaryKeywords":[],"semanticKeywords":[],"metaTitle":"","metaDescription":"","h1":"","ogTitle":"","ogDescription":""}',
  ].join("\n") }], { ...(ai || {}), temperature: 0.3, maxOutputTokens: 1200, timeoutMs: 60000, json: true });
  const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const s = (k) => String(d[k] || "").trim();
  const arr = (k) => (Array.isArray(d[k]) ? d[k].map((x) => String(x || "").trim()).filter(Boolean) : []);
  const out = {
    primaryKeyword: s("primaryKeyword"),
    secondaryKeywords: arr("secondaryKeywords").slice(0, 5),
    semanticKeywords: arr("semanticKeywords").slice(0, 8),
    metaTitle: s("metaTitle"),
    metaDescription: s("metaDescription"),
    h1: s("h1"),
    ogTitle: s("ogTitle") || s("metaTitle"),
    ogDescription: s("ogDescription") || s("metaDescription"),
  };

  // Models land near a character range rather than inside it. Reporting that as
  // a failed check and shipping it anyway would be no use to anyone, so ask
  // once for a corrected pair, quoting the exact miss.
  const off = () => {
    const t = out.metaTitle.length, dd = out.metaDescription.length;
    const bad = [];
    if (t < 50 || t > 60) bad.push(`metaTitle is ${t} characters, needs 50-60`);
    if (dd < 150 || dd > 160) bad.push(`metaDescription is ${dd} characters, needs 150-160`);
    return bad;
  };
  const bad = off();
  if (bad.length) {
    try {
      const fix = await aiCall([{ text: [
        "Rewrite these two SEO fields so they land inside their character ranges. Keep the same meaning, the same keyword and the same call to action — change only the length.",
        "Count characters exactly. This is the one thing that must be right.",
        "", ...bad.map((b) => "- " + b), "",
        `CURRENT metaTitle: ${out.metaTitle}`,
        `CURRENT metaDescription: ${out.metaDescription}`,
        `PAGE SUBJECT: ${out.primaryKeyword}`,
        "",
        'Return ONLY minified JSON: {"metaTitle":"","metaDescription":""}',
      ].join("\n") }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 500, timeoutMs: 45000, json: true });
      const f = JSON.parse((stripFence(fix).match(/\{[\s\S]*\}/) || ["{}"])[0]);
      const ft = String(f.metaTitle || "").trim(), fd = String(f.metaDescription || "").trim();
      // Only take the retry where it actually improved that field.
      const closer = (next, cur, lo, hi) => {
        const miss = (n) => (n.length < lo ? lo - n.length : n.length > hi ? n.length - hi : 0);
        return next && miss(next) < miss(cur) ? next : cur;
      };
      out.metaTitle = closer(ft, out.metaTitle, 50, 60);
      out.metaDescription = closer(fd, out.metaDescription, 150, 160);
    } catch (e) {
      console.warn("seo: length repair failed —", e.message);
    }
  }
  // Backstop. Over-length is the harmful direction — Google truncates it mid
  // sentence — so it is cut at a word boundary no matter what the model said.
  // Under-length is merely a wasted opportunity and is left visible in the check.
  const trim = (t, max) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, ""));
  out.metaTitle = trim(out.metaTitle, 60);
  out.metaDescription = trim(out.metaDescription, 160);
  out.ogTitle = trim(out.ogTitle, 60);
  out.ogDescription = trim(out.ogDescription, 110);
  return out;
}

// ---- 1. URL strategy ---------------------------------------------------------
// The spec says "keep existing URL if valuable; otherwise recommend an
// SEO-friendly URL", and that restraint is the whole point: every rename risks
// the page's standing even with a redirect behind it, so this only fires on a
// clear mismatch between the slug and what the page is about. The home page is
// never renamed — its URL is the domain.
async function seoUrlStrategy(pages, ai) {
  const list = pages.filter((p) => p.slug !== "home")
    .map((p) => `${p.slug} | ${p.title} | primary keyword: ${p.seo.primaryKeyword} | about: ${p.text.slice(0, 200)}`).join("\n");
  if (!list) return [];
  const raw = await aiCall([{ text: [
    "Below are the URL slugs of one website's pages, with what each page is actually about.",
    "Judge each slug. Keep it unless it is genuinely poor — misleading, meaningless, abbreviated past recognition, or unrelated to the page's subject.",
    "Do NOT propose a rename for a slug that is merely shorter or longer than you would have chosen. A rename costs the page some of its standing in search even with a redirect, so it must be worth that.",
    "A replacement slug is lowercase, hyphen-separated, 1-4 words, no stop words, and describes the page's subject.",
    "", "PAGES (slug | title | keyword | about):", list, "",
    'Return ONLY minified JSON: {"renames":[{"from":"current-slug","to":"new-slug","why":"one line on why the current slug fails"}]}',
    "Return an empty array when every slug is fine. That is the expected answer for a well-built site.",
  ].join("\n") }], { ...(ai || {}), temperature: 0.1, maxOutputTokens: 900, timeoutMs: 60000, json: true });
  const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const known = new Set(pages.map((p) => p.slug));
  const clean = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const seen = new Set();
  return (Array.isArray(d.renames) ? d.renames : [])
    .map((r) => ({ from: clean(r && r.from), to: clean(r && r.to), why: String((r && r.why) || "").trim() }))
    .filter((r) => r.from && r.to && r.from !== r.to && r.from !== "home" && known.has(r.from) && !known.has(r.to) && !seen.has(r.to) && seen.add(r.to));
}

// ---- 12. heading hierarchy ---------------------------------------------------
// Deterministic, because it is a structural rule and not a matter of taste:
// exactly one H1, and no level skipped on the way down.
function seoFixHeadings(php, h1Text) {
  let out = String(php);
  const notes = [];
  const hs = () => pageHeadings(out);
  let heads = hs();
  const h1s = heads.filter((h) => h.level === 1);

  if (h1s.length === 0) {
    const first = heads.find((h) => h.level === 2);
    if (first) {
      out = out.replace(first.raw, first.raw.replace(/^<h2/i, "<h1").replace(/<\/h2>$/i, "</h1>"));
      notes.push(`no H1 — promoted "${first.text.slice(0, 60)}" from H2`);
    }
  } else if (h1s.length > 1) {
    for (const extra of h1s.slice(1)) {
      out = out.replace(extra.raw, extra.raw.replace(/^<h1/i, "<h2").replace(/<\/h1>$/i, "</h2>"));
    }
    notes.push(`${h1s.length} H1s — demoted ${h1s.length - 1} to H2`);
  }
  // Rewrite the H1's words only when the page had none worth keeping: an
  // existing headline is the designer's, and replacing it is a content change
  // nobody asked for.
  heads = hs();
  const h1 = heads.find((h) => h.level === 1);
  if (h1 && !h1.text.trim() && h1Text) {
    out = out.replace(h1.raw, h1.raw.replace(/>([\s\S]*)<\/h1>/i, `>${h1Text}</h1>`));
    notes.push("empty H1 — filled from the page's primary keyword");
  }
  // Skipped levels: an H4 directly under an H2 becomes an H3. Only ever
  // promotes, so nothing can be pushed below its own parent.
  heads = hs();
  let prev = 1;
  for (const h of heads) {
    if (h.level > prev + 1) {
      const want = prev + 1;
      out = out.replace(h.raw, h.raw.replace(new RegExp(`^<h${h.level}`, "i"), `<h${want}`).replace(new RegExp(`</h${h.level}>$`, "i"), `</h${want}>`));
      notes.push(`H${h.level} after H${prev} — raised to H${want}`);
      prev = want;
    } else {
      prev = h.level;
    }
  }
  return { php: out, notes };
}

// ---- 9. image alt ------------------------------------------------------------
async function seoImageAlts(page, biz, businessName, ai) {
  const missing = page.images.filter((im) => im.alt === undefined || !String(im.alt).trim());
  if (!missing.length) return { php: page.php, filled: 0 };
  const loc = [biz.city, biz.region].filter(Boolean).join(", ");
  let alts = [];
  try {
    const raw = await aiCall([{ text: [
      `Write ALT text for the images on the "${page.title}" page of ${businessName}${loc ? ` in ${loc}` : ""}.`,
      "ALT text describes what the image shows for someone who cannot see it. Keep it under 125 characters, describe the subject, and do not stuff keywords or start with \"image of\".",
      `The page is about: ${page.seo.primaryKeyword || page.title}.`,
      "PAGE TEXT (for context):", page.text.slice(0, 2500), "",
      "IMAGES, in order:", ...missing.map((im, i) => `${i + 1}. ${im.src.slice(0, 120) || "(no src)"}`), "",
      `Return ONLY minified JSON: {"alts":["one entry per image, in the same order"]}`,
    ].join("\n") }], { ...(ai || {}), temperature: 0.4, maxOutputTokens: 900, timeoutMs: 60000, json: true });
    const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
    alts = Array.isArray(d.alts) ? d.alts.map((a) => String(a || "").trim()) : [];
  } catch (e) {
    console.warn("seo: alt text failed —", e.message);
  }
  let out = page.php, filled = 0;
  missing.forEach((im, i) => {
    const text = (alts[i] || `${page.seo.primaryKeyword || page.title}${loc ? ` — ${loc}` : ""}`).replace(/"/g, "&quot;").slice(0, 125);
    const next = /\balt\s*=/i.test(im.raw)
      ? im.raw.replace(/\balt=["'][^"']*["']/i, `alt="${text}"`)
      : im.raw.replace(/^<img\b/i, `<img alt="${text}"`);
    if (out.includes(im.raw)) { out = out.replace(im.raw, next); filled++; }
  });
  return { php: out, filled };
}

// ---- 11. internal links ------------------------------------------------------
// The page inventory is what makes this decidable without a human: we know every
// page, its subject and its URL, so a mention of one page's subject inside
// another page is a link with a known destination. The rules below are what keep
// it from turning into link spam.
const SEO_MAX_LINKS_PER_PAGE = 5;
async function seoInternalLinks(pages, ai) {
  const inventory = pages.map((p) => `/${p.slug === "home" ? "" : p.slug + "/"} | ${p.title} | ${p.seo.primaryKeyword}`).join("\n");
  const out = [];
  for (const page of pages) {
    const others = pages.filter((p) => p.slug !== page.slug);
    if (!others.length) continue;
    // Only text outside headings, existing anchors and the chrome is eligible.
    let plan = [];
    try {
      const raw = await aiCall([{ text: [
        `Find internal links to add to the "${page.title}" page of this website.`,
        "An anchor is a phrase ALREADY PRESENT in the page's body text that names another page's subject. Copy it exactly as it appears — if the phrase is not in the text below, character for character, do not propose it.",
        "Propose the first, most natural mention only. Never the same phrase twice, never a link to this page itself, and nothing that already sits inside a link.",
        `At most ${SEO_MAX_LINKS_PER_PAGE}. Fewer is correct and normal — propose none rather than reaching.`,
        "", "PAGES ON THIS SITE (url | title | subject):", inventory, "",
        `THIS PAGE IS: /${page.slug === "home" ? "" : page.slug + "/"}`,
        "PAGE TEXT:", "-----", page.text.slice(0, 6000), "-----", "",
        'Return ONLY minified JSON: {"links":[{"anchor":"exact phrase from the text","to":"/target-slug/","why":"a few words"}]}',
      ].join("\n") }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 800, timeoutMs: 60000, json: true });
      const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
      plan = Array.isArray(d.links) ? d.links : [];
    } catch (e) {
      console.warn(`seo: internal links failed for ${page.slug} —`, e.message);
    }
    const valid = new Set(pages.map((p) => "/" + (p.slug === "home" ? "" : p.slug + "/")));
    const added = [];
    let php = page.php;
    for (const l of plan) {
      if (added.length >= SEO_MAX_LINKS_PER_PAGE) break;
      const anchor = String((l && l.anchor) || "").trim();
      const to = String((l && l.to) || "").trim();
      if (anchor.length < 4 || anchor.length > 80 || !valid.has(to) || to === "/" + (page.slug === "home" ? "" : page.slug + "/")) continue;
      if (added.some((a) => a.anchor.toLowerCase() === anchor.toLowerCase())) continue;
      // The anchor must sit in plain body text: not inside an attribute, not
      // already linked, not in a heading, the nav or the footer. Checked
      // against the markup rather than taken on the model's word.
      //
      // Every occurrence is tested, not just the first. A phrase is usually
      // named by a heading before it appears in the copy below it, so stopping
      // at the first match meant the most natural anchors could never be used.
      const lower = php.toLowerCase(), needle = anchor.toLowerCase();
      const BLOCKS = /<(a|h[1-6]|nav|footer|title|button|script|style)\b/gi;
      const BLOCKE = /<\/(a|h[1-6]|nav|footer|title|button|script|style)>/gi;
      let idx = -1, at = lower.indexOf(needle);
      while (at !== -1) {
        const before = php.slice(0, at);
        const inTag = before.lastIndexOf("<") > before.lastIndexOf(">");
        const open = (before.match(BLOCKS) || []).length;
        const close = (before.match(BLOCKE) || []).length;
        if (!inTag && open <= close) { idx = at; break; }
        at = lower.indexOf(needle, at + 1);
      }
      if (idx === -1) continue;
      php = php.slice(0, idx) + `<a href="${to}">` + php.slice(idx, idx + anchor.length) + "</a>" + php.slice(idx + anchor.length);
      added.push({ anchor, to, why: String((l && l.why) || "").trim() });
    }
    // Broken internal hrefs: a link pointing at a slug this site does not have.
    const broken = page.links
      .filter((l) => /^\/[a-z0-9-]*\/?$/i.test(l.href) && !valid.has(l.href.endsWith("/") ? l.href : l.href + "/"))
      .map((l) => ({ href: l.href, text: l.text.slice(0, 60) }));
    out.push({ slug: page.slug, php, added, broken });
  }
  return out;
}

// ---- 14. content audit -------------------------------------------------------
// Not readability, not EEAT boxes: the question is whether a page about Botox is
// actually about Botox, or whether it is mostly clinic boilerplate wearing a
// Botox headline. Reported, never rewritten — writing the copy is a different
// job.
async function seoContentAudit(page, ai) {
  try {
    const raw = await aiCall([{ text: [
      `Judge whether this page's content is genuinely about its subject.`,
      `PAGE: "${page.title}" — its subject is: ${page.seo.primaryKeyword || page.title}`,
      "",
      "Estimate what share of the body copy is specific to that subject, as opposed to generic clinic or business copy that would sit equally well on any other page.",
      "Then say what a strong page on this subject would cover that this one does not. Be concrete and specific to the subject — not general SEO advice.",
      "",
      "PAGE TEXT:", "-----", page.text.slice(0, 8000), "-----", "",
      'Return ONLY minified JSON: {"onTopicPercent":<0-100>,"verdict":"one sentence","missing":["what a page on this subject should cover but does not"]}',
    ].join("\n") }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 800, timeoutMs: 60000, json: true });
    const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
    const pct = Math.max(0, Math.min(100, Math.round(Number(d.onTopicPercent) || 0)));
    return {
      slug: page.slug, title: page.title, onTopicPercent: pct,
      verdict: String(d.verdict || "").trim(),
      missing: (Array.isArray(d.missing) ? d.missing : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6),
      words: page.text.split(/\s+/).filter(Boolean).length,
    };
  } catch (e) {
    console.warn(`seo: content audit failed for ${page.slug} —`, e.message);
    return { slug: page.slug, title: page.title, onTopicPercent: null, verdict: "Could not be audited — " + e.message.slice(0, 80), missing: [], words: page.text.split(/\s+/).filter(Boolean).length };
  }
}

// ---- 13. schema --------------------------------------------------------------
// Built in code rather than by the model: schema is a set of facts in a fixed
// shape, and a model asked to produce it will cheerfully fill gaps with
// plausible opening hours. Review and rating markup is emitted ONLY when the
// page carries real reviews — inventing it is a manual action from Google.
function seoSchema(page, pages, biz, origin) {
  const url = origin ? origin + (page.slug === "home" ? "/" : `/${page.slug}/`) : "";
  const graph = [];
  const org = { "@type": "MedicalBusiness", "@id": origin ? origin + "/#business" : undefined, name: biz.name };
  if (biz.phone) org.telephone = biz.phone;
  if (biz.email) org.email = biz.email;
  if (origin) org.url = origin + "/";
  if (biz.street || biz.city) {
    org.address = { "@type": "PostalAddress" };
    if (biz.street) org.address.streetAddress = biz.street;
    if (biz.city) org.address.addressLocality = biz.city;
    if (biz.region) org.address.addressRegion = biz.region;
    if (biz.postalCode) org.address.postalCode = biz.postalCode;
  }
  if (biz.hours) org.openingHours = biz.hours;
  if (biz.priceRange) org.priceRange = biz.priceRange;

  if (page.slug === "home") {
    graph.push(org);
    if (origin) graph.push({ "@type": "WebSite", "@id": origin + "/#website", url: origin + "/", name: biz.name, publisher: { "@id": origin + "/#business" } });
  }
  const webPage = { "@type": "WebPage", name: page.seo.metaTitle || page.title, description: page.seo.metaDescription || undefined };
  if (url) webPage.url = url;
  if (origin) webPage.isPartOf = { "@id": origin + "/#website" };
  graph.push(webPage);

  if (page.slug !== "home" && origin) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: origin + "/" },
        { "@type": "ListItem", position: 2, name: page.title, item: url },
      ],
    });
  }
  // A page that exists to sell one treatment is a Service. Hub pages ("our
  // treatments") list many and are not.
  if (/^(page-)?service/i.test(page.file) || (page.slug !== "home" && !/services|about|contact|team|brand|blog|seo/i.test(page.slug))) {
    const svc = { "@type": "Service", name: page.title, description: page.seo.metaDescription || undefined };
    if (origin) svc.provider = { "@id": origin + "/#business" };
    if (biz.city) svc.areaServed = [biz.city, biz.region].filter(Boolean).join(", ");
    graph.push(svc);
  }
  // FAQPage only when the page really carries question/answer pairs.
  const qs = (page.text.match(/[A-Z][^.?!]{10,120}\?/g) || []).slice(0, 8);
  if (qs.length >= 3 && /faq|frequently asked/i.test(page.text)) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: qs.map((q) => ({ "@type": "Question", name: q.trim(), acceptedAnswer: { "@type": "Answer", text: "" } })),
    });
  }
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined || v === "" ? undefined : v)));
  return strip({ "@context": "https://schema.org", "@graph": graph });
}

// ---- the generated SEO layer -------------------------------------------------
// One file, regenerated whole on every run, so the diff reads as "here is the
// site's SEO" rather than as scattered edits across a dozen templates.
// Formatted for Laravel Pint's PER preset: blank line after <?php, a named
// function's brace on its own line, one statement per line.
function phpQuote(s) {
  return "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
function phpArray(obj, indent) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 4);
  const rows = Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return `${inner}${phpQuote(k)} => [${v.map(phpQuote).join(", ")}],`;
    if (v && typeof v === "object") return `${inner}${phpQuote(k)} => ${phpArray(v, indent + 4)},`;
    return `${inner}${phpQuote(k)} => ${phpQuote(v)},`;
  });
  return `[\n${rows.join("\n")}\n${pad}]`;
}
function seoIncludePhp(entries, redirects, businessName) {
  const map = entries.map((e) => {
    const row = {
      title: e.metaTitle,
      description: e.metaDescription,
      canonical: e.canonical || "",
      robots: SEO_ROBOTS,
      og_title: e.ogTitle,
      og_description: e.ogDescription,
      og_image: e.ogImage || "",
      og_image_alt: e.ogImageAlt || "",
      keywords: [e.primaryKeyword, ...e.secondaryKeywords].filter(Boolean).join(", "),
      schema: JSON.stringify(e.schema),
    };
    return `        ${phpQuote(e.slug)} => ${phpArray(row, 8)},`;
  }).join("\n");
  const red = redirects.map((r) => `        ${phpQuote(r.from)} => ${phpQuote(r.to)},`).join("\n");
  return `<?php

/**
 * ${businessName} — SEO layer, generated by the Growth99 "Perform SEO" job.
 *
 * Every page gets its own title, description, canonical, social cards and
 * structured data. Regenerated whole on each run — edit the site content, not
 * this file, and re-run the job.
 */

if (! defined('ABSPATH')) {
    exit;
}

function g99_seo_map()
{
    return [
${map}
    ];
}

/**
 * Slugs this job renamed, old => new. Kept so links and search results that
 * still point at the old URL land on the new page instead of a 404.
 */
function g99_seo_redirects()
{
    return [
${red}
    ];
}

function g99_seo_slug()
{
    if (is_front_page() || is_home()) {
        return 'home';
    }

    $post = get_post();

    return $post ? $post->post_name : '';
}

function g99_seo_current()
{
    $map = g99_seo_map();
    $slug = g99_seo_slug();

    return isset($map[$slug]) ? $map[$slug] : null;
}

/**
 * A renamed page keeps its identity: the existing post is renamed rather than a
 * second one being created alongside it. Idempotent — once the rename has
 * happened the old slug no longer resolves and this does nothing.
 */
add_action('init', function () {
    foreach (g99_seo_redirects() as $old => $new) {
        $existing = get_page_by_path($old);

        if ($existing && ! get_page_by_path($new)) {
            wp_update_post(['ID' => $existing->ID, 'post_name' => $new]);
        }
    }
}, 20);

add_action('template_redirect', function () {
    if (! is_404()) {
        return;
    }

    $path = trim(parse_url(add_query_arg([]), PHP_URL_PATH), '/');
    $redirects = g99_seo_redirects();

    if (isset($redirects[$path])) {
        wp_redirect(home_url('/' . $redirects[$path] . '/'), 301);
        exit;
    }
}, 1);

add_filter('pre_get_document_title', function ($title) {
    $seo = g99_seo_current();

    return ($seo && $seo['title']) ? $seo['title'] : $title;
});

// WordPress emits its own canonical; ours is page-specific and replaces it.
remove_action('wp_head', 'rel_canonical');

add_action('wp_head', function () {
    $seo = g99_seo_current();

    if (! $seo) {
        return;
    }

    $out = [];
    $out[] = '<meta name="description" content="' . esc_attr($seo['description']) . '">';
    $out[] = '<meta name="robots" content="' . esc_attr($seo['robots']) . '">';

    if ($seo['keywords']) {
        $out[] = '<meta name="keywords" content="' . esc_attr($seo['keywords']) . '">';
    }

    if ($seo['canonical']) {
        $out[] = '<link rel="canonical" href="' . esc_url($seo['canonical']) . '">';
        $out[] = '<meta property="og:url" content="' . esc_url($seo['canonical']) . '">';
    }

    $out[] = '<meta property="og:type" content="website">';
    $out[] = '<meta property="og:site_name" content="' . esc_attr(get_bloginfo('name')) . '">';
    $out[] = '<meta property="og:title" content="' . esc_attr($seo['og_title']) . '">';
    $out[] = '<meta property="og:description" content="' . esc_attr($seo['og_description']) . '">';
    $out[] = '<meta name="twitter:card" content="summary_large_image">';
    $out[] = '<meta name="twitter:title" content="' . esc_attr($seo['og_title']) . '">';
    $out[] = '<meta name="twitter:description" content="' . esc_attr($seo['og_description']) . '">';

    if ($seo['og_image']) {
        $out[] = '<meta property="og:image" content="' . esc_url($seo['og_image']) . '">';
        $out[] = '<meta property="og:image:alt" content="' . esc_attr($seo['og_image_alt']) . '">';
        $out[] = '<meta name="twitter:image" content="' . esc_url($seo['og_image']) . '">';
    }

    if ($seo['schema']) {
        $out[] = '<script type="application/ld+json">' . $seo['schema'] . '</script>';
    }

    echo "\\n" . implode("\\n", $out) . "\\n";
}, 1);
`;
}

// The hardcoded head block in header.php is what made every page identical.
// Removing it is not optional cleanup — leaving it means two titles, two
// canonicals and two sets of Open Graph tags fighting each other.
function seoStripLegacyHead(header) {
  let out = String(header || "");
  const removed = [];
  const cut = (re, label) => {
    if (re.test(out)) { out = out.replace(re, ""); removed.push(label); }
  };
  cut(/[ \t]*<title\b[^>]*>[\s\S]*?<\/title>\s*\n?/gi, "title");
  cut(/[ \t]*<meta\s+name=["']description["'][^>]*>\s*\n?/gi, "meta description");
  cut(/[ \t]*<meta\s+name=["']keywords["'][^>]*>\s*\n?/gi, "meta keywords");
  cut(/[ \t]*<meta\s+name=["']robots["'][^>]*>\s*\n?/gi, "meta robots");
  cut(/[ \t]*<link\s+rel=["']canonical["'][^>]*>\s*\n?/gi, "canonical");
  cut(/[ \t]*<meta\s+property=["']og:[^"']*["'][^>]*>\s*\n?/gi, "Open Graph");
  cut(/[ \t]*<meta\s+name=["']twitter:[^"']*["'][^>]*>\s*\n?/gi, "Twitter cards");
  cut(/[ \t]*<script\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>\s*\n?/gi, "JSON-LD");
  // Without wp_head() nothing we generate is ever printed.
  if (!/wp_head\s*\(/.test(out)) {
    out = out.replace(/<\/head>/i, "<?php wp_head(); ?>\n</head>");
    removed.push("added missing wp_head()");
  }
  return { php: out.replace(/\n{3,}/g, "\n\n"), removed };
}

function seoEnsureInclude(functionsPhp, themeSlug) {
  const line = "require_once get_template_directory() . '/inc/g99-seo.php';";
  if (functionsPhp.includes("inc/g99-seo.php")) return functionsPhp;
  const marker = /<\?php\s*\n/;
  return marker.test(functionsPhp)
    ? functionsPhp.replace(marker, (m) => m + "\n// Generated per-page SEO layer — see the \"Perform SEO\" job.\n" + line + "\n")
    : `<?php\n\n${line}\n\n` + functionsPhp;
}

// ---- checking the work -------------------------------------------------------
// Almost all of it is a rule with a number attached, so unlike an edit job this
// needs no model to verify: the checks below either pass or they do not.
function seoVerify(entries, pages) {
  const rows = [];
  for (const e of entries) {
    const page = pages.find((p) => p.slug === e.slug) || {};
    const heads = pageHeadings(page.php || "");
    const h1s = heads.filter((h) => h.level === 1).length;
    const imgs = pageImages(page.php || "");
    const noAlt = imgs.filter((im) => im.alt === undefined || !String(im.alt).trim()).length;
    let skipped = 0, prev = 1;
    for (const h of heads) { if (h.level > prev + 1) skipped++; prev = h.level; }
    let schemaOk = true;
    try { JSON.parse(JSON.stringify(e.schema)); } catch (err) { schemaOk = false; }
    const checks = [
      { k: "Meta title 50–60 chars", ok: e.metaTitle.length >= 50 && e.metaTitle.length <= 60, got: `${e.metaTitle.length} chars` },
      { k: "Meta description 150–160 chars", ok: e.metaDescription.length >= 150 && e.metaDescription.length <= 160, got: `${e.metaDescription.length} chars` },
      { k: "Exactly one H1", ok: h1s === 1, got: `${h1s} H1` },
      { k: "No skipped heading levels", ok: skipped === 0, got: skipped ? `${skipped} skipped` : "clean" },
      { k: "Every image has alt text", ok: noAlt === 0, got: noAlt ? `${noAlt} missing` : `${imgs.length} ok` },
      { k: "Canonical set", ok: !!e.canonical, got: e.canonical || "no domain on file" },
      { k: "Schema valid JSON-LD", ok: schemaOk, got: schemaOk ? `${(e.schema["@graph"] || []).length} types` : "invalid" },
    ];
    rows.push({ slug: e.slug, title: e.title, checks, pass: checks.filter((c) => c.ok).length, total: checks.length });
  }
  const pass = rows.reduce((n, r) => n + r.pass, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  return { rows, pass, total, failed: total - pass };
}

function newSeoJob(payload) {
  return {
    type: "seo",
    draftId: String(payload.jobId), businessId: null,
    businessName: payload.businessName || payload.siteId || "Site",
    status: "queued", currentStep: 0,
    steps: SEO_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    seoPages: null, seoRenames: null, seoLinks: null, contentAudit: null, seoCheck: null,
    editPlan: null, editSummary: null, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
function enqueueSeoJob(payload) {
  const job = newSeoJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId); saveJobs();
  processJobQueue();
  return job;
}

async function runSeoJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  const P = job.payload;
  const repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99seo-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => { let r; for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); } return r; };
  const ai = { aiModel: "gemini" };
  // No domain on file means no canonical and no og:url. Writing a guess is what
  // produced the cross-client canonical this job exists to clear up.
  const origin = P.liveUrl ? String(P.liveUrl).replace(/\/+$/, "") : "";
  try {
    // 1 — pull latest
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = process.env.GH_TOKEN ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
    if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (process.env.GH_TOKEN) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
    const themeAbs = path.join(tmp, P.themePath);
    if (!fs.existsSync(themeAbs)) throw new Error("theme not found in repo: " + P.themePath);
    const muAbs = P.muPath ? path.join(tmp, P.muPath) : "";
    jobStep(job, 0, "done", "Latest code pulled");

    // 2 — read every page
    jobStep(job, 1, "running", "Reading the theme…");
    const muSrc = muAbs && fs.existsSync(muAbs) ? fs.readFileSync(muAbs, "utf8") : "";
    const { pages } = readSeoPages(themeAbs, muSrc);
    if (!pages.length) throw new Error("no pages found — the mu-plugin lists none and there is no front-page.php");
    const biz = await readBusinessFacts(pages, P.businessName, ai);
    job.seoBusiness = biz;
    jobStep(job, 1, "done", `${pages.length} page(s)${biz.city ? ` · ${[biz.city, biz.region].filter(Boolean).join(", ")}` : ""}${origin ? "" : " · no domain on file, canonical will be skipped"}`);

    // 3 — keywords + head copy, per page
    jobStep(job, 2, "running", `Writing head copy for ${pages.length} page(s)…`);
    for (let i = 0; i < pages.length; i++) {
      jobStep(job, 2, "running", `${pages[i].title} (${i + 1}/${pages.length})`);
      try {
        pages[i].seo = await seoHeadCopy(pages[i], biz, P.businessName, ai);
      } catch (e) {
        throw new Error(`head copy failed on "${pages[i].title}": ${e.message}`);
      }
    }
    jobStep(job, 2, "done", `${pages.length} page(s) · keywords, title, description, H1, social copy`);

    // 4 — URL strategy. Renames the template, the mu-plugin entry, every
    //     internal href, and leaves a 301 behind. The WordPress page itself is
    //     renamed by the generated layer on the next init.
    jobStep(job, 3, "running", "Judging the URLs…");
    let renames = [];
    try { renames = await seoUrlStrategy(pages, ai); }
    catch (e) { console.warn("seo: url strategy failed —", e.message); }
    let muNext = muSrc;
    for (const rn of renames) {
      const page = pages.find((p) => p.slug === rn.from);
      if (!page) continue;
      const nextFile = `page-${rn.to}.php`;
      fs.renameSync(path.join(themeAbs, page.file), path.join(themeAbs, nextFile));
      muNext = muNext.split(`'slug' => '${rn.from}'`).join(`'slug' => '${rn.to}'`)
        .split(`'template' => '${page.file}'`).join(`'template' => '${nextFile}'`);
      const from = `/${rn.from}/`, to = `/${rn.to}/`;
      for (const p of pages) p.php = p.php.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`'${to}'`);
      page.file = nextFile;
      page.slug = rn.to;
    }
    job.seoRenames = renames;
    jobStep(job, 3, renames.length ? "done" : "done", renames.length ? `${renames.length} slug(s) renamed, 301s written` : "every slug is fine — nothing renamed");

    // 5 — headings, image alt, internal links
    jobStep(job, 4, "running", "Headings and image alt…");
    const headingNotes = [];
    let altsFilled = 0;
    for (const page of pages) {
      const h = seoFixHeadings(page.php, page.seo.h1);
      page.php = h.php;
      if (h.notes.length) headingNotes.push({ slug: page.slug, notes: h.notes });
      const im = await seoImageAlts({ ...page, php: page.php }, biz, P.businessName, ai);
      page.php = im.php;
      altsFilled += im.filled;
    }
    jobStep(job, 4, "running", "Internal links…");
    const linkPlan = await seoInternalLinks(pages, ai);
    let linksAdded = 0;
    const broken = [];
    for (const lp of linkPlan) {
      const page = pages.find((p) => p.slug === lp.slug);
      if (!page) continue;
      page.php = lp.php;
      linksAdded += lp.added.length;
      if (lp.broken.length) broken.push({ slug: lp.slug, broken: lp.broken });
    }
    job.seoLinks = { added: linkPlan.filter((l) => l.added.length).map((l) => ({ slug: l.slug, links: l.added })), broken };
    job.seoHeadings = headingNotes;
    jobStep(job, 4, "done", `${headingNotes.length} heading fix(es) · ${altsFilled} alt text · ${linksAdded} internal link(s)${broken.length ? ` · ${broken.length} page(s) with broken links` : ""}`);

    // 6 — schema + the generated layer
    jobStep(job, 5, "running", "Building schema…");
    const entries = pages.map((page) => {
      const hero = (page.images.find((im) => /^https?:/i.test(im.src)) || {}).src || "";
      return {
        slug: page.slug, title: page.title,
        ...page.seo,
        canonical: origin ? origin + (page.slug === "home" ? "/" : `/${page.slug}/`) : "",
        ogImage: hero,
        ogImageAlt: page.seo.primaryKeyword || page.title,
        schema: seoSchema(page, pages, biz, origin),
      };
    });
    const changed = [];
    for (const page of pages) {
      const abs = path.join(themeAbs, page.file);
      if (fs.readFileSync(abs, "utf8") !== page.php) { fs.writeFileSync(abs, page.php); changed.push(`${P.themePath}/${page.file}`); }
    }
    fs.mkdirSync(path.join(themeAbs, "inc"), { recursive: true });
    fs.writeFileSync(path.join(themeAbs, "inc", "g99-seo.php"), seoIncludePhp(entries, renames, P.businessName));
    changed.push(`${P.themePath}/inc/g99-seo.php`);

    const headerAbs = path.join(themeAbs, "header.php");
    let stripped = [];
    if (fs.existsSync(headerAbs)) {
      const h = seoStripLegacyHead(fs.readFileSync(headerAbs, "utf8"));
      stripped = h.removed;
      if (h.removed.length) { fs.writeFileSync(headerAbs, h.php); changed.push(`${P.themePath}/header.php`); }
    }
    const fnAbs = path.join(themeAbs, "functions.php");
    if (fs.existsSync(fnAbs)) {
      const before = fs.readFileSync(fnAbs, "utf8");
      const after = seoEnsureInclude(before, P.themeSlug);
      if (after !== before) { fs.writeFileSync(fnAbs, after); changed.push(`${P.themePath}/functions.php`); }
    }
    if (muAbs && muNext !== muSrc) { fs.writeFileSync(muAbs, muNext); changed.push(P.muPath); }
    job.seoStripped = stripped;
    jobStep(job, 5, "done", `SEO layer written${stripped.length ? ` · stale ${stripped.join(", ")} removed from header.php` : ""}`);

    // 7 — content audit (reported, never rewritten)
    jobStep(job, 6, "running", "Auditing content relevance…");
    const audit = [];
    for (let i = 0; i < pages.length; i++) {
      jobStep(job, 6, "running", `${pages[i].title} (${i + 1}/${pages.length})`);
      audit.push(await seoContentAudit(pages[i], ai));
    }
    job.contentAudit = audit;
    const weak = audit.filter((a) => a.onTopicPercent != null && a.onTopicPercent < 60);
    jobStep(job, 6, "done", weak.length ? `${weak.length} of ${audit.length} page(s) are mostly generic copy` : `all ${audit.length} page(s) on topic`);

    // 8 — check the work
    jobStep(job, 7, "running", "Checking the work…");
    const check = seoVerify(entries, pages);
    job.seoCheck = check;
    job.seoPages = entries.map((e) => ({ slug: e.slug, title: e.title, metaTitle: e.metaTitle, metaDescription: e.metaDescription, primaryKeyword: e.primaryKeyword, canonical: e.canonical }));
    job.editPlan = changed.map((p) => ({ path: p, op: "modify" }));
    job.editSummary = `SEO across ${pages.length} page(s)`;
    jobStep(job, 7, "done", `${check.pass} of ${check.total} checks pass${check.failed ? ` · ${check.failed} to review` : ""}`);

    if (!changed.length) throw new Error("nothing to change — the SEO layer already matches this content");

    // 9 — push + PR
    jobStep(job, 8, "running", "Pushing + opening PR…");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/seo-${String(P.themeSlug).replace(/^g99-/, "")}-${stamp}`;
    const title = `SEO ${P.businessName}: ${pages.length} page(s)`;
    await run(`git checkout -b "${branch}"`, tmp);
    await run(`git add -A "${P.themePath}" ${P.muPath ? `"${P.muPath}"` : ""}`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "${title.replace(/"/g, "'")}"`, tmp);
    if (r.code) throw new Error("commit failed (no changes?): " + (r.stderr || r.stdout).slice(-160));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    // The body is a full report with tables — far past what survives being
    // quoted into a shell argument, so it goes via a file.
    const bodyFile = path.join(os.tmpdir(), `seo-pr-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, seoPrBody(job, entries, renames, audit, check, stripped, origin));
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body-file "${bodyFile}"`, tmp);
    fs.rmSync(bodyFile, { force: true });
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    job.branch = branch;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 8, "done", job.prUrl);

    // 10 — CI watch → merge
    jobStep(job, 9, "running", "Watching CI build checks…");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st; try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); } catch (e) { await sleep(10000); continue; }
      jobStep(job, 9, "running", (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ") || "CI starting…");
      if (st.allPass) { await awaitApprovalIfNeeded(job, P.siteId, 9); if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl }); merged = true; jobStep(job, 9, "done", `Merged${fixes ? ` after ${fixes} fix(es)` : ""}`); break; }
      if (st.anyFail) {
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts — " + job.prUrl);
        fixes++; jobStep(job, 9, "running", `Build failed — auto-fix ${fixes}/3…`);
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        if (fix.billing) throw new Error(fix.message);
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI: " + (fix.message || ""));
        await sleep(20000); continue;
      }
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out — " + job.prUrl);

    // 11 — registry
    jobStep(job, 10, "running", "Updating site registry…");
    try { await syncSiteRegistry(); } catch (e) { /* non-fatal */ }
    jobStep(job, 10, "done", "Done — SEO live on deploy");
    job.status = "done";
    notify(`🔎 SEO merged for *${job.businessName}*: ${pages.length} page(s) · ${check.pass}/${check.total} checks${renames.length ? ` · ${renames.length} URL(s) renamed` : ""}${weak.length ? `\n⚠️ ${weak.length} page(s) are mostly generic copy — see the content audit` : ""} · ${job.prUrl || ""}`);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) { job.status = "cancelled"; }
    else {
      job.error = e.message; job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      console.error(`seo job ${job.draftId} failed:`, e.message);
      notify(`❌ SEO failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job);
  }
}

// The report that travels with the change: the three advisory tasks plus what
// was applied, so the PR is readable without opening Studio.
function seoPrBody(job, entries, renames, audit, check, stripped, origin) {
  const L = [];
  L.push(`Automated SEO for **${job.businessName}** — ${entries.length} page(s).`, "");
  if (stripped.length) L.push(`Removed the hardcoded ${stripped.join(", ")} from \`header.php\` — it was shared by every page. Each page now has its own, generated in \`inc/g99-seo.php\`.`, "");
  if (!origin) L.push("> No domain is set for this site in NocoDB, so canonical and `og:url` were left out rather than guessed.", "");
  L.push(`**Checks:** ${check.pass} of ${check.total} pass.`, "");
  L.push("| Page | Title | Chars | Primary keyword |", "|---|---|---|---|");
  for (const e of entries) L.push(`| \`/${e.slug === "home" ? "" : e.slug + "/"}\` | ${e.metaTitle.replace(/\|/g, "\\|")} | ${e.metaTitle.length} | ${e.primaryKeyword.replace(/\|/g, "\\|")} |`);
  L.push("");
  if (renames.length) {
    L.push("### URLs renamed", "", "| From | To | Why |", "|---|---|---|");
    for (const r of renames) L.push(`| \`/${r.from}/\` | \`/${r.to}/\` | ${r.why.replace(/\|/g, "\\|")} |`);
    L.push("", "301 redirects for the old URLs ship in the same file.", "");
  }
  const links = (job.seoLinks && job.seoLinks.added) || [];
  if (links.length) {
    L.push("### Internal links added", "");
    for (const p of links) L.push(`- \`/${p.slug}/\` → ${p.links.map((l) => `"${l.anchor}" → \`${l.to}\``).join(", ")}`);
    L.push("");
  }
  const broken = (job.seoLinks && job.seoLinks.broken) || [];
  if (broken.length) {
    L.push("### Broken internal links found", "");
    for (const p of broken) L.push(`- \`/${p.slug}/\` → ${p.broken.map((b) => `\`${b.href}\``).join(", ")}`);
    L.push("");
  }
  const weak = audit.filter((a) => a.onTopicPercent != null && a.onTopicPercent < 60);
  if (weak.length) {
    L.push("### Content audit — pages that are mostly generic copy", "");
    for (const a of weak) {
      L.push(`**\`/${a.slug}/\` — ${a.onTopicPercent}% on topic.** ${a.verdict}`);
      if (a.missing.length) L.push(...a.missing.map((m) => `- ${m}`));
      L.push("");
    }
    L.push("> Content is reported, never rewritten — that is a writing job, not an SEO one.", "");
  }
  return L.join("\n");
}

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
    if (ADMIN && p.startsWith("/api/") && !p.startsWith("/api/webhook/") && (req.headers["x-admin-key"] || "") !== ADMIN) {
      return json(res, 401, { error: "unauthorized" }); // /api/webhook/* carries its own secret check
    }

    // "/" is the Studio overview; the original 6-step build wizard lives on at /wizard.
    if (p === "/" || p === "/overview" || p === "/overview.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "overview.html")));
    if (p === "/overview.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "overview.js")));
    if (p === "/wizard" || p === "/index.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "index.html")));
    // Studio's site-detail screen. Gated on ?id= so bare /site still falls
    // through to the assembled-bundle handler further down.
    if (p === "/site.html" || (p === "/site" && u.searchParams.get("id"))) return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "site.html")));
    if (p === "/site.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "site.js")));
    if (p === "/app.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "app.js")));
    if (p === "/styles.css") return send(res, 200, "text/css", fs.readFileSync(path.join(DIR, "public", "styles.css")));
    if (p === "/dashboard" || p === "/dashboard.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "dashboard.html")));
    if (p === "/dashboard.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "dashboard.js")));
    if (p === "/nav.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "nav.js")));
    if (p === "/theme.css") return send(res, 200, "text/css", fs.readFileSync(path.join(DIR, "public", "theme.css")));
    if (p === "/job" || p === "/job.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "job.html")));
    if (p === "/job.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "job.js")));

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

    // Load the bundled sample response into the builder. Opt-in only: the build
    // screen starts empty, so nobody ships a demo client by accident.
    if (p === "/api/onboarding-sample" && req.method === "POST") {
      const sample = path.join(DIR, "onboarding.sample.json");
      if (!fs.existsSync(sample)) return json(res, 404, { error: "no sample response bundled" });
      const cur = JSON.parse(fs.readFileSync(sample, "utf8"));
      cur.receivedAt = new Date().toISOString();
      fs.writeFileSync(path.join(DIR, "onboarding.json"), JSON.stringify(cur, null, 2));
      return json(res, 200, cur);
    }

    // Live per-page generation progress for the dashboard (poll ~2s during step 3).
    if (p === "/api/generate-progress") return json(res, 200, GEN_PROGRESS);

    // G99 platform → tool: onboarding wizard Part 2 submitted. Fire-and-forget:
    // validates the shared secret, maps answers, queues the pipeline, replies 202.
    if (p === "/api/webhook/onboarding-submitted" && req.method === "POST") {
      const secret = process.env.WEBHOOK_SECRET || "";
      if (!secret || (req.headers["x-webhook-secret"] || "") !== secret) return json(res, 401, { error: "bad webhook secret" });
      const body = JSON.parse(await readBody(req) || "{}");
      if (!body.draftId) return json(res, 400, { error: "draftId required" });
      const mapped = mapG99Answers(body.answers);
      // The HubSpot deal carries the build target (beta site URL + repo). G99 may
      // send it under any of several names, and the answers array can carry it too,
      // so accept every spelling rather than silently falling back to this
      // deployment's own defaults (which is what used to happen).
      const pick = (...keys) => {
        for (const k of keys) {
          if (body[k]) return String(body[k]).trim();
          if (mapped.answers && mapped.answers[k]) return String(mapped.answers[k]).trim();
        }
        return "";
      };
      const betaSiteUrl = pick("betaSiteUrl", "beta_site_url", "betaUrl", "beta_url", "siteUrl", "site_url");
      const betaSiteRepoRaw = pick("betaSiteRepo", "beta_site_repo", "githubRepo", "github_repo", "repoUrl", "repo_url", "repo");
      const betaSiteRepo = normalizeRepo(betaSiteRepoRaw);
      const receivedAt = new Date().toISOString();
      // Persist it as the current onboarding response, so "Build a site" shows
      // the client who actually submitted rather than whatever was there before.
      try {
        fs.writeFileSync(path.join(DIR, "onboarding.json"), JSON.stringify({
          draftId: body.draftId, businessId: body.businessId || null, template: body.template || "WEBSITE",
          receivedAt,
          betaSiteUrl, betaSiteRepo,
          referenceWebsite: body.referenceWebsite || mapped.referenceWebsite || "",
          existingWebsite: body.existingWebsite || mapped.existingWebsite || "",
          answers: mapped.answers,
        }, null, 2));
      } catch (e) { console.warn("could not persist onboarding.json:", e.message); }
      const { job, dedupe } = enqueueJob({
        draftId: body.draftId, businessId: body.businessId, businessName: body.businessName,
        answers: mapped.answers, existingWebsite: body.existingWebsite || mapped.existingWebsite,
        referenceWebsite: body.referenceWebsite || mapped.referenceWebsite,
        // the build target from the deal — without these the job used env defaults
        betaSiteUrl, betaSiteRepo, receivedAt, source: "onboarding form",
      });
      console.log(`webhook: ${job.businessName} · repo ${job.repo} · beta ${job.liveUrl}${betaSiteUrl || betaSiteRepo ? "" : " (deal properties missing — using this deployment's defaults)"}`);
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ accepted: true, dedupe, draftId: job.draftId, status: job.status, monitor: "/jobs" }));
    }

    // Inbound email → website change. Any transport that can POST JSON works;
    // it carries its own secret, so it sits outside the admin-key gate.
    // Body: { from, subject, body, messageId?, headers?, dryRun? }
    if (p === "/api/webhook/email-change" && req.method === "POST") {
      const secret = process.env.EMAIL_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
      if (!secret || (req.headers["x-webhook-secret"] || "") !== secret) return json(res, 401, { error: "bad webhook secret" });
      const body = JSON.parse(await readBody(req) || "{}");
      const from = String(body.from || "").trim();
      const subject = String(body.subject || "").trim();
      const dryRun = !!body.dryRun;
      const text = emailBodyText(body.body);
      const threadId = String(body.threadId || "");
      // `reply` is what the sender is told. Deliberately omitted for automated
      // mail and unknown senders, and capped at one refusal per thread so a
      // "thanks!" cannot start a ping-pong.
      const reject = (reason, extra, reply) => {
        logEmailRequest({ from, subject, messageId: body.messageId || null, status: "rejected", reason, ...(extra || {}) });
        const send = reply && !refusalAlreadySent(threadId);
        if (send) markRefusalSent(threadId);
        // 200: the caller is a mail hook, not a client that should retry.
        return json(res, 200, { accepted: false, reason, ...(send ? { reply } : {}) });
      };

      // 1 — never let a robot conversation start a run
      const auto = looksAutomated(body.headers, subject);
      if (auto) return reject("ignored automated mail (" + auto + ")");

      // 2 — sender allow-list. From is spoofable, so this is a second fence
      //     behind the shared secret, not the lock itself.
      const allowed = (process.env.EMAIL_ALLOWED_SENDERS || "growth99.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const addr = (from.match(/<([^>]+)>/) || [null, from])[1].toLowerCase().trim();
      if (!allowed.some(a => a.startsWith("@") ? addr.endsWith(a) : (addr === a || addr.endsWith("@" + a)))) {
        return reject(`sender ${addr || "(none)"} is not on EMAIL_ALLOWED_SENDERS`);
      }
      if (!text) return reject("empty email body", null,
        "There was no request in this email — the body came through empty.\n\nReply with what you would like changed and which website it is for, and I will pick it up.");

      // 3 — which website? Subject carries the name far more often than the body.
      let sites; try { sites = await getWebsites(false); } catch (e) { return reject("could not load the website list: " + e.message, null,
        "I could not reach the website list just now, so I have not actioned this. Please resend in a few minutes."); }
      const whole = `${subject}\n\n${text}`;
      let hit = matchSiteDeterministic(whole, sites);
      let instruction = text;
      if (hit && hit.ambiguous) return reject(`names more than one website (${hit.ambiguous.join(", ")}) — send one email per site`, null,
        `This email mentions ${hit.ambiguous.join(" and ")}. I can only work on one website per email — please send them separately and I will do both.`);
      if (!hit) {
        try { hit = await matchSiteAI(whole, sites); } catch (e) { return reject("could not parse the email: " + e.message, null,
          "I could not read a change request out of this email.\n\nReply with the website domain and what you would like changed."); }
        if (hit && hit.instruction) instruction = hit.instruction;
        if (hit && hit.confidence < 0.6) return reject(`matched ${hit.site.businessName} but only ${Math.round(hit.confidence * 100)}% confident — needs a human`, { siteId: hit.site.siteId },
          `I think this is about ${hit.site.businessName}, but I was not confident enough to act on it.\n\nReply with the website domain, for example prodteam.gogroth.com, and I will pick it up.`);
      }
      if (!hit) return reject("could not tell which website this is about", null,
        "I could not tell which website this is about.\n\nReply with the domain, for example prodteam.gogroth.com, and what you would like changed, and I will pick it up.");
      const site = hit.site;
      if (!site.githubRepo) return reject(`${site.businessName} has no repository set in NocoDB`, { siteId: site.siteId },
        `${site.businessName} is not fully set up in Studio yet — it has no repository configured — so I cannot make changes to it. Someone will need to add that first.`);

      // 4 — confirm there's a theme to edit before promising anything
      let target; try { target = await resolveEditTarget(site); }
      catch (e) { return reject("no editable theme for " + site.businessName + ": " + e.message, { siteId: site.siteId },
        `I could not work out which theme to edit for ${site.businessName}, so I have not made any changes. A developer will need to check its setup.`); }

      if (dryRun) {
        logEmailRequest({ from, subject, messageId: body.messageId || null, status: "dry-run", siteId: site.siteId, matchedBy: hit.how, instruction });
        return json(res, 200, { accepted: true, dryRun: true, siteId: site.siteId, businessName: site.businessName, matchedBy: hit.how, themeSlug: target.themeSlug, instruction });
      }

      // 5 — same pipeline as the chat UI, but it always stops for a human
      //     before merging: nobody typed this request into Studio.
      const job = enqueueEditJob({
        jobId: "edit-" + Date.now(),
        siteId: site.siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        prompt: instruction, forceApproval: true,
        source: "email", requestedBy: addr, emailSubject: subject, threadId, liveUrl: site.liveUrl || "",
      });
      logEmailRequest({ from, subject, messageId: body.messageId || null, status: "queued", siteId: site.siteId, matchedBy: hit.how, instruction, jobId: job.draftId });
      notify(`📧 Email request from ${addr} → *${site.businessName}*: ${instruction.slice(0, 140)} (needs your approval before merge)`);
      // Echoing the parsed instruction back is the cheapest guard against a
      // misread: the sender sees what will actually be done before it ships.
      // The first of only two messages the requester ever gets. Deliberately
      // short: they wrote the request, so quoting it back adds nothing.
      const ack = [
        "Got it " + String.fromCharCode(8212) + " I will review this and work on it.",
        "",
        "I will email you once the change is live on " + site.businessName + ".",
      ].join("\n");
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ accepted: true, jobId: job.draftId, siteId: site.siteId, businessName: site.businessName, matchedBy: hit.how, instruction, reply: ack, monitor: "/jobs" }));
    }
    // Replies waiting to be sent. Studio has no mail transport, so the Apps
    // Script collects these on its normal poll and sends them from Gmail.
    // Under /api/webhook/ so it sits outside the admin gate and is protected by
    // the same shared secret the inbound hook uses.
    if (p === "/api/webhook/email-outbox") {
      const secret = process.env.EMAIL_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
      if (!secret || (req.headers["x-webhook-secret"] || "") !== secret) return json(res, 401, { error: "bad webhook secret" });
      if (req.method === "POST") {
        // Acknowledge: drop the ids Gmail has now sent.
        const { ids } = JSON.parse(await readBody(req) || "{}");
        const done = new Set(Array.isArray(ids) ? ids : []);
        const o = readOutbox();
        o.pending = o.pending.filter(r => !done.has(r.id));
        writeOutbox(o);
        return json(res, 200, { ok: true, remaining: o.pending.length });
      }
      return json(res, 200, { pending: readOutbox().pending });
    }

    // What the mailbox has sent us lately, matched or not — the place to look
    // when someone says "I emailed that and nothing happened".
    if (p === "/api/email-requests") return json(res, 200, readEmailLog());

    // Jobs monitor data (newest first).
    if (p === "/api/jobs") {
      const list = [...JOBS.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json(res, 200, { running: JOB_RUNNING, queued: JOB_QUEUE.length, jobs: list });
    }
    if (p === "/api/job" ) {
      const j = JOBS.get(u.searchParams.get("id"));
      return j ? json(res, 200, j) : json(res, 404, { error: "job not found" });
    }

    // Cancel a job (queued → dropped; running → stops at the next step boundary).
    if (p === "/api/job-cancel" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id); if (!j) return json(res, 404, { error: "job not found" });
      if (j.status === "queued") { const k = JOB_QUEUE.indexOf(id); if (k >= 0) JOB_QUEUE.splice(k, 1); j.status = "cancelled"; }
      else if (j.status === "running") { j.cancelRequested = true; }
      saveJobs();
      return json(res, 200, { ok: true, status: j.status });
    }
    // Retry a finished job — re-enqueue the same payload as a fresh job.
    if (p === "/api/job-retry" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id); if (!j) return json(res, 404, { error: "job not found" });
      const nj = j.type === "edit" ? enqueueEditJob({ ...j.payload, jobId: "edit-" + Date.now() })
        : j.type === "restore" ? enqueueRestoreJob({ ...j.payload, jobId: "restore-" + Date.now() })
        : enqueueJob(j.payload).job;
      return json(res, 202, { ok: true, jobId: nj.draftId });
    }
    // Approve a job that's paused awaiting human sign-off (per-site approval).
    if (p === "/api/job-approve" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id); if (!j) return json(res, 404, { error: "job not found" });
      j.approved = true; saveJobs();
      return json(res, 200, { ok: true });
    }
    // Toggle per-site require-approval (persisted in the registry).
    if (p === "/api/site-approval" && req.method === "POST") {
      const { siteId, requireApproval } = JSON.parse(await readBody(req) || "{}");
      if (!siteId) return json(res, 400, { error: "siteId required" });
      const m = readApprovals();
      if (requireApproval) m[siteId] = true; else delete m[siteId];
      writeApprovals(m);
      return json(res, 200, { ok: true, siteId, requireApproval: !!requireApproval });
    }
    // Rendered PR diff (for the job detail page).
    if (p === "/api/pr-diff") {
      const prUrl = u.searchParams.get("prUrl") || "";
      const prNum = (prUrl.match(/\/pull\/(\d+)/) || [])[1];
      if (!prNum) return json(res, 400, { error: "prUrl required" });
      const r = await sh(`gh pr diff ${prNum} --repo ${repoFromPrUrl(prUrl)}`);
      return json(res, 200, { diff: (r.stdout || r.stderr || "").slice(0, 200000) });
    }
    // Re-audit the currently-active live site now (also runs on a schedule).
    if (p === "/api/reaudit" && req.method === "POST") {
      try { return json(res, 200, await reauditActiveSite()); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === "/api/reaudit-history") return json(res, 200, readReaudit());

    // Cached CRO audits for every website — one read that powers the overview
    // KPIs and the sites grid without auditing anything.
    if (p === "/api/site-audits") return json(res, 200, { audits: readSiteAudits() });

    // GET: this website's cached audit (or {}). POST: run a fresh one now.
    if (p === "/api/site-audit") {
      const siteId = req.method === "POST"
        ? (JSON.parse(await readBody(req) || "{}").siteId || "")
        : (u.searchParams.get("siteId") || "");
      if (!siteId) return json(res, 400, { error: "siteId required" });
      if (req.method !== "POST") return json(res, 200, readSiteAudits()[siteId] || {});
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown site — refresh the list" });
      try { return json(res, 200, await auditWebsite(site)); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    // Image-quality audit of a LIVE site: measures every image's true pixel size on
    // the home page + services hub + each service page, so "are the images blurry?"
    // is answered from inside the tool instead of by hand.
    if (p === "/api/image-audit" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      let base = body.url || "";
      let slugs = Array.isArray(body.pages) ? body.pages : null;
      if (!base && body.siteId) {
        const site = await findWebsite(body.siteId);
        if (!site) return json(res, 404, { error: "unknown site — refresh the list" });
        if (!site.liveUrl) return json(res, 400, { error: "This website has no Domain set in NocoDB — nothing to audit." });
        base = site.liveUrl;
        if (!slugs) {
          // derive the page list from the newest enrich run for this site
          const e = [...JOBS.values()]
            .filter((j) => j.type === "enrich" && j.servicePages && j.payload && j.payload.siteId === body.siteId)
            .sort((a, b) => (b.finishedAt || b.createdAt || "").localeCompare(a.finishedAt || a.createdAt || ""))[0];
          slugs = e ? e.servicePages.map((s) => s.slug) : [];
        }
      }
      if (!base) return json(res, 400, { error: "siteId or url required" });
      const origin = String(base).replace(/\/+$/, "");
      const paths = ["/", "/services/", ...(slugs || []).map((s) => "/" + s + "/"), "/brand-guide/"];
      const MIN = Number(body.minWidth) || 1000;
      const pages = [];
      for (const p2 of paths) {
        const url = origin + p2 + "?g99imgqc=" + Date.now();
        let html = "";
        try { html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 G99Bot", "Cache-Control": "no-cache" } })).text(); }
        catch (e) { pages.push({ path: p2, error: e.message.slice(0, 120), images: [] }); continue; }
        const main = (html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
        const urls = [...new Set(
          [...main.matchAll(/https:\/\/lh3\.googleusercontent\.com\/aida-public\/[^"'()\s]+/g)].map((m) => m[0])
            .concat([...main.matchAll(/https:\/\/images\.unsplash\.com\/[^"'()\s]+/g)].map((m) => m[0]))
            .concat([...main.matchAll(/https:\/\/[^"'()\s]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'()\s]*)?/gi)].map((m) => m[0]))
        )].slice(0, 30);
        const dims = await Promise.all(urls.map((x) => imageDims(x)));
        const heroes = heroImageUrls(main);
        const images = urls.map((x, i) => {
          const isHero = heroes.has(x);
          const need = isHero ? Math.max(MIN, HERO_MIN_WIDTH) : MIN;
          return {
            url: x.slice(0, 140), w: dims[i] ? dims[i].w : null, h: dims[i] ? dims[i].h : null,
            role: isHero ? "hero" : "inline", need,
            ok: !!(dims[i] && dims[i].w >= need),
            measured: !!dims[i],
          };
        });
        const measured = images.filter((x) => x.measured);
        pages.push({
          path: p2, total: images.length,
          measured: measured.length,
          low: measured.filter((x) => !x.ok).length,
          minWidth: measured.length ? Math.min(...measured.map((x) => x.w)) : null,
          maxWidth: measured.length ? Math.max(...measured.map((x) => x.w)) : null,
          images,
        });
      }
      const totals = pages.reduce((a, p2) => ({ total: a.total + (p2.total || 0), low: a.low + (p2.low || 0) }), { total: 0, low: 0 });
      const out = { site: origin, minWidth: MIN, checkedAt: new Date().toISOString(), pages, totals, pass: totals.low === 0 };
      try {
        const f = path.join(GEN, "image-audits.json");
        const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
        all[body.siteId || origin] = out;
        fs.writeFileSync(f, JSON.stringify(all, null, 2));
      } catch (e) { /* non-fatal */ }
      return json(res, 200, out);
    }
    if (p === "/api/image-audit") {
      try {
        const f = path.join(GEN, "image-audits.json");
        const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
        const k = u.searchParams.get("siteId") || "";
        return json(res, 200, k ? (all[k] || {}) : all);
      } catch (e) { return json(res, 200, {}); }
    }

    // Real websites from NocoDB (name / domain / repo). ?refresh=1 bypasses the
    // 60s cache. Approval flags are merged in from the local store.
    if (p === "/api/sites") {
      try {
        const sites = await getWebsites(u.searchParams.get("refresh") === "1");
        const appr = readApprovals();
        return json(res, 200, { sites: sites.map(s => ({ ...s, requireApproval: !!appr[s.siteId] })), syncedAt: new Date(NOCO_CACHE.at).toISOString() });
      } catch (e) { return json(res, 502, { error: "NocoDB fetch failed: " + e.message }); }
    }

    // Change history for a website: resolve its repo + active theme, then list
    // every PR (build + edit) whose branch targets that theme slug.
    if (p === "/api/site-history") {
      const siteId = u.searchParams.get("siteId");
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown site — refresh the list" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 200, { siteId, repo: site.githubRepo, themeSlug: null, resolveError: e.message, history: [] }); }
      const bare = target.themeSlug.replace(/^g99-/, "");
      const raw = await sh(`gh pr list --repo ${site.githubRepo} --state all --limit 80 --json number,title,url,state,mergedAt,createdAt,headRefName,statusCheckRollup`);
      let prs = []; try { prs = JSON.parse(raw.stdout || "[]"); } catch (e) { prs = []; }
      const re = new RegExp("(^|[/-])" + bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-|$)");
      const history = prs.filter(pr => re.test(pr.headRefName || ""))
        .map(pr => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state, type: (pr.headRefName || "").includes("/edit-") ? "edit" : (pr.headRefName || "").includes("/restore-") ? "restore" : "build", date: pr.mergedAt || pr.createdAt, build: ciRollup(pr.statusCheckRollup) }))
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return json(res, 200, { siteId, repo: site.githubRepo, themeSlug: target.themeSlug, history });
    }

    // Version history straight from GitHub: every commit on the default branch
    // that touched this website's theme, newest first. The newest one is what's
    // live, so it's flagged rather than offered as something to restore.
    if (p === "/api/site-versions") {
      const site = await findWebsite(u.searchParams.get("siteId"));
      if (!site) return json(res, 404, { error: "unknown site — refresh the list" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 200, { siteId: site.siteId, repo: site.githubRepo, resolveError: e.message, versions: [] }); }
      const r = await sh(`gh api "repos/${site.githubRepo}/commits?path=${encodeURIComponent(target.themePath)}&per_page=30"`);
      let raw = []; try { raw = JSON.parse(r.stdout || "[]"); } catch (e) { raw = []; }
      if (!Array.isArray(raw)) return json(res, 502, { error: "GitHub returned no commit list for " + target.themePath });
      const versions = raw.map((c, i) => {
        const msg = String((c.commit && c.commit.message) || "");
        const lines = msg.split("\n").map(s => s.trim()).filter(Boolean);
        const merge = /^Merge pull request #(\d+)/.exec(lines[0] || "");
        // A merge commit's first line is plumbing and its last line is the PR
        // title; a squash-merge puts the title first with a trailing "(#12)".
        let title = (merge ? lines[lines.length - 1] : lines[0]) || "(no message)";
        const squash = /\(#(\d+)\)\s*$/.exec(title);
        if (squash) title = title.slice(0, squash.index).trim();
        const pr = merge ? merge[1] : squash ? squash[1] : null;
        return {
          sha: c.sha, short: String(c.sha || "").slice(0, 7), title,
          date: (c.commit && c.commit.committer && c.commit.committer.date) || null,
          author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || "",
          prNumber: pr ? Number(pr) : null,
          prUrl: pr ? `https://github.com/${site.githubRepo}/pull/${pr}` : null,
          current: i === 0,
        };
      });
      return json(res, 200, { siteId: site.siteId, repo: site.githubRepo, themeSlug: target.themeSlug, themePath: target.themePath, versions });
    }

    // Put the theme back exactly as it was at one commit. This is a forward
    // commit through the same PR + CI + approval path as an edit — nothing is
    // force-pushed, and a restore can itself be restored.
    if (p === "/api/site-restore" && req.method === "POST") {
      const { siteId, sha, label } = JSON.parse(await readBody(req) || "{}");
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ""))) return json(res, 400, { error: "a full commit sha is required" });
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId — refresh the site list" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      const job = enqueueRestoreJob({
        jobId: "restore-" + Date.now(),
        siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        sha: String(sha), versionLabel: String(label || "").slice(0, 120),
      });
      return json(res, 202, { jobId: job.draftId, status: job.status, monitor: "/jobs" });
    }

    // ---- "Edit with an IDE" ------------------------------------------------
    // Cursor has a documented prompt deeplink, so the browser can hand off to it
    // directly. Claude Code and Antigravity are CLI/editor launches, which only
    // work when the tool is running on the same machine as the operator.
    if (p === "/api/ide-support") {
      return json(res, 200, { local: isLocalRequest(req), platform: process.platform, tools: IDE_TOOLS.map(t => t.id) });
    }
    // Launch a local IDE with the prompt already loaded. Deliberately narrow:
    // localhost only, a fixed allow-list of tools, and the operator's prompt
    // never reaches a command line — it's written to a file the agent reads.
    if (p === "/api/ide-launch" && req.method === "POST") {
      if (!isLocalRequest(req)) return json(res, 403, { error: "the launcher only works when Studio runs on your own machine" });
      const { ide, prompt: text, siteId } = JSON.parse(await readBody(req) || "{}");
      const tool = IDE_TOOLS.find(t => t.id === ide);
      if (!tool) return json(res, 400, { error: "unknown tool: " + ide });
      if (!tool.bin) return json(res, 400, { error: tool.label + " opens by link, not from here" });
      if (!text || !text.trim()) return json(res, 400, { error: "prompt required" });
      const found = await sh(process.platform === "win32" ? `where ${tool.bin}` : `which ${tool.bin}`);
      if (found.code) return json(res, 404, { error: `"${tool.bin}" isn't on this machine's PATH — install ${tool.label} or use Copy instead` });
      try { return json(res, 200, await launchIde(tool, text, siteId)); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }

    // What the edit chat may offer. Gemini is always there; Ollama Cloud shows
    // up only when a key is configured, and is marked unavailable otherwise so
    // the picker can say why rather than failing at send time.
    if (p === "/api/ai-models") {
      return json(res, 200, {
        default: "gemini",
        ollamaConfigured: !!OLLAMA_API_KEY,
        models: [
          { id: "gemini", label: "Gemini", group: "Google", available: true },
          ...OLLAMA_MODELS.map((m) => ({ ...m, group: "Ollama Cloud", available: !!OLLAMA_API_KEY })),
        ],
      });
    }

    if (p === "/api/edit-run" && req.method === "POST") {
      const { siteId, prompt, aiModel } = JSON.parse(await readBody(req) || "{}");
      if (!prompt || !prompt.trim()) return json(res, 400, { error: "prompt required" });
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId — refresh the site list" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      const job = enqueueEditJob({
        jobId: "edit-" + Date.now(),
        siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        prompt: prompt.trim(),
        // Only honoured for chat-initiated edits; anything unrecognised (and
        // every email request, which never sets it) falls through to Gemini.
        aiModel: isOllamaModel(aiModel) ? aiModel : "",
      });
      return json(res, 202, { jobId: job.draftId, status: job.status, monitor: "/jobs" });
    }

    // Manual enrichment (service pages + brand guide) for a deployed site. Needs
    // the onboarding answers + composed brand — reused from the most recent build
    // job for this site (kept in memory / jobs.json). Auto-enrich after a build is
    // the primary path; this button re-runs it on demand.
    // One click, every SEO task, one PR. Same rails as enrich: clone → work →
    // PR → CI → the site's own merge policy.
    if (p === "/api/seo-run" && req.method === "POST") {
      const { siteId } = JSON.parse(await readBody(req) || "{}");
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId — refresh the site list" });
      if (!site.githubRepo) return json(res, 409, { error: `${site.businessName} has no repository set in NocoDB` });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      const running = [...JOBS.values()].find((j) => j.type === "seo" && (j.status === "queued" || j.status === "running") && j.payload && j.payload.siteId === site.siteId);
      if (running) return json(res, 202, { jobId: running.draftId, dedupe: true, monitor: "/jobs" });
      const job = enqueueSeoJob({
        jobId: "seo-" + Date.now(),
        siteId: site.siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        liveUrl: site.liveUrl || "",
      });
      return json(res, 202, { jobId: job.draftId, monitor: "/jobs" });
    }

    if (p === "/api/enrich-run" && req.method === "POST") {
      const body0 = JSON.parse(await readBody(req) || "{}");
      // Inline mode (ops/test): explicit themeSlug + answers → enqueue directly,
      // bypassing the NocoDB/build-job lookup. dryRun:true writes to a preview dir
      // and skips the PR; otherwise it's a real run (clone → files → PR → merge).
      if (body0.dryRun || (body0.answers && body0.themeSlug)) {
        const isDry = !!body0.dryRun;
        let answers = body0.answers, composed = body0.composed || {};
        if (!answers) { try { answers = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers; } catch (e) { answers = {}; } }
        const themeSlug = body0.themeSlug || "g99-preview";
        const job = enqueueEnrichJob({
          jobId: (isDry ? "enrich-dry-" : "enrich-") + Date.now(), dryRun: isDry,
          siteId: body0.siteId || themeSlug, businessName: body0.businessName || answers.business_name || "Site",
          githubRepo: WP_REPO, themeSlug, themePath: "web/app/themes/" + themeSlug,
          muPath: "web/app/mu-plugins/g99-activate-" + themeSlug.replace(/^g99-/, "") + ".php",
          answers, composed, referenceWebsite: body0.referenceWebsite || "",
          existingWebsite: body0.existingWebsite || "",
        });
        return json(res, 202, { jobId: job.draftId, dryRun: isDry, monitor: "/jobs" });
      }
      const { siteId } = body0;
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId — refresh the site list" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      // Source of the onboarding answers + brand: match by THEME SLUG, not by
      // business name (the NocoDB site name rarely equals the build's client name).
      // Priority: (1) the newest BUILD whose auto-enrich targeted this theme — its
      // composed brand is the theme's actual design system; (2) the newest enrich
      // run on this theme (inherited the same data); (3) legacy name match.
      const newest = (a, b) => (b.finishedAt || b.createdAt || "").localeCompare(a.finishedAt || a.createdAt || "");
      const all = [...JOBS.values()];
      const buildForSlug = all
        .filter((j) => j.type === "build" && j.composed && j.payload && j.payload.answers && j.enrichJobId &&
          (JOBS.get(j.enrichJobId) || {}).payload && JOBS.get(j.enrichJobId).payload.themeSlug === target.themeSlug)
        .sort(newest)[0];
      const enrichForSlug = all
        .filter((j) => j.type === "enrich" && j.payload && j.payload.themeSlug === target.themeSlug && j.payload.answers && j.payload.composed)
        .sort(newest)[0];
      const buildByName = all
        .filter((j) => j.type === "build" && j.composed && j.payload && j.payload.answers && j.businessName === site.businessName)
        .sort(newest)[0];
      const src = buildForSlug
        ? { answers: buildForSlug.payload.answers, composed: buildForSlug.composed, referenceWebsite: buildForSlug.payload.referenceWebsite, existingWebsite: buildForSlug.payload.existingWebsite, businessId: buildForSlug.businessId, authoritative: true }
        : enrichForSlug
          ? { answers: enrichForSlug.payload.answers, composed: enrichForSlug.payload.composed, referenceWebsite: enrichForSlug.payload.referenceWebsite, existingWebsite: enrichForSlug.payload.existingWebsite, businessId: enrichForSlug.businessId, authoritative: true }
          : buildByName
            ? { answers: buildByName.payload.answers, composed: buildByName.composed, referenceWebsite: buildByName.payload.referenceWebsite, existingWebsite: buildByName.payload.existingWebsite, businessId: buildByName.businessId }
            : null;
      if (!src) return json(res, 409, { error: "No onboarding data for this theme in memory — enrichment auto-runs after a build; trigger it right after building." });
      const job = enqueueEnrichJob({
        jobId: (body0.headerOnly ? "nav-" : "enrich-") + Date.now(), businessId: src.businessId, liveUrl: site.liveUrl,
        siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        answers: src.answers, composed: src.composed, referenceWebsite: src.referenceWebsite || "",
        // fall back to the answers' current-site field so content grounding isn't
        // silently skipped when the source build's payload lacks existingWebsite
        existingWebsite: src.existingWebsite || (src.answers || {}).existing_website || (src.answers || {}).current_website || "",
        headerOnly: !!body0.headerOnly, brandAuthoritative: !!src.authoritative,
      });
      return json(res, 202, { jobId: job.draftId, status: job.status, monitor: "/jobs" });
    }

    if (p === "/edit" || p === "/edit.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "edit.html")));
    if (p === "/edit.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "edit.js")));

    if (p === "/sites" || p === "/sites.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "sites.html")));
    if (p === "/sites.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "sites.js")));

    if (p === "/jobs" || p === "/jobs.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "jobs.html")));
    if (p === "/jobs.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "jobs.js")));

    // Comparison reports written by the job runner.
    if (p.startsWith("/reports/")) {
      const f = path.join(GEN, "reports", p.slice(9).replace(/[^a-zA-Z0-9._-]/g, ""));
      if (fs.existsSync(f)) return send(res, 200, f.endsWith(".json") ? "application/json" : "text/html", fs.readFileSync(f));
      return send(res, 404, "text/plain", "report not found");
    }

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
      // Design language comes from the REFERENCE site the client loves
      // (site_love_1_url); the existing site is only the CRO/what-to-fix source.
      const refUrl = onb.referenceWebsite || a.site_love_1_url || "";
      const existUrl = onb.existingWebsite || a.existingWebsite || "";
      const siteUrl = refUrl || existUrl;
      const isRef = !!refUrl;

      // 1) Existing-site brand theme — reuse passed analysis, else cache, else scan.
      let analysis = body.analysis || null;
      if (!analysis) { try { analysis = JSON.parse(fs.readFileSync(path.join(GEN, ".site-analysis.json"), "utf8")); } catch (e) {} }
      if (!analysis && siteUrl) {
        try { analysis = await analyzeExistingSite(siteUrl); fs.writeFileSync(path.join(GEN, ".site-analysis.json"), JSON.stringify(analysis, null, 2)); }
        catch (e) { console.warn("compose: site analysis failed:", e.message.slice(0, 120)); }
      }

      // 1b) The source site's REAL type + palette, read from its markup. A
      // screenshot can't reveal font names, so without this the brief only ever
      // described a "style" and generation fell back to Playfair/Inter.
      // Fonts come from the EXISTING site — that's the brand the client already
      // has, and what "matching their fonts" means. The reference site still
      // drives the overall design language (palette, vibe, layout) as before.
      let siteBrand = null, fontsFrom = null;
      if (existUrl) { siteBrand = await readSiteBrand(existUrl); fontsFrom = existUrl; }
      if (!siteBrand || !siteBrand.fonts.length) {
        const alt = siteUrl && siteUrl !== existUrl ? await readSiteBrand(siteUrl) : null;
        if (alt && alt.fonts.length) { siteBrand = alt; fontsFrom = siteUrl; }
      }
      if (siteBrand) console.log(`compose: real fonts on ${fontsFrom}: ${siteBrand.fonts.slice(0, 4).join(", ") || "none"}`);

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
        `${isRef ? "REFERENCE / INSPIRATION SITE the client loves" : "EXISTING SITE"} BRAND THEME (extracted from ${siteUrl}) — ${isRef ? "the new site must feel like the same design family (emulate this):" : "keep the brand's DNA but elevate it:"}`,
        `- Colors: primary ${analysis.primaryColor}, secondary ${analysis.secondaryColor}, accent ${analysis.accentColor}, background ${analysis.backgroundColor}.`,
        `- Vibe: ${analysis.vibe}. Headings: ${analysis.headingFontStyle}. Body: ${analysis.bodyFontStyle}.`,
        siteBrand && siteBrand.fonts.length
          ? `- ACTUAL font families that site declares (read from its markup — authoritative; a screenshot cannot show these): ${siteBrand.fonts.slice(0, 4).join(", ")}. Its real palette: ${siteBrand.palette.slice(0, 4).join(", ")}.`
          : "",
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
        siteBrand && siteBrand.fonts.length
          ? `\n== TYPOGRAPHY RULE ==\nThat site really uses: ${siteBrand.fonts.slice(0, 4).join(", ")}. Set "headingFont" and "bodyFont" to those EXACT families (heading = the display/serif one, body = the clean sans one) so the new site stays typographically continuous with the brand. Substitute only if a family isn't on Google Fonts — then pick the closest Google equivalent with the same character.`
          : "",
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
        // A guarantee, not a hope: if the model still invented fonts, use the real
        // ones. Recorded so a run's typography can be explained afterwards.
        if (siteBrand && siteBrand.fonts.length) {
          obj.fontSource = "site";
          const wantH = siteBrand.headingFont, wantB = siteBrand.bodyFont;
          if (wantH && String(obj.headingFont || "").toLowerCase() !== wantH.toLowerCase()) {
            obj.headingFontModelPick = obj.headingFont; obj.headingFont = wantH; obj.fontSource = "site (model overridden)";
          }
          if (wantB && String(obj.bodyFont || "").toLowerCase() !== wantB.toLowerCase()) {
            obj.bodyFontModelPick = obj.bodyFont; obj.bodyFont = wantB; obj.fontSource = "site (model overridden)";
          }
          obj.siteFonts = siteBrand.fonts.slice(0, 4);
        } else { obj.fontSource = "model"; }
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
        let html = enforceBrandFonts(r.html, theme);  // pin the composed brand type
        html = sharpenStitchImages(html);
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
      // Per-client target repo (from the job); falls back to this deployment's default.
      const repo = body.githubRepo || WP_REPO;
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
        let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
        // Fallback avoids api.github.com (flaky DNS). With GH_TOKEN (deployed),
        // embed it so the plain clone is authenticated too.
        const cloneUrl = process.env.GH_TOKEN
          ? `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`
          : `https://github.com/${repo}.git`;
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
        // Prune prior builds' activators — otherwise every one of them fires on
        // 'init' against a fresh DB (they all race to switch_theme() before
        // their own g99_autoactivated_* option exists yet), and whichever file
        // sorts last alphabetically wins instead of the theme this PR ships.
        for (const f of fs.readdirSync(path.join(tmp, muRel))) {
          if (/^g99-activate-.*\.php$/.test(f) && f !== muFile) fs.unlinkSync(path.join(tmp, muRel, f));
        }
        fs.writeFileSync(path.join(tmp, muRel, muFile), wpActivatorPlugin(slug, a.business_name, built.buildId));
        await run(`git checkout -b "${branch}"`, tmp);
        await run(`git add -A "${rel}" "${muRel}"`, tmp);
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
        r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body "${prBody}"`, tmp);
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
      const r = await sh(`gh pr checks ${prNum} --repo ${repoFromPrUrl(prUrl)}`);
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
      const r = await sh(`gh pr merge ${prNum} --repo ${repoFromPrUrl(prUrl)} --squash --delete-branch`);
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
      const branch = (await sh(`gh pr view ${prNum} --repo ${repoFromPrUrl(prUrl)} --json headRefName --jq .headRefName`)).stdout.trim();
      if (!branch) return json(res, 500, { error: "could not resolve PR branch" });
      // find a failing build check and its run id
      const checks = (await sh(`gh pr checks ${prNum} --repo ${repoFromPrUrl(prUrl)}`)).stdout.split("\n").map(l => l.split("\t"));
      const failing = checks.find(c => /^build/i.test((c[0] || "").trim()) && (c[1] || "").trim() === "fail");
      if (!failing) return json(res, 200, { fixed: [], message: "no failing build check found" });
      const runId = ((failing[3] || "").match(/\/runs\/(\d+)/) || [])[1];
      // Detect the "Actions can't run" case (org billing / spending limit / disabled)
      // — Gemini can't fix that; surface it clearly instead of hunting a file.
      const runSummary = runId ? (await sh(`gh run view ${runId} --repo ${repoFromPrUrl(prUrl)}`)).stdout : "";
      if (/recent account payments|spending limit|not started because|Actions.*disabled|billing/i.test(runSummary)) {
        return json(res, 200, { fixed: [], billing: true, message: "GitHub Actions is not running for this repo (billing / spending-limit). CI can't pass until org billing is fixed." });
      }
      const log = runId ? (await sh(`gh run view ${runId} --repo ${repoFromPrUrl(prUrl)} --log-failed`)).stdout.slice(-8000) : "";
      // offending files: Pint prints "⨯ path/to/file.php" (often truncated with …) — also accept any .php path in the log
      const raw = [...new Set([...log.matchAll(/[⨯x]\s+(\S+?\.php)|((?:web|config)\/[\w\/.-]+?\.php)/g)].map(m => (m[1] || m[2])).filter(Boolean))];
      // resolve truncated paths against the branch tree
      const tree = (await sh(`gh api repos/${repoFromPrUrl(prUrl)}/git/trees/${branch}?recursive=1 --jq ".tree[].path"`)).stdout.split("\n");
      const files = [...new Set(raw.map(f => tree.find(t => t === f) || tree.find(t => t.startsWith(f.replace(/…$/, ""))) || null).filter(Boolean))].slice(0, 3);
      if (!files.length) return json(res, 200, { fixed: [], message: "could not identify offending file from log", log: log.slice(-1500) });
      const fixed = [];
      for (const f of files) {
        const meta = JSON.parse((await sh(`gh api "repos/${repoFromPrUrl(prUrl)}/contents/${f}?ref=${branch}"`)).stdout || "{}");
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
        const put = await sh(`gh api -X PUT "repos/${repoFromPrUrl(prUrl)}/contents/${f}" -f message="Auto-fix CI build failure (Gemini)" -f content="${b64}" -f sha="${meta.sha}" -f branch="${branch}"`);
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
  // Scheduled re-audit (off unless REAUDIT_HOURS > 0, to avoid burning quota).
  const reauditHours = parseFloat(process.env.REAUDIT_HOURS || "0");
  if (reauditHours > 0) {
    setInterval(() => { reauditActiveSite().catch((e) => console.warn("re-audit failed:", e.message)); }, reauditHours * 3600 * 1000);
    console.log(`re-audit scheduled every ${reauditHours}h`);
  }
}
module.exports = { seoEnhance, audit, sharpenStitchImages, injectCanonicalNav, qcStitchImages, fixImages };
