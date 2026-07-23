# Plan (v1, DELIVERED): Webhook-triggered pipeline (G99 form submit → auto beta site)  (started 2026-07-22)

Goal: When a client submits Part 2 (= completes) the onboarding wizard in Growth99, product-service POSTs a webhook to the Render tool, which runs the entire pipeline autonomously (CRO before → prompt → Stitch → assemble → PR → auto-merge → activation watch → CRO after → comparison), persists the before/after report, and shows live job progress in a monitor UI — no human clicks.

Decisions:
- Trigger on **Part 2 submit** (wizard is 2 parts = completion); seam = afterCommit hooks in `OnboardingWizardService.submitPart`
- Autonomy: **all steps incl. auto-merge** + comparison report persisted
- Visibility: **jobs monitor in the Render tool**; report also a PR comment for durability

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Server-side pipeline runner (jobs module) | tool server.js | ✅ done | 8-step runJob drives the tool's OWN routes via localApi; JOBS store keyed by draftId; single-concurrency queue; per-step status/detail |
| 2 | Webhook endpoint | tool server.js `POST /api/webhook/onboarding-submitted` | ✅ done | X-Webhook-Secret check (exempt from ADMIN gate); 202 instantly; dedupe by draftId. Verified |
| 3 | Answer mapping G99 → tool schema | tool server.js mapG99Answers | ✅ done | alias table; JSON-string values parsed; site_love_1_url→referenceWebsite; unknown keys kept + warned |
| 4 | Persist before/after comparison report | tool server.js | ✅ done | generated/reports/<draftId>.html+.json at /reports/*; gh pr comment score table on merged PR |
| 5 | Jobs monitor UI | public/jobs.html + jobs.js, GET /api/jobs | ✅ done | live cards; per-page rows; palette + build prompt; before→after |
| 6 | Env (local only) | .env, .env.example, render.yaml | ✅ done | WEBHOOK_SECRET, WP_LIVE_URL |
| 7 | WebsiteBuildNotifier in product-service | g99-product-service WebsiteBuildNotifierService + OnboardingWizardService | ✅ done | fires only when part==2 from afterCommit; async POST + 90s retry; fail-soft; disabled when webhook.url blank |
| 8 | Config + both-apps compile | web & public-api application-local.properties | ✅ done | props in both apps (point at Render); both compiled + restarted |
| 9 | Local E2E (real form → webhook) | full local stack | ✅ done | draft 79 NUVO Part-2 → all 8 steps → PR #11 → auto-merged → activated → CRO 62→78 (+16) → report + PR comment |
| 10 | Render deploy | Render | ✅ done | live at g99-website-build-tool.onrender.com (auth-check 200, webhook gated); tool repo mehulk05/website-builld-tool; local product-service points its webhook at Render |
| 11 | /jobs + job-detail (/dashboard?job=id) enhancements | public/jobs.js, dashboard.js, server job.composed+pages | ✅ done | swatches + build prompt + live/persisted per-page rows on BOTH the list card and the detail (monitor) page |
| 12 | Sonar-check the Java change | WebsiteBuildNotifierService + OnboardingWizardService | ⏳ pending | run before committing the product-service change (still uncommitted in g99-product-service) |
| 13 | Reference-site fix | server.js compose-brand | ✅ done | design language scanned from site_love_1_url (reference) not existing site; per-job cache clear |

## Archive

### Beta-Site Dashboard (one-page 7-step pipeline) — 2026-07-22
CRO→prompt→Stitch→WP+PR→CI watch→auto-merge→activation→CRO compare. 27 tasks done except styling pass (backlog). Highlights: deviceType-casing fix, mu-plugin auto-activate+provision, Gemini CI auto-fix, auto-merge, activation watch, Render deploy-ready.

### Élan Medical Aesthetics beta site (hand-built, ruma.com-inspired) — 2026-07-20
Polished 4-page static site in generated/site-claude/. 7/7 done.
