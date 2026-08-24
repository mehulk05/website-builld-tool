# Plan: Output G99 GitOps `resources/` format instead of PHP theme  (started 2026-08-21)

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

## Archive

### Plan: Use the medspa-tool process inside the build tool (2026-08-15 → done ~2026-08-19)
Shipped as the `webgen` engine (lib/webgen/*): scrape → BrandKit → code-rendered pages, blueprint designs,
deterministic site-derived theming, localized images, premium contact/footer, TED event parity proven.
Full original table recoverable from git history of PLAN.md.
