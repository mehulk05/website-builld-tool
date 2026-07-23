// Growth99 Pipeline Jobs — live monitor for webhook-triggered runs.
"use strict";

// auth: same admin-key handling as the dashboard
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith("/api/")) opts.headers = { ...(opts.headers || {}), "x-admin-key": localStorage.getItem("g99AdminKey") || "" };
  return _fetch(url, opts);
};
async function ensureAuth() {
  for (let i = 0; i < 3; i++) {
    const r = await fetch("/api/auth-check", { headers: { "x-login": "1" } });
    if (r.status !== 401) return true;
    const k = prompt("This tool is password-protected. Enter the admin password:");
    if (k == null) return false;
    localStorage.setItem("g99AdminKey", k.trim());
  }
  return false;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ICON = { pending: "·", running: '<span class="spin"></span>', done: "✓", error: "✗" };
const PG_ICON = { queued: "·", generating: '<span class="spin"></span>', "post-processing": "◌", done: "✓", error: "✗" };
const PAGE_LABELS = [["home", "Home"], ["services", "Services"], ["about", "About"], ["contact", "Contact"]];
let GEN_PROG = { phase: "idle", pages: {} };  // populated from /api/generate-progress each refresh

// Brand palette + fonts strip (shown on the compose step). Uses job.composed if
// the server provides it, else parses the hexes/font out of the step-2 detail.
function brandSwatches(j) {
  let c = j.composed;
  if (!c) {
    const d = (j.steps[1] && j.steps[1].detail) || "";
    const hex = d.match(/#[0-9a-fA-F]{6}/g) || [];
    if (!hex.length) return "";
    c = { primary: hex[0], accent: hex[1] || null, headingFont: (d.split("·")[1] || "").trim() || null };
  }
  const sw = (h, l) => h ? `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:3px;margin-right:14px">
      <span style="width:34px;height:34px;border-radius:8px;background:${esc(h)};border:1px solid var(--line)"></span>
      <span style="font-size:10px;color:var(--muted)">${esc(l)}</span><span style="font-size:10px;font-variant-numeric:tabular-nums">${esc(h)}</span></span>` : "";
  const fonts = [c.headingFont, c.bodyFont].filter(Boolean).join(" + ");
  const brief = (c.brief || "").trim();
  const briefBlock = brief
    ? `<details style="margin:4px 0 4px 28px"><summary style="cursor:pointer;font-size:12.5px;color:var(--accent)">View build prompt (${brief.length} chars)</summary>
       <div style="white-space:pre-wrap;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:6px;max-height:260px;overflow:auto">${esc(brief)}</div></details>`
    : "";
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:8px 0 4px 28px">
    ${sw(c.primary, "Primary")}${sw(c.secondary, "Secondary")}${sw(c.accent, "Accent")}
    ${fonts ? `<span style="font-size:12px;color:var(--muted)">${esc(fonts)}</span>` : ""}</div>${briefBlock}`;
}

// Per-page rows under the "Generate pages" step. While the job is running we use
// the live global progress (queued→generating→done); once done we use the job's
// own persisted snapshot so the breakdown survives.
const PG_TXT = { queued: "queued", generating: "generating…", "post-processing": "fixing images / SEO…", done: "", error: "" };
function perPageRows(j, live) {
  const g = live ? (GEN_PROG.pages || {}) : (j.pages || {});
  if (!Object.keys(g).length) return "";
  const rows = PAGE_LABELS.map(([k, l]) => {
    const st = g[k];
    const status = st ? st.status : "queued";
    const t = status === "done" ? `✓ ${((st.bytes || 0) / 1024).toFixed(1)} KB`
      : status === "error" ? `✗ ${(st && st.error) || "failed"}`
      : `${PG_ICON[status] || "·"} ${PG_TXT[status] || status}`;
    const col = status === "done" ? "var(--good)" : status === "error" ? "var(--bad)" : "var(--muted)";
    return `<div style="font-size:12.5px;color:${col}"><span style="display:inline-block;width:80px">${esc(l)}</span>${t}</div>`;
  }).join("");
  return `<div style="margin:6px 0 4px 28px">${rows}</div>`;
}

function jobCard(j) {
  const badge = `<span class="badge ${j.status}">${j.status.toUpperCase()}</span>`;
  const scores = (j.before || j.after)
    ? `<div class="scores">${j.before ? j.before.overall : "—"} <span class="d" style="color:${(j.delta || 0) >= 0 ? "var(--good)" : "var(--bad)"}">${j.delta == null ? "→" : (j.delta >= 0 ? "+" : "") + j.delta}</span> ${j.after ? j.after.overall : "—"}</div>` : "";
  const steps = j.steps.map((s, i) => {
    const row = `<div class="jstep ${s.status}"><span class="ic">${ICON[s.status] || "·"}</span><span class="lb">${esc(s.label)}</span><span class="dt" style="${s.status === "error" ? "color:var(--bad)" : ""}">${esc(s.detail)}</span></div>`;
    let extra = "";
    if (i === 1 && (s.status === "done" || s.status === "running")) extra = brandSwatches(j);           // compose → palette + fonts + prompt
    if (i === 2 && s.status !== "pending") extra = perPageRows(j, s.status === "running" && j.status === "running"); // generate → per-page (live while running, snapshot after)
    return row + extra;
  }).join("");
  const stop = 'onclick="event.stopPropagation()"';
  const links = [
    j.prUrl ? `<a href="${esc(j.prUrl)}" target="_blank" ${stop}>↗ Pull request</a>` : "",
    j.siteUrl ? `<a href="${esc(j.siteUrl)}" target="_blank" ${stop}>↗ Assembled site</a>` : "",
    j.reportUrl ? `<a href="${esc(j.reportUrl)}" target="_blank" ${stop}>↗ Before/after report</a>` : "",
  ].filter(Boolean).join("");
  const when = (j.startedAt || j.createdAt || "").replace("T", " ").slice(0, 19);
  return `<div class="card" style="cursor:pointer" onclick="location.href='/dashboard?job=${encodeURIComponent(j.draftId)}'">
    <div class="jhead"><h2>${esc(j.businessName)}</h2><span class="meta">draft ${esc(j.draftId)} · ${esc(when)}</span>${badge}${scores}</div>
    <div class="steps">${steps}</div>
    ${links ? `<div class="links">${links}</div>` : ""}
    ${j.error ? `<div class="links" style="color:var(--bad)">${esc(j.error)}</div>` : ""}
  </div>`;
}

async function refresh() {
  try {
    // per-page progress (global; one job runs at a time) for the running job's generate step
    try { GEN_PROG = await (await fetch("/api/generate-progress")).json(); } catch (e) { /* keep last */ }
    const d = await (await fetch("/api/jobs")).json();
    document.getElementById("stat").textContent = `${d.jobs.length} job(s) · ${d.running ? "1 running" : "idle"}${d.queued ? ` · ${d.queued} queued` : ""}`;
    document.getElementById("list").innerHTML = d.jobs.length
      ? d.jobs.map(jobCard).join("")
      : '<div class="empty">Waiting for jobs — submit an onboarding form (or POST the webhook) and runs appear here live.</div>';
  } catch (e) { /* transient poll error — keep last render */ }
}

ensureAuth().then((ok) => {
  if (!ok) { document.getElementById("stat").textContent = "Unauthorized"; return; }
  refresh();
  setInterval(refresh, 3000);
});
