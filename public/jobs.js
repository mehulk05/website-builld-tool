// Growth99 Website Studio — Activity. Every build and edit run, split into
// what's in flight and what recently landed. Polls while anything is live.
"use strict";

const { esc, avatarColor, initials, relTime, getJSON, postJSON, toast, ensureAuth, svg,
        jobState, jobProgress, jobCost, jobStepLabel, isActiveJob, emitHops,
        confirm: confirmAction } = window.G99;

const $ = (id) => document.getElementById(id);

let JOBS = [], FILTER = "all", QUERY = "", timer;
const PAGE = 30;
let shownCount = PAGE;
// Which rows have their task breakdown open. A Set survives the re-render every
// poll does (4-10s) — without it, expanding a row would collapse itself on the
// next tick.
const EXPANDED = new Set();
function toggleExpand(id) { EXPANDED.has(id) ? EXPANDED.delete(id) : EXPANDED.add(id); render(); }

// The same per-step stepper the run detail page uses (same CSS classes, from the
// shared theme.css), so a job's task breakdown reads as one dashboard whether
// you're looking at it from Activity or from the run itself — not two different
// UIs for the same data.
function taskBreakdown(j) {
  const ic = {
    done: svg("check", 12, 3),
    running: `<span class="spin" style="margin:0;width:12px;height:12px;border-color:var(--accent);border-top-color:transparent"></span>`,
    error: svg("close", 12, 3), pending: "",
  };
  const steps = j.steps || [];
  if (!steps.length) return `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-2);font-size:12.5px;color:var(--muted)">No task detail recorded for this run.</div>`;
  return `<div class="steps" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-2)">${steps.map((s) => `
    <div class="jstep ${s.status}">
      <span class="ic">${ic[s.status] || ""}</span>
      <div class="jb">
        <span class="lb">${esc(s.label)}</span>
        ${s.detail ? `<span class="dt"${s.status === "error" ? ' style="color:var(--bad)"' : ""}>${esc(s.detail)}</span>` : ""}
      </div>
    </div>`).join("")}
  </div>`;
}
function taskToggle(j) {
  const open = EXPANDED.has(j.draftId);
  return `<button class="btn sm" data-toggle="${esc(j.draftId)}" style="margin-right:8px" aria-expanded="${open}" title="Show task-by-task progress">
    <span style="display:inline-flex;transform:rotate(${open ? 90 : 0}deg);transition:transform .14s">${svg("chevron", 12, 2.4)}</span> Tasks
  </button>`;
}

// isActiveJob guards against a stale awaitingApproval flag on a run that has
// already ended — a finished job can't be waiting for you.
const needsYou = (j) => j.awaitingApproval && !j.approved && isActiveJob(j);
const title = (j) => j.editSummary || (j.payload && j.payload.prompt) || (j.type === "edit" ? "Website edit" : j.type === "seo" ? "SEO — " + j.businessName : j.type === "pre-release" ? "Pre-release — " + j.businessName : "Build " + j.businessName);

// Client info the onboarding form brought with it: the build target from the
// HubSpot deal, plus when the submission actually arrived. Shown on every row so
// you can tell which client and which site a run belongs to without opening it.
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/+$/, ""); } };
function clientMeta(j) {
  const repo = j.repo || (j.payload && (j.payload.githubRepo || j.payload.betaSiteRepo)) || null;
  const beta = j.liveUrl || (j.payload && j.payload.betaSiteUrl) || null;
  const when = j.receivedAt || j.createdAt;
  const bits = [
    beta ? `<span class="cm" title="Beta site">${esc(hostOf(beta))}</span>` : "",
    repo ? `<span class="cm" title="Repository">${esc(repo)}</span>` : "",
    when ? `<span class="cm" title="Form received ${esc(when)}">${esc(relTime(when))}</span>` : "",
  ].filter(Boolean).join("");
  return bits ? `<div class="cmeta">${bits}</div>` : "";
}
function match(j) {
  if (QUERY && !((j.businessName || "") + " " + title(j)).toLowerCase().includes(QUERY)) return false;
  if (FILTER === "all") return true;
  if (FILTER === "attention") return needsYou(j) || j.status === "error";
  return j.type === FILTER;
}


