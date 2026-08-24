// Growth99 Website Studio — site detail. Live preview, conversion health from
// the cached CRO audit, the resolved edit target, and the site's PR history.
"use strict";

const { esc, avatarColor, initials, host, thumbBg, croColor, relTime, toast,
        getJSON, postJSON, ensureAuth, svg, siteJobs, siteStatus } = window.G99;

const $ = (id) => document.getElementById(id);
const ID = new URLSearchParams(location.search).get("id");

// TARGET starts as loading, not empty: resolving the theme is an 8s GitHub
// round-trip, and rendering "unresolved" for those 8 seconds reads as a broken
// site rather than one that has not answered yet.
let SITE = null, JOBS = [], AUDIT = null, TARGET = { history: [], loading: true };
// A CRO audit fetches the page, screenshots it and runs a Gemini pass — tens of
// seconds. Track it so the UI can show elapsed time instead of a bare spinner.
let AUDITING = false, auditStarted = 0, auditTick;
// Image-quality audit of the live site (true pixel size of every image).
let IMG = null, IMG_RUNNING = false;

function imageCard() {
  if (!IMG && !IMG_RUNNING) return "";
  if (IMG_RUNNING) {
    return `<div class="card pad">
      <div class="card-h"><h2>Image quality</h2></div>
      <p class="empty" style="padding:16px 0"><span class="spin"></span>Measuring every image on the live site…</p>
    </div>`;
  }
  const t = IMG.totals || { total: 0, low: 0 };
  const rows = (IMG.pages || []).filter((p) => p.total || p.error).map((p) => {
    const bad = p.low > 0;
    return `<div class="disc" style="align-items:center">
      <span class="lb" style="font-family:var(--mono);font-size:11.5px">${esc(p.path)}</span>
      <span style="flex:1;font-size:12.5px;color:var(--muted)">${p.error
        ? esc(p.error)
        : `${p.total} image${p.total === 1 ? "" : "s"}${p.minWidth ? ` · ${p.minWidth}–${p.maxWidth}px wide` : ""}`}</span>
      <span class="pill ${p.error ? "" : bad ? "bad" : "good"}">${p.error ? "unreachable" : bad ? p.low + " low-res" : "sharp"}</span>
    </div>`;
  }).join("");
  return `<div class="card pad">
    <div class="card-h">
      <h2>Image quality</h2>
      <span class="right pill ${IMG.pass ? "good" : "bad"}">${IMG.pass ? "All sharp" : t.low + " need attention"}</span>
    </div>
    <p style="font-size:12.5px;color:var(--ink-3);margin:0 0 10px">
      ${t.total} image${t.total === 1 ? "" : "s"} measured at their true pixel size across ${(IMG.pages || []).length} page(s).
      Anything under ${IMG.minWidth}px wide looks soft when stretched.
    </p>
    ${rows}
    <div style="font-size:11.5px;color:var(--muted);margin-top:10px">Checked ${esc(relTime(IMG.checkedAt))}</div>
  </div>`;
}

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
    ["Beta domain", host(SITE.liveUrl) || "not set", SITE.liveUrl || null],
    // The client's CURRENT site — read by Perform PR for its sitemap, to catch
    // pages the rebuild missed. Not derivable from the beta domain.
    ["Live site", host(SITE.existingSiteUrl) || "not set", SITE.existingSiteUrl || null],
    ["Theme", TARGET.themeSlug || (TARGET.loading ? "resolving…" : "unresolved"), null],
    ["Merge policy", "Auto-merge on green build", null],
  ];
  return `<div class="card pad" style="padding-bottom:10px">
    <div class="card-h"><h2>Edit target</h2></div>
    ${!TARGET.loading && TARGET.resolveError ? `<div class="banner" style="margin:8px 0">${svg("warn", 18)}<div><div class="bt">No theme resolved</div><div class="bd">${esc(TARGET.resolveError.slice(0, 220))}</div></div></div>` : ""}
    ${rows.map(([k, v, href]) => `
      <div class="kv">
        <span class="k" style="flex:none;width:104px">${esc(k)}</span>
        ${href ? `<a class="v" href="${esc(href)}" target="_blank" rel="noopener" style="flex:1">${esc(v)}</a>` : `<span class="v" style="flex:1">${esc(v)}</span>`}
      </div>`).join("")}
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

// ------------------------------------------------- "Edit with…" hand-off
// Sends this site's context to a coding agent instead of Studio's own pipeline —
// for the complex changes (layout, new templates) the chat flow isn't for.
// Only Cursor has a documented prompt deeplink; the others are launched locally
// by the server, which only works when Studio runs on the operator's machine.
const IDES = [
  { id: "claude", label: "Claude Code", how: "local",
    note: "Opens a terminal on this machine running Claude Code, already loaded with the task." },
  { id: "cursor", label: "Cursor", how: "deeplink",
    note: "Opens Cursor and drops the prompt straight into its chat. Works from any machine with Cursor installed." },
  { id: "antigravity", label: "Antigravity", how: "local",
    note: "Opens Antigravity on this machine in a fresh workspace with the task file alongside it." },
];
let IDE = "claude";
let IDE_LOCAL = null;   // null = not checked yet

function idePrompt(instruction) {
  const repo = SITE.githubRepo ? `https://github.com/${SITE.githubRepo}` : "";
  const lines = [
    `# Website change — ${SITE.businessName}`,
    "",
    repo ? `Repository: ${repo}` : "Repository: (none set for this site yet)",
  ];
  if (SITE.liveUrl) lines.push(`Live site: ${SITE.liveUrl}`);
  if (TARGET.themeSlug) lines.push(`Theme: web/app/themes/${TARGET.themeSlug}`);
  lines.push("", "## Task", "", instruction.trim() || "(describe the change here)", "", "## Ground rules", "");
  if (repo) lines.push(`- Clone ${repo} if you don't already have it, and work on a new branch.`);
  if (TARGET.themeSlug) lines.push(`- Only change files under \`web/app/themes/${TARGET.themeSlug}\` — this repo hosts other clients' sites too.`);
  lines.push("- Open a pull request against `main` when you're done. Never push straight to `main`.");
  lines.push("- This is a live client website: keep existing content and links intact unless the task says otherwise.");
  return lines.join("\n");
}

