# Plan: Beta-Site Dashboard (one-page 7-step pipeline)  (started 2026-07-22)

Goal: One elegant dashboard page that shows the (editable) onboarding form response and runs the full 7-step beta-site pipeline end to end — CRO(before) → AI prompt → Stitch pages → WordPress + PR → paste live URL → CRO(after) → before/after comparison — wiring mostly to endpoints that already exist.

Backend status found (most steps already covered):
- Step 1 CRO existing → `/api/cro-audit {url}` ✓ (caches `.cro-existing.json`)
- Step 2 prompt → `/api/compose-brand` ✓ (already folds in CRO data + existing colors + onboarding → returns palette + `brief` = the build prompt)
- Step 3 Stitch → `/api/generate-site` ✓
- Step 4 WP + PR → `/api/push-wordpress` ✓ (now auto-binds + ships index.php + auto-activator)
- Step 6 CRO after → **gap**: `/api/cro-audit` overwrites the "before" cache; need a live-URL audit stored separately
- Step 7 compare → `croAverage` + existing compare render logic ✓

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Dashboard page scaffold + route | server.js, public/dashboard.html, public/dashboard.js | ✅ done | /dashboard + /dashboard.js serve HTTP 200; page renders, no console errors |
| 2 | Editable form-response panel + save | public/dashboard.html/js, server.js `POST /api/onboarding` | ✅ done | save round-trips; arrays preserved, structured team_roster excluded (verified via collectForm) |
| 3 | "Build beta site" orchestrator (steps 1→4) | public/dashboard.js | ✅ done (wired) | fully automatic 1→4; each endpoint works independently. Full live run not executed here (step 4 opens a real PR — user triggers) |
| 4 | Wire Step 1 — CRO of existing site | dashboard.js → `/api/cro-audit` | ✅ done | gauge + per-discipline bars + top fixes rendered |
| 5 | Wire Step 2 — compose build prompt | dashboard.js → `/api/compose-brand` | ✅ done | editable brief textarea; used for generation |
| 6 | Wire Step 3 — generate pages (Stitch) | dashboard.js → `/api/generate-site` | ✅ done | engine "" (Stitch); preview links per page |
| 7 | Wire Step 4 — WP theme + open PR | dashboard.js → `/api/push-wordpress` | ✅ done | PR link shown; push auto-binds /site/ first |
| 8 | Step 5 — paste pushed/live URL | public/dashboard.html/js | ✅ done | URL input revealed after step 4 |
| 9 | Backend — audit a live URL as "after" | server.js `POST /api/cro-audit-url` | ✅ done | added; caches `.cro-beta.json`, does NOT clobber `.cro-existing.json` |
| 10 | Wire Step 6 — CRO of live beta URL | dashboard.js → `/api/cro-audit-url` | ✅ done | after-audit gauge + bars |
| 11 | Step 7 — before/after comparison view | dashboard.js | ✅ done | before/after gauges + delta + per-discipline before→after |
| 12 | Elegant styling pass to match reference | public/styles.css (or dashboard.css) | 🚫 blocked (awaiting your UI reference) | built with clean default styling; refine to reference when shared |
| 13 | Fix push non-fast-forward failure | server.js `/api/push-wordpress` | ✅ done | branch now seconds+suffix unique; retries once on rejected push |
| 14 | Enrich compose-brand prompt | server.js `/api/compose-brand`, public/dashboard.js | ✅ done | folds in scanned existing-site theme + full onboarding + full CRO + imagery direction; brief now ~286 words (verified), usedAnalysis/usedCro=true |
| 15 | Fix blank non-home pages on live | server.js `wpActivatorPlugin` | ✅ done | root cause: programmatic switch_theme() never fired theme's after_switch_theme → Pages never created → non-home URLs hit index.php ("Nothing here yet"). Moved provisioning INTO the mu-plugin (runs on init, flag-guarded). Needs a fresh push to reach live |
| 16 | "no stitch pages" — real root cause = deviceType casing | server.js (deviceType normalize), public/dashboard.js | ✅ done | ROOT CAUSE: dashboard sent deviceType "desktop" (lowercase); Stitch enum requires "DESKTOP" → every call "invalid argument". Fix: normalize to .toUpperCase() at all 3 Stitch call sites + dashboard sends DESKTOP. VERIFIED: 1/1 page generated (15,876 bytes) with lowercase input normalized. designSystem proven fine (5/5 variants OK) |
| 17 | Stitch resilience hardening | server.js | ✅ done | switched to user's key; pinned modelId (now GEMINI_3_FLASH per user — faster); retries on create_project + create_design_system + generate(5×); 90s rpc timeout; dashboard halts step 3 on 0 pages with real error |
| 18 | Push network resilience | server.js push route | ✅ done | clone/pr-create retry 3× + git-clone-over-github.com fallback (api.github.com DNS flakiness → connection refused) |
| 19 | Pre-PR Pint gate (JS, no PHP locally) | server.js phpLintPer | ✅ done | repo pint.json = "per" preset; no php/composer/docker locally. JS checker auto-fixes safe PER rules (trailing ws, final newline, blank-after-bare-<?php, named-fn brace next-line), BLOCKS build on unfixable (multiple-statements). Wired into buildWpTheme w() + mu-plugin. 6/6 unit tests pass; safe on inline <?php templates |
| 20 | Per-page progress in dashboard step 3 | server.js (GEN_PROGRESS + GET /api/generate-progress), public/dashboard.js | ✅ done | server updates queued→generating→post-processing→done(bytes)/error per page; dashboard polls 2s; endpoint verified ({"phase":"idle"}), helpers render rows, no console errors |
| 21 | Auto-bind (Gemini chrome) + preview link after generation | public/dashboard.js | ✅ done | step 3 now auto-calls /api/bind-site after generation, shows "Preview assembled site" link, then flows to step 4 with skipRebind:true (no double bind) |
| 22 | Push without lint (raw) | server.js push route + buildWpTheme | ✅ done | phpLintPer removed entirely (wiring + function); push ships generator output as-is |
| 23 | PR build-check poll + Gemini auto-fix loop | server.js (/api/pr-status, /api/pr-autofix), public/dashboard.js watchPrBuilds | ✅ done | polls every 10s, BUILD checks only (integration ignored — verified on PR#7: 3 builds pass, allPass:true); on fail → gh log-failed → Gemini fixes offending .php → commit to branch → re-poll; caps: 3 fixes, ~15min watch. Safe path verified ("no failing build check found"). Full fail→fix cycle untested (needs a real red PR) |
| 24 | Auto-merge PR when builds pass | server.js /api/pr-merge, dashboard watchPrBuilds | ✅ done | on allPass → gh pr merge --squash --delete-branch; route wired, syntax-verified (real merge untested — needs next live PR) |
| 25 | Auto-detect theme activation → run after-audit | server.js /api/theme-live, dashboard step 5/6 | ✅ done | polls live URL every 15s (max ~10 min) for `/themes/g99-<slug>/` asset marker → auto-runs runAfter() (steps 6+7). VERIFIED on live: correct slug → active:true, wrong slug → active:false. Manual input fallback kept |
| 26 | Re-PR hygiene: delete-then-copy theme dir | server.js push route | ✅ done | rm theme dir in clone before copy + `git add -A` so update PRs also carry deletions; buildId change re-triggers mu-plugin activate+provision (idempotent) |
| 27 | Deploy-ready (Render) | server.js, .env(.example), .gitignore, render.yaml, render-build.sh, dashboard.js, app.js | ✅ done | hardcoded Stitch+Gemini keys stripped → .env loader (no deps); GH_TOKEN-aware clone/push; ADMIN_PASSWORD gate on /api/* (health-check exempt) + frontend key prompt/header; render.yaml + gh-binary build script. VERIFIED: ungated local OK, gated instance 6/6 (401 wrong/missing key, 200 correct, health 200) |

## Archive

### Élan Medical Aesthetics beta site (hand-built, ruma.com-inspired) — started 2026-07-20, completed 2026-07-22
Goal: A polished 4-page static site in `generated/site-claude/` from `onboarding.json`, fresh palette, ruma.com-inspired layout.

| # | Task | Status |
|---|------|--------|
| 1 | Palette, type, shared CSS system | ✅ done |
| 2 | Home page | ✅ done |
| 3 | Services page | ✅ done |
| 4 | About page | ✅ done |
| 5 | Contact page | ✅ done |
| 6 | Shared nav/footer + responsive | ✅ done |
| 7 | Browser check | ✅ done |