// A build can finish perfectly and still fail to tell anyone. Surface that on the row —
// otherwise the only way to find it is to open all thirty runs one at a time.
function emitBadge(j) {
  const a = emitHops(j);
  if (!a || !a.failed) return "";
  return `<span class="pill bad" style="margin-right:8px" title="A status callback failed \u2014 open the run for the error">Event not delivered</span>`;
}

function activeRow(j) {
  const st = jobState(j);
  const pct = jobProgress(j);
  return `<a class="run" href="/job?id=${encodeURIComponent(j.draftId)}">
    <div class="hd">
      <span class="ava" style="background:${avatarColor(j.businessName)}">${esc(initials(j.businessName))}</span>
      <div style="flex:1;min-width:0">
        <div class="nm trunc">${esc(title(j))}</div>
        <div class="sub trunc">${esc(j.businessName)} · ${esc(jobStepLabel(j))}</div>
        ${clientMeta(j)}
      </div>
      ${needsYou(j) ? `<span class="btn warn sm">Review &amp; approve</span>` : ""}
      ${(j.status === "running" || j.status === "queued") && !j.cancelRequested ? `<button class="btn danger sm" data-cancel="${esc(j.draftId)}" data-name="${esc(j.businessName)}">Stop</button>` : ""}
      ${j.cancelRequested && j.status === "running" ? `<span class="pill bad">Stopping…</span>` : ""}
      ${emitBadge(j)}
      ${taskToggle(j)}
      <span class="pill ${st.cls}">${esc(st.label)}</span>
    </div>
    <div class="mt">
      <div class="bar${needsYou(j) ? " still" : ""}"><i style="width:${pct}%;background:${st.bar}"></i></div>
      <span class="eta">${pct}%</span>
      <span class="cost">${esc(jobCost(j))}</span>
    </div>
    ${EXPANDED.has(j.draftId) ? taskBreakdown(j) : ""}
  </a>`;
}

function doneRow(j) {
  const st = jobState(j);
  const sub = j.type === "build" ? "Generated & deployed" : j.type === "enrich" ? "Service pages + brand guide" : j.type === "pre-release" ? "Mobile release check" : j.prUrl ? "Change shipped" : "Run ended";
  // flex-direction:column (inline, beats the .compact class's row default) so the
  // expanded task breakdown lands as a full-width block under the row instead of
  // squeezing in as another flex item beside the pills.
  return `<a class="run compact" href="/job?id=${encodeURIComponent(j.draftId)}" style="flex-direction:column;align-items:stretch">
    <div style="display:flex;align-items:center;width:100%">
      <span class="ava" style="background:${avatarColor(j.businessName)}">${esc(initials(j.businessName))}</span>
      <div style="flex:1;min-width:0;margin-left:12px">
        <div class="nm trunc">${esc(title(j))}</div>
        <div class="sub trunc">${esc(j.businessName)} · ${esc(sub)} · ${esc(relTime(j.finishedAt || j.createdAt))}</div>
        ${clientMeta(j)}
      </div>
      ${emitBadge(j)}
      ${j.delta != null ? `<span class="pill ${j.delta >= 0 ? "good" : "bad"}" style="margin-right:8px">CRO ${j.delta >= 0 ? "+" : ""}${j.delta}</span>` : ""}
      ${taskToggle(j)}
      ${j.reportUrl ? `<button class="btn sm" data-report="${esc(j.reportUrl)}" style="margin-right:8px" title="Open the run report">Report</button>` : ""}
      <span class="pill ${st.cls}">${esc(st.label)}</span>
    </div>
    ${EXPANDED.has(j.draftId) ? taskBreakdown(j) : ""}
  </a>`;
}

