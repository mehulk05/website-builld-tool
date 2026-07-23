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
  return j.steps.map((s) => `<div class="jstep ${s.status}"><span class="ic">${ICON[s.status] || "·"}</span><span class="lb">${esc(s.label)}</span><span class="dt" style="${s.status === "error" ? "color:var(--bad)" : ""}">${esc(s.detail)}</span></div>`).join("");
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
    const files = (j.editPlan || []).map((f) => `<div><b>${esc(f.op)}</b> ${esc(f.path)}</div>`).join("");
    body = `
      <div class="card"><h2>Request</h2><div>${esc((j.payload && j.payload.prompt) || "")}</div>
        ${j.editSummary ? `<div class="meta" style="margin-top:8px"><b>Plan:</b> ${esc(j.editSummary)}</div>` : ""}
        ${files ? `<div class="files" style="margin-top:8px">${files}</div>` : ""}</div>
      <div class="card"><h2>Progress</h2>${steps(j)}
        ${j.prUrl ? `<div style="margin-top:12px"><a class="prlink" href="${esc(j.prUrl)}" target="_blank">↗ Pull request</a></div>` : ""}
        ${j.error ? `<div class="meta" style="color:var(--bad);margin-top:8px">${esc(j.error)}</div>` : ""}</div>
      ${j.prUrl ? `<div class="card"><h2>Diff</h2><pre class="diff" id="diffBox"><span class="spin"></span> loading…</pre></div>` : ""}`;
  } else {
    const scores = (j.before || j.after)
      ? `<div class="card"><h2>CRO before → after</h2><div style="font-size:32px;font-weight:800">${j.before ? j.before.overall : "—"} <span style="color:${(j.delta || 0) >= 0 ? "var(--good)" : "var(--bad)"}">${j.delta == null ? "→" : (j.delta >= 0 ? "+" : "") + j.delta}</span> ${j.after ? j.after.overall : "—"}</div></div>` : "";
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
    <div class="head"><h1>${j.type === "edit" ? "✏️ " : "🚀 "}${esc(j.businessName)}</h1>${badge}<span class="meta">${esc(j.type)} · ${esc(when)}</span>
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
