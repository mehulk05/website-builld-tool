# Plan: Webhook-triggered pipeline (G99 form submit → auto beta site)  (started 2026-07-22)

Goal: When a client submits Part 2 (= completes) the onboarding wizard in Growth99, product-service POSTs a webhook to the Render tool, which runs the entire 7-step pipeline autonomously (CRO before → prompt → Stitch → assemble → PR → auto-merge → activation watch → CRO after → comparison), persists the before/after report, and shows live job progress in a monitor UI — no human clicks.

Decisions (confirmed by Mehul 2026-07-22):
- Trigger: on **Part 2 submit** (wizard is 2 parts, so = completion; seam = the existing afterCommit hooks in `OnboardingWizardService.submitPart`)
- Autonomy: **all steps including auto-merge** + comparison report persisted
- Visibility: **jobs monitor in the Render tool** (simplest — reuses existing step UI); report also posted as a PR comment for durability

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Server-side pipeline runner (jobs module) | tool server.js | ✅ done | 8-step runJob drives the tool's OWN routes via localApi (http.request — immune to undici timeouts); JOBS store keyed by draftId; single-concurrency queue; per-step status/detail; CI-watch→autofix→merge + activation-watch + after-audit all server-side |
| 2 | Webhook endpoint | tool server.js `POST /api/webhook/onboarding-submitted` | ✅ done | X-Webhook-Secret check (own secret, exempt from ADMIN gate); 202 instantly; VERIFIED: 401 wrong secret, 400 no draftId, 202 accepted, dedupe:true on duplicate |
| 3 | Answer mapping G99 → tool schema | tool server.js mapG99Answers | ✅ done | alias table (practice_name→business_name, patient_value→ideal_patient, team_members→team_roster, website→existingWebsite…); JSON-string values parsed (team_roster→array ✓); unknown keys kept + warned (verified in log) |
| 4 | Persist before/after comparison report | tool server.js writeComparisonReport/postPrComment | ✅ done | generated/reports/<draftId>.html+.json served at /reports/*; gh pr comment with score table on merged PR (durable). Full-run render verified in task 9 |
| 5 | Jobs monitor UI | public/jobs.html + jobs.js, GET /api/jobs | ✅ done | live cards: business, badge, 8 steps w/ detail, PR/site/report links, before→after+delta; 3s poll; auth-gated like dashboard. Renders clean, no console errors |
| 6 | Env (local only — NO deploy per Mehul) | .env, .env.example, render.yaml | ✅ done | WEBHOOK_SECRET=g99-onboarding-tool-webhook in .env; WP_LIVE_URL documented (defaults to prodteam); render.yaml lists WEBHOOK_SECRET for the future deploy — nothing pushed/deployed |
| 7 | WebsiteBuildNotifier in product-service | g99-product-service service module (new class) + OnboardingWizardService | ⏳ pending | fires ONLY when part==2, from the same afterCommit seam as provisioning/HubSpot; async POST {businessId, draftId, businessName, existingWebsite, answers[{key,value,part}]} with X-Webhook-Secret; 1 retry after 90s (Render cold start); fail-soft (never breaks submit); disabled when `websitebuild.webhook.url` blank |
| 8 | Config + both-apps compile + sonar | web & public-api application*.properties | ⏳ pending | submit runs in PUBLIC-API → properties must exist there; keep web in sync (AGENTS.md rule); outbound call ⇒ NO gateway registration needed |
| 9 | Local E2E (real form → webhook) | full local stack | ✅ done | 2026-07-23: real onboarding Part-2 submit (draft 79 NUVO) → notifier → tool job ran ALL 8 steps: CRO 62 → 4 pages (27.6/22.9/18.1/19.8KB) → assemble → PR #11 → CI green → auto-merged → activated on prodteam → after 78 (+16) → report /reports/79.html + PR comment |
| 10 | Dev E2E (Render deploy) | devemr + Render | ⏳ pending | deferred — running local for now; deploy later |
| 11 | /jobs card enhancements | public/jobs.js (+server job.composed) | ✅ done | color swatches on compose step (job.composed, parse-fallback), live per-page rows under generate step (polls /api/generate-progress), score summary. Hot-reloaded without restart; verified on completed job #79, no console errors. Per-page rows render on next running job |
| 12 | Sonar-check the Java change | WebsiteBuildNotifierService + OnboardingWizardService | ⏳ pending | run before any commit of the product-service change |

## Archive

### Beta-Site Dashboard (one-page 7-step pipeline) — started 2026-07-22, completed 2026-07-22
Goal: dashboard page running CRO→prompt→Stitch→WP+PR→CI watch→auto-merge→activation→CRO compare. 27 tasks: all ✅ done except #12 (styling pass — still awaiting UI reference; carried as backlog). Highlights: deviceType-casing root cause fix, mu-plugin auto-activate+provision, CI auto-fix via Gemini, auto-merge, theme-activation watch, Render deploy-ready (env loader, ADMIN_PASSWORD gate, GH_TOKEN, render.yaml).

### Élan Medical Aesthetics beta site (hand-built, ruma.com-inspired) — started 2026-07-20, completed 2026-07-22
Goal: polished 4-page static site in `generated/site-claude/`. 7/7 tasks ✅ done.
