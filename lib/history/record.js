// The three moments a build touches its history, packaged so server.js adds
// three one-line calls instead of a page of database code.
//
// Every function here returns fast and never throws: history is a record OF
// the build, not a participant in it. A build with the database down is a
// build, full stop.
"use strict";
const fs = require("fs");
const path = require("path");
const DB = require("./db");

// The slugs a generation produces today, and where their finished HTML lands.
// Read from disk at the END of the run rather than captured mid-pipeline,
// because the queue is single-file: while this job is finishing, GEN/site is
// still this job's output.
const SLUGS = { home: "index.html", services: "services.html", about: "about.html", contact: "contact.html" };

/**
 * Callback arrived: remember the client, open a generation, allocate V<n>.
 * Stows ids on the job so the later calls need nothing else.
 */
async function onJobStart(job, GEN) {
  try {
    if (!DB.enabled()) return;
    const P = job.payload || {};
    const clientId = await DB.upsertClient({
      betaSiteUrl: P.betaSiteUrl || job.liveUrl || "",
      existingSite: P.existingWebsite || "",
      onboarding: P.answers || {},
    });
    if (!clientId) return;
    const gen = await DB.startGeneration({
      clientId,
      engine: P.engine || "editorial",
      jobDraftId: job.draftId,
    });
    if (gen) {
      job._histGenId = gen.id;
      job._histVersion = gen.version;
      console.log(`[history] ${job.draftId} -> ${DB.clientKey(P.betaSiteUrl || job.liveUrl)} V${gen.version}`);
    }
  } catch (e) { console.error("[history] start failed:", e.message); }
}

/**
 * The run is over, either way: store whatever pages exist and close the row.
 *
 * Pages are saved on failure too — "how many times did we generate" counts
 * attempts, and a failed run's pages are exactly what someone debugging it
 * wants to see.
 */
async function onJobFinish(job, GEN) {
  try {
    if (!DB.enabled() || !job._histGenId) return;
    const siteDir = path.join(GEN, "site");
    let saved = 0;
    for (const [slug, file] of Object.entries(SLUGS)) {
      const f = path.join(siteDir, file);
      try {
        if (!fs.existsSync(f)) continue;
        const html = fs.readFileSync(f, "utf8");
        if (!html.trim()) continue;
        await DB.savePage(job._histGenId, slug, html);
        saved++;
      } catch (e) { /* one unreadable page must not cost the rest */ }
    }
    await DB.finishGeneration(job._histGenId, {
      status: job.status === "done" ? "done" : "failed",
      brand: job.brandKit || {},
      error: job.error || "",
    });
    console.log(`[history] ${job.draftId} V${job._histVersion} closed (${job.status}, ${saved} page(s) stored)`);
  } catch (e) { console.error("[history] finish failed:", e.message); }
}

module.exports = { onJobStart, onJobFinish, SLUGS };
