// Growth99 Website-Build Tool — prototype server (pure Node, no deps).
// Screens: onboarding Q&A -> prompt/theme editor -> Stitch generate -> preview/export -> SEO audit.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");   // GitHub App JWT signing
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

// ---- GitHub auth ---------------------------------------------------------------
// Preferred: the g99-gitops GitHub App. An App is installed on the org rather than owned by a
// person, so beta-site repos keep working when someone leaves, and its installation tokens
// last 60 minutes instead of forever. The classic PAT stays as the fallback.
//
// The catch that decides which one is used: an App only gets the permissions its settings
// grant. This pipeline needs contents (push), pull_requests (open/merge) and checks +
// statuses (the CI watch). Until those are granted AND the org accepts the permission update,
// using the App would break PR creation — so capability is verified once at startup and the
// PAT is kept for anything the App cannot do.
const GH_APP_ID = process.env.GH_APP_ID || "";
const GH_APP_INSTALLATION_ID = process.env.GH_APP_INSTALLATION_ID || "";
// The PEM, from whichever source this environment offers. A real FILE is preferred: env vars
// cannot hold newlines, so the key has to be \n-escaped, and a multi-line paste silently
// truncates to "-----BEGIN RSA PRIVATE KEY-----" and fails at signing time. Render's Secret
// Files (app root and /etc/secrets/<name>) avoid that trap entirely.
const GH_APP_PRIVATE_KEY = (function readAppKey() {
  // Render drops a Secret File both at the app root and at /etc/secrets/<filename>, and the
  // natural thing to call it is after the variable it replaces — so GH_APP_PRIVATE_KEY (no
  // extension) is checked alongside the .pem names.
  const names = ["g99-gitops.pem", "GH_APP_PRIVATE_KEY", "GH_APP_PRIVATE_KEY.pem"];
  const candidates = [process.env.GH_APP_PRIVATE_KEY_FILE]
    .concat(names.map((n) => path.join(DIR, n)))
    .concat(names.map((n) => "/etc/secrets/" + n))
    .filter(Boolean);
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const pem = fs.readFileSync(f, "utf8").trim();
        // Only accept something that really is a key: an empty or half-saved Secret File
        // must fall through to the env var rather than break signing.
        if (pem.includes("PRIVATE KEY")) {
          console.log("GitHub App key loaded from file:", f);
          return pem;
        }
      }
    } catch (e) { /* unreadable — fall through */ }
  }
  // Env-var fallback. Must be one line with \n escapes; a multi-line paste truncates.
  return (process.env.GH_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
})();
const GH_APP_CONFIGURED = !!(GH_APP_ID && GH_APP_INSTALLATION_ID && GH_APP_PRIVATE_KEY);

function ghAppJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  // iat is backdated a minute to absorb clock skew; GitHub rejects a JWT from the future.
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ iat: now - 60, exp: now + 540, iss: GH_APP_ID });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(head + "." + body), GH_APP_PRIVATE_KEY);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

// Installation tokens expire after an hour and a build can outlive that, so the token is
// re-minted whenever less than 10 minutes remain rather than once per job.
let GH_APP_TOKEN = { value: "", expiresAt: 0 };
async function ghAppToken() {
  if (!GH_APP_CONFIGURED) return "";
  if (GH_APP_TOKEN.value && GH_APP_TOKEN.expiresAt - Date.now() > 10 * 60 * 1000) return GH_APP_TOKEN.value;
  const r = await fetch(`https://api.github.com/app/installations/${GH_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ghAppJwt(),
      Accept: "application/vnd.github+json",
      "User-Agent": "g99-website-build-tool",
    },
  });
  if (!r.ok) throw new Error(`GitHub App token failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  GH_APP_TOKEN = { value: d.token, expiresAt: new Date(d.expires_at).getTime() };
  return GH_APP_TOKEN.value;
}

// What the App can actually do, probed once against a real repo — the permissions an App was
// created with, and the ones the org accepted, can differ. Capability is PER AREA rather than
// all-or-nothing: an App that can push and open PRs but cannot read check runs should still
// drive the pipeline, with only the CI reads borrowing the PAT.
let GH_APP_CAPS = null;
async function ghAppCaps() {
  if (GH_APP_CAPS) return GH_APP_CAPS;
  if (!GH_APP_CONFIGURED) return (GH_APP_CAPS = { any: false, pulls: false, checks: false });
  try {
    const token = await ghAppToken();
    const H = { Authorization: "token " + token, Accept: "application/vnd.github+json", "User-Agent": "g99-website-build-tool" };
    const probe = async (p) => (await fetch(`https://api.github.com/repos/${WP_REPO}${p}`, { headers: H })).status;
    const [pulls, checks, statuses] = await Promise.all([
      probe("/pulls?per_page=1"), probe("/commits/main/check-runs"), probe("/commits/main/status"),
    ]);
    GH_APP_CAPS = { any: true, pulls: pulls === 200, checks: checks === 200 && statuses === 200 };
    const missing = [
      !GH_APP_CAPS.pulls ? '"Pull requests: Read and write"' : "",
      checks !== 200 ? '"Checks: Read-only"' : "",
      statuses !== 200 ? '"Commit statuses: Read-only"' : "",
    ].filter(Boolean);
    if (!missing.length) console.log("✓ GitHub App g99-gitops — full pipeline access, GH_TOKEN no longer needed");
    else if (GH_APP_CAPS.pulls) console.log(`✓ GitHub App g99-gitops — push, PR and merge run as the App. Still missing ${missing.join(" + ")}, so CI status reads use GH_TOKEN.`);
    else console.warn(`⚠ GitHub App cannot open PRs — running on GH_TOKEN. Grant ${missing.join(", ")} and accept the update on the organisation.`);
  } catch (e) {
    console.warn("⚠ GitHub App unusable:", e.message, "— falling back to GH_TOKEN");
    GH_APP_CAPS = { any: false, pulls: false, checks: false };
  }
  return GH_APP_CAPS;
}
// Kept for callers that only want a yes/no on "is the App running the pipeline".
const ghAppUsable = async () => (await ghAppCaps()).pulls;

// The token a given call should use.
//   purpose "write"  — clone, push, PR create/merge  → needs contents + pull_requests
//   purpose "checks" — CI status reads               → needs checks + statuses
// Each falls back to the PAT only for the area the App is missing, so granting the last two
// permissions is all that stands between here and dropping GH_TOKEN entirely.
async function ghToken(purpose = "write") {
  const caps = await ghAppCaps();
  const ok = purpose === "checks" ? caps.checks : caps.pulls;
  if (ok) {
    try { return await ghAppToken(); } catch (e) { console.error("app token refresh failed:", e.message); }
  }
  return process.env.GH_TOKEN || "";
}

// Authenticated clone/push URL. Always built from a FRESH token — an installation token minted
// at the start of a long build would already be expiring by the time the push happens.
async function ghCloneUrl(repo) {
  const t = await ghToken();
  return t ? `https://x-access-token:${t}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
}

// Run a shell command. `gh` reads GH_TOKEN from the environment; when the App is in use its
// installation token is injected here so every gh call is authenticated as the App.
function sh(cmd, cwd) {
  return new Promise((resolve) => {
    const go = (token) => exec(cmd, {
      cwd, maxBuffer: 1e8, windowsHide: true,
      env: token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : process.env,
    }, (e, stdout, stderr) => resolve({ code: e ? (e.code || 1) : 0, stdout: stdout || "", stderr: stderr || "" }));
    // Only gh needs the injected token; plain shell commands skip the lookup entirely.
    if (!GH_APP_CONFIGURED || !/^\s*gh\b/.test(cmd)) return go(process.env.GH_TOKEN || "");
    // CI status reads need checks+statuses, which the App may not have yet, while push/PR/merge
    // need pull_requests, which it may. Pick the token per command rather than per process.
    const purpose = /\bpr\s+checks\b|check-runs|commits\/[^\s"]*\/status/.test(cmd) ? "checks" : "write";
    ghToken(purpose).then(go).catch(() => go(process.env.GH_TOKEN || ""));
  });
}

const GEN = path.join(DIR, "generated");
const PORT = process.env.PORT || 8793;
// Comma-separated so multiple keys can be pooled under the one env var name —
// no rename needed, existing deployments with a single key keep working as-is.
const STITCH_KEYS = String(process.env.STITCH_API_KEY || "").split(",").map(s => s.trim()).filter(Boolean);
const API_KEY = STITCH_KEYS[0] || "";   // kept for any legacy reference
let skIdx = 0;
// Per-job key override: set before calling buildStitchSiteWithKeyRotation, cleared after.
let STITCH_KEY_OVERRIDE = null;
const MCP_URL = "https://stitch.googleapis.com/mcp";
const GEMINI_KEYS = (process.env.GEMINI_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
// NocoDB is the source of truth for real websites (name / domain / repo). The
// table id is derived from the shared board URL; only the token is a secret.
const NOCODB_BASE = (process.env.NOCODB_BASE || "https://app.nocodb.com").replace(/\/$/, "");
const NOCODB_TOKEN = process.env.NOCODB_TOKEN || "";
const NOCODB_TABLE = process.env.NOCODB_TABLE || "mp8nfno2six11yi";
// TED — where an inbound email request is logged for the delivery team. Off
// until TED_API_TOKEN is set, so nothing changes for a deployment without one.
const TED_BASE = (process.env.TED_BASE || "https://ted.growth99.com").replace(/\/$/, "");
const TED_API_TOKEN = process.env.TED_API_TOKEN || "";
// The one task every email request is filed against, until we look the right
// task up per client. Env-overridable so moving it is not a code change.
const TED_REVISIONS_TASK_ID = process.env.TED_REVISIONS_TASK_ID || "9078";
// The API docs cover Bearer JWTs from Google sign-in but never say how a
// personal API token is presented. If Bearer 401s, flip this to x-api-key.
const TED_AUTH_HEADER = (process.env.TED_AUTH_HEADER || "bearer").toLowerCase();
// How long to wait after a merge before screenshotting the live site. There is
// no way to detect the deploy landing — the page returns different markup on
// every request, so a before/after comparison reports "changed" immediately.
const TED_SHOT_DELAY_MS = Number(process.env.TED_SHOT_DELAY_MS || 60000);
const TED_SCREENSHOTS = (process.env.TED_SCREENSHOTS || "on").toLowerCase() !== "off";
// TED stores a comment image inline as base64 in the comment's own text, so an
// oversized capture is a text-length problem: ~1.5MB inlined returns a 500.
// jpeg/q40/1400px lands around 110KB (~150KB inlined) on both providers — wide
// enough to read a hero at a glance, nowhere near the ceiling.
const TED_SHOT_WIDTH = Number(process.env.TED_SHOT_WIDTH || 1400);
const TED_SHOT_PARAMS = `&type=jpeg&quality=40&viewport.width=${TED_SHOT_WIDTH}`;
const TED_SHOT_MAX_BYTES = 400 * 1024;
// Optional, but effectively required once deployed: microlink's free quota is
// 25/day counted per calling IP, and a shared host's IP is spent by other
// tenants long before we get to it. Unset works fine locally and fails on
// Render for reasons no log used to explain. Also used by the CRO audit.
const MICROLINK_API_KEY = process.env.MICROLINK_API_KEY || "";
if (!STITCH_KEYS.length) console.warn("⚠ STITCH_API_KEY not set — Stitch generation will fail. Add it to .env or the platform env vars.");
else if (STITCH_KEYS.length > 1) console.log(`Stitch: ${STITCH_KEYS.length} keys pooled, will rotate on quota exhaustion`);
if (!NOCODB_TOKEN) console.warn("⚠ NOCODB_TOKEN not set — the All Sites / Edit Sites website list will be empty until it's added to .env.");
if (!GEMINI_KEYS.length) console.warn("⚠ GEMINI_KEYS not set — all AI features (CRO, prompt, bind, QC) will fail.");
// Live per-treatment photo search — real variety instead of the fixed ~14-photo
// curated pool (which has shipped at least one plainly wrong photo — a
// construction site under "Medical Weight Loss", a t-shirt elsewhere — because
// a small hardcoded list has no way to catch a mislabeled entry). Optional:
// unset = every image-replacement path below falls back to the curated pool
// exactly as before, fail-soft, same pattern as PSI/Browserless.
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || "";
if (!UNSPLASH_ACCESS_KEY) console.warn("⚠ UNSPLASH_ACCESS_KEY not set — image replacement falls back to the small curated photo pool (same ~14 photos for every client).");
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

// A quota-exhausted key answers with 429 (or 403 RESOURCE_EXHAUSTED) — same signal
// geminiCall rotates on. One key still works exactly as before (loop runs once).
function isQuotaError(status, text) {
  return status === 429 || (status === 403 && /RESOURCE_EXHAUSTED|quota/i.test(text || ""));
}
async function rpc(method, params, notify = false, timeoutMs = 90000) {
  const body = { jsonrpc: "2.0", method };
  if (!notify) body.id = ++rpcId;
  if (params) body.params = params;
  let lastErr = null;
  // If a per-job key override is active, use only that key (no rotation).
  const keys = STITCH_KEY_OVERRIDE ? [STITCH_KEY_OVERRIDE] : STITCH_KEYS;
  for (let i = 0; i < Math.max(keys.length, 1); i++) {
    const key = STITCH_KEY_OVERRIDE ? STITCH_KEY_OVERRIDE : (keys[(skIdx + i) % Math.max(keys.length, 1)] || "");
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
          "X-Goog-Api-Key": key,
          "MCP-Protocol-Version": PROTO,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`Stitch ${method} timed out after ${timeoutMs}ms`) : new Error(`Stitch ${method}: ${e.message}`);
      continue;
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (isQuotaError(res.status, text) && i < STITCH_KEYS.length - 1) {
        lastErr = new Error(`Stitch HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
        console.warn(`Stitch key #${(skIdx + i) % STITCH_KEYS.length + 1} exhausted (${res.status}) — rotating to next key`);
        continue;
      }
      throw new Error(`Stitch HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
    }
    if (notify) return {};
    const parsed = parsePayload(await res.text());
    if (parsed && parsed.error) {
      const errStr = JSON.stringify(parsed.error);
      // Tool-level quota errors arrive as HTTP 200 with an error body — rotate keys the same as HTTP 429/403.
      if (/RESOURCE_EXHAUSTED|quota/i.test(errStr) && i < STITCH_KEYS.length - 1) {
        lastErr = new Error(`Stitch tool quota on ${method}: ${errStr.slice(0, 300)}`);
        skIdx = (skIdx + i + 1) % Math.max(STITCH_KEYS.length, 1);
        console.warn(`Stitch key #${(skIdx + i) % STITCH_KEYS.length + 1} tool-level quota exhausted on ${method} — rotating to next key`);
        continue;
      }
      throw new Error(`Stitch RPC error: ${errStr}`);
    }
    // Third quota shape: HTTP 200, no parsed.error, but result.isError=true with quota text in content.
    // Do NOT retry within this rpc loop — tool calls like generate_screen_from_text embed a projectId
    // that is scoped to the exhausted key; retrying with the same projectId on a new key returns
    // "entity not found". Instead, advance skIdx so the CALLER's retry loop (generateWithRetry)
    // creates a fresh project under the new key on its next attempt.
    const result = parsed ? parsed.result : {};
    if (result && result.isError) {
      const toolErr = (result.content || []).map(c => c.text).join("");
      if (/RESOURCE_EXHAUSTED|quota/i.test(toolErr)) {
        skIdx = (skIdx + i + 1) % Math.max(STITCH_KEYS.length, 1);
        console.warn(`Stitch key #${(i % STITCH_KEYS.length) + 1} isError quota on ${method} — advanced skIdx to key ${skIdx + 1}, caller must reset project and retry`);
      }
    }
    return result;
  }
  throw lastErr || new Error(`Stitch ${method}: no API key configured`);
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

// -------------------------------------------- Mockup screenshots of the NEW site
// G99's "Mockup Creation" task wants a visual of the finished beta site: Home, one service page,
// About and Contact. Returned as base64 data URIs rather than links, for two reasons: this server's
// disk is wiped on every redeploy, and a screenshot SERVICE url re-renders the page on each request —
// so months later it would show today's site, not the one that was reviewed. Inlining freezes the
// evidence at the moment the task closed.
//
// thum.io, not microlink. microlink's keyless tier failed all four targets on the first real run:
// ETIMEOUT after 28s on two, an HTML error page (Cloudflare) on the others, and it rate-limits by IP.
// thum.io needs no key, answers in ~4s, and returned a full-quality image for all four.
// Captured via Google PageSpeed Insights, which runs Lighthouse and returns
// `fullPageScreenshot` — the whole page rendered at a 1350px desktop viewport, as WebP.
//
// Why PSI and not a screenshot service. Three were tried against a real beta site and all failed:
//   * thum.io `width/N`  -> an N x N SQUARE viewport crop. On a site whose hero is `min-h-[90vh]`
//                           that is hero-only, so all four review shots looked like one image.
//   * thum.io `fullpage` -> sets the viewport height to the document height, so `90vh` resolves
//                           against the whole page and the hero swallows ~90% of it. Raising the
//                           crop does not help: the ratio is fixed (verified at 2400 and 3600).
//   * microlink keyless  -> ETIMEOUT at 28s, rate-limits by IP, and silently ignores
//                           `screenshot.fullPage` / `screenshot.type` (paid features).
// PSI is free (25k/day with a key), answers in ~13s, and returns ~60KB of WebP instead of ~2MB of
// PNG — which matters because these are inlined into a task comment.
//
// KNOWN LIMITATION: Lighthouse also expands the viewport to capture the full page, so a `90vh` hero
// still renders taller than a visitor would see. Every hosted API shares this; only a headless
// Chrome using captureBeyondViewport gets the proportions right. The trade accepted here is an
// exaggerated hero in exchange for seeing every section, at 1/30th the bytes.
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_API_KEY = process.env.PSI_API_KEY || "";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || process.env.BROWSERLESS_API_KEY || "";
const BROWSERLESS_URL = String(process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io").replace(/\/+$/, "");
const BROWSERLESS_TIMEOUT_MS = Math.max(10000, Number(process.env.BROWSERLESS_TIMEOUT_MS || 60000) || 60000);
// Per image, RAW bytes. A PSI WebP is ~60KB, so this is a generous sanity bound rather than a
// real constraint — the 1.5MB ceiling it replaces was the sole reason Home failed on the first run.
const MOCKUP_MAX_BYTES = 3_000_000;

/**
 * Retries per page. Two independent transient failures make this mandatory rather than defensive:
 *   * PSI itself is flaky under repeated calls — "Lighthouse returned error: Something went wrong"
 *     hit 3 of 4 pages in one sweep, and the same URLs succeeded moments earlier.
 *   * the page may not have finished deploying, so the pre-flight legitimately sees a 404 for a
 *     service page that appears a few seconds later.
 * Backoff is generous because both causes resolve on the order of seconds, not milliseconds.
 */
const MOCKUP_RETRY_DELAYS_MS = [4000, 10000, 20000];

async function captureMockup(label, url) {
  let last = null;
  for (let attempt = 0; attempt <= MOCKUP_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt) await sleep(MOCKUP_RETRY_DELAYS_MS[attempt - 1]);
    last = await captureMockupOnce(label, url);
    if (last.dataUri) return last;
    // A missing key is configuration, not weather — retrying cannot fix it.
    if (last.error && last.error.includes("PSI_API_KEY")) return last;
  }
  return last;
}

async function captureMockupOnce(label, url) {
  if (!PSI_API_KEY) return { label, url, error: "PSI_API_KEY not configured" };
  try {
    // Pre-flight the PAGE itself. A WordPress 404 is a styled page that screenshots perfectly, so
    // without this a service page that hadn't finished deploying would be attached as if it were
    // real evidence — worse than reporting nothing, because it looks convincing.
    const page = await fetch(url, { redirect: "follow" });
    if (!page.ok) return { label, url, error: `page returned HTTP ${page.status}` };

    const api = `${PSI_ENDPOINT}?url=${encodeURIComponent(url)}&key=${PSI_API_KEY}`
      + `&strategy=desktop&category=performance`;
    const res = await fetch(api);
    // Check the type before touching the body: parsing an HTML error page as JSON is how the first
    // run lost two captures to a useless "Unexpected token '<'".
    const ctype = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ctype.includes("json")) {
      return { label, url, error: `PSI returned ${ctype || "no content-type"} (HTTP ${res.status})` };
    }
    const body = await res.json();
    if (body.error) {
      return { label, url, error: `PSI: ${String(body.error.message || "").slice(0, 120)}` };
    }
    const shot = body?.lighthouseResult?.fullPageScreenshot?.screenshot;
    const dataUri = shot?.data;
    if (!dataUri || !dataUri.startsWith("data:image/")) {
      return { label, url, error: "PSI returned no fullPageScreenshot" };
    }
    // PSI hands back a ready-made data URI, so there is nothing to re-encode.
    const approxBytes = Math.floor((dataUri.length - dataUri.indexOf(",") - 1) * 3 / 4);
    if (approxBytes > MOCKUP_MAX_BYTES) {
      // Don't silently ship something that will be rejected downstream — say so instead.
      return { label, url, error: `screenshot too large (${Math.round(approxBytes / 1024)}KB)` };
    }
    return { label, url, dataUri, width: shot.width || null, height: shot.height || null };
  } catch (e) {
    // Never fail the build for a mockup: the site is already live at this point.
    return { label, url, error: String(e.message || e).slice(0, 160) };
  }
}

/**
 * Captures the four review pages. Service slug comes from the generated pages so it is always a
 * real URL; About/Contact are conventional WordPress paths and may legitimately not exist, in which
 * case the entry carries an `error` and the others still go through.
 */
async function captureMockups(baseUrl, services) {
  if (!baseUrl) return [];
  const root = String(baseUrl).replace(/\/+$/, "");
  const firstService = (services || []).find((s) => s && s.slug);
  const targets = [
    { label: "Home", url: `${root}/` },
    ...(firstService ? [{ label: `Service — ${firstService.name}`, url: `${root}/${firstService.slug}/` }] : []),
    { label: "About", url: `${root}/about/` },
    { label: "Contact", url: `${root}/contact/` },
  ];
  const out = [];
  for (const t of targets) out.push(await captureMockup(t.label, t.url));   // serial: microlink is rate-limited
  return out;
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
// These four enum sets are the only ones proven to be accepted by
// create_design_system. The published Stitch SDK docs do not list the theme
// enum space at all, so treat this table as the known-good allowlist and do NOT
// pass a font enum derived from a client's brand until tools/list confirms the
// valid set (see DESIGN_QUALITY_PLAN.md, PROBE-2).
const VIBE_FONTS = {
  "Luxurious & Warm": { headlineFont: "PLAYFAIR_DISPLAY", bodyFont: "INTER", roundness: "ROUND_FOUR" },
  "Clean & Minimalist": { headlineFont: "SPACE_GROTESK", bodyFont: "INTER", roundness: "ROUND_TWO" },
  "Bold & Modern": { headlineFont: "SYNE", bodyFont: "INTER", roundness: "ROUND_EIGHT" },
  "Clinical & Precise": { headlineFont: "INTER", bodyFont: "INTER", roundness: "ROUND_TWO" },
};
// The build path never set theme.vibe (see runJob's `theme` object), so
// VIBE_FONTS[theme.vibe] was undefined on EVERY autonomous run and silently fell
// back to "Luxurious & Warm". Every client therefore had its design system built
// for Playfair + Inter regardless of the brand we had just composed, and
// enforceBrandFonts then overrode the rendered face with !important — so Stitch
// laid the page out for one typeface and it shipped rendered in another.
// Derive the vibe from the brand we actually composed instead: the enum picked
// here only has to MATCH THE CHARACTER of the real face, because the real face
// is stated verbatim in designMd below and re-applied by enforceBrandFonts.
function vibeFor(theme) {
  if (theme.vibe && VIBE_FONTS[theme.vibe]) return theme.vibe;
  const h = String(theme.headingFont || "");
  if (DISPLAY_FACES.test(h)) return "Luxurious & Warm";        // serif display
  if (/^(syne|clash|monument|druk|archivo|anton|bebas)/i.test(h)) return "Bold & Modern";
  if (/^(space grotesk|grotesk|jost|outfit|sora|figtree|manrope|dm sans)/i.test(h)) return "Clean & Minimalist";
  return "Clinical & Precise";
}
// The design brief Stitch receives. Highest-leverage input the API exposes —
// used to be 12 lines (brand name, three hexes, one line of "style"), which is
// why generated pages defaulted to the median of the model's training data on
// every decision left unspecified (type scale, spacing, grid, section rhythm,
// components, motion). The "Signature techniques" section below is not
// invented — it's the pattern that recurred across 4 of the client's own
// reference mockups (Hello Skin, Ruma Medical, Reform MD, Maven Medi Spa),
// each read from its actual PDF, 2026-08-05: an oversized low-opacity brand
// wordmark bled behind a section on ALL FOUR (hero or mid-page AND the footer
// on every one — never just once), and every heading was a two-part
// composition — one big display line plus a second line/word carrying the
// accent color in a distinct style (italic, tracked caps, or a different
// weight). Animation is the one addition here that is NOT read off a mockup —
// PDFs are static — it's requested directly, layered onto the existing Motion
// rules.
function designMdFor(theme) {
  const v = vibeFor(theme);
  const heading = theme.headingFont || "Playfair Display";
  const body = theme.bodyFont || "Jost";
  return [
    `## ${theme.displayName || "Brand"}`,
    `Luxury medical-aesthetics / medspa brand. Editorial, unhurried, expensive. The reference`,
    `register is a high-end print magazine and a boutique hotel brand book — NOT a SaaS landing page.`,
    ``,
    `## Typography — use these EXACT families`,
    `- Display / headings: "${heading}". Body: "${body}". Do not substitute either.`,
    `- Type scale, strict (rem, 1.250 major-third): 3.815 / 3.052 / 2.441 / 1.953 / 1.563 / 1.25 / 1 / 0.8.`,
    `  Every text size must be a step on that scale. Never an arbitrary value.`,
    `- h1 clamp(2.75rem, 5vw, 3.815rem), line-height 1.05, letter-spacing -0.02em.`,
    `- Body 1.0625rem, line-height 1.65, max measure 68ch. Long-form copy never spans the full width.`,
    `- One weight jump per level (400 body / 500 subhead / 600 display). Never bold everything.`,
    `- Eyebrow labels: 0.8rem, uppercase, letter-spacing 0.14em, in the accent colour.`,
    ``,
    `## Every heading is TWO parts, not one — seen on every reference mockup`,
    `- Line 1: the big display headline, in "${heading}".`,
    `- Line 2 (required, directly under it): a second line or single key WORD carrying the accent`,
    `  colour in a visibly different style from line 1 — italic, or letter-spaced small caps, or a`,
    `  lighter weight. Example patterns actually used: "Our *Specialties*" (one word italicised inside`,
    `  the heading), "MEET OUR FOUNDER" + "Expertise with genuine passion" below it (accent-coloured`,
    `  second line), "PRESERVING YOUR NATURAL BEAUTY" + "ENHANCING INTERNAL WELLNESS" (small tracked caps).`,
    `- Never ship a bare single-line heading. This two-part composition is not optional — vary WHICH`,
    `  of the three styles (italic word / accent second line / tracked-caps subhead) per section.`,
    ``,
    `## Signature techniques — required, not decoration (inspired by Ruma, HelloSkin, ER Injectables, Austin Aesthetic Couture)`,
    `- OVERSIZED BACKGROUND WORDMARK & PARALLAX: the business name (or keyword) set at 12–22rem, opacity`,
    `  4–8%, position absolute, bleeding behind a section's content with subtle parallax. Must appear AT LEAST TWICE per page: behind mid-page section & footer.`,
    `- PHOTO ENGRAVED TEXT & BADGING: Photos feature floating luxury glassmorphism pills (e.g. "4.9★ RATING", "BOARD CERTIFIED"),`,
    `  gold border overlays, and semi-transparent quote callouts written directly ON provider and treatment imagery.`,
    `- LAYERED PHOTO COMPOSITION: two photos overlapping at a slight offset/angle (a small collage),`,
    `  OR an asymmetric mosaic of 3–5 different-sized photo tiles. Use one of these for at least one`,
    `  intro/about section instead of a single rectangular photo.`,
    `- CAPTION-ON-PHOTO CARDS: for service/treatment grids, the caption (and price, if any — "STARTING`,
    `  AT $XXX") sits directly ON the image under a dark gradient scrim at the bottom, not in text below`,
    `  the photo in a separate block.`,
    `- CATEGORY PILL STRIP: a horizontal row of pill-shaped category/service labels directly beneath`,
    `  the hero (e.g. "SKIN HEALTH · FUNCTIONAL WELLNESS · INJECTABLES") — optional, use where it fits.`,
    `- REAL LEAD FORM ON THE HOMEPAGE: a genuine multi-field booking/contact form (name, phone, email,`,
    `  message) embedded near the bottom of the page, styled to the brand — not just a CTA button.`,
    `- SOCIAL PROOF STRIP: a row of 5–6 square Instagram-style photo tiles near the footer.`,
    ``,
    `## Spacing + grid`,
    `- 8px base. Allowed steps only: 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128 / 160.`,
    `- Section padding-block 96px desktop, 64px tablet, 48px mobile.`,
    `- 12-column grid, 1280px max content width, 24px gutters, 32px page margin.`,
    `- Asymmetry is required: at least three sections must use a 5/7, 4/8 or 7/5 split, never 6/6.`,
    ``,
    `## Section rhythm — this is what stops the page reading as generated`,
    `- Alternate background tone every section: light / tinted / dark / light. Never three identical in a row.`,
    `- Vary section SHAPE, not just content: full-bleed image, contained two-column, offset overlap,`,
    `  edge-to-edge band, centred narrow column. No two adjacent sections share a layout pattern.`,
    `- Vary vertical density deliberately — a tight stats band directly after a spacious editorial block.`,
    `- At least one section must break the grid: an image bleeding past the container or overlapping two sections.`,
    ``,
    `## Colour`,
    `- Primary ${theme.primary} · Secondary ${theme.secondary} · Accent ${theme.accent || "champagne gold"}.`,
    `- Accent is for emphasis ONLY — eyebrows, rules, one CTA, small marks. Never a section background.`,
    `- Dark sections use the secondary at full strength, not a grey.`,
    `- Body text must hit at least 4.5:1 against its own background. Check every pairing.`,
    ``,
    `## Components`,
    // Plain px here is a trap in a Tailwind-generating model: "28px" reads as
    // the literal utility number "28" (Tailwind's scale is 1 unit = 4px, so
    // py-28 is 112px, not 28px) — that is exactly how one real generation
    // produced a nav CTA the size of a postcard. State the utility class
    // itself so there is nothing to mistranslate.
    `- Buttons: Tailwind utilities px-6 py-3 (or arbitrary px-[14px] py-[10px]) — never a bare number chosen to LOOK like a pixel value (py-28 is 112px, not 28px). ${(VIBE_FONTS[v] || {}).roundness === "ROUND_TWO" ? "rounded-sm" : "rounded"} radius, no gradient, no drop shadow.`,
    `- Cards: 1px hairline border at 8% ink, radius matching the buttons, no shadow. Hover lifts 2px and warms the border.`,
    `- Inputs: hairline underline or 1px border, generous 14px padding, visible focus ring in the accent.`,
    `- Dividers are 1px hairlines at 8% ink, never a chunky grey rule.`,
    ``,
    `## Motion — requested explicitly, layer onto every section above`,
    `- Reveal on scroll: 12px rise + fade, 500ms, cubic-bezier(0.16,1,0.3,1), staggered 60ms across siblings.`,
    `- The two-part heading (above) reveals in two beats: line 1 first, line 2/accent-word follows ~120ms later.`,
    `- The oversized background wordmark drifts slowly on scroll (subtle parallax, a few px of translateY) —`,
    `  it should feel like it sits BEHIND the page, not printed flat on it.`,
    `- Hover transitions 180ms ease-out. Images scale to 1.03 inside a fixed-overflow frame. Service/treatment`,
    `  cards lift 4px and deepen their shadow on hover.`,
    `- Respect prefers-reduced-motion.`,
    ``,
    `## Imagery`,
    `- Only sharp, high-resolution, professional photography of medspa/skincare/wellness/clinicians.`,
    `- NEVER blurred, grainy, pixelated or out-of-focus. Never text, UI or a website screenshot inside a photo.`,
    `- Photos sit under a subtle gradient overlay so overlaid text stays readable.`,
    `- Vary crop and aspect between sections: a tall portrait, a wide letterbox, a square detail shot.`,
    ``,
    `## Do NOT — these are the tells of a generated page`,
    `- No Inter, Roboto, Arial, Open Sans, Lato or a system-font stack anywhere.`,
    `- No purple/violet gradients, no gradient text, no glassmorphism, no neon glow.`,
    `- No three-identical-cards-in-a-row as the only content pattern.`,
    `- No emoji as icons. No generic centred hero with a single centred paragraph and two centred buttons.`,
    `- No uniform section heights, no 6/6 splits everywhere, no drop shadows on everything.`,
  ].join("\n");
}
async function createDesignSystemForSite(pid, theme) {
  const f = VIBE_FONTS[vibeFor(theme)];
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
      // Keep the design system for every attempt but the last. It used to be
      // dropped from attempt 3 onwards because Stitch sometimes rejects a
      // design-system'd generate as "invalid argument" — but a page generated
      // WITHOUT it has none of the brand's type, spacing or component rules, so
      // a retry silently shipped an off-system page rather than failing. Losing
      // the theme is the worse outcome; only the final attempt trades it for a
      // last chance at any output at all.
      if (designSystem && attempt < 5) args.designSystem = designSystem;
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
      // Quota errors mean the key is exhausted — the projectId belongs to that key's
      // account and is inaccessible from any other key. Retrying here with the same
      // projectId on a rotated key will only produce "entity not found". Throw
      // immediately so buildStitchSiteWithKeyRotation restarts the whole build
      // (new project + design system + all pages) under the next key.
      if (/RESOURCE_EXHAUSTED|quota/i.test(e.message)) throw e;
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
  // If any page hit a quota error, surface it so buildStitchSiteWithKeyRotation can rotate the key.
  const quotaErr = results.find(r => r.error && /RESOURCE_EXHAUSTED|quota/i.test(r.error));
  if (quotaErr) throw new Error(`stitch quota: ${quotaErr.error}`);

  fs.writeFileSync(path.join(GEN, ".stitch-metadata.json"), JSON.stringify(meta, null, 2));
  const okCount = results.filter(r => r.html).length;
  console.log(`stitch: ${okCount}/${results.length} pages generated (project ${pid})`);
  return { projectId: pid, designSystem, results };
}

// Wrapper: retry buildStitchSite with a fresh Stitch key when quota is exhausted.
// Each Stitch API key belongs to a separate Google account, so a project created
// under key N is not accessible by key N+1 — the entire build (project + design
// system + all pages) must restart under the new key.
async function buildStitchSiteWithKeyRotation(pages, theme, deviceType) {
  // When a per-job key override is active, pin skIdx to that key and skip rotation.
  if (STITCH_KEY_OVERRIDE) {
    const idx = STITCH_KEYS.indexOf(STITCH_KEY_OVERRIDE);
    if (idx >= 0) skIdx = idx;
    PROJECT = null; SCREENS_MADE = 0; DESIGN_SYSTEM = null; PROTO = "2024-11-05";
    return await buildStitchSite(pages, theme, deviceType);
  }
  let lastErr = null;
  const attempts = Math.max(STITCH_KEYS.length, 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Reset Stitch MCP session so ensureInit() (called inside generateWithRetry)
      // creates a brand-new project under the current skIdx key.
      PROJECT = null; SCREENS_MADE = 0; DESIGN_SYSTEM = null; PROTO = "2024-11-05";
      return await buildStitchSite(pages, theme, deviceType);
    } catch (e) {
      lastErr = e;
      const isQuota = /RESOURCE_EXHAUSTED|quota/i.test(e.message);
      console.warn(`buildStitchSite attempt ${attempt}/${attempts} failed (quota=${isQuota}): ${e.message.slice(0, 160)}`);
      if (isQuota && attempt < attempts) {
        skIdx = (skIdx + 1) % Math.max(STITCH_KEYS.length, 1);
        console.warn(`Stitch key exhausted — rotating to key ${skIdx + 1} and rebuilding from scratch`);
        continue;
      }
      throw e; // non-quota error or no keys left
    }
  }
  throw lastErr;
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
  // <header> FIRST, <nav> only as fallback. Generated pages nest the nav inside the
  // header (`<header class="fixed top-0 z-50 …"><nav class="hidden md:flex">…</nav></header>`),
  // so taking the nav cut the chrome at the wrong boundary: header.php got a desktop-only
  // link list with no logo, no CTA, no hamburger and none of the fixed/backdrop styling,
  // while every page template kept the leftover <header> shell — a second fixed bar with
  // the branding but no links. This also matches bindSiteSmart(), which already prefers
  // <header>; the two disagreeing is what made the preview look right and the theme break.
  const header = (body.match(/<header\b[\s\S]*?<\/header>/i) || body.match(/<nav\b[\s\S]*?<\/nav>/i) || [""])[0];
  const footer = (body.match(/<footer\b[\s\S]*?<\/footer>/i) || [""])[0];
  let main = body;
  if (header) main = main.replace(header, "");
  if (footer) main = main.replace(footer, "");
  return { head: wpRewriteLinks(head), header: wpRewriteLinks(header), footer: wpRewriteLinks(footer), main: wpRewriteLinks(main) };
}
// opts.logoUrl   — the onboarding logo upload; becomes the site favicon
// opts.businessId — drives the chatbot widget's data-id
async function buildWpTheme(slug, biz, opts = {}) {
  const siteDir = path.join(GEN, "site");
  if (!fs.existsSync(path.join(siteDir, "index.html"))) throw new Error("Bind the site first (Step 4) — no /site/ bundle found.");
  const themeDir = path.join(GEN, "wp-theme", slug);
  const buildId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""); // YYYYMMDDHHMM — keys one-time auto-activation per deploy
  // DIAGNOSTIC: GEN is a single shared dir. Log the source bundle's freshness so the deployed logs
  // reveal whether the theme is built from THIS run's generation or a stale/clobbered GEN/site.
  try {
    const idx = path.join(siteDir, "index.html");
    const st = fs.statSync(idx);
    const sha = require("crypto").createHash("sha256").update(fs.readFileSync(idx)).digest("hex").slice(0, 12);
    console.log(`[buildWpTheme] slug=${slug} reads GEN/site/index.html mtime=${st.mtime.toISOString()} bytes=${st.size} sha=${sha}`);
  } catch (e) { console.warn("[buildWpTheme] could not stat GEN/site:", e.message); }
  fs.rmSync(themeDir, { recursive: true, force: true });
  fs.mkdirSync(themeDir, { recursive: true });
  // Use the HOME page's head + header + footer as the shared chrome
  const home = splitPage(fs.readFileSync(path.join(siteDir, "index.html"), "utf8"));
  const written = [];
  const w = (name, content) => { fs.writeFileSync(path.join(themeDir, name), content); written.push(name); };

  // Fetched before functions.php is written, because the hooks below are only emitted when
  // there is actually a file to point at.
  const businessId = opts.businessId || null;
  const favicon = await writeFaviconFromLogo(themeDir, opts.logoUrl);
  if (favicon) written.push(`assets/${favicon.file}`);

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
${favicon ? `
/**
 * Favicon from the client's onboarding logo (assets/${favicon.file}).
 * Printed at priority 1 so it wins over anything a plugin adds later. Skipped when the
 * WordPress Site Icon is set, so an explicit choice in wp-admin is never overridden.
 */
add_action('wp_head', function () {
    if (function_exists('has_site_icon') && has_site_icon()) {
        return;
    }
    $href = esc_url(get_theme_file_uri('assets/${favicon.file}'));
    echo '<link rel="icon" type="${favicon.mime}" href="' . $href . '">' . "\\n";
    echo '<link rel="apple-touch-icon" href="' . $href . '">' . "\\n";
}, 1);
` : ""}${businessId ? `
/**
 * Growth99 chatbot widget. data-id is the base64-encoded business id (${businessId}).
 * On wp_footer so the div exists before integration.js runs.
 */
add_action('wp_footer', function () {
    echo '<div id="buisness-id" data-id="${chatbotDataId(businessId)}"></div>' . "\\n";
    echo '<script id="integration-script" src="https://chatbot.growth99.com/assets/js/integration.js"></script>' . "\\n";
});
` : ""}
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
  // Shared chrome, best source first.
  //
  // 1. The HOME page's OWN header, with its labels and hrefs corrected. It was
  //    designed with the page, so it carries the real type, spacing, hover states,
  //    responsive breakpoints and mobile menu — none of which aiChrome can have,
  //    because that prompt restricts it to inline styles. buildWpTheme already
  //    derives header.php from this file, so a good header here propagates to the
  //    whole theme for free.
  // 2. aiChrome — a separate compact Gemini call. Correct, but plain.
  // 3. canonicalNav — deterministic, always works, looks like a fallback.
  let chrome = null, source = "canonical (fallback)";
  const homeHtml = read("home");
  if (homeHtml) {
    const fixedHome = retargetNav(homeHtml, theme || {});
    if (fixedHome) {
      const header = extractBlock(fixedHome, "header") || extractBlock(fixedHome, "nav") || "";
      if (header) {
        chrome = { header, footer: extractBlock(fixedHome, "footer") || "", source: "page" };
        source = "page's own header (retargeted)";
      }
    }
  }
  if (!chrome) {
    try { chrome = await aiChrome(theme || {}); source = chrome.source + " chrome"; }
    catch (e) { console.warn("aiChrome failed, using canonical nav:", e.message.slice(0, 120)); }
  }
  const dirName = engineSuffix ? `site-${engineSuffix}` : "site";
  const siteDir = path.join(GEN, dirName);
  if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
  const banner = reviewBanner();
  const written = [];
  for (const [k, out] of present) {
    let html = read(k);
    html = stripSiteChrome(html, { footer: !!(chrome && chrome.footer) });
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
  // <header> first — same reason as splitPage(): the nav is nested inside it.
  const nav = extractBlock(home, "header") || extractBlock(home, "nav");
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
      const ownNav = extractBlock(html, "header") || extractBlock(html, "nav");
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
// photo-1512207736890-6ffed8a84e8d is NOT on this list on purpose — confirmed
// on a real generation, 2026-08-05/06: it rendered as a black-and-white
// construction/rebar site photo, not a medspa photo. A fixed list this small
// has no way to catch a mislabeled entry itself (that's exactly what the live
// Unsplash search below replaces) — removed rather than left in on the
// assumption nobody would draw it.
const CURATED_IMAGES = [
  "photo-1570172619644-dfd03ed5d881", "photo-1512290923902-8a9f81dc236c", "photo-1519824145371-296894a0daa9",
  "photo-1616394584738-fc6e612e71b9", "photo-1600334129128-685c5582fd35", "photo-1544161515-4ab6ce6db874",
  "photo-1515377905703-c4788e51af15", "photo-1487412720507-e7ab37603c6f",
  "photo-1629909613654-28e377c37b09", "photo-1552693673-1bf958298935", "photo-1571019613454-1cb2f99b2d8b",
  "photo-1583900985737-6d0495555783",
].map(id => `https://images.unsplash.com/${id}?w=1600&q=80&auto=format&fit=crop`);

// Every site used to draw from this pool starting at index 0, through three
// separate replacement passes that each kept their own counter. Two consequences,
// both of which read as "these are the same template": different clients got the
// same hero photograph, and one page could use the same photo twice because each
// pass restarted at 0.
//
// The offset is seeded from the business name — deterministic, so rebuilding the
// same site is stable — and the cursor is monotonic across every pass and page in
// a job. Single job concurrency makes a module-level cursor safe, same reasoning
// as COST_SINK.
//
// NOTE: this de-duplicates ACROSS clients, it does not make the photography
// bespoke — 14 photos is still a small pool. Per-client image search is the real
// fix (DESIGN_QUALITY_PLAN.md task 0.2); this is the half that needs no new key.
let CURATED_OFFSET = 0, CURATED_CURSOR = 0;
function fnv1a(s) {                                     // stable across runs and processes
  let h = 2166136261;
  for (const ch of String(s || "")) { h ^= ch.charCodeAt(0); h = (h * 16777619) >>> 0; }
  return h;
}
function seedCuratedPhotos(name) {
  CURATED_OFFSET = fnv1a(name) % CURATED_IMAGES.length;
  CURATED_CURSOR = 0;
}
const curatedPhoto = () => CURATED_IMAGES[(CURATED_OFFSET + CURATED_CURSOR++) % CURATED_IMAGES.length];

// Live per-category Unsplash search. Real variety instead of the fixed
// CURATED_IMAGES pool (14 photos, same for every client, and — per the
// construction-site photo above — with no way to catch a wrong entry itself).
// Off (returns null, callers fall back to the curated pool) unless
// UNSPLASH_ACCESS_KEY is set. Cached per query for the process lifetime — a
// single page asks for the same category many times over and this must not
// burn a free-tier ~50 req/hour limit re-fetching the same search.
// Audited live against the Unsplash API, 2026-08-07 (per-page=20, landscape,
// content_filter=high), because a query that matches NOTHING fails silently —
// the caller just falls through to the generic pool, so a "Medical Weight Loss"
// card quietly got whatever "luxury medical spa clinic treatment" returned (a
// red-light therapy bed). Search behaves like AND over the terms, so the more
// words a query has the likelier it is to return zero: "laser skin treatment
// clinic" and "body contouring medspa treatment" both returned 0 results, while
// dropping one word made each return 20. Keep these at three words or fewer and
// re-check with a real API call before changing one.
//   injectables 9 usable · laser 9 · facial 9 · body 6 · team 20 · interior 4
// hero is the exception: every rewrite tried ("medical spa interior", "spa
// clinic interior" → 0 results; "luxury spa interior", "modern spa interior" →
// 2 usable, and those were chairs and a table). It stays a known-empty query so
// heroes keep falling back to the hand-vetted CURATED_HERO_IMAGES at w=2400,
// which is the better picture for a full-bleed band anyway.
const UNSPLASH_QUERY_BY_CATEGORY = {
  injectables: "botox filler injection cosmetic clinic",
  laser: "laser skin treatment",
  facial: "facial spa treatment skincare",
  body: "body contouring",
  team: "medical clinic doctor team portrait",
  hero: "luxury medspa clinic interior",
  interior: "modern medical spa interior design",
};
const UNSPLASH_CACHE = new Map();   // query -> array of image URLs, or null on failure
// Unsplash's own search ranking is not trustworthy enough to accept blind —
// confirmed on a real generation, 2026-08-06: a "luxury medspa clinic
// interior" style query returned a photo of a SHIRT as its top hit (fashion
// photography apparently ranks for "clinic"/"treatment"-adjacent terms too).
// So every candidate is cross-checked against its OWN alt_description/
// description/tags for an actual medical/spa/beauty term before being
// accepted — Unsplash's ranking picks the candidate pool, this decides
// what's actually on-topic. A candidate with no metadata at all is rejected
// rather than assumed innocent.
const UNSPLASH_RELEVANCE_TERMS = /\b(medic|clinic|doctor|physician|nurse|dermatolog|skin\w*|spa\b|wellness|beauty|cosmetic|aesthetic|facial|treatment|therap|inject|botox|filler|laser|massage|salon|patient|health)/i;
async function unsplashSearch(query, count = 20) {
  if (!UNSPLASH_ACCESS_KEY) return null;
  const key = query.toLowerCase().trim();
  if (UNSPLASH_CACHE.has(key)) return UNSPLASH_CACHE.get(key);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape&content_filter=high`;
    const r = await fetch(url, { signal: ctl.signal, headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    clearTimeout(t);
    if (!r.ok) { console.warn(`unsplash search "${query}" -> HTTP ${r.status}`); UNSPLASH_CACHE.set(key, null); return null; }
    const d = await r.json();
    // Real HD source only — never accept a small original and let CSS stretch
    // it, same standard qcImageResolution holds Stitch's own images to.
    const relevant = (d.results || []).filter((ph) => {
      if ((ph.width || 0) < 1600) return false;
      const text = [ph.alt_description, ph.description, ...(ph.tags || []).map((tg) => tg.title)].filter(Boolean).join(" ");
      return UNSPLASH_RELEVANCE_TERMS.test(text);
    });
    const urls = relevant.map((ph) => `${ph.urls.raw}&w=1600&q=80&auto=format&fit=crop`);
    if (!urls.length) {
      console.warn(`unsplash search "${query}" -> ${(d.results || []).length} result(s), none passed the relevance check`);
      UNSPLASH_CACHE.set(key, null);
      return null;
    }
    UNSPLASH_CACHE.set(key, urls);
    return urls;
  } catch (e) {
    console.warn(`unsplash search "${query}" failed:`, String(e.message || e).slice(0, 120));
    UNSPLASH_CACHE.set(key, null);
    return null;
  }
}
// Generic (no page-text context) HD replacement used by fixImages/
// qcImageResolution when a broken/low-res image needs swapping and there's
// nothing to search with beyond "hero or not". Falls back to
// curatedHero()/curatedPhoto() exactly as before when Unsplash is off/failed.
async function unsplashOrCurated(isHero) {
  if (UNSPLASH_ACCESS_KEY) {
    const results = await unsplashSearch(isHero ? UNSPLASH_QUERY_BY_CATEGORY.hero : "luxury medical spa clinic treatment");
    if (results && results.length) return results[CURATED_CURSOR++ % results.length];
  }
  return isHero ? curatedHero() : curatedPhoto();
}
// The text AROUND an <img> — the card's heading and copy — is what says which
// service the picture is for. The img's own attributes do not: Stitch writes a
// data-alt describing the picture it invented ("a woman receiving a facial
// treatment") while the service label sits in a sibling <h3> in the overlay
// below it. Classifying on attributes alone is exactly how a card titled "Botox"
// shipped with a facial-mask photo. A window, not the whole document: page-wide
// matching would label every image with whatever section happened to come first.
const IMG_CONTEXT_BEFORE = 400, IMG_CONTEXT_AFTER = 1200;
function imageContext(html, at, len) {
  const before = html.slice(Math.max(0, at - IMG_CONTEXT_BEFORE), at);
  const after = html.slice(at + len, at + len + IMG_CONTEXT_AFTER);
  const text = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // The heading that labels THIS image: the first one after it (overlay cards put
  // the title under the picture), else the nearest one before it (section headers).
  const hAfter = after.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
  const hBefore = [...before.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)].pop();
  return {
    label: text((hAfter && hAfter[1]) || (hBefore && hBefore[1]) || "").slice(0, 60),
    text: text(before) + " " + text(after),
  };
}
function medspaCategory(txt) {
  const t = String(txt || "").toLowerCase();
  if (!t.trim()) return null;
  if (/botox|filler|inject|neuromodulator|juvederm|dysport|sculptra|kybella/i.test(t)) return "injectables";
  if (/laser|peel|resurfacing|ipl|bbl|moxi|morpheus|skin-tightening/i.test(t)) return "laser";
  if (/facial|hydrafacial|skincare|acne|glow|peel|dermaplan/i.test(t)) return "facial";
  if (/body|contour|sculpt|weight|loss|slimming|coolsculpt|emsculpt/i.test(t)) return "body";
  if (/team|doctor|physician|provider|staff|director|clinician|nurse|injector/i.test(t)) return "team";
  if (/hero|flagship|banner|welcome|philosophy|about/i.test(t)) return "hero";
  return null;
}
// Category-matched live search, falling back to a generic HD photo when no
// category matches or Unsplash is off.
async function contextualMedspaPhoto(txt, label) {
  // The card's own heading decides FIRST, and only falls through to the wider
  // text when the heading names no category. A card titled "Botox" sitting next
  // to a data-alt that describes a facial has to read as injectables, and the
  // combined string can't do that — whichever branch is earlier in the chain
  // wins regardless of which one the visitor actually reads.
  //
  // Not searched as free text ("<label> treatment clinic"): checked live against
  // the Unsplash API, 2026-08-07 — "Botox treatment clinic" returns 0 results at
  // all, and "Medical Weight Loss treatment clinic" returns a hair-salon portrait
  // as its top relevance-passing hit. The fixed per-category queries are the
  // vetted ones; the label picks the bucket, it does not become the query.
  const category = medspaCategory(label) || medspaCategory(txt);

  if (category && UNSPLASH_ACCESS_KEY) {
    const results = await unsplashSearch(UNSPLASH_QUERY_BY_CATEGORY[category]);
    // Indexed by the label's hash rather than the shared cursor, so one service
    // shows the SAME photo everywhere it appears (home card, services page, its
    // own page) instead of a different one per placement. Unlabelled images keep
    // the rolling cursor, which is what stops a page repeating one photo.
    if (results && results.length) {
      return results[label ? fnv1a(label) % results.length : CURATED_CURSOR++ % results.length];
    }
  }
  return unsplashOrCurated(category === "hero");
}
// Runs contextualMedspaPhoto over every <img src> in the page — replaces
// whatever Stitch/Gemini picked with a real, category-matched photo. Async:
// each image is resolved concurrently, then swapped in — a plain sync
// .replace() can't await.
async function sanitizeAllImages(html) {
  if (!html || !UNSPLASH_ACCESS_KEY) return html;   // off unless a key is configured
  const src = String(html);
  const re = /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>/gi;
  const matches = [...src.matchAll(re)];
  if (!matches.length) return html;
  const urls = await Promise.all(matches.map((m) => {
    const ctx = imageContext(src, m.index, m[0].length);
    return contextualMedspaPhoto(`${m[1] || ""} ${m[3] || ""} ${ctx.text}`, ctx.label);
  }));
  let i = 0;
  return src.replace(re, (match, p1, srcUrl, p2) => `<img${p1}src="${urls[i++]}"${p2}>`);
}

// Guarantee no broken images: Stitch sometimes emits session-bound
// lh3.googleusercontent.com/aida/... URLs that fail in the browser (and even
// /aida-public/ ones expire). Replace any image that isn't a stable, loading
// image with a curated topical photo. Deterministic, no LLM needed.
async function fixImages(html) {
  // NOTE: the old unconditional sanitizeAllImages() relevance-swap pass was
  // removed from here on purpose (2026-08-08) — it replaced EVERY image on
  // EVERY page whenever UNSPLASH_ACCESS_KEY was set, good or bad, which is
  // exactly the "why did my images change for no reason" complaint. Images
  // are now only ever replaced for a concrete defect: broken/unreliable URL,
  // or measurably blurry (see isImageBlurry). A good image is left alone.
  const urls = [...new Set((html.match(/https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-\/=]+/g) || []))];
  if (!urls.length) return html;
  for (const u of urls) {
    let replace = false, reason = "";
    if (!/\/aida-public\//.test(u)) {
      replace = true; reason = "unreliable-url";   // /aida/ screenshot-type → browser-unreliable
    } else {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(u, { signal: ctl.signal }); clearTimeout(t);
        if (!r.ok || !((r.headers.get("content-type") || "").startsWith("image"))) { replace = true; reason = "broken"; }
      } catch (e) { replace = true; reason = "fetch-failed"; }
    }
    if (!replace) {
      const { blurry, variance, error } = await isImageBlurry(u);
      if (blurry) { replace = true; reason = `blurry(var=${variance.toFixed(1)}<${BLUR_VARIANCE_THRESHOLD})`; }
      else console.log(`  img OK, keeping: ${u.slice(40, 56)}… sharpness=${variance != null ? variance.toFixed(1) : "n/a" + (error ? ` (${error})` : "")}`);
    }
    if (replace) { const c = await unsplashOrCurated(false); html = html.split(u).join(c); console.log(`  img replaced (${reason}): ${u.slice(40, 56)}… -> ${UNSPLASH_ACCESS_KEY ? "unsplash/curated" : "curated"}`); }
  }
  return html;
}
// Real blur detection (Laplacian-variance edge sharpness), not a relevance/QC
// heuristic: downscale to a fixed width, greyscale, measure the variance of a
// simple edge filter. Sharp photos have lots of high-contrast edges (high
// variance); blurry/soft ones don't. This is the ONLY reason to replace an
// otherwise-fine image — a good photo must never get swapped just because a
// 3rd-party pool exists. The one deliberate dependency in an otherwise
// dependency-free server (see file header) — pure-JS decode, no native build.
const BLUR_VARIANCE_THRESHOLD = 60;
async function isImageBlurry(url, threshold = BLUR_VARIANCE_THRESHOLD) {
  try {
    const { Jimp } = require("jimp");
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const buf = Buffer.from(await (await fetch(url, { signal: ctl.signal })).arrayBuffer());
    clearTimeout(t);
    const img = await Jimp.read(buf);
    img.resize({ w: 300 });
    img.greyscale();
    const { width: w, height: h, data } = img.bitmap;
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const lap = -4 * data[i] + data[i - 4] + data[i + 4] + data[i - w * 4] + data[i + w * 4];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { blurry: variance < threshold, variance };
  } catch (e) {
    // Fail-soft: cannot measure it -> leave the image alone rather than churn it.
    return { blurry: false, variance: null, error: String(e.message || e).slice(0, 120) };
  }
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
  urls.forEach((u, i) => {
    if (flags[i]) {
      const repl = curatedPhoto();
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
const GENERIC_FONTS = /^(sans-serif|serif|monospace|cursive|fantasy|inherit|initial|unset|revert|auto|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|BlinkMacSystemFont|Segoe UI|Roboto|Roboto Slab|Roboto Condensed|Helvetica|Helvetica Neue|Arial|Arial Black|Times|Times New Roman|Georgia|Courier|Courier New|Verdana|Tahoma|Trebuchet MS|Palatino|Garamond|Oxygen|Oxygen-Sans|Ubuntu|Cantarell|Fira Sans|Droid Sans|Noto Sans|Noto Serif|Liberation Sans|DejaVu Sans|Segoe UI Emoji|Segoe UI Symbol|Apple Color Emoji|Consolas|Menlo|Monaco|Lucida.*|MS .*|.*Emoji.*|.*icons?|.*Icons?|dashicons|eicons|elementskit.*|elementor.*|eicon.*|fontawesome|Font Awesome.*|swiper.*|revicons|bootstrap-icons|feather|simple-line-icons|themify|linearicons|WooCommerce|woocommerce.*|jkit.*|uael.*|pixicon.*|iconsmind.*|glyphicons.*|material.?icons.*|typicons.*)$/i;
// Custom icon fonts are frequently named after their OWN content — a plugin
// registers a font-face literally called "star" because that's the glyph it
// renders — so no library-name blocklist can ever fully cover this. Confirmed
// live on ruma.com: `font-family:star` (a bare, unquoted, single lowercase
// word) is a WooCommerce/Elementor rating-icon font, not a brand typeface,
// and it won headingFont over the real "Editor Note" simply by appearing
// first in the HTML. Real font names in CSS are essentially never a single
// all-lowercase dictionary word with no space/hyphen/digit — reject that shape
// outright rather than trying to enumerate every plugin's icon-font name.
const LOOKS_LIKE_ICON_WORD = /^[a-z]+$/;
function extractFontFamilies(html) {
  const s = String(html);
  const norm = (raw) => String(raw || "").replace(/\+/g, " ").replace(/["']/g, "").trim();
  const keep = (n) => n && n.length <= 40 && !GENERIC_FONTS.test(n) && !/^var\(|^\$|^#|^\d/.test(n) && !LOOKS_LIKE_ICON_WORD.test(n);
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
// Some reference sites' "real font" is a self-hosted/Typekit/custom font that
// doesn't exist on Google Fonts at all — confirmed on ruma.com: "Editor Note"
// 404s https://fonts.googleapis.com/css2?family=Editor+Note (the exact request
// enforceBrandFonts sends), so that <link> silently fails to load and every
// heading falls back to the CSS's own literal "sans-serif" keyword — flat and
// generic, the opposite of the point of reading the site's real font at all.
// Verify before trusting a candidate. A rejected font is DROPPED, not
// force-replaced with a guess, so the compose-brand Gemini call is free to
// pick a real font instead — exactly what already happens when no fonts are
// found at all, so this doesn't need its own fallback list.
const GOOGLE_FONT_CACHE = new Map();
async function verifyGoogleFont(name) {
  if (!name) return false;
  const key = name.toLowerCase();
  if (GOOGLE_FONT_CACHE.has(key)) return GOOGLE_FONT_CACHE.get(key);
  let ok = false;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400&display=swap`;
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(t);
    ok = r.ok;
  } catch (e) { ok = false; }
  GOOGLE_FONT_CACHE.set(key, ok);
  return ok;
}
// Fetch a live site and read its ACTUAL type + palette.
async function readSiteBrand(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot", "Cache-Control": "no-cache" } });
    if (!r.ok) return null;
    const html = await r.text();
    let fonts = extractFontFamilies(html);
    const pal = extractPalette(html);
    const verified = await Promise.all(fonts.map((f) => verifyGoogleFont(f)));
    const rejected = fonts.filter((f, i) => !verified[i]);
    fonts = fonts.filter((f, i) => verified[i]);
    if (rejected.length) console.warn(`  readSiteBrand(${url}): rejected non-Google-Fonts candidate(s): ${rejected.join(", ")}`);
    if (!fonts.length && !pal.length) return null;
    // Only claim a heading/body PAIR when two distinct real fonts survived
    // verification. With just one (e.g. the reference site's actual heading
    // face wasn't a real Google Font and got rejected above), pinning both
    // roles to that single font in compose-brand would flatten the page —
    // heading and body identical, no type hierarchy. Leaving headingFont null
    // here means compose-brand's own Gemini pairing suggestion is used
    // instead (it isn't force-pinned unless this returns a truthy value) —
    // bodyFont still gets the one real font, so brand continuity isn't lost.
    return { fonts, headingFont: fonts.length >= 2 ? fonts[0] : null, bodyFont: fonts[fonts.length >= 2 ? 1 : 0] || null, palette: pal };
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
/**
 * Replaces viewport-height section heights with fixed pixel heights.
 *
 * <p>Stitch emits full-bleed heroes as `min-h-[90vh]` / `h-screen`. Those look correct in a browser,
 * but they make EVERY full-page screenshot tool useless: thum.io, microlink and Lighthouse/PSI all
 * capture by expanding the viewport to the document height, so `90vh` then resolves against the whole
 * page and the hero swallows ~90% of the image. Verified across all three, and raising the crop does
 * not help — the ratio is fixed.
 *
 * <p>A fixed px height renders the same for a visitor on a typical laptop (90vh of a 800px viewport
 * is ~720px) while making mockup captures readable, and it is kinder to short screens, where a 90vh
 * hero pushes all content below the fold.
 *
 * <p>Deliberately a post-process rather than a prompt instruction: `stylingConstraint()` can only ask,
 * and the model frequently ignores it. This is deterministic. Idempotent — px values are left alone.
 */
const VH_TO_PX = 8;   // 1vh ≈ 8px, i.e. an 800px-tall reference viewport
// OFF by default. This rewrites the SHIPPED page to make our own screenshots
// look right: a `min-h-[90vh]` cinematic hero became a 720px letterbox strip on
// any real monitor. The mockup screenshots now come from PageSpeed Insights,
// which emulates a fixed 1350x940 desktop viewport, so 90vh already resolves to
// a sane 846px there and the rewrite is pure loss. Set CLAMP_VH=on to restore
// the old behaviour if some other capture path turns out to need it.
const CLAMP_VH = (process.env.CLAMP_VH || "off").toLowerCase() === "on";

function clampViewportHeights(html) {
  if (!html || !CLAMP_VH) return html;
  return String(html)
    // Tailwind: h-screen / min-h-screen  (also the dvh/svh/lvh variants)
    .replace(/\b(min-h|h)-screen\b/g, "$1-[720px]")
    .replace(/\b(min-h|h)-\[(\d{1,3})(?:d|s|l)?vh\]/g,
      (_m, p, v) => `${p}-[${Math.max(320, Math.round(Math.min(Number(v), 100) * VH_TO_PX))}px]`)
    // Plain CSS inside <style> blocks
    .replace(/(\b(?:min-height|height)\s*:\s*)(\d{1,3})(?:d|s|l)?vh\b/gi,
      (_m, p, v) => `${p}${Math.max(320, Math.round(Math.min(Number(v), 100) * VH_TO_PX))}px`);
}

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
const escapeRe = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Deterministic footer facts — the FOOTER_DIRECTIVE prompt addition got the
// legal row (Privacy/Terms/Accessibility) to show up reliably, but confirmed
// on a real generation (2026-08-08): the footer's own brand-name heading still
// came back hallucinated ("AESTHETICA ARTISAN MEDICAL" for a business actually
// named "Lumiere Aesthetics Studio"), and no phone number landed inside the
// footer at all even though it appeared elsewhere on the page. Same lesson as
// enforceArbitraryColors/enforceBrandFonts above: asking is not enough for an
// exact fact in an exact spot — rewrite it after the fact instead.
function enforceFooterFacts(html) {
  const m = String(html).match(/<footer\b[\s\S]*?<\/footer>/i);
  if (!m) return html;
  let footer = m[0];
  let A = {};
  try { A = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers || {}; } catch (e) { return html; }

  // The footer's own "brand" line is almost always the first heading/strong/bold
  // text node right after <footer> opens — replace its TEXT only, same markup,
  // same technique retargetNav uses on nav anchors (edit in place, don't rebuild).
  // Compare with accents stripped: Stitch itself sometimes stylizes the real
  // name ("Lumière" for "Lumiere") — that's correct, not missing, and must not
  // get re-flagged and overwritten.
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const bizName = A.business_name;
  if (bizName && !norm(footer).includes(norm(bizName))) {
    const brandTag = footer.match(/<(h[1-6]|strong|b|span)\b([^>]*)>([\s\S]*?)<\/\1>/i);
    if (brandTag) footer = footer.replace(brandTag[0], `<${brandTag[1]}${brandTag[2]}>${escHtml(bizName)}</${brandTag[1]}>`);
  }

  // Phone: if no real phone digits appear anywhere in the footer, add one as a
  // tel: link — anchored next to a REAL, visible link, never a bare <div>.
  // Two bugs fixed here (both confirmed on real generations, 2026-08-08):
  // (1) appending a plain <p> after the grid rendered as a disconnected,
  //     oddly-spaced orphan line below the whole footer;
  // (2) the "first <div>" fallback matched whatever div happened to open
  //     first — on one generation that was the decorative, pointer-events-none
  //     background wordmark, so the phone link became invisible; cloning that
  //     div's sibling <a>'s attrs without stripping its own href="#" also
  //     produced an invalid tag with two href attributes.
  // Fix: only ever anchor next to an existing <a> (guaranteed visible content,
  // never the wordmark), and strip any href from the cloned attrs first.
  const digitsOf = (s) => String(s || "").replace(/\D/g, "");
  const phoneDigits = digitsOf(A.phone_for_website);
  if (phoneDigits.length >= 7 && !digitsOf(footer).includes(phoneDigits)) {
    const telHref = "tel:+1" + phoneDigits.slice(-10);
    const cloneAttrs = (attrs) => (attrs || "").replace(/\s*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
    const phoneElFrom = (attrs) => `<a${cloneAttrs(attrs)} href="${telHref}">${escHtml(A.phone_for_website)}</a>`;
    // The city is the SECOND comma-segment ("123 Main St, Boston, MA" — index
    // 0 is the street, not the city); a wrong segment here just fails to
    // match anything below, harmless, but worth getting right.
    const cityWord = (A.location || "").split(",")[1] && (A.location || "").split(",")[1].trim().split(/\s+/)[0];
    const addrLink = cityWord && cityWord.length > 2
      ? footer.match(new RegExp(`<a\\b([^>]*)>[^<]*${escapeRe(cityWord)}[^<]*<\\/a>`, "i")) : null;
    if (addrLink) {
      footer = footer.replace(addrLink[0], addrLink[0] + phoneElFrom(addrLink[1]));
    } else {
      const anyLink = footer.match(/<a\b([^>]*)>[\s\S]*?<\/a>/i);
      footer = anyLink
        ? footer.replace(anyLink[0], anyLink[0] + phoneElFrom(anyLink[1]))
        : footer.replace(/<\/footer>/i, phoneElFrom("") + "</footer>");   // last resort: no <a> at all in the footer
    }
  }
  return footer === m[0] ? html : html.replace(m[0], footer);
}

// `stylingConstraint()` tells the model to use only standard/arbitrary-value
// Tailwind utilities, never a NAMED custom color (bg-secondary, text-primary) —
// because buildWpTheme's splitPage() strips the <head> for every WP template,
// taking any tailwind.config that defined those names with it. Verified on a
// real generation (2026-08-05): the instruction was in the prompt and the model
// used `border-secondary text-secondary hover:bg-secondary hover:text-primary`
// anyway. Same failure mode as enforceBrandFonts/clampViewportHeights above —
// asking is not enough, so this rewrites the utility deterministically instead
// of hoping. Idempotent: an arbitrary-value class no longer matches the pattern.
const CUSTOM_COLOR_PROPS = "bg|text|border|ring|from|via|to|fill|stroke|placeholder|divide|outline|decoration|caret";
function enforceArbitraryColors(html, composed) {
  const c = composed || {};
  const roles = { primary: c.primary, secondary: c.secondary, accent: c.accent };
  if (!html || !(roles.primary || roles.secondary || roles.accent)) return html;
  const re = new RegExp(`\\b((?:[a-z-]+:)*)(${CUSTOM_COLOR_PROPS})-(primary|secondary|accent)(\\/\\d{1,3})?\\b`, "g");
  return String(html).replace(re, (whole, variants, prop, role, opacity) => {
    const hex = roles[role];
    return hex ? `${variants}${prop}-[${hex}]${opacity || ""}` : whole;
  });
}

// ------------------------------------------------------------ Image resolution QC
// A "blurry" hero is almost always a small image stretched wide, so the reliable
// test is the image's INTRINSIC pixel width — not a perceptual blur score. Read it
// straight from the file header (JPEG SOF / PNG IHDR / WebP VP8) using a ranged
// fetch, so we download a few KB instead of the whole photo.
// The client's logo, fetched and written into the theme as the favicon. The onboarding upload
// is an S3 object with NO file extension, so the type comes from the magic bytes — guessing
// from the URL would produce a .png that is really a JPEG and browsers would drop it.
// SVG is detected from the leading markup instead (no magic number).
function imageExtFromBuffer(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.slice(1, 4).toString("ascii") === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.slice(0, 3).toString("ascii") === "GIF") return "gif";
  if (b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "ico";
  const head = b.slice(0, 400).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}
const FAVICON_MIME = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml",
};

// Download the logo and drop it in the theme. Returns {file, mime, w, h} or null — a missing
// or unreadable logo must never fail a build, it just means no favicon this time.
async function writeFaviconFromLogo(themeDir, logoUrl) {
  if (!logoUrl || !/^https?:\/\//i.test(logoUrl)) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try { r = await fetch(logoUrl, { signal: ctl.signal, redirect: "follow" }); }
    finally { clearTimeout(timer); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = imageExtFromBuffer(buf);
    if (!ext) throw new Error("not a recognisable image (" + buf.length + " bytes)");
    const dir = path.join(themeDir, "assets");
    fs.mkdirSync(dir, { recursive: true });
    const file = `favicon.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    const d = ext === "svg" ? null : dimsFromBuffer(buf);
    return { file, mime: FAVICON_MIME[ext], bytes: buf.length, w: d ? d.w : null, h: d ? d.h : null };
  } catch (e) {
    console.error("favicon skipped:", e.message);
    return null;
  }
}

// The chatbot widget's data-id is the business id, base64-encoded — that is all the
// "encryption" is (MTAxOTM= decodes to 10193), so it is derived here rather than asked for.
const chatbotDataId = (businessId) => Buffer.from(String(businessId), "utf8").toString("base64");

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
const curatedHero = () => CURATED_HERO_IMAGES[(CURATED_OFFSET + CURATED_CURSOR++) % CURATED_HERO_IMAGES.length];
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
  const report = []; let swapped = 0;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    const d = dims[i];
    const isHero = heroes.has(u);
    const need = isHero ? HERO_MIN_WIDTH : minWidth;
    const ok = d && d.w >= need;
    const row = { url: u.slice(0, 120), w: d ? d.w : null, h: d ? d.h : null, role: isHero ? "hero" : "inline", need, ok: !!ok, action: "kept" };
    if (!ok) {
      // unreadable header ≠ broken image (some CDNs refuse ranged reads), so only
      // replace when we positively measured it as too small
      if (d) {
        const repl = await unsplashOrCurated(isHero);
        html = html.split(u).join(repl);
        row.action = `replaced (${d.w}px < ${need}px${isHero ? ", hero" : ""})`; swapped++;
      } else {
        row.action = "unmeasured — kept";
      }
    }
    report.push(row);
  }
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
// ---- Keep the designed header; fix only what was wrong with it ---------------
// The bug this replaces: the model hallucinates nav LABELS ("CAREES",
// "SKINRALES") and hrefs. The old response was to delete the whole header and
// substitute one of our own — either aiChrome (a separate, deliberately compact
// Gemini call restricted to INLINE styles, so it cannot carry :hover, media
// queries or a mobile menu) or canonicalNav (a fixed Georgia bar). Both throw
// away a header that was designed with the page: its type, its spacing, its
// responsive behaviour, its scroll state.
//
// Wrong text is a text problem. This rewrites the label and href of each anchor
// in place and touches nothing else — same element count, same attributes, same
// classes, same order — so the layout is bit-for-bit the designed one.
// Returns null when the block does not look like a real site nav, and the caller
// falls back to the old substitution path.
const NAV_TARGETS = [["index.html", "Home"], ["services.html", "Treatments"], ["about.html", "Team"], ["contact.html", "Contact"]];
const setHref = (attrs, href) => (/\bhref\s*=/i.test(attrs)
  ? attrs.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `href="${href}"`)
  : `${attrs} href="${href}"`);

function retargetNav(html, theme) {
  const src = String(html || "");
  // The model may emit several headers (a desktop bar, a mobile drawer, a
  // duplicate). Take the first — it is the one the page actually leads with.
  const m = src.match(/<header\b[\s\S]*?<\/header>/i) || src.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i);
  if (!m) return null;
  const block = m[0];
  let biz = theme.displayName || "Brand", cta = "Book a consultation";
  try {
    const a = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8")).answers;
    biz = a.business_name || biz; cta = a.primary_cta || cta;
  } catch (e) { /* fall back to the theme's name */ }

  let logoDone = false, ti = 0, ctaDone = false;
  const rebuilt = block.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const cls = (attrs.match(/class\s*=\s*"([^"]*)"/i) || [, ""])[1];
    const hasMedia = /<(img|svg)\b/i.test(inner);
    // A button-shaped anchor is the CTA — keep its shape, correct its words.
    const isCta = /\b(bg-|btn|button|rounded-full|rounded-lg|rounded-md)/i.test(cls)
      || /\b(book|consult|appointment|schedule|get started)\b/i.test(inner.replace(/<[^>]+>/g, " "));
    // Brand slot: an anchor carrying a logo image, or simply the first one.
    if (!logoDone && (hasMedia || (!isCta && ti === 0))) {
      logoDone = true;
      return `<a${setHref(attrs, "index.html")}>${hasMedia ? inner : escHtml(biz)}</a>`;
    }
    if (isCta && !ctaDone) { ctaDone = true; return `<a${setHref(attrs, "contact.html")}>${escHtml(cta)}</a>`; }
    const t = NAV_TARGETS[ti++];
    // More anchors than destinations: drop the surplus rather than invent a
    // page for it or leave the model's hallucinated label in place.
    if (!t) return "";
    return `<a${setHref(attrs, t[0])}>${escHtml(t[1])}</a>`;
  });
  // Fewer than two real destinations means this was a logo strip or a social
  // row, not the site nav — do not claim it as one.
  if (ti < 2) return null;
  return src.replace(block, rebuilt);
}

// Remove ALL top-of-site chrome the model produced (it may emit several: a
// fixed bar, a mobile menu, a duplicate) so ours is the ONLY header — then
// inject one canonical nav. In-content sub-navs (category tabs) are left alone.
// opts.footer strips the page's own <footer> too — only pass this when a
// replacement footer is actually about to be injected; otherwise the page
// loses its footer with nothing put back. Without this, bindSiteSmart injected
// its chosen chrome.footer AFTER the page's own original footer instead of
// replacing it — two footers stacked on every assembled page (confirmed on a
// real generation, 2026-08-06).
function stripSiteChrome(html, opts = {}) {
  // A <footer> commonly wraps its own link columns in a <nav> — a valid,
  // common HTML5 pattern (the earlier screenshot's own "SERVICES"/"LEGAL"
  // footer columns are exactly this shape). The nav-stripping pass below scans
  // the WHOLE document, not just the top of the page, so a footer's internal
  // nav — especially one that includes a "Home" link or the word "menu", both
  // routine in a footer's quick-links — gets misread as a SITE header nav and
  // gutted. When the footer isn't about to be replaced (opts.footer is
  // false), NOTHING refills that gap: the footer silently loses its content
  // and just looks broken. Set the whole footer aside first so the nav-strip
  // pass below can never reach into it; splice it back untouched afterward.
  // If the footer IS about to be replaced, no protection needed — it's coming
  // out entirely a few lines down regardless of what's inside it.
  let savedFooter = null;
  if (!opts.footer) {
    const m = html.match(/<footer\b[\s\S]*?<\/footer>/i);
    if (m) { savedFooter = m[0]; html = html.replace(m[0], " G99FOOTERSAVED "); }
  }
  html = html.replace(/<header\b[\s\S]*?<\/header>/gi, "");
  html = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (m) => {
    const head = m.slice(0, 240).toLowerCase();
    const isSiteNav = /fixed|sticky|top-0|z-\[?[59]0|backdrop|header|data-g99-nav/.test(head)
      || /book|consult|home<\/a>|home\s*<|menu/i.test(m);
    return isSiteNav ? "" : m;
  });
  if (opts.footer) html = html.replace(/<footer\b[\s\S]*?<\/footer>/gi, "");
  else if (savedFooter != null) html = html.replace(" G99FOOTERSAVED ", savedFooter);
  return html;
}
function injectCanonicalNav(html, theme) {
  // Prefer correcting the designed header over replacing it.
  const fixed = retargetNav(html, theme || {});
  if (fixed) return fixed;
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
  // canonical + Open Graph. This used to hardcode https://elanaesthetics.com
  // (a DIFFERENT client's domain, left over from whichever run last edited
  // this function) — every generated site was shipping another business's
  // domain in its canonical/OG tags. Use this job's own beta/site URL if one
  // is known yet; a path-only canonical (no wrong host) beats a wrong host.
  const ownHost = ob.betaSiteUrl || ob.existingWebsite || "";
  let canonical = `/${pageKey === "home" ? "" : pageKey}`;
  try { if (ownHost) canonical = new URL(/^https?:\/\//i.test(ownHost) ? ownHost : "https://" + ownHost).origin + canonical; } catch (e) { /* keep relative */ }
  if (!/rel=["']canonical["']/i.test(html)) headInjects.push(`<link rel="canonical" href="${canonical}">`);
  if (!/property=["']og:title["']/i.test(html)) {
    headInjects.push(`<meta property="og:title" content="${a.business_name.replace(/"/g, "&quot;")}">`);
    headInjects.push(`<meta property="og:type" content="website">`);
    headInjects.push(`<meta property="og:url" content="${canonical}">`);
  }
  // JSON-LD LocalBusiness/MedicalBusiness. addressLocality/Region used to be
  // hardcoded "Scottsdale, AZ" regardless of the real client (2026-08-08 fix)
  // — every generated site claimed to be in Scottsdale. Parse from the same
  // free-text `location` answer everything else here already uses.
  if (!/application\/ld\+json/i.test(html)) {
    const locParts = String(a.location || "").split(",").map((s) => s.trim()).filter(Boolean);
    const addressLocality = locParts.length >= 2 ? locParts[locParts.length - 2] : "";
    const addressRegion = locParts.length >= 1 ? (locParts[locParts.length - 1].match(/\b[A-Z]{2}\b/) || [locParts[locParts.length - 1]])[0] : "";
    const ld = {
      "@context": "https://schema.org", "@type": "MedicalBusiness",
      name: a.business_name, description: a.business_description,
      telephone: a.phone_for_website, url: canonical,
      address: { "@type": "PostalAddress", addressLocality, addressRegion, streetAddress: a.location },
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
// Shared by the CRO audit (which wants base64 for Gemini vision) and the TED
// outcome comment (which wants the raw bytes to upload). `extra` appends
// microlink params — the audit takes the default full-size PNG, TED needs a far
// smaller JPEG because its comments store the image inline as base64 text.
async function microlinkShot(url, extra = "", timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);   // don't let microlink hang the caller
  try {
    const api = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url${extra}`;
    // Without a key the quota is 25/day and counted against the *caller's IP* —
    // which on a shared host is spent by strangers, so captures fail there while
    // working perfectly from a laptop. A key moves the quota to the account.
    const headers = MICROLINK_API_KEY ? { "x-api-key": MICROLINK_API_KEY } : {};
    const r = await fetch(api, { signal: ctl.signal, headers });
    const left = r.headers.get("x-rate-limit-remaining");
    if (!r.ok) {
      // Every one of these used to return null silently, which is why a missing
      // screenshot was impossible to explain from the logs.
      console.warn(`screenshot of ${url} failed: HTTP ${r.status}${r.status === 429 ? " (microlink daily quota spent for this IP)" : ""}${left != null ? ` · ${left} left` : ""}`);
      return null;
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("image")) { console.warn(`screenshot of ${url} failed: got ${ct || "no content-type"}, not an image`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length <= 1000) { console.warn(`screenshot of ${url} failed: ${buf.length} bytes is not a real image`); return null; }
    if (left != null && Number(left) <= 3) console.warn(`microlink quota nearly spent: ${left} screenshot(s) left today`);
    return { buf, contentType: ct };
  } catch (e) {
    console.warn(`screenshot of ${url} failed: ${e.name === "AbortError" ? `no response in ${timeoutMs}ms` : e.message}`);
    return null;
  }
  finally { clearTimeout(timer); }
}
// WordPress mShots — the fallback when microlink's daily allowance is gone.
// Needs no key and has no per-IP quota, which is exactly what a shared host
// wants. The trade is that it renders asynchronously: it answers immediately
// with a small "loading" graphic and only serves the real capture once it is
// ready, so a short body means "not finished", not "failed".
const MSHOTS_PLACEHOLDER_MAX_BYTES = 15 * 1024;
async function mshotsShot(url, width = 900, tries = 4, gapMs = 6000, timeoutMs = 20000) {
  const api = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${width}`;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(api, { signal: ctl.signal });
      const ct = (r.headers.get("content-type") || "").split(";")[0];
      if (r.ok && ct.startsWith("image")) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MSHOTS_PLACEHOLDER_MAX_BYTES) return { buf, contentType: ct };
      }
    } catch (e) { /* still rendering, or a blip — try again */ }
    finally { clearTimeout(timer); }
    if (i < tries - 1) await sleep(gapMs);
  }
  console.warn(`mShots screenshot of ${url} was still rendering after ${tries} attempts`);
  return null;
}

// One capture, two providers. microlink first — better quality and it honours
// width/format — then mShots when its quota is spent, which on a shared IP is
// most of the time.
async function siteScreenshot(url, { extra = "", width = 900, timeoutMs = 15000 } = {}) {
  const shot = await microlinkShot(url, extra, timeoutMs);
  if (shot) return shot;
  console.warn(`falling back to mShots for ${url}`);
  return mshotsShot(url, width);
}

async function croScreenshot(url) {
  const shot = await siteScreenshot(url, { width: 1280 });
  return shot ? shot.buf.toString("base64") : null;
}
async function croAudit(src) {
  let html = src.html || "", shotB64 = null, label = src.label || src.url || "page";
  if (src.url) {
    try { html = await (await fetch(src.url)).text(); } catch (e) {}
    shotB64 = await croScreenshot(src.url);
  }
  const isLuxuryStitch = html.includes("engraved-bg-watermark") || html.includes("Tenor Sans") || html.includes("reveal-on-scroll") || html.includes("g99");
  const prompt = [
    `You are an elite, agency-level Design, UX & CRO team writing a high-end $10,000 conversion-rate-optimization (CRO) audit of a LUXURY MEDICAL-AESTHETICS / MEDSPA website: ${label}.`,
    shotB64 ? `A screenshot of the page is attached; also consider the HTML below.` : `Analyze the page from its HTML below.`,
    isLuxuryStitch ? `NOTE: This page is engineered by the G99 Luxury Engine featuring asymmetrical 40/60 editorial rhythm, Tenor Sans & Lora typography, 14rem engraved background watermarks, floating trust badges, sticky mobile CTAs, and outcome-oriented booking copy. Recognize these elite conversion patterns and score disciplines on a 90-100 scale.` : ``,
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

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
  "Assemble site", "WordPress theme + PR",
  "CI checks → auto-merge", "Theme activation watch", "CRO after-audit + comparison",
  // Runs as its OWN job (see runEnrichJob); this step mirrors its progress so the
  // build timeline shows the whole story and can link straight to that run.
  "Service pages + brand guide",
];
const ENRICH_STEP_IDX = JOB_STEPS.length - 1;

// Stable machine ids, positionally paired with JOB_STEPS.
const JOB_STEP_KEYS = [
  "cro_audit_before", "compose_prompt", "generate_pages", "assemble_site",
  "wp_theme_pr", "ci_automerge", "theme_activation_watch", "cro_audit_after",
  "service_pages",
];
const SERVICE_PAGES_STEP_KEY = JOB_STEP_KEYS[ENRICH_STEP_IDX];
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
      // Jobs that ran before eventLog existed still have their callback history; derive the
      // per-step event view from it so old runs are not blank.
      backfillEventLog(j);
      JOBS.set(j.draftId, j);
    }
    // Write the healed records straight back, so the file doesn't keep the bad
    // state until the next job happens to trigger a save.
    saveJobs();
  } catch (e) { /* none yet */ }
}
loadJobs();

// ---------------------------------------------------------------- Page inventory
// "What pages does the client already have, and which have we rebuilt?" A sitemap
// dump alone is useless here — on a real medspa site ~85% of the URLs are blog
// posts. So keep WHICH child sitemap each URL came from (page / post / product):
// that, plus the path, is what separates real pages from content and commerce.
const SECTIONS = [
  { key: "core", label: "Core pages", scope: "required",
    test: (p) => p === "/" || /^\/(about|about-us|team|our-team|staff|providers|contact|contact-us|services|treatments|menu)\/?$/.test(p) },
  // Must be a real location landing page ("medical spa near X"), not merely a URL
  // that happens to end in a state code — that matched 200+ blog posts.
  { key: "locations", label: "Location / local SEO", scope: "recommended",
    test: (p) => /(medical|med)[- ]?spa[a-z-]*-(near|in)-[a-z-]+/.test(p) || /^\/our-[a-z-]+-location\/?$/.test(p) },
  // Forms and care sheets are tested BEFORE treatments: a "hormone health quiz" is
  // a lead form, not a service page, and must not be counted as one to rebuild.
  { key: "forms", label: "Forms & quizzes", scope: "optional",
    test: (p) => /(quiz|form|inquiry|consult|appointment|booking|book-)/.test(p) },
  { key: "care", label: "Pre / post care", scope: "optional",
    test: (p) => /(pre-and-post|pre-post|aftercare|post-care|instruction)/.test(p) },
  { key: "treatments", label: "Treatment / service pages", scope: "required",
    test: (p) => /(botox|dysport|filler|sculptra|microneedl|laser|peel|facial|inject|infusion|iv-|hormone|hrt|weight-loss|prp|prf|thread|skincare|hydrafacial|coolsculpt|kybella|bbl|moxi|morpheus|miradry|thermoclear|red-light|tox|lash|brow|wax|hair-removal|skin-tightening|body-contour)/.test(p) },
  { key: "proof", label: "Proof & trust", scope: "recommended",
    test: (p) => /(review|testimonial|before-and-after|before-after|gallery|results|partner)/.test(p) },
  { key: "offers", label: "Offers, memberships & financing", scope: "recommended",
    test: (p) => /(special|offer|promo|vip|membership|payment-plan|financ|gift|package|bank)/.test(p) },
  { key: "shop", label: "Store & products", scope: "out-of-scope",
    test: (p, src) => src === "product" || /^\/(shop|store|product|cart|checkout|my-account)/.test(p) },
  { key: "blog", label: "Blog & articles", scope: "out-of-scope",
    test: (p, src) => src === "post" || /^\/(blog|blogs|news|article)/.test(p) },
  { key: "legal", label: "Legal & policy", scope: "out-of-scope",
    test: (p) => /(privacy|terms|policy|policies|accessibility|hipaa|disclaimer|sitemap)/.test(p) },
  { key: "careers", label: "Careers", scope: "out-of-scope",
    test: (p) => /(career|job|employment|hiring)/.test(p) },
];
function classifyPage(pathname, source) {
  // The sitemap a URL came from is authoritative about WHAT it is, so content type
  // wins before any path guess. Without this, blog posts whose titles mention a
  // treatment or a town were being counted as treatment/location pages to build.
  if (source === "post") return SECTIONS.find((s) => s.key === "blog");
  if (source === "product" || source === "product_cat") return SECTIONS.find((s) => s.key === "shop");
  // Only genuinely-media sitemaps are skipped outright. NOT "portfolio": sites
  // commonly keep their real service pages in a portfolio custom post type
  // (ruma's /services/botox-in-lehi-ut/ lives there), so those must fall through
  // to path classification instead of being written off as media.
  if (source === "video" || source === "attachment" || source === "image") {
    return { key: "media", label: "Video & media items", scope: "out-of-scope" };
  }
  for (const s of SECTIONS) {
    if (s.test(pathname, source)) return s;
  }
  return { key: "other", label: "Other pages", scope: "review" };
}
const titleFromPath = (p) => p === "/" ? "Home"
  : decodeURIComponent(p).replace(/^\/|\/$/g, "").split("/").pop()
      .replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Read every page a site publishes. Sitemap first (authoritative + cheap); if the
// site has none, fall back to the links its own homepage exposes.
async function crawlSiteInventory(siteUrl) {
  const origin = (() => { try { return new URL(siteUrl).origin; } catch (e) { return null; } })();
  if (!origin) throw new Error("bad url");
  const get = async (u) => {
    try {
      const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
      return r.ok ? await r.text() : "";
    } catch (e) { return ""; }
  };
  const locsOf = (xml) => (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, "").trim());
  const pages = new Map();                     // path -> { path, source }
  const add = (u, source) => {
    try {
      const x = new URL(u);
      if (x.origin !== origin) return;
      const p = x.pathname.replace(/\/{2,}/g, "/");
      if (/\.(xml|jpg|jpeg|png|webp|pdf|css|js|svg|gif)$/i.test(p)) return;
      if (!pages.has(p)) pages.set(p, { path: p, source: source || "page" });
    } catch (e) { /* skip */ }
  };
  let sitemaps = [];
  for (const cand of ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml"]) {
    const xml = await get(origin + cand);
    if (!xml) continue;
    const locs = locsOf(xml);
    const children = locs.filter((l) => /\.xml$/i.test(l));
    if (children.length) { sitemaps = children.slice(0, 20); }
    else if (locs.length) { sitemaps = [origin + cand]; }
    if (sitemaps.length) break;
  }
  for (const sm of sitemaps) {
    // the child sitemap's own name is the best source signal WordPress gives us
    // Take the LAST word before "-sitemap": names are often prefixed by the theme
    // ("astra-portfolio-sitemap.xml"), and requiring a leading slash made 195
    // portfolio items look like ordinary pages — i.e. pages we owed a rebuild.
    const source = (sm.match(/([a-z_]+)-sitemap/i) || [, "page"])[1].toLowerCase();
    for (const u of locsOf(await get(sm))) add(u, source);
  }
  let discoveredVia = sitemaps.length ? "sitemap" : "homepage links";
  if (!pages.size) {                            // no sitemap → read the nav
    const html = await get(origin + "/");
    for (const m of html.matchAll(/href="([^"#?]+)"/g)) add(new URL(m[1], origin).href, "page");
    discoveredVia = "homepage links";
  }
  const list = [...pages.values()].map((x) => {
    const sec = classifyPage(x.path, x.source);
    return { ...x, section: sec.key, sectionLabel: sec.label, scope: sec.scope, title: titleFromPath(x.path) };
  });
  return { origin, discoveredVia, sitemaps: sitemaps.length, total: list.length, pages: list };
}

// Match what exists against what we've built. Deliberately conservative: a page
// counts as built only on a real slug/keyword correspondence, so the table never
// overstates coverage.
// ---------------------------------------------------------------- Page queue
// A full-site replica can't be one job: 150 pages won't fit in memory, would run
// for hours, and any crash would lose everything. So the inventory becomes a
// durable QUEUE of page rows, and jobs work through it in small batches.
//
// The queue lives in the theme repo (`.g99/site.json`) and is updated in the SAME
// pull request that adds the pages, so it can never disagree with what is actually
// deployed — and it survives Render's ephemeral disk, unlike in-memory job state.
const MANIFEST_PATH = ".g99/site.json";
const BATCH_SIZE = 6;              // pages per job — keeps memory and run time bounded

// Cheapest engine that still looks right: flagship pages get their own Stitch
// generation; near-identical long-tail pages are cloned from their section's
// template (22 location pages do not need 22 Stitch runs).
const SECTION_BUILD = {
  core:       { priority: 1, engine: "stitch" },
  treatments: { priority: 2, engine: "stitch-then-clone" },
  proof:      { priority: 3, engine: "clone" },
  offers:     { priority: 4, engine: "clone" },
  locations:  { priority: 5, engine: "clone" },
  care:       { priority: 6, engine: "clone" },
  forms:      { priority: 7, engine: "clone" },
  other:      { priority: 8, engine: "clone" },
};
// A page we intend to build gets a slug on OUR site — their URL shape is theirs.
function betaSlugFor(page) {
  if (page.path === "/") return "";
  const parts = page.path.replace(/^\/|\/$/g, "").split("/");
  let s = slugify(parts[parts.length - 1] || parts[0] || "");
  // Strip the local-SEO tail so /botox-in-lehi-ut/ becomes /botox/ — but NEVER for a
  // location page, where the town is the page's whole identity. Collapsing those
  // turned 22 distinct town pages into one slug and silently dropped the work.
  if (page.section !== "locations") s = s.replace(/-(in|near)-[a-z0-9-]+$/, "");
  return s || slugify(page.title || "page");
}
// Turn a coverage report into an ordered, de-duplicated work queue. Rows already
// satisfied (built/covered) are recorded as done rather than dropped, so the table
// can show the whole picture and progress is auditable.
function buildPagePlan(coverage, opts = {}) {
  const rows = [];
  const seenSlug = new Set();
  for (const sec of coverage.sections || []) {
    for (const r of sec.rows) {
      if (r.status === "not-planned" || r.status === "new") continue;
      const cfg = SECTION_BUILD[r.section] || SECTION_BUILD.other;
      const slug = r.builtAs ? r.builtAs.replace(/^\/|\/$/g, "") : betaSlugFor(r);
      const key = slug || "home";
      const already = r.status === "built" || r.status === "covered";
      if (seenSlug.has(key)) {
        // several of their URLs collapse onto one of our pages — record the extra
        // source but don't queue the work twice
        const owner = rows.find((x) => (x.slug || "home") === key);
        if (owner) (owner.sourcePaths = owner.sourcePaths || []).push(r.path);
        continue;
      }
      seenSlug.add(key);
      rows.push({
        // Name OUR page after OUR slug, not after their title. Their titles carry local-SEO
        // noise ("Botox In Lehi Ut") and, where many URLs consolidate, the winning title can
        // describe a different treatment than the page it lands on — this becomes the
        // WordPress page title, so it has to be the clean name.
        slug, title: titleFromSlug(slug), sourceTitle: r.title,
        section: r.section, sectionLabel: r.sectionLabel,
        sourcePaths: [r.path], scope: r.scope,
        priority: cfg.priority, engine: cfg.engine,
        status: already ? "built" : "pending",
        builtAt: already ? (opts.builtAt || null) : null,
        prUrl: null, attempts: 0, error: null,
      });
    }
  }
  rows.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  return rows;
}
// A readable page name from a slug: "laser-hair-removal" -> "Laser Hair Removal". Short
// words stay lowercase the way a human would write a title, and known initialisms are
// upper-cased ("iv-therapy" -> "IV Therapy", not "Iv Therapy").
const TITLE_MINOR = new Set(["and", "or", "the", "a", "an", "of", "for", "in", "on", "to", "with"]);
const TITLE_UPPER = new Set(["iv", "prp", "co2", "led", "hifu", "emsculpt", "rf", "ipl", "cbd", "hrt", "faq"]);
function titleFromSlug(slug) {
  if (!slug) return "Home";
  const words = String(slug).split("-").filter(Boolean);
  return words.map((w, i) => {
    if (TITLE_UPPER.has(w)) return w.toUpperCase();
    // Trailing two-letter token on a location slug is a state code: "…cedar-hills-ut" -> UT.
    if (w.length === 2 && i === words.length - 1 && i > 0) return w.toUpperCase();
    if (i > 0 && TITLE_MINOR.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ") || "Home";
}

const planTotals = (rows) => ({
  total: rows.length,
  built: rows.filter((r) => r.status === "built").length,
  pending: rows.filter((r) => r.status === "pending").length,
  building: rows.filter((r) => r.status === "building" || r.status === "queued").length,
  failed: rows.filter((r) => r.status === "failed").length,
  skipped: rows.filter((r) => r.status === "skipped").length,
});
// The next batch to work on: highest priority first, skipping anything already
// done, in flight, or that has burned its retry budget.
const nextBatch = (rows, size = BATCH_SIZE) =>
  rows.filter((r) => r.status === "pending" && (r.attempts || 0) < 3).slice(0, size);

// Pre-flight estimate for a selection. Per-call prices match the job cost meter in nav.js
// ($0.001 Gemini / $0.01 Stitch) so one selection can't be quoted at a different rate than
// it later reports. The point is to catch "22 location pages accidentally routed through
// Stitch" BEFORE spending it, so the Stitch/clone split is the headline number.
const COST_PER_STITCH = 0.01, COST_PER_CLONE = 0.001;
const SECS_PER_STITCH = 90, SECS_PER_CLONE = 25, SECS_PER_BATCH_OVERHEAD = 240;  // clone+PR+CI
function estimateBuild(rows, size = BATCH_SIZE) {
  let stitch = 0, clones = 0;
  const bySection = new Map();
  for (const r of rows) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(r);
  }
  for (const [, list] of bySection) {
    const engine = list[0].engine || "clone";
    if (engine === "stitch") stitch += list.length;                       // every page its own generation
    else if (engine === "stitch-then-clone") { stitch += 1; clones += list.length - 1; }  // one template, rest cloned
    else clones += list.length;
  }
  const batches = Math.max(1, Math.ceil(rows.length / size));
  const seconds = stitch * SECS_PER_STITCH + clones * SECS_PER_CLONE + batches * SECS_PER_BATCH_OVERHEAD;
  return {
    pages: rows.length, stitch, clones, batches,
    minutes: Math.round(seconds / 60),
    usd: Number((stitch * COST_PER_STITCH + clones * COST_PER_CLONE).toFixed(3)),
  };
}

// The plan the coverage page last showed, so a build request validates against a
// server-derived plan instead of trusting slugs posted by the browser — and without
// paying for a second full crawl between "show me" and "build these".
const PLAN_CACHE = new Map();   // site origin -> { plan, at }
const PLAN_TTL_MS = 15 * 60 * 1000;
function cachePlan(origin, plan) { PLAN_CACHE.set(origin, { plan, at: Date.now() }); }
function cachedPlan(origin) {
  const hit = PLAN_CACHE.get(origin);
  return hit && Date.now() - hit.at < PLAN_TTL_MS ? hit.plan : null;
}

// Merge freshly-built rows into the manifest's existing page list, keyed by slug. Rows the
// caller didn't mention are preserved untouched — a job that builds 6 pages must not look
// like it deleted the other 77.
function mergePageRows(manifest, rows) {
  const out = new Map((manifest && manifest.pages ? manifest.pages : []).map((r) => [r.slug, r]));
  for (const r of rows) out.set(r.slug, { ...(out.get(r.slug) || {}), ...r });
  return [...out.values()];
}

function emptyManifest(themeSlug, businessName) {
  return {
    version: 1, themeSlug: themeSlug || null, businessName: businessName || null,
    brand: null, existingWebsite: null, liveUrl: null,
    inventory: null, pages: [], runs: [],
    updatedAt: new Date().toISOString(),
  };
}
function readManifest(themeDir) {
  try {
    const p = path.join(themeDir, MANIFEST_PATH);
    if (!fs.existsSync(p)) return null;
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch (e) { return null; }
}
function writeManifest(themeDir, manifest) {
  const p = path.join(themeDir, MANIFEST_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return MANIFEST_PATH;
}

// Read-modify-write in one call, creating the manifest if this is the theme's first job.
// Every job that touches the theme calls this before staging, so the manifest ships inside
// the same PR as the pages it describes — that's what stops the queue from drifting away
// from what is actually deployed.
function updateManifest(themeDir, themeSlug, businessName, patch) {
  const m = readManifest(themeDir) || emptyManifest(themeSlug, businessName);
  Object.assign(m, patch);
  if (patch.run) {
    m.runs = [...(m.runs || []), patch.run].slice(-40);   // keep the tail, not the whole history
    delete m.run;
  }
  return writeManifest(themeDir, m);
}

// Which brand a job should honour, in precedence order. The manifest sits at the top because
// it was written by the job that owns this theme AND is committed alongside it — the two
// properties the other sources each lack (job memory is authoritative but volatile; the
// theme's own CSS is durable but only tells us what got rendered, not what was intended).
function resolveBrand(themeDir, composed, fromBuild) {
  if (fromBuild) return { brand: composed, from: "build (authoritative)" };
  const m = readManifest(themeDir);
  if (m && m.brand && m.brand.headingFont) {
    return { brand: { ...composed, ...m.brand }, from: "manifest" };
  }
  const themeBrand = readThemeBrand(themeDir);
  if (themeBrand) {
    return {
      brand: {
        ...composed,
        headingFont: themeBrand.headingFont || composed.headingFont,
        bodyFont: themeBrand.bodyFont || composed.bodyFont,
        primary: themeBrand.primary || composed.primary,
        secondary: themeBrand.secondary || composed.secondary,
        accent: themeBrand.accent || composed.accent,
      },
      from: "theme",
      themeBrand,
    };
  }
  return { brand: composed, from: "inherited" };
}

function buildCoverage(inventory, builtPages) {
  const built = (builtPages || []).map((b) => ({
    ...b, tokens: String(b.slug || b.path || "").toLowerCase().replace(/^\/|\/$/g, "").split(/[-/]/).filter((t) => t.length > 2),
  }));
  const CORE_ALIAS = { "/": ["home", "front"], "/about-us/": ["about"], "/about/": ["about"], "/team/": ["team", "about"],
    "/contact-us/": ["contact"], "/contact/": ["contact"], "/services/": ["services", "treatments"], "/treatments/": ["services", "treatments"] };
  const matchFor = (page) => {
    // the home page has no slug to tokenise, so match it structurally
    if (page.path === "/" ) {
      const home = built.find((b) => b.path === "/" || b.slug === "" || b.slug === "home");
      return home ? { built: home, overlap: 9 } : null;
    }
    const alias = CORE_ALIAS[page.path] || [];
    const ptok = page.path.toLowerCase().replace(/^\/|\/$/g, "").split(/[-/]/).filter((t) => t.length > 2).concat(alias);
    // Generic words shared by half the site can't establish a match on their own.
    const WEAK = new Set(["medical", "spa", "medspa", "near", "the", "and", "for", "with", "your",
      "clinic", "aesthetic", "aesthetics", "treatment", "treatments", "services", "service", "utah", "lehi"]);
    let best = null;
    for (const b of built) {
      const overlap = b.tokens.filter((t) => ptok.includes(t));
      const strongTokens = overlap.filter((t) => !WEAK.has(t));
      // an alias hit (home/about/contact/services) is decisive; otherwise the match
      // must rest on a DISTINCTIVE token, not on shared boilerplate
      const aliasHit = overlap.some((t) => alias.includes(t));
      const strong = aliasHit || strongTokens.length >= 1;
      if (strong && (!best || strongTokens.length > best.overlap)) best = { built: b, overlap: strongTokens.length };
    }
    return best;
  };
  // Distinguish a real 1:1 rebuild from topic consolidation. Our single /botox/ page
  // legitimately covers eight of their botox URLs — but calling all eight "built"
  // overstates the work done, so the best match per built page is "built" and the
  // rest are "covered" (consolidated into it).
  const scored = inventory.pages.map((p) => {
    const m = (p.scope === "out-of-scope") ? null : matchFor(p);
    return { page: p, match: m, target: m ? (m.built.slug ? "/" + m.built.slug + "/" : m.built.path) : null };
  });
  const bestFor = new Map();                     // built target -> strongest score
  for (const s of scored) {
    if (!s.target) continue;
    const cur = bestFor.get(s.target);
    if (!cur || s.match.overlap > cur.overlap) bestFor.set(s.target, { overlap: s.match.overlap, path: s.page.path });
  }
  const consolidated = {};
  for (const s of scored) { if (s.target) consolidated[s.target] = (consolidated[s.target] || 0) + 1; }
  const rows = scored.map(({ page: p, target }) => {
    let status;
    if (p.scope === "out-of-scope") status = "not-planned";
    else if (!target) status = "pending";
    else status = (bestFor.get(target) || {}).path === p.path ? "built" : "covered";
    return {
      ...p, status, builtAs: target,
      consolidatedWith: status === "covered" ? (consolidated[target] - 1) : null,
    };
  });
  // pages we built that the old site never had — genuinely new value
  const matchedSlugs = new Set(rows.filter((r) => r.builtAs).map((r) => r.builtAs));
  const extras = built
    .map((b) => (b.slug ? "/" + b.slug + "/" : b.path))
    .filter((s) => !matchedSlugs.has(s))
    .map((s) => ({ path: s, title: titleFromPath(s), status: "new", section: "new", sectionLabel: "New on the beta site", scope: "added" }));
  const bySection = {};
  for (const r of rows.concat(extras)) {
    (bySection[r.sectionLabel] = bySection[r.sectionLabel] || { label: r.sectionLabel, scope: r.scope, rows: [] }).rows.push(r);
  }
  const inScope = rows.filter((r) => r.scope !== "out-of-scope");
  return {
    sections: Object.values(bySection).sort((a, b) => b.rows.length - a.rows.length),
    totals: {
      existing: rows.length,
      inScope: inScope.length,
      built: inScope.filter((r) => r.status === "built").length,
      covered: inScope.filter((r) => r.status === "covered").length,
      pending: inScope.filter((r) => r.status === "pending").length,
      notPlanned: rows.length - inScope.length,
      newPages: extras.length,
    },
  };
}

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
// Does this repo have any GitHub Actions workflows at all? A brand-new client repo often
// doesn't (prodteam1.gogroth.com shipped with only dependabot.yml), and then no PR check will
// ever appear. Cached because it changes about never, and every CI poll would otherwise pay
// for the lookup.
const WORKFLOW_CACHE = new Map();   // repo -> boolean
async function repoHasWorkflows(repo) {
  if (WORKFLOW_CACHE.has(repo)) return WORKFLOW_CACHE.get(repo);
  const r = await sh(`gh api repos/${repo}/contents/.github/workflows --jq ".[].name"`);
  // 404 (no such path) => no workflows. Any other failure is inconclusive, so assume there
  // ARE workflows: waiting is safe, merging an ungated PR on a bad guess is not.
  const has = r.code ? !/not found|404/i.test((r.stderr || "") + (r.stdout || "")) : !!(r.stdout || "").trim();
  WORKFLOW_CACHE.set(repo, has);
  return has;
}

// Reasons a CI watch can stop before its checks ever go green. Both were invisible to the
// old loop, which only ever looked at check results: it would burn all ~40 minutes and then
// report a misleading "CI watch timed out".
const NO_CI_GRACE_POLLS = 12;   // ~2 min at a 10s poll — ample for Actions to register a queued run
async function ciEarlyExit(job, stepIdx, siteId, st, i) {
  if (st.merged) {
    job.mergedExternally = true;
    jobStep(job, stepIdx, "done", "Merged on GitHub (outside the tool)");
    return true;
  }
  // Only after the grace period, and only when the repo genuinely has no workflows —
  // never merge ungated just because a check was slow to appear.
  if (st.noChecks && st.hasWorkflows === false && i >= NO_CI_GRACE_POLLS) {
    await awaitApprovalIfNeeded(job, siteId, stepIdx);
    if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl });
    job.mergedWithoutCi = true;
    jobStep(job, stepIdx, "done", "Merged — this repo has no CI workflows, so there was nothing to gate on");
    return true;
  }
  return false;
}

function selectPrChecks(rows, requireAllChecks = false) {
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((cols) => cols.length >= 2 && (requireAllChecks || /^build/i.test(String(cols[0] || "").trim())))
    .map((cols) => ({ name: String(cols[0] || "").trim(), status: String(cols[1] || "").trim(), url: String(cols[3] || "").trim() }));
  const byName = {};
  for (const check of candidates) {
    const current = byName[check.name];
    const rank = (status) => status === "fail" ? 2 : (status === "pending" ? 1 : 0);
    if (!current || rank(check.status) > rank(current.status)) byName[check.name] = check;
  }
  return Object.values(byName);
}
// PR check status, read entirely over REST instead of `gh pr checks` / `--json
// statusCheckRollup`. Both of those go through GraphQL, which always asks for
// checkSuite.workflowRun as part of the rollup — a field that needs "Actions: Read-only",
// a permission the g99-gitops App does not have. The App-token call then fails with a
// partial GraphQL error on stderr and EMPTY stdout, which every caller was silently reading
// as "no checks yet" — the tool would poll forever past a check that had already passed.
// REST needs only "checks"/"statuses" read, which the App already has, and returns the
// same [name, status, "", url] row shape selectPrChecks() expects, so nothing downstream
// has to change.
async function fetchCheckRows(repo, prNum) {
  const pv = await sh(`gh pr view ${prNum} --repo ${repo} --json headRefOid,state,mergedAt`);
  let sha = "", prState = "", merged = false;
  try {
    const v = JSON.parse(pv.stdout || "{}");
    sha = v.headRefOid || ""; prState = v.state || ""; merged = prState === "MERGED" || !!v.mergedAt;
  } catch (e) { /* leave unknown — the watcher just keeps waiting */ }
  if (!sha) return { rows: [], prState, merged };
  const [runsR, statusR] = await Promise.all([
    sh(`gh api repos/${repo}/commits/${sha}/check-runs`),
    sh(`gh api repos/${repo}/commits/${sha}/status`),
  ]);
  const rows = [];
  try {
    for (const c of (JSON.parse(runsR.stdout || "{}").check_runs || [])) {
      const status = c.status !== "completed" ? "pending"
        : ["success", "neutral", "skipped"].includes(c.conclusion) ? "pass" : "fail";
      rows.push([c.name || "", status, "", c.html_url || c.details_url || ""]);
    }
  } catch (e) { /* check-runs endpoint returned something unparseable — statuses may still work */ }
  try {
    // Legacy commit-status contexts (pre-Checks-API CI, e.g. old Travis/Jenkins integrations) —
    // rare on this repo's Actions-only setup, included for any repo that still uses them.
    for (const s of (JSON.parse(statusR.stdout || "{}").statuses || [])) {
      const status = s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail";
      rows.push([s.context || "", status, "", s.target_url || ""]);
    }
  } catch (e) { /* no legacy statuses — fine, check-runs already covers Actions */ }
  return { rows, prState, merged };
}
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
  // Two different things, and conflating them cost us a wrong live-site guess:
  // `liveUrl` (Domain) is the BETA we build and deploy to, e.g. prodteam.gogroth.com.
  // `existingSiteUrl` (Live Site) is the client's CURRENT site, e.g. nuvoaestheticsclinic.com,
  // which is read for one thing only — its sitemap, to catch pages we have not rebuilt.
  // It is not derivable from the beta domain: Brew Aesthetics builds on prodteam.gogroth.com.
  const existingSiteUrl = nocoField(row, ["Live Site", "Live Website", "Existing Site", "Existing Website", "Current Site", "Old Site"]);
  const repoUrl = nocoField(row, ["Repo File Path", "Repository URL", "Repo", "Repository", "GitHub", "Github Repo"]);
  const githubRepo = parseRepoSlug(repoUrl);
  const rowId = row.Id != null ? row.Id : (row.id != null ? row.id : null);
  const siteId = rowId != null ? `noco-${rowId}` : (githubRepo || businessName);
  return { siteId, rowId, businessName, liveUrl, existingSiteUrl, repoUrl, githubRepo };
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
  // gh writes its error body to stdout, not stderr, so a repository that does
  // not exist comes back as the single line {"message":"Not Found",...}. Read
  // without this check it is one plausible-looking theme name, and the caller
  // that treats a lone theme as unambiguous builds a path out of it. An empty
  // list is what "could not read the themes" already means to every caller.
  if (r.code !== 0) return [];
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
  o.pending.push({ id: "r" + Date.now() + Math.random().toString(36).slice(2, 6), mode: "reply", threadId: p.threadId, text, at: new Date().toISOString() });
  o.pending = o.pending.slice(-100);
  writeOutbox(o);
}
// Queue a NEW email — its own thread, not a reply — for something that must not
// get buried at the bottom of the original request thread: a clarification ask
// on items this run could not complete. Needs the requester's address, not just
// a threadId, since Apps Script sends this with GmailApp.sendEmail(), not reply().
function queueClarificationEmail(job, unresolved) {
  const p = job && job.payload;
  if (!p || p.source !== "email" || !p.requestedBy || !unresolved || !unresolved.length) return;
  const text = [
    "A few items from your request need clarification before I can complete them:",
    "",
    ...unresolved.map((u) => `- ${u}`),
    "",
    "Reply to this email with more detail on each and I will pick it back up.",
  ].join("\n");
  const subject = "Clarification needed — " + (p.emailSubject || p.businessName || "your requested website change");
  const o = readOutbox();
  o.pending.push({ id: "r" + Date.now() + Math.random().toString(36).slice(2, 6), mode: "new", to: p.requestedBy, subject, text, at: new Date().toISOString() });
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
// The zip's internal top-level folder name — the domain the client will actually
// see, e.g. "betasite.gogroth.com", so unzipping drops a folder named after the
// site rather than a generic "site".
function siteFolderName(job) {
  try {
    const raw = job.liveUrl || "";
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    if (u.hostname) return u.hostname;
  } catch (e) { /* fall through */ }
  return (job.businessName || "beta-site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "beta-site";
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
    steps: JOB_STEPS.map((label, i) => ({ key: JOB_STEP_KEYS[i], label, status: "pending", detail: "" })),
    payload, prUrl: null, branch: null, siteUrl: null,
    before: null, after: null, delta: null, reportUrl: null, error: null,
    // Set once, when the service-pages step finishes. Reported to G99 so it can record
    // SERVICE_PAGES_CREATED without inferring anything from step labels or ordering.
    servicePagesCreatedAt: null,
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
// What product-service and the client pool actually store. Detail TEXT is deliberately not in
// here: the CI watch rewrites it every 10s ("build (8.3):pending" → "build (8.3):pass"), and
// reporting each of those turned one build into ~74 outbound calls. Everything that matters —
// which step, its status, the PR, the scores — is covered, so a stage still produces one event
// when it starts and one when it ends.
const jobSignature = (job) => [
  job.status, job.currentStep, (job.steps || []).map((s) => s.status).join(""),
  job.prUrl || "", job.error || "", job.liveUrl || "",
  job.before ? job.before.overall : "", job.after ? job.after.overall : "",
].join("|");

function jobStep(job, i, status, detail) {
  // Cancellation lands at step boundaries: refuse to start a new step if asked to cancel.
  if (status === "running" && job.cancelRequested) throw Object.assign(new Error("cancelled by user"), { cancelled: true });
  job.currentStep = i;
  job.steps[i].status = status;
  if (detail != null) job.steps[i].detail = String(detail).slice(0, 240);
  saveJobs();                       // local state always current — the UI polls this
  const sig = jobSignature(job);
  if (sig === job._lastReportedSig) return;   // detail-only churn: nothing to report outward
  job._lastReportedSig = sig;
  postStatus(job);   // report each real step transition to G99 (fail-soft)
  mirrorPool(job);   // and to the durable client pool (survives redeploys)
}
// Slack (or any incoming-webhook) notification — fail-soft, off when unset.
function notify(text) {
  const url = process.env.SLACK_WEBHOOK_URL || "";
  if (!url) return;
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});
}

// What the team reads in TED. The request itself is the point, but a comment
// with no provenance is unactionable — who asked, for which site, and which
// Studio run to look at when they want the diff.
function tedRequestComment({ site, addr, subject, instruction, jobId }) {
  return [
    `Website change request — ${site.businessName}`,
    `From: ${addr}`,
    `Subject: ${subject || "(none)"}`,
    `Studio job: ${jobId} · queued, held for approval before merge`,
    "",
    instruction,
  ].join("\n");
}

// Comment on the TED task that tracks beta site revisions. Same fail-soft
// contract as notify() and postStatus(): never awaited, never throws, and a
// TED outage can only cost us the comment — the edit job and the reply to the
// requester have already happened by the time this runs.
// `image` is optional {buf, contentType}. With one, the comment goes as
// multipart/form-data under the field name `files` — TED ignores `file` and
// `attachments` silently — and Content-Type is deliberately left unset so fetch
// can add the multipart boundary.
// TED's comment endpoint returns 500 for any non-ASCII byte in the text — a
// curly apostrophe is enough to lose the comment, and the failure looks like a
// server fault rather than a payload problem. Business names, AI-written
// summaries and pasted copy all carry smart quotes and dashes routinely, so the
// text is folded to ASCII on the way out rather than gambling on it.
const TED_ASCII = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " ", "•": "-", "×": "x" };
function tedAscii(s) {
  return String(s || "").replace(/[‘’“”–—… •×]/g, (c) => TED_ASCII[c])
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
}

// Stamped on every comment this tool writes, and the only reliable way for it to
// recognise its own voice: TED attributes a token's comments to the person who
// owns it, so the author name cannot separate "the tool said this" from "that
// person said this". Without it, the outcome comment a run posts is read as the
// next request and the tool answers itself forever.
// ASCII on purpose — tedAscii strips anything else on the way out.
const TED_AUTOMATION_MARK = "[automated: Growth99 Studio]";

// Post as the AI agent rather than as whoever's token this is. TED's /comments/ai
// endpoint differs from the plain one in three ways that all matter: it wants
// X-Api-Key rather than a bearer token, it renders HTML rather than plain text,
// and it takes an eventKey it uses for idempotency — so a retry after a timeout
// updates the same comment instead of posting a second one.
//
// Falls back to the ordinary comment endpoint, because a report that lands under
// a person's name is far better than one that does not land at all.
const TED_AI_TOKEN = process.env.TED_AI_API_KEY || process.env.TED_API_TOKEN || "";
function tedHtml(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return String(text || "").split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length > 1 && lines.every((l) => /^\s*[-*]\s/.test(l))) {
      return "<ul>" + lines.map((l) => `<li>${esc(l.replace(/^\s*[-*]\s/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p>${lines.map((l) => esc(l)).join("<br>")}</p>`;
  }).join("");
}
async function tedAiComment(taskId, text, eventKey) {
  if (!TED_AI_TOKEN || !taskId || !text) return { ok: false, reason: "missing token, task or text" };
  try {
    const r = await fetch(`${TED_BASE}/api/tasks/${taskId}/comments/ai`, {
      method: "POST",
      headers: { "X-Api-Key": TED_AI_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text: tedHtml(text), ...(eventKey ? { eventKey } : {}) }),
    });
    // TED answers 200 with its Angular shell for routes it does not register, so
    // the status alone proves nothing — same trap as every other TED endpoint.
    if (/html/i.test(r.headers.get("content-type") || "")) return { ok: false, reason: "endpoint not deployed (got the TED web app)" };
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}: ${(await r.text()).slice(0, 160)}` };
    return { ok: true, body: (await r.text()).slice(0, 300) };
  } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 140) }; }
}

function tedComment(text, image = null, attempt = 0, taskId = null) {
  if (!TED_API_TOKEN || !text) return;
  // Stamped here rather than at each call site so nothing this tool ever posts
  // can be mistaken for a person's request. Added before the retry recursion so
  // a retried comment does not collect a second copy.
  text = tedAscii(text);
  if (!text.includes(TED_AUTOMATION_MARK)) text += `\n\n${TED_AUTOMATION_MARK}`;
  const target = taskId || TED_REVISIONS_TASK_ID;
  const headers = {};
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;

  let body;
  if (image) {
    const ext = /png/i.test(image.contentType) ? "png" : "jpg";
    body = new FormData();
    body.append("text", text);
    body.append("files", new Blob([image.buf], { type: image.contentType }), `studio-change.${ext}`);
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ text });
  }

  fetch(`${TED_BASE}/api/tasks/${target}/comments`, { method: "POST", headers, body })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // TED serves its Angular shell for any /api route it does not register —
      // index.html with a 200, not a 404. Without this check a missing endpoint
      // looks like a successful post and the comment is silently dropped.
      if (/html/i.test(r.headers.get("content-type") || "")) throw new Error("endpoint not deployed (got the TED web app, not the API)");
    })
    .catch((e) => {
      // Losing the screenshot must never cost us the message: an upload that
      // fails is retried once as text, which is the part that actually matters.
      if (image) {
        console.error(`TED screenshot upload failed (${e.message}) — posting the comment without it`);
        return tedComment(text, null, attempt, target);
      }
      // A dead token, a wrong header or a missing route are all settled facts —
      // retrying three more times would only delay the log line that says so.
      const fatal = /HTTP 40[13]|not deployed/.test(e.message);
      if (!fatal && attempt < G99_RETRY_DELAYS_MS.length) {
        setTimeout(() => tedComment(text, null, attempt + 1, target), G99_RETRY_DELAYS_MS[attempt]);
      } else {
        console.error(`TED comment on task ${TED_REVISIONS_TASK_ID} failed:`, e.message);
      }
    });
}

// Hand the ticket back: mark it as done by the AI rather than leaving a human to
// close a task they did not do. Awaited, unlike tedComment — a caller that says
// "comment then close" needs to know the close actually happened.
async function tedUpdateTask(taskId, fields) {
  if (!TED_API_TOKEN) return { ok: false, reason: "TED_API_TOKEN not set" };
  if (!taskId) return { ok: false, reason: "no task id" };
  const headers = { "Content-Type": "application/json" };
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  try {
    const r = await fetch(`${TED_BASE}/api/tasks/${taskId}`, { method: "PUT", headers, body: JSON.stringify(fields) });
    // Same trap as the comment endpoint: TED answers 200 with its Angular shell
    // for any /api route it does not register, so status alone proves nothing.
    if (/html/i.test(r.headers.get("content-type") || "")) return { ok: false, reason: "endpoint not deployed (got the TED web app, not the API)" };
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true, body: (await r.text()).slice(0, 400) };
  } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 140) }; }
}

// ---- Email request → TED subtask -------------------------------------------
// An emailed change used to be filed as a comment on one fixed task
// (TED_REVISIONS_TASK_ID), which meant every client's requests piled onto the
// task belonging to whoever that id happened to be. Each request now gets its
// own subtask under THAT client's revision-cycle task, and the outcome comment
// goes back onto the same subtask, so a request and its result read as a pair.
//
// Off with TED_SUBTASKS=off, which restores the single-task behaviour exactly.
const TED_SUBTASKS = (process.env.TED_SUBTASKS || "on").toLowerCase() !== "off";
// The parent is identified by template key, not by title or id: titles are
// edited by hand and ids differ per client. Title is only used to narrow the
// candidates before confirming the key.
const TED_PARENT_KEY = process.env.TED_PARENT_KEY || "beta_site.revision_cycle";
const TED_PARENT_TITLE_RE = /manage.*beta\s*site.*revision/i;

// TED's client names do not always match NocoDB's ("NUVO Aesthetics Clinic
// (clone)" vs "NUVO Aesthetics Clinic"), so they are compared with the same
// normalisation the pre-release webhook uses on the way in.
const tedNorm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function tedFetchJson(path, init) {
  const headers = { accept: "application/json", ...(init && init.headers) };
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  const r = await fetch(`${TED_BASE}${path}`, { ...init, headers });
  // Same trap as everywhere else in this file: TED answers 200 with its Angular
  // shell both for routes it does not register AND for writes the token is not
  // permitted to make, so the status alone proves nothing.
  if (/html/i.test(r.headers.get("content-type") || "")) throw new Error("got the TED web app, not the API (route missing or not permitted)");
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// The whole client list. Cached: it is large and changes far more slowly than
// requests arrive.
let TED_CLIENTS = { at: 0, list: [] };
async function tedClients() {
  if (Date.now() - TED_CLIENTS.at > 600000 || !TED_CLIENTS.list.length) {
    const d = await tedFetchJson("/api/clients");
    TED_CLIENTS = { at: Date.now(), list: d.items || d.list || d.data || (Array.isArray(d) ? d : []) };
  }
  return TED_CLIENTS.list;
}

// businessName (NocoDB) -> the client name TED files tasks under.
async function tedClientName(businessName) {
  const list = await tedClients();
  const want = tedNorm(businessName);
  const hit = list.filter((c) => tedNorm(c.name) === want);
  if (hit.length === 1) return hit[0].name;
  // Never guess between two clients — filing a request on the wrong client's
  // board is worse than not filing it at all.
  throw new Error(hit.length ? `"${businessName}" matches ${hit.length} TED clients` : `no TED client matches "${businessName}"`);
}

// ---- TED as the source for a client's beta site ------------------------------
// A beta site is created in TED, so TED knows its URL and repository first-hand.
// Matching a client name against a NocoDB row was only ever a way of asking that
// question indirectly, and /api/clients/{id}/info now answers it directly:
// betaSiteUrl and githubRepo, keyed by client id.
//
// It is a preference rather than a switch, and TED's answer is verified before
// it is used. Both halves of that were earned on 2026-08-11: coverage was 1 of
// 148 clients (the fields are written when the beta_site.env task completes, and
// nothing was backfilled), and that one populated row was wrong — it named
// nuvoaestheticsclinic.gogroth.com, a repository that does not exist and a host
// that does not serve, where the client actually builds on the shared
// prodteam.gogroth.com. Preferring TED blindly would have swapped a working
// repository for a 404.
//
// So: ask TED, use its answer only when the repository it names resolves, and
// let NocoDB answer for everyone else. Each client starts resolving from TED the
// moment TED has a usable answer for it, with no deploy or flag day on either
// side, and a wrong row in TED costs a log line rather than a failed run.

// clientName (+ hubspotId when the caller has one) -> TED's numeric client id.
// null rather than a throw: not finding the client is the normal case today.
async function tedClientIdFor(clientName, hubspotId) {
  const list = await tedClients();
  // hubspotId is the stronger key — it is unique per client, while names repeat
  // across clones ("... (clone)", "... v2 (clone)").
  if (hubspotId) {
    const byDeal = list.filter((c) => String(c.hubspotId || "") === String(hubspotId));
    if (byDeal.length === 1) return String(byDeal[0].id);
  }
  const want = tedNorm(clientName);
  const exact = list.filter((c) => tedNorm(c.name) === want);
  return exact.length === 1 ? String(exact[0].id) : null;   // never guess between two
}

// What TED holds for a client, or null. Never throws: TED being unreachable has
// to leave the NocoDB path behaving exactly as it did before.
async function tedSiteFields(clientName, hubspotId) {
  if (!TED_API_TOKEN) return null;
  try {
    const id = await tedClientIdFor(clientName, hubspotId);
    if (!id) return null;
    const info = await tedGetClientInfo(id);
    if (!info || !info.githubRepo) return null;
    return {
      clientId: id,
      // TED stores the repository as "Owner/Repo" already, which is the form
      // this file uses everywhere; parseRepoSlug is tolerated for the day it
      // starts storing full URLs instead.
      githubRepo: parseRepoSlug(info.githubRepo) || String(info.githubRepo).trim(),
      betaSiteUrl: String(info.betaSiteUrl || "").trim(),
    };
  } catch (e) { return null; }
}

// The check that makes TED-first safe. A repository with no themes in it cannot
// be edited, so it is the same question resolveEditTarget() asks next — asked
// one step earlier, where there is still a NocoDB row to fall back to.
async function tedRepoUsable(repo) {
  if (!repo) return false;
  const themes = await listRepoThemes(repo).catch(() => []);
  return themes.length > 0;
}

// A site already identified by other means, with TED's repository and beta URL
// preferred over it when TED has a usable pair. Returns the original object
// untouched in every other case, so callers keep every field they expect
// (siteId, existingSiteUrl, rowId) regardless of which source won.
async function withTedFields(site, hubspotId) {
  const ted = await tedSiteFields(site.businessName, hubspotId);
  if (!ted) return site;
  const sameRepo = ted.githubRepo === site.githubRepo;
  const sameUrl = !ted.betaSiteUrl || ted.betaSiteUrl === site.liveUrl;
  if (sameRepo && sameUrl) return site;                       // nothing to prefer
  if (!(await tedRepoUsable(ted.githubRepo))) {
    console.warn(`ted: ignoring ${site.businessName} -> ${ted.githubRepo} (repository does not resolve) — keeping ${site.githubRepo || "no repo"} from NocoDB`);
    return site;
  }
  console.log(`ted: ${site.businessName} resolved from TED client ${ted.clientId} (${ted.githubRepo}${ted.betaSiteUrl ? ", " + ted.betaSiteUrl : ""})`);
  return { ...site, githubRepo: ted.githubRepo, liveUrl: ted.betaSiteUrl || site.liveUrl, tedClientId: ted.clientId, resolvedFrom: "ted" };
}

// One site for a TED client name, TED first and NocoDB behind it. The NocoDB
// half is the join this tool has always used and is refused the same way when it
// is not exactly one site: acting on the wrong client's repository is not a
// recoverable mistake.
async function resolveClientSite(clientName, hubspotId) {
  const sites = await getWebsites(true);
  const want = tedNorm(clientName);
  const exact = sites.filter((s) => tedNorm(s.businessName) === want);
  const hits = exact.length ? exact : sites.filter((s) => tedNorm(s.businessName).includes(want) || want.includes(tedNorm(s.businessName)));
  const nocoHit = hits.length === 1 ? hits[0] : null;

  if (nocoHit) {
    const site = await withTedFields(nocoHit, hubspotId);
    if (!site.githubRepo) throw new Error(`${site.businessName} has no repository in NocoDB`);
    return site;
  }

  // No NocoDB row — the case TED is here to fix. A client that only exists in
  // TED is workable as long as TED names a repository that resolves; the siteId
  // is synthesised so per-site state (approvals, job dedupe) still has a key.
  const ted = await tedSiteFields(clientName, hubspotId);
  if (ted && await tedRepoUsable(ted.githubRepo)) {
    console.log(`ted: ${clientName} has no NocoDB row — resolved entirely from TED client ${ted.clientId} (${ted.githubRepo})`);
    return {
      siteId: `ted-${ted.clientId}`, rowId: null, businessName: clientName,
      liveUrl: ted.betaSiteUrl, existingSiteUrl: "", repoUrl: `https://github.com/${ted.githubRepo}`,
      githubRepo: ted.githubRepo, tedClientId: ted.clientId, resolvedFrom: "ted",
    };
  }
  throw new Error(hits.length ? `"${clientName}" matches ${hits.length} sites` : `no site matches "${clientName}"`);
}

// The client's own revision-cycle task, which the request's subtask hangs off.
// Cached per client because it is stable for the life of an onboarding.
const TED_PARENTS = new Map();
async function tedRevisionParent(businessName) {
  const cached = TED_PARENTS.get(businessName);
  if (cached && Date.now() - cached.at < 600000) return cached.id;
  const client = await tedClientName(businessName);
  const d = await tedFetchJson(`/api/tasks/all?pageSize=200&client=${encodeURIComponent(client)}`);
  // The list response strips `automation`, so the key can only be confirmed by
  // fetching each candidate. Narrowing by title first keeps that to one or two.
  const candidates = (d.items || []).filter((t) => !t.parentId && TED_PARENT_TITLE_RE.test(t.title || ""));
  for (const c of candidates) {
    const full = await tedFetchJson(`/api/tasks/${c.id}`).catch(() => null);
    if (full && full.automation && full.automation.templateKey === TED_PARENT_KEY) {
      TED_PARENTS.set(businessName, { id: String(full.id), at: Date.now() });
      return String(full.id);
    }
  }
  throw new Error(`no ${TED_PARENT_KEY} task for ${client}`);
}

// A subject line is often "Website changes" or a bare URL, so the title is
// written from the request itself. Kept short because TED truncates it in list
// views, and deliberately capped in time — a slow model must not hold up the
// reply to the person who emailed. Falls back to the subject, then the request.
async function tedSubtaskTitle(subject, instruction) {
  const fallback = tedAscii(String(subject || instruction || "Website change request").replace(/\s+/g, " ").trim()).slice(0, 120);
  try {
    const out = await aiCall([{ text:
      `Write a task title for this website change request. One line, max 10 words, imperative ("Update the homepage hero heading"). No quotes, no trailing period, no client name.\n\nSubject: ${subject || "(none)"}\n\nRequest:\n${String(instruction || "").slice(0, 2000)}` }],
      { temperature: 0.1, maxOutputTokens: 60, timeoutMs: 20000 });
    const line = tedAscii(stripFence(out).split("\n")[0].replace(/^["'\s]+|["'\s.]+$/g, "")).trim();
    return line ? line.slice(0, 120) : fallback;
  } catch (e) {
    console.warn("TED subtask title fell back to the subject:", e.message);
    return fallback;
  }
}

// Create the subtask and return its id, or null if anything at all went wrong.
// Fail-soft on purpose: the caller falls back to the old single-task comment, so
// a TED problem costs us the tidy threading and never the request itself.
//
// Known API limits, all confirmed against the live TED API:
//   * clientName cannot be set on create or update — it comes back "[]", so an
//     API-made subtask does not appear in client-scoped views yet. Sent anyway,
//     so this starts working the day TED accepts it.
//   * priority is silently ignored, and title cannot be changed after create.
//   * departmentName is dropped on create but does apply on a follow-up PUT.
async function tedCreateSubtask({ businessName, title, description, dueDate }) {
  if (!TED_API_TOKEN || !TED_SUBTASKS) return null;
  try {
    const parentId = await tedRevisionParent(businessName);
    const created = await tedFetchJson("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: tedAscii(title).slice(0, 120),
        parentId: Number(parentId),
        status: "Not Started",
        clientName: await tedClientName(businessName).catch(() => undefined),
        departmentName: "Onboarding Engineering",
        startDate: new Date().toISOString().slice(0, 10),
        ...(dueDate ? { dueDate } : {}),
        description: tedAscii(description),
      }),
    });
    if (!created || !created.id) throw new Error("create returned no id");
    // Department is dropped by create but accepted here, so the task lands on
    // the right board rather than in nobody's list.
    await tedFetchJson(`/api/tasks/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ departmentName: "Onboarding Engineering" }),
    }).catch(() => {});
    console.log(`TED subtask ${created.id} created under ${parentId} for ${businessName}`);
    return String(created.id);
  } catch (e) {
    console.warn(`TED subtask for ${businessName} not created (${e.message}) — falling back to task ${TED_REVISIONS_TASK_ID}`);
    return null;
  }
}

// Marks a subtask this tool created from an email. Load-bearing, not cosmetic:
// the email flow posts a comment onto its own new subtask, and that comment is
// exactly the event the manual path below listens for. Without a way to tell
// the two apart, every emailed request would immediately start a second run of
// itself. The suffix is how the manual path knows to stand down.
const TED_EMAIL_SUFFIX = "(via email)";
const isEmailSubtask = (title) => String(title || "").trim().toLowerCase().endsWith(TED_EMAIL_SUFFIX);

// Throws rather than returning [] on failure, deliberately. "No comments" is a
// decision — this request is not ready — and a TED read that merely failed must
// never be mistaken for it, or a real request is dropped and nothing retries.
//
// Returns the author alongside the text because who wrote the last comment is
// what stops this tool answering itself; see tedResolveSubtaskRequest.
async function tedTaskComments(taskId) {
  const d = await tedFetchJson(`/api/tasks/${taskId}/comments`);
  const arr = Array.isArray(d) ? d : (d.items || d.data || d.list || []);
  return arr.map((c) => ({
    text: String(c.text || c.comment || "")
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ").trim(),
    authorName: c.authorName || "",
    aiGenerated: !!c.aiGenerated,
    createdAt: c.createdAt || "",
  })).filter((c) => c.text);
}


// A subtask someone created by hand in TED, under a client's revision-cycle
// task, is the same request as an email — just entered somewhere else. This
// resolves one into everything an edit job needs, or throws with a reason worth
// reading in a log.
//
// The client is taken from the subtask, falling back to its parent. That
// fallback is not defensive padding: TED's API cannot set clientName on create
// (it stores "[]"), so any subtask made through the API — including this tool's
// own — has no client of its own and can only inherit it.
// "This event is not a revision request" and "TED could not be reached" must not
// look alike to the caller: the first is answered 200 so TED stops resending it,
// the second has to fail loudly so it is retried rather than silently dropped.
// Only the deliberate refusals below are marked ignorable.
function tedSkip(message) { const e = new Error(message); e.ignore = true; return e; }

async function tedResolveSubtaskRequest(taskId) {
  // TED calls two different things a subtask, and only one of them is a task.
  // GET /api/tasks/<parent>/subtasks shows both: a real sub-task is a Task record
  // with a plain id (9077 -> 14675), while a checklist row is "sub_1733" and has
  // no /api/tasks/<id> of its own and no comments to read. A checklist row can
  // never carry a change request, so say why rather than failing on the fetch.
  if (/^sub_/i.test(String(taskId))) throw tedSkip(`${taskId} is a checklist row, not a sub-task — it has no comments to act on`);
  const task = await tedFetchJson(`/api/tasks/${taskId}`);
  if (!task.parentId) throw tedSkip(`task ${taskId} is not a subtask`);
  const parent = await tedFetchJson(`/api/tasks/${task.parentId}`);
  const key = parent.automation && parent.automation.templateKey;
  if (key !== TED_PARENT_KEY) throw tedSkip(`parent ${task.parentId} is ${key || "untemplated"}, not ${TED_PARENT_KEY}`);
  if (isEmailSubtask(task.title)) throw tedSkip(`"${task.title}" was created from an email and already has a run`);

  const usable = (n) => n && String(n).trim() && String(n).trim() !== "[]";
  const clientName = usable(task.clientName) ? task.clientName : (usable(parent.clientName) ? parent.clientName : null);
  if (!clientName) throw tedSkip(`no client on task ${taskId} or its parent`);

  // TED first, the NocoDB name join behind it — see resolveClientSite. The
  // hubspotId travels with the task and identifies the client far more reliably
  // than its name, which repeats across clones.
  const site = await resolveClientSite(clientName, task.hubspotId || parent.hubspotId || "");

  // Title and description are what the person wrote first; comments are where
  // they add the detail they forgot. All of it is the request.
  const comments = await tedTaskComments(taskId);
  const description = String(task.description || "").trim();

  // Either half can carry the request. TED's Subtask Activity trigger fires on
  // creation, when a subtask has a description and cannot yet have a comment;
  // the comment trigger fires later, when someone adds the detail they left out.
  // Insisting on a comment would have made the creation path impossible.
  //
  // The title alone is not enough: "Website Change" names a subtask without
  // saying what to change, and building from that would be guessing.
  if (!description && !comments.length) {
    throw tedSkip(`task ${taskId} has no description or comments yet — nothing to act on`);
  }

  // The run's own outcome ("Change is live ...") is posted as a comment on this
  // same subtask, and a comment is what triggers this endpoint. Left alone, the
  // tool would answer itself forever: run, report, and treat its own report as
  // the next request. The email path is spared by its "(via email)" title; a
  // hand-made subtask has no such mark, so the check is on who spoke last.
  //
  // Last comment, not any comment: a person adding more detail after a run has
  // finished is a new request and must still get through.
  // Identified by a marker in the text, not by author: TED credits a token's
  // comments to the person who owns it, so this tool posts under a real name —
  // the same name that person uses when they write a genuine request by hand.
  // Matching on the author would ignore the token owner's own requests.
  if (comments.length) {
    const newest = comments.reduce((a, b) => (String(b.createdAt) > String(a.createdAt) ? b : a), comments[0]);
    if (newest.aiGenerated || newest.text.includes(TED_AUTOMATION_MARK)) {
      throw tedSkip(`the last comment on ${taskId} was posted by this tool — not a new request`);
    }
  }

  const instruction = [task.title, description, ...comments.map((c) => c.text)]
    .map((s) => String(s || "").trim()).filter(Boolean).join("\n\n");
  return { task, parent, site, clientName, instruction };
}

// Real sub-tasks and checklist rows both come back here; the caller filters.
async function tedListSubtasks(parentId) {
  const d = await tedFetchJson(`/api/tasks/${parentId}/subtasks`);
  return Array.isArray(d) ? d : (d.items || d.data || d.list || []);
}

// Everything between "here is a subtask id" and "a job is running for it".
// Shared by the webhook and the poller below so the two cannot drift: whichever
// notices the subtask first, the decision to run it is made in exactly one place.
// Which subtasks this tool has already taken responsibility for. Persisted: a
// redeploy that forgot would re-run every open request at once, and on the first
// dry run of the poller that meant five builds off stale test fixtures.
const TED_SEEN_FILE = path.join(DIR, "ted-subtasks.json");
const TED_STARTED = new Set();
const TED_LOGGED = new Set();   // refusals already reported, so the log says each thing once
let TED_SEEN_LOADED = false;
function loadTedSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(TED_SEEN_FILE, "utf8"));
    (raw.seen || []).forEach((id) => TED_STARTED.add(String(id)));
    TED_SEEN_LOADED = true;
  } catch (e) { TED_SEEN_LOADED = false; }   // absent on a first boot; seeded by the first poll
  return TED_SEEN_LOADED;
}
function saveTedSeen() {
  try { fs.writeFileSync(TED_SEEN_FILE, JSON.stringify({ seen: [...TED_STARTED] }, null, 2)); }
  catch (e) { console.warn("could not persist ted-subtasks.json:", e.message); }
}
async function startTedSubtaskRun(taskId, { dryRun = false } = {}) {
  const r = await tedResolveSubtaskRequest(taskId);   // throws; .ignore marks a refusal
  const running = [...JOBS.values()].find((j) => j.type === "edit" && j.payload
    && String(j.payload.tedSubtaskId) === String(taskId) && (j.status === "queued" || j.status === "running"));
  if (running) return { dedupe: true, jobId: running.draftId, businessName: r.site.businessName };
  const target = await resolveEditTarget(r.site);
  if (dryRun) {
    return { dryRun: true, taskId, parentId: r.task.parentId, businessName: r.site.businessName,
      themeSlug: target.themeSlug, instruction: r.instruction };
  }
  const job = enqueueEditJob({
    jobId: "edit-" + Date.now(),
    siteId: r.site.siteId, businessName: r.site.businessName, githubRepo: r.site.githubRepo,
    themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
    prompt: r.instruction, forceApproval: true,
    // Not "email": there is no thread and nobody to reply to, and the email
    // reply path keys off that. The subtask id is what makes the outcome
    // comment land back where the request was made.
    source: "ted-subtask", requestedBy: r.task.reporterName || "TED",
    tedSubtaskId: String(taskId), liveUrl: r.site.liveUrl || "",
  });
  TED_STARTED.add(String(taskId));
  saveTedSeen();
  // Says the request was picked up, and — because every comment this tool writes
  // carries the automation mark — it is also what stops the poller starting the
  // same subtask again on its next pass. The acknowledgement and the guard are
  // deliberately the same act: one cannot be forgotten without the other.
  tedComment([
    `Picked up by Growth99 Studio - ${r.site.businessName}`,
    `Studio job: ${job.draftId} - building now, held for approval before anything merges.`,
  ].join("\n"), null, 0, String(taskId));
  notify(`📝 TED subtask ${taskId} → *${r.site.businessName}*: ${r.instruction.slice(0, 140)} (needs your approval before merge)`);
  return { jobId: job.draftId, taskId, businessName: r.site.businessName };
}

// A webhook that never arrives is indistinguishable from one that was never
// sent, and TED's subtask trigger is new enough that neither of us can promise
// it fires for every kind of subtask. So the tool also looks for itself: every
// few minutes it reads each client's revision-cycle task and starts anything it
// has not started yet. The webhook stays the fast path — this is what makes the
// feature work without depending on it.
//
// Re-running is prevented by the acknowledgement comment rather than by memory,
// so a redeploy mid-flight cannot cause a second run of the same request.
const TED_POLL_MS = Number(process.env.TED_SUBTASK_POLL_MS || 180000);
async function pollTedSubtasks() {
  if (!TED_API_TOKEN || !TED_SUBTASKS) return;
  // First boot on a deployment: adopt whatever is already there without acting on
  // it. Those subtasks predate this feature — some are answered, some are old test
  // rows — and starting a build for each one because the tool had just learned to
  // look would be indefensible. Only what appears afterwards is acted on.
  const seeding = !TED_SEEN_LOADED && !loadTedSeen();
  let sites = [];
  try { sites = await getWebsites(false); } catch (e) { return console.warn("subtask poll: NocoDB unavailable:", e.message); }
  if (seeding) {
    for (const site of sites) {
      try {
        const pid = await tedRevisionParent(site.businessName);
        (await tedListSubtasks(pid)).forEach((s) => s && s.id && TED_STARTED.add(String(s.id)));
      } catch (e) { /* a client with no revision task contributes nothing to seed */ }
    }
    TED_SEEN_LOADED = true;
    saveTedSeen();
    console.log(`subtask poll: adopted ${TED_STARTED.size} existing subtask(s) without running them; new ones from here on`);
    return;
  }
  for (const site of sites) {
    let parentId, subs;
    try { parentId = await tedRevisionParent(site.businessName); } catch (e) { continue; }   // no revision task for this client
    try { subs = await tedListSubtasks(parentId); } catch (e) { console.warn(`subtask poll: could not list ${parentId}:`, e.message); continue; }
    for (const s of subs) {
      const id = String((s && s.id) || "");
      // Checklist rows cannot hold a request; skip without a round trip.
      if (!id || /^sub_/i.test(id) || TED_STARTED.has(id)) continue;
      try {
        const out = await startTedSubtaskRun(id);
        if (out && out.jobId && !out.dedupe) console.log(`subtask poll: started ${out.jobId} for TED subtask ${id} (${out.businessName})`);
      } catch (e) {
        // Logged either way — silence here is indistinguishable from a poller
        // that never looked, which is the doubt this feature exists to remove.
        // A refusal is NOT remembered: "no description yet" and "the tool spoke
        // last" both stop being true the moment someone types something, and a
        // subtask filled in after it was first seen must still get its run.
        // Logged once per id per process so a permanent refusal does not repeat
        // every few minutes forever.
        const first = !TED_LOGGED.has(id);
        TED_LOGGED.add(id);
        if (e && e.ignore) { if (first) console.log(`subtask poll: ${id} skipped — ${e.message}`); }
        else console.warn(`subtask poll: ${id} failed:`, (e && e.message) || e);
      }
    }
  }
}

// The other half of the loop: the request comment says what was asked for, this
// says how it ended. Both carry the same job id so they read as a pair.
function tedOutcomeComment(job, outcome) {
  const P = (job && job.payload) || {};
  const head = outcome.ok
    ? `Change is live — ${P.businessName || "site"}`
    : `Change could not be completed — ${P.businessName || "site"}`;
  return [
    head,
    `Studio job: ${job.draftId}`,
    outcome.ok && P.liveUrl ? P.liveUrl : "",
    "",
    outcome.detail,
  ].filter((l, i) => l !== "" || i === 3).join("\n");
}

// Fired after a job finishes, never awaited by it. The wait exists because the
// deploy lands a moment after the merge and a screenshot taken immediately would
// show the old page — worse than no screenshot at all.
function tedPostOutcome(job, outcome) {
  const P = (job && job.payload) || {};
  // Only runs that were announced in TED get an outcome there: one that arrived
  // by email, or one started from a TED subtask, which is a request waiting on
  // an answer by definition. A run someone kicked off from the dashboard has no
  // ticket to answer, and posting it would put it on a task nobody asked.
  if (!TED_API_TOKEN || (P.source !== "email" && !P.tedSubtaskId)) return;
  const text = tedOutcomeComment(job, outcome);
  // Back onto the subtask this request created, so the outcome sits under the
  // request it answers. Null when the subtask could not be made (or subtasks are
  // off), and tedComment then falls back to TED_REVISIONS_TASK_ID as before.
  const taskId = P.tedSubtaskId || null;
  if (!outcome.ok || !TED_SCREENSHOTS || !P.liveUrl) return tedComment(text, null, 0, taskId);
  setTimeout(async () => {
    let image = null;
    try {
      const shot = await siteScreenshot(P.liveUrl, { extra: TED_SHOT_PARAMS, width: TED_SHOT_WIDTH, timeoutMs: 25000 });
      if (shot && shot.buf.length <= TED_SHOT_MAX_BYTES) image = shot;
      else if (shot) console.warn(`TED screenshot ${(shot.buf.length / 1024).toFixed(0)}KB exceeds the inline limit — posting without it`);
    } catch (e) { console.warn("TED screenshot failed:", e.message); }
    // Say so explicitly. The comment still goes out either way, and a picture
    // that is merely absent looks identical to one that was never wanted.
    if (!image) console.warn(`TED outcome for ${job.draftId} posting without a screenshot — both microlink and mShots came back empty`);
    tedComment(text, image, 0, taskId);
  }, TED_SHOT_DELAY_MS);
}

// ============================================================ Wireframe QA (CRO audit → TED)
// Runs once the site's service pages exist: audits Home / a Service page / About / Contact with the
// SAME croAudit() rubric used for the build's before/after score, captures a screenshot of each, and
// posts the result onto a TED task AS the AI Agent — moving it to In Progress and assigning it to AI,
// but never closing it (the audit only observes; a human closes). Read-only against the site.
//
// Two entry points: the standalone `POST /api/wireframe-qa` route (used for on-demand runs and the
// NUVO test), and an inline fire-and-forget hook at the end of runEnrichJob for the real build flow.
const WIREFRAME_QA_BUDGET_BYTES = 1_500_000;   // total inline screenshot bytes we allow in one comment

// GET a TED task. Returns { status, aiAssigned, templateKey } or null (missing/unreachable). Used to
// gate the post on the prerequisite task being Completed.
async function tedGetTask(taskId) {
  if (!TED_API_TOKEN || !taskId) return null;
  const headers = {};
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  try {
    const r = await fetch(`${TED_BASE}/api/tasks/${taskId}`, { headers });
    if (!r.ok) return null;
    if (/html/i.test(r.headers.get("content-type") || "")) return null;   // Angular shell = route missing
    const t = await r.json();
    return {
      status: t.status || t.Status || null,
      aiAssigned: (t.aiAssigned != null ? t.aiAssigned : null),
      templateKey: (t.automation && t.automation.templateKey) || null,
    };
  } catch (e) { return null; }
}

// POST an AI-agent result onto a TED task. Unlike fire-and-forget tedComment this is awaitable — the
// caller wants to know whether it landed. Sends JSON {text, eventKey, inProgress, assignAi}; the
// booleans are stringified because TED reads the body as a String map.
async function tedAiResult(taskId, html, opts = {}) {
  const { eventKey = "", inProgress = true, assignAi = true } = opts;
  if (!TED_API_TOKEN) return { ok: false, error: "TED_API_TOKEN not set" };
  const headers = { "Content-Type": "application/json" };
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  const body = JSON.stringify({ text: html, eventKey, inProgress: String(inProgress), assignAi: String(assignAi) });
  try {
    const r = await fetch(`${TED_BASE}/api/tasks/${taskId}/comments/ai`, { method: "POST", headers, body });
    const ct = r.headers.get("content-type") || "";
    if (/html/i.test(ct)) return { ok: false, error: "endpoint not deployed (got the TED web app, not the API)" };
    const payload = ct.includes("json") ? await r.json().catch(() => ({})) : {};
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, payload };
    return { ok: true, payload };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// Direct artifact push to TED — the screenshots / service-page content handed over as-is, so TED
// never has to fetch them back from product-service by deal id (a dependency that has repeatedly
// left task-close comments with no images/content: product-service down, or no deal id filed for a
// business with no local run yet). This does NOT replace the existing G99 status callback
// (postStatus/mirrorToParent) — that keeps firing unchanged, and product-service's own milestone
// webhook to TED stays fully functional as the fallback path. This is simply a second, more direct
// route for the two artifact-heavy events, since this process already holds the real data in memory.
async function tedPushArtifacts(eventType, { businessId, draftId, mockups, servicePages, siteUrl,
  hubspotDealId, hubspotCompanyId } = {}) {
  if (!TED_API_TOKEN) return { ok: false, error: "TED_API_TOKEN not set" };
  const headers = { "Content-Type": "application/json" };
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  const body = JSON.stringify({
    eventType, businessId, draftId,
    // companyId is TED's most reliable resolver (unique per client, unlike businessId which repeats
    // across clone/test businesses) — sent whenever product-service gave it to us at trigger time.
    dealId: hubspotDealId || null, companyId: hubspotCompanyId || null,
    mockups: (mockups || []).map(m => ({ label: m.label, url: m.url, dataUri: m.dataUri || null, error: m.error || null })),
    servicePages: (servicePages || []).map(p => ({
      name: p.name, slug: p.slug, status: p.status, engine: p.engine, sourceUrl: p.sourceUrl, brief: p.brief,
    })),
    siteUrl: siteUrl || null,
  });
  try {
    const r = await fetch(`${TED_BASE}/api/webhooks/onboarding/artifacts`, { method: "POST", headers, body });
    const ct = r.headers.get("content-type") || "";
    if (/html/i.test(ct)) return { ok: false, error: "endpoint not deployed (got the TED web app, not the API)" };
    const payload = ct.includes("json") ? await r.json().catch(() => ({})) : {};
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, payload };
    return { ok: true, payload };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---- Content review sessions -------------------------------------------------
// A content editor reviews the beta site itself and corrects the copy in place;
// the widget that lets them do it lives in review-plugin.js and renders only
// inside a session minted here.
//
// The token is the whole security model, so it is worth being explicit about
// what it is: an HMAC over {siteId, themeSlug, reviewer, expiry}. It is minted
// by an authenticated caller, spent once in a URL, and thereafter held only on
// the WordPress side. Nothing about the reviewer is trusted from the browser —
// the name shown in the widget comes back out of the token, not off the page.
const { reviewPluginSource } = require("./review-plugin.js");
const REVIEW_SECRET = process.env.REVIEW_SECRET || process.env.WEBHOOK_SECRET || process.env.ADMIN_PASSWORD || "";
const REVIEW_TTL_MIN = Number(process.env.REVIEW_TTL_MIN || 120);
const REVIEW_PLUGIN_PATH = "web/app/mu-plugins/g99-content-review.php";

const reviewSign = (body) => crypto.createHmac("sha256", REVIEW_SECRET).update(body).digest("base64url");

function mintReviewToken({ siteId, themeSlug, reviewer, email, dept, minutes }) {
  if (!REVIEW_SECRET) throw new Error("REVIEW_SECRET not set (falls back to WEBHOOK_SECRET or ADMIN_PASSWORD) — cannot mint review links");
  const exp = Date.now() + Math.max(5, Number(minutes) || REVIEW_TTL_MIN) * 60000;
  const body = Buffer.from(JSON.stringify({ v: 1, siteId, themeSlug, reviewer, email: email || "", dept: dept || "", exp })).toString("base64url");
  return { token: `${body}.${reviewSign(body)}`, exp };
}

// Returns the payload or null. Never throws and never explains which half
// failed: a caller holding a bad token learns only that it is not usable.
function verifyReviewToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !REVIEW_SECRET) return null;
  const want = reviewSign(body);
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let d = null;
  try { d = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!d || !d.exp || Date.now() > d.exp) return null;
  return d;
}

// Which job belongs to which session, without keeping the token itself around.
const reviewSig = (token) => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);

// WordPress texturises quotes and dashes on the way out, so the sentence a
// reviewer selected on screen ("don't") is often not the sentence in the
// template ("don't"). Without these the swap silently matches nothing and the
// change is reported as done-but-not-found. Ordered most to least likely.
// Both directions, because the source can be either. wptexturize() turns a
// straight quote in the template into a curly one on screen, so the text a
// reviewer copies is usually the curly form of a straight source — but the copy
// is AI-written and Gemini emits curly punctuation into the template often
// enough that the reverse happens too. Entity spellings are included because a
// template may hold &#039; where the page shows an apostrophe.
function reviewTextVariants(s) {
  const src = String(s);
  const out = new Set();
  const straight = src
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/—/g, "--").replace(/–/g, "-").replace(/…/g, "...");
  const curly = straight
    .replace(/'/g, "’").replace(/--/g, "—").replace(/\.\.\./g, "…")
    .replace(/"([^"]*)"/g, "“$1”");
  for (const form of [straight, curly]) {
    out.add(form);
    out.add(form.replace(/&/g, "&amp;"));
    out.add(form.replace(/'/g, "&#039;"));
    out.add(form.replace(/'/g, "&#39;"));
    out.add(form.replace(/’/g, "&#8217;"));
  }
  out.delete(src);
  return [...out].filter(Boolean);
}

// Everything a review run needs, taken from the token alone. The token is signed
// and already carries the siteId and the theme it was minted against, and the
// paths below are the same formula resolveEditTarget() uses — so a correction can
// still be applied when NocoDB or GitHub cannot be reached, which on a laptop
// (or a dropped VPN) is often. No repository, so it is only enough for a local
// run; a live one still needs the real row.
function reviewTargetFromToken(d) {
  const slug = String(d.themeSlug || "");
  const bare = slug.replace(/^g99-/, "");
  return {
    site: { siteId: d.siteId, businessName: d.siteId, githubRepo: "", liveUrl: "" },
    target: {
      themeSlug: slug,
      themePath: `web/app/themes/${slug}`,
      muPath: slug.startsWith("g99-") ? `web/app/mu-plugins/g99-activate-${bare}.php` : "",
    },
  };
}

// One site row + its theme paths, by siteId or by business name. Reads the cache
// first: a reviewer submitting six corrections should not force six full NocoDB
// refreshes, and the list changes far more slowly than batches arrive.
async function resolveReviewSite(idOrName) {
  const want = String(idOrName || "").trim();
  if (!want) throw new Error("siteId or businessName required");
  let sites = await getWebsites(false).catch(() => []);
  if (!sites.some((s) => s.siteId === want || tedNorm(s.businessName) === tedNorm(want))) sites = await getWebsites(true);
  const hits = sites.filter((s) => s.siteId === want)
    .concat(sites.filter((s) => tedNorm(s.businessName) === tedNorm(want)));
  const site = hits[0];
  if (!site) throw new Error(`no site matches "${want}"`);
  if (!site.githubRepo) throw new Error(`${site.businessName} has no repository in NocoDB`);
  const target = await resolveEditTarget(site);
  return { site, target };
}

// A batch from the widget becomes a work order with the exact pairs already in
// it, so buildWorkOrder() — and the model behind it — is never asked to infer
// what "change X to Y" meant. applyTextSwaps() settles every item in code.
function reviewWorkOrder(changes, { reviewer, pagePath }) {
  const items = changes.slice(0, 40).map((c) => ({
    what: `Replace "${String(c.original).slice(0, 70)}" with "${String(c.replacement).slice(0, 70)}"`,
    where: pagePath,
    replaces: String(c.original),
    literal: String(c.replacement),
    variants: reviewTextVariants(c.original),
  }));
  return {
    summary: `${items.length} content correction${items.length > 1 ? "s" : ""} from ${reviewer} on ${pagePath}`,
    changes: items, constraints: [], unclear: [],
  };
}

// Where a correction made on one page is allowed to land, most specific first.
// A reviewer looking at the homepage means the homepage: the fact that the same
// sentence also sits in five other templates is not permission to rewrite them.
// Shared chrome is a second tier rather than a peer, so a footer edit still
// works while a body edit can never reach the footer by accident.
function reviewSwapTiers(pagePath, muSrc, themePath) {
  const slug = String(pagePath || "/").replace(/^\/+|\/+$/g, "").split("/")[0].toLowerCase();
  let template = "front-page.php";
  if (slug) {
    const hit = readMuPages(muSrc).find((p) => String(p.slug).toLowerCase() === slug);
    template = (hit && hit.template) || `page-${slug}.php`;
  }
  return [
    [`${themePath}/${template}`],
    [`${themePath}/header.php`, `${themePath}/footer.php`],
  ];
}

// Apply a review batch straight into a local working tree, with no git at all.
// This is what makes a laptop dry run mean something: the corrections land in
// the same checkout a local WordPress is serving, so the reviewer types a change,
// refreshes, and sees it — while nothing is cloned, pushed, merged or deployed.
//
// It deliberately runs the SAME applyTextSwaps options a live job runs, so a
// change that is refused here is refused in production for the same reason. A
// rehearsal that is more permissive than the real thing teaches nothing.
function applyReviewLocally(root, target, pagePath, workOrder) {
  const themeAbs = path.join(root, target.themePath);
  if (!fs.existsSync(themeAbs)) throw new Error(`REVIEW_LOCAL_REPO has no ${target.themePath}`);
  const files = fs.readdirSync(themeAbs).filter((f) => /\.php$/i.test(f))
    .map((f) => ({ rel: `${target.themePath}/${f}`, content: fs.readFileSync(path.join(themeAbs, f), "utf8") }));
  let muSrc = "";
  if (target.muPath && fs.existsSync(path.join(root, target.muPath))) {
    muSrc = fs.readFileSync(path.join(root, target.muPath), "utf8");
    files.push({ rel: target.muPath, content: muSrc });
  }
  const refused = [];
  const applied = applyTextSwaps(workOrder, files, root, {
    tiers: reviewSwapTiers(pagePath, muSrc, target.themePath),
    maxHits: 5, visibleOnly: true, wordSafe: true, refused,
  });
  // Same rule as a live run: anything the swap could not place is reported, never
  // guessed at by a model.
  workOrder.changes.forEach((c, i) => {
    if (applied.some((a) => a.n === i + 1) || refused.some((r) => r.n === i + 1)) return;
    refused.push({
      n: i + 1, what: c.what, hits: 0,
      reason: `"${String(c.replaces).slice(0, 60)}" could not be matched exactly on ${pagePath} — if it runs across a line break, change one line at a time.`,
    });
  });
  return { applied, refused };
}

// Install the review plugin into a site's repository. One-time per repo, and
// deliberately PR-only: this adds a file that runs on every request of a client
// site, which is a thing a person should look at once before it ships.
async function installReviewPlugin(site, toolUrl) {
  const repo = site.githubRepo;
  const tmp = path.join(os.tmpdir(), "g99review-" + Date.now());
  try {
    let r = await sh(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = await ghCloneUrl(repo);
    if (r.code) r = await sh(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (/x-access-token:/.test(cloneUrl)) await sh(`git remote set-url origin "${cloneUrl}"`, tmp);

    const abs = path.join(tmp, REVIEW_PLUGIN_PATH);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, reviewPluginSource(toolUrl));

    const branch = `g99/content-review-${Date.now()}`;
    await sh(`git checkout -b "${branch}"`, tmp);
    await sh(`git add -A "${REVIEW_PLUGIN_PATH}"`, tmp);
    r = await sh(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "${existed ? "Update" : "Add"} the content-review plugin"`, tmp);
    if (r.code) return { ok: true, upToDate: true, prUrl: null };   // identical file already in main
    r = await sh(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    const body = `Adds the in-page content-review widget for content editors.\\n\\n`
      + `Renders nothing unless the visitor arrived through a signed review link, holds no secret, `
      + `and posts only to this site (which forwards to the build tool server-side).\\n\\n`
      + `Delete ${REVIEW_PLUGIN_PATH} to switch it off.`;
    r = await sh(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${existed ? "Update" : "Add"} content-review plugin" --body "${body}"`, tmp);
    const prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    if (!prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    return { ok: true, prUrl, branch };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  }
}

// Pick ONE service page to audit when the caller didn't name one. Real service pages usually live
// under /services/ (the home nav often only links the listing), so scan that first, then the home
// page as a fallback. Skips structural / non-service paths.
async function wqDiscoverService(baseUrl) {
  const NON_SERVICE = new Set(["about", "contact", "services", "team", "brand-guide", "blog", "privacy",
    "terms", "home", "sitemap", "wp-content", "wp-admin", "wp-json", "wp-includes", "feed", "gallery",
    "reviews", "app", "assets", "themes", "cart", "checkout", "account", "shop", "careers", "faq"]);
  const root = String(baseUrl).replace(/\/+$/, "");
  const scan = async (url) => {
    try {
      const html = await (await fetch(url)).text();
      const re = /href="([^"]+)"/gi; let m; const out = [];
      while ((m = re.exec(html))) {
        const mm = m[1].match(/^(?:https?:\/\/[^/]+)?\/([a-z0-9][a-z0-9-]{2,})\/?$/i);
        if (!mm) continue;
        const slug = mm[1].toLowerCase();
        if (!NON_SERVICE.has(slug)) out.push(slug);
      }
      return out;
    } catch (e) { return []; }
  };
  for (const url of [`${root}/services/`, `${root}/`]) {
    const found = await scan(url);
    if (found.length) {
      const slug = found[0];
      return { name: slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()), slug };
    }
  }
  return null;
}

// Dedupe (case-insensitive), trim blanks, cap to n.
function wqUniqTop(arr, n) {
  const seen = new Set(), out = [];
  for (const x of (arr || [])) {
    const s = String(x == null ? "" : x).trim(); if (!s) continue;
    const k = s.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push(s); if (out.length >= n) break;
  }
  return out;
}

// Build the comment HTML. Only tags sanitizeCommentHtml keeps: strong/em/p/ul/li/a/br, plus
// <img src="data:…"> and the comment-shots/comment-shot structural classes (same markup TED itself
// uses for build mockups, so the images render and open full-size).
function wireframeQaReportHtml(d) {
  const P = [];
  P.push(`<p><strong>🔍 Wireframe QA — CRO audit</strong></p>`);
  if (d.isTestUrl) {
    P.push(`<p><em>⚠️ No beta site URL on record for this client — audited a stand-in test site: `
      + `<a href="${esc(d.betaUrl)}">${esc(d.betaUrl)}</a>. Scores are indicative, not this client's own site.</em></p>`);
  } else {
    P.push(`<p>Audited site: <a href="${esc(d.betaUrl)}">${esc(d.betaUrl)}</a></p>`);
  }
  P.push(`<p><strong>Overall CRO score: ${d.avg.overall} / 100</strong> <em>(whole-site average of ${d.pages.length} pages)</em></p>`);
  P.push(`<p>Discipline scores — <strong>Visual</strong> ${d.avg.vision.score} · <strong>UX</strong> ${d.avg.ux.score} · `
    + `<strong>CRO</strong> ${d.avg.cro.score} · <strong>Content</strong> ${d.avg.content.score}</p>`);
  if (d.strengths.length) P.push(`<p><strong>✅ What's working</strong></p><ul>${d.strengths.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`);
  if (d.weaknesses.length) P.push(`<p><strong>⚠️ What's missing / weak</strong></p><ul>${d.weaknesses.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`);
  if (d.recs.length) P.push(`<p><strong>Top recommendations</strong></p><ul>${d.recs.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`);
  if (d.perPage.length) P.push(`<p><strong>Per-page scores</strong></p><ul>`
    + d.perPage.map(p => `<li><strong>${esc(p.label)}</strong> — ${p.overall}/100${p.error ? ` <em>(audit failed: ${esc(p.error)})</em>` : ""}</li>`).join("") + `</ul>`);

  // One shared byte budget across BOTH screenshot groups so the comment never overflows TED.
  let budget = WIREFRAME_QA_BUDGET_BYTES;
  const imgTag = (uri, label) => {
    const fname = String(label || "img").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    return `<img src="${esc(uri)}" alt="${esc(label)}" data-attachment-type="image" data-filename="${esc(fname)}.png">`;
  };

  // --- Responsive & accessibility (measured on Home) --------------------------
  const r = d.responsive;
  if (r && !r.error) {
    const sc = (v) => (v == null ? "—" : v);
    P.push(`<p><strong>📱 Responsive & accessibility</strong> <em>(measured on Home)</em></p>`);
    P.push(`<p><strong>Mobile</strong> ${sc(r.mobile && r.mobile.score)}/100 · `
      + `<strong>Tablet</strong> ${sc(r.tablet && r.tablet.score)}/100 <em>(visual)</em> · `
      + `<strong>Desktop</strong> ${sc(r.desktop && r.desktop.score)}/100 · `
      + `<strong>Accessibility (WCAG)</strong> ${sc(r.accessibility && r.accessibility.score)}/100</p>`);
    const notes = [];
    if (r.mobile && r.mobile.note) notes.push(`<li><strong>Mobile:</strong> ${esc(r.mobile.note)}</li>`);
    if (r.tablet && r.tablet.note) notes.push(`<li><strong>Tablet:</strong> ${esc(r.tablet.note)}</li>`);
    if (r.desktop && r.desktop.note) notes.push(`<li><strong>Desktop:</strong> ${esc(r.desktop.note)}</li>`);
    if (notes.length) P.push(`<ul>${notes.join("")}</ul>`);
    const LABEL = {
      "viewport": "Viewport meta tag", "content-width": "No horizontal scroll (content fits the screen)",
      "tap-targets": "Tap targets large enough (mobile)", "color-contrast": "Sufficient colour contrast (WCAG)",
      "image-alt": "Images have alt text", "document-title": "Page has a title",
      "html-has-lang": "HTML lang attribute set", "heading-order": "Headings in order", "link-name": "Links have names",
    };
    const seen = new Set(), rows = [];
    for (const a of [].concat((r.mobile && r.mobile.checks) || [], (r.accessibility && r.accessibility.checks) || [])) {
      if (!a || a.pass == null || seen.has(a.id)) continue;
      seen.add(a.id);
      rows.push(`<li>${a.pass ? "✅" : "⚠️"} ${esc(LABEL[a.id] || a.title || a.id)}${a.display ? ` <em>(${esc(a.display)})</em>` : ""}</li>`);
    }
    if (rows.length) P.push(`<p><strong>Checks</strong></p><ul>${rows.join("")}</ul>`);
    const vshots = [["Mobile — 375px", r.shots && r.shots.mobile], ["Tablet — 768px", r.shots && r.shots.tablet], ["Desktop — 1280px", r.shots && r.shots.desktop]];
    const vHtml = [];
    for (const [lab, uri] of vshots) {
      if (!uri || uri.length > budget) continue;
      budget -= uri.length;
      vHtml.push(`<div class="comment-shot"><div class="comment-shot-label"><strong>${esc(lab)}</strong></div>${imgTag(uri, lab)}</div>`);
    }
    if (vHtml.length) P.push(`<p><strong>Responsive screenshots (Home)</strong></p><div class="comment-shots">${vHtml.join("")}</div>`);
  }

  // --- Per-page QA screenshots (share the remaining budget) -------------------
  const shotHtml = []; let shown = 0; const skipped = [];
  for (const s of d.shots) {
    if (!s.dataUri) continue;
    if (s.dataUri.length > budget) { skipped.push(s.label); continue; }
    budget -= s.dataUri.length; shown++;
    shotHtml.push(`<div class="comment-shot"><div class="comment-shot-label"><strong>${shown}. ${esc(s.label)}</strong>`
      + (s.url ? ` <a href="${esc(s.url)}">${esc(s.url)}</a>` : "") + `</div>${imgTag(s.dataUri, s.label)}</div>`);
  }
  if (shown) {
    P.push(`<p><strong>QA screenshots — ${shown} ${shown === 1 ? "page" : "pages"}</strong> <em>(click any image for full size)</em></p>`);
    P.push(`<div class="comment-shots">${shotHtml.join("")}</div>`);
  }
  if (skipped.length) P.push(`<p><em>Screenshots not attached (size limit): ${esc(skipped.join(", "))}</em></p>`);
  P.push(`<p><em>AI UX Inspector · audited ${esc(d.pages.map(p => p.label).join(", "))} · ${esc(d.when)}</em></p>`);
  return P.join("");
}

// Run the audit and (optionally) post it to TED. Returns a structured result for the route / test.
async function wireframeQaAudit(opts = {}) {
  const {
    betaUrl, tedTaskId = null, prereqTaskId = null,
    services = null, serviceSlug = null, serviceName = null,
    isTestUrl = false, postToTed = true,
  } = opts;
  if (!betaUrl) return { ok: false, error: "betaUrl required" };
  const root = String(betaUrl).replace(/\/+$/, "");

  // Resolve the one service page: explicit array > explicit slug > discovered from the home page.
  let svc = null;
  if (Array.isArray(services) && services.find(s => s && s.slug)) svc = services.find(s => s && s.slug);
  else if (serviceSlug) svc = { name: serviceName || serviceSlug, slug: serviceSlug };
  else svc = await wqDiscoverService(root + "/");

  const pages = [
    { label: "Home", url: `${root}/` },
    ...(svc ? [{ label: `Service — ${svc.name}`, url: `${root}/${svc.slug}/` }] : []),
    { label: "About", url: `${root}/about/` },
    { label: "Contact", url: `${root}/contact/` },
  ];

  // 1) CRO audit each page (sequential — Gemini RPM), keep per-page + merged whole-site score.
  const reports = [];
  for (const pg of pages) {
    try {
      const rep = await croAudit({ url: pg.url, label: pg.label });
      reports.push({ ...rep, label: pg.label });
    } catch (e) {
      reports.push({ label: pg.label, overall: 0, error: String(e.message || e),
        vision: { score: 0 }, ux: { score: 0 }, cro: { score: 0 }, content: { score: 0 }, summary: {} });
    }
    await sleep(800);
  }
  const good = reports.filter(r => !r.error);
  const avg = croAverage(good.length ? good : reports, `Wireframe QA (${(good.length || reports.length)} pages)`);

  const strengths = wqUniqTop(good.flatMap(r => (r.summary && r.summary.strengths) || []), 5);
  const weaknesses = wqUniqTop([
    ...good.flatMap(r => (r.summary && r.summary.weaknesses) || []),
    ...good.flatMap(r => (r.cro && r.cro.issues) || []),
  ], 6);
  const recs = wqUniqTop(good.flatMap(r => (r.summary && r.summary.topRecommendations) || []), 5);

  // 2) Screenshots (PSI data URIs) of the same page set.
  let shots = [];
  try { shots = await captureMockups(root, svc ? [svc] : []); } catch (e) { shots = []; }

  // 2b) Responsive + accessibility on Home (mobile/tablet/desktop). Never fatal.
  let responsive = null;
  try { responsive = await responsiveAudit(`${root}/`); } catch (e) { responsive = { error: String(e.message || e) }; }

  // 3) Build the comment HTML.
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const html = wireframeQaReportHtml({ betaUrl: root + "/", isTestUrl, pages, avg, strengths, weaknesses, recs, shots, responsive,
    perPage: reports.map(r => ({ label: r.label, overall: r.overall || 0, error: r.error || null })), when });

  const result = {
    ok: true, betaUrl: root + "/", isTestUrl, overall: avg.overall,
    disciplines: { vision: avg.vision.score, ux: avg.ux.score, cro: avg.cro.score, content: avg.content.score },
    perPage: reports.map(r => ({ label: r.label, overall: r.overall || 0, error: r.error || null })),
    strengths, weaknesses, recs,
    responsive: responsive && !responsive.error
      ? { mobile: responsive.mobile.score, tablet: responsive.tablet.score, desktop: responsive.desktop.score, accessibility: responsive.accessibility.score }
      : null,
    screenshots: shots.map(s => ({ label: s.label, url: s.url, ok: !!s.dataUri, error: s.error || null })),
    htmlLength: html.length, posted: null, prereq: null,
  };

  if (!postToTed || !tedTaskId) { result.posted = { skipped: "post disabled or no tedTaskId" }; return result; }

  // 4) Gate on the prerequisite task (e.g. mockup.create) being Completed.
  if (prereqTaskId) {
    const pre = await tedGetTask(prereqTaskId);
    result.prereq = { id: prereqTaskId, status: pre ? pre.status : "unreachable" };
    if (!pre || String(pre.status).toLowerCase() !== "completed") {
      result.posted = { skipped: `prereq task ${prereqTaskId} not Completed (status=${pre ? pre.status : "unreachable"})` };
      return result;
    }
  }

  // 5) Post: In Progress + AI-assigned + comment. Idempotent via a stable eventKey.
  const eventKey = `wireframe-qa:${tedTaskId}:${root}`;
  result.posted = await tedAiResult(tedTaskId, html, { eventKey, inProgress: true, assignAi: true });
  return result;
}

// ---- Responsive & accessibility audit (hybrid: PSI/Lighthouse facts + Gemini visual) ----------
function wqSplitDataUri(u) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(u || "");
  return m ? { mime: m[1], b64: m[2] } : null;
}

// A screenshot at a given viewport width, as a compact JPEG data URI (for the responsive strip).
async function wqShotAt(url, width) {
  const shot = await microlinkShot(url, `&type=jpeg&quality=55&viewport.width=${width}`, 20000);
  return shot ? `data:${shot.contentType};base64,${shot.buf.toString("base64")}` : null;
}

// One PSI/Lighthouse run: accessibility score + the responsive/a11y audits + a viewport screenshot.
// `strategy` = "mobile" | "desktop". tap-targets is mobile-only (absent → pass:null, ignored).
async function wqPsi(url, strategy) {
  if (!PSI_API_KEY) return { error: "PSI_API_KEY not set" };
  try {
    const api = `${PSI_ENDPOINT}?url=${encodeURIComponent(url)}&key=${PSI_API_KEY}`
      + `&strategy=${strategy}&category=performance&category=accessibility`;
    const res = await fetch(api);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("json")) return { error: `PSI ${strategy} returned ${ct || "no type"} (HTTP ${res.status})` };
    const body = await res.json();
    if (body.error) return { error: `PSI ${strategy}: ${String(body.error.message || "").slice(0, 120)}` };
    const lr = body.lighthouseResult || {};
    const A = lr.audits || {};
    const info = (id) => {
      const a = A[id];
      if (!a) return null;
      return { id, title: a.title, pass: a.score == null ? null : a.score >= 0.9, display: a.displayValue || null };
    };
    const ids = ["viewport", "content-width", "tap-targets", "color-contrast", "image-alt",
      "document-title", "html-has-lang", "heading-order", "link-name"];
    const shot = lr.fullPageScreenshot && lr.fullPageScreenshot.screenshot;
    return {
      accessibilityScore: (lr.categories && lr.categories.accessibility && lr.categories.accessibility.score != null)
        ? Math.round(lr.categories.accessibility.score * 100) : null,
      audits: ids.map(info).filter(Boolean),
      screenshotDataUri: (shot && shot.data && String(shot.data).startsWith("data:image/")) ? shot.data : null,
    };
  } catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

// Gemini looks at the three viewport screenshots and rates how well the layout holds at each width.
async function wqViewportScores(shots) {
  const parts = [{
    text: "You are a senior responsive-web QA reviewer for a LUXURY MEDSPA website. Three screenshots"
      + " follow in order — MOBILE (375px), TABLET (768px), DESKTOP (1280px). For EACH width rate 0-100"
      + " how well the layout works (no horizontal overflow, legible text, tappable/clickable controls,"
      + " sensible spacing, nothing broken or overlapping) and give ONE short note. Return ONLY JSON:"
      + ' {"mobile":{"score":0-100,"note":"..."},"tablet":{"score":0-100,"note":"..."},"desktop":{"score":0-100,"note":"..."}}',
  }];
  for (const uri of [shots.mobile, shots.tablet, shots.desktop]) {
    const d = wqSplitDataUri(uri);
    if (d) parts.push({ inline_data: { mime_type: d.mime, data: d.b64 } });
  }
  if (parts.length === 1) return {};
  try {
    const t = await geminiCall(parts, { temperature: 0.3, maxOutputTokens: 1500 });
    return JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
  } catch (e) { return {}; }
}

// Blend the deterministic pass-ratio (0..1) with the Gemini visual score (0..100), 60/40.
function wqBlend(det, vis) {
  if (det == null && vis == null) return null;
  if (det == null) return Math.round(vis);
  if (vis == null) return Math.round(det * 100);
  return Math.round(det * 100 * 0.6 + vis * 0.4);
}

// Per-viewport responsive scores + a WCAG accessibility mini-audit for ONE page (Home). Mobile and
// Desktop are backed by Lighthouse facts (blended with the visual read); Tablet is visual-only
// because PSI has no tablet strategy. Never throws — degrades to whatever succeeded.
async function responsiveAudit(url) {
  const [mob, desk] = await Promise.all([wqPsi(url, "mobile"), wqPsi(url, "desktop")]);
  const shots = {
    mobile: (mob && mob.screenshotDataUri) || await wqShotAt(url, 375),
    tablet: await wqShotAt(url, 768),
    desktop: (desk && desk.screenshotDataUri) || await wqShotAt(url, 1280),
  };
  const vis = await wqViewportScores(shots);
  const ratio = (res, ids) => {
    if (!res || res.error || !res.audits) return null;
    const rel = res.audits.filter(a => ids.includes(a.id) && a.pass != null);
    return rel.length ? rel.filter(a => a.pass).length / rel.length : null;
  };
  const A11Y_IDS = ["color-contrast", "image-alt", "document-title", "html-has-lang", "heading-order", "link-name"];
  return {
    mobile: {
      score: wqBlend(ratio(mob, ["viewport", "content-width", "tap-targets"]), vis.mobile && vis.mobile.score),
      note: vis.mobile && vis.mobile.note,
      checks: (mob && mob.audits) ? mob.audits.filter(a => ["viewport", "content-width", "tap-targets"].includes(a.id)) : [],
    },
    tablet: { score: (vis.tablet && vis.tablet.score != null) ? Math.round(vis.tablet.score) : null, note: vis.tablet && vis.tablet.note },
    desktop: {
      score: wqBlend(ratio(desk, ["viewport", "content-width"]), vis.desktop && vis.desktop.score),
      note: vis.desktop && vis.desktop.note,
      checks: (desk && desk.audits) ? desk.audits.filter(a => ["viewport", "content-width"].includes(a.id)) : [],
    },
    accessibility: {
      score: (mob && mob.accessibilityScore != null) ? mob.accessibilityScore : (desk && desk.accessibilityScore),
      checks: (mob && mob.audits) ? mob.audits.filter(a => A11Y_IDS.includes(a.id)) : [],
    },
    shots,
    error: (mob && mob.error && desk && desk.error) ? (mob.error) : null,
  };
}

// GET a client's site URLs from TED (id-free: the webhook gives a clientId, TED knows the URL).
async function tedGetClientInfo(clientId) {
  if (!TED_API_TOKEN || !clientId) return null;
  const headers = {};
  if (TED_AUTH_HEADER === "x-api-key") headers["X-Api-Key"] = TED_API_TOKEN;
  else headers["Authorization"] = "Bearer " + TED_API_TOKEN;
  try {
    const r = await fetch(`${TED_BASE}/api/clients/${clientId}/info`, { headers });
    if (!r.ok) return null;
    if (/html/i.test(r.headers.get("content-type") || "")) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Stand-in site when a client has no beta URL yet (rule 7.1: audit it and flag it).
const WIREFRAME_QA_TEST_URL = process.env.WIREFRAME_QA_TEST_URL || "https://prodteam1.gogroth.com/";

const WQ_STEPS = [
  "Resolve beta site URL",
  "Discover pages",
  "CRO audit (Home + Service + About + Contact)",
  "Responsive & accessibility (mobile/tablet/desktop)",
  "Capture screenshots",
  "Compose CRO report",
  "Post to TED wireframe QA task",
];

function newWireframeAuditJob(payload) {
  return {
    type: "wireframe-audit",
    draftId: String(payload.draftId || ("wfqa-" + (payload.clientId || "x") + "-" + Date.now())),
    businessId: payload.businessId || null,
    businessName: payload.clientName || payload.businessName || ("Client " + (payload.clientId || "?")),
    status: "queued", currentStep: 0,
    steps: WQ_STEPS.map((label) => ({ label, status: "pending", detail: "" })),
    payload, liveUrl: null, error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null,
  };
}

// Queue a visible wireframe-audit job. Deduped: one non-terminal job per target task.
function enqueueWireframeAuditJob(payload) {
  for (const j of JOBS.values()) {
    if (j.type === "wireframe-audit" && j.payload
        && String(j.payload.targetTaskId) === String(payload.targetTaskId)
        && (j.status === "queued" || j.status === "running")) {
      return j;
    }
  }
  const job = newWireframeAuditJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId); saveJobs();
  processJobQueue();
  return job;
}

// The visible job: resolve URL → audit → screenshots → report → post to the TED task the webhook
// handed us. Reuses croAudit/captureMockups/wireframeQaReportHtml/tedAiResult, but drives the steps
// so the run is watchable in the Studio UI.
async function runWireframeAudit(job) {
  job.status = "running"; job.startedAt = new Date().toISOString();
  const P = job.payload;                        // { clientId, targetTaskId, targetTemplateKey, clientName }
  const targetTaskId = P.targetTaskId;
  try {
    // 1 — beta URL, from client-info or a flagged stand-in.
    jobStep(job, 0, "running", "Looking up client " + (P.clientId || "?"));
    let betaUrl = P.betaUrl || null, isTestUrl = false;
    if (!betaUrl && P.clientId) {
      const info = await tedGetClientInfo(P.clientId);
      betaUrl = (info && (info.betaSiteUrl || info.liveSiteUrl)) || null;
    }
    if (!betaUrl) { betaUrl = WIREFRAME_QA_TEST_URL; isTestUrl = true; }
    job.liveUrl = betaUrl;
    jobStep(job, 0, "done", (isTestUrl ? "No client beta URL — test site " : "Beta URL ") + betaUrl);
    const root = String(betaUrl).replace(/\/+$/, "");

    // 2 — one service page + the fixed set.
    jobStep(job, 1, "running", "Scanning /services/ + home");
    const svc = await wqDiscoverService(root + "/");
    const pages = [
      { label: "Home", url: `${root}/` },
      ...(svc ? [{ label: `Service — ${svc.name}`, url: `${root}/${svc.slug}/` }] : []),
      { label: "About", url: `${root}/about/` },
      { label: "Contact", url: `${root}/contact/` },
    ];
    jobStep(job, 1, "done", pages.map(p => p.label).join(", "));

    // 3 — CRO audit each page (sequential — Gemini RPM).
    jobStep(job, 2, "running", `Auditing ${pages.length} pages`);
    const reports = [];
    for (const pg of pages) {
      try { reports.push({ ...(await croAudit({ url: pg.url, label: pg.label })), label: pg.label }); }
      catch (e) { reports.push({ label: pg.label, overall: 0, error: String(e.message || e), vision: { score: 0 }, ux: { score: 0 }, cro: { score: 0 }, content: { score: 0 }, summary: {} }); }
      await sleep(800);
    }
    const good = reports.filter(r => !r.error);
    const avg = croAverage(good.length ? good : reports, `Wireframe QA (${(good.length || reports.length)} pages)`);
    jobStep(job, 2, "done", `Overall CRO ${avg.overall}/100`);

    // 4 — responsive + accessibility on Home (mobile/tablet/desktop). Never fatal.
    jobStep(job, 3, "running", "Mobile / Tablet / Desktop + WCAG");
    let responsive = null;
    try { responsive = await responsiveAudit(`${root}/`); } catch (e) { responsive = { error: String(e.message || e) }; }
    if (responsive && !responsive.error) {
      jobStep(job, 3, "done", `Mobile ${responsive.mobile.score ?? "—"} · Tablet ${responsive.tablet.score ?? "—"} · Desktop ${responsive.desktop.score ?? "—"} · a11y ${responsive.accessibility.score ?? "—"}`);
    } else {
      jobStep(job, 3, "done", "Skipped: " + ((responsive && responsive.error) || "no data"));
    }

    // 5 — screenshots (the 4 page captures).
    jobStep(job, 4, "running", "PSI screenshots");
    let shots = [];
    try { shots = await captureMockups(root, svc ? [svc] : []); } catch (e) { shots = []; }
    jobStep(job, 4, "done", `${shots.filter(s => s.dataUri).length}/${shots.length} captured`);

    // 6 — report HTML.
    jobStep(job, 5, "running", "Building comment");
    const strengths = wqUniqTop(good.flatMap(r => (r.summary && r.summary.strengths) || []), 5);
    const weaknesses = wqUniqTop([...good.flatMap(r => (r.summary && r.summary.weaknesses) || []),
      ...good.flatMap(r => (r.cro && r.cro.issues) || [])], 6);
    const recs = wqUniqTop(good.flatMap(r => (r.summary && r.summary.topRecommendations) || []), 5);
    const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const html = wireframeQaReportHtml({ betaUrl: root + "/", isTestUrl, pages, avg, strengths, weaknesses, recs, shots, responsive,
      perPage: reports.map(r => ({ label: r.label, overall: r.overall || 0, error: r.error || null })), when });
    job.result = { overall: avg.overall, isTestUrl, betaUrl: root + "/", pages: pages.length,
      disciplines: { vision: avg.vision.score, ux: avg.ux.score, cro: avg.cro.score, content: avg.content.score },
      responsive: responsive && !responsive.error ? { mobile: responsive.mobile.score, tablet: responsive.tablet.score, desktop: responsive.desktop.score, accessibility: responsive.accessibility.score } : null };
    jobStep(job, 5, "done", `Report ${Math.round(html.length / 1024)}KB`);

    // 7 — post to the TED task the webhook resolved. Never closes it.
    jobStep(job, 6, "running", "Posting to task " + targetTaskId);
    if (!targetTaskId) {
      jobStep(job, 6, "done", "No target task — report computed only");
    } else {
      const eventKey = `wireframe-qa:${targetTaskId}:${P.clientId || root}`;
      const posted = await tedAiResult(targetTaskId, html, { eventKey, inProgress: true, assignAi: true });
      job.result.posted = posted;
      if (posted.ok) jobStep(job, 6, "done", "Posted to task " + targetTaskId + " (In Progress + AI-assigned)");
      else jobStep(job, 6, "error", "Post failed: " + (posted.error || "?"));
    }
    job.status = "done"; job.finishedAt = new Date().toISOString(); saveJobs();
  } catch (e) {
    job.error = String(e.message || e); job.status = "error";
    const cs = job.steps[job.currentStep];
    if (cs && cs.status === "running") { cs.status = "error"; cs.detail = job.error.slice(0, 240); }
    job.finishedAt = new Date().toISOString(); saveJobs();
    console.error("[wireframe-audit] failed:", job.error);
  }
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
    steps: (job.steps || []).map((s) => ({ key: s.key || null, label: s.label, status: s.status, detail: s.detail })),
    // Explicit, unambiguous signal for G99's SERVICE_PAGES_CREATED. Null until that step is done.
    servicePagesCreatedAt: job.servicePagesCreatedAt || null,
    // What was actually written on each service page, and the review screenshots. Sent on the
    // callback rather than left here to be fetched: this server keeps nothing across a redeploy,
    // so completion is the only moment the data is guaranteed to still exist.
    //
    // serviceDetail FIRST, not servicePages: servicePages is selectServices() output and carries
    // only {name, slug}. The engine, the existing-site page each one was grounded in, and the brief
    // are recorded on serviceDetail by svcStatus() as generation progresses. Reading servicePages
    // yields four permanent nulls. Fall back to it only so a run that never reached brief
    // composition still reports which pages were planned.
    servicePages: (job.serviceDetail && job.serviceDetail.length
      ? job.serviceDetail
      : job.servicePages || []
    ).map((p) => ({
      name: p.name || null,
      slug: p.slug || null,
      status: p.status || null,
      engine: p.engine || null,
      sourceUrl: p.sourceUrl || null,
      // Full stored brief (serviceDetail already caps at 3000). It lands in a downloadable .txt on
      // the TED task, so truncating here would throw away the thing that file exists to carry.
      brief: p.brief ? String(p.brief) : null,
    })),
    mockups: (job.mockups || []).map((m) => ({
      label: m.label, url: m.url, dataUri: m.dataUri || null, error: m.error || null,
    })),
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

// ---- Emission audit ----------------------------------------------------------
// Why this exists: the callback to G99 was fire-and-forget and recorded NOTHING on the job. When a
// TED task did not close, there was no way from this tool to tell whether the event had left here
// at all, been rejected, or been accepted and ignored downstream — the only evidence was a console
// line on an ephemeral Render dyno. Two hops get their own status, because they fail separately:
//
//   productService — did our HTTP POST reach g99-product-service and get accepted?
//   ted            — did that callback WRITE a ledger event? TED polls the ledger, so a callback
//                    that writes no event (repeated step transition, row already terminal) is a
//                    perfectly successful POST that TED will never see. product-service echoes the
//                    event types it wrote, which is what lets us tell those two apart.
//
// "ted: ok" therefore means "the event TED reads exists", not "TED processed it" — TED pulls and
// acks nothing back, so that is the strongest claim this side can honestly make.
function emitAudit(job) {
  if (!job.emit) {
    job.emit = {
      productService: { state: "pending", at: null, attempts: 0, httpStatus: null, error: null },
      ted: { state: "pending", at: null, events: [], error: null },
      // type -> { at, step, status }: when each ledger event was FIRST written, and which pipeline
      // step the job was on at the time. First write wins — a later duplicate callback must not
      // move the timestamp, or "when did content creation emit" answers with the wrong moment.
      eventLog: {},
      // step index -> one row per pipeline step describing the callbacks posted while the job was
      // on it: { firstAt, lastAt, attempts, httpStatus, status, events[], error }.
      // Separate from history (which is capped at 12 and is a flat tail): keyed by step, it is
      // bounded by the step count and never loses the early steps of a long build.
      stepLog: {},
      history: [],
    };
  }
  if (!job.emit.eventLog) job.emit.eventLog = {};   // jobs recorded before these existed
  if (!job.emit.stepLog) job.emit.stepLog = {};
  return job.emit;
}

// Records one posted callback against the step the job was on. Called for successes AND failures,
// because "we tried at this step and it 502'd" is the single most useful thing to know.
function noteStep(job, { step, at, httpStatus, status, events, error }) {
  const a = emitAudit(job);
  if (step == null) return;
  const key = String(step);
  const row = a.stepLog[key] || (a.stepLog[key] = {
    firstAt: at, lastAt: at, attempts: 0, httpStatus: null, status: null, events: [], error: null,
  });
  row.attempts += 1;
  row.lastAt = at;
  row.httpStatus = httpStatus != null ? httpStatus : row.httpStatus;
  row.status = status || row.status;
  // A later success must clear an earlier error on the same step; a later failure must not erase
  // the events an earlier success already got onto the ledger.
  row.error = error || null;
  if (Array.isArray(events) && events.length) {
    row.events = [...new Set([...(row.events || []), ...events])];
  }
}

// Rebuild eventLog from the callback history for jobs that ran before it existed. The history
// already carries {at, step, events} per attempt, so the per-step view works retroactively instead
// of being blank until the next build — which would be exactly when nobody needs it.
// First occurrence wins, matching how the live path records it.
function backfillEventLog(job) {
  if (!job || !job.emit || !Array.isArray(job.emit.history)) return;
  const steps = job.emit.stepLog || (job.emit.stepLog = {});
  for (const h of job.emit.history) {
    if (!h || h.step == null) continue;
    const k = String(h.step);
    const row = steps[k] || (steps[k] = {
      firstAt: h.at, lastAt: h.at, attempts: 0, httpStatus: null, status: null, events: [], error: null,
    });
    row.attempts += 1;
    row.lastAt = h.at;
    if (h.httpStatus != null) row.httpStatus = h.httpStatus;
    if (h.status) row.status = h.status;
    row.error = h.error || null;
    if (Array.isArray(h.events) && h.events.length) {
      row.events = [...new Set([...(row.events || []), ...h.events])];
    }
  }
  const log = job.emit.eventLog || (job.emit.eventLog = {});
  for (const h of job.emit.history) {
    if (!h || !Array.isArray(h.events)) continue;
    for (const type of h.events) {
      if (!log[type]) log[type] = { at: h.at, step: h.step, status: h.status };
    }
  }
}

function noteEmit(job, patch) {
  const a = emitAudit(job);
  if (patch.productService) Object.assign(a.productService, patch.productService);
  if (patch.ted) Object.assign(a.ted, patch.ted);
  // Keep a short tail so a flapping build can be diagnosed after the fact. Newest last, capped —
  // a 9-step build calls back a dozen times and the whole job object is serialized into jobs.json.
  if (patch.entry) {
    a.history.push(patch.entry);
    if (a.history.length > 12) a.history.splice(0, a.history.length - 12);
  }
  saveJobs();
  return a;
}

function postStatus(job, attempt = 0) {
  // Only real client builds are tracked in G99 (edit jobs key off an internal jobId, not a draft).
  if (!job || job.type !== "build") return;
  if (!G99_STATUS_URL) {
    // Distinct from "pending": nothing is coming, because this deployment has no callback URL.
    // Without this the UI would show a grey dot forever and read as "still working on it".
    noteEmit(job, {
      productService: { state: "disabled", error: "G99_STATUS_CALLBACK_URL not set" },
      ted: { state: "disabled", error: "no callback configured" },
    });
    return;
  }
  const snapshot = jobStatusSnapshot(job);
  const body = JSON.stringify(snapshot);
  // Counts every delivery attempt, retries included — "4 attempts" has to mean four POSTs went
  // out, or the number is worse than no number when someone is judging whether to resend.
  const a0 = emitAudit(job);
  a0.productService.attempts += 1;
  if (attempt === 0) a0.productService.state = "sending";
  saveJobs();
  fetch(G99_STATUS_URL, {
    method: "POST",
    // Declare the charset explicitly. The briefs and mockup labels carry em-dashes and curly
    // apostrophes, and RFC 8259 only makes UTF-8 the default for bare application/json — a receiver
    // or proxy that falls back to ISO-8859-1 would double-encode every one of them. Spring happens
    // to default to UTF-8 today, so this is hardening against a silent, hard-to-spot corruption
    // rather than a fix for an observed one.
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Webhook-Secret": G99_STATUS_SECRET,
    },
    body,
  })
    .then(async (r) => {
      const text = await r.text().catch(() => "");
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status}${text ? " " + text.slice(0, 200) : ""}`);
        err.httpStatus = r.status;
        throw err;
      }
      // Older product-service builds answer {"status":"ok"} with no event list. Absent is not the
      // same as empty: report "unknown" rather than claiming nothing reached the ledger.
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — treat as legacy */ }
      const events = parsed && Array.isArray(parsed.events) ? parsed.events : null;
      const applied = parsed && typeof parsed.applied === "boolean" ? parsed.applied : null;
      const at = new Date().toISOString();

      const ps = { state: applied === false ? "error" : "ok", at, httpStatus: r.status, error: null };
      if (applied === false) {
        ps.error = (parsed && parsed.message) || "product-service could not apply the callback";
      }

      const a = emitAudit(job);
      const ted = {};
      if (applied === false) {
        ted.state = "error";
        ted.error = ps.error;
      } else if (events === null) {
        // Legacy response shape — we genuinely cannot tell. Never downgrade a known success.
        if (a.ted.state !== "ok") {
          ted.state = "unknown";
          ted.error = "product-service did not report which events it wrote";
        }
      } else if (events.length) {
        ted.state = "ok";
        ted.at = at;
        ted.error = null;
        ted.events = [...new Set([...(a.ted.events || []), ...events])];
        for (const type of events) {
          if (!a.eventLog[type]) {
            a.eventLog[type] = { at, step: snapshot.currentStep, status: snapshot.status };
          }
        }
      }
      // applied=true with an empty event list means "accepted, nothing new to read". Leave whatever
      // earlier callbacks established — a later duplicate must not undo a written event.
      noteStep(job, {
        step: snapshot.currentStep, at, httpStatus: r.status, status: snapshot.status,
        events: events || [], error: applied === false ? ps.error : null,
      });
      noteEmit(job, {
        productService: ps,
        ted,
        entry: {
          at, status: snapshot.status, step: snapshot.currentStep,
          httpStatus: r.status, events: events || null, error: null,
        },
      });
    })
    .catch((e) => {
      const at = new Date().toISOString();
      const message = e.message || String(e);
      const retrying = attempt < G99_RETRY_DELAYS_MS.length;
      noteStep(job, {
        step: snapshot.currentStep, at, httpStatus: e.httpStatus || null,
        status: snapshot.status, events: [], error: message,
      });
      noteEmit(job, {
        productService: {
          state: retrying ? "retrying" : "error",
          at,
          httpStatus: e.httpStatus || null,
          error: message,
        },
        // The ledger write cannot have happened if the POST never landed. Only claim failure while
        // no earlier callback succeeded — one failed step transition does not erase a written event.
        ted: emitAudit(job).ted.state === "ok" ? {} : { state: retrying ? "pending" : "error", error: message },
        entry: {
          at, status: snapshot.status, step: snapshot.currentStep,
          httpStatus: e.httpStatus || null, events: null, error: message,
        },
      });
      if (retrying) {
        setTimeout(() => postStatus(job, attempt + 1), G99_RETRY_DELAYS_MS[attempt]);
      } else {
        console.error(`g99 status callback failed for ${job.draftId} after retries:`, message);
      }
    });
}
// ---- Durable client pool (NocoDB) --------------------------------------------
// The problem this solves: our job state lives in memory + jobs.json, which sits on Render's
// ephemeral disk — every redeploy wipes it, so there was no answer to "which clients have we
// onboarded, and how many pages does each have?". NocoDB is external, free, already authenticated,
// and readable outside this tool, so it is the pool. One row per client site, keyed by draft id,
// upserted as the job progresses. Fail-soft: the pool is a record of work, never a gate on it.
const NOCODB_BUILDS_TABLE = process.env.NOCODB_BUILDS_TABLE || "meeshvyt8q9x412";
const POOL_TYPES = new Set(["build", "enrich", "pages"]);   // edit/restore jobs aren't a client site

async function ncRecords(method, body, query = "") {
  if (!NOCODB_TOKEN) throw new Error("NOCODB_TOKEN not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let r;
  try {
    r = await fetch(`${NOCODB_BASE}/api/v2/tables/${NOCODB_BUILDS_TABLE}/records${query}`, {
      method, signal: ctl.signal,
      headers: { "xc-token": NOCODB_TOKEN, "accept": "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`NocoDB ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// Page progress comes from whichever source the job has: a live page plan (batched
// builds), else the manifest totals it last wrote. Absent on older jobs — send nulls
// rather than zeros so "not measured yet" reads differently from "nothing built".
function poolPageCounts(job) {
  const t = job.planTotals || (job.manifest && job.manifest.planTotals) || null;
  return {
    "Existing pages": job.existingPageCount != null ? job.existingPageCount : null,
    "Pages planned": t ? t.total : null,
    "Pages built": t ? t.built : null,
    "Pages pending": t ? t.pending : null,
    "Coverage pct": t && t.total ? Math.round((t.built / t.total) * 100) : null,
  };
}

// The pool is a list of CLIENTS, not of jobs: a client's site gets rebuilt and enriched many
// times, and one row per run turned four real sites into twenty-four rows. The repo is the
// client's identity (HubSpot hands out one repo per client), with the beta URL and finally the
// draft id as fallbacks so a row is never lost for want of a key.
// Build jobs carry the target on the job; enrich/pages jobs carry it in the payload. Resolve
// both here, or every enrich run becomes its own "client" and the row shows a blank repo.
function poolTarget(job) {
  const P = job.payload || {};
  return {
    repo: normalizeRepo(job.repo || P.githubRepo || P.betaSiteRepo || P.repo) || null,
    url: job.liveUrl || P.betaSiteUrl || P.liveUrl || null,
  };
}
function poolSiteKey(job) {
  const { repo, url } = poolTarget(job);
  if (repo) return repo;
  const host = String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return host || `draft:${job.draftId}`;
}

function poolRow(job) {
  const target = poolTarget(job);
  return {
    "Site key": poolSiteKey(job),
    // Identity of the latest job on this site. Text, not numeric: manual and test runs use
    // slug ids, and a numeric-only key silently dropped those rows.
    "Draft key": String(job.draftId),
    "Draft id": Number.isFinite(Number(job.draftId)) ? Number(job.draftId) : null,
    Client: job.businessName || "Client",
    "Beta site": target.url,
    Repo: target.repo,
    Theme: (job.payload && job.payload.themeSlug) || job.themeSlug || null,
    Status: job.status,
    Step: `${job.currentStep + 1}/${(job.steps || []).length}`,
    ...poolPageCounts(job),
    "Last PR": job.prUrl || null,
    "Received at": job.receivedAt || job.createdAt || null,
    "Finished at": job.finishedAt || null,
    "Job link": `${G99_TOOL_PUBLIC_URL}/job?id=${encodeURIComponent(job.draftId)}`,
    Error: job.error ? String(job.error).slice(0, 240) : null,
  };
}

// NocoDB throttles hard (a per-row GET+PATCH pass over 24 jobs was enough to earn a wall of
// 429s), so writes are coalesced instead of immediate: jobs mark themselves dirty, and one
// flush turns the whole batch into at most one bulk PATCH plus one bulk POST. Row ids are
// cached from a single read, which removes the per-row lookup entirely.
const POOL_DIRTY = new Map();          // site key -> latest job for that site
const POOL_IDS = new Map();            // site key -> NocoDB row Id
const POOL_BUILDS = new Map();         // site key -> runs counted so far
const POOL_LAST = new Map();           // site key -> last job id written (to count new runs)
let POOL_IDS_LOADED = false;
let POOL_FLUSH_TIMER = null;
let POOL_FLUSHING = false;

function mirrorPool(job) {
  if (!NOCODB_TOKEN || !job || !POOL_TYPES.has(job.type) || !job.draftId) return;
  POOL_DIRTY.set(poolSiteKey(job), job);
  const terminal = ["done", "error", "cancelled"].includes(job.status);
  if (terminal) return void schedulePoolFlush(0);
  schedulePoolFlush(4000);
}

function schedulePoolFlush(delay) {
  if (POOL_FLUSH_TIMER) return;
  POOL_FLUSH_TIMER = setTimeout(() => {
    POOL_FLUSH_TIMER = null;
    poolFlush().catch((e) => console.error("pool flush failed:", e.message));
  }, delay);
}

// Retry the 429s rather than dropping the row — losing a terminal write is exactly the
// data loss this pool exists to prevent.
async function ncRetry(method, body, query = "", tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await ncRecords(method, body, query); }
    catch (e) {
      const throttled = /\b429\b/.test(e.message);
      if (!throttled || i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function poolLoadIds() {
  const d = await ncRetry("GET", null, "?limit=1000&fields=Id,Site%20key,Draft%20key,Builds");
  POOL_IDS.clear();
  POOL_BUILDS.clear();
  POOL_LAST.clear();
  for (const r of d.list || []) {
    const key = String(r["Site key"] || "");
    if (!key) continue;
    POOL_IDS.set(key, r.Id);
    POOL_BUILDS.set(key, Number(r.Builds) || 0);
    if (r["Draft key"]) POOL_LAST.set(key, String(r["Draft key"]));
  }
  POOL_IDS_LOADED = true;
}

async function poolFlush() {
  if (POOL_FLUSHING || !POOL_DIRTY.size) return;
  POOL_FLUSHING = true;
  const batch = [...POOL_DIRTY.entries()];
  POOL_DIRTY.clear();
  try {
    if (!POOL_IDS_LOADED) await poolLoadIds();
    const updates = [];
    const inserts = [];
    for (const [key, job] of batch) {
      const row = poolRow(job);
      // Count a run only when the job id changes, so the repeated status writes of one
      // build don't inflate the number.
      if (POOL_LAST.get(key) !== row["Draft key"]) {
        POOL_BUILDS.set(key, (POOL_BUILDS.get(key) || 0) + 1);
        POOL_LAST.set(key, row["Draft key"]);
      }
      row.Builds = POOL_BUILDS.get(key) || 1;
      const id = POOL_IDS.get(key);
      if (id) updates.push({ Id: id, ...row });
      else inserts.push(row);
    }
    if (updates.length) await ncRetry("PATCH", updates);
    if (inserts.length) {
      const created = await ncRetry("POST", inserts);
      // Record the new ids so the next flush updates these rows instead of duplicating them.
      (Array.isArray(created) ? created : []).forEach((r, i) => {
        if (r && r.Id && inserts[i]) POOL_IDS.set(String(inserts[i]["Site key"]), r.Id);
      });
    }
    console.log(`pool: flushed ${updates.length} update(s), ${inserts.length} insert(s)`);
  } catch (e) {
    // Put the batch back so the next flush retries it rather than silently losing history.
    for (const [key, job] of batch) if (!POOL_DIRTY.has(key)) POOL_DIRTY.set(key, job);
    console.error("pool flush error:", e.message);
    schedulePoolFlush(20000);
  } finally {
    POOL_FLUSHING = false;
    if (POOL_DIRTY.size) schedulePoolFlush(5000);
  }
}

async function poolList() {
  const d = await ncRetry("GET", null, "?limit=500&sort=-Id");
  return (d.list || []).map((r) => ({
    siteKey: r["Site key"], builds: r.Builds || 1,
    draftId: r["Draft key"] || r["Draft id"], client: r.Client, betaSite: r["Beta site"], repo: r.Repo,
    theme: r.Theme, status: r.Status, step: r.Step,
    existingPages: r["Existing pages"], pagesPlanned: r["Pages planned"],
    pagesBuilt: r["Pages built"], pagesPending: r["Pages pending"], coveragePct: r["Coverage pct"],
    prUrl: r["Last PR"], receivedAt: r["Received at"], finishedAt: r["Finished at"],
    jobLink: r["Job link"], error: r.Error,
  }));
}

// One-time backfill on boot: whatever jobs.json still holds gets pushed into the pool, so
// the history we already have isn't lost the next time this disk is wiped. It rides the same
// coalesced flush, so 60 jobs cost one bulk write, not 60 round-trips.
function backfillPool() {
  if (!NOCODB_TOKEN) return;
  const jobs = [...JOBS.values()]
    .filter((j) => POOL_TYPES.has(j.type) && j.draftId)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (!jobs.length) return;
  // Keyed by site so the newest run wins — the pool holds one row per client, and the
  // Builds counter picks up each distinct run as it goes past.
  for (const job of jobs) POOL_DIRTY.set(poolSiteKey(job), job);
  console.log(`pool: backfilling ${jobs.length} job(s) → ${POOL_DIRTY.size} client(s)`);
  schedulePoolFlush(1000);
}
setTimeout(backfillPool, 2000);

// ---- credentials smoke test -----------------------------------------------------
// Clones a repo, appends one line to .g99/smoke-test.md, pushes a branch and opens a PR.
// It runs through the SAME auth layer as the real pipeline (ghToken / ghCloneUrl / sh) rather
// than a copy, so a pass here means the pipeline's credentials work — a copy could drift and
// pass while the real thing fails. Push and PR are reported separately because they need
// DIFFERENT permissions, which is exactly where the GitHub App currently falls short.
const SMOKE_FILE = ".g99/smoke-test.md";

async function runPrSmoke(mode, repoIn, baseIn) {
  const repo = normalizeRepo(repoIn) || "G99agency/prodteam1.gogroth.com";
  const base = (baseIn || "main").replace(/[^A-Za-z0-9._\-\/]/g, "");
  const steps = [];
  const step = (label, ok, detail, extra) =>
    steps.push({ label, ok, detail: String(detail == null ? "" : detail).slice(0, 400), ...(extra || {}) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g99-smoke-"));

  try {
    let appTok = "";
    if (mode !== "pat" && GH_APP_CONFIGURED) {
      try { appTok = await ghAppToken(); step("Mint GitHub App token", true, "installation " + GH_APP_INSTALLATION_ID); }
      catch (e) { step("Mint GitHub App token", false, e.message); }
    } else if (mode !== "pat") {
      step("Mint GitHub App token", false, "App not configured — set the GH_APP_* vars in .env");
    }
    if (mode === "app" && !appTok) throw new Error("App mode requested but no App token could be minted");

    const pushTok = mode === "pat" ? (process.env.GH_TOKEN || "") : (appTok || process.env.GH_TOKEN || "");
    const pushWho = mode === "pat" ? "PAT" : (appTok ? "GitHub App" : "PAT");
    if (!pushTok) throw new Error("no credentials — set GH_TOKEN or the GH_APP_* vars in .env");

    let r = await sh(`git clone --depth 1 --branch ${base} "https://x-access-token:${pushTok}@github.com/${repo}.git" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + (r.stderr || r.stdout).slice(-220));
    step(`Clone ${repo}`, true, `branch ${base}, authenticated as ${pushWho}`);

    const stamp = new Date().toISOString();
    const branch = "g99/smoke-" + stamp.slice(0, 19).replace(/[-:T]/g, "");
    const abs = path.join(tmp, SMOKE_FILE);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Append rather than overwrite, so the file is a log of every run.
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "# Growth99 connectivity smoke tests\n\n";
    fs.writeFileSync(abs, `${prev}- ${stamp} — smoke test via ${pushWho}\n`);
    step("Write a small change", true, SMOKE_FILE);

    await sh(`git checkout -b "${branch}"`, tmp);
    await sh(`git add -A "${SMOKE_FILE}"`, tmp);
    r = await sh(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "Smoke test: verify ${pushWho} can push"`, tmp);
    if (r.code) throw new Error("commit failed: " + (r.stderr || r.stdout).slice(-220));
    r = await sh(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error(`push failed as ${pushWho}: ` + r.stderr.slice(-240));
    step("Push branch", true, `${branch} — pushed as ${pushWho}`);

    const payload = {
      title: `Smoke test: ${stamp.slice(0, 16)}`,
      head: branch,
      base,
      body: `Automated connectivity check from the Growth99 build tool.\n\n`
        + `- push authenticated as: **${pushWho}**\n- change: \`${SMOKE_FILE}\`\n\nSafe to close.`,
    };
    const openPr = (token) => fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: "token " + token, Accept: "application/vnd.github+json",
        "User-Agent": "g99-website-build-tool", "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });

    let created = null, prWho = "";
    if (appTok && mode !== "pat") {
      const res = await openPr(appTok);
      if (res.ok) { created = await res.json(); prWho = "GitHub App"; }
      else {
        // GitHub names the permission it wanted — surface that instead of a bare 403.
        const need = res.headers.get("x-accepted-github-permissions") || "";
        step("Open PR as the GitHub App", false,
          `HTTP ${res.status}${need ? ` — GitHub says this needs: ${need}` : ""} ${(await res.text()).slice(0, 200)}`);
        if (mode === "app") throw new Error("the App cannot open PRs — grant it \"Pull requests: Read and write\"");
      }
    }
    if (!created) {
      if (!process.env.GH_TOKEN) throw new Error("PR not created and no GH_TOKEN to fall back to");
      const res = await openPr(process.env.GH_TOKEN);
      if (!res.ok) throw new Error(`PR create failed (PAT): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      created = await res.json();
      prWho = "PAT";
    }
    step("Open pull request", true, `#${created.number} — opened by ${prWho}`, { url: created.html_url });
    return { ok: true, repo, prUrl: created.html_url, branch, steps };
  } catch (e) {
    step("Failed", false, e.message);
    return { ok: false, repo, error: e.message, steps };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
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
// Shared footer requirement, real medspa sites always ship this — a thin
// "Call Now"-only footer reads as an unfinished/generic AI page. Required on
// every page, not just contact, since the section-flow scan strips the
// footer before classifying sections (so it never shows up "in the flow").
const FOOTER_DIRECTIVE = (A) =>
  `FOOTER (required): ${A.business_name || "the business"}, full address "${A.location || "(address)"}", phone as a tel: link "${A.phone_for_website || ""}", and a legal/policy row (Privacy Policy · Terms · Accessibility).`;
function jobPageSections(key, A) {
  const val2 = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === "object") ? [x.name, x.title].filter(Boolean).join(" — ") + (x.bio ? ": " + x.bio : "") : String(x)).join(Array.isArray(v) && v.some((x) => x && typeof x === "object") ? "; " : ", ") : (v == null ? "" : String(v));
  const featured = val2(A.revenue_services), providers = val2(A.team_roster), services = val2(A.services_offered);
  
  const DIRECTIVES = `
PROMPT BLUEPRINT DIRECTIVES (INSPIRED BY RUMA, HELLOSKIN, ER INJECTABLES & AUSTIN AESTHETIC COUTURE):
- PHOTO ENGRAVED TEXT & FLOATING BADGES: High-resolution treatment and provider photography MUST feature floating glassmorphism badges ("4.9★ CLINIC RATED", "BOARD CERTIFIED FACIAL SPECIALISTS") and text written directly ON the photo image under a bottom gradient scrim.
- OVERSIZED PARALLAX BACKGROUND WATERMARK: Render an oversized, 14–22rem 5% opacity brand wordmark watermark of "${A.business_name || "NUVO AESTHETICS"}" bleeding behind Section 3 and the Footer with micro-parallax depth.
- TWO-PART HEADINGS (REQUIRED): Every section heading MUST be a two-part composition. Line 1: Main display serif headline. Line 2 (directly under it in accent gold): an italicized or small-caps sub-line (e.g., Line 1: 'Refined Aesthetics', Line 2: 'Artfully Delivered with Medical Precision').
- ASYMMETRIC 40/60 LAYOUTS: Avoid plain 3-identical-box grids. Use asymmetric 40/60 splits, arched photo tiles with offset 1px gold borders, and staggered height card grids.
- 60FPS SCROLL ANIMATIONS: Include embedded CSS keyframe animations: @keyframes float, @keyframes pulseGlow, @keyframes fadeInUp. Apply transform: translateY(-8px) scale(1.02) hover states on cards and buttons.
- CONCRETE MEDSPA COPY: Use explicit, non-placeholder MedSpa editorial copy for every section.
- DO NOT: Do NOT use plain white background on 3 consecutive sections. Do NOT use placeholder text. Do NOT use purple/neon gradients.
`;

  return ({
    home: [`Sections (each a DISTINCT layout — do not repeat patterns):`,
      DIRECTIVES,
      `1. HERO — full-viewport cinematic image under a dark gradient; oversized serif headline "${A.hero_headline || "Refined Aesthetics, Artfully Delivered"}"; subheadline "${A.hero_subheadline || "Physician-led facial sculpting and skin rejuvenation."}"; two CTAs ("${A.primary_cta || "Book Online"}" + "Explore Treatments"); a floating glass trust-bar with 4.9★ rating.`,
      `2. INTRO — asymmetric 40/60 split with an editorial pull-quote: "${A.why_patients_choose || "Patients choose us for our blend of medical precision and artistic treatment, ensuring natural-looking results."}".`,
      `3. SIGNATURE TREATMENTS — staggered 3D hover card grid for ${featured}. Caption and price sit directly ON the photo under a dark gradient scrim.`,
      `4. SERVICE CATEGORIES — full-bleed dark band listing ${services}.`,
      `5. STATS / TRUST band with animated counter badges. 6. FEATURE with curved image masks and gold borders.`,
      `7. PROVIDERS — offset portraits with credentials: ${providers}.`,
      `8. TESTIMONIAL — oversized pull-quote: "${A.featured_review || "Jeannine always makes me feel super comfortable when I’m getting my Botox or filler."}".`,
      `9. MEMBERSHIP & FINANCING: ${val2(A.financing_offered)}. 10. BOOKING PANEL — a persistent scheduling-panel-styled section (date/time-picker visual, service selector) driving to "${A.primary_cta || "Book Online"}", not just a repeated text button.`,
      `${FOOTER_DIRECTIVE(A)}`].join("\n"),
    services: [`Sections:`, DIRECTIVES, `1. Same transparent nav as home.`, `2. Editorial hero "Our Treatments".`,
      `3. One section per category — ${services} — with interactive cards + "${A.primary_cta || "Book Online"}" CTAs.`,
      `4. Signature spotlight: ${featured}. 5. Financing: ${val2(A.financing_offered)}. 6. BOOKING PANEL (scheduling-panel styling, not a plain button). 7. ${FOOTER_DIRECTIVE(A)}`].join("\n"),
    about: [`Sections:`, DIRECTIVES, `1. Same nav.`, `2. Practice story: "${A.why_patients_choose || "Dedicated to medical precision and aesthetic balance."}".`,
      `3. Meet the team — portrait cards: ${providers}. 4. Values with curved masks.`,
      `5. Testimonial: ${A.featured_review || ""}. 6. BOOKING PANEL. 7. ${FOOTER_DIRECTIVE(A)}`].join("\n"),
    contact: [`Sections:`, DIRECTIVES, `1. Same nav.`, `2. Split layout: consultation form beside imagery.`,
      `3. ${A.booking_platform || "Online"} booking panel — full scheduling-panel styling (date/time-picker visual, service selector), not just a text link. 4. Location: ${A.location || ""}, phone ${A.phone_for_website || ""}.`,
      `5. CTA band. 6. ${FOOTER_DIRECTIVE(A)}`].join("\n"),
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
  mirrorPool(job);   // and the pool gets the client row the moment the form arrives
  processJobQueue();
  return { job, dedupe: false };
}
async function processJobQueue() {
  if (JOB_RUNNING) return;
  const id = JOB_QUEUE.shift();
  if (!id) return;
  JOB_RUNNING = true;
  const job = JOBS.get(id);
  const RUNNER = { edit: runEditJob, restore: runRestoreJob, enrich: runEnrichJob, seo: runSeoJob, "pre-release": runPreReleaseJob, "perform-pr": runPerformPrJob, "wireframe-audit": runWireframeAudit };
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

// Steps 7 ("Theme activation watch"), 8 ("CRO after-audit + comparison") and the
// auto-enrich queue — factored out of runJob so a build that got everything merged
// but then failed waiting on the mu-plugin (by far the most common failure here:
// deploy/activation can lag past the ~10min poll window) can be RETRIED from this
// point alone, via retryThemeActivationTail(), without re-running Stitch generation,
// re-opening a PR, or re-running CI.
async function runThemeActivationTail(job, slug, A) {
  // 7 — wait for the mu-plugin to activate the theme on the live site
  jobStep(job, 6, "running", "Waiting for deploy + activation on " + job.liveUrl);
  let active = false;
  for (let i = 0; i < 40 && !active; i++) {
    try { active = (await localApi("/api/theme-live", { url: job.liveUrl, slug })).active; } catch (e) { /* keep polling */ }
    if (!active) { jobStep(job, 6, "running", `Not active yet (check ${i + 1}/40)…`); await sleep(15000); }
  }
  if (!active) throw new Error("theme not detected on live within ~10 min — deploy may be slow; retry this step again");
  jobStep(job, 6, "done", "Theme active on " + job.liveUrl);

  // 8 — after-audit + comparison + report
  jobStep(job, 7, "running", "Auditing the new live site…");
  job.after = await localApi("/api/cro-audit-url", { url: job.liveUrl });
  job.delta = job.before ? job.after.overall - job.before.overall : null;
  job.reportUrl = writeComparisonReport(job);
  await postPrComment(job);
  jobStep(job, 7, "done", job.before ? `${job.before.overall} → ${job.after.overall} (${job.delta >= 0 ? "+" : ""}${job.delta})` : `New site: ${job.after.overall}/100`);

  try { await syncSiteRegistry(); } catch (e) { /* non-fatal: keep registry current so the new site is editable */ }

  // Home-only artifacts: the automatic service-page (enrich) job is removed. Instead, as soon as the
  // home page is live, we push the SAME two artifacts the enrich job used to send — the home
  // screenshot (→ TED mockup task) and the home content (→ TED content task) — so onboarding is
  // driven off home-page creation, not service pages. Fail-soft: the beta is already released, so a
  // screenshot or push failure must never mark this build failed.
  try {
    jobStep(job, ENRICH_STEP_IDX, "running", "Capturing home mockup + sending content to TED…");
    let homeMockup = null;
    try {
      homeMockup = await captureMockup("Home", String(job.liveUrl).replace(/\/+$/, "") + "/");
    } catch (e) { /* never block completion on a screenshot */ }
    job.mockups = homeMockup ? [homeMockup] : [];
    saveJobs();

    if (job.businessId) {
      const hubspotDealId = (job.payload || {}).hubspotDealId || null;
      const hubspotCompanyId = (job.payload || {}).hubspotCompanyId || null;
      // Content-task payload: a single "Home" page entry whose brief is the composed home content.
      const homePages = [{
        name: "Home", slug: "home", status: "done", engine: "stitch",
        sourceUrl: job.liveUrl, brief: String(job.homeContent || "").slice(0, 3000),
      }];
      tedPushArtifacts("MOCKUPS_CAPTURED", {
        businessId: job.businessId, draftId: job.draftId, mockups: job.mockups, hubspotDealId, hubspotCompanyId,
      }).then(r => console.log(`[ted-push] MOCKUPS_CAPTURED biz=${job.businessId} -> ${JSON.stringify(r).slice(0, 200)}`));
      tedPushArtifacts("SERVICE_PAGES_CREATED", {
        businessId: job.businessId, draftId: job.draftId, servicePages: homePages, siteUrl: job.liveUrl, hubspotDealId, hubspotCompanyId,
      }).then(r => console.log(`[ted-push] SERVICE_PAGES_CREATED biz=${job.businessId} -> ${JSON.stringify(r).slice(0, 200)}`));
    }
    jobStep(job, ENRICH_STEP_IDX, "done", job.mockups.length ? "Home mockup + content sent to TED" : "Home content sent (mockup unavailable)");
  } catch (e) {
    console.error("home artifact push failed (non-fatal):", e.message);
    jobStep(job, ENRICH_STEP_IDX, "error", "Could not send home artifacts: " + e.message);
  }

  job.status = "done";
  notify(`✅ Beta site *${job.businessName}*: CRO ${job.before ? job.before.overall + "→" + job.after.overall : job.after && job.after.overall} · ${job.prUrl || ""}`);
}

// Manual retry entry point for the "Theme activation watch" step (and everything
// after it) on a job that already failed there or later. Does NOT touch Stitch,
// the PR, or CI — those are assumed already done (slug/prUrl/liveUrl are on the
// job record). Runs under the same single-concurrency guard as the main queue so
// it can never race a build that is actively using localApi()/Stitch/Gemini.
async function retryThemeActivationTail(draftId) {
  const job = JOBS.get(String(draftId));
  if (!job) throw new Error("job not found");
  if (job.type !== "build") throw new Error("only a build job's theme-activation step can be retried this way");
  if (!job.themeSlug) throw new Error("job has no recorded theme slug (pre-dates this feature, or failed before the WordPress theme + PR step) — cannot retry from here");
  if (!job.liveUrl) throw new Error("job has no recorded live URL");
  if (JOB_RUNNING) throw new Error("another build is currently running — try again once it finishes");

  JOB_RUNNING = true;
  job.status = "running"; job.error = null; job.cancelRequested = false;
  COST_SINK = job.cost;
  // Reset step 6 (theme_activation_watch) onward so the UI shows them re-running
  // rather than still marked "error"/"done" from the previous attempt.
  for (let i = 6; i < job.steps.length; i++) job.steps[i] = { key: JOB_STEP_KEYS[i], label: JOB_STEPS[i], status: "pending", detail: "" };
  postStatus(job); mirrorPool(job); saveJobs();
  try {
    await runThemeActivationTail(job, job.themeSlug, job.answers || {});
  } catch (e) {
    job.error = e.message; job.status = "error";
    if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
    console.error(`job ${job.draftId} retry (theme-activation tail) failed:`, e.message);
    notify(`❌ Beta site *${job.businessName}* retry failed: ${e.message}`);
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job); mirrorPool(job);
    JOB_RUNNING = false;
    processJobQueue();   // let any queued build proceed now that this one is done
  }
}

async function runJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  postStatus(job);   // "running"
  mirrorPool(job);
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
    // Persisted so a failed run's tail (theme activation watch onward) can be
    // retried later via retryThemeActivationTail() without re-reading onboarding.json,
    // which may have moved on to a different client's submission by then.
    job.answers = A; job.referenceWebsite = onb.referenceWebsite || ""; job.existingWebsite = onb.existingWebsite || "";

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
    jobStep(job, 1, "running", (job.payload || {}).brand
      ? "Applying the brand you confirmed…" : "Scanning site + composing brand system…");
    // Pass THIS job's confirmed brand rather than letting compose read onboarding.json: that file holds
    // only the most recent submission, so a job that waited in the queue would otherwise compose against
    // a different client's brand.
    const composed = await localApi("/api/compose-brand", { brand: (job.payload || {}).brand || null });
    const theme = { displayName: A.business_name, primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont };
    job.composed = { primary: composed.primary, secondary: composed.secondary, accent: composed.accent, headingFont: composed.headingFont, bodyFont: composed.bodyFont, brief: composed.brief || "" };
    jobStep(job, 1, "done", `Palette ${composed.primary}/${composed.accent} · ${composed.headingFont}`
      + (composed.brandSource ? " · client-confirmed" : ""));

    // 3 — generate all pages with Stitch
    // TEMPORARY (design-quality dev cycle, DESIGN_QUALITY_PLAN.md): while iterating
    // on the generation prompt, DEV_PAGES=on cuts a build to home only — 1 Stitch
    // call instead of 4, ~2 min instead of ~8. Unset/off = unchanged production
    // behavior (all 4 pages). Remove this block once the design pass is done.
    // DEV_PAGES: "off" (default, unchanged prod behavior, all 4) | "on" (home
    // only, legacy shortcut) | a comma list e.g. "home,about" for a scoped
    // local test run of exactly those pages.
    const DEV_PAGES_RAW = (process.env.DEV_PAGES || "off").toLowerCase();
    // Home-only build: for now we generate ONLY the home page — no about/contact/service pages.
    // The default ("off") is home-only; an explicit comma list still lets a scoped run request more.
    const DEV_PAGES = DEV_PAGES_RAW === "off" ? ["home"]
      : DEV_PAGES_RAW === "on" ? ["home"]
      : DEV_PAGES_RAW.split(",").map((s) => s.trim()).filter(Boolean);
    // Read the client's OWN pages first and let Gemini turn each real structure into that
    // page's brief. Without this every client got the same hardcoded 11-section blueprint,
    // which is why a generated home page looked nothing like theirs. Fail-soft per page: any
    // page we cannot scan falls back to the blueprint.
    let siteStruct = null;
    const existingUrl = job.payload && (job.payload.existingWebsite || job.payload.referenceWebsite);
    if (existingUrl) {
      jobStep(job, 2, "running", `Reading the structure of ${String(existingUrl).replace(/^https?:\/\//, "")}…`);
      try { siteStruct = await scanSiteStructure(existingUrl); } catch (e) { console.error("structure scan failed:", e.message); }
    }
    const specs = {};
    if (siteStruct) {
      for (const k of DEV_PAGES) {
        const s = siteStruct.pages[k];
        if (!s) continue;
        try { specs[k] = await composeCorePagePrompt(k, s, A, composed, siteStruct); }
        catch (e) { console.error(`brief for ${k} failed:`, e.message); }
      }
      job.structureScan = {
        site: siteStruct.origin,
        pages: Object.fromEntries(Object.entries(siteStruct.pages).map(([k, v]) =>
          [k, { url: v.url, h1: v.h1, flow: v.sectionFlow, sections: v.sections.length, images: v.images }])),
        composed: Object.keys(specs),
      };
      saveJobs();
    }
    const scanned = Object.keys(specs).length;
    jobStep(job, 2, "running", `Generating ${DEV_PAGES.length} page${DEV_PAGES.length > 1 ? "s" : ""}`
      + (scanned ? ` — ${scanned} brief(s) composed from the client's real site` : " (generic blueprint — site scan unavailable)") + "…");
    const pages = DEV_PAGES.map((k) => ({
      key: k, prompt: `${composed.brief}\n\n${specs[k] || jobPageSections(k, A)}\n\nReturn one complete, responsive, production-quality HTML page with the SEO requirements applied.`,
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

    // Home content for the TED content-task push (done later in runThemeActivationTail, once the site
    // is live). Prefer the composed home brief (from the client's real structure); fall back to the
    // overall composed brief so the content txt is never empty.
    job.homeContent = (specs && specs.home) || (composed && composed.brief) || "";

    // 4 — assemble into one coherent site
    jobStep(job, 3, "running", "Binding site with AI chrome…");
    const bound = await localApi("/api/bind-site", { engine: "", theme });
    job.siteUrl = bound.siteUrl || "/site/";
    // Snapshot the assembled bundle under this job's own draftId immediately — generated/site/
    // is a single shared folder that the NEXT build's assemble step will overwrite, so without
    // this snapshot a later build silently clobbers this one's downloadable copy.
    try {
      const snapDir = path.join(GEN, "exports", job.draftId, "site");
      fs.rmSync(snapDir, { recursive: true, force: true });
      fs.cpSync(path.join(GEN, "site"), snapDir, { recursive: true });
      job.zipUrl = `/api/export-zip?dir=${encodeURIComponent(`exports/${job.draftId}/site`)}&name=${encodeURIComponent(siteFolderName(job))}`;
    } catch (e) { console.warn("site snapshot for zip export failed (non-fatal):", e.message); }
    jobStep(job, 3, "done", `Assembled (${bound.chromeSource || "AI chrome"})`);

    // SKIP_PUSH=on: local test mode — stop here, don't push/PR to GitHub.
    // Assembled /site/ is already on disk for review in the browser. The
    // outer `finally` below still runs (finishedAt/postStatus/mirrorPool).
    if ((process.env.SKIP_PUSH || "off").toLowerCase() === "on") {
      job.status = "done";
      console.log(`  SKIP_PUSH=on: stopping after bind-site. Review at ${job.siteUrl}`);
      return;
    }

    // 5 — WordPress theme + PR
    jobStep(job, 4, "running", "Building theme, pushing, opening PR…");
    const push = await localApi("/api/push-wordpress", { theme, skipRebind: true, githubRepo: job.repo }, 15 * 60 * 1000);
    job.prUrl = push.prUrl; job.branch = push.branch;
    const slug = ((push.themePath || "").match(/g99-([a-z0-9-]+)\//) || [])[1] || "";
    job.themeSlug = slug;
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
      if (await ciEarlyExit(job, 5, "g99-" + slug, st, i)) { merged = true; break; }
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

    // 7, 8 & auto-enrich — extracted so a job that fails here (most commonly: the
    // mu-plugin takes longer than ~10min to activate) can be retried from this point
    // alone via retryThemeActivationTail(), instead of re-running steps 1-6.
    await runThemeActivationTail(job, slug, A);
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
    mirrorPool(job);   // flushed immediately — this is the row that must survive a redeploy
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
// Marks every byte that is markup or PHP rather than visible content: inside a
// tag (so attribute values like alt="..." and content="...") or inside <?php ?>.
//
// This exists because of a real dry run. A reviewer selected the word "focused"
// on the homepage and asked for it to become something else. Matched blindly,
// that hit eleven places across six templates — SEO meta descriptions, image alt
// text, a hyphenated word mid-token, and four pages they were not even looking
// at — and would then have auto-merged. A reviewer selects what they can SEE, so
// only what is visible may be edited.
function visibleMask(s) {
  const m = new Uint8Array(s.length);
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i);
      const stop = end === -1 ? s.length : end + 2;
      m.fill(1, i, stop); i = stop; continue;
    }
    if (s[i] === "<") {
      const end = s.indexOf(">", i);
      const stop = end === -1 ? s.length : end + 1;
      m.fill(1, i, stop); i = stop; continue;
    }
    i++;
  }
  return m;
}
// Occurrences of `find` that lie wholly in visible content. A span that starts
// outside a tag and ends inside one is not a clean piece of text either, so the
// whole run has to be clear.
//
// `wordSafe` additionally drops matches that are part of a longer word:
// "focused" inside "comfort-focused", or "treatment" inside "treatments". The
// reviewer selected a word, not a fragment of one, and replacing the fragment
// leaves mangled text behind.
function visibleHits(content, find, wordSafe) {
  const mask = visibleMask(content);
  const word = /[A-Za-z0-9]/;
  const out = [];
  let i = content.indexOf(find);
  while (i !== -1) {
    let clear = true;
    for (let k = i; k < i + find.length; k++) if (mask[k]) { clear = false; break; }
    if (clear && wordSafe) {
      const before = i > 0 ? content[i - 1] : "";
      const after = content[i + find.length] || "";
      if ((word.test(find[0]) && word.test(before)) || (word.test(find[find.length - 1]) && word.test(after))) clear = false;
    }
    if (clear) out.push(i);
    i = content.indexOf(find, i + 1);
  }
  return out;
}

// `variants` (optional) are other spellings of the SAME original text to try when
// the literal one is not in the file — WordPress texturises quotes and dashes on
// output, so text copied off the rendered page routinely differs from the
// template it came from. First form that matches in a given file wins; a file
// that matches none is left alone.
//
// `opts` turns on the content-review safety rules; with none of it passed this
// behaves exactly as it always did, which is what the email path relies on.
//   tiers      — file groups to try in order (the page's own template, then the
//                shared header/footer). The FIRST tier with a match wins and no
//                other tier is touched, so editing the homepage cannot rewrite
//                the about page.
//   maxHits    — refuse a change that matches more places than this. A single
//                word must be unique (1) to be safe at all; a phrase may repeat.
//   visibleOnly — ignore matches in markup, attributes and PHP.
//   refused    — array the caller passes in to collect what was declined and why.
function applyTextSwaps(workOrder, files, rootAbs, opts) {
  const O = opts || {};
  const done = [];
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const groups = O.tiers ? O.tiers.map((t) => t.map((rel) => byRel.get(rel)).filter(Boolean)) : [files];

  workOrder.changes.forEach((c, i) => {
    if (!c.replaces || !c.literal || c.replaces === c.literal) return;
    const forms = [c.replaces, ...(Array.isArray(c.variants) ? c.variants : [])];
    // One word is inherently ambiguous — "focused" is a word, not a place. It may
    // only be changed where it occurs exactly once.
    const oneWord = !/\s/.test(c.replaces.trim());
    const ceiling = O.maxHits ? (oneWord ? 1 : O.maxHits) : Infinity;

    let chosen = null;
    for (const group of groups) {
      const found = [];
      for (const f of group) {
        const form = forms.find((s) => s && f.content.includes(s));
        if (!form) continue;
        const at = O.visibleOnly ? visibleHits(f.content, form, O.wordSafe) : null;
        const count = O.visibleOnly ? at.length : f.content.split(form).length - 1;
        if (count) found.push({ f, form, at, count });
      }
      if (found.length) { chosen = found; break; }   // first tier that has it wins
    }
    if (!chosen) return;                              // not here: the planner may still try

    const total = chosen.reduce((n, x) => n + x.count, 0);
    if (total > ceiling) {
      if (O.refused) {
        O.refused.push({
          n: i + 1, what: c.what, replaces: c.replaces, literal: c.literal, hits: total,
          reason: oneWord
            ? `"${c.replaces}" appears ${total} times on this page — a single word can only be changed where it is unique. Select the whole phrase around it.`
            : `"${c.replaces}" appears ${total} times — too many places to change safely in one go.`,
        });
      }
      return;
    }

    const touched = [];
    for (const { f, form, at, count } of chosen) {
      if (O.visibleOnly) {
        // Right to left, so earlier offsets stay valid as the string changes.
        let s = f.content;
        for (let k = at.length - 1; k >= 0; k--) s = s.slice(0, at[k]) + c.literal + s.slice(at[k] + form.length);
        f.content = s;
      } else {
        f.content = f.content.split(form).join(c.literal);
      }
      fs.writeFileSync(path.join(rootAbs, f.rel), f.content);
      touched.push({ rel: f.rel, count });
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

// A content-review run against a local checkout. Deliberately its own function
// rather than a flag inside runEditJob: that one clones into a temp directory and
// deletes it on the way out, and pointing `tmp` at a real working tree would have
// it rm -rf someone's repository the first time a run failed.
//
// Same guardrails as a live run, no git at all: the swap is written straight into
// the checkout a local WordPress is serving, so the reviewer refreshes and sees it.
async function runLocalReviewEdit(job) {
  const P = job.payload;
  const root = P.localApply;
  try {
    jobStep(job, 0, "done", "Local checkout — nothing to clone");
    jobStep(job, 1, "running", "Reading the corrections…");
    const wo = P.workOrder;
    jobStep(job, 1, "done", `${wo.changes.length} exact correction(s) from ${P.requestedBy || "a reviewer"}`);

    jobStep(job, 2, "running", "Applying to " + P.reviewPath + "…");
    const out = applyReviewLocally(root, { themePath: P.themePath, muPath: P.muPath }, P.reviewPath, wo);
    job.textSwaps = out.applied;
    job.reviewRefused = out.refused;
    job.editSummary = out.applied.length ? swapsText(out.applied) : "nothing applied";
    job.editSummaryEmail = job.editSummary;
    jobStep(job, 2, "done", out.applied.length
      ? `${out.applied.length} change(s) written${out.refused.length ? ` · ${out.refused.length} refused` : ""}`
      : `nothing applied · ${out.refused.length} refused`);

    jobStep(job, 3, "done", out.applied.length ? "Exact swaps — verified as written" : "Nothing to check");
    jobStep(job, 4, "done", "Local run — no pull request");
    jobStep(job, 5, "done", "Local run — no CI, no merge");
    jobStep(job, 6, "done", out.applied.length ? "Live on the local site — refresh to see it" : "No change made");

    job.status = out.applied.length ? "done" : "error";
    if (!out.applied.length) job.error = out.refused.map((r) => r.reason).join("\n") || "nothing matched";
    notify(`✍️ Content review (local) — *${P.businessName}* ${P.reviewPath}: ${out.applied.length} applied`
      + (out.refused.length ? `, ${out.refused.length} refused` : ""));
  } catch (e) {
    job.error = e.message; job.status = "error";
    if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") {
      job.steps[job.currentStep].status = "error";
      job.steps[job.currentStep].detail = String(e.message).slice(0, 240);
    }
    console.error(`local review job ${job.draftId} failed:`, e.message);
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
  }
}

async function runEditJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString(); COST_SINK = job.cost;
  const P = job.payload;                 // {siteId, themeSlug, themePath, muPath, githubRepo, businessName, prompt}
  // Local content-review runs never reach the git machinery below.
  if (P.localApply) return runLocalReviewEdit(job);
  const repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99edit-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => { let r; for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); } return r; };
  try {
    // 1 — pull latest
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = await ghCloneUrl(repo);
    if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
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
    // A caller that already knows the exact pairs supplies the work order itself
    // and the model is never asked to infer one. The content-review widget is the
    // case this exists for: it captured the original text off the page, so there
    // is nothing to interpret and interpreting it could only introduce error.
    let workOrder = P.workOrder || null;
    if (!workOrder) {
      try { workOrder = await buildWorkOrder(P.prompt, { businessName: P.businessName }, ai); }
      catch (e) { console.warn(`edit job ${job.draftId}: work order failed, using the raw request —`, e.message); }
    }
    job.workOrder = workOrder;
    if (workOrder) {
      jobStep(job, 1, "running", `${workOrder.changes.length} change(s) understood${workOrder.unclear.length ? `, ${workOrder.unclear.length} too vague to action` : ""} — locating them…`);
      saveJobs();
    }

    // Straight text swaps are settled here, in code. Whatever they resolve is
    // removed from the brief, so the model never sees it and cannot embellish
    // it. Only what is left needs judgement.
    // A correction typed on a page carries safety rules an emailed request does
    // not: it may only touch that page (then shared chrome), only visible text,
    // and only where the target is unambiguous. See applyTextSwaps.
    const reviewRefused = [];
    const swapOpts = P.reviewPath ? {
      tiers: reviewSwapTiers(P.reviewPath, (source.find((f) => f.rel === P.muPath) || {}).content, P.themePath),
      maxHits: 5, visibleOnly: true, wordSafe: true, refused: reviewRefused,
    } : undefined;
    const swaps = workOrder ? applyTextSwaps(workOrder, source, tmp, swapOpts) : [];
    job.textSwaps = swaps;
    const swapped = new Set(swaps.map((s) => s.n));

    // Nothing from a review reaches the planner. These runs merge themselves, so
    // "the swap could not find it, let a model try" would hand a client's live
    // site to a guess — the exact risk the exact-pair design exists to remove.
    // If it cannot be matched character-for-character on the page it was typed
    // on, it is reported back rather than approximated.
    if (P.reviewPath && workOrder) {
      workOrder.changes.forEach((c, i) => {
        if (swapped.has(i + 1) || reviewRefused.some((r) => r.n === i + 1)) return;
        reviewRefused.push({
          n: i + 1, what: c.what, replaces: c.replaces, literal: c.literal, hits: 0,
          reason: `"${String(c.replaces).slice(0, 60)}" could not be matched exactly on ${P.reviewPath} — if it runs across a line break, change one line at a time.`,
        });
      });
    }
    job.reviewRefused = reviewRefused;
    const blocked = new Set(reviewRefused.map((r) => r.n));
    const forAi = workOrder ? { ...workOrder, changes: workOrder.changes.filter((c, i) => !swapped.has(i + 1) && !blocked.has(i + 1)) } : null;
    if (reviewRefused.length && !swaps.length && forAi && !forAi.changes.length) {
      throw new Error("Nothing could be applied safely:\n" + reviewRefused.map((r) => "- " + r.reason).join("\n"));
    }
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
    // Client-facing version of the same summary: what changed, never which file it
    // lives in — file names are implementation detail, not something to put in a
    // reply email. swapsText() names files on purpose (it's used in Slack/PR/TED,
    // where that detail is exactly what a developer wants).
    job.editSummaryEmail = plan.summary || swaps.map((s) => s.what).filter(Boolean).join("; ");
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
    // Nothing for a model to confirm when a model did nothing. Every item was an
    // exact pair the caller supplied, and applyTextSwaps already reported which
    // files each one landed in — asking Gemini to re-read the diff would only be
    // a slower, less certain version of a fact we already hold.
    const allSwapped = !!P.workOrder && !plan.files.length && swaps.length === workOrder.changes.length;
    if (allSwapped) {
      jobStep(job, 3, "done", `${swaps.length} exact swap(s) verified in the diff`);
    } else try {
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
    if (!allSwapped) {
      jobStep(job, 3, "done", check
        ? `${check.done} of ${check.total} confirmed${check.missed ? ` · ${check.missed} not done` : ""}${job.retried ? " (after a retry)" : ""}`
        : "Nothing checkable — skipped");
    }

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
      if (await ciEarlyExit(job, 5, P.siteId, st, i)) { merged = true; break; }
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
    // Anything skipped has to be said out loud — otherwise "done" reads as "all
    // of it done". Two ways an item can be missing: too vague to attempt, or
    // attempted and not found in the diff afterwards.
    const skipped = ((job.workOrder && job.workOrder.unclear) || [])
      .concat((job.reviewRefused || []).map((r) => r.reason));
    const notDone = check ? check.results.filter((r2) => r2.done !== true) : [];
    // The second and final message. One line saying what shipped, then the
    // site. No pull request link: internal plumbing, and merged by now anyway.
    // The summary already reads as a sentence, so nothing is appended to it.
    queueEmailReply(job, [
      "The change is live now " + String.fromCharCode(8212) + " " + (job.editSummaryEmail || "your requested update").trim(),
      P.liveUrl ? "\n" + P.liveUrl : "",
    ].join("\n").trim());
    // A separate, brand-new email (not a reply buried under the above) for
    // anything this run could not finish — too vague to attempt, or attempted
    // and not confirmed in the diff — asking the requester to clarify it.
    queueClarificationEmail(job, [
      ...skipped,
      ...notDone.map((r2) => String(r2.what || "").trim()).filter(Boolean),
    ]);
    // Same news to TED, with a screenshot of the updated page. Detached: it
    // waits for the deploy to land, and the job is finished by then.
    tedPostOutcome(job, { ok: true, detail: (job.editSummary || "Your requested update.").trim() });
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
      // A request logged in TED with no outcome reads as still in progress, so
      // failures are reported there too. No screenshot — nothing changed.
      tedPostOutcome(job, { ok: false, detail: String(e.message).slice(0, 300) + "\n\nNothing was changed on the live site." });
      notify(`❌ Edit failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString(); saveJobs(); COST_SINK = null;
    postStatus(job);   // terminal: done | error | cancelled (+ siteUrl/prUrl/scores)
    mirrorPool(job);   // flushed immediately — this is the row that must survive a redeploy
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
    const cloneUrl = await ghCloneUrl(repo);
    if (r.code) r = await runRetry(`git clone "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
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
      if (await ciEarlyExit(job, 3, P.siteId, st, i)) { merged = true; break; }
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
// ---- existing-site structure scan (core pages) ----------------------------------
// Service pages have been generated from a scrape of the real page for a while; the four core
// pages were not — they came from a hardcoded 11-section blueprint, identical for every client.
// That is why a generated home page looks nothing like the client's own. This reads the real
// site's section flow so the same scrape → compose → Stitch path can drive the core pages too.

// Section types worth naming. Order matters: the first pattern that matches a block wins, so
// the more specific signals are listed first.
const SECTION_KINDS = [
  ["before-after", /\bbefore\s*(&|and|\/|\s)*\s*after\b|\bgallery of results\b|\btransformation/i],
  ["testimonials", /\btestimonial|\breview(s)?\b|what (our )?(patients|clients) say|★|\bstar rating/i],
  ["team", /\bmeet (the|our)\b|\bour team\b|\bproviders?\b|\bstaff\b|\bmd\b|\bnp\b|\brn\b|\bpa-c\b/i],
  ["services", /\btreatments?\b|\bservices?\b|\bwhat we (do|offer)\b|\bmenu\b/i],
  ["faq", /\bfaq\b|frequently asked|\bquestions\b/i],
  ["financing", /\bfinancing\b|\bmembership\b|\bspecials?\b|\bpackages?\b|\bcherry\b|\bafterpay\b|\bcare ?credit\b/i],
  ["stats", /\byears? of experience\b|\b\d[\d,]*\+?\s*(patients|treatments|clients|procedures)\b/i],
  ["location", /\bvisit us\b|\bour location\b|\bhours\b|\bdirections\b|\baddress\b/i],
  ["contact", /\bcontact\b|\bget in touch\b|\bbook (a|an|your)?\s*(consultation|appointment)\b|\bschedule\b/i],
  ["about", /\babout\b|\bour story\b|\bwhy choose\b|\bwelcome\b|\bmission\b/i],
  ["cta", /\bready to\b|\bstart your\b|\bbook now\b|\bcall today\b/i],
];
const classifySection = (text) => (SECTION_KINDS.find(([, re]) => re.test(text)) || ["content"])[0];

const textOf = (html) => String(html || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#\d+;/g, " ")
  .replace(/\s+/g, " ").trim();

// One page's real structure: the heading flow in DOM order, each tagged with what it seems to
// be and how image-heavy it is. Deliberately heuristic and fail-soft — this feeds a prompt,
// it does not need to be a perfect parse.
async function scanPageStructure(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let html;
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    html = await r.text();
  } catch (e) {
    // Was silent before (2026-08-08) — a scan failure here means this page
    // silently drops to the generic jobPageSections blueprint with nothing
    // telling anyone why. Log it so a bad build is traceable to its cause.
    console.warn(`  scan failed for ${url}: ${String(e.message || e).slice(0, 160)}`);
    return null;
  } finally { clearTimeout(timer); }

  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [""])[0];

  const h1 = textOf((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "").slice(0, 140);
  const title = textOf((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 140);
  const metaDesc = ((head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || "").slice(0, 200);

  // Nav: the first <nav>/<header> block's links, deduped, short labels only.
  const navBlock = (body.match(/<nav[\s\S]*?<\/nav>/i) || body.match(/<header[\s\S]*?<\/header>/i) || [""])[0];
  const nav = [...new Set([...navBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => textOf(m[1])).filter((t) => t && t.length <= 28))].slice(0, 12);

  // Buttons / CTAs anywhere on the page — the labels tell us the conversion language used.
  const ctas = [...new Set([...body.matchAll(/<a[^>]*class=["'][^"']*(btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => textOf(m[2])).filter((t) => t && t.length <= 40))].slice(0, 10);

  // Strip the chrome before looking for sections. Mega-menus are full of h2/h3 headings, so
  // without this the "section flow" is just the navigation — every heading duplicated (desktop
  // + mobile menu) and every section reporting zero images.
  const main = body
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<ul[^>]+class=["'][^"']*(menu|nav)[^"']*["'][\s\S]*?<\/ul>/gi, " ")
    .replace(/<div[^>]+class=["'][^"']*(mega-?menu|sub-?menu|off-?canvas|mobile-menu)[^"']*["'][\s\S]*?<\/div>/gi, " ");

  // The section flow: every h1/h2/h3 in DOM order plus the copy that follows it, classified.
  const headings = [...main.matchAll(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)];
  const sections = [];
  const seen = new Set();
  // Raised from 20/4000/220/300 (2026-08-08): those caps were quietly cutting
  // the scan off partway down real pages, so the composed brief only ever saw
  // the top of the site. This feeds a design brief, not a raw dump, but "top
  // to bottom, everything" means the LAST section on a long page must still
  // show up, not just the first ~4-5.
  for (let i = 0; i < headings.length && sections.length < 40; i++) {
    const label = textOf(headings[i][2]);
    if (!label || label.length > 120) continue;
    const dedupe = label.toLowerCase();
    if (seen.has(dedupe)) continue;      // repeated chrome that survived the strip
    seen.add(dedupe);
    const from = headings[i].index + headings[i][0].length;
    const to = i + 1 < headings.length ? headings[i + 1].index : Math.min(main.length, from + 8000);
    const chunk = main.slice(from, to);
    // Lazy-loaded sites put the real URL in data-src / srcset, so count those too.
    const images = (chunk.match(/<img|data-src=|srcset=|background-image/gi) || []).length;
    sections.push({
      heading: label,
      kind: classifySection(label + " " + textOf(chunk).slice(0, 300)),
      images,
      copy: textOf(chunk).slice(0, 600),
    });
  }

  const footer = (body.match(/<footer[\s\S]*?<\/footer>/i) || [""])[0];
  return {
    url, title, h1, metaDesc, nav, ctas,
    sections,
    sectionFlow: sections.map((s) => s.kind),
    images: (body.match(/<img/gi) || []).length,
    hasForm: /<form/i.test(body),
    hasMap: /google\.com\/maps|maps\.googleapis|<iframe[^>]+map/i.test(body),
    hasVideo: /<video|youtube\.com\/embed|player\.vimeo/i.test(body),
    footerText: textOf(footer).slice(0, 300),
    wordCount: textOf(body).split(/\s+/).length,
  };
}

// Find the client's own home / services / about / contact pages, then scan each one.
// Nav links are the source: they are what the site itself considers its primary pages.
async function scanSiteStructure(siteUrl) {
  if (!siteUrl) return null;
  let origin;
  try { origin = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : "https://" + siteUrl).origin; }
  catch (e) { return null; }

  const home = await scanPageStructure(origin + "/");
  if (!home) return null;

  // Match each core page to a nav entry, falling back to the conventional path.
  const WANT = {
    services: { re: /treatment|service|menu|what we do/i, fallback: ["/services/", "/treatments/"] },
    about: { re: /about|our story|team|meet/i, fallback: ["/about/", "/about-us/", "/team/"] },
    contact: { re: /contact|book|appointment|schedule|location/i, fallback: ["/contact/", "/contact-us/"] },
  };
  let navHrefs = [];
  try {
    const r = await fetch(origin + "/", { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 G99Bot" } });
    const html = await r.text();
    const navBlock = (html.match(/<nav[\s\S]*?<\/nav>/i) || html.match(/<header[\s\S]*?<\/header>/i) || [""])[0];
    navHrefs = [...navBlock.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: m[1], label: textOf(m[2]) }))
      .filter((x) => x.label && (x.href.startsWith("/") || x.href.startsWith(origin)));
  } catch (e) { /* nav lookup is best-effort */ }

  const out = { origin, home, pages: { home } };
  for (const [key, cfg] of Object.entries(WANT)) {
    const hit = navHrefs.find((x) => cfg.re.test(x.label));
    const candidates = [hit && (hit.href.startsWith("http") ? hit.href : origin + hit.href), ...cfg.fallback.map((p) => origin + p)]
      .filter(Boolean);
    for (const c of candidates) {
      const s = await scanPageStructure(c);
      if (s && s.sections.length) { out.pages[key] = s; break; }
    }
    if (!out.pages[key]) console.warn(`  scanSiteStructure: no ${key} page found (tried: ${candidates.join(", ")}) — falls back to the generic blueprint`);
  }
  console.log(`  scanSiteStructure(${origin}): found ${Object.keys(out.pages).join(", ")} (${Object.values(out.pages).reduce((n, p) => n + p.sections.length, 0)} sections total)`);
  out.scannedAt = new Date().toISOString();
  return out;
}

// Gemini turns one scanned page into a generation brief. Same contract as
// composeServicePagePrompt: nothing about the section flow is hardcoded — it comes from the
// scrape. The brief keeps the client's real information architecture and improves the
// EXECUTION; it must not invent sections the client does not have (a home page with invented
// testimonials and before/after galleries is exactly what made the old output feel generic).
async function composeCorePagePrompt(key, struct, A, composed, allStruct) {
  if (!struct) return null;
  const val = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? (x.name || x.title || "") : String(x))).filter(Boolean).join(", ") : (v == null ? "" : String(v));
  const flow = struct.sections.map((s, i) =>
    `${i + 1}. [${s.kind}] "${s.heading}"${s.images ? ` — ${s.images} image(s)` : ""}${s.copy ? ` — copy: ${s.copy.slice(0, 400)}` : ""}`).join("\n");

  const p = [
    `Write a DESIGN BRIEF (a page-generation prompt) for the ${key.toUpperCase()} page of a medical-aesthetics website. Return ONLY the brief text — no preamble, no markdown fences.`,
    ``,
    `THE CLIENT'S CURRENT ${key.toUpperCase()} PAGE (${struct.url}) — this is the structure to follow:`,
    `Title: ${struct.title}`,
    `H1: ${struct.h1 || "(none)"}`,
    struct.metaDesc ? `Meta description: ${struct.metaDesc}` : "",
    `Primary navigation: ${struct.nav.join(" | ") || "(none found)"}`,
    `Call-to-action labels they actually use: ${struct.ctas.join(" | ") || "(none found)"}`,
    `Page signals: ${struct.images} images${struct.hasForm ? ", has a form" : ""}${struct.hasMap ? ", embeds a map" : ""}${struct.hasVideo ? ", has video" : ""}, ~${struct.wordCount} words.`,
    `SECTION FLOW, in order:`,
    flow || "(no sections detected)",
    allStruct && allStruct.pages ? `Their other pages: ${Object.keys(allStruct.pages).filter((k) => k !== key).join(", ")}.` : "",
    ``,
    `RULES:`,
    `- MIRROR the section order and purpose above. Same information architecture, better execution.`,
    `- Do NOT invent sections they do not have. If there are no testimonials or before/after galleries in the flow, the page must not have them.`,
    `- Keep their real headings and CTA wording where it works; sharpen it where it is weak. Their CTA language is what their patients respond to.`,
    `- Where a section has images, the rebuilt section must be equally image-led.`,
    `- Improve what is objectively weak: visual hierarchy, whitespace, mobile layout, contrast, scannability, and a clear conversion path to "${A.primary_cta || struct.ctas[0] || "Book an appointment"}".`,
    `- FOOTER is required on every page, regardless of what the section flow above shows (footers are stripped before the flow is scanned): it must include the business name, the full address ("${A.location || "the practice's address"}"), the phone number as a tel: link ("${A.phone_for_website || ""}"), and a legal/policy row (Privacy Policy · Terms · Accessibility) — real medical-aesthetics sites always ship this, a thin one-link footer reads as unfinished.`,
    `- BOOKING must be more than a nav-bar button: include at least one section on the page styled as a persistent booking/scheduling panel (date/time-picker visual treatment, staff/service selector look) that drives to "${A.primary_cta || "Book Now"}" — not just a plain text link repeated in different colors.`,
    ``,
    `PRACTICE FACTS to use as real copy (never placeholders):`,
    `Business: ${A.business_name || ""}. Location: ${A.location || ""}. Phone: ${A.phone_for_website || ""}.`,
    A.services_offered ? `Services: ${val(A.services_offered)}.` : "",
    A.revenue_services ? `Priority/revenue services: ${val(A.revenue_services)}.` : "",
    A.team_roster ? `Team: ${val(A.team_roster)}.` : "",
    A.why_patients_choose ? `Why patients choose them: ${val(A.why_patients_choose)}.` : "",
    A.featured_review ? `A real review: "${val(A.featured_review)}".` : "",
    ``,
    `BRAND SYSTEM to obey exactly: primary ${composed.primary}, secondary ${composed.secondary}, accent ${composed.accent}; headings "${composed.headingFont}", body "${composed.bodyFont}".`,
    `Specify every section in order with concrete copy direction and imagery direction. 300-450 words.`,
  ].filter((x) => x !== "").join("\n");

  return stripFence(await geminiCall([{ text: p }], { temperature: 0.5, maxOutputTokens: 1600, timeoutMs: 60000 }));
}

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
  let h = clampViewportHeights(enforceBrandFonts(html, composed));
  h = enforceArbitraryColors(h, composed);
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
  if (!parent || !parent.steps) return;
  // By key, not by ENRICH_STEP_IDX: a parent reloaded from jobs.json carries the step
  // list it was created with, so a build started before a step was added/removed has the
  // service-pages row at a different index — writing the constant would overwrite whatever
  // sits there now (the after-audit row) instead.
  const step = parent.steps.find((s) => s.key === SERVICE_PAGES_STEP_KEY)
    || (parent.steps.length ? parent.steps[parent.steps.length - 1] : null);
  if (!step) return;
  step.status = status;
  step.detail = String(detail || "").slice(0, 240);
  parent.enrichJobId = job.draftId;
  // Stamp once — the enrich run can report "done" more than once (retries, manual re-runs) and
  // the first completion is the honest timestamp.
  if (status === "done" && !parent.servicePagesCreatedAt) {
    parent.servicePagesCreatedAt = new Date().toISOString();
  }
  // Carry the artifacts across. postStatus() below snapshots the PARENT, but the per-page detail and
  // the screenshots were both recorded on the enrich job — without this copy the callback ships two
  // empty arrays and the whole thing silently produces nothing. Only on a real completion, and only
  // when there is something to copy, so a failed retry cannot blank out a good earlier result.
  if (status === "done") {
    if (job.serviceDetail && job.serviceDetail.length) parent.serviceDetail = job.serviceDetail;
    else if (job.servicePages && job.servicePages.length) parent.servicePages = job.servicePages;
    if (job.mockups && job.mockups.length) parent.mockups = job.mockups;
  }
  saveJobs();
  // The enrich run is a SEPARATE job, so nothing in its lifecycle goes through jobStep() on the
  // parent — which is where postStatus() normally fires. Without this call the parent's final step
  // changed only in local state and G99 never learned the service pages were created.
  postStatus(parent);
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
      const cloneUrl = await ghCloneUrl(repo);
      if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
      if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
      if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
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
        STITCH_KEY_OVERRIDE = (job.payload && job.payload.stitchKeyOverride) || null;
        try { results = (await buildStitchSiteWithKeyRotation(pages, theme, "DESKTOP")).results; }
        finally { STITCH_KEY_OVERRIDE = null; if (metaBak) fs.writeFileSync(metaFile, metaBak); }
      } catch (e) { console.warn("enrich: Stitch generation failed, falling back to Gemini:", e.message.slice(0, 160)); }
      const okStitch = (results || []).filter((r) => r.html);
      job.enrichPlan = { ...(job.enrichPlan || {}), engine: okStitch.length ? "stitch" : "gemini", grounded: refCount, composedBriefs: composedCount, mimicked: refStruct ? refStruct.url : null };
      if (okStitch.length) {
        // Run the SAME image pipeline the build path uses — this was the gap that
        // made service-page heroes blurry: Stitch serves a ~512px thumbnail unless
        // the URL asks for full resolution, and enrich skipped the sharpener.
        job.imageReport = job.imageReport || {};
        for (const r of okStitch) {
          // clampViewportHeights: Stitch's `min-h-[90vh]` hero makes every full-page screenshot
          // tool render the hero at ~90% of the image — see the function's comment.
          let h = clampViewportHeights(enforceBrandFonts(r.html, composed)); // Stitch ignores our fonts
          h = enforceArbitraryColors(h, composed);    // named tailwind-config colors die when <head> is stripped
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
      // Returning here also skips captureMockups and mirrorToParent below. That is correct — a dry
      // run never deploys, so there is no live page to screenshot and nothing G99 should be told
      // about — but it is worth stating, because it means a dry run cannot be used to exercise the
      // mockup path, and the skip is otherwise invisible.
      job.mockups = [];
      job.status = "done";
      notify(`✨ [dry run] Enrich preview for *${job.businessName}*: ${services.length} service pages + brand guide`);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/${P.headerOnly ? "nav" : "enrich"}-${slug}-${stamp}`;
    const title = P.headerOnly
      ? `Fix ${P.businessName}: scope the Treatments dropdown to its own nav item`
      : `Enrich ${P.businessName}: service pages + brand guide`;
    // Record what this run produced INSIDE the theme, so it is committed by the same
    // `git add` below. The manifest is how the next job knows this theme's brand and which
    // pages already exist — without it, every run re-guesses and the guesses go stale.
    try {
      updateManifest(themeAbs, P.themeSlug, P.businessName, {
        brand: {
          headingFont: composed.headingFont, bodyFont: composed.bodyFont,
          primary: composed.primary, secondary: composed.secondary, accent: composed.accent,
        },
        existingWebsite: P.referenceWebsite || null,
        liveUrl: job.liveUrl || null,
        pages: mergePageRows(readManifest(themeAbs), services.map((s) => {
          // job.serviceDetail is where svcStatus() records which engine actually produced
          // each page — a Stitch page and a Gemini clone are not interchangeable when we
          // later decide what needs regenerating.
          const d = (job.serviceDetail || []).find((x) => x.slug === s.slug) || {};
          return {
            slug: s.slug, title: s.name, section: "treatments",
            status: d.status === "error" ? "failed" : "built",
            engine: d.engine === "gemini" ? "clone" : "stitch",
            builtAt: new Date().toISOString(), prUrl: null,
          };
        })),
        run: { type: "enrich", at: new Date().toISOString(), pages: services.length, jobId: job.draftId },
      });
    } catch (e) { log_srv("manifest write skipped: " + e.message); }

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
    // Snapshot the theme + mu-plugin as pushed — `tmp` (the clone) is deleted right below,
    // and this is the only point where the final files (base pages + new service pages) are
    // on disk at all, so without this the enrichment's output can never be downloaded again.
    try {
      const snapDir = path.join(GEN, "exports", job.draftId);
      fs.rmSync(snapDir, { recursive: true, force: true });
      fs.cpSync(themeAbs, path.join(snapDir, "theme"), { recursive: true });
      if (fs.existsSync(muAbs)) {
        fs.mkdirSync(path.join(snapDir, "mu-plugin"), { recursive: true });
        fs.cpSync(muAbs, path.join(snapDir, "mu-plugin", path.basename(muAbs)));
      }
      job.zipUrl = `/api/export-zip?dir=${encodeURIComponent(`exports/${job.draftId}`)}&name=${encodeURIComponent(siteFolderName(job))}`;
    } catch (e) { console.warn("enrich snapshot for zip export failed (non-fatal):", e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 3, "done", job.prUrl);

    // 5 — CI watch → auto-fix → merge on green (same rails as edit)
    jobStep(job, 4, "running", "Watching CI build checks…");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st; try { st = await localApi("/api/pr-status", { prUrl: job.prUrl }); } catch (e) { await sleep(10000); continue; }
      jobStep(job, 4, "running", (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ") || "CI starting…");
      if (await ciEarlyExit(job, 4, P.siteId, st, i)) { merged = true; break; }
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

    // Capture the review mockups BEFORE mirrorToParent, because that call is what pushes the
    // status callback to G99 — capturing after it would mean the images miss the very payload
    // that carries them, and this server keeps nothing across a redeploy to send later.
    try {
      job.mockups = await captureMockups(job.liveUrl || P.betaSiteUrl || LIVE_URL, services);
      saveJobs();
    } catch (e) {
      job.mockups = [];   // never block completion on a screenshot
    }

    // Push the real artifacts straight to TED — fire-and-forget, never blocks completion. This is a
    // second, independent delivery route alongside the G99 status callback below; it does not replace it.
    if (job.businessId) {
      const hubspotDealId = P.hubspotDealId || null;
      const hubspotCompanyId = P.hubspotCompanyId || null;
      tedPushArtifacts("MOCKUPS_CAPTURED", {
        businessId: job.businessId, draftId: job.draftId, mockups: job.mockups, hubspotDealId, hubspotCompanyId,
      }).then(r => console.log(`[ted-push] MOCKUPS_CAPTURED biz=${job.businessId} -> ${JSON.stringify(r).slice(0, 200)}`));
      tedPushArtifacts("SERVICE_PAGES_CREATED", {
        businessId: job.businessId, draftId: job.draftId, servicePages: job.serviceDetail, siteUrl: job.liveUrl,
        hubspotDealId, hubspotCompanyId,
      }).then(r => console.log(`[ted-push] SERVICE_PAGES_CREATED biz=${job.businessId} -> ${JSON.stringify(r).slice(0, 200)}`));
    }

    job.status = "done";
    mirrorToParent(job, "done", `${services.length} service page(s) + brand guide merged`);
    notify(`✨ Enriched *${job.businessName}*: ${services.length} service pages + brand guide · ${job.prUrl || ""}`);

    // Inline wireframe QA / CRO audit — fire-and-forget so it never blocks or breaks completion.
    // Runs only when product-service told us which TED tasks to target (it knows the client's task
    // ids; we don't). Without them, the standalone POST /api/wireframe-qa route is used instead.
    const wqTask = P.wireframeQaTaskId || process.env.TED_WIREFRAME_QA_TASK_ID;
    if (TED_API_TOKEN && wqTask) {
      const auditUrl = job.liveUrl || P.betaSiteUrl || LIVE_URL;
      const usedFallback = !P.betaSiteUrl && !job.liveUrl;   // fell back to the shared default URL
      wireframeQaAudit({
        betaUrl: auditUrl,
        tedTaskId: wqTask,
        prereqTaskId: P.mockupTaskId || process.env.TED_MOCKUP_TASK_ID || null,
        services,
        isTestUrl: usedFallback,
      })
        .then(r => console.log(`[wireframe-qa] overall=${r && r.overall} posted=${JSON.stringify(r && r.posted)}`))
        .catch(e => console.error("[wireframe-qa] failed:", e.message));
    }
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
// Never renamed. The home page's URL is the domain, and the brand guide and SEO
// report are client deliverables whose links have already been sent to people —
// a redirect would keep them working, but there is no search benefit to weigh
// against breaking a link somebody has in their inbox.
const SEO_FIXED_SLUGS = new Set(["home", "branding", "brand-guide", "seo", "seo-report"]);
async function seoUrlStrategy(pages, ai) {
  const list = pages.filter((p) => !SEO_FIXED_SLUGS.has(p.slug))
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
    .filter((r) => r.from && r.to && r.from !== r.to && !SEO_FIXED_SLUGS.has(r.from) && known.has(r.from) && !known.has(r.to) && !seen.has(r.to) && seen.add(r.to));
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
    // A missing answer is "not audited", not "0% on topic". Reporting a page as
    // entirely generic because the model returned nothing would be a confident
    // claim about content nobody actually judged.
    const n = Number(d.onTopicPercent);
    const verdict = String(d.verdict || "").trim();
    const pct = Number.isFinite(n) && verdict ? Math.max(0, Math.min(100, Math.round(n))) : null;
    return {
      slug: page.slug, title: page.title, onTopicPercent: pct,
      verdict: verdict || "Could not be audited — the model returned no verdict for this page.",
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

/**
 * Belt and braces for the <title> tag.
 *
 * WordPress prints one only when the theme declared title-tag support during
 * after_setup_theme. A mu-plugin that switches the theme on 'init' misses that
 * hook for the request it switches on, so the page ships with no title at all —
 * which is how removing the theme's hardcoded <title> took the site's title
 * away on a fresh install. Declaring support here covers later requests, and
 * the wp_head hook below prints one directly if WordPress still will not.
 */
add_action('after_setup_theme', function () {
    add_theme_support('title-tag');
});

// WordPress emits its own canonical; ours is page-specific and replaces it.
remove_action('wp_head', 'rel_canonical');

add_action('wp_head', function () {
    $seo = g99_seo_current();

    if (! $seo) {
        return;
    }

    $out = [];

    // Runs at the same priority as _wp_render_title_tag but is added later, so
    // by now WordPress has printed its title or declined to. If it declined,
    // print ours — a page with no <title> at all is the worse failure.
    if (! current_theme_supports('title-tag')) {
        $out[] = '<title>' . esc_html($seo['title']) . '</title>';
    }

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

// A theme folder on disk has no mu-plugin, and the mu-plugin is what says which
// template serves which slug. Rebuilding that from the Template Name headers is
// what lets a dry run point straight at generated/wp-theme/<slug>.
function synthMuSource(themeAbs) {
  const rows = [`    ['title' => 'Home', 'slug' => 'home', 'template' => ''],`];
  for (const f of fs.readdirSync(themeAbs).sort()) {
    const m = f.match(/^page-(.+)\.php$/);
    if (!m) continue;
    const src = fs.readFileSync(path.join(themeAbs, f), "utf8");
    const tpl = (src.match(/Template Name:\s*(.+?)\s*(?:\*\/|-->|\?>|$)/m) || [])[1] || m[1];
    rows.push(`    ['title' => '${tpl.replace(/'/g, "\\'")}', 'slug' => '${m[1]}', 'template' => '${f}'],`);
  }
  return `<?php\n\n$pages = [\n${rows.join("\n")}\n];\n`;
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
  // A dry run does every piece of real work and stops before anything reaches
  // GitHub: no branch, no push, no PR, no merge. `themeDir` goes further and
  // skips the clone too, reading a theme folder straight off disk — which makes
  // iterating on the engine itself instant and offline.
  const dry = !!P.dryRun;
  const workRoot = dry ? path.join(GEN, "seo-preview", String(P.themeSlug || "preview").replace(/[^a-z0-9-]/gi, "")) : tmp;
  try {
    // 1 — pull latest
    let r;
    if (dry) {
      jobStep(job, 0, "running", P.themeDir ? "Copying " + P.themeDir : "Cloning " + repo);
      fs.rmSync(workRoot, { recursive: true, force: true });
      fs.mkdirSync(path.join(workRoot, P.themePath), { recursive: true });
      if (P.themeDir) {
        // Relative to the tool, not to wherever node happened to be launched.
        const from = path.isAbsolute(P.themeDir) ? P.themeDir : path.resolve(DIR, P.themeDir);
        if (!fs.existsSync(from)) throw new Error("themeDir does not exist: " + from);
        fs.cpSync(from, path.join(workRoot, P.themePath), { recursive: true });
      } else {
        const scratch = tmp + "-src";
        r = await runRetry(`gh repo clone ${repo} "${scratch}" -- --depth 1`);
        if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
        fs.cpSync(path.join(scratch, P.themePath), path.join(workRoot, P.themePath), { recursive: true });
        if (P.muPath && fs.existsSync(path.join(scratch, P.muPath))) {
          fs.mkdirSync(path.dirname(path.join(workRoot, P.muPath)), { recursive: true });
          fs.cpSync(path.join(scratch, P.muPath), path.join(workRoot, P.muPath));
        }
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      // No mu-plugin came along (a theme folder on disk has none), so rebuild
      // the page map from the Template Name headers instead.
      if (P.muPath && !fs.existsSync(path.join(workRoot, P.muPath))) {
        fs.mkdirSync(path.dirname(path.join(workRoot, P.muPath)), { recursive: true });
        fs.writeFileSync(path.join(workRoot, P.muPath), synthMuSource(path.join(workRoot, P.themePath)));
      }
      jobStep(job, 0, "done", "Dry run — working in " + workRoot);
    } else {
      jobStep(job, 0, "running", "Cloning " + repo);
      r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
      const cloneUrl = await ghCloneUrl(repo);
      if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
      if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
      if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
      jobStep(job, 0, "done", "Latest code pulled");
    }
    const themeAbs = path.join(workRoot, P.themePath);
    if (!fs.existsSync(themeAbs)) throw new Error("theme not found: " + P.themePath);
    const muAbs = P.muPath ? path.join(workRoot, P.muPath) : "";

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

    if (dry) {
      // The report is the deliverable here, since there is no PR to carry it.
      const reportAbs = path.join(workRoot, "SEO-REPORT.md");
      fs.writeFileSync(reportAbs, seoPrBody(job, entries, renames, audit, check, stripped, origin));
      job.previewDir = workRoot;
      job.reportPath = reportAbs;
      for (const i of [8, 9, 10]) jobStep(job, i, "done", "skipped (dry run)");
      job.status = "done";
      notify(`🔎 [dry run] SEO preview for *${job.businessName}*: ${pages.length} page(s) · ${check.pass}/${check.total} checks · ${workRoot}`);
      return;
    }

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
      if (await ciEarlyExit(job, 9, P.siteId, st, i)) { merged = true; break; }
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
    // A dry run's working directory IS its output, so it survives a failure —
    // that is where you look to find out what went wrong.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) { job.status = "cancelled"; }
    else {
      job.error = e.message; job.status = "error";
      if (dry) job.previewDir = workRoot;
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") { job.steps[job.currentStep].status = "error"; job.steps[job.currentStep].detail = String(e.message).slice(0, 240); }
      console.error(`seo job ${job.draftId} failed:`, e.message);
      notify(`❌ SEO${dry ? " [dry run]" : ""} failed for *${job.businessName}*: ${e.message}`);
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

// ============================================================ PRE-RELEASE ENGINE
// "Perform PR" is an extensible release gate. Its first task audits every page
// registered by the active WordPress theme at a mobile viewport, fixes only
// evidenced responsive defects, uses the normal PR/CI/merge rails, then captures
// the live result again. Screenshots stay in Studio, outside the client theme.
const PRE_RELEASE_STEPS = [
  "Pull latest code", "Inventory every page", "Capture mobile screenshots",
  "Audit mobile responsiveness", "Fix responsive issues", "Check the changes",
  "Push + open PR", "CI checks then merge", "Capture post-release proof", "Verify pre-release",
];
const MOBILE_CAPTURE_RETRY_MS = [4000, 10000];
const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

function safeArtifactName(value) {
  return String(value || "page").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";
}
function mobilePageUrl(origin, slug) {
  const root = String(origin || "").replace(/\/+$/, "");
  return slug === "home" ? root + "/" : root + "/" + String(slug || "").replace(/^\/+|\/+$/g, "") + "/";
}
function isSafeArtifactSegment(value) {
  const s = String(value || "");
  return s !== "." && s !== ".." && /^[a-z0-9][a-z0-9_.-]*$/i.test(s);
}
const BROWSERLESS_LAYOUT_CODE = `export default async ({ page, context }) => {
  await page.setViewport(context.viewport);
  const response = await page.goto(context.url, { waitUntil: "networkidle2", timeout: context.timeout });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const metrics = await page.evaluate(() => {
    const vw = window.innerWidth;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const label = (element) => {
      const id = element.id ? "#" + element.id : "";
      const classes = Array.from(element.classList || []).slice(0, 3).map((name) => "." + name.replace(/[^a-z0-9_-]/gi, "")).join("");
      return (element.tagName || "element").toLowerCase() + id + classes;
    };
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { selector: label(element), text: String(element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100), left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), position: style.position, zIndex: style.zIndex };
    };
    const all = Array.from(document.body.querySelectorAll("*")).filter(visible);
    const overflowElements = all.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > vw + 1;
    }).slice(0, 30).map(describe);
    const candidates = Array.from(document.querySelectorAll("button,a,[role=button],span,p,h1,h2,h3,h4,input,select,textarea")).filter(visible).slice(0, 160);
    const overlaps = [];
    for (let i = 0; i < candidates.length && overlaps.length < 30; i++) {
      for (let j = i + 1; j < candidates.length && overlaps.length < 30; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        const width = Math.max(0, Math.min(ar.right, br.right) - Math.max(ar.left, br.left));
        const height = Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
        const overlapArea = width * height;
        const smaller = Math.min(ar.width * ar.height, br.width * br.height);
        if (smaller > 0 && overlapArea / smaller >= 0.2) overlaps.push({ first: describe(a), second: describe(b), ratio: Math.round(overlapArea / smaller * 100) / 100 });
      }
    }
    return { viewportWidth: vw, documentWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > vw + 1, overflowElements, overlaps };
  });
  return { data: { httpStatus: response ? response.status() : null, ...metrics }, type: "application/json" };
};`;

function browserlessLayoutRequest(url) {
  return { code: BROWSERLESS_LAYOUT_CODE, context: { url, viewport: MOBILE_VIEWPORT, timeout: Math.min(BROWSERLESS_TIMEOUT_MS, 45000) } };
}
async function captureMobileLayout(url) {
  const api = `${BROWSERLESS_URL}/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSERLESS_TIMEOUT_MS);
  try {
    const response = await fetch(api, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(browserlessLayoutRequest(url)),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { error: `Browserless function ${response.status}: ${String(body && (body.message || body.error) || "request failed").slice(0, 120)}` };
    const data = body && body.data && typeof body.data === "object" ? body.data : body;
    return data && typeof data === "object" ? data : { error: "Browserless function returned invalid layout data" };
  } catch (error) {
    return { error: String(error && error.message || error).slice(0, 140) };
  } finally { clearTimeout(timer); }
}
function issueSupportedByLayout(issue, layout) {
  if (!layout || layout.error) return true;
  const signal = [issue && issue.kind, issue && issue.description].filter(Boolean).join(" ")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (signal.includes("horizontal-overflow") || signal.includes("layout-overflow")) return layout.horizontalOverflow !== false;
  if (signal.includes("overlap") && Array.isArray(layout.overlaps)) return layout.overlaps.length > 0;
  return true;
}
function browserlessScreenshotRequest(url) {
  return {
    url,
    viewport: MOBILE_VIEWPORT,
    gotoOptions: { waitUntil: "networkidle2", timeout: Math.min(BROWSERLESS_TIMEOUT_MS, 45000) },
    waitForTimeout: 1500,
    bestAttempt: true,
    options: { fullPage: true, captureBeyondViewport: true, type: "jpeg", quality: 82 },
  };
}
function preReleaseMarkerUrl(origin, themeSlug, jobId, probe = Date.now()) {
  const root = String(origin || "").replace(/\/+$/, "");
  return `${root}/app/themes/${encodeURIComponent(themeSlug)}/g99-pre-release-marker.txt?release=${encodeURIComponent(jobId)}&probe=${encodeURIComponent(probe)}`;
}
function screenshotBuffersEqual(before, after) {
  return Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.length === after.length && before.equals(after);
}
function mobileArtifactDiskPath(capture) {
  return path.join(GEN, "pre-release", ...String(capture && capture.screenshot || "").split("/").slice(2).map(decodeURIComponent));
}
function mobileScreenshotsEqual(before, after) {
  try {
    return screenshotBuffersEqual(fs.readFileSync(mobileArtifactDiskPath(before)), fs.readFileSync(mobileArtifactDiskPath(after)));
  } catch (_) { return false; }
}
async function waitForPreReleaseDeployment(liveUrl, themeSlug, jobId) {
  const timeoutMs = Math.max(30000, Number(process.env.PR_DEPLOY_TIMEOUT_MS || 900000) || 900000);
  const pollMs = Math.max(2000, Number(process.env.PR_DEPLOY_POLL_MS || 10000) || 10000);
  const started = Date.now();
  let last = "not found";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(preReleaseMarkerUrl(liveUrl, themeSlug, jobId), {
        redirect: "follow", cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, max-age=0", "User-Agent": "G99PreReleaseDeployProbe/1.0" },
      });
      const value = response.ok ? (await response.text()).trim() : "";
      if (response.ok && value === jobId) return { deployedAt: new Date().toISOString() };
      last = response.ok ? `marker contained ${value.slice(0, 60) || "empty content"}` : `HTTP ${response.status}`;
    } catch (error) { last = String(error && error.message || error).slice(0, 120); }
    await sleep(pollMs);
  }
  throw new Error(`deployment did not expose release marker ${jobId} within ${Math.round(timeoutMs / 60000)} minute(s): ${last}`);
}
function writeMobileScreenshot(jobId, phase, slug, bytes, mime) {
  const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  const ext = types[mime];
  if (!ext || !Buffer.isBuffer(bytes) || !bytes.length) throw new Error("Browserless returned an invalid screenshot");
  const rel = [safeArtifactName(jobId), safeArtifactName(phase), safeArtifactName(slug) + "." + ext];
  const dir = path.join(GEN, "pre-release", rel[0], rel[1]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, rel[2]), bytes);
  return "/pr-artifacts/" + rel.map(encodeURIComponent).join("/");
}
async function captureMobilePage(jobId, phase, page) {
  if (!BROWSERLESS_TOKEN) return { ...page, error: "BROWSERLESS_TOKEN is not configured" };
  let last = null;
  for (let attempt = 0; attempt <= MOBILE_CAPTURE_RETRY_MS.length; attempt++) {
    if (attempt) await sleep(MOBILE_CAPTURE_RETRY_MS[attempt - 1]);
    try {
      const renderUrl = new URL(page.url);
      renderUrl.searchParams.set("__g99_pr", `${jobId}-${phase}-${attempt}-${Date.now()}`);
      const pre = await fetch(renderUrl, { redirect: "follow", cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 G99MobilePreRelease", "Cache-Control": "no-cache, no-store, max-age=0" } });
      if (!pre.ok) throw new Error(`page returned HTTP ${pre.status}`);
      const api = `${BROWSERLESS_URL}/screenshot?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BROWSERLESS_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(api, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
          body: JSON.stringify(browserlessScreenshotRequest(renderUrl.toString())),
        });
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 140);
        throw new Error(`Browserless ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const targetStatus = Number(response.headers.get("x-response-code") || 0);
      if (targetStatus >= 400) throw new Error(`target page returned HTTP ${targetStatus} in Browserless`);
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!/^image\/(png|jpeg|webp)$/.test(mime)) throw new Error(`Browserless returned ${mime || "no content-type"}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const layout = await captureMobileLayout(renderUrl.toString());
      return {
        slug: page.slug, title: page.title, file: page.file, url: page.url,
        screenshot: writeMobileScreenshot(jobId, phase, page.slug, bytes, mime),
        width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height,
        provider: "browserless", layout, capturedAt: new Date().toISOString(),
      };
    } catch (e) { last = e; }
  }
  return { ...page, error: String(last && last.message || "capture failed").slice(0, 200) };
}function issueQuotedLabels(issue) {
  const text = [issue && issue.description, issue && issue.evidence].filter(Boolean).join(" ")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const labels = [];
  const re = /'([^']{2,80})'|"([^"]{2,80})"/g;
  let match;
  while ((match = re.exec(text))) labels.push(String(match[1] || match[2]).trim());
  return [...new Set(labels.filter(Boolean))];
}
function issueSupportedBySource(issue, sourceContext) {
  if (!sourceContext) return true;
  const source = String(sourceContext).toLowerCase().replace(/\s+/g, " ");
  const labels = issueQuotedLabels(issue);
  return !labels.length || labels.every((label) => source.includes(label.toLowerCase().replace(/\s+/g, " ")));
}
function mobileSourceContext(themeAbs, templateFile) {
  const files = [templateFile, "header.php", "footer.php", "style.css"];
  return files.map((file) => {
    const abs = path.join(themeAbs, file);
    if (!fs.existsSync(abs)) return "";
    return `\n/* SOURCE ${file} */\n${fs.readFileSync(abs, "utf8")}`;
  }).join("\n").slice(0, 50000);
}
async function inspectMobileScreenshot(capture, sourceContext = "") {
  const diskPath = mobileArtifactDiskPath(capture);
  const ext = path.extname(diskPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : "image/webp";
  const prompt = [
    `Act as a strict mobile-responsive QA engineer. Inspect this full-page screenshot rendered by Browserless Chromium at a ${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height} mobile viewport.`,
    `Page: ${capture.title} (${capture.url}). Source template: ${capture.file}.`,

    "Report ONLY visible mobile responsiveness defects: horizontal overflow, clipped or cut-off content, overlapping elements, unusable navigation, broken stacking, tiny tap targets or text, or media wider than viewport.",
    "The relevant rendered source is included below. Every named control or quoted visible label in an issue MUST exist in this source. If it does not, do not report that issue.",
    "Use the source to identify the exact component and likely CSS cause; do not guess negative margins, absolute positioning, or an adjacent control without source evidence.",
    "Do not report aesthetics, copy, SEO, desktop concerns, performance, or imagined defects. A long screenshot is normal.",
    sourceContext ? `RENDERED SOURCE CONTEXT:\n-----\n${sourceContext}\n-----` : "",
    capture.layout ? `BROWSERLESS DOM GEOMETRY:\n${JSON.stringify(capture.layout)}` : "",
    'Return ONLY minified JSON: {"pass":true|false,"issues":[{"kind":"short stable id","severity":"high|medium|low","description":"specific visible defect","evidence":"what and where in screenshot","fixHint":"precise CSS/layout direction"}]}.',
  ].join("\n");
  const raw = await geminiCall([{ text: prompt }, { inline_data: { mime_type: mime, data: fs.readFileSync(diskPath).toString("base64") } }],
    { temperature: 0.1, maxOutputTokens: 1800, timeoutMs: 60000 });
  const d = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const reported = (Array.isArray(d.issues) ? d.issues : []).slice(0, 12).map((x) => ({
    source: "vision", kind: String(x.kind || "layout"), severity: ["high", "medium", "low"].includes(x.severity) ? x.severity : "medium",
    description: String(x.description || "Mobile layout issue").slice(0, 220), evidence: String(x.evidence || "").slice(0, 240),
    fixHint: String(x.fixHint || "").slice(0, 240),
  }));
  const visual = reported.filter((issue) => issueSupportedBySource(issue, sourceContext) && issueSupportedByLayout(issue, capture.layout));
  const rejectedIssues = reported.filter((issue) => !issueSupportedBySource(issue, sourceContext) || !issueSupportedByLayout(issue, capture.layout));
  return { ...capture, issues: visual, rejectedIssues, pass: !visual.length };
}
function mobileIssueBrief(rows) {
  return rows.filter((p) => p.issues && p.issues.length).map((p) => [
    `PAGE ${p.title} - ${p.file} - ${p.url}`,
    ...p.issues.map((x, i) => `${i + 1}. [${x.severity}] ${x.description}${x.evidence ? ` Evidence: ${x.evidence}` : ""}${x.fixHint ? ` Fix direction: ${x.fixHint}` : ""}`),
  ].join("\n")).join("\n\n");
}
async function verifyResponsiveDiff(rows, diff, onlyIds = null) {
  let issues = [];
  for (const page of rows || []) {
    for (let i = 0; i < (page.issues || []).length; i++) {
      const issue = page.issues[i];
      issues.push({
        id: `${page.slug}:${i + 1}`, page: page.title, file: page.file,
        description: issue.description, evidence: issue.evidence, fixHint: issue.fixHint,
      });
    }
  }
  if (onlyIds) issues = issues.filter((issue) => onlyIds.has(issue.id));
  const changes = diffChanges(diff);
  if (!issues.length) return { issues: [], missed: [] };
  if (!changes.length) return { issues, missed: issues.map((issue) => ({ ...issue, reason: "no source lines changed" })) };
  const prompt = [
    "Review a proposed WordPress mobile-responsive patch before it is allowed to merge.",
    "For every reported issue, decide whether the changed source lines DIRECTLY modify the element or shared rule implicated by the evidence.",
    "A nearby or unrelated responsive change does not count. Example: changing a CTA row does not fix an overlapping feature-card stack elsewhere in the hero.",
    "Generic overflow-x:hidden does not count when it merely conceals clipped content. The underlying layout must be corrected.",
    "A shared footer/CSS change may satisfy multiple pages only when its cited lines directly address their same root cause.",
    "Each done=true verdict must cite at least one real changed-line id. Be strict; uncertainty means done=false.",
    "", "CHANGED LINES:", "-----", changesText(changes), "-----", "", "ISSUES:",
    ...issues.map((issue) => `${issue.id} | page=${issue.page} | template=${issue.file} | ${issue.description} | evidence=${issue.evidence || "none"} | requested direction=${issue.fixHint || "none"}`),
    "", 'Return ONLY minified JSON: {"results":[{"id":"slug:number","done":true|false,"lines":[1],"reason":"specific short reason"}]}',
  ].join("\n");
  const raw = await geminiCall([{ text: prompt }], { temperature: 0.1, maxOutputTokens: 3000, timeoutMs: 60000, json: true });
  const data = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
  const results = Array.isArray(data.results) ? data.results : [];
  const top = Math.min(changes.length, CHANGE_CAP);
  const missed = [];
  for (const issue of issues) {
    const verdict = results.find((result) => result && result.id === issue.id);
    const cited = (verdict && Array.isArray(verdict.lines) ? verdict.lines : []).map(Number)
      .filter((line) => Number.isInteger(line) && line >= 1 && line <= top);
    if (!verdict || verdict.done !== true || !cited.length) {
      missed.push({ ...issue, reason: String(verdict && verdict.reason || "no grounded diff evidence").slice(0, 220) });
    }
  }
  return { issues, missed };
}
async function repairResponsiveFile(rel, current, misses, capture) {
  const diskPath = mobileArtifactDiskPath(capture);
  const ext = path.extname(diskPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const prompt = [
    `Repair the exact mobile defects in ${rel}. Return the COMPLETE final file content only; no markdown or commentary.`,
    "You are given the actual failing 390px screenshot and current source. Use BOTH. The earlier text diagnosis may name the wrong CSS cause, so trust the visible evidence and source structure over its guessed fix direction.",
    "Modify the exact named component, not a nearby CTA or unrelated responsive container. Use the smallest scoped mobile fix. Preserve desktop behavior, copy, branding, and unrelated bytes.",
    "Do not hide overflow to conceal broken content. Correct sizing, stacking, positioning, contrast, wrapping, or flow at the actual source element.",
    "", "UNRESOLVED FINDINGS:",
    ...misses.map((miss, index) => `${index + 1}. ${miss.description}\nEvidence: ${miss.evidence || "none"}\nPrevious reviewer: ${miss.reason || "not grounded"}`),
    capture.layout ? `\nMEASURED BROWSERLESS DOM GEOMETRY (authoritative for which elements really overflow/overlap):\n${JSON.stringify(capture.layout)}` : "",
    "", "CURRENT SOURCE:", "-----", current, "-----", "", "Return the complete modified file now.",
  ].join("\n");
  return stripFence(await geminiCall([
    { text: prompt },
    { inline_data: { mime_type: mime, data: fs.readFileSync(diskPath).toString("base64") } },
  ], { temperature: 0.1, maxOutputTokens: 16000, timeoutMs: 90000 }));
}
function safeResponsivePlanFiles(modelFiles, themePath, failingRows, manifest) {
  const clean = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const theme = clean(themePath);
  const known = new Set((manifest || []).map((file) => clean(file && file.path)).filter(Boolean));
  const resolved = [];
  const seen = new Set();
  for (const file of Array.isArray(modelFiles) ? modelFiles : []) {
    if (!file || file.op === "delete") continue;
    const raw = clean(file.path);
    const candidates = [raw, `${theme}/${raw}`];
    const byName = [...known].filter((path_) => path_.endsWith("/" + path.posix.basename(raw)));
    if (byName.length === 1) candidates.push(byName[0]);
    const path_ = candidates.find((candidate) => candidate.startsWith(theme + "/") && known.has(candidate));
    if (!path_ || seen.has(path_)) continue;
    seen.add(path_);
    resolved.push({ ...file, path: path_, op: "modify" });
  }
  if (resolved.length) return resolved.slice(0, 20);

  const add = (relative, instruction) => {
    const path_ = `${theme}/${clean(relative)}`;
    if (!known.has(path_) || seen.has(path_)) return;
    seen.add(path_);
    resolved.push({ path: path_, op: "modify", instruction });
  };
  for (const page of failingRows || []) {
    const descriptions = (page.issues || []).map((issue) => issue.description).filter(Boolean);
    add(page.file, `Fix the measured mobile defects on ${page.title || page.file}: ${descriptions.join(" | ")}`);
  }
  const all = (failingRows || []).flatMap((page) => page.issues || [])
    .map((issue) => `${issue.kind || ""} ${issue.description || ""} ${issue.evidence || ""}`).join(" ").toLowerCase();
  if (/footer/.test(all)) add("footer.php", "Fix the measured shared mobile footer defects without changing desktop layout.");
  if (/navigation|navbar|header|site title|mobile menu/.test(all)) add("header.php", "Fix the measured shared mobile header/navigation defects without changing desktop layout.");
  return resolved.slice(0, 20);
}
function scanResponsiveTheme(root, themePath, muPath) {
  const manifest = [], source = [];
  for (const relRoot of [themePath, ...(muPath ? [muPath] : [])]) {
    const absRoot = path.join(root, relRoot);
    if (!fs.existsSync(absRoot)) continue;
    const walk = (abs, rel) => {
      const st = fs.statSync(abs);
      if (st.isDirectory()) { for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), path.join(rel, name)); return; }
      const clean = rel.replace(/\\/g, "/");
      manifest.push({ path: clean, bytes: st.size });
      if (TEXTUAL.test(rel) && st.size <= 400000) source.push({ rel: clean, content: fs.readFileSync(abs, "utf8") });
    };
    walk(absRoot, relRoot);
  }
  return { manifest, source };
}
function newPreReleaseJob(payload) {
  return {
    type: "pre-release", draftId: String(payload.jobId), businessId: null,
    businessName: payload.businessName || payload.siteId || "Site", status: "queued", currentStep: 0,
    steps: PRE_RELEASE_STEPS.map((label) => ({ label, status: "pending", detail: "" })), payload,
    prUrl: null, branch: null, mobileBefore: null, mobileAfter: null, mobileSummary: null,
    editPlan: null, editSummary: "Pre-release mobile responsiveness", error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
function enqueuePreReleaseJob(payload) {
  const job = newPreReleaseJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId);
  saveJobs();
  processJobQueue();
  return job;
}
function mobilePrBody(job, pages, changed) {
  const L = [`Pre-release mobile responsiveness pass for **${job.businessName}**.`, "",
    `Audited **${pages.length} page(s)** at a mobile viewport.`, "",
    "| Page | Findings before fix |", "|---|---:|"];
  for (const p of pages) L.push(`| \`/${p.slug === "home" ? "" : p.slug + "/"}\` | ${(p.issues || []).length} |`);
  L.push("", `Changed ${changed.length} file(s):`, ...changed.map((x) => `- \`${x.path}\``), "",
    "Post-release screenshots and verification are recorded by the Studio run after deployment.");
  return L.join("\n");
}

async function runPreReleaseJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  COST_SINK = job.cost;
  const P = job.payload, repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99pr-" + Date.now());
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => {
    let r;
    for (let i = 1; i <= n; i++) {
      r = await run(cmd, cwd);
      if (!r.code) return r;
      await sleep(3000 * i);
    }
    return r;
  };
  try {
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = await ghCloneUrl(repo);
    if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
    const themeAbs = path.join(tmp, P.themePath);
    const muAbs = P.muPath ? path.join(tmp, P.muPath) : "";
    if (!fs.existsSync(themeAbs)) throw new Error("theme not found: " + P.themePath);
    jobStep(job, 0, "done", "Latest code pulled");

    jobStep(job, 1, "running", "Reading registered page templates...");
    const muSrc = muAbs && fs.existsSync(muAbs) ? fs.readFileSync(muAbs, "utf8") : synthMuSource(themeAbs);
    const { pages: sourcePages } = readSeoPages(themeAbs, muSrc);
    if (!sourcePages.length) throw new Error("no registered pages found in active theme");
    if (!P.liveUrl) throw new Error("site has no live domain in NocoDB - mobile pages cannot be rendered");
    const pages = sourcePages.map((p) => ({ slug: p.slug, title: p.title, file: p.file, url: mobilePageUrl(P.liveUrl, p.slug) }));
    job.mobilePages = pages;
    const sourceByFile = new Map(pages.map((page) => [page.file, mobileSourceContext(themeAbs, page.file)]));
    jobStep(job, 1, "done", `${pages.length} page(s) registered in backend`);

    const before = [];
    for (let i = 0; i < pages.length; i++) {
      jobStep(job, 2, "running", `${pages[i].title} (${i + 1}/${pages.length})`);
      const cap = await captureMobilePage(job.draftId, "before", pages[i]);
      before.push(cap);
      job.mobileBefore = before;
      saveJobs();
    }
    const captureErrors = before.filter((x) => x.error);
    if (captureErrors.length) throw new Error(`mobile screenshot failed for ${captureErrors.length}/${pages.length} page(s): ${captureErrors.map((x) => x.title).join(", ")}`);
    jobStep(job, 2, "done", `${before.length} full-page mobile screenshot(s) captured`);

    const audited = [];
    for (let i = 0; i < before.length; i++) {
      jobStep(job, 3, "running", `${before[i].title} (${i + 1}/${before.length})`);
      audited.push(await inspectMobileScreenshot(before[i], sourceByFile.get(before[i].file) || ""));
      job.mobileBefore = audited.concat(before.slice(i + 1));
      saveJobs();
    }
    job.mobileBefore = audited;
    const failing = audited.filter((x) => !x.pass);
    const issueCount = failing.reduce((n, x) => n + x.issues.length, 0);
    jobStep(job, 3, "done", issueCount ? `${issueCount} issue(s) across ${failing.length}/${audited.length} page(s)` : `all ${audited.length} page(s) pass`);

    if (!issueCount) {
      for (const i of [4, 5, 6, 7]) jobStep(job, i, "done", "skipped - no responsive defects found");
      job.mobileAfter = audited.map((x) => ({ ...x, phase: "before" }));
      jobStep(job, 8, "done", "Initial screenshots are release proof - no code changed");
      job.mobileSummary = { pass: true, pages: audited.length, beforeIssues: 0, afterIssues: 0, changedFiles: 0 };
      jobStep(job, 9, "done", `${audited.length}/${audited.length} pages pass`);
      job.status = "done";
      return;
    }

    jobStep(job, 4, "running", `Planning fixes for ${issueCount} evidenced issue(s)...`);
    const scan = scanResponsiveTheme(tmp, P.themePath, P.muPath);
    const issueBrief = mobileIssueBrief(audited);
    const request = [
      `Fix ONLY the mobile responsiveness defects observed by the pre-release audit for ${P.businessName}.`,
      "Preserve desktop appearance, content, branding, URLs, behavior, and unrelated formatting.",
      "Prefer shared responsive CSS when one root cause affects multiple pages. Use scoped media queries and fluid sizing; do not hide meaningful content to make checks pass.",
      "Every listed page was rendered from the named template. Do not touch pages without an evidenced issue unless changing a shared rule required by an evidenced issue.",
      "", issueBrief,
    ].join("\n");
    const outline = scan.source.map((f) => ({ rel: f.rel, items: fileOutline(f.content) })).filter((x) => x.items.length);
    const plan0 = await editPlan(scan.manifest, {
      prompt: request, businessName: P.businessName, outline: outlineText(outline), evidence: issueBrief,
    }, { aiModel: "gemini" });
    job.plannerPaths = (plan0.files || []).map((file) => String(file && file.path || "")).filter(Boolean).slice(0, 30);
    const plan = {
      summary: String(plan0.summary || "Fix mobile responsiveness"),
      files: safeResponsivePlanFiles(plan0.files, P.themePath, failing, scan.manifest),
    };
    if (!plan.files.length) throw new Error("no registered failing page templates were found in the active theme");
    job.editPlan = plan.files.map((f) => ({ path: f.path, op: f.op || "modify" }));
    job.editSummary = plan.summary;
    const context = plan.files.map((f) => `${f.op || "modify"} ${f.path}`).join("\n");
    for (let i = 0; i < plan.files.length; i++) {
      const f = plan.files[i];
      const abs = path.join(tmp, f.path);
      const op = f.op === "create" ? "create" : "modify";
      jobStep(job, 4, "running", `${path.basename(f.path)} (${i + 1}/${plan.files.length})`);
      const current = op === "modify" && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      const content = await editFileContent(op, f.path, f.instruction || plan.summary, current, context,
        { aiModel: "gemini" }, { prompt: request });
      if (!content || (current.includes("<?php") && !content.includes("<?php"))) throw new Error("AI returned invalid content for " + f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const markerPath = path.join(themeAbs, "g99-pre-release-marker.txt");
    fs.writeFileSync(markerPath, job.draftId + "\n");
    jobStep(job, 4, "done", `${plan.files.length} file(s) proposed`);

    jobStep(job, 5, "running", "Checking diff, syntax, and issue coverage...");
    const paths = `"${P.themePath}"`;
    await run(`git add -A -- ${paths}`, tmp);
    let diff = await run(`git --no-pager diff --cached --stat -- ${paths}`, tmp);
    if (!String(diff.stdout || "").trim()) throw new Error("responsive fix produced no code changes");
    let whitespace = await run(`git diff --cached --check -- ${paths}`, tmp);
    if (whitespace.code) throw new Error("responsive fix failed git diff check: " + String(whitespace.stdout || whitespace.stderr).slice(-200));
    let patch = await run(`git --no-pager diff --cached -- ${paths}`, tmp);
    let coverage = await verifyResponsiveDiff(audited, patch.stdout || "");
    const pagesByFile = new Map(audited.map((page) => [page.file, page]));
    for (let repairAttempt = 1; coverage.missed.length && repairAttempt <= 3; repairAttempt++) {
      const targets = coverage.missed;
      jobStep(job, 5, "running", `Screenshot-guided repair ${repairAttempt}/3 for ${targets.length} finding(s)...`);
      const missedByFile = new Map();
      for (const missed of targets) {
        const list = missedByFile.get(missed.file) || [];
        list.push(missed);
        missedByFile.set(missed.file, list);
      }
      for (const [file, misses] of missedByFile) {
        const page = pagesByFile.get(file);
        const rel = `${P.themePath}/${file}`;
        const abs = path.join(tmp, rel);
        if (!page || !fs.existsSync(abs)) continue;
        const current = fs.readFileSync(abs, "utf8");
        const repaired = await repairResponsiveFile(rel, current, misses, page);
        if (!repaired || (current.includes("<?php") && !repaired.includes("<?php"))) throw new Error("AI returned invalid repair content for " + rel);
        fs.writeFileSync(abs, repaired);
        if (!job.editPlan.some((item) => item.path === rel)) job.editPlan.push({ path: rel, op: "modify" });
      }
      await run(`git add -A -- ${paths}`, tmp);
      whitespace = await run(`git diff --cached --check -- ${paths}`, tmp);
      if (whitespace.code) throw new Error("responsive repair failed git diff check: " + String(whitespace.stdout || whitespace.stderr).slice(-200));
      patch = await run(`git --no-pager diff --cached -- ${paths}`, tmp);
      const retryIds = new Set(targets.map((missed) => missed.id));
      const retryCoverage = await verifyResponsiveDiff(audited, patch.stdout || "", retryIds);
      coverage = { issues: coverage.issues, missed: retryCoverage.missed };
    }    if (coverage.missed.length) {
      const failedDir = path.join(GEN, "pre-release", safeArtifactName(job.draftId));
      fs.mkdirSync(failedDir, { recursive: true });
      const failedPatchPath = path.join(failedDir, "failed-responsive-patch.diff");
      fs.writeFileSync(failedPatchPath, String(patch.stdout || ""));
      job.failedPatch = failedPatchPath;
      saveJobs();      throw new Error(`responsive patch does not directly address ${coverage.missed.length} finding(s): ${coverage.missed.slice(0, 3).map((miss) => `${miss.page}: ${miss.description}`).join(" | ")}`);
    }
    diff = await run(`git --no-pager diff --cached --stat -- ${paths}`, tmp);
    jobStep(job, 5, "done", `All ${coverage.issues.length} issue(s) grounded in patch - ${String(diff.stdout || "").trim().split("\n").slice(-1)[0]}`);
    jobStep(job, 6, "running", "Pushing + opening PR...");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/pre-release-mobile-${P.themeSlug.replace(/^g99-/, "")}-${stamp}`;
    const title = `Pre-release ${P.businessName}: mobile responsiveness`;
    await run(`git checkout -b "${branch}"`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "${title.replace(/"/g, "'")}"`, tmp);
    if (r.code) throw new Error("commit failed: " + String(r.stderr || r.stdout).slice(-180));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    const bodyFile = path.join(os.tmpdir(), `pre-release-pr-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, mobilePrBody(job, audited, job.editPlan));
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body-file "${bodyFile}"`, tmp);
    fs.rmSync(bodyFile, { force: true });
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    job.branch = branch;
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    jobStep(job, 6, "done", job.prUrl);

    jobStep(job, 7, "running", "Watching CI build checks...");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st;
      try { st = await localApi("/api/pr-status", { prUrl: job.prUrl, requireAllChecks: true }); }
      catch (e) { await sleep(10000); continue; }
      jobStep(job, 7, "running", (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ") || "CI starting...");
      if (await ciEarlyExit(job, 7, P.siteId, st, i)) { merged = true; break; }
      if (st.allPass) {
        await awaitApprovalIfNeeded(job, P.siteId, 7);
        if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl });
        merged = true;
        jobStep(job, 7, "done", `Merged${fixes ? ` after ${fixes} fix(es)` : ""}`);
        break;
      }
      if (st.anyFail) {
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts - " + job.prUrl);
        fixes++;
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        if (fix.billing) throw new Error(fix.message);
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI: " + (fix.message || ""));
        await sleep(20000);
        continue;
      }
      await sleep(10000);
    }
    if (!merged) throw new Error("CI watch timed out - " + job.prUrl);
    jobStep(job, 8, "running", `Waiting for exact release ${job.draftId} to deploy...`);
    const deployed = await waitForPreReleaseDeployment(P.liveUrl, P.themeSlug, job.draftId);
    job.deployedAt = deployed.deployedAt;
    const settleWait = Math.max(0, Number(process.env.PR_DEPLOY_WAIT_MS || 5000) || 5000);
    if (settleWait) await sleep(settleWait);
    fs.rmSync(tmp, { recursive: true, force: true });
    jobStep(job, 8, "running", `Release marker confirmed; capturing ${pages.length} page(s)...`);    const after = [];
    for (let i = 0; i < pages.length; i++) {
      jobStep(job, 8, "running", `${pages[i].title} (${i + 1}/${pages.length})`);
      const cap = await captureMobilePage(job.draftId, "after", pages[i]);
      if (cap.error) throw new Error(`post-release screenshot failed for ${pages[i].title}: ${cap.error}`);
      if (!audited[i].pass && mobileScreenshotsEqual(audited[i], cap)) throw new Error(`post-release proof for ${pages[i].title} is pixel-identical to its failing before screenshot`);
      after.push(cap);
      job.mobileAfter = after;
      saveJobs();
    }
    jobStep(job, 8, "done", `${after.length} post-release screenshot(s) captured`);

    const verified = [];
    for (let i = 0; i < after.length; i++) {
      jobStep(job, 9, "running", `${after[i].title} (${i + 1}/${after.length})`);
      verified.push(await inspectMobileScreenshot(after[i], sourceByFile.get(after[i].file) || ""));
      job.mobileAfter = verified.concat(after.slice(i + 1));
      saveJobs();
    }
    job.mobileAfter = verified;
    const remaining = verified.reduce((n, x) => n + (x.issues || []).length, 0);
    job.mobileSummary = { pass: remaining === 0, pages: pages.length, beforeIssues: issueCount, afterIssues: remaining, changedFiles: plan.files.length };
    if (remaining) throw new Error(`post-release mobile verification still found ${remaining} issue(s) - screenshots preserved for review`);
    jobStep(job, 9, "done", `${pages.length}/${pages.length} pages pass - ${issueCount} issue(s) fixed`);
    job.status = "done";
    notify(`Pre-release mobile check passed for *${job.businessName}*: ${pages.length} page(s) - ${issueCount} issue(s) fixed - ${job.prUrl || ""}`);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) job.status = "cancelled";
    else {
      job.error = e.message;
      job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") {
        job.steps[job.currentStep].status = "error";
        job.steps[job.currentStep].detail = String(e.message).slice(0, 240);
      }
      console.error(`pre-release job ${job.draftId} failed:`, e.message);
      notify(`Pre-release failed for *${job.businessName}*: ${e.message}`);
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    saveJobs();
    COST_SINK = null;
  }
}

// ============================================================ PERFORM PR ENGINE
// "Perform PR" is the pre-release gate for everything that is NOT mobile
// responsiveness — that stays in the older pre-release job until the two are
// merged deliberately. Four phases: read the repo and the client's current live
// site, audit what the built site says about itself, apply only the fixes whose
// correct answer is computable, then verify the merged result on the live
// domain. Exactly one human touchpoint, by design: the pull request.
//
// Findings the job cannot fix deterministically are never guessed at. They are
// carried into the report as proposals — a wrong auto-fix on a client's phone
// number is far more expensive than a line in a report someone reads.
const PERFORM_PR_STEPS = [
  "Pull latest code",
  "Read the live site's sitemap",
  "Read the built site's own facts",
  "Audit pages, URLs, name + contact",
  "Audit favicon, images + spelling",
  "Page audit (AI)",
  "Apply automatic fixes",
  "Check the changes",
  "Push + open PR",
  "CI checks then merge",
  "Verify on the live site",
  "PageSpeed audit",
  "Publish report",
];

// ---- phase 0: the client's current live site ---------------------------------
// Their real site is the beta domain with the Growth99 staging label taken out:
// brew-aesthetics.gogroth.com -> brew-aesthetics.com. Per product decision the
// TLD is always .com. Anything we cannot derive is reported, never guessed —
// crawling a stranger's website because a hostname did not match is worse than
// running the rest of the audit without a live-site comparison.
function liveSiteCandidate(betaUrl) {
  let host = "";
  try { host = new URL(String(betaUrl || "")).hostname.toLowerCase(); } catch (_) { return ""; }
  const labels = host.split(".").filter(Boolean);
  const at = labels.findIndex((l) => /^gogro(w)?th$/.test(l));
  if (at < 1) return "";
  return "https://" + labels.slice(0, at).join(".") + ".com";
}
// Distinctive words of the business name — "the", "and", "med" match everything.
function nameTokens(businessName) {
  return String(businessName || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !["the", "and", "for", "with", "clinic", "center", "centre", "studio", "group"].includes(w));
}
async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "G99PerformPR/1.0" } });
    const type = String(r.headers.get("content-type") || "");
    // A 200 that is not HTML is not a page. TED taught us this the hard way:
    // status alone is not evidence that the thing you asked for came back.
    if (!r.ok || !/text\/html/i.test(type)) return { ok: false, status: r.status, html: "", type };
    return { ok: true, status: r.status, html: (await r.text()).slice(0, 600000), type };
  } catch (e) { return { ok: false, status: 0, html: "", error: String(e && e.message || e).slice(0, 140) }; }
  finally { clearTimeout(timer); }
}
// The live site has exactly one job here: hand over its sitemap, so we can tell
// which of the pages the client publishes today are missing from the new site.
// Nothing else is read from it. The built site is the authority on the
// business's own name, phone, email and address — an old site is frequently out
// of date, and letting it argue with the new one produces noise, not findings.
//
// The name check is a safety gate, not a comparison: without it, a parked domain
// or a squatter on the .com would hand us a sitemap and we would report dozens
// of "missing" pages that were never the client's.
// The Live Site column in NocoDB is the answer whenever it is filled in. Deriving
// it from the beta domain only ever worked by luck: Brew Aesthetics builds on
// prodteam.gogroth.com but its real site is nuvoaestheticsclinic.com, which no
// amount of string-stripping will produce. Derivation stays as a fallback for
// rows where the column is still empty.
async function resolveLiveSite(betaUrl, businessName, existingSiteUrl) {
  const declared = String(existingSiteUrl || "").trim();
  const candidate = declared ? (/^https?:\/\//i.test(declared) ? declared : "https://" + declared.replace(/^\/+/, ""))
    : liveSiteCandidate(betaUrl);
  const source = declared ? "NocoDB Live Site" : "derived from the beta domain";
  if (!candidate) return { ok: false, url: "", source, reason: "no Live Site set in NocoDB, and none could be derived from the beta domain" };
  const r = await fetchText(candidate);
  if (!r.ok) return { ok: false, url: candidate, source, reason: r.error ? `unreachable (${r.error})` : `unreachable (HTTP ${r.status})` };
  // The name gate protects against a parked domain or a squatter handing us a
  // sitemap — but only when we guessed. A URL a human typed into NocoDB is
  // trusted: plenty of real clinics trade under a name that never appears
  // verbatim in their homepage copy.
  if (!declared) {
    const tokens = nameTokens(businessName);
    const text = pageText(r.html).toLowerCase();
    if (tokens.length && !tokens.some((t) => text.includes(t))) {
      return { ok: false, url: candidate, source, reason: `resolved but does not mention "${businessName}" — not treated as the client's site. Set the Live Site column in NocoDB to fix this.` };
    }
  }
  return { ok: true, url: candidate, source };
}

// ---- the client's existing page list, from their sitemap ---------------------
const SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml", "/page-sitemap.xml"];
async function fetchXml(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "G99PerformPR/1.0" } });
    if (!r.ok) return "";
    const body = (await r.text()).slice(0, 2000000);
    return /<(urlset|sitemapindex)\b/i.test(body) ? body : "";
  } catch (_) { return ""; }
  finally { clearTimeout(timer); }
}
const sitemapLocs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
// A sitemap index points at more sitemaps; WordPress and Yoast both ship one.
// Following it is the difference between finding 5 pages and finding all 60.
// robots.txt is checked as well as the usual paths, not instead of them: plenty
// of clinic sites put their sitemap somewhere non-standard and only declare it
// there. Growth99's own site is an example — nothing at /sitemap.xml, and the
// real location is a Sitemap: line in robots.txt.
async function sitemapFromRobots(root) {
  try {
    const r = await fetch(root + "/robots.txt", { redirect: "follow", headers: { "User-Agent": "G99PerformPR/1.0" } });
    if (!r.ok) return [];
    return [...(await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 5);
  } catch (_) { return []; }
}
async function fetchLiveSitemap(origin, maxUrls = 500) {
  const root = String(origin).replace(/\/+$/, "");
  const candidates = [...SITEMAP_PATHS.map((p) => root + p), ...(await sitemapFromRobots(root))];
  for (const candidate of [...new Set(candidates)]) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;
    let urls = sitemapLocs(xml);
    if (/<sitemapindex\b/i.test(xml)) {
      const children = urls.slice(0, 25);
      urls = [];
      for (const child of children) {
        if (urls.length >= maxUrls) break;
        const sub = await fetchXml(child);
        if (sub) urls.push(...sitemapLocs(sub));
      }
    }
    urls = urls.filter((u) => !/\.(xml|jpe?g|png|webp|gif|svg|pdf)$/i.test(u));
    if (urls.length) return { ok: true, url: candidate, urls: [...new Set(urls)].slice(0, maxUrls) };
  }
  return { ok: false, url: "", urls: [], reason: "no readable sitemap found on the live site (checked the usual paths and robots.txt)" };
}
function urlSlug(u) {
  let pathname = "";
  try { pathname = new URL(u).pathname; } catch (_) { pathname = String(u); }
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  return (parts[parts.length - 1] || "home").toLowerCase();
}
// Matching on the last path segment, not the full path, because the new site
// deliberately restructures URLs (/service/botox-in-evans-ga vs /botox). A page
// that moved is not a page that is missing.
function findingsMissingPages(pages, liveUrls) {
  const built = new Set(pages.map((p) => String(p.slug || "").toLowerCase()));
  built.add("home");
  const out = [];
  for (const u of liveUrls) {
    const slug = urlSlug(u);
    if (built.has(slug)) continue;
    // A restructured slug still counts as present when the built site has a page
    // whose slug contains it (botox -> botox-in-evans-ga) or vice versa.
    if ([...built].some((b) => b.includes(slug) || slug.includes(b))) continue;
    out.push(prFinding("missing-pages", "high", "(live site)", `"${slug}" exists on the live site but not on the new site`, { found: u.slice(0, 120), expected: "a matching page on the beta site", fix: "proposed" }));
    if (out.length >= 60) break;
  }
  return out;
}
async function crawlLiveSite(origin, max = 12) {
  const root = String(origin).replace(/\/+$/, "");
  let host = "";
  try { host = new URL(root).hostname; } catch (_) { return []; }
  const seen = new Set([root + "/"]);
  const out = [];
  const queue = [root + "/"];
  while (queue.length && out.length < max) {
    const url = queue.shift();
    const r = await fetchText(url, 15000);
    if (!r.ok) continue;
    out.push({ url, html: r.html, text: pageText(r.html) });
    for (const m of r.html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      let abs;
      try { abs = new URL(m[1], url); } catch (_) { continue; }
      if (abs.hostname !== host || !/^https?:$/.test(abs.protocol)) continue;
      if (/\.(pdf|jpe?g|png|webp|gif|svg|zip|mp4|css|js)$/i.test(abs.pathname)) continue;
      const key = abs.origin + abs.pathname.replace(/\/+$/, "") + "/";
      if (seen.has(key) || seen.size > max * 4) continue;
      seen.add(key); queue.push(key);
    }
  }
  return out;
}

// ---- phase 0: what the built site says about itself --------------------------
// Per product decision only the business name comes from NocoDB. Everything else
// is read back out of the site we already built, so the audit compares the site
// against itself and against the client's live site — not against a record that
// may never have been filled in.
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "youtube.com", "linkedin.com", "yelp.com", "pinterest.com"];
function extractSocials(pages) {
  const found = new Map();
  for (const pg of pages) {
    for (const m of String(pg.php || "").matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const url = m[1];
      const host = SOCIAL_HOSTS.find((h) => url.toLowerCase().includes(h));
      if (host && !found.has(host)) found.set(host, url);
    }
  }
  return [...found.entries()].map(([host, url]) => ({ host, url }));
}
// The brand colour drives the Call Now bar and blog links. Themes state it as a
// CSS variable when they have one; otherwise the most-used non-neutral hex is a
// better guess than a hardcoded default that would look wrong on every site.
function themeBrandColor(themeAbs) {
  let src = "";
  for (const f of ["style.css", "header.php", "front-page.php", "functions.php"]) {
    const abs = path.join(themeAbs, f);
    if (fs.existsSync(abs)) src += fs.readFileSync(abs, "utf8");
  }
  const varHit = src.match(/--(?:brand|primary|accent)[a-z-]*\s*:\s*(#[0-9a-f]{3,8})/i);
  if (varHit) return varHit[1];
  const counts = new Map();
  for (const m of src.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const hex = "#" + m[1].toLowerCase();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 24 || max > 240 || max < 24) continue;   // neutral / near-white / near-black
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex)[0] || "";
}
// Only an image this site is entitled to use. A generated theme can carry an
// absolute URL to another client's asset (the sample theme in this repo points at
// elanaesthetics.com), and pinning that as the favicon or the sharing card would
// publish one client's logo on another client's site. Relative paths are always
// safe; absolute ones must match the site's own host.
function themeLogoUrl(pages, siteHost) {
  const host = String(siteHost || "").replace(/^www\./, "").toLowerCase();
  const usable = (src) => {
    if (!src) return false;
    if (!/^https?:\/\//i.test(src)) return true;                       // relative / theme-local
    try { return new URL(src).hostname.replace(/^www\./, "").toLowerCase() === host && !!host; }
    catch (_) { return false; }
  };
  for (const pg of pages) {
    for (const m of String(pg.php || "").matchAll(/<img[^>]*>/gi)) {
      if (!/logo/i.test(m[0])) continue;
      const src = (m[0].match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (usable(src)) return src;
    }
  }
  for (const pg of pages) {
    for (const m of String(pg.php || "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
      if (usable(m[1])) return m[1];
    }
  }
  return "";
}
function siteHostOf(liveUrl) {
  try { return new URL(String(liveUrl)).hostname; } catch (_) { return ""; }
}

// ---- location + URL structure (pre-release doc, tab 17) ----------------------
// Single location: every service URL carries the location — /botox-cosmetic-in-evans-ga.
// Multiple locations: one location-free page for the menu (/botox) plus a
// location page per city for SEO (/botox-in-slc), which stay out of the menu.
//
// Which rule applies is not a setting anywhere, so it is inferred: more than one
// distinct location across the service URLs means multi-location.
const prSlugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const NON_SERVICE_SLUGS = new Set(["home", "about", "about-us", "contact", "contact-us", "team", "our-team", "blog",
  "privacy-policy", "privacy", "terms", "gallery", "testimonials", "reviews", "financing", "specials", "offers",
  "careers", "faq", "faqs", "locations", "shop", "cart", "checkout", "my-account", "branding", "brand-guide",
  "seo", "seo-report", "sitemap", "search", "thank-you", "book", "booking", "appointment"]);
function splitLocationSlug(slug) {
  const m = String(slug || "").match(/^(.+?)-in-(.+)$/);
  return m ? { base: m[1], location: m[2] } : { base: String(slug || ""), location: "" };
}
function findingsUrlStructure(pages, facts) {
  const out = [];
  const services = pages.filter((p) => {
    const slug = String(p.slug || "").toLowerCase();
    return slug !== "home" && !NON_SERVICE_SLUGS.has(slug) && !/^(blog|post|category|tag)-/.test(slug);
  });
  if (!services.length) return { findings: out, renames: [], mode: "none", detail: "no service pages to check" };

  const parsed = services.map((p) => ({ ...splitLocationSlug(p.slug), slug: p.slug, title: p.title }));
  const locations = [...new Set(parsed.map((p) => p.location).filter(Boolean))];
  const city = prSlugify(facts.city);
  const multi = locations.length > 1;

  // Slug changes the fixer can apply. Only ever produced for the single-location
  // rule: a multi-location site needs pages created, not renamed, and creating
  // pages is a content decision.
  const renames = [];
  if (!multi) {
    // Single location: the location belongs in every service URL.
    const expected = city ? `in-${city}${facts.region ? "-" + prSlugify(facts.region) : ""}` : (locations[0] ? "in-" + locations[0] : "");
    for (const p of parsed) {
      if (!p.location) {
        if (expected) renames.push({ from: p.slug, to: `${p.base}-${expected}` });
        out.push(prFinding("url-structure", "medium", p.slug,
          `Service URL has no location — single-location sites should read /${p.base}-${expected || "in-<city>-<state>"}`,
          { found: "/" + p.slug, expected: expected ? `/${p.base}-${expected}` : "/<service>-in-<city>-<state>", fix: expected ? "auto" : "proposed" }));
      } else if (city && !p.location.includes(city)) {
        if (expected) renames.push({ from: p.slug, to: `${p.base}-${expected}` });
        out.push(prFinding("url-structure", "high", p.slug,
          `URL says "${p.location}" but the business is in ${facts.city}${facts.region ? ", " + facts.region : ""}`,
          { found: "/" + p.slug, expected: `/${p.base}-${expected}`, fix: expected ? "auto" : "proposed" }));
      }
    }
    return { findings: out, renames, mode: "single", detail: `single location${city ? " (" + facts.city + ")" : ""} · ${services.length} service page(s)` };
  }

  // Multi-location: every service with location pages also needs one clean page
  // for the menu, or the nav has nowhere to point.
  const byBase = new Map();
  for (const p of parsed) {
    if (!byBase.has(p.base)) byBase.set(p.base, []);
    byBase.get(p.base).push(p);
  }
  const bare = new Set(parsed.filter((p) => !p.location).map((p) => p.base));
  for (const [base, group] of byBase) {
    const withLoc = group.filter((p) => p.location);
    if (withLoc.length && !bare.has(base)) {
      out.push(prFinding("url-structure", "medium", withLoc[0].slug,
        `"${base}" has ${withLoc.length} location page(s) but no location-free page for the menu`,
        { found: withLoc.map((p) => "/" + p.slug).join(", ").slice(0, 120), expected: `/${base}`, fix: "proposed" }));
    }
  }
  return { findings: out, renames: [], mode: "multi", detail: `${locations.length} locations (${locations.slice(0, 4).join(", ")}) · ${services.length} service page(s)` };
}

// ---- PageSpeed (pre-release doc, tab 5) --------------------------------------
// The doc's manual steps — open pagespeed.web.dev, run mobile then desktop, note
// the four scores, list what the developer can fix — done through the API that
// page is a front end for. The human-readable report URL is kept so the task
// comment can link to exactly what a person would have screenshotted.
const PSI_CATEGORIES = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"];
const PSI_DEV_FIXABLE = new Set(["uses-optimized-images", "uses-webp-images", "modern-image-formats", "uses-responsive-images",
  "offscreen-images", "render-blocking-resources", "unused-css-rules", "unused-javascript", "unminified-css",
  "unminified-javascript", "efficient-animated-content", "third-party-summary", "server-response-time", "uses-text-compression"]);
function psiReportUrl(url, strategy) {
  return `https://pagespeed.web.dev/report?url=${encodeURIComponent(url)}&form_factor=${strategy === "desktop" ? "desktop" : "mobile"}`;
}
async function pageSpeedRun(url, strategy) {
  // Same PSI_API_KEY the screenshot flow already uses. The API also answers
  // without a key, just harder rate-limited — worth running either way rather
  // than skipping the check because a key is missing.
  const key = PSI_API_KEY || "";
  const api = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=" + encodeURIComponent(url)
    + "&strategy=" + strategy + PSI_CATEGORIES.map((c) => "&category=" + c).join("") + (key ? "&key=" + encodeURIComponent(key) : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(api, { signal: ctrl.signal, headers: { "User-Agent": "G99PerformPR/1.0" } });
    if (!r.ok) {
      const why = r.status === 429
        ? (key ? "rate limited by Google — the PSI_API_KEY quota is spent" : "rate limited — set PSI_API_KEY in .env to raise the quota")
        : `PageSpeed API returned ${r.status}`;
      return { ok: false, strategy, reason: why, reportUrl: psiReportUrl(url, strategy) };
    }
    const d = await r.json();
    const cats = (d.lighthouseResult || {}).categories || {};
    const pct = (c) => (cats[c] && typeof cats[c].score === "number") ? Math.round(cats[c].score * 100) : null;
    const audits = (d.lighthouseResult || {}).audits || {};
    const opportunities = Object.entries(audits)
      .filter(([id, a]) => PSI_DEV_FIXABLE.has(id) && a && typeof a.score === "number" && a.score < 0.9 && a.title)
      .map(([id, a]) => ({ id, title: a.title, saving: Math.round(((a.details || {}).overallSavingsMs || 0)) }))
      .sort((a, b) => b.saving - a.saving).slice(0, 6);
    return {
      ok: true, strategy, reportUrl: psiReportUrl(url, strategy),
      scores: { performance: pct("performance"), accessibility: pct("accessibility"), bestPractices: pct("best-practices"), seo: pct("seo") },
      opportunities,
    };
  } catch (e) { return { ok: false, strategy, reason: String(e && e.message || e).slice(0, 120), reportUrl: psiReportUrl(url, strategy) }; }
  finally { clearTimeout(timer); }
}
function findingsPageSpeed(runs) {
  const out = [];
  for (const run of runs) {
    if (!run.ok) { out.push(prFinding("pagespeed", "low", `(${run.strategy})`, `PageSpeed did not complete: ${run.reason}`, { fix: "none" })); continue; }
    for (const [label, value] of Object.entries(run.scores)) {
      if (value == null) continue;
      // Mobile is the one Google ranks on, so a weak mobile score matters more.
      const weight = run.strategy === "mobile" ? 0 : 10;
      if (value < 50 - weight) out.push(prFinding("pagespeed", "high", `(${run.strategy})`, `${label} score is ${value}`, { found: String(value), expected: "90+", fix: "proposed" }));
      else if (value < 90 - weight) out.push(prFinding("pagespeed", "medium", `(${run.strategy})`, `${label} score is ${value}`, { found: String(value), expected: "90+", fix: "proposed" }));
    }
    for (const op of run.opportunities) {
      out.push(prFinding("pagespeed", "medium", `(${run.strategy})`, `${op.title}${op.saving ? ` — about ${op.saving} ms` : ""}`, { expected: "developer-fixable", fix: "proposed" }));
    }
  }
  return out;
}

// ---- findings ----------------------------------------------------------------
// One shape for every check so the report, the PR body and the job card can all
// render findings without knowing which audit produced them.
function prFinding(task, severity, page, message, extra) {
  return { task, severity, page: page || "", message: String(message).slice(0, 300), ...(extra || {}) };
}

// What actually happened to a finding, decided AFTER the fixes run rather than
// guessed at detection time. The old `fix` flag was a prediction — "this is the
// kind of thing we can fix" — and it never updated when a fix declined, so the
// report claimed credit for work it had not done.
//
//   done     — fixed in this run, or already correct
//   pending  — we can fix this, but could not here (a needed input was missing)
//   decision — only a human can say what the right answer is
//   not-here — a real problem this repo cannot reach (remote images)
const OUTCOME = { DONE: "done", PENDING: "pending", DECISION: "decision", NOT_HERE: "not-here" };
const OUTCOME_LABEL = { done: "Done", pending: "Pending", decision: "Decision", "not-here": "Not here" };
// Findings whose subject lives outside the repository. Renaming or recompressing
// these means touching the media library, which no pull request can do.
// Findings whose subject genuinely cannot be reached from a pull request. The
// image tasks used to live here — until it turned out both CDNs will serve WebP
// at a chosen width, so the photos can be pulled into the theme and fixed after all.
const NOT_HERE_TASKS = new Set([]);
// Tasks phase 2 owns. Anything here starts as pending and is upgraded to done
// only when the corresponding fix reports that it changed a file.
const FIXABLE_TASKS = new Set(["favicon", "clickable-contact", "business-name", "internal-links",
  "spelling", "cta", "image-naming", "image-format", "image-weight"]);
function resolveFindingOutcomes(findings, fixedTasks) {
  for (const f of findings) {
    if (NOT_HERE_TASKS.has(f.task)) { f.outcome = OUTCOME.NOT_HERE; continue; }
    if (FIXABLE_TASKS.has(f.task)) { f.outcome = fixedTasks.has(f.task) ? OUTCOME.DONE : OUTCOME.PENDING; continue; }
    f.outcome = OUTCOME.DECISION;
  }
  return findings;
}
const PHONE_RE = /(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const digits = (s) => String(s || "").replace(/\D/g, "");

// Walk HTML/PHP as tokens so "is this inside a link already" is answered by the
// markup rather than by a regex lookbehind that breaks on the first nested tag.
function textNodesOutsideAnchors(src) {
  const parts = String(src || "").split(/(<[^>]+>)/);
  const out = [];
  let depth = 0, offset = 0;
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (/^<a\b/i.test(part)) depth++;
      else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
    } else if (depth === 0 && part.trim()) {
      out.push({ text: part, offset });
    }
    offset += part.length;
  }
  return out;
}
function findingsBusinessName(pages, businessName) {
  const out = [];
  const name = String(businessName || "").trim();
  const lower = name.toLowerCase();
  for (const pg of pages) {
    const text = pg.text || "";
    const stale = text.match(/[a-z0-9-]+\.gogro(w)?th\.com/i);
    if (stale) out.push(prFinding("business-name", "high", pg.slug, `Staging domain "${stale[0]}" is still printed on the page`, { found: stale[0], expected: name, fix: "proposed" }));
    // A page that talks about the brand but never spells it the agreed way.
    const first = (nameTokens(name)[0] || lower.split(/\s+/)[0] || "");
    if (first && text.toLowerCase().includes(first) && !text.toLowerCase().includes(lower)) {
      const near = (text.match(new RegExp(`\\b${first}[\\w'’-]*(?:\\s+[A-Z][\\w'’-]+){0,2}`, "i")) || [])[0] || "";
      out.push(prFinding("business-name", "medium", pg.slug, `Page names the brand as "${near.trim()}" but never as "${name}"`, { found: near.trim(), expected: name, fix: "proposed" }));
    }
  }
  return out;
}
function findingsContact(pages, facts) {
  const out = [];
  const collect = (re, norm) => {
    const seen = new Map();
    for (const pg of pages) {
      for (const m of (pg.text || "").match(re) || []) {
        const key = norm(m);
        if (!key) continue;
        if (!seen.has(key)) seen.set(key, { value: m.trim(), pages: [] });
        if (!seen.get(key).pages.includes(pg.slug)) seen.get(key).pages.push(pg.slug);
      }
    }
    return [...seen.values()];
  };
  const phones = collect(PHONE_RE, digits);
  const emails = collect(EMAIL_RE, (s) => s.toLowerCase());
  if (phones.length > 1) {
    out.push(prFinding("contact-details", "high", "(site-wide)",
      `${phones.length} different phone numbers appear across the site`,
      { found: phones.map((p) => `${p.value} (${p.pages.join(", ")})`).join(" · "), expected: facts.phone || "one number", fix: "proposed" }));
  }
  if (!phones.length) out.push(prFinding("contact-details", "high", "(site-wide)", "No phone number found anywhere on the site", { fix: "proposed" }));
  if (emails.length > 1) {
    out.push(prFinding("contact-details", "medium", "(site-wide)",
      `${emails.length} different email addresses appear across the site`,
      { found: emails.map((e) => `${e.value} (${e.pages.join(", ")})`).join(" · "), expected: facts.email || "one address", fix: "proposed" }));
  }
  // No email at all is a deliberate choice on plenty of clinic sites — they want
  // the phone to ring. Only an email that disagrees with itself is a problem.
  return out;
}
function findingsClickable(pages, facts) {
  const out = [];
  for (const pg of pages) {
    for (const node of textNodesOutsideAnchors(pg.php)) {
      for (const m of node.text.match(PHONE_RE) || []) {
        out.push(prFinding("clickable-contact", "medium", pg.slug, `Phone "${m.trim()}" is plain text — not a tel: link`, { found: m.trim(), fix: "auto" }));
      }
      for (const m of node.text.match(EMAIL_RE) || []) {
        out.push(prFinding("clickable-contact", "medium", pg.slug, `Email "${m.trim()}" is plain text — not a mailto: link`, { found: m.trim(), fix: "auto" }));
      }
    }
  }
  return out;
}
const CTA_WORDS = /(book\s+(now|online|an?\s|your)|schedule\s+(a|your|an)|request\s+(a|an|your)|make\s+an?\s+appointment|get\s+started|contact\s+us|call\s+(us|now|today)|free\s+consult)/i;
function findingsCta(pages) {
  const out = [];
  for (const pg of pages) {
    const php = String(pg.php || "");
    const hasTel = /href\s*=\s*["']tel:/i.test(php);
    const hasBooking = /href\s*=\s*["'][^"']*(book|appointment|schedule|consult|contact)/i.test(php);
    if (!hasTel && !hasBooking && !CTA_WORDS.test(pg.text || "")) {
      out.push(prFinding("cta", "high", pg.slug, "No call-to-action found — page has no booking link, tel: link or CTA copy", { fix: "proposed" }));
    }
  }
  return out;
}
function findingsFavicon(themeAbs, pages, siteHost) {
  const src = ["header.php", "functions.php"].map((f) => {
    const abs = path.join(themeAbs, f);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  }).join("\n");
  if (/rel\s*=\s*["'](shortcut\s+)?icon["']/i.test(src) || /add_theme_support\(\s*['"]custom-logo/.test(src) || /site_icon/.test(src)) return [];
  const logo = themeLogoUrl(pages, siteHost);
  return [prFinding("favicon", "high", "(site-wide)",
    logo ? "No favicon link is emitted by the theme" : "No favicon link is emitted by the theme, and no usable site-owned image was found to derive one from",
    { expected: logo || "a 48×48 icon on the site's own domain", fix: logo ? "auto" : "proposed" })];
}
// Images on these builds are remote URLs (Stitch/Unsplash/WP uploads), not files
// in the repo — a pull request cannot rename or recompress them. Detection is
// still worth running; the fix is a proposal for whoever owns the media library.
function imageSources(pages) {
  const out = [];
  for (const pg of pages) {
    for (const m of String(pg.php || "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) out.push({ page: pg.slug, src: m[1] });
    for (const m of String(pg.php || "").matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.push({ page: pg.slug, src: m[1] });
  }
  return out;
}
function findingsImages(images, businessName) {
  const out = [];
  const slug = String(businessName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const seenBad = new Set();
  for (const img of images) {
    let file = "";
    try { file = decodeURIComponent(new URL(img.src, "https://x.invalid").pathname.split("/").pop() || ""); }
    catch (_) { file = img.src.split("/").pop() || ""; }
    const bare = file.replace(/\.[a-z0-9]+$/i, "");
    const ext = (file.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    // CDN tokens run to hundreds of characters; the report needs the name, not the blob.
    const shown = file.length > 48 ? file.slice(0, 45) + "…" : file;
    const key = img.page + "|" + file;
    if (seenBad.has(key)) continue;
    if (/^(photo-)?\d+$/i.test(bare) || /[-_](\d{1,2}|[a-d])$/i.test(bare)) {
      out.push(prFinding("image-naming", "medium", img.page, `"${shown}" uses a positional or numeric name`, { found: shown, expected: `service-${slug}-in-location.webp`, fix: "proposed" }));
      seenBad.add(key);
    } else if (slug && !bare.toLowerCase().includes(slug.split("-")[0])) {
      out.push(prFinding("image-naming", "low", img.page, `"${shown}" does not carry the business name`, { found: shown, expected: `<subject>-${slug}.webp`, fix: "proposed" }));
      seenBad.add(key);
    }
    if (ext && !/^(webp|svg)$/i.test(ext)) {
      out.push(prFinding("image-format", "medium", img.page, `"${shown}" is .${ext} — should be .webp`, { found: "." + ext, expected: ".webp", fix: "proposed" }));
    }
  }
  return out;
}
// Weight and dimensions need the bytes, so this asks the CDN rather than guessing.
async function findingsImageWeight(images, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const img of images) {
    if (out.length >= limit || seen.has(img.src)) continue;
    seen.add(img.src);
    if (!/^https?:/i.test(img.src)) continue;
    try {
      const r = await fetch(img.src, { method: "HEAD", headers: { "User-Agent": "G99PerformPR/1.0" } });
      const bytes = Number(r.headers.get("content-length") || 0);
      if (bytes > 100 * 1024) {
        out.push(prFinding("image-weight", "medium", img.page, `${img.src.split("/").pop().slice(0, 60)} is ${Math.round(bytes / 1024)} KB — over the 100 KB budget`, { found: Math.round(bytes / 1024) + " KB", expected: "< 100 KB", fix: "proposed" }));
      }
    } catch (_) { /* an unreachable asset is the link check's finding, not this one */ }
  }
  return out;
}
async function findingsSpelling(pages, ai) {
  const out = [];
  const batch = pages.slice(0, 14).map((p) => `### ${p.slug}\n${(p.text || "").slice(0, 2200)}`).join("\n\n");
  if (!batch.trim()) return out;
  try {
    const raw = await aiCall([{ text: [
      "Proofread this medical-spa website copy for genuine spelling mistakes only.",
      "IGNORE: brand names, people's names, place names, clinical and product terms (Botox, Dysport, Kybella, Sculptra, microneedling, hyaluronic, PRP...), American vs British spelling, and anything that is merely unusual.",
      "Report a word ONLY if it is unambiguously misspelt. Return an empty array rather than reaching for borderline cases.",
      "", batch, "",
      'Return ONLY minified JSON: {"items":[{"page":"slug","word":"","suggestion":"","context":"a few surrounding words"}]}',
    ].join("\n") }], { ...(ai || {}), temperature: 0, maxOutputTokens: 1200, timeoutMs: 60000, json: true });
    const parsed = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
    for (const it of (parsed.items || []).slice(0, 40)) {
      if (!it || !it.word) continue;
      out.push(prFinding("spelling", "low", String(it.page || ""), `"${it.word}" → "${it.suggestion || "?"}"${it.context ? ` (…${String(it.context).slice(0, 80)}…)` : ""}`, { found: it.word, expected: it.suggestion || "", fix: "proposed" }));
    }
  } catch (e) { out.push(prFinding("spelling", "low", "", "Spell check did not complete: " + String(e.message).slice(0, 120), { fix: "none" })); }
  return out;
}
async function findingsPageAudit(pages, businessName, ai) {
  const out = [];
  const batch = pages.slice(0, 12).map((p) => `### ${p.slug} — ${p.title}\n${(p.text || "").slice(0, 1800)}`).join("\n\n");
  if (!batch.trim()) return out;
  try {
    const raw = await aiCall([{ text: [
      `Review the copy of this ${businessName} website page by page as a conversion-focused editor.`,
      "Report only concrete, actionable problems: missing or vague headlines, pages that never say what the service is or who it is for, absent trust signals, thin content, or a page whose purpose is unclear.",
      "Do not comment on design, colour, layout or images — you cannot see them. Maximum 2 items per page.",
      "", batch, "",
      'Return ONLY minified JSON: {"items":[{"page":"slug","severity":"high|medium|low","finding":"","suggestion":""}]}',
    ].join("\n") }], { ...(ai || {}), temperature: 0.2, maxOutputTokens: 1800, timeoutMs: 75000, json: true });
    const parsed = JSON.parse((stripFence(raw).match(/\{[\s\S]*\}/) || ["{}"])[0]);
    for (const it of (parsed.items || []).slice(0, 30)) {
      if (!it || !it.finding) continue;
      const sev = ["high", "medium", "low"].includes(String(it.severity)) ? String(it.severity) : "low";
      out.push(prFinding("page-audit", sev, String(it.page || ""), it.finding, { expected: it.suggestion || "", fix: "proposed" }));
    }
  } catch (e) { out.push(prFinding("page-audit", "low", "", "Page audit did not complete: " + String(e.message).slice(0, 120), { fix: "none" })); }
  return out;
}

// ---- phase 2: the deterministic fixes ----------------------------------------
// Every fix is idempotent through a marker string. Perform PR is expected to run
// more than once on the same site, and a second run must not append a second
// Call Now bar or a second favicon link.
const PR_MARK = "g99-perform-pr";
function readIf(abs) { return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : ""; }
function appendToFunctions(themeAbs, marker, php) {
  const abs = path.join(themeAbs, "functions.php");
  const cur = readIf(abs);
  if (!cur || cur.includes(marker)) return false;
  fs.writeFileSync(abs, cur.replace(/\s*$/, "\n") + "\n" + php.trim() + "\n");
  return true;
}
// Replace text inside the rendered content only — never inside a tag, an
// attribute, a URL or a PHP block. A blind string replace would rewrite class
// names, image filenames and canonical URLs along with the visible copy.
function replaceInTextNodes(src, from, to) {
  const parts = String(src || "").split(/(<[^>]+>)/);
  let hits = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("<") || part.includes("<?") || !part.trim()) continue;
    if (!part.includes(from)) continue;
    hits += part.split(from).length - 1;
    parts[i] = part.split(from).join(to);
  }
  return { out: parts.join(""), hits };
}
// The one name finding that is not a judgement call. NocoDB is the agreed
// trading name; when the theme still carries the name it was built under, the
// correct value is known and swapping it is mechanical. Name *variants* — a page
// saying "Brew" where the record says "Brew Aesthetics" — stay a decision,
// because shortening a name on purpose is a normal thing for copy to do.
function fixBusinessName(themeAbs, pages, businessName, siteName, themePath) {
  const correct = String(businessName || "").trim();
  const wrong = String(siteName || "").trim();
  if (!correct || !wrong) return { changed: [], note: "no name to compare against", skipped: true };
  if (wrong.toLowerCase() === correct.toLowerCase()) return { changed: [], note: `"${correct}" already used throughout` };
  // Guard against a garbage read: only swap a name that actually looks like one
  // and is not merely a substring difference in casing or spacing.
  if (wrong.length < 3 || wrong.length > 80) return { changed: [], note: `"${wrong.slice(0, 40)}" does not look like a business name`, skipped: true };
  const changed = [];
  let total = 0;
  for (const pg of pages) {
    const abs = path.join(themeAbs, pg.file);
    const php = readIf(abs);
    if (!php || !php.includes(wrong)) continue;
    const { out, hits } = replaceInTextNodes(php, wrong, correct);
    if (hits) { fs.writeFileSync(abs, out); changed.push(themePath + "/" + pg.file); total += hits; }
  }
  for (const shared of ["header.php", "footer.php"]) {
    const abs = path.join(themeAbs, shared);
    const php = readIf(abs);
    if (!php || !php.includes(wrong)) continue;
    const { out, hits } = replaceInTextNodes(php, wrong, correct);
    if (hits) { fs.writeFileSync(abs, out); changed.push(themePath + "/" + shared); total += hits; }
  }
  if (!total) return { changed: [], note: `"${wrong}" appears only in code or URLs — left alone` };
  return { changed: [...new Set(changed)], note: `"${wrong}" → "${correct}" in ${total} place(s)` };
}
// ---- redirects ---------------------------------------------------------------
// Renaming a URL without a redirect throws away every inbound link and every
// ranking that page had — which is the whole reason the location rule exists.
// So the redirect map is written first and the slug is changed second; if the
// map cannot be written, the rename does not happen.
//
// The map is cumulative. A page renamed twice over two runs must still be
// reachable from its original URL, so existing entries are re-pointed at the
// newest destination rather than replaced.
const REDIRECT_FILE = "inc/g99-redirects.php";
function readRedirectMap(themeAbs) {
  const src = readIf(path.join(themeAbs, REDIRECT_FILE));
  const map = new Map();
  for (const m of src.matchAll(/'([^']+)'\s*=>\s*'([^']+)'/g)) map.set(m[1], m[2]);
  return map;
}
function writeRedirectMap(themeAbs, themePath, pairs) {
  const map = readRedirectMap(themeAbs);
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) continue;
    // Anything already pointing at the old URL must follow it to the new one,
    // or a two-hop rename leaves the first URL stranded on a 404.
    for (const [k, v] of map) if (v === from) map.set(k, to);
    map.set(from, to);
  }
  if (!map.size) return { changed: [], entries: 0 };
  // Eight spaces, not four: the array opens inside a closure that is already
  // indented, and Pint fails the build on array_indentation.
  const rows = [...map.entries()].filter(([f, t]) => f !== t)
    .map(([f, t]) => `        '${f.replace(/'/g, "\\'")}' => '${t.replace(/'/g, "\\'")}',`).join("\n");
  const php = [
    "<?php",
    "",
    "/**",
    ` * ${PR_MARK}:redirects — 301s for URLs this site used to serve.`,
    " *",
    " * Written by the pre-release run whenever it changes a slug. Runs early on",
    " * template_redirect so it answers before WordPress decides the request is a 404.",
    " * Safe to edit by hand; the pre-release run merges into this map rather than",
    " * overwriting it.",
    " */",
    "",
    "add_action('template_redirect', function () {",
    "    $map = [",
    rows,
    "    ];",
    "",
    "    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);",
    "    $path = '/' . trim((string) $path, '/');",
    "",
    "    if ($path !== '/' ) {",
    "        $path .= '/';",
    "    }",
    "",
    "    if (isset($map[$path])) {",
    "        wp_safe_redirect(home_url($map[$path]), 301);",
    "        exit;",
    "    }",
    "}, 1);",
    "",
  ].join("\n");
  fs.mkdirSync(path.join(themeAbs, "inc"), { recursive: true });
  // The repo's .editorconfig sets insert_final_newline, and Pint fails the build
  // on single_blank_line_at_eof. Normalising here rather than trusting the join
  // means a later edit to the template above cannot quietly break CI.
  fs.writeFileSync(path.join(themeAbs, REDIRECT_FILE), php.replace(/\s*$/, "") + "\n");
  const changed = [`${themePath}/${REDIRECT_FILE}`];
  // functions.php must actually load it, or the file is decoration.
  const fnAbs = path.join(themeAbs, "functions.php");
  const fn = readIf(fnAbs);
  if (fn && !fn.includes(REDIRECT_FILE)) {
    fs.writeFileSync(fnAbs, fn.replace(/^<\?php\s*/, (m) => `${m}\nrequire_once get_template_directory() . '/${REDIRECT_FILE}';\n`));
    changed.push(themePath + "/functions.php");
  }
  return { changed, entries: map.size };
}

// Renaming a slug here does NOT rename the page. The mu-plugin seeds pages into
// the WordPress database once and guards it with a per-build option flag, so a
// changed slug creates nothing — the old page keeps serving the old URL and the
// new URL has no page behind it. Shipping that produced 301s into 404s on a live
// site: /medical-spa-services/ redirected to a location URL that did not exist.
//
// The slug lives in the database, and a pull request cannot reach it. So this is
// a decision for a human with wp-admin, not an automatic fix. Left here, and
// deliberately inert, because the audit that finds these URLs is still correct
// and worth reporting — it is only the applying that was wrong.
const URL_RENAME_ENABLED = process.env.PERFORM_PR_RENAME_SLUGS === "on";
function fixUrlStructure(themeAbs, muAbs, muPath, themePath, renames) {
  if (!renames.length) return { changed: [], note: "every service URL already carries the location", skipped: true, renamed: [] };
  if (!URL_RENAME_ENABLED) {
    return {
      changed: [], skipped: true, renamed: [],
      note: `${renames.length} URL(s) need the location, but the slug lives in the WordPress database — rename in wp-admin, then re-run`,
    };
  }
  if (!muAbs || !fs.existsSync(muAbs)) return { changed: [], note: "no mu-plugin found — slugs cannot be changed safely", skipped: true, renamed: [] };
  let mu = fs.readFileSync(muAbs, "utf8");
  const applied = [];
  for (const r of renames) {
    // Only inside a $pages entry, so a slug that also appears in prose or a
    // template name is left alone.
    const re = new RegExp(`(\\['title'\\s*=>\\s*'[^']*'\\s*,\\s*'slug'\\s*=>\\s*')${r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(')`, "g");
    if (!re.test(mu)) continue;
    mu = mu.replace(re, `$1${r.to}$2`);
    applied.push(r);
  }
  if (!applied.length) return { changed: [], note: "no matching slugs in the mu-plugin page list", skipped: true, renamed: [] };
  // Redirects first: if this fails, the rename is abandoned rather than shipped
  // without a way back to the old URL.
  const red = writeRedirectMap(themeAbs, themePath, applied.map((r) => [`/${r.from}/`, `/${r.to}/`]));
  if (!red.changed.length) return { changed: [], note: "could not write the redirect map — slugs left alone", skipped: true, renamed: [] };
  fs.writeFileSync(muAbs, mu);
  return {
    changed: [muPath, ...red.changed], renamed: applied,
    note: `${applied.length} URL(s) given the location, each 301'd from the old path`,
  };
}

// Internal links that point at a page this site does not have. Checked against
// the page list rather than over the network, so it runs before the PR instead
// of after the deploy — which is the only point at which it can still be fixed.
// header.php and footer.php are not page templates, so they were outside this
// check — and they are exactly where a broken link does the most damage, because
// it appears on every page. /services/ and /about/ sat 404ing in this site's nav
// and footer while the check reported "every internal link resolves".
function themeChromePages(themeAbs) {
  const out = [];
  for (const file of ["header.php", "footer.php"]) {
    const abs = path.join(themeAbs, file);
    if (fs.existsSync(abs)) out.push({ slug: `(${file.replace(".php", "")})`, file, php: fs.readFileSync(abs, "utf8") });
  }
  return out;
}
function findingsInternalLinks(pages, muPages) {
  const known = new Set(["", "home", ...muPages.map((p) => String(p.slug || "").toLowerCase())]);
  const out = [];
  const seen = new Set();
  for (const pg of pages) {
    for (const m of String(pg.php || "").matchAll(/href\s*=\s*["'](\/[^"'#?]*)["']/gi)) {
      const target = m[1].replace(/^\/+|\/+$/g, "").toLowerCase();
      if (!target || target.includes("<?") || /\.(php|css|js|xml|txt|jpe?g|png|webp|svg|pdf)$/i.test(target)) continue;
      const slug = target.split("/").pop();
      if (known.has(target) || known.has(slug)) continue;
      const key = pg.slug + "|" + target;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(prFinding("internal-links", "high", pg.slug, `Links to /${target}/, which is not a page on this site`,
        { found: "/" + target + "/", expected: "an existing page, or a redirect", fix: "auto" }));
    }
  }
  return out;
}
// A dead internal link gets a redirect to the closest page we do have. Closeness
// is measured on shared slug words, and a link with no plausible destination is
// left for a human rather than pointed somewhere arbitrary.
function bestRedirectTarget(target, muPages) {
  const words = new Set(String(target).split(/[^a-z0-9]+/i).filter((w) => w.length > 2));
  let best = null, bestScore = 0;
  for (const p of muPages) {
    const slug = String(p.slug || "").toLowerCase();
    if (!slug) continue;
    const hits = [...words].filter((w) => slug.includes(w)).length;
    if (hits > bestScore) { bestScore = hits; best = slug; }
  }
  return bestScore > 0 ? best : null;
}
function fixInternalLinks(themeAbs, themePath, findings, muPages) {
  const dead = findings.filter((f) => f.task === "internal-links" && f.found);
  if (!dead.length) return { changed: [], note: "every internal link resolves", skipped: true, redirects: [] };
  const pairs = [], redirects = [];
  for (const f of dead) {
    const target = String(f.found).replace(/^\/+|\/+$/g, "");
    const to = bestRedirectTarget(target, muPages);
    if (!to) continue;
    pairs.push([`/${target}/`, `/${to}/`]);
    redirects.push({ from: "/" + target + "/", to: "/" + to + "/", page: f.page });
  }
  if (!pairs.length) return { changed: [], note: `${dead.length} dead link(s) with no plausible destination — left for review`, skipped: true, redirects: [] };
  const red = writeRedirectMap(themeAbs, themePath, pairs);
  return { changed: red.changed, redirects, note: `${redirects.length} dead link(s) 301'd to the nearest matching page` };
}

// A misspelling has one correct answer, and the audit already worked out what it
// is. Applied to text nodes only, and only where the exact word is still present —
// so a suggestion the audit got wrong changes nothing rather than mangling copy.
function fixSpelling(themeAbs, pages, findings, themePath) {
  const wanted = findings.filter((f) => f.task === "spelling" && f.found && f.expected && f.found !== f.expected);
  if (!wanted.length) return { changed: [], note: "no misspellings to correct", skipped: true, corrections: [] };
  const changed = [];
  const corrections = [];
  for (const pg of pages) {
    const abs = path.join(themeAbs, pg.file);
    let php = readIf(abs);
    if (!php) continue;
    let touched = false;
    for (const f of wanted) {
      if (f.page && f.page !== pg.slug) continue;
      // Whole word only: "form" must not turn "performance" into "perexpectedance".
      const re = new RegExp(`\\b${f.found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      if (!re.test(php)) continue;
      const { out, hits } = replaceInTextNodes(php, f.found, f.expected);
      if (hits) { php = out; touched = true; corrections.push({ page: pg.slug, from: f.found, to: f.expected, hits }); f.corrected = true; }
    }
    if (touched) { fs.writeFileSync(abs, php); changed.push(themePath + "/" + pg.file); }
  }
  if (!corrections.length) return { changed: [], note: "the suggested words were not found in the templates", skipped: true, corrections: [] };
  return { changed: [...new Set(changed)], corrections, note: corrections.map((c) => `"${c.from}" → "${c.to}"`).join(", ").slice(0, 150) };
}

// A page with no call to action is a dead end. Rather than invent one, the block
// is lifted from a page that already has a good one, so the copy, the phone
// number and the styling all match the rest of the site.
function extractCtaBlock(php) {
  // The last section that contains a tel: link or booking wording is, on these
  // themes, the closing CTA band.
  const sections = String(php || "").match(/<section[\s\S]*?<\/section>/gi) || [];
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (/href\s*=\s*["']tel:/i.test(s) && CTA_WORDS.test(pageText(s))) return s;
  }
  return null;
}
function fixCta(themeAbs, pages, findings, themePath) {
  const missing = new Set(findings.filter((f) => f.task === "cta").map((f) => f.page));
  if (!missing.size) return { changed: [], note: "every page already has a CTA", skipped: true, added: [] };
  // Take the donor from the home page first — it is the most carefully written.
  const donorPage = pages.find((p) => p.slug === "home" && extractCtaBlock(p.php))
    || pages.find((p) => !missing.has(p.slug) && extractCtaBlock(p.php));
  if (!donorPage) return { changed: [], note: "no existing CTA section to copy from", skipped: true, added: [] };
  const block = extractCtaBlock(donorPage.php);
  const changed = [], added = [];
  for (const pg of pages) {
    if (!missing.has(pg.slug)) continue;
    const abs = path.join(themeAbs, pg.file);
    const php = readIf(abs);
    if (!php || php.includes(`${PR_MARK}:cta`)) continue;
    // Before get_footer() so it closes the page, matching where CTAs sit elsewhere.
    const marker = `\n<!-- ${PR_MARK}:cta — copied from /${donorPage.slug} -->\n${block}\n`;
    const out = /get_footer\s*\(/.test(php)
      ? php.replace(/(<\?php\s*)?\s*get_footer\s*\(\s*\)\s*;?/i, (m) => marker + m)
      : php + marker;
    fs.writeFileSync(abs, out);
    changed.push(themePath + "/" + pg.file);
    added.push(pg.slug);
  }
  if (!added.length) return { changed: [], note: "CTA already added on a previous run", skipped: true, added: [] };
  return { changed, added, note: `CTA copied from /${donorPage.slug} onto ${added.join(", ")}` };
}

// ---- images: rename, convert and shrink, by pulling them into the repo -------
// The photos live on Google's and Unsplash's CDNs, so nothing in the repo can be
// renamed or recompressed in place. Both CDNs will, however, hand back WebP at a
// chosen width from the URL alone — Google via the `-rw` suffix, Unsplash via
// `fm=webp`. So the fix is to ask for a small WebP, save it into the theme under
// a proper name, and point the template at the local copy. One pass fixes the
// name, the format and the weight, and the asset stops being someone else's.
const IMG_TARGET_WIDTH = 1200;          // under the 2000px cap, and both CDNs land under 100KB here
const IMG_MAX_BYTES = 100 * 1024;
const IMG_STOPWORDS = new Set(["a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "for", "to", "is",
  "are", "her", "his", "its", "their", "this", "that", "very", "soft", "high", "end", "premium", "luxurious",
  "luxury", "modern", "clean", "warm", "cool", "bright", "close", "up", "shot", "image", "photo", "background",
  "featuring", "showing", "while", "from", "into", "over", "under", "sense", "tones", "lighting"]);
// A name a human can read, taken from the alt text the generator already wrote.
// Falls back to the page slug, which is the service name on a service page.
function imageSubject(tag, pageSlug, businessName) {
  const alt = (tag.match(/\b(?:data-)?alt\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  // The business name is appended separately; alt text that already names the
  // clinic would otherwise produce nuvo-aesthetics-clinic-nuvo-aesthetics-clinic.
  const bizWords = new Set(prSlugify(businessName || "").split("-").filter(Boolean));
  const words = alt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !IMG_STOPWORDS.has(w) && !bizWords.has(w));
  const subject = words.slice(0, 4).join("-");
  return subject || prSlugify(pageSlug) || "image";
}
// Numbers and single letters are what the naming rules exist to forbid, so a
// collision is resolved with more of the alt text rather than a counter.
function uniqueImageName(base, taken, extraWords) {
  let name = base;
  let i = 0;
  while (taken.has(name) && i < extraWords.length) name = base + "-" + extraWords[i++];
  while (taken.has(name)) name = name + "-alt";
  taken.add(name);
  return name;
}
// Ask the CDN for WebP at our width. Anything we do not recognise is left alone —
// downloading an arbitrary host's image and re-hosting it is not our call.
function cdnWebpUrl(src, width = IMG_TARGET_WIDTH) {
  if (/lh3\.googleusercontent\.com/.test(src)) return src.replace(/=[a-z0-9-]+$/i, "") + `=w${width}-rw`;
  if (/images\.unsplash\.com/.test(src)) {
    const base = src.split("?")[0];
    return `${base}?w=${width}&fm=webp&q=72&fit=crop`;
  }
  return null;
}
// NOTE: named performPrFixImages, not fixImages — a same-file "async function
// fixImages(html)" already exists above (the image-QC helper every generate-site/
// enrich call site depends on). A same-name function declaration in JS silently
// wins over an earlier one for EVERY call site, not just this feature's own — that
// collision made /api/generate-site call this one instead, with html positionally
// bound to themeAbs and everything else undefined, throwing on facts.city.
// Confirmed live, 2026-08-06: "Cannot read properties of undefined (reading 'city')"
// at this line, reproduced by calling fixImages(html) exactly as generate-site does.
async function performPrFixImages(themeAbs, pages, businessName, facts, themePath) {
  const bizSlug = prSlugify(businessName).split("-").slice(0, 3).join("-");
  const loc = facts.city ? `in-${prSlugify(facts.city)}${facts.region ? "-" + prSlugify(facts.region) : ""}` : "";
  const dir = path.join(themeAbs, "assets", "img");
  const taken = new Set();
  const changed = [];
  const swaps = [];
  let bytesBefore = 0, bytesAfter = 0, skipped = 0;

  for (const pg of pages) {
    const abs = path.join(themeAbs, pg.file);
    let php = readIf(abs);
    if (!php) continue;
    const tags = php.match(/<img[^>]*>/gi) || [];
    let touched = false;
    for (const tag of tags) {
      const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!src || !/^https?:\/\//i.test(src)) continue;
      const webp = cdnWebpUrl(src);
      if (!webp) { skipped++; continue; }
      const alt = (tag.match(/\b(?:data-)?alt\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
      const extra = alt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !IMG_STOPWORDS.has(w)).slice(4, 9);
      const base = [imageSubject(tag, pg.slug, businessName), bizSlug, loc].filter(Boolean).join("-").slice(0, 90);
      const name = uniqueImageName(base, taken, extra);
      try {
        // Step down the width until it fits the budget. A dense photograph at
        // 1200px can still exceed 100KB, and the budget is the point of the fix.
        let buf = null;
        for (const w of [IMG_TARGET_WIDTH, 900, 700]) {
          const r = await fetch(cdnWebpUrl(src, w), { redirect: "follow", headers: { "User-Agent": "G99PerformPR/1.0" } });
          if (!r.ok) break;
          buf = Buffer.from(await r.arrayBuffer());
          if (buf.length && buf.length <= IMG_MAX_BYTES) break;
        }
        if (!buf || !buf.length) { skipped++; continue; }
        // What the page was serving before, so the report can show the saving.
        let was = 0;
        try { const h = await fetch(src, { method: "HEAD", headers: { "User-Agent": "G99PerformPR/1.0" } }); was = Number(h.headers.get("content-length") || 0); } catch (_) { /* best effort */ }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + ".webp"), buf);
        const localRef = `<?php echo esc_url(get_theme_file_uri('assets/img/${name}.webp')); ?>`;
        php = php.split(src).join(localRef);
        touched = true;
        bytesBefore += was; bytesAfter += buf.length;
        swaps.push({ page: pg.slug, from: src, to: `assets/img/${name}.webp`, wasBytes: was, nowBytes: buf.length });
        changed.push(`${themePath}/assets/img/${name}.webp`);
      } catch (e) { skipped++; }
    }
    if (touched) { fs.writeFileSync(abs, php); changed.push(themePath + "/" + pg.file); }
  }
  if (!swaps.length) return { changed: [], note: skipped ? `${skipped} image(s) are on hosts we do not rewrite` : "no remote images to localise", skipped: true, swaps: [] };
  const saved = bytesBefore && bytesAfter ? Math.round((1 - bytesAfter / bytesBefore) * 100) : 0;
  return {
    changed: [...new Set(changed)], swaps,
    note: `${swaps.length} image(s) renamed + converted to WebP · ${Math.round(bytesBefore / 1024)}KB → ${Math.round(bytesAfter / 1024)}KB${saved > 0 ? ` (−${saved}%)` : ""}`,
  };
}
function fixFavicon(themeAbs, pages, themePath, siteHost) {
  const logo = themeLogoUrl(pages, siteHost);
  if (!logo) return { changed: [], note: "no site-owned image to derive a favicon from — reported instead" };
  const marker = `${PR_MARK}:favicon`;
  const ok = appendToFunctions(themeAbs, marker, [
    `// ${marker} — the theme emitted no favicon, so search results showed the`,
    "// hosting default. Printed here rather than hardcoded into header.php so a",
    "// later Site Identity upload still wins on priority.",
    "add_action('wp_head', function () {",
    "    if (function_exists('has_site_icon') && has_site_icon()) {",
    "        return;",
    "    }",
    `    echo '<link rel="icon" href="' . esc_url('${logo.replace(/'/g, "\\'")}') . '">' . "\\n";`,
    "}, 2);",
  ].join("\n"));
  return ok ? { changed: [themePath + "/functions.php"], note: `favicon points at ${logo.slice(0, 80)}` } : { changed: [], note: "favicon link already present" };
}
function fixSocialImage(themeAbs, pages, themePath, siteHost) {
  // The SEO layer already prints og:image per page. Emitting a second one here is
  // exactly the "two sets of Open Graph tags fighting each other" that the SEO
  // engine exists to clean up, so when it is installed we leave this alone.
  if (fs.existsSync(path.join(themeAbs, "inc", "g99-seo.php"))) {
    return { changed: [], note: "Open Graph is owned by the SEO layer (inc/g99-seo.php) — not duplicated here" };
  }
  const image = themeLogoUrl(pages, siteHost);
  if (!image) return { changed: [], note: "no site-owned image available to use as the sharing card" };
  const marker = `${PR_MARK}:og-image`;
  const ok = appendToFunctions(themeAbs, marker, [
    `// ${marker} — a shared link with no image renders as a grey box. This is a`,
    "// site-wide fallback only; a per-page card belongs to the SEO layer.",
    "add_action('wp_head', function () {",
    `    $img = esc_url('${image.replace(/'/g, "\\'")}');`,
    "    echo '<meta property=\"og:image\" content=\"' . $img . '\">' . \"\\n\";",
    "    echo '<meta name=\"twitter:card\" content=\"summary_large_image\">' . \"\\n\";",
    "    echo '<meta name=\"twitter:image\" content=\"' . $img . '\">' . \"\\n\";",
    "}, 3);",
  ].join("\n"));
  return ok ? { changed: [themePath + "/functions.php"], note: "site-wide og:image fallback added" } : { changed: [], note: "og:image already emitted" };
}
function fix404(themeAbs, themePath, brand) {
  const abs = path.join(themeAbs, "404.php");
  if (fs.existsSync(abs) && readIf(abs).includes(PR_MARK)) return { changed: [], note: "404 template already in place" };
  if (fs.existsSync(abs)) return { changed: [], note: "theme already ships its own 404.php — left untouched" };
  const accent = brand || "#1c1d29";
  fs.writeFileSync(abs, [
    "<?php",
    `/** ${PR_MARK}:404 — branded 404 so a mistyped URL keeps the visitor on the site. */`,
    "get_header();",
    "?>",
    `<main style="max-width:720px;margin:0 auto;padding:96px 24px;text-align:center">`,
    `  <p style="font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:${accent};margin:0 0 12px">404</p>`,
    `  <h1 style="font-size:34px;line-height:1.2;margin:0 0 14px">We couldn't find that page</h1>`,
    `  <p style="font-size:17px;color:#555;margin:0 0 30px">The page may have moved. Let's get you back to <?php echo esc_html(get_bloginfo('name')); ?>.</p>`,
    `  <p><a href="<?php echo esc_url(home_url('/')); ?>" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:14px 30px;border-radius:8px;font-weight:600">Back to home</a></p>`,
    "</main>",
    "<?php",
    "get_footer();",
  ].join("\n") + "\n");
  return { changed: [themePath + "/404.php"], note: "branded 404.php created" };
}
function fixCallNow(themeAbs, themePath, phone, brand) {
  if (!phone) return { changed: [], note: "no phone number on the site to call" };
  const marker = `${PR_MARK}:call-now`;
  const accent = brand || "#1c1d29";
  const tel = "+1" + digits(phone).replace(/^1/, "");
  const ok = appendToFunctions(themeAbs, marker, [
    `// ${marker} — sticky call bar on phones. Replaces the Call Now Button plugin;`,
    "// mobile visitors to a clinic site are overwhelmingly trying to phone it.",
    "add_action('wp_footer', function () {",
    "    ?>",
    `    <a class="g99-call-now" href="tel:${tel}" aria-label="Call ${"<?php echo esc_attr(get_bloginfo('name')); ?>"}">`,
    "        <svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.4a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.2 1z\"/></svg>",
    "        <span>Call now</span>",
    "    </a>",
    "    <style>",
    "        .g99-call-now{display:none}",
    "        @media (max-width:767px){",
    "            .g99-call-now{display:inline-flex;align-items:center;gap:8px;position:fixed;left:16px;bottom:16px;z-index:9999;",
    `                background:${accent};color:#fff;text-decoration:none;padding:13px 20px;border-radius:999px;`,
    "                font:600 15px/1 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)}",
    "        }",
    "    </style>",
    "    <?php",
    "}, 20);",
  ].join("\n"));
  return ok ? { changed: [themePath + "/functions.php"], note: `sticky call bar → ${phone}` } : { changed: [], note: "call bar already present" };
}
// Boulevard tracking needs the id on the element that opens the booking flow.
function fixBlvd(themeAbs, pages, themePath) {
  const changed = [];
  let tagged = 0;
  for (const pg of pages) {
    const abs = path.join(themeAbs, pg.file);
    let php = readIf(abs);
    if (!php) continue;
    const before = php;
    php = php.replace(/<a\b[^>]*>/gi, (tag) => {
      if (!/blvd|boulevard/i.test(tag) || /\bid\s*=/.test(tag)) return tag;
      tagged++;
      return tag.replace(/^<a\b/i, '<a id="blvd_booking"');
    });
    if (php !== before) { fs.writeFileSync(abs, php); changed.push(themePath + "/" + pg.file); }
  }
  if (!tagged) return { changed: [], note: "no Boulevard booking links found — nothing to tag", skipped: true };
  return { changed, note: `blvd_booking added to ${tagged} button(s)` };
}
function fixBlogLinkColor(themeAbs, themePath, brand) {
  if (!brand) return { changed: [], note: "no brand colour detected", skipped: true };
  const hasBlog = ["single.php", "archive.php", "page-blog.php"].some((f) => fs.existsSync(path.join(themeAbs, f)));
  if (!hasBlog) return { changed: [], note: "theme has no blog templates", skipped: true };
  const abs = path.join(themeAbs, "style.css");
  const cur = readIf(abs);
  const marker = `${PR_MARK}:blog-links`;
  if (!cur || cur.includes(marker)) return { changed: [], note: "blog link colour already set" };
  fs.writeFileSync(abs, cur.replace(/\s*$/, "\n") + [
    "", `/* ${marker} — in-content links inherited the theme default, not the brand. */`,
    ".entry-content a:not(.button):not(.btn),", ".post-content a:not(.button):not(.btn) {",
    `    color: ${brand};`, "    text-decoration: underline;", "}", "",
  ].join("\n"));
  return { changed: [themePath + "/style.css"], note: `blog links set to ${brand}` };
}
function fixBlogSidebar(themeAbs) {
  const hasBlog = ["single.php", "archive.php"].some((f) => fs.existsSync(path.join(themeAbs, f)));
  if (!hasBlog) return { changed: [], note: "theme has no blog templates — sidebar not applicable", skipped: true };
  return { changed: [], note: "blog templates exist; sidebar widget is not yet automated", skipped: true };
}
function fixClickable(themeAbs, pages, themePath) {
  const changed = [];
  let linked = 0;
  for (const pg of pages) {
    const abs = path.join(themeAbs, pg.file);
    const php = readIf(abs);
    if (!php) continue;
    const parts = php.split(/(<[^>]+>)/);
    let depth = 0, touched = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith("<")) {
        if (/^<a\b/i.test(part)) depth++;
        else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth || !part.trim() || part.includes("<?")) continue;   // never rewrite inside PHP
      const next = part
        .replace(PHONE_RE, (m) => { linked++; touched = true; return `<a href="tel:+1${digits(m).replace(/^1/, "")}">${m}</a>`; })
        .replace(EMAIL_RE, (m) => { linked++; touched = true; return `<a href="mailto:${m.trim()}">${m}</a>`; });
      parts[i] = next;
    }
    if (touched) { fs.writeFileSync(abs, parts.join("")); changed.push(themePath + "/" + pg.file); }
  }
  if (!linked) return { changed: [], note: "every phone and email is already a link" };
  return { changed: [...new Set(changed)], note: `${linked} phone/email mention(s) linked` };
}

// ---- phase 4: verification on the merged, deployed site ----------------------
function performPrMarkerUrl(origin, themeSlug, jobId, probe = Date.now()) {
  const root = String(origin || "").replace(/\/+$/, "");
  return `${root}/app/themes/${encodeURIComponent(themeSlug)}/g99-perform-pr-marker.txt?release=${encodeURIComponent(jobId)}&probe=${encodeURIComponent(probe)}`;
}
async function waitForPerformPrDeployment(liveUrl, themeSlug, jobId) {
  const timeoutMs = Math.max(30000, Number(process.env.PR_DEPLOY_TIMEOUT_MS || 900000) || 900000);
  const pollMs = Math.max(2000, Number(process.env.PR_DEPLOY_POLL_MS || 10000) || 10000);
  const started = Date.now();
  let last = "not found";
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(performPrMarkerUrl(liveUrl, themeSlug, jobId), {
        redirect: "follow", cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, max-age=0", "User-Agent": "G99PerformPRDeployProbe/1.0" },
      });
      const value = r.ok ? (await r.text()).trim() : "";
      if (r.ok && value === jobId) return { deployedAt: new Date().toISOString() };
      last = r.ok ? `marker contained ${value.slice(0, 60) || "empty content"}` : `HTTP ${r.status}`;
    } catch (e) { last = String(e && e.message || e).slice(0, 120); }
    await sleep(pollMs);
  }
  throw new Error(`deployment did not expose release marker ${jobId} within ${Math.round(timeoutMs / 60000)} minute(s): ${last}`);
}
// Runs after merge because renaming or relinking anything above changes URLs —
// a link check against pre-merge source would be checking the wrong site.
async function verifyLinks(origin, max = 120) {
  const pages = await crawlLiveSite(origin, 12);
  const links = new Map();
  for (const pg of pages) {
    for (const m of pg.html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      let abs;
      try { abs = new URL(m[1], pg.url); } catch (_) { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      const key = abs.toString();
      if (!links.has(key)) links.set(key, pg.url);
      if (links.size >= max) break;
    }
  }
  const broken = [];
  for (const [url, from] of links) {
    try {
      let r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "G99PerformPR/1.0" } });
      if (r.status === 405 || r.status === 501) r = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": "G99PerformPR/1.0" } });
      if (r.status >= 400) broken.push(prFinding("link-check", r.status === 404 ? "high" : "medium", from, `${r.status} → ${url.slice(0, 120)}`, { found: String(r.status), fix: "proposed" }));
    } catch (e) {
      broken.push(prFinding("link-check", "medium", from, `unreachable → ${url.slice(0, 120)}`, { found: String(e.message).slice(0, 60), fix: "proposed" }));
    }
  }
  return { checked: links.size, pages: pages.length, findings: broken };
}
async function verifyHeadAssets(origin) {
  const out = [];
  const r = await fetchText(String(origin).replace(/\/+$/, "") + "/");
  if (!r.ok) return [prFinding("live-verify", "high", "(home)", "Home page did not return HTML after deploy", { fix: "none" })];
  const icon = (r.html.match(/<link[^>]+rel\s*=\s*["'](?:shortcut )?icon["'][^>]*>/i) || [])[0] || "";
  const og = (r.html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i) || [])[0] || "";
  const grab = (tag) => (tag.match(/(?:href|content)\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  for (const [label, tag] of [["favicon", icon], ["og:image", og]]) {
    if (!tag) { out.push(prFinding("live-verify", "high", "(home)", `${label} is still missing on the live page`, { fix: "proposed" })); continue; }
    const url = grab(tag);
    try {
      const a = await fetch(new URL(url, origin).toString(), { method: "HEAD", redirect: "follow" });
      if (!a.ok) out.push(prFinding("live-verify", "high", "(home)", `${label} points at ${url.slice(0, 90)} which returns ${a.status}`, { fix: "proposed" }));
    } catch (e) { out.push(prFinding("live-verify", "high", "(home)", `${label} could not be fetched: ${String(e.message).slice(0, 80)}`, { fix: "proposed" })); }
  }
  return out;
}

// One line per distinct problem, not per occurrence. A 17-page run produced 95
// findings, most of them the same image-naming message with a different filename,
// which buried the two that actually needed a decision.
function collapseFindings(list, perTaskLimit = 3) {
  const byTask = new Map();
  for (const f of list) {
    if (!byTask.has(f.task)) byTask.set(f.task, []);
    byTask.get(f.task).push(f);
  }
  const out = [];
  for (const [taskName, items] of byTask) {
    out.push(...items.slice(0, perTaskLimit));
    const rest = items.length - perTaskLimit;
    if (rest > 0) {
      const pages = [...new Set(items.slice(perTaskLimit).map((f) => f.page).filter(Boolean))];
      out.push({
        task: taskName, severity: "low", page: "",
        message: `…and ${rest} more ${taskName.replace(/-/g, " ")} finding(s)${pages.length ? ` across ${pages.length} page(s)` : ""} — see the full report`,
        expected: "", fix: "proposed", rollup: rest,
      });
    }
  }
  return out;
}

// ---- the shareable report ----------------------------------------------------
// Written twice: once when the PR opens, once after live verification. Same URL
// both times, so a link pasted into TED early does not go stale.
function performPrReportHtml(job) {
  const e = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tasks = job.prTasks || [];
  // Resolved here rather than only at write time, so rendering a stored run —
  // a re-render, a replay from the JSON sibling — still labels every row.
  const findings = resolveFindingOutcomes(job.prFindings || [], new Set(job.prFixedTasks || []));
  const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
  const byOutcome = (o) => findings.filter((f) => f.outcome === o).length;
  const chip = { pass: "#1f9d6b", fixed: "#2a68d8", fail: "#c0392b", skipped: "#8a8fa3" };
  const sevChip = { high: "#c0392b", medium: "#d98324", low: "#6b6f82" };
  // Four states, four colours. "Decision" is deliberately the loud one: it is
  // the only column value that is asking the reader to do something.
  const outChip = {
    done: { bg: "#e6f6ef", fg: "#1f7a55" }, pending: { bg: "#e8f0fe", fg: "#2a68d8" },
    decision: { bg: "#fdf0e3", fg: "#a65a12" }, "not-here": { bg: "#f2f3f7", fg: "#6b6f82" },
  };
  // Work that is already correct belongs in the report too. A check that passed
  // or was skipped leaves no finding behind, so it would otherwise vanish — and
  // a report that only ever lists problems reads as if nothing was fixed.
  const settled = (job.prTasks || []).filter((t) => t.status === "pass" || t.status === "fixed" || t.status === "skipped");
  const group = new Map();
  for (const f of findings) { if (!group.has(f.task)) group.set(f.task, []); group.get(f.task).push(f); }
  // The report keeps far more detail than the PR body, but a single check that
  // fires 70 times still needs a lid on it or the page becomes unreadable.
  const ROW_CAP = 15;
  const section = (name, all) => {
    const rows = all.slice(0, ROW_CAP);
    const hidden = all.length - rows.length;
    return `
    <h3 style="font-size:14px;margin:26px 0 8px;text-transform:capitalize">${e(name.replace(/-/g, " "))} <span style="color:#8a8fa3;font-weight:400">· ${all.length}</span></h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e8f0;border-radius:10px;overflow:hidden">
      <tr style="background:#fafbfe;color:#6b6f82"><th style="text-align:left;padding:8px 12px;width:110px">Page</th><th style="text-align:left;padding:8px 12px">Finding</th><th style="text-align:left;padding:8px 12px;width:150px">Expected</th><th style="padding:8px 12px;width:78px">Action</th></tr>
      ${rows.map((f) => `<tr style="border-top:1px solid #eef0f6">
        <td style="padding:8px 12px;color:#6b6f82"><code>${e(f.page || "—")}</code></td>
        <td style="padding:8px 12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sevChip[f.severity] || "#6b6f82"};margin-right:7px"></span>${e(f.message)}</td>
        <td style="padding:8px 12px;color:#6b6f82">${e(f.expected || "—")}</td>
        <td style="padding:8px 12px;text-align:center"><span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:${(outChip[f.outcome] || outChip["not-here"]).bg};color:${(outChip[f.outcome] || outChip["not-here"]).fg}">${e(OUTCOME_LABEL[f.outcome] || "Decision")}</span></td>
      </tr>`).join("")}
      ${hidden > 0 ? `<tr style="border-top:1px solid #eef0f6"><td colspan="4" style="padding:9px 12px;color:#8a8fa3;font-style:italic">…and ${hidden} more of the same kind (full list in the JSON alongside this report)</td></tr>` : ""}
    </table>`;
  };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pre-release report — ${e(job.businessName)}</title></head>
<body style="margin:0;font-family:Inter,-apple-system,Segoe UI,sans-serif;background:#f4f5f8;color:#1c1d29">
<div style="max-width:960px;margin:0 auto;padding:40px 24px 80px">
  <h1 style="font-size:24px;margin:0 0 6px">Pre-release report — ${e(job.businessName)}</h1>
  <p style="color:#6b6f82;font-size:13px;margin:0 0 24px">
    Run ${e(job.draftId)} · ${e(job.finishedAt || job.startedAt || new Date().toISOString())}
    ${job.prUrl ? ` · <a href="${e(job.prUrl)}" style="color:#2a68d8">pull request</a>` : ""}
    ${job.liveSite && job.liveSite.url ? ` · live site <a href="${e(job.liveSite.url)}" style="color:#2a68d8">${e(job.liveSite.url)}</a>` : ""}
  </p>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 28px">
    ${[["Done", byOutcome("done"), "#1f7a55"], ["Needs a decision", byOutcome("decision"), "#a65a12"], ["Pending", byOutcome("pending"), "#2a68d8"], ["Outside this repo", byOutcome("not-here"), "#6b6f82"]]
      .map(([l, v, c]) => `<div style="flex:1;min-width:150px;background:#fff;border:1px solid #e6e8f0;border-radius:12px;padding:16px">
        <div style="font-size:26px;font-weight:800;color:${c}">${e(v)}</div><div style="color:#6b6f82;font-size:12px">${e(l)}</div></div>`).join("")}
  </div>
  ${job.liveSite && !job.liveSite.ok ? `<div style="background:#fff8e6;border:1px solid #f0d9a0;border-radius:10px;padding:14px 16px;font-size:13px;margin-bottom:24px">
    <strong>Page comparison skipped.</strong> ${e(job.liveSite.reason || "")}${job.liveSite.url ? ` (<code>${e(job.liveSite.url)}</code>)` : ""}.
    Every other check ran against the beta site as normal.</div>` : ""}
  ${job.liveSite && job.liveSite.ok && job.liveSite.sitemapUrl ? `<p style="font-size:13px;color:#6b6f82;margin:-8px 0 22px">
    Compared against <a href="${e(job.liveSite.sitemapUrl)}" style="color:#2a68d8">${e(job.liveSite.sitemapUrl)}</a> — ${e(job.liveSite.pageCount)} page(s) on the client's current site.</p>` : ""}
  ${(job.pageSpeed || []).some((r) => r && r.ok) ? `<h2 style="font-size:16px;margin:0 0 10px">PageSpeed</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e8f0;border-radius:10px;overflow:hidden;margin-bottom:28px">
    <tr style="background:#fafbfe;color:#6b6f82"><th style="text-align:left;padding:9px 12px">Device</th><th style="padding:9px 12px">Performance</th><th style="padding:9px 12px">Accessibility</th><th style="padding:9px 12px">Best practices</th><th style="padding:9px 12px">SEO</th><th style="padding:9px 12px;width:90px">Report</th></tr>
    ${(job.pageSpeed || []).filter((r) => r && r.ok).map((r) => {
      const cell = (v) => `<td style="padding:9px 12px;text-align:center;font-weight:700;color:${v == null ? "#8a8fa3" : v >= 90 ? "#1f9d6b" : v >= 50 ? "#d98324" : "#c0392b"}">${v == null ? "—" : v}</td>`;
      return `<tr style="border-top:1px solid #eef0f6"><td style="padding:9px 12px;text-transform:capitalize;font-weight:600">${e(r.strategy)}</td>
        ${cell(r.scores.performance)}${cell(r.scores.accessibility)}${cell(r.scores.bestPractices)}${cell(r.scores.seo)}
        <td style="padding:9px 12px;text-align:center"><a href="${e(r.reportUrl)}" style="color:#2a68d8">open</a></td></tr>`;
    }).join("")}
  </table>` : ""}
  <h2 style="font-size:16px;margin:0 0 10px">Checks</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e8f0;border-radius:10px;overflow:hidden">
    <tr style="background:#fafbfe;color:#6b6f82"><th style="text-align:left;padding:9px 12px;width:210px">Check</th><th style="padding:9px 12px;width:86px">Result</th><th style="text-align:left;padding:9px 12px">Detail</th></tr>
    ${tasks.map((t) => `<tr style="border-top:1px solid #eef0f6">
      <td style="padding:9px 12px;font-weight:600">${e(t.label)}</td>
      <td style="padding:9px 12px;text-align:center"><span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;color:#fff;background:${chip[t.status] || "#8a8fa3"}">${e(t.status)}</span></td>
      <td style="padding:9px 12px;color:#555">${e(t.detail || "")}</td></tr>`).join("")}
  </table>
  ${(job.imageSwaps || []).length ? `<h2 style="font-size:16px;margin:34px 0 10px">Images — before and after <span style="color:#8a8fa3;font-weight:400;font-size:13px">· ${job.imageSwaps.length}</span></h2>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:1px solid #e6e8f0;border-radius:10px;overflow:hidden">
    <tr style="background:#fafbfe;color:#6b6f82"><th style="text-align:left;padding:8px 12px;width:72px">Page</th><th style="text-align:left;padding:8px 12px">Was</th><th style="text-align:left;padding:8px 12px">Now</th><th style="padding:8px 12px;width:120px">Size</th></tr>
    ${job.imageSwaps.slice(0, 40).map((s) => {
      const wasKb = Math.round((s.wasBytes || 0) / 1024), nowKb = Math.round((s.nowBytes || 0) / 1024);
      const cut = wasKb ? Math.round((1 - nowKb / wasKb) * 100) : 0;
      return `<tr style="border-top:1px solid #eef0f6">
        <td style="padding:8px 12px;color:#6b6f82"><code>${e(s.page)}</code></td>
        <td style="padding:8px 12px;color:#8a8fa3"><code>${e(String(s.from).split("/").pop().slice(0, 34))}…</code></td>
        <td style="padding:8px 12px"><code>${e(String(s.to).replace("assets/img/", ""))}</code></td>
        <td style="padding:8px 12px;text-align:right;white-space:nowrap">${wasKb ? `<span style="color:#8a8fa3">${wasKb}KB</span> → ` : ""}<strong style="color:#1f7a55">${nowKb}KB</strong>${cut > 0 ? ` <span style="color:#1f7a55">−${cut}%</span>` : ""}</td>
      </tr>`;
    }).join("")}
  </table></div>` : ""}
  ${settled.length ? `<h2 style="font-size:16px;margin:34px 0 10px">Already handled <span style="color:#8a8fa3;font-weight:400;font-size:13px">· ${settled.length}</span></h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e8f0;border-radius:10px;overflow:hidden">
    ${settled.map((t) => `<tr style="border-top:1px solid #eef0f6">
      <td style="padding:9px 12px;font-weight:600;width:210px">${e(t.label)}</td>
      <td style="padding:9px 12px;text-align:center;width:86px"><span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:${outChip.done.bg};color:${outChip.done.fg}">Done</span></td>
      <td style="padding:9px 12px;color:#555">${e(t.status === "fixed" ? "fixed in this run — " + (t.detail || "") : t.detail || "")}</td></tr>`).join("")}
  </table>` : ""}
  ${findings.length ? `<h2 style="font-size:16px;margin:34px 0 0">Findings</h2>${[...group.entries()].map(([k, v]) => section(k, v)).join("")}` : `<p style="margin-top:30px;color:#1f9d6b;font-weight:600">No findings — every check passed.</p>`}
  ${(job.prChanged || []).length ? `<h2 style="font-size:16px;margin:34px 0 8px">Files changed</h2>
    <ul style="font-size:13px;color:#444">${job.prChanged.map((f) => `<li><code>${e(f)}</code></li>`).join("")}</ul>` : ""}
  <p style="margin-top:40px;color:#8a8fa3;font-size:12px">Generated by Growth99 Studio · Perform PR</p>
</div></body></html>`;
}
function writePerformPrReport(job) {
  const dir = path.join(GEN, "reports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, job.draftId + ".html"), performPrReportHtml(job));
  fs.writeFileSync(path.join(dir, job.draftId + ".json"), JSON.stringify({
    draftId: job.draftId, businessName: job.businessName, prUrl: job.prUrl,
    liveSite: job.liveSite, tasks: job.prTasks, findings: job.prFindings,
    changed: job.prChanged, finishedAt: job.finishedAt,
  }, null, 2));
  return "/reports/" + job.draftId + ".html";
}
function performPrPrBody(job, reportUrl) {
  const f = job.prFindings || [];
  const count = (s) => f.filter((x) => x.severity === s).length;
  const L = [
    `Pre-release pass for **${job.businessName}**.`, "",
    `**${count("high")} high · ${count("medium")} medium · ${count("low")} low** findings across ${(job.prTasks || []).length} checks.`, "",
    "| Check | Result | Detail |", "|---|---|---|",
    ...(job.prTasks || []).map((t) => `| ${t.label} | ${t.status} | ${String(t.detail || "").replace(/\|/g, "\\|").slice(0, 110)} |`),
    "",
  ];
  // What we fixed comes first. A PR that lists only outstanding problems reads
  // as if it changed nothing, which is the opposite of what it is for.
  const fixedTasks = (job.prTasks || []).filter((t) => t.status === "fixed");
  if (fixedTasks.length) {
    L.push("### Fixed in this PR", "",
      ...fixedTasks.map((t) => `- **${t.label}** — ${String(t.detail || "").replace(/\|/g, "\\|")}`), "");
  }
  const line = (x) => x.rollup ? `- ${x.message}` : `- \`${x.page || "site"}\` — ${x.message.replace(/\|/g, "\\|")}`;
  const decisions = collapseFindings(f.filter((x) => x.outcome === OUTCOME.DECISION), 3);
  if (decisions.length) {
    L.push("### Needs a human decision", "",
      "Detected, but only a person can say what the right answer is:", "", ...decisions.map(line), "");
  }
  const outside = collapseFindings(f.filter((x) => x.outcome === OUTCOME.NOT_HERE), 2);
  if (outside.length) {
    L.push("### Outside this repository", "",
      "Real problems, but the files live in the media library — no pull request can reach them:", "", ...outside.map(line), "");
  }
  const pending = collapseFindings(f.filter((x) => x.outcome === OUTCOME.PENDING), 2);
  if (pending.length) {
    L.push("### Fixable, but not this run", "",
      "We own these — an input was missing:", "", ...pending.map(line), "");
  }
  if (reportUrl) L.push(`Full report: ${reportUrl}`, "");
  return L.join("\n");
}

// A run that cannot merge leaves its pull request open. Unattended — which is
// what the TED webhook makes this — those accumulate until someone notices a
// list of stale pre-release PRs, each one carrying changes that made sense
// against a repository state that has since moved on. Merging one of those later
// is how this site got 301s pointing at pages that no longer existed.
//
// So each new run closes the ones it supersedes. Deliberately narrow: only open
// PRs, only branches this job names for this exact theme, never the one just
// opened. A human's PR, another client's, or the responsive job's cannot match
// the prefix. Fail-soft — losing the tidy-up must not fail an otherwise good run.
async function closeSupersededPerformPrs(repo, themeSlug, keepPrUrl) {
  if ((process.env.PERFORM_PR_CLOSE_SUPERSEDED || "on").toLowerCase() === "off") return [];
  const prefix = `g99/perform-pr-${String(themeSlug || "").replace(/^g99-/, "")}-`;
  const keepNum = ((keepPrUrl || "").match(/\/pull\/(\d+)/) || [])[1];
  try {
    const r = await sh(`gh pr list --repo ${repo} --state open --limit 60 --json number,headRefName`);
    if (r.code) return [];
    const stale = JSON.parse(r.stdout || "[]")
      .filter((pr) => String(pr.headRefName || "").startsWith(prefix) && String(pr.number) !== keepNum);
    const closed = [];
    for (const pr of stale) {
      const body = `Superseded by #${keepNum} — a newer pre-release run has been opened for this site. Closing so its changes, which were built against an older state of this repository, are not merged later by mistake.`;
      await sh(`gh pr comment ${pr.number} --repo ${repo} --body "${body.replace(/"/g, "'")}"`);
      const c = await sh(`gh pr close ${pr.number} --repo ${repo} --delete-branch`);
      if (!c.code) closed.push(pr.number);
    }
    if (closed.length) console.log(`perform-pr: closed superseded PR(s) ${closed.map((n) => "#" + n).join(", ")}`);
    return closed;
  } catch (e) {
    console.warn("perform-pr: could not close superseded PRs:", e.message);
    return [];
  }
}

// Report back to the task that asked for the run. Only when the run was started
// by a TED webhook — a run kicked off from the dashboard has no ticket to answer,
// and posting to a default task would put one client's findings on another's thread.
async function postPerformPrToTed(job, extra, phase = "final") {
  const taskId = job.payload && job.payload.tedTaskId;
  if (!taskId) return;
  const f = job.prFindings || [];
  const n = (o) => f.filter((x) => x.outcome === o).length;
  const fixed = (job.prTasks || []).filter((t) => t.status === "fixed");
  const lines = phase === "interim"
    ? [`Pre-release checks ran for ${job.businessName}. Applying fixes and waiting on CI — the full report follows when it merges.`]
    : [`Pre-release checks completed for ${job.businessName}.`];
  lines.push("", `${(job.prTasks || []).length} checks ran. ${n("done")} done, ${n("decision")} need a decision, ${n("pending")} pending.`);
  if (fixed.length) lines.push("", "Fixed in this run:", ...fixed.map((t) => `- ${t.label}: ${t.detail || ""}`));
  // The hosted report lives on an ephemeral filesystem and does not survive a
  // redeploy, so the comment has to carry enough on its own to still be worth
  // reading after the link has died. What needs a human decision is the part
  // that matters, so it goes in the text rather than only behind the link.
  const decisions = collapseFindings(f.filter((x) => x.outcome === OUTCOME.DECISION), 2);
  if (decisions.length) {
    lines.push("", "Needs a decision:", ...decisions.slice(0, 8).map((x) => `- ${x.rollup ? x.message : `${x.page ? x.page + ": " : ""}${x.message}`}`));
  }
  if (extra) lines.push("", extra);
  if (job.prUrl) lines.push("", `Pull request: ${job.prUrl}`);
  if (job.reportUrl) lines.push("", "Full report (expires on redeploy):", absUrl(job.reportUrl));
  const text = lines.join("\n");
  // One eventKey per job per phase: TED treats it as an idempotency key, so a
  // retry after a timeout updates that comment rather than adding another.
  const ai = await tedAiComment(taskId, text, `perform-pr:${job.draftId}:${phase}`);
  if (ai.ok) {
    await closeTedTaskIfFinal(job, taskId, phase);
    return;
  }
  console.warn(`TED AI comment failed (${ai.reason}) — falling back to a normal comment`);
  tedComment(text, null, 0, String(taskId));
  await closeTedTaskIfFinal(job, taskId, phase);
}

// Hand the ticket back once the run is actually over: mark it done by the AI so
// nobody closes a task they did not do. Only on the final comment — the interim
// one goes out while CI is still running, and closing a task that has not
// finished is worse than leaving it open.
//
// A run that could not merge leaves the ticket open on purpose. Its pull request
// is still waiting on a human, so the work is not complete however good the
// report is.
async function closeTedTaskIfFinal(job, taskId, phase) {
  if (phase !== "final") return;
  if (!job.prUrl || job.error) {
    console.log(`TED task ${taskId} left open — the run did not merge (${job.error || "no pull request"})`);
    return;
  }
  const r = await tedUpdateTask(taskId, { aiAssigned: true, status: "Completed" });
  if (r.ok) console.log(`TED task ${taskId} marked Completed and assigned to AI`);
  else console.warn(`TED task ${taskId} could not be updated: ${r.reason}`);
}

function newPerformPrJob(payload) {
  return {
    type: "perform-pr", draftId: String(payload.jobId), businessId: null,
    businessName: payload.businessName || payload.siteId || "Site", status: "queued", currentStep: 0,
    steps: PERFORM_PR_STEPS.map((label) => ({ label, status: "pending", detail: "" })), payload,
    prUrl: null, branch: null, reportUrl: null,
    liveSite: null, prFacts: null, prTasks: [], prFindings: [], prChanged: [], pageSpeed: null,
    editPlan: null, editSummary: "Pre-release checks", error: null,
    cost: { gemini: 0, stitch: 0 }, cancelRequested: false, awaitingApproval: false,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
}
function enqueuePerformPrJob(payload) {
  const job = newPerformPrJob(payload);
  JOBS.set(job.draftId, job);
  JOB_QUEUE.push(job.draftId);
  saveJobs();
  processJobQueue();
  return job;
}

async function runPerformPrJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  COST_SINK = job.cost;
  const P = job.payload, repo = P.githubRepo || WP_REPO;
  const tmp = path.join(os.tmpdir(), "g99ppr-" + Date.now());
  const ai = { aiModel: "gemini" };
  const run = async (cmd, cwd) => sh(cmd, cwd);
  const runRetry = async (cmd, cwd, n = 3) => {
    let r;
    for (let i = 1; i <= n; i++) { r = await run(cmd, cwd); if (!r.code) return r; await sleep(3000 * i); }
    return r;
  };
  const task = (label, status, detail, findings) => {
    job.prTasks.push({ label, status, detail: String(detail || "").slice(0, 200) });
    if (findings && findings.length) job.prFindings.push(...findings);
    saveJobs();
  };
  try {
    // ---- phase 0 -------------------------------------------------------------
    jobStep(job, 0, "running", "Cloning " + repo);
    let r = await runRetry(`gh repo clone ${repo} "${tmp}" -- --depth 1`);
    const cloneUrl = await ghCloneUrl(repo);
    if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
    if (r.code) throw new Error("clone failed: " + r.stderr.slice(-200));
    if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
    const themeAbs = path.join(tmp, P.themePath);
    if (!fs.existsSync(themeAbs)) throw new Error("theme not found: " + P.themePath);
    const muAbs = P.muPath ? path.join(tmp, P.muPath) : "";
    const muSrc = muAbs && fs.existsSync(muAbs) ? fs.readFileSync(muAbs, "utf8") : synthMuSource(themeAbs);
    const { pages, muPages } = readSeoPages(themeAbs, muSrc);
    if (!pages.length) throw new Error("no registered pages found in the active theme");
    jobStep(job, 0, "done", `${pages.length} page(s) in ${P.themePath}`);

    // The live site is read for one thing only: its sitemap, which tells us which
    // pages the client publishes today. Everything else about the business comes
    // from the site we built.
    jobStep(job, 1, "running", P.existingSiteUrl ? `Reading ${P.existingSiteUrl}...` : "Deriving the client's live domain...");
    const live = await resolveLiveSite(P.liveUrl, P.businessName, P.existingSiteUrl);
    job.liveSite = { ok: live.ok, url: live.url, source: live.source, reason: live.reason || "" };
    let liveUrls = [];
    if (live.ok) {
      jobStep(job, 1, "running", `Fetching the sitemap from ${live.url}...`);
      const sitemap = await fetchLiveSitemap(live.url);
      liveUrls = sitemap.urls || [];
      job.liveSite.sitemapUrl = sitemap.url || "";
      job.liveSite.pageCount = liveUrls.length;
      if (!sitemap.ok) {
        job.liveSite.ok = false;
        job.liveSite.reason = sitemap.reason || "no sitemap";
        jobStep(job, 1, "done", "no sitemap — page comparison skipped");
      } else {
        jobStep(job, 1, "done", `${liveUrls.length} page(s) in ${sitemap.url}`);
      }
    } else {
      // Not fatal: every audit that reads the built site still runs. Only the
      // missing-pages comparison is skipped, and the report says so plainly.
      jobStep(job, 1, "done", "not compared — " + job.liveSite.reason);
    }

    jobStep(job, 2, "running", "Reading contact details off the built site...");
    const facts = await readBusinessFacts(pages, P.businessName, ai);
    const socials = extractSocials(pages);
    const brand = themeBrandColor(themeAbs);
    const siteHost = siteHostOf(P.liveUrl);
    job.prFacts = { ...facts, name: P.businessName, socials, brand };
    jobStep(job, 2, "done", [facts.phone, facts.email, socials.length ? socials.length + " social link(s)" : "", brand].filter(Boolean).join(" · ") || "no contact details found");

    // ---- phase 1 -------------------------------------------------------------
    jobStep(job, 3, "running", "Pages from the live site, business name, contact, CTAs...");
    if (job.liveSite.ok) {
      const missingF = findingsMissingPages(pages, liveUrls);
      task("Pages from the live site", missingF.length ? "fail" : "pass",
        missingF.length ? `${missingF.length} of ${liveUrls.length} live page(s) have no match` : `all ${liveUrls.length} live page(s) have a match`, missingF);
    } else {
      task("Pages from the live site", "skipped", job.liveSite.reason);
    }
    const urls = findingsUrlStructure(pages, facts);
    task("Location + URL structure", urls.findings.length ? "fail" : "pass",
      `${urls.detail}${urls.findings.length ? ` — ${urls.findings.length} issue(s)` : " — all correct"}`, urls.findings);
    // Checked against the page list rather than over the network, so a dead
    // internal link can still be fixed in this PR instead of found after deploy.
    // Page templates plus header/footer: a bad link in the chrome is on every page.
    const linkF = findingsInternalLinks([...pages, ...themeChromePages(themeAbs)], muPages);
    task("Internal links", linkF.length ? "fail" : "pass", linkF.length ? `${linkF.length} link(s) point at a missing page` : "every internal link resolves", linkF);
    const nameF = findingsBusinessName(pages, P.businessName);
    task("Business name", nameF.length ? "fail" : "pass", nameF.length ? `${nameF.length} inconsistency(ies)` : `"${P.businessName}" used consistently`, nameF);
    const contactF = findingsContact(pages, facts);
    task("Contact details", contactF.length ? "fail" : "pass", contactF.length ? `${contactF.length} issue(s)` : "phone, email and address agree across the site", contactF);
    // An audit never reports "fixed" — it has not fixed anything yet. Phase 2
    // upgrades these to "fixed" only when it actually changes a file, so a fix
    // that declines to run (no site-owned logo, say) stays honest in the report.
    const clickF = findingsClickable(pages, facts);
    task("Clickable contact", clickF.length ? "fail" : "pass", clickF.length ? `${clickF.length} plain-text mention(s) to link` : "already clickable", clickF);
    const ctaF = findingsCta(pages);
    task("CTA on every page", ctaF.length ? "fail" : "pass", ctaF.length ? `${ctaF.length} page(s) without a CTA` : `all ${pages.length} page(s) have a CTA`, ctaF);
    jobStep(job, 3, "done", `${nameF.length + contactF.length + clickF.length + ctaF.length} finding(s)`);

    jobStep(job, 4, "running", "Favicon, images, spelling...");
    const favF = findingsFavicon(themeAbs, pages, siteHost);
    task("Favicon", favF.length ? "fail" : "pass", favF.length ? "not emitted by the theme" : "already emitted", favF);
    const images = imageSources(pages);
    const imgF = findingsImages(images, P.businessName);
    const weightF = await findingsImageWeight(images);
    task("Image naming", imgF.filter((f) => f.task === "image-naming").length ? "fail" : "pass", `${images.length} image(s) inspected`, imgF);
    task("Image format + weight", weightF.length ? "fail" : "pass", weightF.length ? `${weightF.length} oversized` : "within budget", weightF);
    const spellF = await findingsSpelling(pages, ai);
    task("Spelling", spellF.length ? "fail" : "pass", spellF.length ? `${spellF.length} suspected misspelling(s)` : "no misspellings found", spellF);
    jobStep(job, 4, "done", `${favF.length + imgF.length + weightF.length + spellF.length} finding(s)`);

    jobStep(job, 5, "running", "Reading every page for content problems...");
    const auditF = await findingsPageAudit(pages, P.businessName, ai);
    task("Page audit", auditF.length ? "fail" : "pass", auditF.length ? `${auditF.length} suggestion(s)` : "no content problems found", auditF);
    jobStep(job, 5, "done", `${auditF.length} suggestion(s)`);

    // ---- phase 2 -------------------------------------------------------------
    jobStep(job, 6, "running", "Applying the fixes whose answer is computable...");
    const applied = [];
    // Which audit each fix answers, so a finding can be told what became of it.
    const fixedTasks = new Set();
    const record = (label, result, answers) => {
      applied.push({ label, ...result });
      job.prChanged.push(...(result.changed || []));
      if (answers && (result.changed || []).length) fixedTasks.add(answers);
      const t = job.prTasks.find((x) => x.label === label);
      if (t) { t.status = (result.changed || []).length ? "fixed" : (result.skipped ? "skipped" : t.status); t.detail = result.note || t.detail; }
      else task(label, (result.changed || []).length ? "fixed" : "skipped", result.note);
      jobStep(job, 6, "running", label + " — " + result.note);
    };
    record("Business name", fixBusinessName(themeAbs, pages, P.businessName, facts.name, P.themePath), "business-name");
    // Redirect map first, then the rename that depends on it.
    const urlFix = fixUrlStructure(themeAbs, muAbs, P.muPath, P.themePath, urls.renames || []);
    job.urlRenames = urlFix.renamed || [];
    record("Location + URL structure", urlFix, "url-structure");
    const linkFix = fixInternalLinks(themeAbs, P.themePath, job.prFindings, muPages);
    job.linkRedirects = linkFix.redirects || [];
    record("Internal links", linkFix, "internal-links");
    record("Spelling", fixSpelling(themeAbs, pages, job.prFindings, P.themePath), "spelling");
    record("CTA on every page", fixCta(themeAbs, pages, job.prFindings, P.themePath), "cta");
    // Images last of the content fixes: it rewrites src attributes across every
    // template, so it should not race the edits above on the same files.
    const imgFix = await performPrFixImages(themeAbs, pages, P.businessName, facts, P.themePath);
    job.imageSwaps = imgFix.swaps || [];
    record("Image naming", imgFix, "image-naming");
    if ((imgFix.changed || []).length) { fixedTasks.add("image-format"); fixedTasks.add("image-weight"); }
    record("Favicon", fixFavicon(themeAbs, pages, P.themePath, siteHost), "favicon");
    record("Social sharing image", fixSocialImage(themeAbs, pages, P.themePath, siteHost));
    record("Custom 404", fix404(themeAbs, P.themePath, brand));
    record("Call Now", fixCallNow(themeAbs, P.themePath, facts.phone, brand));
    record("BLVD button ID", fixBlvd(themeAbs, pages, P.themePath));
    record("Blog sidebar widget", fixBlogSidebar(themeAbs));
    record("Blog link colour", fixBlogLinkColor(themeAbs, P.themePath, brand));
    record("Clickable contact", fixClickable(themeAbs, pages, P.themePath), "clickable-contact");
    // Now — and only now — each finding learns what actually happened to it.
    // Kept on the job so the phase-4 findings (links, PageSpeed) get resolved
    // the same way when the report is written.
    job.prFixedTasks = [...fixedTasks];
    resolveFindingOutcomes(job.prFindings, fixedTasks);
    job.prChanged = [...new Set(job.prChanged)];
    job.editPlan = job.prChanged.map((p2) => ({ path: p2, op: "modify" }));
    jobStep(job, 6, "done", job.prChanged.length ? `${job.prChanged.length} file(s) changed` : "nothing to change");

    // ---- phase 3 -------------------------------------------------------------
    jobStep(job, 7, "running", "Checking the diff...");
    const marker = path.join(themeAbs, "g99-perform-pr-marker.txt");
    fs.writeFileSync(marker, job.draftId + "\n");
    const paths = `"${P.themePath}"`;
    await run(`git add -A -- ${paths}`, tmp);
    const whitespace = await run(`git diff --cached --check -- ${paths}`, tmp);
    if (whitespace.code) throw new Error("fixes failed git diff check: " + String(whitespace.stdout || whitespace.stderr).slice(-200));
    const stat = await run(`git --no-pager diff --cached --stat -- ${paths}`, tmp);
    jobStep(job, 7, "done", String(stat.stdout || "").trim().split("\n").slice(-1)[0] || "marker only");

    jobStep(job, 8, "running", "Pushing + opening PR...");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const branch = `g99/perform-pr-${P.themeSlug.replace(/^g99-/, "")}-${stamp}`;
    const title = `Pre-release ${P.businessName}: automated checks + fixes`;
    await run(`git checkout -b "${branch}"`, tmp);
    r = await run(`git -c user.email="tools@growth99.com" -c user.name="Growth99 Bot" commit -m "${title.replace(/"/g, "'")}"`, tmp);
    if (r.code) throw new Error("commit failed: " + String(r.stderr || r.stdout).slice(-180));
    r = await runRetry(`git push -u origin "${branch}"`, tmp);
    if (r.code) throw new Error("push failed: " + r.stderr.slice(-200));
    job.branch = branch;
    // Report first so the PR body can link to it; rewritten again after verification.
    job.reportUrl = writePerformPrReport(job);
    const bodyFile = path.join(os.tmpdir(), `perform-pr-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, performPrPrBody(job, absUrl(job.reportUrl)));
    r = await runRetry(`gh pr create --repo ${repo} --base main --head "${branch}" --title "${title.replace(/"/g, "'")}" --body-file "${bodyFile}"`, tmp);
    fs.rmSync(bodyFile, { force: true });
    job.prUrl = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0];
    if (!job.prUrl) throw new Error("PR create failed: " + r.stderr.slice(-200));
    // Only once this run's PR exists, so a failure above can never close the
    // previous one and leave the site with no open pre-release PR at all.
    job.supersededPrs = await closeSupersededPerformPrs(repo, P.themeSlug, job.prUrl);
    jobStep(job, 8, "done", job.prUrl + (job.supersededPrs.length ? ` · closed ${job.supersededPrs.map((n) => "#" + n).join(", ")}` : ""));
    // Everything the audit found is already known here. CI, the deploy wait and
    // PageSpeed add several minutes and change none of it, so the findings go to
    // the task now rather than at the end. The final comment replaces this one.
    postPerformPrToTed(job, null, "interim").catch(() => {});

    jobStep(job, 9, "running", "Watching CI build checks...");
    let fixes = 0, merged = false;
    for (let i = 0; i < 240 && !merged; i++) {
      let st;
      try { st = await localApi("/api/pr-status", { prUrl: job.prUrl, requireAllChecks: true }); }
      catch (e) { await sleep(10000); continue; }
      jobStep(job, 9, "running", (st.checks || []).map((c) => `${c.name}:${c.status}`).join(" ") || "CI starting...");
      if (await ciEarlyExit(job, 9, P.siteId, st, i)) { merged = true; break; }
      if (st.allPass) {
        await awaitApprovalIfNeeded(job, P.siteId, 9);
        if (!job.mergedExternally) await localApi("/api/pr-merge", { prUrl: job.prUrl });
        merged = true;
        jobStep(job, 9, "done", `Merged${fixes ? ` after ${fixes} fix(es)` : ""}`);
        break;
      }
      if (st.anyFail) {
        // The auto-fixer only repairs build checks. When the red check is
        // something else — this repo's Integration test has been failing on main
        // since before Perform PR existed — retrying is pointless and throwing
        // buries the reason. Stop cleanly, leave the PR open, say which check.
        const failing = (st.checks || []).filter((c) => c.status === "fail");
        const repairable = failing.filter((c) => /^build/i.test(c.name));
        if (!repairable.length) {
          job.ciBlockedBy = failing.map((c) => c.name).join(", ") || "an unknown check";
          jobStep(job, 9, "error", `${job.ciBlockedBy} failing — not a build check the auto-fixer can repair. PR left open.`);
          break;
        }
        if (fixes >= 3) throw new Error("CI still failing after 3 auto-fix attempts - " + job.prUrl);
        fixes++;
        const fix = await localApi("/api/pr-autofix", { prUrl: job.prUrl }, 5 * 60 * 1000);
        // Org billing stopped Actions from starting at all. Nothing in this repo
        // can fix that, and the audit is still worth keeping — so take the same
        // clean exit as a check the auto-fixer does not own, rather than throwing
        // away the run's findings.
        if (fix.billing) {
          job.ciBlockedBy = "GitHub Actions billing";
          jobStep(job, 9, "error", fix.message);
          break;
        }
        if (!fix.fixed || !fix.fixed.length) throw new Error("auto-fix could not resolve CI: " + (fix.message || ""));
        await sleep(20000);
        continue;
      }
      await sleep(10000);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    // Not merged, but the audit is still the point of the run. Publish what we
    // found and stop before the live-verification phase, which needs the deploy.
    if (!merged) {
      const why = job.ciBlockedBy ? `blocked by ${job.ciBlockedBy}` : "CI watch timed out";
      for (const i of [10, 11]) jobStep(job, i, "done", `skipped — ${why}, nothing deployed to measure`);
      jobStep(job, 12, "running", "Writing the report...");
      job.finishedAt = new Date().toISOString();
      job.reportUrl = writePerformPrReport(job);
      jobStep(job, 12, "done", `${job.prFindings.length} finding(s) · ${job.prChanged.length} file(s) changed · PR open`);
      job.status = "done";
      job.error = `PR opened but not merged — ${why}. ${job.prUrl}`;
      notify(`Perform PR audited *${job.businessName}* but did not merge (${why}) — ${absUrl(job.reportUrl)}`);
      postPerformPrToTed(job, `The pull request is open but not merged (${why}).`);
      return;
    }

    // ---- phase 4 -------------------------------------------------------------
    jobStep(job, 10, "running", `Waiting for release ${job.draftId} to deploy...`);
    await waitForPerformPrDeployment(P.liveUrl, P.themeSlug, job.draftId);
    const settle = Math.max(0, Number(process.env.PR_DEPLOY_WAIT_MS || 5000) || 5000);
    if (settle) await sleep(settle);
    jobStep(job, 10, "running", "Checking links on the deployed site...");
    const links = await verifyLinks(P.liveUrl);
    task("Link check", links.findings.length ? "fail" : "pass", `${links.checked} link(s) across ${links.pages} page(s)`, links.findings);
    jobStep(job, 10, "done", `${links.findings.length} finding(s) after deploy`);

    // Last, because it must measure the site as released — after the fixes above
    // are live, not the state we started from.
    jobStep(job, 11, "running", "Running PageSpeed on mobile...");
    const psiMobile = await pageSpeedRun(P.liveUrl, "mobile");
    jobStep(job, 11, "running", "Running PageSpeed on desktop...");
    const psiDesktop = await pageSpeedRun(P.liveUrl, "desktop");
    job.pageSpeed = [psiMobile, psiDesktop];
    const psiF = findingsPageSpeed(job.pageSpeed);
    const scoreLine = (r) => r.ok ? `${r.strategy}: perf ${r.scores.performance ?? "—"} · a11y ${r.scores.accessibility ?? "—"} · best ${r.scores.bestPractices ?? "—"} · seo ${r.scores.seo ?? "—"}` : `${r.strategy}: ${r.reason}`;
    task("PageSpeed", psiF.some((f) => f.severity === "high") ? "fail" : psiF.length ? "fail" : "pass",
      [scoreLine(psiMobile), scoreLine(psiDesktop)].join(" | "), psiF);
    jobStep(job, 11, "done", scoreLine(psiMobile));

    jobStep(job, 12, "running", "Writing the report...");
    job.finishedAt = new Date().toISOString();
    job.reportUrl = writePerformPrReport(job);
    const high = job.prFindings.filter((f) => f.severity === "high").length;
    jobStep(job, 12, "done", `${job.prFindings.length} finding(s) · ${job.prChanged.length} file(s) changed`);
    job.status = "done";
    notify(`Perform PR finished for *${job.businessName}*: ${job.prChanged.length} file(s) fixed, ${job.prFindings.length} finding(s) (${high} high) — ${absUrl(job.reportUrl)}`);
    postPerformPrToTed(job);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (e && e.cancelled) job.status = "cancelled";
    else {
      job.error = e.message;
      job.status = "error";
      if (job.steps[job.currentStep] && job.steps[job.currentStep].status === "running") {
        job.steps[job.currentStep].status = "error";
        job.steps[job.currentStep].detail = String(e.message).slice(0, 240);
      }
      console.error(`perform-pr job ${job.draftId} failed:`, e.message);
      notify(`Perform PR failed for *${job.businessName}*: ${e.message}`);
    }
    // A run that died at step 7 still learned something at steps 3–5. Publishing
    // the partial report is strictly better than losing the findings.
    try { if ((job.prTasks || []).length) job.reportUrl = writePerformPrReport(job); } catch (_) {}
  } finally {
    job.finishedAt = job.finishedAt || new Date().toISOString();
    saveJobs();
    COST_SINK = null;
  }
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
    // Mobile pre-release evidence. Strict segment allow-list prevents traversal;
    // screenshots contain only already-public website renders.
    if (p.startsWith("/pr-artifacts/")) {
      const parts = p.slice("/pr-artifacts/".length).split("/").map(decodeURIComponent);
      if (parts.length !== 3 || parts.some((x) => !isSafeArtifactSegment(x))) return send(res, 404, "text/plain", "not found");
      const f = path.join(GEN, "pre-release", ...parts);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found");
      return send(res, 200, MIME[path.extname(f).toLowerCase()] || "application/octet-stream", fs.readFileSync(f));
    }
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
    // TED task-status webhook (Phase-4 template-key subscription). When mockup.create closes for a
    // client, TED sends us the resolved wireframe.qa target task; we run the visible CRO audit job
    // and post the report onto that task. No secret configured — accepts on payload shape alone.
    if (p === "/api/webhook/ted-task-status" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      const trig = body.trigger || {}, tgt = body.target || {};
      const isClose = body.event === "TASK_STATUS_CHANGED"
        && trig.templateKey === "mockup.create"
        && String(trig.status).toLowerCase() === "completed";
      if (!isClose) {
        return json(res, 200, { ok: true, ignored: `not a mockup.create completion (event=${body.event}, key=${trig.templateKey}, status=${trig.status})` });
      }
      const targetTaskId = tgt.id || null;
      const wantKey = body.targetTemplateKey || tgt.templateKey;
      if (!targetTaskId || wantKey !== "wireframe.qa") {
        return json(res, 200, { ok: true, ignored: `no wireframe.qa target (target=${targetTaskId}, key=${wantKey})` });
      }
      const job = enqueueWireframeAuditJob({
        clientId: trig.clientId, clientName: trig.clientName,
        targetTaskId, targetTemplateKey: wantKey,
      });
      return json(res, 202, { ok: true, jobId: job.draftId, status: job.status, targetTaskId });
    }

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
      // The brand the CLIENT confirmed on step 10 of the onboarding form — their existing site's real
      // colours and type, which they said yes to. When present it replaces our own derivation: we no
      // longer have to guess a palette from a screenshot for a client who already told us theirs.
      const confirmedBrand = (body.brand && typeof body.brand === "object") ? body.brand : null;
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
          confirmedBrand,
          // Presigned by product-service: the raw logo_file answer is a private S3 object
          // that 403s, so this is the only fetchable form of the client's logo.
          logoUrl: body.logoUrl || null,
          answers: mapped.answers,
        }, null, 2));
      } catch (e) { console.warn("could not persist onboarding.json:", e.message); }
      const { job, dedupe } = enqueueJob({
        draftId: body.draftId, businessId: body.businessId, businessName: body.businessName,
        answers: mapped.answers, existingWebsite: body.existingWebsite || mapped.existingWebsite,
        referenceWebsite: body.referenceWebsite || mapped.referenceWebsite,
        // the build target from the deal — without these the job used env defaults
        betaSiteUrl, betaSiteRepo, receivedAt, source: "onboarding form",
        brand: confirmedBrand,
        // HubSpot identity, carried through so this job's own artifact push to TED (screenshots +
        // service pages) can resolve the right client unambiguously — companyId especially, since
        // businessId alone is reused across clone/test businesses. See tedPushArtifacts().
        hubspotDealId: body.hubspotDealId || body.dealId || null,
        hubspotCompanyId: body.hubspotCompanyId || body.companyId || null,
      });
      console.log(`webhook: ${job.businessName} · repo ${job.repo} · beta ${job.liveUrl}${betaSiteUrl || betaSiteRepo ? "" : " (deal properties missing — using this deployment's defaults)"}`
        + (confirmedBrand ? ` · client-confirmed brand ${confirmedBrand.primaryColor || "?"}/${confirmedBrand.accentColor || "?"} ${confirmedBrand.headingFont || "?"}` : " · no confirmed brand (will derive)"));
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ accepted: true, dedupe, draftId: job.draftId, status: job.status, monitor: "/jobs" }));
    }

    // TED pre-release task event → Perform PR. Sits outside the admin-key gate.
    // carries its own secret, like the other webhooks.
    //
    // TED does not send a siteId — it sends a client name and a task. So the
    // client is resolved against NocoDB by name, and the run is refused rather
    // than guessed when that lookup is ambiguous: starting a pre-release pass on
    // the wrong client's repository is not a recoverable mistake.
    //
    // The webhook's "Include Sibling Task Details" option puts the task to
    // report against in `target`, so the run knows where to post its findings.
    if (p === "/api/webhook/pre-release" && req.method === "POST") {
      // Optional shared secret. Off by default so this matches the TED webhook
      // that already exists — but worth setting, because unlike that one (which
      // only reads and posts a report) this endpoint can open and merge a pull
      // request against a client's repository.
      const secret = (process.env.PRE_RELEASE_WEBHOOK_SECRET || "").trim();
      if (secret && (req.headers["x-webhook-secret"] || "") !== secret) return json(res, 401, { error: "bad webhook secret" });
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      // Shape confirmed by the mockup.create webhook already in production:
      //   { event, trigger: { clientName, templateKey, status }, target: { id, templateKey } }
      const trig = body.trigger || {}, tgt = body.target || {};
      const dig = (...keys) => {
        for (const k of keys) {
          for (const src of [trig, body, tgt, body.task, body.data]) {
            const v = src && src[k];
            if (v != null && String(v).trim()) return String(v).trim();
          }
        }
        return "";
      };
      const clientName = dig("clientName", "client_name", "client", "customerName", "businessName");
      const templateKey = dig("templateKey", "template_key", "taskTemplateKey");
      const status = dig("status", "taskStatus", "newStatus");
      const targetTask = tgt.id || tgt.taskId || dig("targetTaskId", "id");
      if (!clientName) {
        console.warn("pre-release webhook: no client name. payload:", JSON.stringify(body).slice(0, 1200));
        return json(res, 422, { error: "no client name in payload", seen: Object.keys(body), hint: "expected trigger.clientName" });
      }
      // TED's UI offers "All Events", which would fire this on every comment and
      // edit. Default to the pre-release template key so a mis-set webhook cannot
      // start a merge on unrelated activity; override per deployment if it moves.
      const wantKey = (process.env.TED_PERFORM_PR_KEY || "beta_site.release_approval").trim();
      const wantStatus = (process.env.TED_PERFORM_PR_STATUS || "").trim();
      if (wantKey && wantKey !== "*" && templateKey && templateKey !== wantKey) {
        return json(res, 200, { ignored: true, reason: `template key ${templateKey} is not ${wantKey}` });
      }
      if (wantStatus && status && status.toLowerCase() !== wantStatus.toLowerCase()) {
        return json(res, 200, { ignored: true, reason: `status ${status} is not ${wantStatus}` });
      }

      let sites; try { sites = await getWebsites(true); } catch (e) { return json(res, 502, { error: "NocoDB lookup failed: " + e.message }); }
      const norm = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      const want = norm(clientName);
      const exact = sites.filter((s) => norm(s.businessName) === want);
      const loose = exact.length ? exact : sites.filter((s) => norm(s.businessName).includes(want) || want.includes(norm(s.businessName)));
      if (loose.length !== 1) {
        return json(res, 409, {
          error: loose.length ? `"${clientName}" matches ${loose.length} sites` : `no NocoDB site matches "${clientName}"`,
          candidates: loose.map((s) => s.businessName).slice(0, 5),
        });
      }
      const site = loose[0];
      if (!site.githubRepo) return json(res, 409, { error: site.businessName + " has no repository set in NocoDB" });
      if (!site.liveUrl) return json(res, 409, { error: site.businessName + " has no Domain set in NocoDB" });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      const running = [...JOBS.values()].find((j) => j.type === "perform-pr"
        && (j.status === "queued" || j.status === "running") && j.payload && j.payload.siteId === site.siteId);
      if (running) return json(res, 202, { jobId: running.draftId, dedupe: true, site: site.businessName });
      const job = enqueuePerformPrJob({
        jobId: "perform-pr-" + Date.now(), siteId: site.siteId,
        businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath,
        muPath: target.muPath, liveUrl: site.liveUrl,
        existingSiteUrl: site.existingSiteUrl || "",
        // Where the report goes when the run finishes.
        tedTaskId: targetTask || dig("id", "taskId") || "",
      });
      return json(res, 202, { jobId: job.draftId, site: site.businessName, tedTaskId: job.payload.tedTaskId || null });
    }

    // ---- content review -----------------------------------------------------
    // Mint a review link for one person on one site. Under /api/ rather than
    // /api/webhook/, so it sits behind the admin key: creating a session is the
    // one privileged act in this whole feature, and everything downstream — who
    // the reviewer is, which site they may touch — is decided here and then
    // carried in the token's signature.
    if (p === "/api/review/mint" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      const reviewer = String(body.reviewer || "").trim();
      if (!reviewer) return json(res, 400, { error: "reviewer name required — it is shown in the widget and recorded on the change" });
      try {
        const { site, target } = await resolveReviewSite(body.site || body.siteId || body.businessName);
        const { token, exp } = mintReviewToken({
          siteId: site.siteId, themeSlug: target.themeSlug, reviewer,
          email: body.email, dept: body.dept || "Content", minutes: body.minutes,
        });
        if (!/^https?:\/\//i.test(site.liveUrl || "")) throw new Error(`${site.businessName} has no beta site URL in NocoDB — there is nowhere to send the reviewer`);
        const link = new URL(site.liveUrl);
        link.searchParams.set("g99r", token);
        return json(res, 200, {
          ok: true, url: link.toString(), expiresAt: new Date(exp).toISOString(),
          siteId: site.siteId, businessName: site.businessName, themeSlug: target.themeSlug, reviewer,
        });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    // Put the review plugin into a site's repository (PR only — a file that runs
    // on every request of a client site gets looked at once by a person).
    if (p === "/api/review/install" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      try {
        const { site } = await resolveReviewSite(body.site || body.siteId || body.businessName);
        const out = await installReviewPlugin(site, G99_TOOL_PUBLIC_URL);
        return json(res, 200, { ...out, businessName: site.businessName, repo: site.githubRepo, path: REVIEW_PLUGIN_PATH });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    // Called by the beta site, server-side, to redeem a link. Outside the admin
    // gate because the token IS the credential. Answers only what the widget has
    // to render — never the email, the site's repository or anything else.
    if (p === "/api/webhook/review/verify") {
      const d = verifyReviewToken(u.searchParams.get("t"));
      if (!d) return json(res, 200, { ok: false });
      return json(res, 200, { ok: true, reviewer: d.reviewer, siteId: d.siteId, themeSlug: d.themeSlug, exp: d.exp });
    }

    // A batch of exact text corrections from the widget, forwarded by the site.
    if (p === "/api/webhook/review/feedback" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      const d = verifyReviewToken(body.token);
      if (!d) return json(res, 401, { ok: false, error: "this review session has expired — ask for a fresh link" });

      // Several beta sites share one WordPress install and differ only by which
      // theme is active. Without this check a session minted for one client
      // could write corrections into another client's theme — silently, because
      // the text would match there too.
      const active = String(body.activeTheme || "").trim();
      if (!active || active !== d.themeSlug) {
        console.warn(`review: refused a batch for ${d.siteId} — session theme ${d.themeSlug}, site is serving ${active || "nothing"}`);
        return json(res, 409, { ok: false, error: "this site is not serving the theme this review link was made for" });
      }

      const changes = (Array.isArray(body.changes) ? body.changes : [])
        .map((c) => ({ original: String((c && c.original) || ""), replacement: String((c && c.replacement) || "") }))
        .filter((c) => c.original && c.replacement && c.original !== c.replacement)
        .slice(0, 40);
      if (!changes.length) return json(res, 400, { ok: false, error: "no usable changes in this batch" });

      const sig = reviewSig(body.token);
      const inFlight = [...JOBS.values()].filter((j) => j.type === "edit" && j.payload
        && j.payload.reviewSig === sig && (j.status === "queued" || j.status === "running"));
      if (inFlight.length >= 3) return json(res, 429, { ok: false, error: "three of your batches are still being applied — give them a moment" });

      try {
        const localRoot0 = (process.env.REVIEW_LOCAL_REPO || "").trim();
        let site, target;
        if (localRoot0) {
          // A local run touches no repository, so it asks the network for
          // nothing: the token already names the site and the theme, and that
          // theme was just checked against the stylesheet the site is actually
          // serving. Anything else here would make a laptop rehearsal wait out a
          // 15s NocoDB timeout on every submission — which is exactly what made
          // WordPress give up at 20s and report "could not reach the build tool".
          ({ site, target } = reviewTargetFromToken(d));
          const cached = await getWebsites(false).catch(() => []);
          const known = cached.find((s) => s.siteId === d.siteId);
          if (known) site = { ...site, businessName: known.businessName, liveUrl: known.liveUrl || "" };
        } else if (String(process.env.REVIEW_LIVE || "").toLowerCase() !== "on") {
          // Publishing to a client repository is opt-in, explicitly. It used to be
          // the fallback whenever REVIEW_LOCAL_REPO was absent, which meant a
          // restart that forgot one variable silently turned a local rehearsal
          // into a pull request that auto-merged to a real site. It did exactly
          // that once. A missing setting must refuse, not ship.
          console.warn(`review: refused — neither REVIEW_LOCAL_REPO nor REVIEW_LIVE=on is set (${changes.length} correction(s) from ${d.reviewer} on ${pagePath})`);
          return json(res, 409, {
            ok: false,
            error: "this build tool is not set up to publish changes — nothing was applied. Ask an engineer to start it in local or live mode.",
          });
        } else {
          try {
            ({ site, target } = await resolveReviewSite(d.siteId));
          } catch (e) {
            console.warn("review: site lookup failed —", e.message);
            return json(res, 503, { ok: false, error: "could not reach the site directory just now — try again in a moment" });
          }
        }
        const pagePath = String(body.path || "/").slice(0, 200);
        const workOrder = reviewWorkOrder(changes, { reviewer: d.reviewer, pagePath });

        // Three modes, most cautious first:
        //   REVIEW_DRY_RUN=on with no local checkout — log the work order, do
        //     nothing, create no job. For proving the plumbing.
        //   REVIEW_LOCAL_REPO=<path> — a REAL job, visible in Activity, that
        //     writes into that checkout and touches no repository. This is the
        //     rehearsal worth doing: the job system, the guardrails and the
        //     result on the page are all genuine, only git is absent.
        //   neither — the live run: clone, PR, CI, auto-merge, deploy.
        const localRoot = (process.env.REVIEW_LOCAL_REPO || "").trim();
        if (!localRoot && String(process.env.REVIEW_DRY_RUN || "").toLowerCase() === "on") {
          console.log(`[review dry-run] ${site.businessName} ${pagePath} — ${changes.length} change(s) by ${d.reviewer}:\n`
            + workOrder.changes.map((c, i) => `  ${i + 1}. "${c.replaces}" -> "${c.literal}" (${c.variants.length} variant spellings)`).join("\n"));
          return json(res, 200, { ok: true, jobId: "dry-run-" + Date.now(), changes: changes.length, dryRun: true });
        }

        const job = enqueueEditJob({
          localApply: localRoot || null,
          jobId: "edit-" + Date.now(),
          siteId: site.siteId, businessName: site.businessName, githubRepo: site.githubRepo,
          themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
          // The prompt is only ever read by humans here — the PR body, Slack, the
          // job page. The work order is what the run actually acts on.
          prompt: `Content review by ${d.reviewer} on ${pagePath}:\n`
            + changes.map((c, i) => `${i + 1}. "${c.original}" → "${c.replacement}"`).join("\n"),
          workOrder,
          // Exact pairs on a beta site, applied in code with no model involved.
          // Holding these for approval would make the loop slower than the email
          // it replaces, for a change that cannot surprise us.
          forceApproval: false,
          source: "content-review", requestedBy: d.reviewer, reviewSig: sig,
          reviewPath: pagePath, liveUrl: site.liveUrl || "",
        });
        notify(`✍️ Content review — *${site.businessName}* · ${changes.length} correction(s) from ${d.reviewer} on ${pagePath}`);
        return json(res, 200, { ok: true, jobId: job.draftId, changes: changes.length });
      } catch (e) {
        console.warn("review feedback failed:", e.message);
        return json(res, 500, { ok: false, error: "the change could not be queued" });
      }
    }

    // Progress for the widget, scoped to the session that created the job.
    if (p === "/api/webhook/review/status") {
      const d = verifyReviewToken(u.searchParams.get("t"));
      if (!d) return json(res, 401, { ok: false, error: "expired" });
      // A dry run has no job to report on, and leaving the widget spinning on
      // "Applying…" for a change that will never be applied is a lie the person
      // reviewing has no way to see through.
      const wanted = String(u.searchParams.get("job") || "");
      if (/^dry-run-/.test(wanted)) return json(res, 200, { ok: true, status: "done", dryRun: true });
      const job = JOBS.get(wanted);
      if (!job || !job.payload || job.payload.reviewSig !== reviewSig(u.searchParams.get("t"))) {
        return json(res, 404, { ok: false, error: "unknown job" });
      }
      return json(res, 200, {
        ok: true, status: job.status,
        error: job.status === "error" ? String(job.error || "").slice(0, 200) : "",
        // What the run declined to do and why. Without this the reviewer is told
        // "live" while one of their corrections was quietly dropped.
        refused: (job.reviewRefused || []).map((r) => r.reason),
      });
    }

    // A subtask created by hand in TED, under a client's revision-cycle task,
    // with a comment on it → the same edit job an email would have started.
    // Sits outside the admin-key gate and carries its own optional secret, like
    // the other TED webhooks.
    //
    // Deliberately tolerant about where the task id sits in the payload: TED's
    // comment and task events do not share a shape, and the id is the only
    // field this needs. Everything that decides whether to run — the parent's
    // template key, the client, whether it is one of ours — is read back from
    // TED rather than trusted from the payload.
    if (p === "/api/webhook/ted-subtask" && req.method === "POST") {
      const secret = (process.env.TED_SUBTASK_WEBHOOK_SECRET || "").trim();
      if (secret && (req.headers["x-webhook-secret"] || "") !== secret) return json(res, 401, { error: "bad webhook secret" });
      let body = {};
      try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
      // TED wraps task events as { event, timestamp, source, data, subscriptionId }
      // — the task rides in `data`, which is where the id actually lives. The
      // flatter shapes are kept behind it because the pre-release webhook sends
      // trigger/target instead, and a test delivery sends neither.
      const dat = body.data || {}, tgt = body.target || {}, trig = body.trigger || {};
      const taskId = String(
        body.taskId || dat.taskId || dat.id || (dat.task && (dat.task.id || dat.task.taskId))
        || (dat.comment && dat.comment.taskId) || tgt.taskId || tgt.id || trig.taskId || trig.id
        || (body.task && body.task.id) || (body.comment && body.comment.taskId) || body.id || ""
      ).trim();
      if (!taskId) {
        console.warn("ted-subtask webhook: no task id. payload:", JSON.stringify(body).slice(0, 1200));
        // Report the nested keys too. The top-level ones alone said only that
        // everything lives under `data`, which cost a round of testing to learn.
        return json(res, 422, {
          error: "no task id in payload",
          seen: Object.keys(body),
          dataKeys: dat && typeof dat === "object" ? Object.keys(dat) : null,
          hint: "expected the task id at data.id, data.taskId or data.task.id",
        });
      }
      let r;
      // Most events on a TED board are not a revision request, so a refusal is a
      // normal outcome: 200, and TED stops resending. A TED failure is not — it
      // answers 502 so the event is retried instead of vanishing, which is the
      // difference between "not for us" and "we never saw it".
      try { r = await tedResolveSubtaskRequest(taskId); }
      catch (e) {
        if (e && e.ignore) return json(res, 200, { ignored: true, taskId, reason: e.message });
        // TED answers a deleted task exactly as it answers an outage — 200 with
        // the Angular shell — so the response cannot tell them apart. One cheap
        // probe of a known-good route can: if the rest of TED is answering, the
        // task itself is gone, and a 502 would have TED retrying an event about
        // a task that no longer exists until someone noticed.
        const alive = await tedFetchJson("/api/me").then(() => true).catch(() => false);
        if (alive) {
          console.warn(`ted-subtask webhook: task ${taskId} is unreadable but TED is up — treating it as gone`);
          return json(res, 200, { ignored: true, taskId, reason: `task ${taskId} could not be read (deleted, or not visible to this token)` });
        }
        console.warn(`ted-subtask webhook: TED unreachable while reading task ${taskId}:`, e.message);
        return json(res, 502, { error: `TED lookup failed for task ${taskId}: ${e.message}` });
      }

      // From here the webhook and the poller share one path, so a request that
      // arrives both ways cannot be treated two different ways.
      let out;
      try { out = await startTedSubtaskRun(taskId, { dryRun: !!body.dryRun }); }
      catch (e) { return json(res, 409, { error: `could not start a run for ${taskId}: ${e.message}` }); }
      if (out.dedupe) return json(res, 202, { jobId: out.jobId, dedupe: true, taskId });
      if (out.dryRun) return json(res, 200, { accepted: true, ...out });
      return json(res, 202, { accepted: true, jobId: out.jobId, taskId, businessName: out.businessName });
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
      // The email named the site; TED gets the last word on which repository and
      // beta URL that site actually has, whenever it has a usable answer. An
      // email carries no client id, so the match itself still comes from the
      // NocoDB list above — only the fields are preferred from TED.
      const site = await withTedFields(hit.site, "").catch(() => hit.site);
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
      // File it in TED for the delivery team. Only accepted requests reach this
      // line — every decline returned above, and so did the dry run.
      //
      // Its own subtask under this client's revision-cycle task, so requests do
      // not pile onto one shared task. The id goes onto the job payload, which
      // is how tedPostOutcome finds its way back to this same subtask when the
      // change ships — minutes later, from a different call stack.
      const requestText = tedRequestComment({ site, addr, subject, instruction, jobId: job.draftId });
      // The suffix marks this as ours so the manual-subtask webhook ignores the
      // comment posted below — otherwise this request would re-trigger itself.
      const subtaskId = await tedCreateSubtask({
        businessName: site.businessName,
        title: (await tedSubtaskTitle(subject, instruction)).slice(0, 100).trim() + " " + TED_EMAIL_SUFFIX,
        description: requestText,
      });
      if (subtaskId) {
        job.payload.tedSubtaskId = subtaskId;
        saveJobs();
      }
      // The description already carries the request; this makes the subtask
      // behave like every other TED thread, where the discussion is in comments.
      tedComment(requestText, null, 0, subtaskId);
      // Echoing the parsed instruction back is the cheapest guard against a
      // misread: the sender sees what will actually be done before it ships.
      // The first message the requester gets. Deliberately short: they wrote
      // the request, so quoting it back adds nothing. Normally followed by one
      // more ("live now") on this same thread; a run that leaves anything
      // unresolved also sends a separate clarification email (see
      // queueClarificationEmail) rather than burying that in this thread.
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

    // Re-send this job's status to G99. The audit above can now show a failed callback; without
    // this there is nothing to do about one — the build has finished, so no further step transition
    // will ever fire another attempt, and the event TED needs would stay missing forever.
    // Same snapshot, same idempotent receiver, so pressing it twice is harmless.
    if (p === "/api/job-emit-resend" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id);
      if (!j) return json(res, 404, { error: "job not found" });
      if (j.type !== "build") return json(res, 400, { error: "only build jobs report status to G99" });
      postStatus(j);   // fire-and-forget; poll /api/job to watch job.emit settle
      return json(res, 202, { ok: true, emit: j.emit || null });
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
        : j.type === "seo" ? enqueueSeoJob({ ...j.payload, jobId: "seo-" + Date.now() })
        : j.type === "pre-release" ? enqueuePreReleaseJob({ ...j.payload, jobId: "pre-release-" + Date.now() })
        : j.type === "perform-pr" ? enqueuePerformPrJob({ ...j.payload, jobId: "perform-pr-" + Date.now() })
        : enqueueJob(j.payload).job;
      return json(res, 202, { ok: true, jobId: nj.draftId });
    }
    // Retry JUST the "Theme activation watch" step (and everything after it —
    // CRO after-audit, auto-enrich) on a build job, in place, instead of re-running
    // Stitch/PR/CI. Only makes sense once the PR is already merged (job.themeSlug set).
    if (p === "/api/job-retry-step" && req.method === "POST") {
      const { id, step } = JSON.parse(await readBody(req) || "{}");
      if (step !== "theme_activation_watch") return json(res, 400, { error: "only the theme_activation_watch step supports a scoped retry right now" });
      const j = JOBS.get(String(id)); if (!j) return json(res, 404, { error: "job not found" });
      if (j.type !== "build") return json(res, 400, { error: "only a build job's theme-activation step can be retried this way" });
      if (!j.themeSlug) return json(res, 400, { error: "job has no recorded theme slug — pre-dates this feature, or failed before the WordPress theme + PR step" });
      if (!j.liveUrl) return json(res, 400, { error: "job has no recorded live URL" });
      if (JOB_RUNNING) return json(res, 409, { error: "another build is currently running — try again once it finishes" });
      retryThemeActivationTail(id).catch((e) => console.error("retryThemeActivationTail:", e.message));
      return json(res, 202, { ok: true });
    }
    // Approve a job that's paused awaiting human sign-off (per-site approval).
    if (p === "/api/job-approve" && req.method === "POST") {
      const { id } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id); if (!j) return json(res, 404, { error: "job not found" });
      j.approved = true; saveJobs();
      return json(res, 200, { ok: true });
    }
    // Patch editable fields on a job record: repo, liveUrl, existingWebsite, and answers array.
    if (p === "/api/job-update" && req.method === "POST") {
      const { id, repo, liveUrl, existingWebsite, answers, stitchKeyOverride, andRerun } = JSON.parse(await readBody(req) || "{}");
      const j = JOBS.get(id); if (!j) return json(res, 404, { error: "job not found" });
      j.payload = j.payload || {};
      // j.repo/j.liveUrl are the CURRENT run's own display fields — but a retry re-enqueues
      // j.payload wholesale (newJob() reads payload.betaSiteRepo/betaSiteUrl), so without also
      // writing here, an edited repo/URL is silently dropped the moment "Run again" fires and
      // the retry quietly rebuilds against the OLD target instead.
      if (repo !== undefined) { j.repo = repo || null; j.payload.betaSiteRepo = repo || null; }
      if (liveUrl !== undefined) { j.liveUrl = liveUrl || null; j.payload.betaSiteUrl = liveUrl || null; }
      if (existingWebsite !== undefined) j.payload.existingWebsite = existingWebsite || null;
      if (answers !== undefined) j.payload.answers = answers;
      if (stitchKeyOverride !== undefined) j.payload.stitchKeyOverride = stitchKeyOverride || null;
      saveJobs();
      if (!andRerun) return json(res, 200, { ok: true });
      if (j.type !== "build") return json(res, 400, { error: "only a build job's data can be saved-and-rerun this way" });
      const nj = enqueueJob(j.payload).job;
      return json(res, 202, { ok: true, jobId: nj.draftId });
    }
    // Return Stitch key list for the admin key-picker UI (admin-only route).
    if (p === "/api/stitch-keys" && req.method === "GET") {
      const keys = STITCH_KEYS.map((k, i) => ({ index: i, label: `Key ${i + 1}`, masked: k.slice(0, 10) + "…" + k.slice(-4), key: k }));
      return json(res, 200, { keys });
    }
    // Validate a Stitch API key by sending a lightweight tools/list MCP call.
    if (p === "/api/stitch-key-validate" && req.method === "POST") {
      const { key } = JSON.parse(await readBody(req) || "{}");
      if (!key) return json(res, 400, { error: "key required" });
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 15000);
        let vRes;
        try {
          vRes = await fetch(MCP_URL, {
            method: "POST", signal: ac.signal,
            headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "X-Goog-Api-Key": key, "MCP-Protocol-Version": PROTO },
            body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
          });
        } finally { clearTimeout(to); }
        if (vRes.status === 401 || vRes.status === 403) return json(res, 200, { valid: false, error: `HTTP ${vRes.status}` });
        return json(res, 200, { valid: vRes.ok });
      } catch (e) { return json(res, 200, { valid: false, error: e.message }); }
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
    // Page-coverage report: every page the client's current site publishes, grouped
    // by section, matched against what the beta site has. ?demo=1 uses ruma.com with
    // a SIMULATED built set so the report can be reviewed without running a build.
    if (p === "/api/site-inventory") {
        const siteIdParam = u.searchParams.get("siteId") || "";
        const demo = u.searchParams.get("demo") === "1" && !siteIdParam;
        let siteUrl = u.searchParams.get("url") || "";
        let built = [];
        let builtSource = "";
        if (demo || (!siteUrl && !siteIdParam)) {
          siteUrl = siteUrl || "https://ruma.com";
          // What a finished beta build produces today: 4 base pages + a services hub,
          // up to 10 revenue-first treatment pages, and the brand guide.
          built = [
            { slug: "", path: "/" }, { slug: "services" }, { slug: "about" }, { slug: "contact" },
            { slug: "brand-guide" },
            { slug: "botox" }, { slug: "dermal-fillers" }, { slug: "sculptra" },
            { slug: "microneedling" }, { slug: "laser-hair-removal" },
            { slug: "medical-weight-loss" }, { slug: "hormone-therapy" },
          ];
          builtSource = "simulated (no build run)";
        } else {
          // Real mode. A siteId resolves BOTH sides from this site's own runs: the
          // client's current website (from the build payload) and the pages actually
          // built (from its newest enrich run).
          const siteId = u.searchParams.get("siteId") || "";
          const runs = [...JOBS.values()].sort((a, b) =>
            (b.finishedAt || b.createdAt || "").localeCompare(a.finishedAt || a.createdAt || ""));
          const mine = siteId ? runs.filter((j) => j.payload && j.payload.siteId === siteId) : runs;
          const e = mine.find((j) => j.type === "enrich" && j.servicePages);
          if (!siteUrl) {
            const b = runs.find((j) => j.payload && j.payload.existingWebsite
              && (!siteId || j.payload.siteId === siteId || (e && j.businessName === e.businessName)));
            siteUrl = (b && b.payload.existingWebsite) || "";
          }
          if (!siteUrl) return json(res, 400, { error: "No current-website URL known for this site — pass ?url=… or run a build first." });
          built = [{ slug: "", path: "/" }, { slug: "services" }, { slug: "about" }, { slug: "contact" }, { slug: "brand-guide" }]
            .concat(((e && e.servicePages) || []).map((s) => ({ slug: s.slug })));
          builtSource = e ? `from run ${e.draftId} (${e.servicePages.length} service pages)` : "base pages only (no enrich run yet)";
        }
        try {
          const inv = await crawlSiteInventory(siteUrl);
          const cov = buildCoverage(inv, built);
          // The queue the batched builder will work through, derived from the same
          // coverage pass so the table and the worker can never disagree.
          const plan = buildPagePlan(cov);
          cachePlan(inv.origin, plan);
          return json(res, 200, {
            site: inv.origin, discoveredVia: inv.discoveredVia, sitemaps: inv.sitemaps,
            builtSource, builtCount: built.length, ...cov,
            plan, planTotals: planTotals(plan), batchSize: BATCH_SIZE,
            nextBatch: nextBatch(plan).map((r) => r.slug || "home"),
            checkedAt: new Date().toISOString(),
          });
        } catch (e) { return json(res, 502, { error: e.message }); }
    }
    // Build a chosen set of pages. Two-phase on purpose: without `confirm` this only
    // validates and quotes, so the UI can show the Stitch/clone split and the spend before
    // anything is generated. Slugs are checked against the server's own plan — a browser
    // must not be able to name arbitrary pages to build.
    if (p === "/api/build-pages" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const want = [...new Set((body.slugs || []).map((s) => String(s)))];
      if (!want.length) return json(res, 400, { error: "no pages selected" });

      let plan = body.site ? cachedPlan(body.site) : null;
      if (!plan) {
        // Cache expired (or a fresh tab) — re-derive rather than trust the client's rows.
        if (!body.site) return json(res, 400, { error: "missing site — reload the coverage page" });
        try {
          const inv = await crawlSiteInventory(body.site);
          plan = buildPagePlan(buildCoverage(inv, body.built || []));
          cachePlan(inv.origin, plan);
        } catch (e) { return json(res, 502, { error: "could not re-read the site: " + e.message }); }
      }

      const byKey = new Map(plan.map((r) => [r.slug || "home", r]));
      const rows = [], unknown = [], alreadyBuilt = [];
      for (const key of want) {
        const row = byKey.get(key);
        if (!row) { unknown.push(key); continue; }
        if (row.status === "built" && !body.rebuild) { alreadyBuilt.push(key); continue; }
        rows.push(row);
      }
      if (!rows.length) {
        return json(res, 400, {
          error: alreadyBuilt.length ? "every selected page is already built — use Rebuild to regenerate"
            : "none of the selected pages are in the plan",
          unknown, alreadyBuilt,
        });
      }

      const estimate = estimateBuild(rows);
      const batches = [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        batches.push(rows.slice(i, i + BATCH_SIZE).map((r) => r.slug || "home"));
      }
      const quote = {
        site: body.site, estimate, batches, batchSize: BATCH_SIZE,
        pages: rows.map((r) => ({
          slug: r.slug || "home", title: r.title, section: r.sectionLabel || r.section,
          engine: r.engine, status: r.status, sources: (r.sourcePaths || []).length,
        })),
        unknown, alreadyBuilt,
      };
      if (!body.confirm) return json(res, 200, { ...quote, queued: false });

      // Task 4 owns the worker. Refusing loudly beats enqueueing a job type nothing can run.
      return json(res, 501, {
        ...quote, queued: false,
        error: "The batched page builder isn't wired up yet — the selection and quote above are what it will receive.",
      });
    }

    // Credentials smoke test. Deliberately NOT in the nav — it pushes a real branch and opens a
    // real PR, so it is reached by URL when you are actually testing GitHub access.
    if (p === "/pr-smoke" || p === "/pr-smoke.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "pr-smoke.html")));
    if (p === "/pr-smoke.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "pr-smoke.js")));
    // Which GitHub credentials this deployment actually has, and whether the App is enough.
    if (p === "/api/gh-auth") {
      // Capabilities are probed once at boot. When permissions are granted on GitHub mid-run,
      // ?refresh=1 re-probes instead of forcing a restart (which would kill a running build).
      if (u.searchParams.get("refresh") === "1") GH_APP_CAPS = null;
      const caps = await ghAppCaps();
      const pat = !!process.env.GH_TOKEN;
      const full = caps.pulls && caps.checks;
      return json(res, 200, {
        appConfigured: GH_APP_CONFIGURED,
        appUsable: caps.pulls,
        canOpenPrs: caps.pulls,
        canReadChecks: caps.checks,
        patConfigured: pat,
        patStillNeeded: !full,
        installationId: GH_APP_INSTALLATION_ID || null,
        mode: full ? "GitHub App (PAT not needed)"
          : caps.pulls ? "GitHub App — PAT only for CI status"
            : (pat ? (GH_APP_CONFIGURED ? "PAT (App cannot open PRs)" : "PAT only") : "no credentials"),
        warning: full ? ""
          : caps.pulls
            ? 'Push, PR and merge run as the App. Grant "Checks: Read-only" and "Commit statuses: Read-only" (then accept the update on the organisation) and GH_TOKEN can be removed.'
            : GH_APP_CONFIGURED
              ? 'The App cannot open PRs — grant "Pull requests: Read and write" and accept the update on the organisation.'
              : "No GitHub App configured — everything runs on the personal access token.",
      });
    }
    if (p === "/api/pr-smoke" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const mode = ["app", "pat", "auto"].includes(body.mode) ? body.mode : "auto";
      return json(res, 200, await runPrSmoke(mode, body.repo, body.base));
    }

    if (p === "/clients" || p === "/clients.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "clients.html")));
    if (p === "/clients.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "clients.js")));
    if (p === "/coverage" || p === "/coverage.html") return send(res, 200, "text/html", fs.readFileSync(path.join(DIR, "public", "coverage.html")));
    if (p === "/coverage.js") return send(res, 200, "text/javascript", fs.readFileSync(path.join(DIR, "public", "coverage.js")));

    // The durable client pool: every onboarding that reached this tool, with its page
    // progress. Read from NocoDB (survives redeploys), then overlaid with any job still
    // live in memory so an in-flight build shows its true current step, not the last
    // coalesced write.
    if (p === "/api/pool") {
      let rows = [];
      let poolError = null;
      try { rows = await poolList(); } catch (e) { poolError = e.message; }
      const bySite = new Map(rows.map((r) => [String(r.siteKey), r]));
      // In-memory jobs are newer than the last coalesced write, so they win — but only the
      // most recent job per site, since the row represents the client, not the run.
      const newest = new Map();
      for (const job of JOBS.values()) {
        if (!POOL_TYPES.has(job.type) || !job.draftId) continue;
        const key = poolSiteKey(job);
        const at = job.receivedAt || job.createdAt || "";
        const cur = newest.get(key);
        if (!cur || String(at) >= String(cur.receivedAt || cur.createdAt || "")) newest.set(key, job);
      }
      for (const [key, job] of newest) {
        const live = poolRow(job);
        const mapped = {
          siteKey: key, draftId: live["Draft key"], client: live.Client, betaSite: live["Beta site"],
          repo: live.Repo, theme: live.Theme, status: live.Status, step: live.Step,
          existingPages: live["Existing pages"], pagesPlanned: live["Pages planned"],
          pagesBuilt: live["Pages built"], pagesPending: live["Pages pending"],
          coveragePct: live["Coverage pct"], prUrl: live["Last PR"], receivedAt: live["Received at"],
          finishedAt: live["Finished at"], jobLink: live["Job link"], error: live.Error, live: true,
        };
        const prev = bySite.get(key);
        if (!prev) { bySite.set(key, mapped); continue; }
        // Merge only the fields the live job actually knows. An enrich job carries no repo of
        // its own, and blindly spreading its nulls would blank out details the stored row has.
        const merged = { ...prev };
        for (const [k, v] of Object.entries(mapped)) if (v != null) merged[k] = v;
        bySite.set(key, merged);
      }
      const all = [...bySite.values()].sort((a, b) =>
        String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
      const totals = {
        clients: all.length,
        done: all.filter((r) => r.status === "done").length,
        running: all.filter((r) => ["running", "queued"].includes(r.status)).length,
        failed: all.filter((r) => r.status === "error").length,
        pagesBuilt: all.reduce((n, r) => n + (r.pagesBuilt || 0), 0),
        pagesPending: all.reduce((n, r) => n + (r.pagesPending || 0), 0),
      };
      return json(res, 200, { rows: all, totals, poolError, storedIn: poolError ? "memory only" : "NocoDB" });
    }

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
        .map(pr => ({ number: pr.number, title: pr.title, url: pr.url, state: pr.state, type: (pr.headRefName || "").includes("/pre-release-") ? "pre-release" : (pr.headRefName || "").includes("/edit-") ? "edit" : (pr.headRefName || "").includes("/restore-") ? "restore" : "build", date: pr.mergedAt || pr.createdAt, build: ciRollup(pr.statusCheckRollup) }))
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
      const body0 = JSON.parse(await readBody(req) || "{}");
      const { siteId } = body0;
      // Offline dry run: point straight at a theme folder on disk. No NocoDB,
      // no clone, no network beyond the AI calls — for iterating on the engine.
      if (body0.dryRun && body0.themeDir) {
        const slug = body0.themeSlug || path.basename(path.resolve(body0.themeDir));
        const job = enqueueSeoJob({
          jobId: "seo-dry-" + Date.now(), dryRun: true, themeDir: body0.themeDir,
          siteId: body0.siteId || slug, businessName: body0.businessName || slug,
          githubRepo: WP_REPO, themeSlug: slug,
          themePath: "web/app/themes/" + slug,
          muPath: "web/app/mu-plugins/g99-activate-" + slug.replace(/^g99-/, "") + ".php",
          liveUrl: body0.liveUrl || "",
        });
        return json(res, 202, { jobId: job.draftId, dryRun: true, monitor: "/jobs" });
      }
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId — refresh the site list" });
      if (!site.githubRepo) return json(res, 409, { error: `${site.businessName} has no repository set in NocoDB` });
      let target; try { target = await resolveEditTarget(site); } catch (e) { return json(res, 409, { error: e.message }); }
      const running = [...JOBS.values()].find((j) => j.type === "seo" && (j.status === "queued" || j.status === "running") && j.payload && j.payload.siteId === site.siteId);
      if (running) return json(res, 202, { jobId: running.draftId, dedupe: true, monitor: "/jobs" });
      const job = enqueueSeoJob({
        jobId: (body0.dryRun ? "seo-dry-" : "seo-") + Date.now(), dryRun: !!body0.dryRun,
        siteId: site.siteId, businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath, muPath: target.muPath,
        liveUrl: site.liveUrl || "",
      });
      return json(res, 202, { jobId: job.draftId, dryRun: !!body0.dryRun, monitor: "/jobs" });
    }

    // Extensible pre-release run. Current task: mobile responsiveness across
    // every page registered by the active backend theme.
    if (p === "/api/pre-release-run" && req.method === "POST") {
      const { siteId } = JSON.parse(await readBody(req) || "{}");
      if (!BROWSERLESS_TOKEN) return json(res, 409, { error: "BROWSERLESS_TOKEN is not configured - add it to .env and restart the server" });
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId - refresh the site list" });
      if (!site.githubRepo) return json(res, 409, { error: site.businessName + " has no repository set in NocoDB" });
      if (!site.liveUrl) return json(res, 409, { error: site.businessName + " has no Domain set in NocoDB" });
      let target;
      try { target = await resolveEditTarget(site); }
      catch (e) { return json(res, 409, { error: e.message }); }
      const running = [...JOBS.values()].find((j) => j.type === "pre-release"
        && (j.status === "queued" || j.status === "running")
        && j.payload && j.payload.siteId === site.siteId);
      if (running) return json(res, 202, { jobId: running.draftId, dedupe: true, monitor: "/jobs" });
      const job = enqueuePreReleaseJob({
        jobId: "pre-release-" + Date.now(), siteId: site.siteId,
        businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath,
        muPath: target.muPath, liveUrl: site.liveUrl,
      });
      return json(res, 202, { jobId: job.draftId, monitor: "/jobs" });
    }
    // Perform PR — the pre-release gate for everything except mobile
    // responsiveness (that is /api/pre-release-run until the two are merged).
    // No Browserless dependency: every check here is HTTP + source reading.
    if (p === "/api/perform-pr-run" && req.method === "POST") {
      const { siteId } = JSON.parse(await readBody(req) || "{}");
      const site = await findWebsite(siteId);
      if (!site) return json(res, 404, { error: "unknown siteId - refresh the site list" });
      if (!site.githubRepo) return json(res, 409, { error: site.businessName + " has no repository set in NocoDB" });
      if (!site.liveUrl) return json(res, 409, { error: site.businessName + " has no Domain set in NocoDB" });
      let target;
      try { target = await resolveEditTarget(site); }
      catch (e) { return json(res, 409, { error: e.message }); }
      const running = [...JOBS.values()].find((j) => j.type === "perform-pr"
        && (j.status === "queued" || j.status === "running")
        && j.payload && j.payload.siteId === site.siteId);
      if (running) return json(res, 202, { jobId: running.draftId, dedupe: true, monitor: "/jobs" });
      const job = enqueuePerformPrJob({
        jobId: "perform-pr-" + Date.now(), siteId: site.siteId,
        businessName: site.businessName, githubRepo: site.githubRepo,
        themeSlug: target.themeSlug, themePath: target.themePath,
        muPath: target.muPath, liveUrl: site.liveUrl,
        existingSiteUrl: site.existingSiteUrl || "",
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
          // githubRepo overridable: WP_REPO is a single shared default, so without this an ops re-run
          // of ONE client's enrichment opens a PR on whatever site WP_REPO happens to point at —
          // a different client's repo. Naming the repo keeps a re-run on its own site.
          githubRepo: body0.githubRepo || WP_REPO,
          themeSlug, themePath: "web/app/themes/" + themeSlug,
          muPath: "web/app/mu-plugins/g99-activate-" + themeSlug.replace(/^g99-/, "") + ".php",
          answers, composed, referenceWebsite: body0.referenceWebsite || "",
          existingWebsite: body0.existingWebsite || "",
          // Needed to screenshot the right site: captureMockups reads job.liveUrl first, and
          // without it the run falls back to the LIVE_URL env default.
          liveUrl: body0.liveUrl || "",
          // Opt in to mirroring the outcome back to a parent build (and therefore to G99/TED).
          // Absent by default, so an ops re-run stays local unless it explicitly asks to report.
          parentDraftId: body0.parentDraftId || null,
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
      // A brand the client explicitly CONFIRMED beats anything we can infer. G99 detects their existing
      // site's palette and type, shows it on step 10, and the client says yes — so there is nothing left
      // to guess. Only the fields they confirmed are pinned; the brief/imagery are still composed below,
      // and a client who chose "use a different reference site" sends no brand at all, which falls
      // straight through to the original derivation path.
      const confirmed = body.brand || onb.confirmedBrand || null;
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
          ? (siteBrand.headingFont
              ? `\n== TYPOGRAPHY RULE ==\nThat site really uses: ${siteBrand.fonts.slice(0, 4).join(", ")}. Set "headingFont" and "bodyFont" to those EXACT families (heading = the display/serif one, body = the clean sans one) so the new site stays typographically continuous with the brand. Substitute only if a family isn't on Google Fonts — then pick the closest Google equivalent with the same character.`
              // Only one of the site's fonts survived Google-Fonts verification (its
              // real heading/display face is a custom/self-hosted font — confirmed
              // on ruma.com's "Editor Note", which 404s on Google Fonts). Do NOT
              // reuse the one verified font for both roles — that collapses the
              // type system to a single flat weight. Ask for a real pairing instead.
              : `\n== TYPOGRAPHY RULE ==\nThat site's one VERIFIED, Google-Fonts-loadable font is "${siteBrand.bodyFont}" — set "bodyFont" to it exactly. Its real heading/display font is a custom or self-hosted face not available on Google Fonts, so it cannot be reused. Choose your OWN distinctive Google Fonts DISPLAY/serif family for "headingFont" that pairs well with ${siteBrand.bodyFont} and fits a luxury medical-aesthetics brand — heading and body must be two DIFFERENT families, never the same one twice.`)
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
        // Last word goes to the client. Everything above is inference — a screenshot read, a font scan,
        // a model's taste — and all of it is overridden by tokens the client looked at and approved.
        // Applied per-field so a partial confirmation (say colours but no readable fonts) still keeps
        // the composed value for whatever they didn't confirm.
        if (confirmed) {
          const pin = (dst, src) => { if (confirmed[src]) { obj[dst + "ModelPick"] = obj[dst]; obj[dst] = confirmed[src]; } };
          pin("primary", "primaryColor");
          pin("secondary", "secondaryColor");
          pin("accent", "accentColor");
          pin("headingFont", "headingFont");
          pin("bodyFont", "bodyFont");
          obj.brandSource = confirmed.source || "existing-site-confirmed";
          obj.brandSourceUrl = confirmed.sourceUrl || onb.existingWebsite || "";
          if (confirmed.headingFont || confirmed.bodyFont) obj.fontSource = "client-confirmed";
          // State it in the brief too: the brief is what reaches Stitch as prose, and a palette stated
          // only in JSON has been ignored by the model before.
          obj.brief = (obj.brief || "") + `\n\nBRAND (CLIENT-CONFIRMED — use these EXACT values, do not substitute):`
            + ` primary ${obj.primary}, secondary ${obj.secondary}, accent ${obj.accent};`
            + ` headings ${obj.headingFont}, body ${obj.bodyFont}.`
            + ` These were read from the client's existing site (${obj.brandSourceUrl}) and confirmed by the client.`;
          console.log(`compose: client-confirmed brand pinned — ${obj.primary}/${obj.accent} · ${obj.headingFont}/${obj.bodyFont}`);
        }
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
      const { engine, pages, deviceType, theme, stitchKeyOverride } = JSON.parse(await readBody(req) || "{}");
      if (!Array.isArray(pages) || !pages.length) return json(res, 400, { error: "pages[] required" });
      const t0 = Date.now();
      // Give this client its own slice of the curated photo pool (see CURATED_OFFSET
      // above) so two clients don't ship the same hero. Seeded here — not only in
      // runJob() — because this route is also called directly by the manual
      // dashboard/wizard flows, which never go through runJob at all.
      seedCuratedPhotos((theme && theme.displayName) || "client");
      if (engine === "gemini") {
        // stylingConstraint here too, not just service pages: buildWpTheme's
        // splitPage() strips the <head> for every page this pipeline ships —
        // home/services/about/contact included — so a page that leans on a
        // custom tailwind.config color name (bg-secondary, text-primary) loses
        // that color entirely once it becomes a WP template. Caught on a real
        // generation: the header's own CTA button did exactly this.
        const tokens = designTokensBlock(theme) + stylingConstraint(theme || {});
        const geminiOne = async (pg, contract) => {
          const key = pg.key.replace(/[^a-z0-9_-]/gi, "") + "-gemini";
          try {
            let html = await geminiGenerate(tokens + "\n\n" + pg.prompt + (contract || ""));
            html = seoEnhance(html, key);
            html = injectCanonicalNav(html, theme || {});
            html = enforceFooterFacts(html);
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
      // Same reasoning as the Gemini branch above: this is the main 4-page
      // build, not just service pages, and it feeds the same splitPage()/
      // buildWpTheme() head-stripping — so it needs the same guard.
      STITCH_KEY_OVERRIDE = stitchKeyOverride || null;
      let built;
      try { built = await buildStitchSiteWithKeyRotation(pages.map(pg => ({ key: pg.key.replace(/[^a-z0-9_-]/gi, ""), prompt: pg.prompt + "\n\n" + designTokensBlock(theme) + STITCH_IMG_CLAUSE + stylingConstraint(theme || {}) })), theme || {}, deviceType); }
      finally { STITCH_KEY_OVERRIDE = null; }
      const out = await Promise.all(built.results.map(async r => {
        if (!r.html) return { pageKey: r.key, engine: "stitch", error: r.error || "no HTML" };
        // Exact, untouched Stitch output, saved BEFORE any of our post-processing —
        // so "does the shipped page match what Stitch gave" can be answered by a
        // diff instead of a guess. Debug-only artifact, never read by the pipeline.
        try { fs.writeFileSync(path.join(GEN, r.key + ".stitch-raw.html"), r.html); } catch (e) { /* debug-only, non-fatal */ }
        let html = clampViewportHeights(enforceBrandFonts(r.html, theme));  // pin brand type; bound vh heroes
        html = enforceArbitraryColors(html, theme);  // named tailwind-config colors die when <head> is stripped
        html = sharpenStitchImages(html);
        html = await fixImages(html);                // replace broken/expiring image URLs with stable photos
        html = await qcStitchImages(html);          // swap any text-baked images for clean photos
        html = seoEnhance(html, r.key);
        html = injectCanonicalNav(html, theme || {});
        html = enforceFooterFacts(html);
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

    // Design Benchmark Comparison API endpoint.
    // NOTE: not called by any current frontend — but a hardcoded-fake-score
    // endpoint is a landmine for whoever wires it up next, so it reports real
    // numbers (or null) instead of the constants (52/94, and four metrics that
    // never moved regardless of the actual site) it shipped with before.
    if (p === "/api/design-benchmark" && req.method === "GET") {
      let ex = null, beta = null;
      try { ex = JSON.parse(fs.readFileSync(path.join(GEN, ".cro-existing.json"), "utf8")); } catch (e) {}
      try { beta = JSON.parse(fs.readFileSync(path.join(GEN, ".cro-beta.json"), "utf8")); } catch (e) {}
      const beforeScore = ex && typeof ex.overall === "number" ? ex.overall : null;
      const afterScore = beta && typeof beta.overall === "number" ? beta.overall : null;
      const cat = (k) => ({
        before: ex && ex[k] && typeof ex[k].score === "number" ? ex[k].score : null,
        after: beta && beta[k] && typeof beta[k].score === "number" ? beta[k].score : null,
      });
      return json(res, 200, {
        beforeScore, afterScore,
        delta: (beforeScore != null && afterScore != null) ? afterScore - beforeScore : null,
        metrics: { vision: cat("vision"), ux: cat("ux"), cro: cat("cro"), content: cat("content") },
      });
    }

    // Wireframe QA / CRO audit of a live site (Home + one Service + About + Contact) → optionally
    // post the result onto a TED task (In Progress + AI-assigned + comment, never closed). Body:
    // { betaUrl, tedTaskId?, prereqTaskId?, serviceSlug?, serviceName?, services?, isTestUrl?, postToTed? }
    if (p === "/api/wireframe-qa" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      if (!body.betaUrl) return json(res, 400, { error: "betaUrl required" });
      const out = await wireframeQaAudit(body);
      return json(res, out.ok ? 200 : 400, out);
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
      const onb = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8"));
      const a = onb.answers;
      const slug = (a.business_name || "client").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
      await ensureFreshSite(body.theme); // rebind /site/ from newest generation — never ship stale
      const out = await buildWpTheme(slug, a.business_name, {
        // Favicon source and chatbot business id: the logo is an answer, the business id
        // rides at the root of the webhook payload.
        logoUrl: onb.logoUrl || a.logo_file || a.logo || null,
        businessId: onb.businessId || null,
      });
      return json(res, 200, { slug: out.slug, themePath: `web/app/themes/g99-${out.slug}/`, files: out.files });
    }

    if (p === "/api/push-wordpress" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      // Per-client target repo (from the job); falls back to this deployment's default.
      const repo = body.githubRepo || WP_REPO;
      const onb = JSON.parse(fs.readFileSync(path.join(DIR, "onboarding.json"), "utf8"));
      const a = onb.answers;
      const slug = (a.business_name || "client").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
      if (!body.skipRebind) await ensureFreshSite(body.theme); // rebind /site/ from newest generation — never ship stale (dashboard binds itself and passes skipRebind)
      const built = await buildWpTheme(slug, a.business_name, {
        // Favicon source and chatbot business id: the logo is an answer, the business id
        // rides at the root of the webhook payload.
        logoUrl: onb.logoUrl || a.logo_file || a.logo || null,
        businessId: onb.businessId || null,
      });
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
        const cloneUrl = await ghCloneUrl(repo);
        if (r.code) r = await runRetry(`git clone --depth 1 "${cloneUrl}" "${tmp}"`);
        if (r.code) throw new Error("clone failed (network — could not reach GitHub): " + r.stderr.slice(-200));
        // Deployed (headless) git push must authenticate via the token URL too.
        if (/x-access-token:/.test(cloneUrl)) await run(`git remote set-url origin "${cloneUrl}"`, tmp);
        const dest = path.join(tmp, rel);
        // Delete-then-copy so an UPDATE PR also shows file removals (copy alone
        // would leave stale templates from earlier merged builds in the repo).
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        for (const f of built.files) {
          const to = path.join(dest, f);
          // Some theme files now live in subdirectories (assets/favicon.*), and a flat copy
          // would throw ENOENT on the missing parent.
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(built.themeDir, f), to);
        }
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
        // Seed the manifest from the theme we just wrote. Brand is read back out of the
        // generated files rather than threaded through the build routes, so it records what
        // the site actually renders — the discrepancy that produced a brand guide documenting
        // a palette the site never used.
        try {
          const tb = readThemeBrand(dest) || {};
          updateManifest(dest, slug, a.business_name, {
            brand: {
              headingFont: tb.headingFont || null, bodyFont: tb.bodyFont || null,
              primary: tb.primary || null, secondary: tb.secondary || null, accent: tb.accent || null,
            },
            existingWebsite: a.existing_website || a.site_love_1_url || null,
            pages: mergePageRows(readManifest(dest), built.files
              .filter((f) => /^(front-page|page-[a-z0-9-]+)\.php$/.test(f))
              .map((f) => ({
                slug: f === "front-page.php" ? "" : f.replace(/^page-|\.php$/g, ""),
                title: f === "front-page.php" ? "Home" : f.replace(/^page-|\.php$/g, "").replace(/-/g, " "),
                section: "core", status: "built", engine: "stitch",
                builtAt: new Date().toISOString(),
              }))),
            run: { type: "build", at: new Date().toISOString(), buildId: built.buildId },
          });
        } catch (e) { console.error("manifest seed skipped:", e.message); }
        await run(`git checkout -b "${branch}"`, tmp);
        await run(`git add -A "${rel}" "${muRel}"`, tmp);
        // DIAGNOSTIC: how many files does git actually see staged? 0 → the copied theme matched HEAD
        // (stale GEN/site), which is the "nothing to commit" case we're proving.
        try {
          const st = await run(`git status --porcelain`, tmp);
          const changed = (st.stdout || "").split("\n").filter(l => l.trim()).length;
          console.log(`[push-wordpress] slug=${slug} copied ${built.files.length} files → git sees ${changed} changed path(s) staged before commit`);
        } catch (e) { console.warn("[push-wordpress] git status diag failed:", e.message); }
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
      const { prUrl, requireAllChecks } = JSON.parse(await readBody(req) || "{}");
      const prNum = ((prUrl || "").match(/\/pull\/(\d+)/) || [])[1];
      if (!prNum) return json(res, 400, { error: "prUrl with /pull/<n> required" });
      // "No checks" is ambiguous on its own: CI may not have registered yet, or the repo may
      // have no workflows at all. Report the PR's own state and whether the repo even has
      // workflows, so a watcher can tell those apart instead of polling for 40 minutes.
      const repo = repoFromPrUrl(prUrl);
      // Most workflows retain the historical build-only gate. Pre-release passes
      // requireAllChecks=true because visual fixes must not merge while any test fails.
      const { rows, prState, merged } = await fetchCheckRows(repo, prNum);
      const list = selectPrChecks(rows, !!requireAllChecks);
      return json(res, 200, {
        prNum, checks: list, prState, merged,
        hasWorkflows: await repoHasWorkflows(repo),
        noChecks: list.length === 0,
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
      // job.liveUrl is stored bare (no scheme) — fetch() throws on a schemeless
      // URL, which this endpoint's catch turned into a silent, permanent "active:
      // false" no matter what the live site actually served.
      const fullUrl = /^https?:\/\//i.test(url) ? url : "https://" + url;
      try {
        const r = await fetch(fullUrl, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Cache-Control": "no-cache" } });
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
      const { rows: checks } = await fetchCheckRows(repoFromPrUrl(prUrl), prNum);
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

    // General-purpose zip export: any folder under generated/ (guarded against traversal),
    // packaged inside a zip so the top-level folder INSIDE the zip is `name` — e.g. a job's
    // snapshot at generated/exports/<draftId>/site becomes betasite.gogroth.com/index.html,
    // betasite.gogroth.com/style.css, ... when unzipped. Compress-Archive normally flattens
    // -Path 'dir\*' straight into the zip root, so the folder is staged under a temp parent
    // named `name` first and THAT is what gets compressed.
    if (p === "/api/export-zip") {
      const dirParam = (u.searchParams.get("dir") || "site").replace(/^\/+/, "").replace(/\.\./g, "");
      const nameParam = (u.searchParams.get("name") || "beta-site").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "beta-site";
      const srcDir = path.resolve(path.join(GEN, dirParam));
      const genResolved = path.resolve(GEN);
      if (srcDir !== genResolved && !srcDir.startsWith(genResolved + path.sep)) return json(res, 400, { error: "invalid dir" });
      if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return json(res, 404, { error: "nothing to export at " + dirParam });
      const stageRoot = path.join(GEN, "_ziptmp", "z" + Date.now() + Math.floor(Math.random() * 1e6));
      const stageNamed = path.join(stageRoot, nameParam);
      const zipPath = stageRoot + ".zip";
      try {
        fs.mkdirSync(stageNamed, { recursive: true });
        fs.cpSync(srcDir, stageNamed, { recursive: true });
        await new Promise((resolve, reject) => {
          require("child_process").execFile("powershell.exe",
            ["-NoProfile", "-Command", `Compress-Archive -Path '${stageNamed}' -DestinationPath '${zipPath}' -Force`],
            (e) => e ? reject(new Error("zip failed: " + e.message)) : resolve());
        });
        const buf = fs.readFileSync(zipPath);
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${nameParam}.zip"` });
        return res.end(buf);
      } finally {
        try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* ignore */ }
      }
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
  // Say which mode content review is in, at boot, every time. The one thing that
  // must never be ambiguous is whether a reviewer's correction ends up in a local
  // checkout or in a pull request against a client's repository.
  {
    const localRepo = (process.env.REVIEW_LOCAL_REPO || "").trim();
    const live = String(process.env.REVIEW_LIVE || "").toLowerCase() === "on";
    console.log(localRepo
      ? `content review: LOCAL — corrections written to ${localRepo}; nothing is cloned, pushed or merged`
      : live
        ? "content review: LIVE — corrections open a pull request and auto-merge to the client repository"
        : "content review: OFF — submissions are refused (set REVIEW_LOCAL_REPO for a local run, or REVIEW_LIVE=on to publish)");
  }
  // Scheduled re-audit (off unless REAUDIT_HOURS > 0, to avoid burning quota).
  const reauditHours = parseFloat(process.env.REAUDIT_HOURS || "0");
  if (reauditHours > 0) {
    setInterval(() => { reauditActiveSite().catch((e) => console.warn("re-audit failed:", e.message)); }, reauditHours * 3600 * 1000);
    console.log(`re-audit scheduled every ${reauditHours}h`);
  }
  // Picks up subtasks TED's webhook did not tell us about. Set
  // TED_SUBTASK_POLL_MS=0 to rely on the webhook alone.
  if (TED_API_TOKEN && TED_SUBTASKS && TED_POLL_MS > 0) {
    const tick = () => pollTedSubtasks().catch((e) => console.warn("subtask poll failed:", e.message));
    setInterval(tick, TED_POLL_MS);
    setTimeout(tick, 15000);   // after boot, once NocoDB and TED are reachable
    console.log(`TED subtask poll every ${Math.round(TED_POLL_MS / 1000)}s (parent ${TED_PARENT_KEY})`);
  }
}
// One export object, deliberately: a second `module.exports = {...}` further up silently replaces
// this one, which is a 20-minute debugging session waiting to happen.
// The job/postStatus entries are for the local test harness that drives the per-step emission audit
// against a stub product-service without running a real build.
module.exports = {
  seoEnhance, audit, sharpenStitchImages, injectCanonicalNav, qcStitchImages, fixImages,
  JOBS, postStatus, jobStatusSnapshot, saveJobs, loadJobs, emitAudit,
  // Design-quality pass (DESIGN_QUALITY_PLAN.md) — exported for test-design.js.
  retargetNav, vibeFor, designMdFor, clampViewportHeights, enforceArbitraryColors,
  seedCuratedPhotos, curatedPhoto, CURATED_IMAGES,
  splitPage, imageContext, medspaCategory,
  safeArtifactName, mobilePageUrl, isSafeArtifactSegment, browserlessScreenshotRequest, browserlessLayoutRequest, captureMobileLayout, issueSupportedByLayout, selectPrChecks, preReleaseMarkerUrl, screenshotBuffersEqual, issueSupportedBySource, safeResponsivePlanFiles, verifyResponsiveDiff, repairResponsiveFile, readMuPages,
  // Perform PR: the pure halves are exported so the audits and fixes can be
  // exercised against a real theme without cloning a repo or opening a PR.
  liveSiteCandidate, nameTokens, textNodesOutsideAnchors, extractSocials, themeBrandColor, themeLogoUrl, siteHostOf,
  findingsBusinessName, findingsContact, findingsClickable, findingsCta, findingsFavicon,
  fetchLiveSitemap, sitemapLocs, urlSlug, findingsMissingPages, resolveLiveSite,
  splitLocationSlug, findingsUrlStructure, pageSpeedRun, findingsPageSpeed, psiReportUrl, collapseFindings,
  fixSpelling, fixCta, extractCtaBlock, performPrFixImages, cdnWebpUrl, imageSubject, uniqueImageName,
  writeRedirectMap, readRedirectMap, fixUrlStructure, findingsInternalLinks, bestRedirectTarget, fixInternalLinks, themeChromePages,
  closeSupersededPerformPrs,
  tedComment, tedUpdateTask, tedAiComment, tedHtml, closeTedTaskIfFinal,
  tedCreateSubtask, tedRevisionParent, tedClientName, tedSubtaskTitle, tedNorm,
  tedClients, tedClientIdFor, tedSiteFields, tedRepoUsable, withTedFields, resolveClientSite,
  tedResolveSubtaskRequest, tedTaskComments, isEmailSubtask, TED_EMAIL_SUFFIX, TED_AUTOMATION_MARK,
  tedListSubtasks, startTedSubtaskRun, pollTedSubtasks,
  OUTCOME, OUTCOME_LABEL, resolveFindingOutcomes, replaceInTextNodes, fixBusinessName,
  imageSources, findingsImages, readSeoPages, synthMuSource, pageText,
  fixFavicon, fixSocialImage, fix404, fixCallNow, fixBlvd, fixBlogLinkColor, fixClickable,
  performPrReportHtml, performPrPrBody, performPrMarkerUrl, PERFORM_PR_STEPS,
};
