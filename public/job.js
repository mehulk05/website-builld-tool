// Growth99 — unified, type-aware job detail (build + edit) with actions + PR diff.
"use strict";
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith("/api/")) opts.headers = { ...(opts.headers || {}), "x-admin-key": localStorage.getItem("g99AdminKey") || "" };
  return _fetch(url, opts);
};
async function ensureAuth() {
  for (let i = 0; i < 3; i++) {
    const r = await fetch("/api/auth-check", { headers: { "x-login": "1" } });
    if (r.status !== 401) return true;
    const k = prompt("Admin password:"); if (k == null) return false;
    localStorage.setItem("g99AdminKey", k.trim());
  }
  return false;
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let toastT; function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }
const ID = new URLSearchParams(location.search).get("id");
const ICON = { pending: "·", running: '<span class="spin"></span>', done: "✓", error: "✗" };
const SVG_EDIT = `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>`;
const SVG_BUILD = `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
let diffLoaded = false;

async function act(path, okMsg) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ID }) });
  const d = await r.json();
  if (!r.ok) { toast(d.error || "failed"); return; }
  toast(okMsg);
  if (d.jobId) setTimeout(() => location.href = "/job?id=" + encodeURIComponent(d.jobId), 700);
  else render();
}
window._cancel = () => act("/api/job-cancel", "Cancelling…");
window._retry = () => act("/api/job-retry", "Retrying — new job started…");
window._approve = () => act("/api/job-approve", "Approved — merging…");

function steps(j) {
  return `<div class="steps">${j.steps.map((s) => `<div class="jstep ${s.status}">
    <span class="ic">${ICON[s.status] || ""}</span>
    <div class="jb"><span class="lb">${esc(s.label)}</span>
      <span class="dt" style="${s.status === "error" ? "color:var(--bad)" : ""}">${esc(s.detail)}</span></div>
  </div>`).join("")}</div>`;
}
function fileBox(plan) {
  if (!plan || !plan.length) return "";
  const rows = plan.map((f) => `<div class="frow"><span class="fop ${esc((f.op || "edit").toLowerCase())}">${esc(f.op || "edit")}</span><span class="fpath">${esc(f.path)}</span></div>`).join("");
  return `<div class="filebox"><div class="fhead">${plan.length} file${plan.length > 1 ? "s" : ""} changed</div>${rows}</div>`;
}
function costLine(j) {
  const c = j.cost || {}; const est = ((c.gemini || 0) * 0.001 + (c.stitch || 0) * 0.01);
  return `<span class="cost">Usage: ${c.gemini || 0} Gemini · ${c.stitch || 0} Stitch calls · ~$${est.toFixed(3)} est.</span>`;
}
function actionButtons(j) {
  const b = [];
  if (j.awaitingApproval) b.push(`<button class="btn primary" onclick="_approve()">✓ Approve &amp; merge</button>`);
  if (j.status === "running" || j.status === "queued") b.push(`<button class="btn danger" onclick="_cancel()">Cancel</button>`);
  if (["done", "error", "cancelled"].includes(j.status)) b.push(`<button class="btn" onclick="_retry()">↻ Retry</button>`);
  return b.join("");
}
async function loadDiff(j) {
  if (diffLoaded || !j.prUrl) return; diffLoaded = true;
  try {
    const d = await (await fetch("/api/pr-diff?prUrl=" + encodeURIComponent(j.prUrl))).json();
    const html = esc(d.diff || "(empty diff)").split("\n").map((l) =>
      l.startsWith("+") && !l.startsWith("+++") ? `<span class="a">${l}</span>` :
      l.startsWith("-") && !l.startsWith("---") ? `<span class="d">${l}</span>` : l).join("\n");
    if ($("diffBox")) $("diffBox").innerHTML = html;
  } catch (e) { if ($("diffBox")) $("diffBox").textContent = "Could not load diff: " + e.message; }
}

function render(j) {
  // j passed on poll; else fetch
}
async function poll() {
  let j; try { j = await (await fetch("/api/job?id=" + encodeURIComponent(ID))).json(); } catch (e) { return; }
  if (j.error && j.error === "job not found") { $("detail").innerHTML = `<p class="meta">Job <b>${esc(ID)}</b> not found (it may have been cleared). <a href="/jobs">← all jobs</a></p>`; clearInterval(timer); return; }
  const badge = `<span class="badge ${j.status}">${esc(j.status.toUpperCase())}</span>`;
  const when = (j.startedAt || j.createdAt || "").replace("T", " ").slice(0, 19);
  let body = "";
  if (j.type === "edit") {
    body = `
      <div class="card"><h2>Request</h2><div class="req">${esc((j.payload && j.payload.prompt) || "")}</div>
        ${j.editSummary ? `<div class="meta" style="margin-top:10px"><b>Plan:</b> ${esc(j.editSummary)}</div>` : ""}
        ${fileBox(j.editPlan)}</div>
      <div class="card"><h2>Progress</h2>${steps(j)}
        ${j.prUrl ? `<div style="margin-top:14px"><a class="prlink" href="${esc(j.prUrl)}" target="_blank">↗ Pull request</a></div>` : ""}
        ${j.error ? `<div class="meta" style="color:var(--bad);margin-top:10px">${esc(j.error)}</div>` : ""}</div>
      ${j.prUrl ? `<div class="card"><h2>Diff</h2><pre class="diff" id="diffBox"><span class="spin"></span> loading…</pre></div>` : ""}`;
  } else {
    const scores = (j.before || j.after)
      ? `<div class="card"><h2>CRO before → after</h2><div class="scoreline">${j.before ? j.before.overall : "—"} <span style="color:${(j.delta || 0) >= 0 ? "var(--good)" : "var(--bad)"}">${j.delta == null ? "→" : (j.delta >= 0 ? "+" : "") + j.delta}</span> ${j.after ? j.after.overall : "—"}</div></div>` : "";
    body = `${scores}
      <div class="card"><h2>Progress</h2>${steps(j)}
        <div style="margin-top:12px;display:flex;gap:12px;flex-wrap:wrap">
          ${j.prUrl ? `<a class="prlink" href="${esc(j.prUrl)}" target="_blank">↗ Pull request</a>` : ""}
          ${j.siteUrl ? `<a class="prlink" href="${esc(j.siteUrl)}" target="_blank">↗ Assembled site</a>` : ""}
          ${j.reportUrl ? `<a class="prlink" href="${esc(j.reportUrl)}" target="_blank">↗ Report</a>` : ""}
          <a class="prlink" href="/dashboard?job=${encodeURIComponent(j.draftId)}">↗ Live build view</a>
        </div>
        ${j.error ? `<div class="meta" style="color:var(--bad);margin-top:8px">${esc(j.error)}</div>` : ""}</div>`;
  }
  $("detail").innerHTML = `
    <div class="head"><span class="tchip ${j.type === "edit" ? "edit" : "build"}">${j.type === "edit" ? SVG_EDIT : SVG_BUILD}</span><h1>${esc(j.businessName)}</h1><span class="meta">${esc(j.type)} · ${esc(when)}</span>${badge}
      <div class="actions">${actionButtons(j)}</div></div>
    <div style="margin-bottom:14px">${costLine(j)}</div>
    ${body}`;
  if (j.type === "edit") loadDiff(j);
  if (["done", "error", "cancelled"].includes(j.status)) clearInterval(timer);
}

let timer;
ensureAuth().then((ok) => {
  if (!ok) { $("detail").innerHTML = '<p class="meta">Unauthorized.</p>'; return; }
  if (!ID) { $("detail").innerHTML = '<p class="meta">No job id. <a href="/jobs">← all jobs</a></p>'; return; }
  poll();
  timer = setInterval(poll, 3000);
});
