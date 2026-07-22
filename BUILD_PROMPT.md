# Build Prompt — Growth99 Website Build Tool

You are building an internal, single-operator web app that turns a medical-aesthetics (medspa) client's onboarding form into a complete, conversion-optimized **beta website**, plus client-shareable **Brand Guide** and **SEO Report** pages, with a **CRO before/after** proving the new site beats the old one.

## Stack & constraints
- **Pure Node.js, ZERO npm dependencies.** One `server.js` using only built-in `http`, `fs`, `path`, `url`, and global `fetch`. Static frontend in `public/` (`index.html`, `app.js`, `styles.css`) — vanilla JS, no framework, no build step. Run with `node server.js` on port 8793.
- Dummy client data in `onboarding.json` (`{ businessId, existingWebsite, referenceWebsite, answers:{...} }`). Output written to `generated/` (per-page HTML, assembled `site/`, review pages, zips).
- API keys via env with hardcoded dev fallbacks: `STITCH_API_KEY`, `GEMINI_KEYS` (comma-separated list), `GEMINI_MODEL`. **Design for env vars from day one.**

## External services
1. **Google Stitch** (design generator) over MCP JSON-RPC at `https://stitch.googleapis.com/mcp`. Headers: `X-Goog-Api-Key`, `MCP-Protocol-Version: 2025-06-18`, `Accept: application/json, text/event-stream`. Flow: `initialize` → `notifications/initialized` → `tools/call` with `create_project`, `create_design_system`, `generate_screen_from_text`, `edit_screens`, `get_project`, `get_screen`. Responses may be bare JSON or SSE (`data:` lines) — parse both; results are under `result.structuredContent`.
2. **Google Gemini** (`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`) for all reasoning: prompt composition, CRO audits, QA critique, brand/SEO copy, vision image-QC, existing-site design scan.
3. **microlink.io** (free, no key) for existing-site screenshots: `api.microlink.io/?url=&screenshot=true&embed=screenshot.url`.

