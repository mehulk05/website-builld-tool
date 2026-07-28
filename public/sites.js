// Growth99 Website Studio — Sites. Every NocoDB website as a card, with its
// derived status (from live runs), CRO score (from cached audits) and last
// change (from the newest run targeting that site).
"use strict";

const { esc, avatarColor, initials, host, thumbBg, croInk, relTime, toast,
        getJSON, ensureAuth, svg, siteJobs, siteStatus, isActiveJob } = window.G99;

const $ = (id) => document.getElementById(id);

let SITES = [], JOBS = [], AUDITS = {}, FILTER = "all", QUERY = "";

function lastChange(site) {
  const mine = siteJobs(site.siteId, JOBS);
  if (!mine.length) return null;
  const j = mine[0];
  const what = j.editSummary || (j.payload && j.payload.prompt) || (j.type === "edit" ? "Website edit" : "Site build");
  return { text: what, when: relTime(j.finishedAt || j.startedAt || j.createdAt), href: "/job?id=" + encodeURIComponent(j.draftId) };
}

function card(s) {
  const color = avatarColor(s.businessName);
  const st = siteStatus(s, JOBS);
  const a = AUDITS[s.siteId] || {};
  const cro = typeof a.overall === "number" ? a.overall : null;
  const delta = (cro != null && typeof a.before === "number") ? cro - a.before : null;
  const lc = lastChange(s);
  const domain = host(s.liveUrl) || "no domain set";

  return `<a class="sc" href="/site?id=${encodeURIComponent(s.siteId)}">
    <div class="thumb" style="background:${thumbBg(color)}">
      <span class="wm" style="color:${color}">${esc(initials(s.businessName))}</span>
      <span class="tag">${esc(s.githubRepo || "no repo")}</span>
      <span class="st" style="color:${st.dot}"><span class="dot" style="width:6px;height:6px;background:${st.dot}"></span>${esc(st.label)}</span>
    </div>
    <div class="body">
      <div class="hd">
        <span class="ava md" style="background:${color}">${esc(initials(s.businessName))}</span>
        <div style="flex:1;min-width:0">
          <div class="nm trunc">${esc(s.businessName)}</div>
          <div class="dm trunc">${esc(domain)}</div>
        </div>
        <div style="text-align:right;flex:none">
          <div class="cro" style="color:${croInk(cro)}">${cro == null ? "—" : cro}</div>
          <div class="crol">CRO</div>
        </div>
      </div>
      <div class="ft">
        <div style="flex:1;min-width:0">
          <div class="lc trunc">${esc(lc ? lc.text : "No changes shipped from Studio yet")}</div>
          <div class="up trunc">${esc(lc ? lc.when : "Ready to edit")}</div>
        </div>
        ${delta != null ? `<span class="pill ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "+" : ""}${delta}</span>` : ""}
      </div>
    </div>
  </a>`;
}

function render() {
  const shown = SITES.filter((s) => {
    if (QUERY && !((s.businessName || "") + " " + (s.liveUrl || "") + " " + (s.githubRepo || "")).toLowerCase().includes(QUERY)) return false;
    return FILTER === "all" || siteStatus(s, JOBS).key === FILTER;
  });
  const live = SITES.filter((s) => siteStatus(s, JOBS).key === "live").length;
  $("sub").textContent = SITES.length
    ? `${SITES.length} site${SITES.length === 1 ? "" : "s"} · ${live} live · each mapped to its own domain and repository`
    : "No websites found in NocoDB.";

  $("grid").innerHTML = shown.length
    ? shown.map(card).join("")
    : `<p class="empty">${SITES.length
        ? (QUERY ? `No sites match “${esc(QUERY)}”.` : "No sites match this filter.")
        : "No websites found in NocoDB. Check the table and that NOCODB_TOKEN is set, then Refresh."}</p>`;
}

async function load(refresh) {
  $("grid").innerHTML = '<p class="empty"><span class="spin"></span>Loading websites…</p>';
  try {
    const [sitesRes, jobsRes, auditRes] = await Promise.all([
      getJSON("/api/sites" + (refresh ? "?refresh=1" : "")),
      getJSON("/api/jobs").catch(() => ({ jobs: [] })),
      getJSON("/api/site-audits").catch(() => ({ audits: {} })),
    ]);
    SITES = (sitesRes.sites || []).sort((a, b) => (a.businessName || "").localeCompare(b.businessName || ""));
    JOBS = jobsRes.jobs || [];
    AUDITS = auditRes.audits || {};
    render();
  } catch (e) {
    $("grid").innerHTML = `<p class="empty">Could not load websites: ${esc(e.message)}</p>`;
    $("sub").textContent = "NocoDB is unreachable.";
  }
}

$("filters").onclick = (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  FILTER = b.dataset.f;
  [...$("filters").children].forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  render();
};
$("refresh").onclick = () => { toast("Refreshing from NocoDB…"); load(true); };
$("search").oninput = (e) => { QUERY = e.target.value.toLowerCase().trim(); render(); };

ensureAuth().then((ok) => {
  if (!ok) { $("grid").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load(false);
});
