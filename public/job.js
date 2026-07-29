// Growth99 Website Studio — run detail (build + edit). Plain-language progress
// up top, engineer detail behind a disclosure, real actions against the runner.
"use strict";

const { esc, avatarColor, initials, croColor, relTime, toast, getJSON, postJSON,
        ensureAuth, svg, jobState, jobCost } = window.G99;

const $ = (id) => document.getElementById(id);
const ID = new URLSearchParams(location.search).get("id");

let JOB = null, TECH_OPEN = false, diffLoaded = false, timer;

const verdict = (d) => d == null ? "" : d >= 15 ? "Significant improvement" : d >= 5 ? "Improved" : d >= 0 ? "Stable" : "Regressed";

function stepper(j) {
  const ic = { done: svg("check", 13, 3), running: `<span class="spin" style="margin:0;border-color:var(--accent);border-top-color:transparent"></span>`, error: svg("close", 13, 3), pending: "" };
  return `<div class="steps">${(j.steps || []).map((s) => `
    <div class="jstep ${s.status}">
      <span class="ic">${ic[s.status] || ""}</span>
      <div class="jb">
        <span class="lb">${esc(s.label)}</span>
        ${s.detail ? `<span class="dt"${s.status === "error" ? ' style="color:var(--bad)"' : ""}>${esc(s.detail)}</span>` : ""}
      </div>
    </div>`).join("")}</div>`;
}

function scoresCard(j) {
  if (!j.before && !j.after) return "";
  const before = j.before ? j.before.overall : null;
  const after = j.after ? j.after.overall : null;
  return `<div class="card scores">
    <div class="n"><b style="font-size:30px;color:var(--muted)">${before == null ? "—" : before}</b><i>Before</i></div>
    ${svg("arrow", 20)}
    <div class="n"><b style="font-size:44px;color:${croColor(after)}">${after == null ? "—" : after}</b><i>Now</i></div>
    <div style="margin-left:auto;text-align:right">
      ${j.delta == null ? "" : `<span class="pill ${j.delta >= 0 ? "good" : "bad"}" style="font-size:15px;padding:4px 12px">${j.delta >= 0 ? "+" : ""}${j.delta}</span>`}
      <div style="font-size:12px;color:var(--ink-3);font-weight:600;margin-top:6px">CRO score${j.delta == null ? "" : " · " + verdict(j.delta)}</div>
    </div>
  </div>`;
}

function techCard(j) {
  const c = j.cost || {};
  return `<div class="card pad">
    <button class="disc-btn" id="techBtn" aria-expanded="${TECH_OPEN}" aria-controls="tech">
      ${svg("code", 16)}<span class="t">Technical details</span><span class="h">for engineers</span>
    </button>
    <div class="tech${TECH_OPEN ? " open" : ""}" id="tech">
      <div class="grid">
        <div><span class="k">Repository</span><div class="v">${esc((j.payload && j.payload.githubRepo) || "—")}</div></div>
        <div><span class="k">Theme</span><div class="v">${esc((j.payload && j.payload.themeSlug) || "—")}</div></div>
        <div><span class="k">Branch</span><div class="v">${esc(j.branch || "—")}</div></div>
        <div><span class="k">Usage</span><div class="v">${c.gemini || 0} Gemini · ${c.stitch || 0} Stitch · ${esc(jobCost(j))}</div></div>
      </div>
      ${j.prUrl ? `<a href="${esc(j.prUrl)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;margin-top:14px;font-size:12.5px;font-weight:700">Open pull request on GitHub${svg("ext", 13)}</a>` : ""}
      ${j.prUrl ? `<pre class="diff" id="diffBox" style="margin-top:14px"><span class="spin"></span>loading diff…</pre>` : ""}
    </div>
  </div>`;
}

