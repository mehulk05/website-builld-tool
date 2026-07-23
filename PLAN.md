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
