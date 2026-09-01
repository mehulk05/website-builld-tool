# Plan: Designer feedback loop on beta sites  (started 2026-09-01)

Goal: an authorised designer selects a live beta-site element, batches page-specific feedback,
and submits once; the build tool safely resolves, patches, verifies, auto-merges, deploys and
reports each item without a human approval step.

## Architecture decision

Extend the first-party review system already present in `public/review-widget.js`,
`review-plugin.js`, and the `runEditJob` GitOps pipeline. Do not build a second widget, token
system, queue, PR implementation, or WPCode delivery path.

The mutation unit is a **section patch bundle**: one targeted Elementor HTML widget plus only
the scoped CSS needed for that section. The stable Elementor id locates the section; a clicked
descendant fingerprint identifies the exact button/link/image inside it. The submission also
records the current Git commit and fragment hash, so a queued item can detect drift instead of
silently modifying a different section.

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Define annotation contract | lib/feedback/schema.js (new), public/review-widget.js, review-plugin.js | ⏳ pending | Browser sends page, Elementor id, note, clicked tag/text/attributes/relative path, viewport and rect; backend adds current Git SHA + fragment hash. Browser HTML is a hint, never the source of truth. |
| 2 | Add durable feedback ledger | lib/feedback/store.js (new), server.js, .env.example | ⏳ pending | Persist batches/items/status/attempts/PR/deploy SHA through the existing NocoDB integration; `jobs.json` stays an execution cache because local disk is not restart-safe. Add an idempotency key. |
| 3 | Extend element picker UI | public/review-widget.js | ⏳ pending | Keep exact-text review mode; add Design mode with hover outline, click-to-pin, note box, queued markers, page-level Submit, Escape and mobile-safe controls. Resolve the nearest Elementor HTML-widget wrapper. |
| 4 | Forward batches securely | review-plugin.js, server.js | ⏳ pending | Reuse signed `?g99r=` redemption, HttpOnly cookie, same-origin WP REST proxy and `/api/webhook/review/feedback`; extend validation/limits instead of exposing the build-tool API or secrets to browser JS. |
| 5 | Resolve against Git HEAD | lib/feedback/resolve.js (new), gitops-json.js | ⏳ pending | Require one matching widget id. Record main SHA/hash. Missing, duplicate, retyped or fingerprint-mismatched targets become item-level `conflict`; never guess from coordinates. |
| 6 | Coalesce section feedback | lib/feedback/patch.js (new), server.js | ⏳ pending | Group by repo + page + widget id. All notes on one section go into one Gemini call, while separate sections are committed atomically in one submitted-batch PR. |
| 7 | Patch HTML and scoped CSS | lib/feedback/patch.js (new), gitops-json.js | ⏳ pending | Return `{html, scopedCss, addressedItemIds}`. Apply deterministic text/href edits directly; use Gemini for layout/style/reorder. Prefix CSS with `.elementor-element-<id>` and write via the existing page CSS/carrier channel. Never regenerate a page. |
| 8 | Add automatic patch gates | lib/feedback/validate.js (new), gitops-json.js, server.js | ⏳ pending | JSON parses; id survives; only allowed widget/page CSS changes; notes have diff evidence; byte/DOM caps pass; safe URL schemes only; no scripts, event handlers or iframes. A failed item is not merged. |
| 9 | Serialize repo revisions | lib/feedback/store.js (new), server.js | ⏳ pending | One active mutation per repo. Re-fetch/rebase on latest `main` before commit; stale batches re-resolve by id + hash. One submission creates one PR, not one PR per note. |
| 10 | Reuse PR/deploy pipeline | server.js | ⏳ pending | Extend `runEditJob`, GitOps virtual views and existing GitHub App clone → branch → PR → auto-merge. PR lists every note, target id, validation result and before/after hash. |
| 11 | Add visual safety/rollback | lib/feedback/visualCheck.js (new), server.js | ⏳ pending | Playwright desktop/mobile pre-merge smoke rejects blank/overflow/broken output. After exact deploy SHA succeeds, verify live target; deterministic regression triggers conditional auto-revert only when main has not moved past our lineage. Ignore the known transient deploy access-denied flake. |
| 12 | Report item outcomes | public/review-widget.js, public/job.js, server.js | ⏳ pending | Show queued/running/live/conflict/failed per item. Durable ledger + PR provide audit after restarts; ambiguous feedback is explicit, never silently dropped. |
| 13 | Test resolver and drift | test-feedback.js (new), test-gitops-json.js | ⏳ pending | Cover exact/child id, same-section multi-note, reorder, missing/duplicate id, concurrent batch, CSS/link edit, unsafe output, retry idempotency and conditional rollback. |
| 14 | Run staged Nuvo E2E | public/review-widget.js, server.js, resources/pages/home/elementor.json | ⏳ pending | Dry-run → local checkout → live beta. Submit padding + footer-link + reorder notes; prove one PR, merge, deploy SHA, browser result, persistence and no widget for normal visitors. |
| 15 | Persist the queue across page navigation | public/review-widget.js | ⏳ pending | Found reading the SHIPPED widget: `queue` is an in-memory JS array only — a real page load (no SPA here) reruns the script fresh, so unsubmitted items are silently lost the moment the reviewer clicks to another page without hitting Apply first. The panel's own copy ("add changes across as many pages as you like") already promises this and isn't true yet. Fix: `localStorage`-back the queue, tag each item with the page it was added on, hydrate on load so the launch-button counter is correct immediately. Per-page early-submit stays available — this only stops navigation from being a trap. |
| 16 | Multi-page batch → one job/PR | public/review-widget.js, review-plugin.js, server.js (`reviewWorkOrder`:5817, `enqueueEditJob`:7168, `reviewSwapTiers`:5836) | ⏳ pending | A global "Submit N across M pages" button sends one batch spanning pages. Correction to an earlier claim in this plan: `reviewSwapTiers` already scopes a swap strictly to the ONE page's file (gitops: `resources/pages/<slug>/elementor.json`; classic: that page's template + the header/footer tier) — it does NOT search the whole repo. So a multi-page batch is not a scope-widening risk: group items by page client- and server-side, call the existing per-page swap/tier logic once per distinct page in the batch, still one PR. `changes[]` gains a per-item `path` (today `path` is one top-level field for the whole request). |
| 17 | Session overview panel (group by page → section) | public/review-widget.js | ⏳ pending | Restructure `showQueue()`: group queued items under a "Page: /slug (N)" heading, then under each page group show section/element label (human name resolved from the Elementor id, not the raw hash) + note text + thumbnail if a screenshot was attached + × remove — before submit, across the whole persisted (task 15) session, not just the current page. Launch-button badge shows the total across all pages. |
| 18 | Optional per-item screenshot | public/review-widget.js, review-plugin.js, server.js, lib/feedback (new store target) | ⏳ pending | On "Add change"/note, rasterize just the target element's bounding box to a PNG (a small vendored DOM-rasterization lib — html2canvas-class, no permission prompt, unlike a real screen-capture API). Optional per item, not mandatory. Save the crop to disk (same pattern as existing downloaded-image handling) and store a reference in the ledger, not a base64 blob inline — keeps ledger rows small. Also handed to Gemini as extra visual context at patch time (task 7/6), which helps most on vague notes ("this looks off") a text-only diff can't disambiguate. |

