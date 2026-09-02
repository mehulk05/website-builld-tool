# Plan: Designer feedback loop — delivery and capability  (updated 2026-09-02)

Goal: a designer opens a signed link on a live beta site, leaves notes, presses Submit
once, and the build tool applies what it safely can, refuses the rest out loud, and
says which is which.

Proven end to end on nuvo this session: widget delivered by gitops, running against a
tunnelled local build tool, three batches applied and verified live (PRs #112-#114).

| # | Task | Files / area | Status | Notes |
|---|------|--------------|--------|-------|
| 1 | Widget cross-origin transport | public/review-widget.js | ✅ done | token in body/query, credentials omit |
| 2 | Loader snippet builder | lib/feedback/loader.js | ✅ done | URL stripped, sessionStorage only |
| 3 | Ship loader as its own wpcode CPT | lib/feedback/loader.js | ✅ done | snippet 71 live on nuvo |
| 4 | CORS on review endpoints | server.js | ✅ done | evil origin 403, preflight 204 |
| 5 | Serve review-widget.js cross-origin | server.js | ✅ done | now unused — widget is inlined |
| 6 | Cap TTL for browser-held tokens | server.js | ✅ done | 7d asked → 2h given |
| 7 | Token revocation | server.js | ✅ done | POST /api/review/revoke |
| 8 | Per-token batch cap | server.js | ✅ done | 429 past the cap |
| 9 | Ship to nuvo + verify live | nuvo repo | ✅ done | PR #113 — change visible on the live site |
| 10 | Deploy tool changes to onrender | git push → render | ✅ done | see D1 |
| 11 | Preview surface | server.js | ✅ done | /preview/gitops-review |
| 12 | Emit review cpt from compile.js | lib/gitops/compile.js | ⏳ pending | tracked as D2 |
| 13 | Carry taxonomy terms in cpt.json | compile.js | 🚫 blocked | tracked as D4 / D6 |
| 14 | Reap orphaned batches on boot | server.js | ✅ done | a crash used to hold the site lock and leave the panel polling forever |
| 15 | Reject CSS that hooks onto nothing | lib/feedback/validate.js | ✅ done | found live: a rule for a class never added to the markup reported as applied |
| 16 | Page-level structural operations | new module | ✅ done | done as B1-B3 |
| 17 | Tell the reviewer what cannot be done | review-widget.js | ✅ done | done as A2 / A7 |

## Task status

Three states, and "partial" is used honestly: a task is partial when it works for
the case it was built against but not for the case a designer will actually hit.

| # | Task | Status | What is actually left |
|---|------|--------|-----------------------|
| 1 | Widget cross-origin transport | ✅ done | — |
| 2 | Loader snippet builder | ✅ done | — |
| 3 | Ship loader as a wpcode CPT | ⚠ partial | reaches the site, but lands as an HTML snippet in the header. Two dropdowns per site by hand until D4/D6 |
| 4 | CORS on review endpoints | ✅ done | — |
| 5 | Serve review-widget.js cross-origin | ✅ done | now unused — the widget is inlined |
| 6 | Cap TTL for browser-held tokens | ✅ done | — |
| 7 | Token revocation | ✅ done | — |
| 8 | Per-token batch cap | ✅ done | — |
| 9 | Ship to nuvo + verify live | ✅ done | — |
| 11 | Preview surface | ✅ done | — |
| 14 | Reap orphaned batches on boot | ✅ done | — |
| 15 | Reject CSS that hooks onto nothing | ✅ done | — |
| A1 | Classify a note before acting | ✅ done | F3's model classifier reads it first, keywords as the fallback and as the veto on removals |
| A2 | Refuse what cannot be done, out loud | ✅ done | a stopgap by design — each rule leaves as its writer lands |
| A3 | Fix nested page slugs | ✅ done | — |
| A4 | Report what actually changed | ✅ done | — |
| A5 | Sweep source for control bytes | ✅ done | — |
| A6 | Name the section a note was left on | ⚠ partial | applied notes now name the section the CLICK landed in (G4). Out-of-scope refusals still show none — that is A8 |
| A7 | Per-note outcomes on the run page | ✅ done | — |
| A8 | Section name on out-of-scope refusals | ⏳ pending | send the section text from the widget instead |
| B1 | Page-level structural operations | ✅ done | insert, remove and move all complete; move takes a named target (F1) and remove acts on one section (G2) |
| B2 | Safety check for a changed node set | ✅ done | — |
| B3 | Generate one new section's markup | ✅ done | — |
| D1 | Deploy the tool to onrender | ✅ done | merged as #57; render serves the new widget and ran the image batch that became #136 |
| D2 | Emit the review cpt from compile.js | ⏳ pending | worth little until D4/D6 |
| D3 | Backfill the widget to existing sites | ⏳ pending | — |
| D4 | Carry taxonomy terms in cpt.json | 🚫 blocked | infra say the importer is fixed; UNVERIFIED — no deploy has touched resources/cpt since |
| D5 | Survey the fleet for WPCode | ⏳ pending | verified on two sites, unknown on the rest |
| D6 | Admin sync strips the taxonomies block | 🚫 blocked | seen live: 2db4b30 added it, 646f37d removed it |
| F1 | Move to a NAMED section | ✅ done | matchSection now runs over VISIBLE sections, not containers |
| F2 | Insert an image where there is none | ✅ done | image.js places an <img> in the last .u-wrap |
| F3 | Model-based intent | ✅ done | intentAI.js, keywords as the fallback. May no longer force a removal on its own — G1 |
| F4 | Site-wide CSS writer | ✅ done | sitecss.js writes into the data-g99-css carrier on every page |
| F5 | Same change across pages | ✅ done | site.js applyEverywhere, reports the page count |
| F6 | Menu writer | ✅ done | nav is inlined per page; rewritten once and copied, link count may not fall |
| F7 | SEO writer | ✅ done | writers.js writeSeo, Rank Math and Yoast field maps |
| F8 | Page creator | ✅ done | copies the donor's chrome and page CSS, else the page renders unstyled |
| F9 | Media library upload | ⏳ pending | NOT blocked by the reconciler, as long assumed. Uploading to the live site at note time returns the real wp-content URL, which is written into the markup like any other absolute src — the same shape as the ruma.com hotlinks already there, so nothing has to resolve a media ref. The only blocker is a credential: POST /wp/v2/media answers 401 rest_cannot_create, not "unsupported" |
| G1 | A model may not force a removal | ✅ done | intentAI.js — "Remove this card" took a whole band off a live site. A removal now needs the words to agree |
| G2 | Remove one section, not its container | ✅ done | structure.js — c076a1e held two bands; removing one took both. Now removes the widget, container only if emptied |
| G3 | "don't remove X" is not a removal | ✅ done | intent.js maskNegations — the one failure that turned a note into its opposite |
| G4 | Name the section that was clicked | ✅ done | run.js reads the label off the widget, not the container's first child |
| G5 | Say when an earlier note removed the section | ⏳ pending | i1/i3 in #130 got a bare "no longer on the page" and no reason |
| H1 | Offer the picture control where there is no picture | ✅ done | review-widget.js — insertImage existed and could not be reached; the upload only appeared over an existing <img>. Shipped to nuvo as #135 |
| H2 | A note carrying a file skips the classifier | ✅ done | run.js — the model answering "image" routed it to the branch that refuses image notes for having no image attached |
| H3 | Publish an attached picture end to end | ✅ done | proved on the deployed tool: #136 added one where the band had none and swapped one where it did. Over a free ngrok tunnel the render gate refused it — correctly, since ngrok serves browsers an interstitial instead of the file |
| H4 | Show the pictures on the run page | ✅ done | job.js — "markup adjusted" is a true and useless answer to "did my photo go on". Before/after for a swap, one thumbnail for an addition |
| H5 | One vocabulary for a structural note | ✅ done | patch.js kept its own word list and had never heard of "take it out"; the note was carried out and then rejected for doing it. The guard now asks intent.js |
| H6 | Attached pictures die on every deploy | ⏳ pending | render's disk is ephemeral, so every picture a reviewer has attached 404s on the next release. Seen live: #136's photo was already dead. Nuvo carries none today — 30 images, all ruma.com — so a deploy breaks nothing until the next upload. F9 is the fix; a render persistent disk is the stopgap |
| H7 | An unplaceable picture must not reach the model | ✅ done | patch.js — a photo attached to a band holding four of them fell through to the model, which invented a filename, replaced a founder's headshot with a URL nobody created, ignored the upload, and reported it applied. Now refused, with the way out |
| H8 | The render gate trusts HTTP 200 | ⏳ pending | ruma.com answers a missing file with its 404 page under 200, so a broken picture passed. Check the content type, not just the status |

Totals: 39 done, 2 partial, 8 pending, 2 blocked.

H6 is the one to read: the picture handling is correct and the place those
pictures live is not. Until F9 lands, an attached photo is good until the
tool's next deploy and no longer.

G1-G4 are the three bugs #130 shipped to the live site, plus the mislabelling that
hid the worst of them. All four are fixed, covered by tests, and proven on the live
site by #132 — whose own changes were then undone by #133 and #134.

## Why anything is refused at all

Refusing was never the goal. It exists because the tool used to reinterpret a
request it could not carry out and report it as done, and an honest "no" beat a
dishonest "yes".

Every refusal traces to one missing thing — code that writes to that part of the
site. Understanding the ask works; finding the target works; only the writers are
incomplete. So F4 through F9 are one writer each, and as each lands its rule
leaves scope.js and the refusal becomes routing. Nothing is meant to stay
refused.

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
| 2 | GitOps resource compiler | new lib/gitops/compile.js | ✅ done | `lib/feedback/store.js`. One durable ROW PER ITEM (not per batch) — the question the ledger answers is "what happened to this note". Local JSON file is authoritative for the run; NocoDB is a best-effort mirror behind `NOCODB_FEEDBACK_TABLE`, because a reporting outage must not become a feature outage. Idempotency key included. **Not done:** `.env.example` was never touched (the var is documented here instead).
| 3 | HTML → elementor.json (option A) | lib/gitops/elementor.js, reuses section split like splitPage (server.js:~1200) | ✅ done | container + html-widget per section; stable element ids (hash of slug+index) so re-deploys don't churn |
| 4 | resource.json + seo.json per page | lib/gitops/compile.js | ✅ done | git_id = `page-<slug>-<jobhash>` stable across pushes; SEO title/desc from onboarding data (rank_math fields, like mcptest2 samples) |
| 5 | Media pipeline → resources/media | lib/gitops/compile.js, localizeImages (server.js:9772) | ✅ done | Localized images already downloaded → copy binary + write ref JSON; rewrite page URLs to `{{SITE_URL}}`-relative media paths |
| 6 | Site config JSONs | lib/gitops/compile.js | ✅ done | menus.json (Home/Services/About/Contact), site.json (business name, tagline), custom-css.css (webgen page CSS), minimal taxonomies/theme-mods/widgets stubs |
| 7 | Output-format switch in build job | server.js runJob, buildWpTheme (server.js:1395) | ✅ done | `lib/feedback/patch.js`. Deterministic path handles link-destination notes with no model at all; everything else goes to Gemini, one call per SECTION (all of a section's notes together, so two notes don't undo each other). **Changed from plan:** unscoped CSS is now auto-confined (`.elementor-element-<id> ` prefixed) rather than rejected — rejecting it produced a real false success in the rehearsal: the model added a class in the HTML, the rule giving it meaning was dropped, and the item still reported as applied. Prefixing only ever narrows, so it is strictly safer AND it carries out the note.
| 8 | Commit/PR flow to template-based repo | server.js push/PR helpers (:6796, :9075) | ✅ done | Clone target repo (created from mcptest2 template), replace ONLY resources/, branch + PR. Never touch .github/ or mu-plugins/ |
| 9 | Local E2E: compile from a finished job | test script | ✅ done | Per-repo advisory lock in `store.js`, held for the run, heartbeated, expires at 15min so a dead run can't block a repo forever. **Changed from plan:** "one submission = one PR" holds for a notes-only batch. A MIXED batch (notes + exact text pairs) makes two — notes to `runFeedbackJob`, text to the existing `runEditJob` — because merging two very different apply-paths into one runner is where the bugs would be. Mixed batches are the uncommon case.
| 10 | Live E2E on a test repo | mcptest2 or a new template copy | ✅ done | **Changed from plan:** a NEW `runFeedbackJob` rather than extending `runEditJob`. Reuses everything that matters (GitHub App clone, `/api/pr-status`, `/api/pr-merge`, job/step plumbing) but keeps its own flow, because `runEditJob` is built around a planner deciding which files to touch and here the target is already known. PR body lists every note with its page, element id and outcome.

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


---

<details><summary>Previous plan: Designer feedback loop (completed 2026-09-01)</summary>

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
| 1 | Define annotation contract | lib/feedback/schema.js (new), public/review-widget.js, review-plugin.js | ✅ done | Browser sends page, Elementor id, note, clicked tag/text/attributes/relative path, viewport and rect; backend adds current Git SHA + fragment hash. Browser HTML is a hint, never the source of truth. |
| 2 | Add durable feedback ledger | lib/feedback/store.js (new), server.js, .env.example | ✅ done | `lib/feedback/store.js`. One durable ROW PER ITEM (not per batch) — the question the ledger answers is "what happened to this note". Local JSON file is authoritative for the run; NocoDB is a best-effort mirror behind `NOCODB_FEEDBACK_TABLE`, because a reporting outage must not become a feature outage. Idempotency key included. **Not done:** `.env.example` was never touched (the var is documented here instead).
| 3 | Extend element picker UI | public/review-widget.js | ✅ done | Keep exact-text review mode; add Design mode with hover outline, click-to-pin, note box, queued markers, page-level Submit, Escape and mobile-safe controls. Resolve the nearest Elementor HTML-widget wrapper. |
| 4 | Forward batches securely | review-plugin.js, server.js | ✅ done | Reuse signed `?g99r=` redemption, HttpOnly cookie, same-origin WP REST proxy and `/api/webhook/review/feedback`; extend validation/limits instead of exposing the build-tool API or secrets to browser JS. |
| 5 | Resolve against Git HEAD | lib/feedback/resolve.js (new), gitops-json.js | ✅ done | Require one matching widget id. Record main SHA/hash. Missing, duplicate, retyped or fingerprint-mismatched targets become item-level `conflict`; never guess from coordinates. |
| 6 | Coalesce section feedback | lib/feedback/patch.js (new), server.js | ✅ done | Group by repo + page + widget id. All notes on one section go into one Gemini call, while separate sections are committed atomically in one submitted-batch PR. |
| 7 | Patch HTML and scoped CSS | lib/feedback/patch.js (new), gitops-json.js | ✅ done | `lib/feedback/patch.js`. Deterministic path handles link-destination notes with no model at all; everything else goes to Gemini, one call per SECTION (all of a section's notes together, so two notes don't undo each other). **Changed from plan:** unscoped CSS is now auto-confined (`.elementor-element-<id> ` prefixed) rather than rejected — rejecting it produced a real false success in the rehearsal: the model added a class in the HTML, the rule giving it meaning was dropped, and the item still reported as applied. Prefixing only ever narrows, so it is strictly safer AND it carries out the note.
| 8 | Add automatic patch gates | lib/feedback/validate.js (new), gitops-json.js, server.js | ✅ done | JSON parses; id survives; only allowed widget/page CSS changes; notes have diff evidence; byte/DOM caps pass; safe URL schemes only; no scripts, event handlers or iframes. A failed item is not merged. |
| 9 | Serialize repo revisions | lib/feedback/store.js (new), server.js | ✅ done | Per-repo advisory lock in `store.js`, held for the run, heartbeated, expires at 15min so a dead run can't block a repo forever. **Changed from plan:** "one submission = one PR" holds for a notes-only batch. A MIXED batch (notes + exact text pairs) makes two — notes to `runFeedbackJob`, text to the existing `runEditJob` — because merging two very different apply-paths into one runner is where the bugs would be. Mixed batches are the uncommon case.
| 10 | Reuse PR/deploy pipeline | server.js | ✅ done | **Changed from plan:** a NEW `runFeedbackJob` rather than extending `runEditJob`. Reuses everything that matters (GitHub App clone, `/api/pr-status`, `/api/pr-merge`, job/step plumbing) but keeps its own flow, because `runEditJob` is built around a planner deciding which files to touch and here the target is already known. PR body lists every note with its page, element id and outcome.
| 11 | Add visual safety/rollback | lib/feedback/visualCheck.js (new), server.js | ✅ done | `lib/feedback/visualCheck.js` — Playwright desktop+mobile render of every touched page BEFORE the branch is pushed; blank/collapsed/overflowing/broken-image output stops the run. Post-deploy live check reports but never fails (the change is merged by then). **Not done:** automatic rollback/auto-revert. The pre-merge gate means a bad patch shouldn't reach main in the first place; auto-revert is a separate feature and is now listed under Not in v1.
| 12 | Report item outcomes | public/review-widget.js, public/job.js, server.js | ✅ done | Show queued/running/live/conflict/failed per item. Durable ledger + PR provide audit after restarts; ambiguous feedback is explicit, never silently dropped. |
| 13 | Test resolver and drift | test-feedback.js (new), test-gitops-json.js | ✅ done | `test-feedback.js` — 117 assertions, no network/AI/git (the model is stubbed). Covers: id resolution incl. widget-vs-container, missing/duplicate/multi-widget conflicts, drift accept+refuse, same-section coalescing, deterministic link edit incl. ambiguity refusal, every injection gate, CSS confinement, ledger idempotency + repo lock, and the visual judge. **Not covered:** rollback (not built).
| 14 | Run staged Nuvo E2E | public/review-widget.js, server.js, resources/pages/home/elementor.json | ✅ done | Dry-run, local rehearsal AND live beta all run. Live (nuvo, PR #103): 2 notes in, 1 applied + 1 correctly refused, PR opened, CI green, **auto-merged**, deployed, live page verified. Diff was 1 file / 2 lines — only the targeted section's html and its own scoped CSS block. Ledger shows `live` and `conflict` against the right items.
| 15 | Persist the queue across page navigation | public/review-widget.js | ✅ done | Found reading the SHIPPED widget: `queue` is an in-memory JS array only — a real page load (no SPA here) reruns the script fresh, so unsubmitted items are silently lost the moment the reviewer clicks to another page without hitting Apply first. The panel's own copy ("add changes across as many pages as you like") already promises this and isn't true yet. Fix: `localStorage`-back the queue, tag each item with the page it was added on, hydrate on load so the launch-button counter is correct immediately. Per-page early-submit stays available — this only stops navigation from being a trap. |
| 16 | Multi-page batch → one job/PR | public/review-widget.js, review-plugin.js, server.js (`reviewWorkOrder`:5817, `enqueueEditJob`:7168, `reviewSwapTiers`:5836) | ✅ done | A global "Submit N across M pages" button sends one batch spanning pages. Correction to an earlier claim in this plan: `reviewSwapTiers` already scopes a swap strictly to the ONE page's file (gitops: `resources/pages/<slug>/elementor.json`; classic: that page's template + the header/footer tier) — it does NOT search the whole repo. So a multi-page batch is not a scope-widening risk: group items by page client- and server-side, call the existing per-page swap/tier logic once per distinct page in the batch, still one PR. `changes[]` gains a per-item `path` (today `path` is one top-level field for the whole request). |
| 17 | Session overview panel (group by page → section) | public/review-widget.js | ✅ done | `showQueue()` now groups by page (`/slug · N items`) with each item's element/text shown, and the launch badge counts the whole session across pages. **Note:** the section label is the clicked tag + its text, not a friendly name resolved from the Elementor id — the id has no human name anywhere to resolve against.
| 18 | Per-item screenshot | lib/feedback/shot.js (new), server.js | ✅ done | **Design changed during implementation, for the better.** Original plan: rasterize in the browser with an html2canvas-class library. Rejected once writing it — that means inlining ~50KB into every review page through the PHP heredoc, and browser rasterization silently degrades on exactly this content (cross-origin images taint the canvas, webfonts and background-images often do not render). Instead the SERVER captures it with Playwright, which this codebase already runs: given the page URL + the Elementor id, it loads the page, finds `.elementor-element-<id>`, and screenshots that element's box. Better fidelity, no library in the page, tiny payload (no base64 over the WP proxy), and it happens for every item with nothing for the reviewer to do. Trade-off accepted: the capture reflects the page at patch time rather than at note time — fine for a loop that runs in minutes, and the patch resolves against Git HEAD regardless. Feeds Gemini as visual context (task 6/7). |

## Automatic conflict policy

- Unchanged unique id + fragment hash: patch normally.
- Changed fragment: rebase only if the clicked descendant fingerprint still resolves uniquely.
- Missing/duplicated id, ambiguous target, cross-page request, unsafe output or failed visual gate:
  mark that item `conflict`/`failed`; do not guess and do not merge it.

## Not in v1

Sitewide/global design-system feedback ("every button everywhere"), native Elementor widget
editing, arbitrary element deletion, and a human approval queue.

Added to this list during implementation:
- **Automatic rollback / auto-revert after deploy.** The pre-merge render gate is what keeps a
  broken patch off `main`; reverting after the fact is a different feature with its own race
  (main may have moved) and was not built.
- **One PR for a MIXED batch.** Notes and exact text pairs are applied by different runners, so
  a batch containing both opens two.
- **A friendly name for a section.** The overview panel shows the clicked tag and its text; the
  Elementor id has no human-readable name anywhere to resolve against.

## Round two (2026-09-01) — four things Mehul asked for after using it

| # | Task | Files | Status | Notes |
|---|------|-------|--------|-------|
| 19 | Multi-site link UI | public/review-links.html/.js (new), public/nav.js, server.js | ✅ done | `/review-links`: reviewer name + expiry, every known site listed, Create link / Copy / Open. The minting endpoint already existed and was verified against two sites; what was missing was anywhere to press it, so handing links out meant one curl per site. |
| 20 | Attach an image / replace a picture | public/review-widget.js, review-plugin.js, lib/feedback/upload.js (new), lib/feedback/patch.js, server.js | ✅ done | File picker appears on any element containing an `<img>`. Downscaled in the browser to ≤1600px (the batch crosses a WordPress proxy with a 20s timeout), travels inside the note, is written to disk server-side and served from `/feedback-uploads/`. The swap is DETERMINISTIC — no model — and strips `srcset`/`sizes`, which would otherwise keep serving the old picture on most screens. A note left blank is filled in automatically: the picture is the instruction. **Honest limit:** the file is hotlinked from this tool, so the tool must stay reachable — the same arrangement the generated sites already use for every reference-site photo. Putting it in the site's own media library is not possible from here (the reconciler only resolves `media:<ref>` in structured fields, never inside html-widget markup). |
| 21 | Choose one occurrence or all | public/review-widget.js, server.js (`reviewWorkOrder`, `applyTextSwaps`) | ✅ done | When a phrase repeats, the editor offers "Change all N" or "Only the one I selected (#k)". The index is trusted only when the server counts the same number of copies the reviewer was shown — a different count means the page moved under them, and it refuses rather than rewrite the wrong sentence. The `maxHits` ceiling is bypassed for a narrowed change (they already answered the question it asks) and the index is refused across multiple files, where a page-wide position means nothing. |
| 22 | Multi-page preview | tools/build-review-preview.js (new) | ✅ done | `node tools/build-review-preview.js <site>` builds all four pages at `/preview/review-preview-<slug>`, with internal links rewritten so navigation stays inside the preview — which is also what proves the queue survives a page change. |

Two real bugs found while testing this round in a browser, both fixed:
- **`src=` also matched `data-src=`.** `` is not a word boundary against `-`, so the image swap
  rewrote the lazy-load attribute and left the real one alone. Anchored on preceding whitespace.
  (The `` had also been silently turned into a literal backspace byte by a heredoc — twice.)
- **Occurrence count and index disagreed.** The count came from rendered `innerText` (a nav styled
  uppercase reads "CONTACT"), the index from raw DOM text ("Contact") — so the panel said a phrase
  appeared twice and offered to change "#3" of them. Both now read raw DOM text. On the services
  page that is 6 occurrences vs 2, which is exactly how wrong it was.

## Follow-ups after the first demo (2026-09-01)

- **Comment mode is now one click, not three.** Leaving the first note meant open panel →
  "pick an element" → click the thing. The floating control is a real ON/OFF toggle now: one
  click arms commenting (button turns blue, "● Commenting"), every click after that is a note,
  clicking it again gives the page back so the reviewer can navigate. Verified in the preview.
- **Screenshots need no UI and there is nothing for the designer to attach.** They are captured
  server-side per item (`lib/feedback/shot.js`) at patch time — the page is loaded, the section
  found by its Elementor id, and that element's box photographed — then handed to Gemini as
  visual context. Nothing is uploaded from the browser.
- **Multi-site already works, but only via the API.** `POST /api/review/mint {site, reviewer}`
  returns a signed per-site link; the token binds the siteId, so a link for one client cannot
  touch another. Verified against two sites. **Gap: there is no UI for it** — today it is a curl.

## Verification (2026-09-01)

- `node test-feedback.js` — 114 passed, 0 failed. No network, no AI, no git.
- No regressions: `test-gitops-json.js` 52/52, `test-swap-scope.js` 10/10, `test-webhook-auth.js`
  15/15, `test-instruction-source.js` 6/6.
- Local rehearsal against a real nuvo clone with real Gemini: one note applied, one correctly
  refused, render gate passed, **exactly one section changed in the whole file**, CSS landed
  scoped to that section.
- Found and fixed while testing: a pre-existing `pagePath` temporal-dead-zone bug in the review
  endpoint that turned "this tool is not set up to publish" into an opaque 500.
- **Live E2E (nuvo, PR #103)**: opened, CI green, auto-merged, deployed, live page verified clean.
  1 file / 2 lines changed — the targeted section only.

Two real bugs the LIVE run found that no offline test could have:
- **A CSS-only patch was refused.** "Give this heading more space above it" is correctly answered by
  leaving the markup alone and returning CSS — and `checkHtml` treated unchanged markup as failure.
  Now unchanged HTML passes when the CSS carries the change. (Regression test added.)
- **The post-deploy collapse check cried wolf on every healthy page.** It counted any zero-height
  section, which on these sites includes the hidden `<style>` CSS carrier and the fixed nav (and its
  wrapper) — all zero-height by design. Rewritten to ask the question that actually matters: does
  anything INSIDE still render? Verified both ways — a genuinely collapsed section is still caught.


</details>
