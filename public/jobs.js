// Growth99 Website Studio — Activity. Every build and edit run, split into
// what's in flight and what recently landed. Polls while anything is live.
"use strict";

const { esc, avatarColor, initials, relTime, getJSON, postJSON, toast, ensureAuth,
        jobState, jobProgress, jobCost, jobStepLabel, isActiveJob, confirm: confirmAction } = window.G99;

const $ = (id) => document.getElementById(id);

let JOBS = [], FILTER = "all", QUERY = "", timer;
const PAGE = 30;
let shownCount = PAGE;

// isActiveJob guards against a stale awaitingApproval flag on a run that has
// already ended — a finished job can't be waiting for you.
const needsYou = (j) => j.awaitingApproval && !j.approved && isActiveJob(j);
const title = (j) => j.editSummary || (j.payload && j.payload.prompt) || (j.type === "edit" ? "Website edit" : "Build " + j.businessName);

function match(j) {
  if (QUERY && !((j.businessName || "") + " " + title(j)).toLowerCase().includes(QUERY)) return false;
  if (FILTER === "all") return true;
  if (FILTER === "attention") return needsYou(j) || j.status === "error";
  return j.type === FILTER;
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
      </div>
      ${needsYou(j) ? `<span class="btn warn sm">Review &amp; approve</span>` : ""}
      ${(j.status === "running" || j.status === "queued") && !j.cancelRequested ? `<button class="btn danger sm" data-cancel="${esc(j.draftId)}" data-name="${esc(j.businessName)}">Stop</button>` : ""}
      ${j.cancelRequested && j.status === "running" ? `<span class="pill bad">Stopping…</span>` : ""}
      <span class="pill ${st.cls}">${esc(st.label)}</span>
    </div>
    <div class="mt">
      <div class="bar${needsYou(j) ? " still" : ""}"><i style="width:${pct}%;background:${st.bar}"></i></div>
      <span class="eta">${pct}%</span>
      <span class="cost">${esc(jobCost(j))}</span>
    </div>
  </a>`;
}

function doneRow(j) {
  const st = jobState(j);
  const sub = j.type === "build" ? "Generated & deployed" : j.type === "enrich" ? "Service pages + brand guide" : j.prUrl ? "Change shipped" : "Run ended";
  return `<a class="run compact" href="/job?id=${encodeURIComponent(j.draftId)}">
    <span class="ava" style="background:${avatarColor(j.businessName)}">${esc(initials(j.businessName))}</span>
    <div style="flex:1;min-width:0;margin-left:12px">
      <div class="nm trunc">${esc(title(j))}</div>
      <div class="sub trunc">${esc(j.businessName)} · ${esc(sub)} · ${esc(relTime(j.finishedAt || j.createdAt))}</div>
    </div>
    ${j.delta != null ? `<span class="pill ${j.delta >= 0 ? "good" : "bad"}" style="margin-right:8px">CRO ${j.delta >= 0 ? "+" : ""}${j.delta}</span>` : ""}
    <span class="pill ${st.cls}">${esc(st.label)}</span>
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

ensureAuth().then((ok) => {
  if (!ok) { $("active").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