function render() {
  const shown = JOBS.filter(match);
  const active = shown.filter((j) => isActiveJob(j) || needsYou(j));
  const done = shown.filter((j) => !isActiveJob(j) && !needsYou(j));

  $("activeCount").textContent = `${active.length} running`;
  $("doneCount").textContent = String(done.length);
  $("active").innerHTML = active.length ? active.map(activeRow).join("")
    : `<p class="empty">Nothing in flight. Start a build or an edit and it appears here live.</p>`;

  const visible = done.slice(0, shownCount);
  const hidden = done.length - visible.length;
  $("done").innerHTML = done.length
    ? visible.map(doneRow).join("") +
      (hidden > 0
        ? `<div style="padding:14px 0 4px;display:flex;align-items:center;gap:12px;border-top:1px solid var(--line-2)">
             <span style="font-size:12.5px;color:var(--muted)">Showing ${visible.length} of ${done.length}</span>
             <button class="btn sm" id="showMore" style="margin-left:auto">Show ${Math.min(PAGE, hidden)} more</button>
           </div>`
        : (done.length > PAGE ? `<div style="padding:14px 0 4px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line-2)">Showing all ${done.length}</div>` : ""))
    : `<p class="empty">${JOBS.length ? "No completed runs match this filter." : "No runs yet."}</p>`;
  const more = $("showMore");
  if (more) more.onclick = () => { shownCount += PAGE; render(); };

  const live = JOBS.filter(isActiveJob).length;
  $("sub").textContent = live
    ? `${live} run${live === 1 ? "" : "s"} in flight · ${JOBS.length} total`
    : `${JOBS.length} run${JOBS.length === 1 ? "" : "s"} recorded · nothing running right now`;
}

async function load() {
  try {
    const d = await getJSON("/api/jobs");
    JOBS = d.jobs || [];
    render();
    // Always keep polling — a run can START at any time (e.g. the enrichment that
    // auto-fires after a build), and the page must pick it up without a refresh.
    // Fast cadence while something is in flight, slower when idle.
    clearInterval(timer);
    timer = setInterval(load, JOBS.some(isActiveJob) ? 4000 : 10000);
  } catch (e) {
    $("active").innerHTML = `<p class="empty">Could not load runs: ${esc(e.message)}</p>`;
    clearInterval(timer);
    timer = setInterval(load, 10000);   // keep trying after a transient failure
  }
}

$("filters").onclick = (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  FILTER = b.dataset.f;
  shownCount = PAGE;
  [...$("filters").children].forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  render();
};
$("search").oninput = (e) => { QUERY = e.target.value.toLowerCase().trim(); shownCount = PAGE; render(); };

// Tasks toggle — same handler on both lists, delegated (rows re-render on every
// poll for active jobs, so a listener bound to a row would be lost on the next tick).
function bindTaskToggle(container) {
  container.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    toggleExpand(t.dataset.toggle);
  });
}
bindTaskToggle($("active"));
bindTaskToggle($("done"));

// Stop button on active rows (delegated — rows re-render on every poll). The row
// itself is a link, so swallow the navigation before cancelling.
$("active").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cancel]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const ok = await confirmAction({
    title: "Stop this run?",
    body: "The run stops at the next step boundary. Work already pushed stays on its branch — nothing is rolled back.",
    details: { Site: b.dataset.name, Run: b.dataset.cancel },
    confirmLabel: "Stop run", tone: "danger",
  });
  if (!ok) return;
  b.disabled = true;
  try { await postJSON("/api/job-cancel", { id: b.dataset.cancel }); toast("Stopping — the run ends at the next step boundary."); load(); }
  catch (err) { b.disabled = false; toast("Could not stop: " + err.message); }
});

// Report button on completed rows — opens the run's report directly instead of
// following the row into the full job detail page.
$("done").addEventListener("click", (e) => {
  const b = e.target.closest("[data-report]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  window.open(b.dataset.report, "_blank", "noopener");
});

ensureAuth().then((ok) => {
  if (!ok) { $("active").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
