// Generation history — the database half.
//
// Everything here is OPTIONAL at runtime. The tool ran for months with no
// database and every part of it still has to work that way: an unset
// BUILDTOOL_DATABASE_URL, an unreachable RDS, a dropped connection mid-build —
// none of these may cost a build. So every write is fire-and-caught, every
// read returns empty on failure, and the one place the caller can tell the
// difference is enabled().
//
// History is a record OF the build, never a participant IN it: nothing in the
// build path awaits a history write on its critical path or changes course on
// its result.
//
// The client key is the beta site URL, normalized. It is the only stable
// handle the product-service callback carries — there is no client id or name
// to key on — so two spellings of one URL must map to one client.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const URL_ENV = "BUILDTOOL_DATABASE_URL";
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

let pool = null;
let disabledReason = process.env[URL_ENV] ? "" : URL_ENV + " not set";

function enabled() { return !disabledReason; }
function whyDisabled() { return disabledReason; }

/** The pool, created on first use so requiring this file costs nothing. */
function getPool() {
  if (disabledReason) return null;
  if (pool) return pool;
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env[URL_ENV],
      // Always TLS. RDS refuses plaintext even through an SSH tunnel — its
      // pg_hba is hostssl — so "localhost means no ssl" was a guess that lost
      // to reality on the first connection. The cert is unverifiable from here
      // (no chain for the RDS CA); the tunnel/VPC is the transport trust, the
      // same stance as the rest of the fleet tooling. sslmode=disable in the
      // URL still wins for a genuinely local postgres.
      ssl: /sslmode=disable/.test(process.env[URL_ENV]) ? false : { rejectUnauthorized: false },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    // A dead pool must not take the process with it.
    pool.on("error", (e) => console.error("history db pool error:", e.message));
  } catch (e) {
    disabledReason = "pg driver unavailable: " + e.message;
    return null;
  }
  return pool;
}

/**
 * One query, never throwing.
 * @returns {Promise<{rows: any[]}|null>} null on any failure
 */
async function q(sql, params) {
  const p = getPool();
  if (!p) return null;
  try { return await p.query(sql, params); }
  catch (e) {
    console.error("history db:", e.message, "—", sql.slice(0, 60).replace(/\s+/g, " "));
    return null;
  }
}

// ---------------------------------------------------------------- migrate ---

/**
 * Apply pending migrations, oldest first, each recorded by filename.
 *
 * Runs once at boot when the DB is configured. Failure disables history for
 * the process rather than crashing it: a build tool that cannot migrate its
 * history schema is still a build tool.
 */
async function migrate() {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await p.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const c = await p.connect();
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        console.log("history db: applied", f);
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { c.release(); }
    }
    return true;
  } catch (e) {
    disabledReason = "migration failed: " + e.message;
    console.error("history db disabled —", disabledReason);
    return false;
  }
}

// ------------------------------------------------------------------- keys ---

/**
 * The client key for a beta site URL.
 *
 * Lowercased host without www, plus the path without its trailing slash.
 * "https://Foo.gogroth.com/" and "foo.gogroth.com" are the same client, and
 * on the day two clients share a host with different paths, the path keeps
 * them apart.
 */
