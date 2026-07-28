// Growth99 Website Studio — Overview. One read across sites, runs and cached
// CRO audits, rendered as the four KPIs plus the task / attention / health /
// activity panels. Polls while anything is still running.
"use strict";

const { esc, avatarColor, initials, host, croColor, croInk, deltaInk, relTime, svg, getJSON, ensureAuth,
        jobProgress, jobState, jobCost, jobStepLabel, isActiveJob } = window.G99;

const $ = (id) => document.getElementById(id);
const jobHref = (j) => "/job?id=" + encodeURIComponent(j.draftId);
const siteHref = (s) => "/site?id=" + encodeURIComponent(s.siteId);

let timer;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function kpiCard(k, v, sub, color) {
  return `<div class="kpi">
    <div class="k">${esc(k)}</div>
    <div class="v"${color ? ` style="color:${color}"` : ""}>${esc(String(v))}</div>
    <div class="s">${sub}</div>
  </div>`;
}

function renderKpis(sites, jobs, audits) {
  const running = jobs.filter(isActiveJob);
  const approvals = jobs.filter((j) => j.awaitingApproval && !j.approved);
  const failed = jobs.filter((j) => j.status === "error");
  const scored = sites.map((s) => (audits[s.siteId] || {}).overall).filter((n) => typeof n === "number");
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const withRepo = sites.filter((s) => s.githubRepo).length;
  const live = sites.filter((s) => s.githubRepo && s.liveUrl).length;
  const attention = approvals.length + failed.length + (sites.length - withRepo);

  $("kpis").innerHTML = [
    // Counts every registered website — "live" would be a different number.
    kpiCard("Sites registered", sites.length, `<span>${live} live · ${withRepo} wired to a repo</span>`),
    kpiCard("Running now", running.length, approvals.length
      ? `<span class="dot attention"></span>${approvals.length} need${approvals.length === 1 ? "s" : ""} approval`
      : `<span>${jobs.filter((j) => j.status === "queued").length} queued</span>`, running.length ? "var(--accent)" : ""),
    kpiCard("Avg CRO score", avg == null ? "—" : avg, scored.length
      ? `<span>${scored.length} of ${sites.length} audited</span>`
      : `<span>Run an audit from a site page</span>`, avg == null ? "" : croColor(avg)),   // 28px bold — display size
    kpiCard("Needs attention", attention, attention
      ? `<span>${approvals.length} approval · ${failed.length} failed</span>`
      : `<span>Everything looks healthy</span>`, attention ? "var(--warn)" : "var(--good)"),
  ].join("");

  $("greet").textContent = `${greeting()} — Website Studio`;
  $("subline").textContent = running.length
    ? `${plural(running.length, "task")} running · ${plural(sites.length, "site")} registered`
    : `${plural(sites.length, "site")} registered · nothing running right now`;
}

function renderActive(jobs) {
  const active = jobs.filter((j) => isActiveJob(j) || (j.awaitingApproval && !j.approved)).slice(0, 5);
  $("activeCount").textContent = `${active.length} running`;
  if (!active.length) {
    $("active").innerHTML = `<p class="empty">Nothing running. Start a build or an edit and it shows up here live.</p>`;
    return;
  }
  $("active").innerHTML = active.map((j) => {
    const st = jobState(j);
    const pct = jobProgress(j);
    const color = avatarColor(j.businessName);
    return `<a class="task" href="${jobHref(j)}" style="text-decoration:none;color:inherit">
      <div class="hd">
        <span class="ava" style="background:${color}">${esc(initials(j.businessName))}</span>
        <div style="flex:1;min-width:0">
          <div class="nm trunc">${esc(j.editSummary || (j.payload && j.payload.prompt) || (j.type === "edit" ? "Website edit" : "Building " + j.businessName))}</div>
          <div class="sub trunc">${esc(j.businessName)} · ${esc(jobStepLabel(j))}</div>
        </div>
        <span class="pill ${st.cls}">${esc(st.label)}</span>
      </div>
      <div class="mt">
        <div class="bar${st.key === "approval" ? " still" : ""}"><i style="width:${pct}%;background:${st.bar}"></i></div>
        <span class="eta">${pct}%</span>
        <span class="cost">${esc(jobCost(j))}</span>
      </div>
      ${st.key === "approval" ? `<div class="approve">${svg("warn", 15)}<span>Ready to ship — waiting for your approval to merge.</span><span class="btn warn sm">Review &amp; approve</span></div>` : ""}
    </a>`;
  }).join("");
}

