# Plan: Full-site replica via a batched page queue  (started 2026-07-30)

Goal: rebuild a client's ENTIRE site (100–150 pages) as a beta site, end-to-end, without human
intervention — by turning the page inventory into a durable **page queue** and working through it in
small batches that each open their own PR. No single job ever holds more than a batch in memory.

## The two questions answered

**Where to start:** the **page queue**, not a database. The queue is the durable state (what's built /
what's pending) AND the unit of batching. A DB is infrastructure that can be swapped in later without
changing this model; the queue is the model.

**The pain that drove this (Mehul, 2026-07-31):** "jab new deployment karta hu to existing job ka data
chala jata hai — mere paas koi pool nahi hai jahan dekh saku kitne client onboard hue, unke kitne pages
bane." Render's disk is ephemeral, so `jobs.json` dies on every deploy. Note the platform ALREADY keeps a
durable record — Postgres `website_build`, one row per draft, fed by our own status callbacks and listed by
`GET /api/admin/onboarding/drafts`. What was missing was (a) page counts and (b) any view of it inside this
tool. Hence the NocoDB pool: external, free, already authenticated, and readable outside the tool.

**Do we need a DB now:** no. The queue lives in `.g99/site.json` inside the theme repo — durable,
versioned, and **updated in the same PR that adds the pages**, so the queue can never drift from what is
actually deployed. Mirror a per-site summary row into **NocoDB** (already wired: `NOCODB_TOKEN`) for the
cross-client table + history view, for free. Graduate to Postgres when >~20 live sites or when
cross-client queries/trends are needed (note: Render free Postgres expires after 90 days).

## Why 150 pages currently can't work, and the fix

| Constraint | Fix |
|---|---|
| Holding 150 pages of HTML in one job = memory blowout | Batch of 5–8 pages per job; write + commit + exit |
| One Stitch generation per page ≈ 1–3 min → hours, and real cost | **Not every page needs Stitch.** One Stitch *template per section*, then Gemini clones for the long tail (22 location pages are near-identical) |
| Render: idle sleep, request timeouts, single job concurrency | Each batch is a short job; the queue survives restarts because it's in the repo |
| A human clicking "build" 25 times | Batch auto-chains: on success, if pending remain, enqueue the next batch (capped + backoff) |

Ordering so value lands first: core → revenue treatments → remaining treatments → proof/offers →
locations → long tail.

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Page-plan model + manifest | server.js — `buildPagePlan()`, `betaSlugFor()`, `nextBatch()`, `readManifest`/`writeManifest` (`.g99/site.json`) | ✅ done | per-page rows `{path,title,section,slug,status,priority,engine,attempts,sourcePaths}`; `SECTION_BUILD` priority+engine map; exposed via `/api/site-inventory`. VERIFIED on ruma.com's real 405-URL sitemap: 247 in-scope URLs → **83 rows, 72 pending, 12 batches**. Caught a bug: `betaSlugFor` stripped `-near-provo-utah` and collapsed all 22 location pages into 2 rows — now skipped for the locations section |
| 2 | Manifest as brand + plan source of truth | server.js — `updateManifest`, `mergePageRows`, `resolveBrand`; enrich + push-wordpress write it | ✅ done | Two halves, because nothing was writing the manifest before — read alone would never have fired. **Write:** build seeds it (brand read back out of the generated theme, core pages), enrich merges its treatment rows in; both land in the same PR as the pages, via the existing `git add -A "<themePath>"`. **Read:** `resolveBrand` precedence = build-authoritative → manifest → theme scrape → inherited. `mergePageRows` keys on slug so a 6-page job can't look like it deleted the other 77. VERIFIED: 17/17 unit assertions (create, merge-preserves-core, rebuild-in-place, all 4 precedence levels) + repo `.gitignore` checked — no dotfolder rule, so `.g99/site.json` really does commit |
| 3 | Coverage table becomes the control surface | public/coverage.* , server.js `/api/build-pages`, `estimateBuild`, `PLAN_CACHE`, `titleFromSlug` | ✅ done | Table now renders the PAGE PLAN (one row = one unit of work), not raw URLs. Checkbox per row, per-section select-all, "select all pending", sticky action bar, per-row Build/Rebuild. `/api/build-pages` is two-phase: quote without `confirm`, and validates slugs against the SERVER's plan (`PLAN_CACHE`, 15-min TTL) so the browser can't name arbitrary pages. Built rows locked. VERIFIED in browser: 72 checkboxes / 11 locked / 8 sections; section select-all → 18 selected; quote = 1 Stitch + 17 clones, 3 batches, ~21m, ~$0.03; all-pending → 72 pages, 12 batches, large-selection warning; server rejects built-without-rebuild (400), unknown slug (400), empty (400); confirm returns the honest 501 until task 4. No console errors. Also fixed: page titles came from THEIR titles ("Botox In Lehi Ut", and a consolidated row named "Vitamin IV Therapy…" landing on `/hormone-therapy`) — now `titleFromSlug` names our page after our slug | **Multi-select is the primitive** (Mehul, 2026-08-03): checkbox per row, select-all per section, "select all pending", sticky action bar with count → **Build pages**. Per-row Build too. Built rows locked — Rebuild is an explicit action, never the default. "Build next batch" survives as a preset (= select next N) |
| 4 | Batched page-builder job (`pages` type) | server.js — `runPagesJob()` | ⏳ pending | takes N pending rows → generate → write → PR → CI → merge → update manifest → exit. Never holds >batch in memory |
| 5 | Auto-chaining | server.js — tail of `runPagesJob` | ⏳ pending | if pending>0 and batch succeeded → enqueue next batch; stop on 2 consecutive failures; cap batches/run. **Also splits an oversized selection**: 40 selected pages → 7 chained batches from one click, so a big selection can't recreate the memory blowout batching exists to prevent |
| 6 | Section templates + clone engine | server.js — reuse `generateServiceTemplate`/`cloneServicePage` | ⏳ pending | 1 Stitch template per section, Gemini clones the rest; per-row `engine` records which was used |
| 7 | NocoDB client pool (cross-client history) | server.js pool block, public/clients.* , /api/pool | ✅ done | **The redeploy-data-loss fix.** NocoDB table `beta_site_builds` (id `meeshvyt8q9x412`), one row per CLIENT keyed by repo (not per job — that turned 4 sites into 24 rows). Coalesced bulk flush (NocoDB 429s on per-row writes), retry on throttle, boot backfill from jobs.json, live in-memory overlay that never blanks stored fields. New `/clients` page + nav entry. VERIFIED: 24 jobs → 6 clients; restart = 24 updates / 0 inserts (no dupes); **jobs.json deleted → all rows still listed** |
| 8 | AI page classifier (quality, not capability) | server.js — `classifyPage` → Gemini, cached | ⏳ pending | fixes the judgement calls (portfolio CPT = service pages, Traptox ≈ Neurotoxins). Batch ~80 URLs/call, cache on sitemap hash, current rules as fallback |
| 9 | Inventory as a build step | server.js `runJob` step 2 | ⏳ pending | "Scan the current website" populates the plan on first build; fail-soft |
| 10 | E2E: ruma-scale replica | full local | ⏳ pending | drive a 100+ page site to ~100% coverage through auto-chained batches |
| 11 | Pre-flight estimate | public/coverage.js, server.js `estimateBuild` | ✅ done (shipped with 3) | before firing: Stitch-vs-clone split, rough minutes and $ for the selection. No hard cap — 20+ rows warns and asks to confirm, never blocks. Guards against 22 location pages accidentally going through Stitch |

Open decisions: (a) auto-expand the page set or propose-then-confirm — recommend **propose** for the
first run, auto after; (b) location pages in scope? — recommend yes, they're the biggest unbuilt block,
but generate via clone to control cost.

---

# Plan: Edit an existing deployed site (AI code-edit → PR → merge)  (started 2026-07-23)

Goal: From the tool, pick an already-deployed site, describe a change in a prompt (free-text, AI-expanded, or a predefined template), and have the tool pull the current theme code, apply the edit with AI (plan-then-apply), open a PR, watch the build, auto-merge on green, and report done. No DB — the site→repo mapping lives in a repo-derived registry.

Decisions (confirmed by Mehul 2026-07-23):
- Merge policy: **auto-merge on green build** (same as the generator; integration test ignored)
- Preview: **only if feasible, else skip** — realistically the PR diff + live site after merge
- Edit engine: **plan-then-apply** (multi-file; handles "add a page" = template + mu-plugin provisioning entry)
- Registry: **(a) sync-from-repo only** — repo is source of truth, on-demand/refreshable, covers existing + future; build/edit jobs call the same sync at the end for instant freshness (no separate write path)

Prior plan preserved in `onboarding-v1-plan.md` (v1 pipeline — delivered; only sonar-check on the Java change still pending there).

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Site registry (sync-from-repo) | tool server.js, registry.json, GET /api/sites | ✅ done | syncSiteRegistry() derives sites from theme dirs on main + boundary-matched latest merged PR; GET /api/sites (?refresh=1 re-syncs). VERIFIED: 4 sites seeded, each mapped to its own PR (#8/#9/#10/#12) after fixing a substring-collision bug (mehul-aesthetic vs mehul-aesthetic1) |
| 2 | Edit UI page | public/edit.html + edit.js, route /edit | ✅ done | site picker (live from /api/sites + refresh), shows slug/lastChange; prompt box; 6 predefined-prompt buttons; ✨ Improve-with-AI; Apply → edit job → /jobs. VERIFIED: /edit 200, 4 sites, selection enables panel, 6 presets, no console errors |
| 3 | AI prompt helpers | tool server.js /api/edit-suggest, edit.js templates | ✅ done | 6 presets in FE; /api/edit-suggest verified — "add terms of service page" → precise multi-sentence instruction (incl. nav) |
| 4 | AI edit engine — PLAN | tool server.js editPlan + THEME_CONVENTIONS | ✅ done | clones main, builds manifest of theme dir + mu-plugin, Gemini → {summary, files:[{path,op,instruction}]}; filtered to in-scope paths (theme dir + its mu-plugin), capped 8 |
| 5 | AI edit engine — APPLY | tool server.js editFileContent + runEditJob | ✅ done | per file: create/modify (sends current content)/delete; empty/invalid-content guard; required index.php+style.css survival guard; add-page pattern encoded in THEME_CONVENTIONS |
| 6 | Edit job type on the runner | tool server.js runEditJob, enqueueEditJob, EDIT_STEPS | ✅ done (unrun) | 6 steps: Pull→Plan→Apply→Push+PR→CI watch/auto-fix/merge→sync registry; reuses pr-status/autofix/merge + git/gh flow; PR comment. Routes + validation verified; full engine E2E not yet run (opens+merges a real PR — needs go) |
| 7 | Preview (best-effort) | — | ❌ dropped | true preview needs a running WordPress; per decision "skip if not feasible" → the PR diff + post-merge live site are the preview |
| 8 | Registry auto-refresh hook | tool server.js runJob + runEditJob | ✅ done | both build and edit jobs call syncSiteRegistry() at the end so /edit is instantly current |
| 9 | Local E2E — "add Terms of Service page" | full local | ✅ done (engine); merge blocked externally | edit job ran plan→apply→PR #15 correctly (created page-terms.php + added mu-plugin $pages entry). Two findings fixed: (1) AI filename mismatch (page-terms.php vs page-terms-of-service.php in mu-plugin) → apply now passes the plan's file list so cross-refs match; (2) org GitHub Actions is OFF (billing/spending-limit) → CI can't run → now detected + reported as billing (no futile autofix). PR #15 closed. Green-merge unverifiable until org billing restored |
| 10 | Edit history (PR links per site) | server.js /api/site-history, edit.html/js | ✅ done | lists every build+edit PR for a site (boundary-matched branch), type/state/date + GitHub link; verified mehul-aesthetic → #9 only |

## P0 product improvements (PM review 2026-07-23)
| # | Task | Files | Status | Notes |
|---|------|-------|--------|-------|
| P0-1 | Fix edit-job detail (was showing build onboarding form) | public/jobs.js editCard | ✅ done | edit jobs render own inline detail (request, plan, files, steps, PR); no nav to build dashboard. Verified via mock |
| P0-2 | Persist jobs across restart | server.js saveJobs/loadJobs, jobs.json | ✅ done | debounced save on step/enqueue/finish; load marks running→"interrupted". Verified survive+interrupt |
| P0-3 | Page thumbnails (show the website) | public/dashboard.js thumbStrip | ✅ done | scaled live /preview iframes in build monitor + live run; /preview 200 |

## P1 UI improvements (2026-07-23)
| # | Task | Files | Status | Notes |
|---|------|-------|--------|-------|
| P1-1 | Left-rail nav (shared) | public/nav.js (+route, included on all 3 pages) | ✅ done | injected sidebar Build/Jobs/Edit, active highlight; fixed on desktop (214px offset, no overlap — verified @1200px), responsive top-bar ≤760px |
| P1-2 | /jobs summary + filters | public/jobs.html/js | ✅ done | 6 summary tiles (total/running/done/errors/success-rate/avg CRO lift) + status & type chips + business search. Verified render + no console errors |
| P1-3 | Before/after hero | public/dashboard.js renderComparison, dashboard.html | ✅ done | big before→after scores, animated delta + verdict, microlink before/after screenshots, per-discipline before→after bars. Verified: +19 "significant improvement", 2 shots, 4 cats |

## P2 (2026-07-23)
| # | Task | Files | Status | Notes |
|---|------|-------|--------|-------|
| P2-1 | Cost/usage meter | server.js (CURRENT_JOB + counters in geminiCall/callTool) | ✅ done | count Gemini + Stitch calls per job, rough $ estimate; show per job + global |
| P2-2 | Cancel / retry | server.js job-cancel/job-retry + JOBS, jobs.js buttons | ✅ done | cancel flag checked between steps; dequeue queued; retry re-enqueues payload |
| P2-3 | Per-site approval | server.js registry.requireApproval + job pause + job-approve, edit.js toggle | ✅ done | if on, job stops at "PR open" and waits for human approve → merge |
| P2-4 | Notifications | server.js notify() (Slack webhook) | ✅ done | fire on job done/error; env SLACK_WEBHOOK_URL; fail-soft |
| P2-5 | Type-aware detail page + rendered diff | public/job.html+js, server.js /api/pr-diff, jobs.js links | ✅ done | one /job?id= view: build vs edit layout; render PR diff via gh pr diff |
| P2-6 | Scheduled re-audits | server.js interval + /api/reaudit | ✅ done | periodic CRO on active site(s), store + alert on regression via notify |
| P2-7 | Design-system pass | public/theme.css (shared), linked on all pages | ✅ done | Inter font, refined tokens/shadows/spacing, consistent buttons/cards |

## UI revamp (2026-07-23) — Vercel/Linear-inspired
| # | Task | Files | Status | Notes |
|---|------|-------|--------|-------|
| UI-1 | Centralize design tokens | public/theme.css + strip per-page :root | ✅ done | theme.css is now the single source of tokens (light+dark); removed the 4 pages' own :root blocks → one change restyles everything |
| UI-2 | Vercel-clean palette/type | theme.css | ✅ done | refined neutrals, crisp 1px borders, minimal shadow, tighter radius (10px), restrained violet accent, Inter, focus rings, quiet scrollbar |
| UI-3 | Declutter headers | theme.css (.top logo/sub hidden) | ✅ done | left rail carries the brand; pages lead with just their title. Verified /jobs + /edit render clean, no console errors |

## Archive
(see onboarding-v1-plan.md for the delivered v1 pipeline; older plans archived there)