## Automatic conflict policy

- Unchanged unique id + fragment hash: patch normally.
- Changed fragment: rebase only if the clicked descendant fingerprint still resolves uniquely.
- Missing/duplicated id, ambiguous target, cross-page request, unsafe output or failed visual gate:
  mark that item `conflict`/`failed`; do not guess and do not merge it.

## Not in v1

Sitewide/global design-system feedback ("every button everywhere"),
native Elementor widget editing, arbitrary element deletion, and a human approval queue. Internal
screenshots used by automated validation are in scope; they are not reviewer attachments.
(Cross-PAGE batching of one reviewer's own notes — task 16 — is now in v1; it is a narrower thing
than sitewide feedback: still one reviewer's own session, still resolved per-page, just submitted
together instead of one page at a time.)

## Post-submit review gap (also found reading the shipped widget, not yet a task)

After Apply, the widget polls status and shows step progress then "Your changes are live" (or the
`refused` list with reasons) — but no before/after diff of what actually landed, and nothing
persists past that panel for the reviewer to look back at later. Worth a task if Mehul wants it;
holding off since it wasn't asked for yet.

## Archive

### Plan: Output G99 GitOps `resources/` format instead of PHP theme  (started 2026-08-21 → done)

Goal: a build job produces a repo in the **mcptest2.gogroth.com template format** — a `resources/` tree
(pages as Elementor JSON + resource.json + seo.json, media binaries + ref JSON, menus/site config) that
the G99 MU-plugin reconciles into WordPress — instead of today's Bedrock repo with a custom PHP theme
(`web/app/themes/g99-*`). TED events unchanged.

## What the target format is (from mcptest2 ARCHITECTURE.md)

- Repo = desired state, NOT a WP install. Only `resources/` is site-specific; workflow + `web/app/mu-plugins/g99-control/` are shared fleet files that come from the template and must not be generated or touched by us.
- Per page: `resources/pages/<slug>/{resource.json, elementor.json, seo.json}`.
  - `resource.json`: schema_version, git_id (stable!), type, slug, title, status, page_template `elementor_header_footer`, featured_image `media:<ref>`.
  - `elementor.json`: schema_version 1, elementor_version "3", `elements[]` — Elementor container/widget tree.
  - `seo.json`: provider rank_math, title/description/focus keyword.
- Media: `resources/media/<File>.webp` + `<ref>.json` ({ref, file, alt, caption}); referenced as `media:<ref>`.
- Site-level: `menus.json`, `site.json`, `taxonomies.json`, `theme-mods.json`, `widgets.json`, `custom-css.css`, templates/ (header, footer, default-kit …).
- `{{SITE_URL}}` is the portable token for internal links.
- Deploy: push to branch → signed webhook → plugin fetches, validates, reconciles transactionally.