function renderAttention(sites, jobs) {
  const rows = [];
  jobs.filter((j) => j.awaitingApproval && !j.approved).forEach((j) => rows.push({
    dot: "var(--warn)", title: "Waiting for approval", site: j.businessName,
    detail: "The change is built and paused before merge", action: "Review", href: jobHref(j),
  }));
  jobs.filter((j) => j.status === "error").slice(0, 4).forEach((j) => rows.push({
    dot: "var(--bad)", title: j.type === "edit" ? "Edit run failed" : "Build run failed",
    site: j.businessName, detail: (j.error || "See the run log").slice(0, 90), action: "View", href: jobHref(j),
  }));
  sites.filter((s) => !s.githubRepo || !s.liveUrl).slice(0, 4).forEach((s) => rows.push({
    dot: "var(--warn)", title: !s.githubRepo ? "No repository set" : "No domain set",
    site: s.businessName, detail: "Set it in NocoDB so Studio can ship changes", action: "Open", href: siteHref(s),
  }));

  $("attCount").textContent = String(rows.length);
  if (!rows.length) { $("attention").innerHTML = `<p class="empty">Nothing needs you right now.</p>`; return; }
  $("attention").innerHTML = rows.slice(0, 6).map((r) => `
    <div class="att">
      <span class="dot" style="width:9px;height:9px;background:${r.dot}"></span>
      <div style="flex:1;min-width:0">
        <div class="nm trunc">${esc(r.title)}</div>
        <div class="sub trunc">${esc(r.site)} · ${esc(r.detail)}</div>
      </div>
      <a class="btn sm" href="${r.href}">${esc(r.action)}</a>
    </div>`).join("");
}

function renderHealth(sites, audits) {
  if (!sites.length) { $("health").innerHTML = `<p class="empty">No websites in NocoDB yet.</p>`; return; }
  $("health").innerHTML = sites.slice(0, 6).map((s) => {
    const a = audits[s.siteId] || {};
    const cro = typeof a.overall === "number" ? a.overall : null;
    const delta = (cro != null && typeof a.before === "number") ? cro - a.before : null;
    const color = avatarColor(s.businessName);
    const wired = s.githubRepo && s.liveUrl;
    return `<a class="health" href="${siteHref(s)}">
      <span class="ava" style="background:${color}">${esc(initials(s.businessName))}</span>
      <div style="flex:1;min-width:0">
        <div class="nm trunc">${esc(s.businessName)}</div>
        <div class="st trunc"><span class="dot ${wired ? "live" : "attention"}"></span>${wired ? "Live" : "Needs setup"}</div>
      </div>
      <div style="text-align:right;flex:none">
        <div class="sc" style="color:${croInk(cro)}">${cro == null ? "—" : cro}</div>
        <div class="dl" style="color:${deltaInk(delta)}">${delta == null ? "no audit" : (delta >= 0 ? "+" : "") + delta}</div>
      </div>
    </a>`;
  }).join("");
}

function renderRecent(jobs) {
  const done = jobs.filter((j) => ["done", "error", "cancelled"].includes(j.status)).slice(0, 6);
  if (!done.length) { $("recent").innerHTML = `<p class="empty">No completed runs yet.</p>`; return; }
  $("recent").innerHTML = done.map((j) => {
    const st = jobState(j);
    const dot = j.status === "done" ? "var(--good)" : j.status === "error" ? "var(--bad)" : "var(--muted)";
    const delta = (j.delta != null) ? `<span class="pill ${j.delta >= 0 ? "good" : "bad"}" style="height:fit-content">CRO ${j.delta >= 0 ? "+" : ""}${j.delta}</span>` : "";
    return `<a class="act" href="${jobHref(j)}">
      <span class="dot" style="width:8px;height:8px;margin-top:5px;background:${dot}"></span>
      <div style="flex:1;min-width:0">
        <div class="nm trunc">${esc(j.editSummary || (j.type === "edit" ? "Website edit" : "Site generated & deployed"))}</div>
        <div class="sub trunc">${esc(j.businessName)} · ${esc(relTime(j.finishedAt || j.createdAt))} · ${esc(st.label)}</div>
      </div>
      ${delta}
    </a>`;
  }).join("");
}

async function load() {
  const [sitesRes, jobsRes, auditRes] = await Promise.all([
    getJSON("/api/sites").catch((e) => ({ sites: [], _err: e.message })),
    getJSON("/api/jobs").catch(() => ({ jobs: [] })),
    getJSON("/api/site-audits").catch(() => ({ audits: {} })),
  ]);
  const sites = sitesRes.sites || [];
  const jobs = jobsRes.jobs || [];
  const audits = auditRes.audits || {};

  if (sitesRes._err) $("subline").textContent = "Could not reach NocoDB: " + sitesRes._err;

  renderKpis(sites, jobs, audits);
  renderActive(jobs);
  renderAttention(sites, jobs);
  renderHealth(sites, audits);
  renderRecent(jobs);

  // Keep polling only while something is genuinely in flight.
  const live = jobs.some((j) => isActiveJob(j));
  clearInterval(timer);
  if (live) timer = setInterval(load, 4000);
}

ensureAuth().then((ok) => {
  if (!ok) { $("subline").textContent = "Unauthorized — reload and enter the admin password."; return; }
  load();
});