function actions(j) {
  const b = [];
  if (j.awaitingApproval && !j.approved) b.push(`<button class="btn primary" data-act="approve">${svg("check", 15, 2.2)}Approve &amp; ship</button>`);
  if (j.status === "running" || j.status === "queued") b.push(`<button class="btn danger" data-act="cancel">Cancel</button>`);
  if (["done", "error", "cancelled"].includes(j.status)) b.push(`<button class="btn" data-act="retry">${svg("refresh", 15)}Run again</button>`);
  return b.join("");
}

function render() {
  const j = JOB;
  const st = jobState(j);
  const isEdit = j.type === "edit";
  const site = (j.payload && j.payload.siteId) || null;
  const c = j.cost || {};

  $("wrap").innerHTML = `
    <a class="back" href="${site ? "/site?id=" + encodeURIComponent(site) : "/jobs"}">${svg("back", 14, 2.2)}${site ? "Back to site" : "All activity"}</a>

    <div class="hero">
      <span class="ava lg" style="width:42px;height:42px;border-radius:11px;font-size:15px;background:${avatarColor(j.businessName)}">${esc(initials(j.businessName))}</span>
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h1>${esc(j.editSummary || (isEdit ? "Website edit" : "Build " + j.businessName))}</h1>
          <span class="pill ${st.cls}">${esc(st.label)}</span>
        </div>
        <div class="meta">${isEdit ? "Edit" : "Build"} · ${esc(j.businessName)} · started ${esc(relTime(j.startedAt || j.createdAt))} · ${c.gemini || 0} AI planning · ${c.stitch || 0} generation calls · ${esc(jobCost(j))} est.</div>
      </div>
      <div class="acts">${actions(j)}</div>
    </div>

    ${j.awaitingApproval && !j.approved ? `<div class="banner">${svg("warn", 18)}<div style="flex:1"><div class="bt">Paused for your approval</div><div class="bd">The change is written and the pull request is open — it merges only once you approve.</div></div></div>` : ""}
    ${j.status === "error" ? `<div class="banner bad">${svg("warn", 18)}<div style="flex:1"><div class="bt">This run failed</div><div class="bd">${esc((j.error || "").slice(0, 240))}</div></div></div>` : ""}

    ${scoresCard(j)}

    ${isEdit && j.payload && j.payload.prompt ? `<div class="card pad"><div class="card-h"><h2>The request</h2></div><p class="req">${esc(j.payload.prompt)}</p></div>` : ""}

    <div class="card pad">
      <div class="card-h"><h2>Progress</h2>${j.prUrl ? `<a class="right linkbtn" href="${esc(j.prUrl)}" target="_blank" rel="noopener">Pull request${svg("ext", 13)}</a>` : ""}</div>
      <div style="padding-top:10px">${stepper(j)}</div>
      ${j.editPlan && j.editPlan.length ? `<div class="filebox"><div class="fhead">${j.editPlan.length} file${j.editPlan.length > 1 ? "s" : ""} changed</div>${j.editPlan.map((f) => `<div class="frow"><span class="fop ${esc((f.op || "edit").toLowerCase())}">${esc(f.op || "edit")}</span><span class="fpath">${esc(f.path)}</span></div>`).join("")}</div>` : ""}
      ${(j.siteUrl || j.reportUrl) ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px">
        ${j.siteUrl ? `<a class="linkbtn" href="${esc(j.siteUrl)}" target="_blank" rel="noopener">Assembled site${svg("ext", 13)}</a>` : ""}
        ${j.reportUrl ? `<a class="linkbtn" href="${esc(j.reportUrl)}" target="_blank" rel="noopener">Comparison report${svg("ext", 13)}</a>` : ""}
      </div>` : ""}
    </div>

    ${techCard(j)}`;

  $("techBtn").onclick = () => {
    TECH_OPEN = !TECH_OPEN;
    $("tech").classList.toggle("open", TECH_OPEN);
    $("techBtn").setAttribute("aria-expanded", String(TECH_OPEN));
    if (TECH_OPEN) loadDiff();
  };
  document.querySelectorAll("[data-act]").forEach((b) => { b.onclick = () => act(b.dataset.act, b); });
  if (TECH_OPEN) loadDiff();
}

async function act(kind, btn) {
  // Edit jobs carry the target repo on their payload; build jobs don't, so the
  // row is omitted rather than filled with a placeholder.
  const repo = (JOB.payload && JOB.payload.githubRepo) || null;
  const withRepo = (d) => (repo ? { ...d, Repository: repo } : d);
  const ASK = {
    approve: {
      title: "Approve and merge?",
      body: "This merges the pull request and ships the change to the live site. It can only be undone with another change.",
      details: withRepo({ Site: JOB.businessName, ...(JOB.prUrl ? { "Pull request": JOB.prUrl } : {}) }),
      confirmLabel: "Approve & ship",
    },
    cancel: {
      title: "Cancel this run?",
      body: "The run stops at the next step boundary. Work already pushed stays on its branch — nothing is rolled back.",
      details: { Site: JOB.businessName, Run: JOB.draftId },
      confirmLabel: "Cancel run", tone: "danger",
    },
    retry: {
      title: "Run this again?",
      body: JOB.type === "build"
        ? "Starts a fresh build: audit, brand, page generation, theme and deploy. Takes several minutes and spends AI credits."
        : "Starts a fresh edit run with the same request, opening a new pull request.",
      details: withRepo({ Site: JOB.businessName }),
      confirmLabel: "Run again",
    },
  }[kind];

  if (!(await window.G99.confirm(ASK))) return;

  const cfg = {
    approve: ["/api/job-approve", "Approved — merging…"],
    cancel: ["/api/job-cancel", "Cancelling…"],
    retry: ["/api/job-retry", "Retrying — new run started…"],
  }[kind];
  btn.disabled = true;
  try {
    const d = await postJSON(cfg[0], { id: ID });
    toast(cfg[1]);
    if (d.jobId) setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 700);
    else load();
  } catch (e) { toast("Failed: " + e.message); btn.disabled = false; }
}

async function loadDiff() {
  if (diffLoaded || !JOB || !JOB.prUrl || !$("diffBox")) return;
  diffLoaded = true;
  try {
    const d = await getJSON("/api/pr-diff?prUrl=" + encodeURIComponent(JOB.prUrl));
    $("diffBox").innerHTML = esc(d.diff || "(empty diff)").split("\n").map((l) =>
      l.startsWith("+") && !l.startsWith("+++") ? `<span class="a">${l}</span>` :
      l.startsWith("-") && !l.startsWith("---") ? `<span class="d">${l}</span>` : l).join("\n");
  } catch (e) {
    diffLoaded = false;
    if ($("diffBox")) $("diffBox").textContent = "Could not load diff: " + e.message;
  }
}

async function load() {
  try {
    JOB = await getJSON("/api/job?id=" + encodeURIComponent(ID));
  } catch (e) {
    // Only a real 404 means the run is gone; anything else (401, network, 5xx) must say so rather
    // than blaming "cleared" state — that mis-diagnosis sent us hunting for lost jobs that existed.
    const msg = e && e.status === 404
      ? `Run <b>${esc(ID)}</b> not found — it may have been cleared.`
      : e && e.status === 401
        ? `Unauthorized — reload the page and enter the admin password.`
        : `Could not load run <b>${esc(ID)}</b>: ${esc(e && e.message ? e.message : "request failed")}`;
    $("wrap").innerHTML = `<p class="empty">${msg} <a href="/jobs">← all activity</a></p>`;
    clearInterval(timer);
    return;
  }
  document.title = "Growth99 · " + JOB.businessName;
  render();
  if (["done", "error", "cancelled"].includes(JOB.status)) clearInterval(timer);
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  if (!ID) { $("wrap").innerHTML = '<p class="empty">No run id. <a href="/jobs">← all activity</a></p>'; return; }
  load();
  timer = setInterval(load, 3000);
});