## Key design decision (needs Mehul's confirmation)

Our webgen pages are hand-crafted HTML/CSS — Elementor has no widget for them. Options:

- **A (recommended v1): section-as-HTML-widget.** Split each generated page into its sections; each section becomes an Elementor container holding one `html` widget with that section's markup. Page CSS goes to `resources/custom-css.css`. Pixel-identical to today's output, valid Elementor JSON, editable per-section in the WP editor.
- **B: full native-widget mapping** (heading/text-editor/image/button widgets). Real Elementor editability, but a large mapping layer and design fidelity loss. Later phase if needed.

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Confirm format details w/ MCP repo owner | — | ✅ done | Does the reconciler accept `html` widgets? Is default-kit/header/footer template mandatory or does the destination site already have them? Which repo will jobs push to? |
| 2 | GitOps resource compiler | new lib/gitops/compile.js | ✅ done | `compileResources(pages, biz, media)` → in-memory file map of the whole resources/ tree. Pure function, unit-testable offline |
| 3 | HTML → elementor.json (option A) | lib/gitops/elementor.js, reuses section split like splitPage (server.js:~1200) | ✅ done | container + html-widget per section; stable element ids (hash of slug+index) so re-deploys don't churn |
| 4 | resource.json + seo.json per page | lib/gitops/compile.js | ✅ done | git_id = `page-<slug>-<jobhash>` stable across pushes; SEO title/desc from onboarding data (rank_math fields, like mcptest2 samples) |
| 5 | Media pipeline → resources/media | lib/gitops/compile.js, localizeImages (server.js:9772) | ✅ done | Localized images already downloaded → copy binary + write ref JSON; rewrite page URLs to `{{SITE_URL}}`-relative media paths |
| 6 | Site config JSONs | lib/gitops/compile.js | ✅ done | menus.json (Home/Services/About/Contact), site.json (business name, tagline), custom-css.css (webgen page CSS), minimal taxonomies/theme-mods/widgets stubs |
| 7 | Output-format switch in build job | server.js runJob, buildWpTheme (server.js:1395) | ✅ done | `OUTPUT_FORMAT=gitops` env / payload flag. gitops path replaces buildWpTheme; PHP-theme path stays default until proven. Same job type → postStatus/TED untouched |
| 8 | Commit/PR flow to template-based repo | server.js push/PR helpers (:6796, :9075) | ✅ done | Clone target repo (created from mcptest2 template), replace ONLY resources/, branch + PR. Never touch .github/ or mu-plugins/ |
| 9 | Local E2E: compile from a finished job | test script | ✅ done | Run compiler on an existing GEN/site output; validate JSON shapes against mcptest2 samples |
| 10 | Live E2E on a test repo | mcptest2 or a new template copy | ✅ done | Real job → PR → merge → plugin reconciles → pages render on the WP site. Definition of done |

## Definition of done

A build-tool job pushes a `resources/` tree to a template-based repo, the G99 plugin imports it without
validation errors, and the four pages (home/services/about/contact) render on the WordPress site looking
the same as today's theme output. TED event log diff vs a normal build = empty.

## Not in v1

Blog posts, products, astra-portfolios, popups, per-service pages, Elementor native-widget mapping (option B),
WordPress→Git reverse sync (plugin handles that).

### Plan: Use the medspa-tool process inside the build tool (2026-08-15 → done ~2026-08-19)
Shipped as the `webgen` engine (lib/webgen/*): scrape → BrandKit → code-rendered pages, blueprint designs,
deterministic site-derived theming, localized images, premium contact/footer, TED event parity proven.
Full original table recoverable from git history of PLAN.md.

### Plan: designgen polish — remove floating book-tab, fix invisible ghost-button text (2026-09-01 → done)
Two live bugs on nuvo (job nuvo-cta-fix-1): (1) a fixed side "Book a Visit" tab (`.c-book-tab`) the
user didn't want — removed the prompt line that told Gemini to use it, plus a defensive strip of any
`.c-book-tab` element Gemini emits anyway (`lib/designgen/index.js`, per-page loop). (2) CTA-band ghost
buttons ("CONTACT US"/"BOOK NOW" on a dark band) rendered BLACK text, invisible — root cause: pages ship
as Elementor html-widgets, and the site's own kit CSS has a more specific `a` rule (`.elementor-widget-container a`,
specificity 0-1-1) that beats our plain `.c-btn`/`.c-btn--ghost` class rules (0-1-0 each) and overrides
the button's `currentColor` text to Elementor's default. Fix: `background`/`color`/`border` on the base
`.c-btn` rule in `lib/designgen/assets/system.css` now carry `!important` — vendored framework CSS, so
every future generation gets it automatically. Verified live on all 4 pages: no floating tab, every
CTA/ghost button white text, footer parity fix (previous entry) still intact.
