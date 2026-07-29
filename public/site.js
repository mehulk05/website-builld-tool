// Growth99 Website Studio — site detail. Live preview, conversion health from
// the cached CRO audit, the resolved edit target, and the site's PR history.
"use strict";

const { esc, avatarColor, initials, host, thumbBg, croColor, relTime, toast,
        getJSON, postJSON, ensureAuth, svg, siteJobs, siteStatus } = window.G99;

const $ = (id) => document.getElementById(id);
const ID = new URLSearchParams(location.search).get("id");

let SITE = null, JOBS = [], AUDIT = null, TARGET = { history: [] };
// A CRO audit fetches the page, screenshots it and runs a Gemini pass — tens of
// seconds. Track it so the UI can show elapsed time instead of a bare spinner.
let AUDITING = false, auditStarted = 0, auditTick;

const verdict = (d) => d == null ? "Not audited yet" : d >= 15 ? "Significant improvement" : d >= 5 ? "Improved" : d >= 0 ? "Stable" : "Regressed";

function healthCard() {
  const cro = AUDIT && typeof AUDIT.overall === "number" ? AUDIT.overall : null;
  const before = AUDIT && typeof AUDIT.before === "number" ? AUDIT.before : null;
  const delta = (cro != null && before != null) ? cro - before : null;
  const cats = (AUDIT && AUDIT.cats) || {};
  const rows = [
    ["Vision & UI", cats.vision], ["UX & Usability", cats.ux],
    ["CRO & Sales", cats.cro], ["Content & Copy", cats.content],
  ].filter(([, v]) => typeof v === "number");

  // While a run is in flight this card *is* the progress indicator — the hero
  // button is the only other entry point, and it's disabled meanwhile.
  if (AUDITING) {
    return `<div class="card pad">
      <div class="card-h"><h2>Conversion health</h2></div>
      <div style="padding:22px 0 18px;text-align:center">
        <div style="display:flex;align-items:center;justify-content:center;gap:9px;font-size:13.5px;font-weight:700">
          <span class="spin" style="margin:0"></span>Auditing ${esc(host(SITE.liveUrl) || "the live site")}…
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          Fetching the page, capturing a screenshot and scoring four disciplines.<br>
          Usually 30–60 seconds — <span id="auditElapsed">0s</span> elapsed. You can leave this page; the result is saved.
        </div>
      </div>
    </div>`;
  }

  return `<div class="card pad">
    <div class="card-h">
      <h2>Conversion health</h2>
    </div>
    ${cro == null ? `
      <p class="empty" style="padding:20px 0 14px">No CRO audit for this site yet.<br>Run one to score its design, UX, conversion path and copy.</p>
      <div style="display:flex;justify-content:center;padding-bottom:8px"><button class="btn primary" id="reaudit2">Run CRO audit</button></div>
    ` : `
      <div class="scores">
        <div class="n"><b style="font-size:26px;color:var(--muted)">${before == null ? "—" : before}</b><i>Before</i></div>
        ${svg("arrow", 18)}
        <div class="n"><b style="font-size:34px;color:${croColor(cro)}">${cro}</b><i>Now</i></div>
        <div style="margin-left:auto;text-align:right">
          ${delta == null ? "" : `<span class="pill ${delta >= 0 ? "good" : "bad"}" style="font-size:13px;padding:3px 10px">${delta >= 0 ? "+" : ""}${delta}</span>`}
          <div style="font-size:11.5px;color:var(--ink-3);font-weight:600;margin-top:5px">${esc(verdict(delta))}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--line-2);padding-top:8px">
        ${rows.map(([label, score]) => `
          <div class="disc">
            <span class="lb">${esc(label)}</span>
            <div class="bar still"><i style="width:${score}%;background:${croColor(score)}"></i></div>
            <span class="sc">${score}</span>
          </div>`).join("")}
      </div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:10px">Audited ${esc(relTime(AUDIT.at))} · ${esc(host(AUDIT.url) || "")}</div>
    `}
  </div>`;
}