function ideModal() {
  const old = document.querySelector(".g99scrim"); if (old) old.remove();
  const scrim = document.createElement("div");
  scrim.className = "g99scrim";
  scrim.innerHTML = `
    <div class="g99panel idepanel" role="dialog" aria-modal="true" aria-labelledby="idet">
      <div class="ph">
        <div style="flex:1;min-width:0">
          <h2 id="idet">Edit with a coding agent</h2>
          <p>For bigger changes than the chat flow handles — layouts, new templates, refactors. Studio builds the prompt; your tool does the work.</p>
        </div>
        <button class="btn sm" id="idex" aria-label="Close">${svg("close", 15, 2.2)}</button>
      </div>
      <div class="pbody">
        <div class="idetabs" id="idetabs" role="tablist" aria-label="Choose a tool">
          ${IDES.map((t) => `<button role="tab" data-ide="${t.id}" class="${t.id === IDE ? "on" : ""}" aria-selected="${t.id === IDE}">${esc(t.label)}</button>`).join("")}
        </div>
        <div class="idefield">
          <label for="iderepo">Repository</label>
          <div class="ro" id="iderepo">${esc(SITE.githubRepo ? "https://github.com/" + SITE.githubRepo : "No repository set for this site in NocoDB")}</div>
        </div>
        <div class="idefield">
          <label for="ideinstr">What should it do?</label>
          <textarea id="ideinstr" rows="3" placeholder="e.g. Redesign the complete UI of the home page"></textarea>
        </div>
        <div class="idefield" id="idefinalwrap" hidden>
          <label for="idefinal">Prompt — edit it if you like</label>
          <textarea id="idefinal" class="final" rows="12" spellcheck="false"></textarea>
        </div>
        <p class="idenote" id="idenote"></p>
      </div>
      <div class="pf">
        <button class="btn" id="idegen">Generate prompt</button>
        <div class="end">
          <button class="btn" id="idecopy" disabled>Copy</button>
          <button class="btn primary" id="idesend" disabled>Send</button>
        </div>
      </div>
    </div>`;
  const close = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(scrim);
  scrim.querySelector("#idex").onclick = close;

  const $$ = (id) => scrim.querySelector("#" + id);
  const tool = () => IDES.find((t) => t.id === IDE);

  // The launcher needs Studio to be running on this machine; ask once and cache.
  const noteFor = () => {
    const t = tool();
    if (t.how === "deeplink") return t.note;
    if (IDE_LOCAL === false) return `${t.label} can't be launched from here — Studio is running on a remote server, so use Copy and paste it into ${t.label} yourself.`;
    return t.note;
  };
  const paint = () => {
    scrim.querySelectorAll("[data-ide]").forEach((b) => {
      const on = b.dataset.ide === IDE;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    $$("idenote").textContent = noteFor();
    $$("idesend").textContent = "Send to " + tool().label;
  };
  const generate = () => {
    $$("idefinal").value = idePrompt($$("ideinstr").value);
    $$("idefinalwrap").hidden = false;
    $$("idecopy").disabled = false;
    $$("idesend").disabled = false;
  };

  $$("idetabs").onclick = (e) => {
    const b = e.target.closest("[data-ide]"); if (!b) return;
    IDE = b.dataset.ide; paint();
  };
  $$("idegen").onclick = generate;
  $$("ideinstr").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(); };
  $$("idecopy").onclick = async () => {
    try { await navigator.clipboard.writeText($$("idefinal").value); toast("Prompt copied."); }
    catch (e) { $$("idefinal").select(); toast("Press Ctrl+C to copy."); }
  };
  $$("idesend").onclick = async () => {
    const text = $$("idefinal").value.trim();
    if (!text) { toast("Generate the prompt first."); return; }
    const t = tool();
    if (t.how === "deeplink") {
      // Cursor's documented deeplink caps out at 8000 characters once encoded.
      const url = "cursor://anysphere.cursor-deeplink/prompt?text=" + encodeURIComponent(text);
      if (url.length > 8000) { toast("Prompt is too long for Cursor's link — use Copy instead."); return; }
      location.href = url;
      toast("Opening Cursor… if nothing happens, use Copy.");
      return;
    }
    const b = $$("idesend"); b.disabled = true; b.textContent = "Opening…";
    try {
      const d = await postJSON("/api/ide-launch", { ide: IDE, prompt: text, siteId: SITE.siteId });
      toast(`${d.tool} is opening on this machine.`);
      close();
    } catch (e) {
      toast(e.message);
      b.disabled = false; b.textContent = "Send to " + t.label;
    }
  };

  paint();
  $$("ideinstr").focus();
  if (IDE_LOCAL === null) {
    getJSON("/api/ide-support").then((d) => { IDE_LOCAL = !!d.local; paint(); }).catch(() => { IDE_LOCAL = false; paint(); });
  }
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
        <button class="btn" id="seoBtn" title="Shift-click for a dry run — writes the result to a preview folder, no pull request">${svg("search", 15)}Perform SEO</button>
        <button class="btn" id="preReleaseBtn" title="Mobile responsiveness pass across every registered page">${svg("mobile", 15)}Perform PR</button>
        <button class="btn" id="performPrBtn" title="Pre-release checks: business name, contact details, CTAs, favicon, images, spelling — auto-fixes what is deterministic, reports the rest">${svg("check", 15)}Perform PR (new)</button>
        <button class="btn" id="imgBtn"${IMG_RUNNING ? " disabled" : ""}>${svg("panel", 15)}${IMG_RUNNING ? "Checking images…" : "Check images"}</button>
        <a class="btn" href="/coverage?siteId=${encodeURIComponent(SITE.siteId)}">${svg("sites", 15)}Page coverage</a>
        <button class="btn" id="editWith">${svg("code", 15)}Edit with…</button>
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

    ${imageCard()}

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
  const sb = $("seoBtn");
  // Shift-click is a dry run: everything happens except the branch, the push
  // and the pull request. Useful while the engine is being tuned, since a real
  // run costs a PR and a CI cycle each time.
  if (sb) sb.onclick = async (ev) => {
    const dryRun = ev.shiftKey;
    const msg = dryRun
      ? `Dry run the SEO pass over every page of "${SITE.businessName}"?\n\nEverything is worked out and written to a preview folder — no branch, no pull request, nothing reaches GitHub.`
      : `Run the full SEO pass over every page of "${SITE.businessName}"?\n\nKeywords, titles, descriptions, canonicals, social cards, headings, image alt text, internal links and schema — plus a content audit. One PR, merged when the build is green.`;
    if (!confirm(msg)) return;
    sb.disabled = true;
    try {
      const d = await postJSON("/api/seo-run", { siteId: SITE.siteId, dryRun });
      toast(d.dedupe ? "An SEO run is already going — opening it…" : `SEO ${dryRun ? "dry run" : "run"} started — opening Activity…`);
      setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 800);
    } catch (e) { sb.disabled = false; toast("Could not start: " + (e.message || "failed")); }
  };
  const prb = $("preReleaseBtn");
  if (prb) prb.onclick = async () => {
    const msg = `Perform pre-release checks for "${SITE.businessName}"?

Current task: capture and audit every registered page at a mobile viewport, fix evidenced responsive issues, open one PR, follow this site's CI/approval policy, then capture post-release proof.`;
    if (!confirm(msg)) return;
    prb.disabled = true;
    try {
      const d = await postJSON("/api/pre-release-run", { siteId: SITE.siteId });
      toast(d.dedupe ? "A pre-release run is already going - opening it..." : "Pre-release run started - opening Activity...");
      setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 800);
    } catch (e) { prb.disabled = false; toast("Could not start: " + (e.message || "failed")); }
  };
  const ppr = $("performPrBtn");
  if (ppr) ppr.onclick = async () => {
    const msg = `Run pre-release checks for "${SITE.businessName}"?

Audits the built site against the client's live site: business name, contact details, clickable phone/email, CTAs, favicon, image naming and weight, spelling, and a page-by-page content audit.

Auto-fixes only what has one correct answer (favicon, 404, Call Now, BLVD button IDs, blog link colour, clickable contact), opens one PR, then verifies links and sharing images on the deployed site. Everything else is reported, not guessed.`;
    if (!confirm(msg)) return;
    ppr.disabled = true;
    try {
      const d = await postJSON("/api/perform-pr-run", { siteId: SITE.siteId });
      toast(d.dedupe ? "A pre-release run is already going — opening it…" : "Pre-release run started — opening Activity…");
      setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 800);
    } catch (e) { ppr.disabled = false; toast("Could not start: " + (e.message || "failed")); }
  };
  const ib = $("imgBtn");
  if (ib) ib.onclick = async () => {
    IMG_RUNNING = true; render();
    try { IMG = await postJSON("/api/image-audit", { siteId: SITE.siteId }); }
    catch (e) { toast("Image check failed: " + (e.message || "failed")); }
    finally {
      IMG_RUNNING = false; render();
      if (IMG) toast(IMG.pass ? `All ${IMG.totals.total} images are sharp` : `${IMG.totals.low} low-resolution image(s) found`);
    }
  };
  const ew = $("editWith"); if (ew) ew.onclick = ideModal;

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
    const [sitesRes, jobsRes, auditRes, imgRes] = await Promise.all([
      getJSON("/api/sites"),
      getJSON("/api/jobs").catch(() => ({ jobs: [] })),
      getJSON("/api/site-audit?siteId=" + encodeURIComponent(ID)).catch(() => null),
      getJSON("/api/image-audit?siteId=" + encodeURIComponent(ID)).catch(() => null),
    ]);
    SITE = (sitesRes.sites || []).find((s) => s.siteId === ID);
    if (!SITE) { $("wrap").innerHTML = '<p class="empty">That website is no longer in NocoDB. <a href="/sites">← all sites</a></p>'; return; }
    JOBS = jobsRes.jobs || [];
    AUDIT = auditRes && typeof auditRes.overall === "number" ? auditRes : null;
    IMG = imgRes && imgRes.pages ? imgRes : null;   // last image audit, if any
    document.title = "Growth99 · " + SITE.businessName;

    render();
    // History needs a GitHub round-trip — paint the page first, fill it in after.
    getJSON("/api/site-history?siteId=" + encodeURIComponent(ID))
      .then((d) => { TARGET = { ...d, loading: false }; render(); })
      .catch((e) => { TARGET = { history: [], loading: false, resolveError: e.message }; render(); });
  } catch (e) {
    $("wrap").innerHTML = `<p class="empty">Could not load this site: ${esc(e.message)}</p>`;
  }
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
