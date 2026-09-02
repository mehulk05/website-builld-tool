# Does `resources/media/` import on deploy?

**Asked because:** a designer reviewing a beta site can attach a photo to a note.
The build tool has nowhere durable to put that photo, so today it writes the file
to its own disk and hotlinks it. Render replaces that disk on every release, so
the photo 404s on the next deploy of the tool — and it has already happened on a
live client site.

The fix we want is the one a human would use: the file goes into the site's own
media library and the markup points at the site's own URL. We would like to do
that **through git**, since that is the channel the tool already has.

---

## What we tried

One image and its sidecar, in exactly the shape `mcptest2.gogroth.com` carries:

```
resources/media/g99-media-probe.webp        (91 KB)
resources/media/g99-media-probe.json        {"ref","file","alt","caption"}
```

Merged to `main` on `G99agency/nuvoaestheticsclinic.gogroth.com`.

## What happened

The plugin reported the deploy as **successful**:

```
GET /wp-json/g99-control/v1/deployment-status?commit=f1afc5ef…&branch=main

  "status": "success", "message": "WordPress deployment succeeded."
  "job": { "id": "deploy-20260902-145843-f3cec4", "status": "success",
           "step": "Verifying", "error": "" }
  "deployed_sha": "f1afc5ef29f2f90ddf40c4a394cd0016699e5d8a"
  "plugin_version": "1.8.3"
```

And nothing arrived:

| Check | Result |
|---|---|
| `GET /wp-json/wp/v2/media` → `X-WP-Total` | **0** (before and after) |
| `/wp-content/uploads/g99-media-probe.webp` | 404 |
| `/wp-content/uploads/2026/09/g99-media-probe.webp` | 404 |
| `/wp-content/uploads/media/g99-media-probe.webp` | 404 |
| `/resources/media/g99-media-probe.webp` | 404 |

`Managed features → Media` is **checked** on this site, so it is not that.

The probe has been removed again (PR #145). Nothing on the site depends on it.

---

## What we need to know

1. **Is media import supported on deploy at all**, or is `resources/media/` written
   by the exporter and ignored on the way in? `mcptest2` carries 257 files there
   and its library has 257 items, which is consistent with either direction.

2. **If it is supported, what does the importer expect** that the mcptest2 sidecar
   shape does not have? A field, a manifest, a reference from content, an
   `attachment` entry somewhere else?

3. **What URL will an imported file get?** This is the part that decides whether
   the git route is usable at all. On mcptest2 the file
   `resources/media/AdobeStock_2069511006.jpg` is served as

   ```
   /wp-content/uploads/2026/08/AdobeStock_2069511006-scaled.jpg
   ```

   — a year/month folder chosen at import time, plus a `-scaled` suffix
   WordPress adds to large images. Neither is knowable when we write the commit.

   That matters because the markup and the file have to travel in the **same
   commit**. Our images live inside an Elementor `html` widget as a raw
   `<img src>`, and `compile.js` records that the reconciler resolves
   `media:<ref>` only in structured fields, never inside html. So we cannot
   reference the file by ref — we have to write a literal URL, and we have to
   know it in advance.

   If the importer could keep the filename as given and skip the date folder for
   files under `resources/media/`, the URL becomes predictable and the whole
   thing is one commit. If not, the git route needs two deploys per photo, which
   is not something a designer should have to wait through.

---

## The alternative, if the answer to (1) is no

A single authenticated endpoint on the plugin:

```
POST /wp-json/g99-control/v1/media      →  { "source_url": "https://…" }
```

behind the shared secret the plugin already holds. The tool uploads at the moment
it applies the note, gets the real URL back, and writes it into the markup — one
run, one commit, no prediction.

We can also do this today with a WordPress application password per site
(`POST /wp/v2/media` answers `401 rest_cannot_create`, so the endpoint works and
only auth is missing). We would rather not: that is one credential per site
across the fleet, each tied to a person's account.

---

## Scope

Nothing is broken right now. Nuvo carries 30 images, all hotlinked from
`ruma.com`, and none from the build tool. The next reviewer who attaches a photo
is the one who hits this.
