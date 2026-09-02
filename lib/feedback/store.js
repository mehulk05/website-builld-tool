// The feedback ledger — what was asked for, what happened to it, and whether
// this repository is safe to write to right now.
//
// Two things live here for one reason: both must outlive the process. A job
// record does not — jobs.json keeps the last 60 and is wiped by a redeploy,
// which is fine for "how is this run going" and useless for "did the padding
// change a designer asked for last Tuesday ever ship". So each item is written
// to a durable row as soon as it is accepted, before any work starts, and
// updated as it resolves. If the tool restarts mid-run the ledger still says
// what was owed.
//
// Durability is best-effort by design. A ledger that refuses the batch when
// NocoDB is unreachable would make an outage on a reporting system into an
// outage on the feature. So: NocoDB when it is configured and answering, a
// local JSON file always, and the local file is authoritative for the run.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// `let`, not `const`: the tests point this at a scratch file. A const here
// would leave _reset() silently writing the real ledger during a test run.
let LEDGER_FILE = path.join(__dirname, "..", "..", "feedback-ledger.json");
const MAX_LOCAL = 500;              // rows kept on disk; NocoDB keeps the rest
const LOCK_STALE_MS = 15 * 60e3;    // a run that has not touched its lock in 15m is dead

const NOCODB_BASE = (process.env.NOCODB_BASE || "https://app.nocodb.com").replace(/\/$/, "");
const nocoTable = () => (process.env.NOCODB_FEEDBACK_TABLE || "").trim();
const nocoToken = () => (process.env.NOCODB_TOKEN || "").trim();

// ---- local file --------------------------------------------------------------
let LEDGER = null;    // { batches: [], locks: {} }

function load() {
  if (LEDGER) return LEDGER;
  try {
    LEDGER = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    if (!LEDGER || typeof LEDGER !== "object") throw new Error("not an object");
  } catch (e) {
    LEDGER = { batches: [], locks: {} };
  }
  LEDGER.batches = Array.isArray(LEDGER.batches) ? LEDGER.batches : [];
  LEDGER.locks = LEDGER.locks && typeof LEDGER.locks === "object" ? LEDGER.locks : {};
  return LEDGER;
}

function save() {
  const L = load();
  L.batches = L.batches.slice(-MAX_LOCAL);
  try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(L, null, 0)); }
  catch (e) { console.warn("feedback ledger: could not persist —", e.message); }
}

// ---- NocoDB mirror -----------------------------------------------------------
// Never awaited by the caller's happy path and never allowed to throw outward:
// the row is a record of the work, not a step in it.
async function nocoWrite(method, body, query = "") {
  const table = nocoTable(), token = nocoToken();
  if (!table || !token) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${NOCODB_BASE}/api/v2/tables/${table}/records${query}`, {
      method, signal: ctl.signal,
      headers: { "xc-token": token, "accept": "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 140)}`);
    return await r.json();
  } catch (e) {
    console.warn("feedback ledger: NocoDB write failed —", e.message);
    return null;
  } finally { clearTimeout(timer); }
}

// One row per ITEM, not per batch: the question the ledger exists to answer is
// "what happened to this note", and a batch-shaped row cannot answer it without
// a JSON blob nobody can query.
function itemRow(batch, item) {
  return {
    "Item id": item.id,
    "Batch id": batch.id,
    "Site id": batch.siteId || "",
    "Repo": batch.repo || "",
    "Reviewer": batch.reviewer || "",
    "Page": item.page,
    "Element id": item.elementId,
    "Note": String(item.note || "").slice(0, 1000),
    "Status": item.status,
    "Detail": String(item.detail || "").slice(0, 500),
    "Screenshot": item.screenshotRef || "",
    "PR": batch.prUrl || "",
    "Deploy SHA": batch.deploySha || "",
    "Attempts": batch.attempts || 0,
    "Created at": batch.createdAt,
    "Updated at": new Date().toISOString(),
  };
}

async function mirror(batch) {
  if (!nocoTable() || !nocoToken()) return;
  for (const item of batch.items) {
    const row = itemRow(batch, item);
    if (item.nocoId) await nocoWrite("PATCH", [{ Id: item.nocoId, ...row }]);
    else {
      const out = await nocoWrite("POST", [row]);
      const id = out && out[0] && (out[0].Id || out[0].id);
      if (id) { item.nocoId = id; }
    }
  }
  save();
}