function clientKey(betaUrl) {
  const raw = String(betaUrl || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const p = u.pathname.replace(/\/+$/, "");
    return host + p;
  } catch (e) {
    return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

// ----------------------------------------------------------------- writes ---

/**
 * The client row for this callback, created or refreshed.
 * @returns {Promise<number|null>} client id, or null when history is off
 */
async function upsertClient({ betaSiteUrl, existingSite, onboarding }) {
  const key = clientKey(betaSiteUrl);
  if (!key) return null;
  const r = await q(
    `INSERT INTO clients (client_key, beta_site_url, existing_site, onboarding)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_key) DO UPDATE SET
       beta_site_url = EXCLUDED.beta_site_url,
       existing_site = CASE WHEN EXCLUDED.existing_site <> '' THEN EXCLUDED.existing_site ELSE clients.existing_site END,
       onboarding    = EXCLUDED.onboarding,
       updated_at    = now()
     RETURNING id`,
    [key, String(betaSiteUrl || ""), String(existingSite || ""), JSON.stringify(onboarding || {})]);
  return r && r.rows[0] ? r.rows[0].id : null;
}

/**
 * A new generation for a client, with its version allocated HERE.
 *
 * max+1 inside one statement, so two concurrent callbacks contend on the
 * unique index instead of both reading the same max. On conflict the insert
 * is retried once — versions are small integers, not a hot path.
 *
 * @returns {Promise<{id: number, version: number}|null>}
 */
async function startGeneration({ clientId, engine, jobDraftId }) {
  if (!clientId) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await q(
      `INSERT INTO generations (client_id, version, engine, status, job_draft_id)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, 'running', $3
       FROM generations WHERE client_id = $1
       RETURNING id, version`,
      [clientId, String(engine || ""), String(jobDraftId || "")]);
    if (r && r.rows[0]) return r.rows[0];
  }
  return null;
}

/** Close a generation out, either way. */
async function finishGeneration(genId, { status, brand, error }) {
  if (!genId) return;
  await q(
    `UPDATE generations SET status=$2, brand=$3, error=$4, finished_at=now() WHERE id=$1`,
    [genId, status === "done" ? "done" : "failed", JSON.stringify(brand || {}), String(error || "").slice(0, 2000)]);
}

/**
 * Store one page's HTML, gzipped.
 *
 * Upsert rather than insert: a retried step must not fail on the page it
 * already wrote.
 */
async function savePage(genId, slug, html) {
  if (!genId || !slug) return;
  const src = String(html || "");
  const gz = zlib.gzipSync(Buffer.from(src, "utf8"));
  await q(
    `INSERT INTO pages (generation_id, slug, html_gz, size_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (generation_id, slug) DO UPDATE SET html_gz = EXCLUDED.html_gz, size_bytes = EXCLUDED.size_bytes`,
    [genId, String(slug), gz, Buffer.byteLength(src, "utf8")]);
}

// ------------------------------------------------------------------ reads ---

/**
 * Every client we have ever recorded a generation for, busiest-recent first.
 *
 * The landing data for the history browser: one row per client with enough to
 * decide whether to open it, and never the pages themselves — a client with
 * forty versions must not drag forty megabytes of HTML into a list screen.
 */
async function listClients() {
  const r = await q(
    `SELECT c.client_key, c.beta_site_url, c.existing_site,
            COUNT(g.id)                                  AS versions,
            COUNT(g.id) FILTER (WHERE g.status = 'done')  AS done_versions,
            MAX(g.version)                               AS latest_version,
            MAX(g.created_at)                            AS last_run_at
     FROM clients c
     LEFT JOIN generations g ON g.client_id = c.id
     GROUP BY c.id
     HAVING COUNT(g.id) > 0
     ORDER BY MAX(g.created_at) DESC NULLS LAST`);
  if (!r) return [];
  return r.rows.map((x) => ({
    clientKey: x.client_key,
    betaSiteUrl: x.beta_site_url,
    existingSite: x.existing_site,
    versions: Number(x.versions) || 0,
    doneVersions: Number(x.done_versions) || 0,
    latestVersion: Number(x.latest_version) || 0,
    lastRunAt: x.last_run_at,
  }));
}

/** Every version for a client, newest first, with page slugs. */
async function listVersions(betaOrKey) {
  const key = clientKey(betaOrKey);
  const r = await q(
    `SELECT g.version, g.engine, g.status, g.job_draft_id, g.created_at, g.finished_at,
            c.beta_site_url, c.existing_site,
            COALESCE(json_agg(json_build_object('slug', p.slug, 'size', p.size_bytes)
                              ORDER BY p.slug) FILTER (WHERE p.id IS NOT NULL), '[]') AS pages
     FROM clients c
     JOIN generations g ON g.client_id = c.id
     LEFT JOIN pages p ON p.generation_id = g.id
     WHERE c.client_key = $1
     GROUP BY g.id, c.id
     ORDER BY g.version DESC`,
    [key]);
  return r ? r.rows : [];
}

/** One stored page's HTML, or null. */
async function readPage(betaOrKey, version, slug) {
  const key = clientKey(betaOrKey);
  const r = await q(
    `SELECT p.html_gz FROM pages p
     JOIN generations g ON g.id = p.generation_id
     JOIN clients c ON c.id = g.client_id
     WHERE c.client_key = $1 AND g.version = $2 AND p.slug = $3`,
    [key, Number(version) || 0, String(slug)]);
  if (!r || !r.rows[0]) return null;
  try { return zlib.gunzipSync(r.rows[0].html_gz).toString("utf8"); }
  catch (e) { return null; }
}

module.exports = {
  enabled, whyDisabled, migrate, clientKey,
  upsertClient, startGeneration, finishGeneration, savePage,
  listClients, listVersions, readPage,
  _internals: { q, getPool },
};