function targetCard() {
  const rows = [
    ["Repository", SITE.githubRepo || "not set", SITE.githubRepo ? "https://github.com/" + SITE.githubRepo : null],
    ["Live domain", host(SITE.liveUrl) || "not set", SITE.liveUrl || null],
    ["Theme", TARGET.themeSlug || "unresolved", null],
    ["Merge policy", SITE.requireApproval ? "Approve before merge" : "Auto-merge on green build", null],
  ];
  return `<div class="card pad" style="padding-bottom:10px">
    <div class="card-h"><h2>Edit target</h2></div>
    ${TARGET.resolveError ? `<div class="banner" style="margin:8px 0">${svg("warn", 18)}<div><div class="bt">No theme resolved</div><div class="bd">${esc(TARGET.resolveError.slice(0, 220))}</div></div></div>` : ""}
    ${rows.map(([k, v, href]) => `
      <div class="kv">
        <span class="k" style="flex:none;width:104px">${esc(k)}</span>
        ${href ? `<a class="v" href="${esc(href)}" target="_blank" rel="noopener" style="flex:1">${esc(v)}</a>` : `<span class="v" style="flex:1">${esc(v)}</span>`}
      </div>`).join("")}
    <div style="padding-top:14px;border-top:1px solid var(--line-2);margin-top:4px">
      <label class="switch">
        <input type="checkbox" id="apprToggle" aria-describedby="apprHelp"${SITE.requireApproval ? " checked" : ""}><span class="track"></span>
        Require approval before merge
      </label>
      <p id="apprHelp" style="margin:7px 0 0;font-size:12px;color:var(--muted);line-height:1.5">
        Applies to <strong>every</strong> future run on this site, from any screen. When on, Studio opens the
        pull request and waits for you; when off, it merges as soon as the build passes.
      </p>
    </div>
  </div>`;
}