// ---- batches -----------------------------------------------------------------
/**
 * Record an accepted submission. Written to disk BEFORE any work begins, so a
 * crash between "accepted" and "queued" still leaves evidence of what was owed.
 *
 * `idempotencyKey` is what makes a retried POST safe: the widget resends the
 * same batch when its first attempt times out (a 20s WordPress proxy in front
 * of a 15-minute pipeline makes that routine), and without this each retry
 * would open its own pull request for work already under way.
 */
function createBatch({ siteId, repo, reviewer, sessionSig, items, idempotencyKey }) {
  const L = load();
  const key = String(idempotencyKey || "").trim();
  if (key) {
    const seen = L.batches.find((b) => b.idempotencyKey === key);
    if (seen) return { batch: seen, duplicate: true };
  }
  const batch = {
    id: "fb-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex"),
    idempotencyKey: key || null,
    siteId: siteId || "",
    repo: repo || "",
    reviewer: reviewer || "",
    sessionSig: sessionSig || "",
    createdAt: new Date().toISOString(),
    status: "queued",
    attempts: 0,
    jobId: null,
    prUrl: null,
    deploySha: null,
    items: items.map((it, i) => ({
      ...it,
      id: `${Date.now().toString(36)}-${i}`,
      status: "queued",
      detail: "",
      nocoId: null,
    })),
  };
  L.batches.push(batch);
  save();
  mirror(batch).catch(() => {});
  return { batch, duplicate: false };
}

function getBatch(id) {
  return load().batches.find((b) => b.id === id) || null;
}

/** Update a batch's own fields (job id, PR, deploy SHA, status). */
function updateBatch(id, patch) {
  const b = getBatch(id);
  if (!b) return null;
  Object.assign(b, patch || {});
  save();
  mirror(b).catch(() => {});
  return b;
}

/**
 * Set the outcome of individual items. `byId` maps item id → {status, detail}.
 * Statuses: queued → running → live | conflict | failed | skipped.
 */
function updateItems(batchId, byId) {
  const b = getBatch(batchId);
  if (!b) return null;
  for (const item of b.items) {
    const p = byId[item.id];
    if (!p) continue;
    if (p.status) item.status = p.status;
    if (p.detail != null) item.detail = String(p.detail).slice(0, 500);
    if (p.screenshotRef) item.screenshotRef = p.screenshotRef;
  }
  save();
  mirror(b).catch(() => {});
  return b;
}

/** Everything a reviewer's session ever submitted, newest first. */
function batchesForSession(sessionSig) {
  return load().batches.filter((b) => b.sessionSig === sessionSig).reverse();
}

// ---- per-repo serialisation --------------------------------------------------
// Two batches patching the same repository at the same time is the one race
// this pipeline cannot survive: both clone `main`, both splice a different
// section into the same page file, and whichever merges second silently drops
// the other's change — with both runs reporting success. So a repo is held for
// the length of a run.
//
// The lock is advisory and expires. A held lock whose owner died would
// otherwise block a repository until someone noticed, and nobody would.
function acquireRepoLock(repo, batchId) {
  const L = load();
  const key = String(repo || "").toLowerCase();
  if (!key) return true;
  const held = L.locks[key];
  if (held && held.batchId !== batchId && Date.now() - (held.at || 0) < LOCK_STALE_MS) return false;
  L.locks[key] = { batchId, at: Date.now() };
  save();
  return true;
}

/** Keep a long run's lock alive. A run that stops touching it loses it. */
function touchRepoLock(repo, batchId) {
  const L = load();
  const key = String(repo || "").toLowerCase();
  const held = L.locks[key];
  if (held && held.batchId === batchId) { held.at = Date.now(); save(); }
}

function releaseRepoLock(repo, batchId) {
  const L = load();
  const key = String(repo || "").toLowerCase();
  const held = L.locks[key];
  if (held && held.batchId === batchId) { delete L.locks[key]; save(); }
}

/** Batches that were accepted but never reached a terminal state — after a restart. */
function unfinishedBatches() {
  return load().batches.filter((b) => b.status === "queued" || b.status === "running");
}

// Test seam: point the module at a scratch file and start clean.
function _reset(file) {
  LEDGER = null;
  if (file) LEDGER_FILE = file;
  return load();
}

module.exports = {
  ledgerFile: () => LEDGER_FILE,
  createBatch, getBatch, updateBatch, updateItems, batchesForSession,
  acquireRepoLock, touchRepoLock, releaseRepoLock, unfinishedBatches,
  _reset, _load: load, _save: save,
};
