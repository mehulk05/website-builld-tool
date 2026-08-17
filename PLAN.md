# Plan: Use the medspa-tool process inside the build tool  (started 2026-08-15)

Goal: generate the website the **same way the medspa mockup tool does** — AI writes only the *content*,
the *layout* is code — but take the input from the **onboarding data that already arrives**, not from a
user-typed URL. Pages must be as good as today's, and **every TED event must fire exactly as it does
today** (Mehul: TED subtasks close off those events).

Decided 2026-08-15: **home page only** for v1. Playwright, same as the medspa tool.
Prior plans deleted per Mehul; recoverable from git at `2db745d`.

## The process we are copying

This is the medspa tool's pipeline, and what each step becomes here.

| Medspa tool (today) | In the build tool | What changes |
|---|---|---|
| 1. User pastes a URL in a box | `existingWebsite` + `referenceWebsite` from the onboarding payload | **No input box.** Both URLs already arrive — see onboarding.sample.json |
| 2. Playwright scrapes: colors, fonts, images, screenshot | Same, but **two** scrapes | `referenceWebsite` → design only. `existingWebsite` → images + facts |
| 3. One Gemini call → BrandKit JSON (theme + all copy) | Same call, **seeded with the onboarding answers** | Business name, services, team, hero headline, review are already given — AI invents far less |
| 4. Template function renders HTML (code, no AI) | Same three templates | Layout is deterministic → no per-page drift |
| 5. Show the page | Hand off to the **existing** pipeline | assemble → WP theme → PR → CI → merge, all unchanged |

Step 5 is why this is cheap: everything after "render HTML" already works and is engine-agnostic.

## The one thing that must not break: TED events

TED is **not** called directly by this tool. The chain is:

```
jobStep()  →  postStatus(job)  →  POST G99_STATUS_CALLBACK_URL
                               →  product-service writes ledger events
                               →  TED polls the ledger  →  subtask closes
```

So:

- **`postStatus()` ignores anything that isn't `job.type === "build"`** (server.js:6158). Editorial must run
  *inside* the normal build job. A new job type or a side route emits **nothing** — silently — and TED
  subtasks stop closing.
- **`JOB_STEP_KEYS` (server.js:3146) are positionally paired with `JOB_STEPS`.** Step 2's label says
  `"Generate pages (Stitch)"`; the label may change, the **key `generate_pages` must not move**.
- `tedPushArtifacts("SERVICE_PAGES_CREATED", …)` (server.js:6804, :10130) is a **separate** route and must
  keep firing too.

`job.emit.eventLog` (server.js:6068) already records which event fired at which step, so we can **prove**
parity by diffing a stitch build against an editorial build.

## Definition of done

1. Editorial build produces a home page that reaches a merged PR.
2. `job.emit.eventLog` diff vs. a stitch build = **empty** (same events, same step keys).
3. `croAudit` score on editorial home ≥ stitch home for the same client.

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Scrape both URLs with Playwright | new lib/editorial/scrape.js | ⏳ pending | Port the medspa `scrape()` as-is. Run it twice: reference (design) + existing (images/facts). Add `playwright` to package.json |
| 2 | Verify Playwright runs on Render | render.yaml, render-build.sh | ⏳ pending | Needs a browser download + memory on a free dyno. Do this **early** — if it fails, fall back to the existing `readSiteBrand` (:2072) and we lose the screenshot, not the plan |
| 3 | BrandKit extractor, seeded with onboarding | server.js new `extractBrandKit()` near `geminiGenerate` (:1030) | ⏳ pending | One Gemini call → typed JSON. Feed it `A.business_name`, `services_offered`, `team_roster`, `hero_headline`, `featured_review`, `phone_for_website`, `location`. Go through the existing `aiCall` wrapper so cost metering + key rotation keep working |
| 4 | Port the three templates | new templates/{base,editorial,bold,minimal,motion}.js | ⏳ pending | Pure `kit → html` functions, no deps |
| 5 | Keep client's own photos; block the reference's | server.js image slots, `unsplashOrCurated` (:1810) | ⏳ pending | **Corrected 2026-08-15 (Mehul):** images from `existingWebsite` are the client's own — keep them, they beat stock. Only guard that `referenceWebsite` images never land in the page. Curated/Unsplash is the **fallback** when a slot has no client photo |
| 6 | **Move CSS out of `<head>`** | server.js `splitPage` (:1200), `buildWpTheme` (:1220), templates/base.js | ⏳ pending | 🔴 **Blocker.** `splitPage()` throws away `<head>` on every page; the templates keep all their CSS in a `<style>` there → theme renders **completely unstyled**. Same cause as the tailwind bug noted at :15709. Emit a stylesheet → `style.css` |
| 7 | **Run inside the normal build job** | server.js `runJob` (:7216), `/api/generate-site` (:15699) | ⏳ pending | 🔴 **The TED constraint.** `engine: "editorial"` is a branch inside the existing build job — not a new job type or route |
| 8 | Engine-aware step label, key unchanged | server.js `JOB_STEPS` (:3135), `JOB_STEP_KEYS` (:3146) | ⏳ pending | Label `"Generate pages (Stitch)"` → engine-aware. **`generate_pages` key must not move or reorder** |
| 9 | Run the existing QC + SEO chain | server.js `seoEnhance` (:2678), `injectCanonicalNav` (:2665), `enforceFooterFacts` (:2227), `qcImageResolution` (:2505), `fixImages` (:1899) | ⏳ pending | Engine-agnostic HTML→HTML passes; this is what makes the page shippable, not just pretty |
| 10 | `tedPushArtifacts` keeps firing | server.js :6804, :10130 | ⏳ pending | Second outbound route, fails independently of `postStatus` |
| 11 | **Prove event parity** | test-full.js, server.js exports (:16340) | ⏳ pending | Diff `emit.eventLog` between a stitch job and an editorial job. **This is the proof your TED subtasks still close** |
| 12 | **Prove quality parity** | server.js `croAudit` (:2955), `pageScore` (:504) | ⏳ pending | Score both engines for the same client; editorial ≥ stitch |
| 13 | Retire CLONE_MODE | server.js `reskinTemplateBrand` (:6910), CLONE_MODE (:7273), reference_sites/ | ⏳ pending | Already a rough version of this idea (patch a frozen HTML file's CSS vars). Editorial replaces it |
| 14 | E2E with real onboarding data | full local | ⏳ pending | Feed onboarding.sample.json → merged PR, with 11 and 12 green |

## Not in v1

About / services / contact pages, and service pages. The three templates are **homepage layouts**. Those
need either a `pages{}` extension to the BrandKit or a new template, and are a separate plan.