function historyCard() {
  const h = TARGET.history || [];
  return `<div class="card pad" style="padding-bottom:8px">
    <div class="card-h"><h2>Change history</h2>${h.length ? `<span class="pill">${h.length}</span>` : ""}</div>
    ${!h.length ? `<p class="empty">${TARGET.themeSlug ? "No pull requests for this website yet." : "History unavailable until a theme is resolved."}</p>` : h.map((pr, i) => {
      const st = (pr.state || "").toLowerCase();
      const cls = st === "merged" ? "accent" : st === "closed" ? "" : "good";
      const label = st === "merged" ? "Merged" : st === "closed" ? "Closed" : "Open";
      const ci = { passing: ["good", "CI passed"], failing: ["bad", "CI failed"], pending: ["warn", "CI running"], none: ["", "no CI"] }[pr.build || "none"];
      return `<div class="hist" data-i="${i}">
        <div class="hd">
          <span class="tchip">${svg(pr.type === "build" ? "build" : "edit", 15)}</span>
          <div style="flex:1;min-width:0">
            <div class="nm trunc">${esc(pr.title)}</div>
            <div class="sub trunc">Growth99 AI · ${esc((pr.date || "").slice(0, 10))}</div>
          </div>
          <span class="pill ${ci[0]}">${esc(ci[1])}</span>
          <span class="pill ${cls}">${esc(label)}</span>
          <button class="toggle" data-t="${i}" aria-expanded="false" aria-controls="hist${i}">Details${svg("chevron", 13)}</button>
        </div>
        <div class="det" id="hist${i}">
          <div class="grid">
            <div><span class="k">Pull request</span><div class="v">#${pr.number}</div></div>
            <div><span class="k">Type</span><div class="v">${esc(pr.type)}</div></div>
            <div><span class="k">Repository</span><div class="v">${esc(SITE.githubRepo || "")}</div></div>
          </div>
          <a href="${esc(pr.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;margin-top:11px;font-size:12.5px;font-weight:700">View diff on GitHub${svg("ext", 13)}</a>
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

function runsCard() {
  const mine = siteJobs(SITE.siteId, JOBS).slice(0, 6);
  return `<div class="card pad" style="padding-bottom:10px">
    <div class="card-h"><h2>Studio runs</h2><a class="right linkbtn" href="/jobs">Activity →</a></div>
    ${!mine.length ? `<p class="empty">No Studio runs for this site yet.</p>` : mine.map((j) => {
      const st = window.G99.jobState(j);
      return `<a class="kv" href="/job?id=${encodeURIComponent(j.draftId)}" style="text-decoration:none;color:inherit">
        <div style="flex:1;min-width:0">
          <div class="k trunc">${esc(j.editSummary || (j.payload && j.payload.prompt) || "Website edit")}</div>
          <div class="v" style="font-family:var(--sans);font-size:11.5px">${esc(relTime(j.finishedAt || j.createdAt))}</div>
        </div>
        <span class="pill ${st.cls}">${esc(st.label)}</span>
      </a>`;
    }).join("")}
  </div>`;
}

function render() {
  const color = avatarColor(SITE.businessName);
  const st = siteStatus(SITE, JOBS);
  const domain = host(SITE.liveUrl);
  const needsSetup = !SITE.githubRepo || !SITE.liveUrl;

  $("wrap").innerHTML = `
    <a class="back" href="/sites">${svg("back", 14, 2.2)}All sites</a>

    <div class="hero">
      <span class="ava lg" style="background:${color}">${esc(initials(SITE.businessName))}</span>
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h1>${esc(SITE.businessName)}</h1>
          <span class="pill ${st.cls}"><span class="dot" style="width:6px;height:6px;background:${st.dot}"></span>${esc(st.label)}</span>
        </div>
        ${SITE.liveUrl
          ? `<a class="dom" href="${esc(SITE.liveUrl)}" target="_blank" rel="noopener">${esc(domain)}${svg("ext", 11)}</a>`
          : `<span class="dom">no domain set</span>`}
      </div>
      <div class="acts">
        <button class="btn" id="reauditTop"${AUDITING ? " disabled" : ""}>${svg("chart", 15)}${AUDIT ? "Re-audit" : "Run CRO audit"}</button>
        <button class="btn" id="enrichBtn">${svg("spark", 15)}Add service pages</button>
        <a class="btn primary" href="/edit?site=${encodeURIComponent(SITE.siteId)}">${svg("edit", 15)}Edit this site</a>
      </div>
    </div>

    ${needsSetup ? `<div class="banner">${svg("warn", 18)}<div style="flex:1"><div class="bt">This site isn't fully wired up</div><div class="bd">${esc(!SITE.githubRepo ? "No repository is set in NocoDB — Studio can't open a pull request." : "No domain is set in NocoDB — Studio can't detect the live theme.")}</div></div></div>` : ""}

    <div class="two">
      <div class="card" style="overflow:hidden">
        <div class="frame" style="background:${thumbBg(color)}">
          ${SITE.liveUrl
            ? `<iframe src="${esc(SITE.liveUrl)}" title="Live preview" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>`
            : `<div class="ph"><span class="wm" style="color:${color}">${esc(initials(SITE.businessName))}</span></div>`}
          <span class="tag">Live preview · homepage</span>
          ${SITE.liveUrl ? `<a class="btn open" href="${esc(SITE.liveUrl)}" target="_blank" rel="noopener">Open live site${svg("ext", 13)}</a>` : ""}
        </div>
        <div class="frame-ft">
          <span style="font-weight:600;color:var(--ink-2)">${esc(TARGET.themeSlug || "theme unresolved")}</span>
          <span style="color:var(--muted)" aria-hidden="true">·</span>
          <span>${esc((TARGET.history || []).length)} pull request${(TARGET.history || []).length === 1 ? "" : "s"}</span>
          <span class="mono" style="margin-left:auto;font-size:11px;color:var(--muted)">${esc(SITE.githubRepo || "")}</span>
        </div>
      </div>
      ${healthCard()}
    </div>

    <div class="two flip">
      ${targetCard()}
      ${historyCard()}
    </div>

    ${runsCard()}`;

  wire();
}

// Scale the desktop-width preview to exactly fill its frame, and keep it right
// as the column reflows. Without this the fixed scale left a dead strip.
let pvObserver;
function fitPreview() {
  const frame = document.querySelector(".frame");
  if (!frame || !frame.querySelector("iframe")) return;
  frame.style.setProperty("--pvScale", String(frame.clientWidth / 1280));
}
let pvResizeBound = false;
function watchPreview() {
  fitPreview();
  // ResizeObserver catches column reflow that isn't a window resize (a card
  // growing as history loads); the window listener is the dependable fallback.
  if (pvObserver) pvObserver.disconnect();
  const frame = document.querySelector(".frame");
  if (frame && typeof ResizeObserver !== "undefined") {
    pvObserver = new ResizeObserver(fitPreview);
    pvObserver.observe(frame);
  }
  if (!pvResizeBound) {
    window.addEventListener("resize", fitPreview);
    pvResizeBound = true;
  }
}

function wire() {
  watchPreview();

  const run = async () => {
    if (AUDITING) return;
    if (!SITE.liveUrl) { toast("Set a domain in NocoDB before auditing."); return; }
    AUDITING = true;
    auditStarted = Date.now();
    render();
    clearInterval(auditTick);
    auditTick = setInterval(() => {
      const el = $("auditElapsed");
      if (el) el.textContent = Math.round((Date.now() - auditStarted) / 1000) + "s";
    }, 1000);
    try {
      AUDIT = await postJSON("/api/site-audit", { siteId: SITE.siteId });
      toast("CRO audit complete — score " + AUDIT.overall);
    } catch (e) {
      toast("Audit failed: " + e.message);
    } finally {
      clearInterval(auditTick);
      AUDITING = false;
      render();
    }
  };
  ["reaudit2", "reauditTop"].forEach((id) => { const b = $(id); if (b) b.onclick = run; });

  const eb = $("enrichBtn");
  if (eb) eb.onclick = async () => {
    if (!confirm(`Add revenue-first service pages + a brand guide for "${SITE.businessName}"?\n\nThis opens one PR on the theme and merges when the build is green.`)) return;
    eb.disabled = true;
    try {
      const d = await postJSON("/api/enrich-run", { siteId: SITE.siteId });
      toast("Enrichment started — opening Activity…");
      setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 800);
    } catch (e) { eb.disabled = false; toast("Could not start: " + (e.message || "failed")); }
  };

  const t = $("apprToggle");
  if (t) t.onchange = async () => {
    try {
      const d = await postJSON("/api/site-approval", { siteId: SITE.siteId, requireApproval: t.checked });
      SITE.requireApproval = d.requireApproval;
      toast(d.requireApproval ? "Approval required before merge" : "Auto-merge on green build");
    } catch (e) { t.checked = !t.checked; toast("Could not update: " + e.message); }
  };

  document.querySelectorAll(".toggle[data-t]").forEach((b) => {
    b.onclick = () => {
      const open = b.closest(".hist").classList.toggle("open");
      b.setAttribute("aria-expanded", String(open));
    };
  });
}

async function load() {
  if (!ID) { $("wrap").innerHTML = '<p class="empty">No site id. <a href="/sites">← all sites</a></p>'; return; }
  try {
    const [sitesRes, jobsRes, auditRes] = await Promise.all([
      getJSON("/api/sites"),
      getJSON("/api/jobs").catch(() => ({ jobs: [] })),
      getJSON("/api/site-audit?siteId=" + encodeURIComponent(ID)).catch(() => null),
    ]);
    SITE = (sitesRes.sites || []).find((s) => s.siteId === ID);
    if (!SITE) { $("wrap").innerHTML = '<p class="empty">That website is no longer in NocoDB. <a href="/sites">← all sites</a></p>'; return; }
    JOBS = jobsRes.jobs || [];
    AUDIT = auditRes && typeof auditRes.overall === "number" ? auditRes : null;
    document.title = "Growth99 · " + SITE.businessName;

    render();
    // History needs a GitHub round-trip — paint the page first, fill it in after.
    getJSON("/api/site-history?siteId=" + encodeURIComponent(ID))
      .then((d) => { TARGET = d; render(); })
      .catch((e) => { TARGET = { history: [], resolveError: e.message }; render(); });
  } catch (e) {
    $("wrap").innerHTML = `<p class="empty">Could not load this site: ${esc(e.message)}</p>`;
  }
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