## The 6-step operator flow (stepper UI, one page)
1. **Onboarding** — render the submitted form answers with source chips (From HubSpot / Your website / Client) and NEW tags. No brand-color fields (client won't have them).
2. **CRO Audit (existing site)** — agency-style conversion audit of the client's current URL. Gemini analyzes a microlink screenshot + HTML across **4 disciplines: Vision & UI, UX & Usability, CRO & Sales, Content & Copy**. Each returns `{score 0-100, severity, observations[], issues[], recommendations[], checks:[{label,status,note}]}` + an executive summary `{strengths[], weaknesses[], topRecommendations[]}`. Weighted overall (cro .35, ux .30, vision .20, content .15). Show a score gauge + per-discipline bars + full detail. Cache findings to `.cro-existing.json`.
3. **Prompt & Generate** — an **✨ AI-compose (Gemini)** button writes the build prompt from onboarding + CRO findings + existing-site colors (scanned & AI-refined into a clean accessible palette; picks one if none). Produces `{primary, secondary, accent, headingFont, bodyFont, brief}`. Also a "🔍 Scan design" that reads the existing site's tokens. Editable prompt textarea, vibe/device selectors. Generate all 4 pages (Home/Services/About/Contact) with **Stitch**, **Gemini**, or **⚔ BOTH** (engines run in parallel; all pages parallel).
4. **Preview & Export** — per-page tabs; if BOTH ran, show Stitch vs Gemini side-by-side. **✨ Bind site (AI chrome)** produces one coherent bundle. **Client deliverables**: Generate Brand Guide + Generate SEO Report. Export HTML / download zip.
5. **QA & Refine (whole-site)** — Gemini UX critique of every page; show feedback; one **"Refine whole site with Stitch"** button feeds comments into `edit_screens` and regenerates each page (parallel), shown original-vs-v2.
6. **CRO Compare (before/after)** — re-run the CRO audit on the beta site (audits **every page and averages**), compare to Step 2: two gauges + delta, per-discipline comparison, issues fixed vs still open, and the **full CRO report for both** existing and beta.

## Generation engines — implement exactly
**Stitch site build:** ONE project + ONE `create_design_system` (colors/fonts/roundness/designMd from the theme) → all pages `generate_screen_from_text` in parallel **with that designSystem id** (consistent theme). Track `{projectId, designSystem, screens:{key:id}}` in `.stitch-metadata.json`.

**Gemini:** system prompt forces a complete standalone HTML doc; home page generated first, then its exact `<head>`+nav+footer contracted into the other pages for consistency (or run parallel with shared design tokens).

## CRITICAL gotchas (each cost real debugging — bake these in)
- **Stitch returns MULTIPLE screens per generation** (page + decorative shader/image assets, order not guaranteed). Never take the first HTML — download every candidate and **score by content density** (count `<h1/h2/p/section/nav/footer/img>` + word count); keep the highest. Do NOT disqualify on a `STITCH_SHADER_START` marker — real pages embed shaders as backgrounds.
- **Stitch is flaky**: intermittent 429 / "invalid argument" / empty results, especially back-to-back. Retry up to 3× (rotate to a fresh project between whole-site attempts); per-page generation belongs in one shared project.
- **Broken/expiring images**: Stitch `<img>` often points at `lh3.googleusercontent.com/aida/AP1WRL…` (session-bound, fail in browser) or `/aida-public/…` (a 512px thumb that also expires). Add a `fixImages()` pass: force-replace any non-`/aida-public/` lh3 URL, and load-verify `/aida-public/` ones (fetch → 200 + image content-type) — replace failures with a **curated, validated Unsplash medspa photo library** (~14 stable `images.unsplash.com/photo-…?w=1600` URLs). This guarantees every page ships with loading, on-topic images.
- **Hallucinated header + text-baked images**: Stitch invents garbled nav labels and bakes fake nav text into image pixels. Fix: (a) `injectCanonicalNav()` — strip ALL model `<header>/<nav>` and inject one deterministic, inline-styled, contrast-safe bar built from real data (text logo, correct links, CTA); (b) `qcStitchImages()` — Gemini-vision check each image for baked-in text/UI and swap flagged ones for curated photos.
- **Gemini free-tier quota**: use **key rotation** across many keys (`GEMINI_KEYS`), skipping 429/503 and advancing the index; add a per-request AbortController timeout (~45s). Model choice matters — `gemini-flash-latest` is often 503; `gemini-flash-lite-latest` is reliable and has quota. Run whole-site audits **sequentially** (not parallel) to stay under RPM.
- **CSS gauge**: the inner mask (`::after`) paints over the number — give the number `z-index:1`.
- **Site binding**: model pages don't link to each other. An assembler must inject ONE shared header/footer into every page (self-contained inline styles so it renders identically), rewire nav links to real files (`index/services/about/contact.html`), and bundle under `generated/site/`. Prefer an AI-generated brand-matched chrome (`aiChrome` via Gemini) with the deterministic canonical nav as fallback.
- **seoEnhance post-processor**: Stitch ignores meta/schema prompt instructions, so deterministically inject `<title>`, meta description, canonical, Open Graph, JSON-LD `MedicalBusiness` schema (NAP+hours), image alt text, promote one `<h1>`, and a keyword line — on every generated page.

## Client deliverables (self-contained HTML pages, own styling, shareable)
- **Brand Guide**: hero, brand story, voice/tone, logo usage variants, color palette (swatches + hex + usage), typography scale samples (heading/body fonts), iconography, imagery style, buttons, design rationale. Content prose via Gemini; layout deterministic from the composed brand.
- **SEO Report**: score gauge, "what we optimized", target keywords, per-page meta title/description + schema + alt + score table, structured-data section, technical recommendations, content-optimization summary, AI explanation.
- Both are generated INTO the bound bundle (`site/branding.html`, `site/seo.html`) and every page gets a thin "BETA PREVIEW · Site · Branding guide · SEO report" review bar. Included in the zip.

## Endpoints (POST unless noted)
`/api/onboarding` (GET), `/api/analyze-site` (scan existing → design tokens), `/api/compose-brand`, `/api/cro-audit` (existing), `/api/cro-audit-beta` (averaged), `/api/generate-site` (engine, pages[], theme), `/api/bind-site`, `/api/qa-audit`, `/api/qa-refine`, `/api/brand-guide`, `/api/seo-report`; static + `/preview/:key`, `/export/:key`, `/site/*`, `/export-site`.

## Design bar
Premium editorial aesthetic (think luxury medspa): serif display + clean sans, generous whitespace, warm palette, theme-aware, real content (no lorem). The operator UI itself should be a clean, professional dashboard (cool neutral chrome, plum accent) distinct from the warm client-site previews.

Build it, run it on 8793, and verify each stage end-to-end (drive the browser, screenshot results) before declaring done. Never claim something works without observing it.
