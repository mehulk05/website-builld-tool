# Bug report: Edit jobs can merge cleanly and still never appear on the live site

**Status:** Root cause fixed for the two pages already affected (PR #147). Underlying pipeline gap **not** fixed — will recur on the next site that adds a page this way.
**Reported by:** Bishakha Gupta (via Growth99 Studio local tool)
**Date found:** 2026-08-07
**Affected tool:** Growth99 Website-Build Tool (`server.js`), Edit job pipeline (`/api/edit-run`, `runEditJob`)
**Affected site:** NUVO Aesthetics Clinic — `prodteam.gogroth.com` (repo `G99agency/prodteam.gogroth.com`)

---

## Summary

An "Edit with AI" request to add a new service page (**Alma FemiLift**) ran end-to-end without any visible error: the AI wrote correct code, opened a PR, CI passed, the PR merged, and the tool's own job log reported **"Done — change is live on merge/deploy."** The page was, in fact, **not live** — it 404'd, wasn't in the sitemap, and wasn't linked anywhere on the site. A second, unrelated edit ("Add GIA Membership page") hit the identical failure the same day.

This is two bugs stacked on top of each other:

1. The AI edit was **logically incomplete** — correct code, but missing a required companion change specific to this site's provisioning mechanism.
2. The tool's job pipeline **asserts "live" without verifying it** for edit jobs, unlike build jobs which do verify.

---

## Impact

- Any edit job that adds a page to a site using this same mu-plugin provisioning pattern can silently no-op on WordPress's side while reporting full success in Studio (job status "Done", PR merged, no error anywhere).
- The failure is invisible unless someone manually opens the resulting URL. Nothing in the job log, the PR, or the CI checks flags it.
- Confirmed to have happened **twice in one day** on the same site, independently, from two unrelated edit requests.

---

## Root cause

### How this site creates WordPress pages

The theme repo does not create pages the normal WordPress way. An mu-plugin (`web/app/mu-plugins/g99-activate-nuvo-aesthetics-clinic-gia-upsel.php`, runs on every request via `init`) holds a hardcoded array of every page the site should have:

```php
$pages = [
    ['title' => 'Home', 'slug' => 'home', 'template' => ''],
    // ...
    ['title' => 'Bio-identical HRT', 'slug' => 'bio-identical-hrt', 'template' => 'page-service-bio-identical-hrt.php'],
];
```

A function walks this array and, per entry, calls `get_page_by_path($slug)` — if the page doesn't exist yet, it creates it (`wp_insert_post`), then rebuilds the primary nav menu from scratch. This is how new pages normally get added: append a row, push the code, WordPress notices and creates it on next load.

### The guard that silently blocked it

Running that full check-and-create pass on every page load would be wasteful, so it's wrapped in an idempotency guard keyed to a hardcoded build identifier:

```php
$build = '202608071307';   // baked in at generation time, NOT derived from git/file content

if (get_stylesheet() === $slug && get_option('g99_provisioned_' . $slug) !== $build) {
    g99_provision_nuvo_aesthetics_clinic_gia_upsel();
    update_option('g99_provisioned_' . $slug, $build);
}
```

Meaning: *"Have I already provisioned pages for build `$build`? If yes, skip."* WordPress stores the last-provisioned build ID in the database (`g99_provisioned_<slug>` option). The **only** thing that makes WordPress re-check the page list is `$build` itself changing.

### Why the edit silently failed

The "Create Alma FemiLift" edit job correctly:
1. Wrote the new page template (`page-service-alma-femilift.php`)
2. Added the new row to `$pages` in the mu-plugin
3. Committed, pushed, opened [PR #145](https://github.com/G99agency/prodteam.gogroth.com/pull/145), watched CI, merged it

It never touched `$build`. On the live site, WordPress checked its stored option, saw it still matched the unchanged `$build` value, concluded "already provisioned, nothing to do," and skipped the entire function — including the brand-new row sitting right there in the array. Nothing about this trips a PHP error, a failed CI check, or a failed merge: the code is 100% syntactically and logically valid PHP. It's just never executed on the branch that matters (creating the new page).

The AI editor had no way to know this convention exists — it isn't documented anywhere in the file it was editing (the array), only inferable from a separate guard condition elsewhere in the same file that the edit's scope never touched.

### Why the tool reported success anyway

`runEditJob`'s final step for a merged PR is:

```js
jobStep(job, 6, "done", "Done — change is live on merge/deploy");
```

This is an **assertion**, not a check. Compare this to the **build** job pipeline, which after merge actively polls the live site (`/api/theme-live`) until it detects the new theme is genuinely active before declaring itself done. The **edit** job pipeline has no equivalent verification step — "merged" and "live" are treated as the same thing, and for most edits (text changes, style tweaks on existing pages) that's a safe assumption. It is **not** a safe assumption for anything that depends on this site's provisioning re-run mechanism.

---

## Evidence

| # | Item | Value |
|---|---|---|
| 1 | Edit job (Alma FemiLift) | `edit-1786108400928` — status `done`, [PR #145](https://github.com/G99agency/prodteam.gogroth.com/pull/145) merged `2026-08-07T13:14:58Z` |
| 2 | Live check before fix | `curl https://prodteam.gogroth.com/service-alma-femilift/` → **HTTP 404**; not present in sitemap; no nav link anywhere |
| 3 | Sibling pages (control check) | `medical-weight-loss`, `ariessence-pure-pdgf`, `bio-identical-hrt` all → HTTP 200 — proves the general mechanism works, isolating the bug to the missing `$build` bump |
| 4 | Second occurrence, same day | A later, unrelated edit ("Add a new 'GIA Membership' page") merged `2026-08-07T13:25:16Z` — same symptom: page in the array, 404 on the live URL |
| 5 | Root cause confirmed | Fetched the live mu-plugin file directly from `main` via `gh api`, found `$build = '202608071307'` unchanged across both affected PRs |

---

## Fix applied (this instance only)

Bumped `$build` in a follow-up commit to force WordPress to re-run provisioning:

```diff
- $build = '202608071307';
+ $build = '202608071330';
```

Shipped as [PR #147](https://github.com/G99agency/prodteam.gogroth.com/pull/147), CI-checked, merged. Confirmed **safe to re-run**: the provisioning function checks `get_page_by_path()` per entry before inserting, so existing pages are left untouched — it only creates what's missing. The menu rebuild on every re-run is intentional, existing behavior (per the code's own comment), not a side effect of this fix.

**Verified after merge:**
- `https://prodteam.gogroth.com/service-alma-femilift/` → HTTP 200, content confirmed (mentions "Alma FemiLift")
- `https://prodteam.gogroth.com/gia-membership/` → HTTP 200 (the second stuck page, fixed by the same commit)

This is a **patch for the two already-broken pages**, not a fix to the pipeline. The next edit that adds a page to a site using this pattern will hit the exact same bug.

---

## Recommended permanent fix (not yet implemented)

Pick one (or both):

1. **Teach the AI edit planner this convention.** When an edit touches a site's page-provisioning array (detectable by file/pattern), the plan must also bump the adjacent `$build`/version guard in the same file. This fixes it at the source but is fragile — depends on the AI reliably recognizing the pattern every time, on this site and any other site using the same convention.
2. **Add a post-merge live-verification step to edit jobs**, the way build jobs already do. After merge, if the edit's plan included creating a new page, poll the resulting URL (or check the sitemap) before declaring the job "Done." If it's not live within a reasonable window, report the job as **"Merged but not confirmed live"** instead of "Done" — turning a silent failure into a visible, actionable one. This is the more robust fix: it doesn't require the AI to know every site's internal conventions, it just stops the tool from asserting something it never checked.

Option 2 is the stronger fix on its own — it would have caught this specific bug (and any future, differently-caused version of the same "merged but didn't take effect" failure mode) without needing to special-case this one site's provisioning convention.

---

## Files/PRs referenced

- Buggy edit (page never went live): [PR #145](https://github.com/G99agency/prodteam.gogroth.com/pull/145)
- Second occurrence: "Add a new 'GIA Membership' page…" edit, merged `2026-08-07T13:25:16Z`
- Fix: [PR #147](https://github.com/G99agency/prodteam.gogroth.com/pull/147)
- Root cause file: `web/app/mu-plugins/g99-activate-nuvo-aesthetics-clinic-gia-upsel.php`
- Tool code involved: `server.js` — `runEditJob()`, step 6 ("Sync registry" / final "Done" assertion)
