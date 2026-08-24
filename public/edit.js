// Growth99 Website Studio — Edit a site.
// Two panes: a chat thread on the left where every message you send starts a
// real edit run against that website's own repo, and the site's live homepage
// on the right. Assistant bubbles are bound to a jobId and stream that run's
// actual steps, plan and pull request — nothing here is simulated.
"use strict";

const { esc, avatarColor, initials, host, relTime, toast, getJSON, postJSON, ensureAuth, svg,
        jobState, jobProgress } = window.G99;

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

let SITES = [];
let SITE = null;
let TARGET = null;          // { themeSlug, resolveError }
let THREAD = [];            // [{ role:"user"|"ai", text, jobId?, job? }]
let SENDING = false;
let MODE = "desktop";
// Chat panel collapsed → the live preview gets the full width. Remembered
// across sites and reloads; below 900px the tabs own this instead.
let COLLAPSED = localStorage.getItem("g99chatCollapsed") === "1";
// Which model writes the change. Gemini unless the operator picks otherwise;
// remembered per browser. Only chat-initiated edits carry this — email
// requests never set it and always run on Gemini.
let MODEL = localStorage.getItem("g99editModel") || "gemini";
let MODELS = [];
let poll;
// Files staged via the "+" button, not yet sent. [{filename, mime, dataBase64, kind, isImage, previewUrl}]
let ATTACH = [];
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
// Maps a browser-reported MIME type to the "kind" the server also derives independently from the
// file's actual bytes (see detectAttachmentKind in server.js) — this is only used for the instant
// client-side check and preview; the server never trusts it.
const ATTACH_KIND = {
  "image/png": "image", "image/jpeg": "image", "image/jpg": "image", "image/gif": "image", "image/webp": "image",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const ATTACH_ACCEPT = "image/png,image/jpeg,image/jpg,image/gif,image/webp,application/pdf,application/json,.json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx";

const threadKey = () => "g99thread:" + (SITE ? SITE.siteId : "none");

const PRESETS = [
  ["Change hero text", "M4 6h16M4 12h10M4 18h7", "Update the homepage hero headline and sub-headline to feel more premium and benefit-led."],
  ["Add a page", "M12 4v16m8-8H4", "Add a Terms of Service page with standard sections, and link it in the footer navigation."],
  ["Update colors", "M7 21a4 4 0 01-4-4V5a2 2 0 012-2h14a2 2 0 012 2v12a4 4 0 01-4 4H7z", "Refresh the brand color palette to a warmer, more luxurious tone across the whole site, keeping contrast accessible."],
  ["Add a section", "M4 5a1 1 0 011-1h14a1 1 0 011 1v4H4V5zm0 6h16v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8z", "Add a testimonials section with three patient reviews to the homepage, below the services."],
  ["Fix an SEO issue", "M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z", "Remove any noindex tag and fix the meta title and description so search engines can index the site."],
  ["Update contact info", "M3 5a2 2 0 012-2h3l2 5-2 1a11 11 0 005 5l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 5z", "Update the clinic phone number, address and opening hours in the footer and on the contact page."],
];

// ------------------------------------------------------------------ picker
function showPicker() {
  const old = document.querySelector(".picker");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "picker";
  // This screen runs without the app shell, so the picker is the only chrome
  // there is. It must always offer a way out — close when a site is already
  // loaded behind it, links back into the app when there isn't.
  el.innerHTML = `
    <div class="box2" role="dialog" aria-modal="true" aria-labelledby="pkt">
      <div class="hd" style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <h2 id="pkt">Which site are you editing?</h2>
          <p>Every website registered in NocoDB, each mapped to its own repository.</p>
        </div>
        <button class="btn sm" id="pkx" aria-label="Close">${svg("close", 15, 2.2)}</button>
      </div>
      <div class="list">${SITES.length ? SITES.map((s) => {
        const c = avatarColor(s.businessName);
        const on = SITE && SITE.siteId === s.siteId;
        return `<a class="it" href="/edit?site=${encodeURIComponent(s.siteId)}">
          <span class="ava md" style="background:${c}">${esc(initials(s.businessName))}</span>
          <div style="flex:1;min-width:0"><div class="nm trunc">${esc(s.businessName)}</div><div class="dm trunc">${esc(host(s.liveUrl) || "no domain set")}</div></div>
          ${on ? `<span class="pill">Current</span>` : ""}
        </a>`;
      }).join("") : `<p class="empty">No websites found in NocoDB. Check the table and that NOCODB_TOKEN is set.</p>`}</div>
      <div style="display:flex;gap:14px;align-items:center;padding:12px 20px;border-top:1px solid var(--line);background:var(--surface-2)">
        <a class="linkbtn" href="/sites">${svg("back", 13, 2.2)}All sites</a>
        <a class="linkbtn" href="/">Overview</a>
      </div>
    </div>`;
  const close = () => { if (SITE) { el.remove(); document.removeEventListener("keydown", onKey, true); } };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector("#pkx").onclick = () => {
    // With no site loaded there is nothing behind the modal — go somewhere real.
    if (SITE) close(); else location.href = "/sites";
  };
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
}

// ------------------------------------------------------- version history
// Read straight from GitHub: every commit that touched this site's theme. The
// newest one is what's live; any older one can be restored as a new commit.
function closeVersions() {
  document.querySelectorAll(".vscrim, .vpanel").forEach((el) => el.remove());
  document.removeEventListener("keydown", onVersionKey, true);
  const b = $("history"); if (b) b.setAttribute("aria-expanded", "false");
}
function onVersionKey(e) { if (e.key === "Escape") closeVersions(); }

async function showVersions() {
  closeVersions();
  const scrim = document.createElement("div");
  scrim.className = "vscrim";
  const panel = document.createElement("aside");
  panel.className = "vpanel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "vpt");
  const body = (inner) => `
    <div class="vh2">
      <div style="flex:1;min-width:0">
        <h2 id="vpt">Version history</h2>
        <p>Every change to this site's theme, read live from GitHub. Restoring puts the theme back as it was — later theme changes are discarded.</p>
      </div>
      <button class="btn sm" id="vpx" aria-label="Close version history">${svg("close", 15, 2.2)}</button>
    </div>
    <div class="vlist">${inner}</div>`;
  panel.innerHTML = body(`<p class="empty"><span class="spin"></span>Reading history from GitHub…</p>`);
  scrim.onclick = closeVersions;
  document.addEventListener("keydown", onVersionKey, true);
  document.body.append(scrim, panel);
  panel.querySelector("#vpx").onclick = closeVersions;
  const b = $("history"); if (b) b.setAttribute("aria-expanded", "true");

  let d;
  try { d = await getJSON("/api/site-versions?siteId=" + encodeURIComponent(SITE.siteId)); }
  catch (e) { panel.innerHTML = body(`<p class="empty">Could not read history: ${esc(e.message)}</p>`); panel.querySelector("#vpx").onclick = closeVersions; return; }

  const vs = d.versions || [];
  panel.innerHTML = body(
    d.resolveError ? `<p class="empty">No theme resolved for this site, so there's no history to show.<br>${esc(d.resolveError.slice(0, 160))}</p>`
    : !vs.length ? `<p class="empty">No commits have touched this theme yet.</p>`
    : vs.map((v, i) => `<div class="ver">
        <span class="tchip">${svg(v.current ? "globe" : "clock", 15)}</span>
        <div class="vt">
          <div class="t">${esc(v.title)}</div>
          <div class="m"><span class="sha">${esc(v.short)}</span> · ${esc(relTime(v.date) || (v.date || "").slice(0, 10))}${v.author ? " · " + esc(v.author) : ""}${v.prUrl ? ` · <a href="${esc(v.prUrl)}" target="_blank" rel="noopener">#${v.prNumber}</a>` : ""}</div>
        </div>
        ${v.current
          ? `<span class="pill good">Live now</span>`
          : `<button class="btn sm" data-restore="${i}">Restore</button>`}
      </div>`).join("")
  );
  panel.querySelector("#vpx").onclick = closeVersions;
  panel.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.onclick = () => restoreVersion(vs[+btn.dataset.restore]);
  });
}

async function restoreVersion(v) {
  if (!v) return;
  // A restore merges into a client's live repo — same weight as shipping an
  // edit, so it gets the same explicit confirmation.
  const ok = await window.G99.confirm({
    title: "Restore this version?",
    body: "Studio will roll the theme back to this version, open a pull request and merge it once the build passes. Theme changes made after this version are discarded.",
    details: {
      Site: SITE.businessName,
      Repository: SITE.githubRepo || "not set",
      Version: `${v.short} · ${v.title.length > 60 ? v.title.slice(0, 60) + "…" : v.title}`,
      Dated: (v.date || "").slice(0, 10),
    },
    confirmLabel: "Restore this version",
    tone: "warn",
  });
  if (!ok) return;
  closeVersions();

  const ai = { role: "ai", text: `Restoring ${SITE.businessName} to ${v.short} — ${v.title}.`, jobId: null, job: null };
  THREAD.push(ai);
  renderThread(); save();
  try {
    const d = await postJSON("/api/site-restore", { siteId: SITE.siteId, sha: v.sha, label: v.title });
    ai.jobId = d.jobId;
    save(); renderThread(); startPolling();
  } catch (e) {
    ai.text = "That restore didn't start: " + e.message;
    renderThread(); save();
  }
}

// ------------------------------------------------------------------ render
// Plain-English phase per pipeline step, positionally matched to the server's
// step lists. The Activity screen keeps the technical labels; chat says what's
// happening in words an operator can read at a glance.
const PHASES = {
  edit: ["Pulling the latest code", "Planning the change", "Writing the change", "Opening a pull request", "Waiting for the build to pass", "Finishing up"],
  restore: ["Pulling the latest code", "Rolling the theme back", "Opening a pull request", "Waiting for the build to pass", "Finishing up"],
};
function phaseText(job) {
  const steps = job.steps || [];
  let i = steps.findIndex((s) => s.status === "running");
  if (i < 0) i = Math.max(0, steps.filter((s) => s.status === "done").length - 1);
  return (PHASES[job.type] || [])[i] || (steps[i] && steps[i].label) || "Getting started";
}

// One status line per run — Started → Working → Completed, plus whatever action
// is actually the operator's (approve, open the PR). Every step, file and log
// line stays on the Activity screen behind "Details".
function runBox(job, missing) {
  // A thread survives in localStorage after the server has cleared its jobs.
  // Say so plainly instead of spinning forever on a run that no longer exists.
  if (missing) {
    return `<div class="run">
      <div class="rl" style="color:var(--muted)">${svg("warn", 13)}<span class="grow">Run details no longer available</span></div>
      <div class="sum">This run was cleared from the server — check the site's history for what shipped.</div>
      <div class="acts"><a class="linkbtn" href="/site?id=${encodeURIComponent(SITE.siteId)}">Site history →</a></div>
    </div>`;
  }
  if (!job) {
    return `<div class="run"><div class="rl"><span class="spin"></span><span class="grow">Started</span></div>
      <div class="sum">Getting started</div></div>`;
  }
  const done = job.status === "done";
  const failed = job.status === "error" || job.status === "cancelled";
  const waiting = job.awaitingApproval && !job.approved;
  const head = failed ? (job.status === "cancelled" ? "Cancelled" : "Couldn't finish this change")
    : done ? "Completed — live on the site"
    : waiting ? "Waiting for your approval"
    : job.status === "queued" ? "Started" : "Working on it";
  const color = failed ? "var(--bad-ink)" : done ? "var(--good-ink)" : waiting ? "var(--warn-ink)" : "var(--ink)";
  const icon = done ? svg("check", 13, 2.6) : failed || waiting ? svg("warn", 13) : `<span class="spin"></span>`;
  const running = !done && !failed && !waiting;

  return `<div class="run">
    <div class="rl" style="color:${color}">${icon}<span class="grow">${esc(head)}</span>
      ${done ? `<span class="pill good">Done</span>` : ""}</div>
    ${running ? `<div class="sum">${esc(phaseText(job))}</div>` : ""}
    ${job.editSummary && (done || failed) ? `<div class="sum">${esc(job.editSummary)}</div>` : ""}
    ${job.error ? `<div class="sum" style="color:var(--bad-ink)">${esc(job.error.slice(0, 160))}</div>` : ""}
    <div class="acts">
      ${waiting ? `<button class="btn warn sm" data-approve="${esc(job.draftId)}">Approve &amp; merge</button>` : ""}
      ${job.prUrl ? `<a class="linkbtn" href="${esc(job.prUrl)}" target="_blank" rel="noopener">Pull request${svg("ext", 13)}</a>` : ""}
      <a class="linkbtn end" href="/job?id=${encodeURIComponent(job.draftId)}">Details →</a>
    </div>
  </div>`;
}

function renderThread() {
  const el = $("thread");
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.innerHTML = THREAD.map((m) => {
    if (m.role === "user") {
      const atts = m.attachments || [];
      const thumbs = atts.length
        ? `<div class="msg-thumbs">${atts.map((a) => a.kind === "image"
            ? `<img src="${esc(a.url)}" alt="${esc(a.filename || "attached image")}">`
            : `<span class="msg-filechip">${svg("file", 12)}${esc(a.filename)}</span>`).join("")}</div>`
        : "";
      return `<div class="msg user"><div class="col">${thumbs}<div class="bubble">${esc(m.text)}</div></div></div>`;
    }
    return `<div class="msg"><div class="col">
      <div class="say">${esc(m.text)}</div>
      ${m.jobId ? runBox(m.job, m.missing) : ""}
    </div></div>`;
  }).join("");
  el.querySelectorAll("[data-approve]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await postJSON("/api/job-approve", { id: b.dataset.approve }); toast("Approved — merging…"); refreshJobs(); }
      catch (e) { toast("Could not approve: " + e.message); b.disabled = false; }
    };
  });
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function render() {
  const color = avatarColor(SITE.businessName);
  const domain = host(SITE.liveUrl);

  $("shell").innerHTML = `
    <div class="topbar">
      <a class="back" href="/site?id=${encodeURIComponent(SITE.siteId)}" title="Back to site">${svg("back", 14, 2.2)}</a>
      <span class="ava md" style="background:${color}">${esc(initials(SITE.businessName))}</span>
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px"><h1 class="nm">${esc(SITE.businessName)}</h1><span class="pill">Editing</span></div>
        <div class="dm">${esc(domain || "no domain set")}</div>
      </div>
      <div class="right">
        <button class="btn" id="history" aria-expanded="false" title="Version history">${svg("clock", 15)}History</button>
        <button class="btn" id="togglePane" aria-pressed="${COLLAPSED ? "true" : "false"}" aria-controls="panes" title="${COLLAPSED ? "Show the chat panel" : "Hide the chat panel"}">${svg("panel", 15)}<span id="togglePaneLabel">${COLLAPSED ? "Show chat" : "Hide chat"}</span></button>
        <button class="btn" id="switchSite">Switch site</button>
        <a class="btn primary" href="/jobs">${svg("activity", 15)}All runs</a>
      </div>
    </div>

    <div class="seg mobtabs" id="mobtabs" role="group" aria-label="Switch panel">
      <button data-v="chat" class="on" aria-pressed="true" style="flex:1">Chat</button>
      <button data-v="preview" aria-pressed="false" style="flex:1">Live preview</button>
    </div>

    <div class="panes show-chat${COLLAPSED ? " nochat" : ""}" id="panes">
      <div class="pane chatpane">
        <div class="thread" id="thread"></div>
        <div class="composer">
          <div class="chips" id="chips">${PRESETS.map((p, i) =>
            `<button class="chip" data-p="${i}"><svg style="width:12px;height:12px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="${p[1]}"/></svg>${esc(p[0])}</button>`).join("")}</div>
          <div class="attach-strip" id="attachStrip"></div>
          <div class="box">
            <button type="button" class="iconbtn ghost" id="attachBtn" title="Attach a file (image, PDF, JSON or Word)" aria-label="Attach a file">${svg("plus", 16, 2.2)}</button>
            <input type="file" id="fileInput" accept="${ATTACH_ACCEPT}" multiple style="display:none">
            <textarea id="input" rows="1" placeholder="Describe a change — e.g. make the hero headline bolder"></textarea>
            <button class="iconbtn" id="send" title="Ship this change">${svg("arrow", 16, 2.2)}</button>
          </div>
          <div class="modelrow">
            <label for="model">Model</label>
            <select id="model" title="Which model writes this change"></select>
          </div>
        </div>
      </div>

      <div class="pane prev">
        <div class="pv-bar">
          <div class="lights"><i style="background:#f2b8b5"></i><i style="background:#fadf98"></i><i style="background:#b9e2c0"></i></div>
          <div class="url">${svg("globe", 12)}<span>${esc(domain || "no domain set")}</span></div>
          <button class="btn sm" id="reload">${svg("refresh", 13)}Reload</button>
          <div class="seg" style="margin-left:auto;flex:none">
            <button data-m="desktop" class="${MODE === "desktop" ? "on" : ""}" title="Desktop" style="padding:5px 9px">${svg("desktop", 15)}</button>
            <button data-m="mobile" class="${MODE === "mobile" ? "on" : ""}" title="Mobile" style="padding:5px 9px">${svg("mobile", 15)}</button>
          </div>
        </div>
        ${SITE.liveUrl
          ? `<div class="pv-stage ${MODE}" id="stage"><iframe id="pv" src="${esc(SITE.liveUrl)}" title="Live site preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`
          : `<div class="pv-empty"><div><div style="font-weight:700;margin-bottom:6px">No domain set</div><div style="font-size:13px;color:var(--muted);max-width:320px">Add this website's Domain in NocoDB and the live preview appears here.</div></div></div>`}
      </div>
    </div>`;

  wire();
  renderThread();
}

function wire() {
  const input = $("input");
  input.oninput = () => { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $("send").onclick = send;
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";   // lets the same file be picked again later
    for (const f of files) await addAttachment(f);
  };
  $("attachStrip").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const i = +b.dataset.i;
    if (ATTACH[i].previewUrl) URL.revokeObjectURL(ATTACH[i].previewUrl);
    ATTACH.splice(i, 1);
    renderAttach();
  });
  $("chips").onclick = (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    input.value = PRESETS[+b.dataset.p][2];
    input.focus(); input.dispatchEvent(new Event("input"));
  };
  $("switchSite").onclick = () => showPicker();
  fillModels();
  $("model").onchange = (e) => {
    MODEL = e.target.value;
    localStorage.setItem("g99editModel", MODEL);
  };
  $("history").onclick = showVersions;
  $("togglePane").onclick = () => {
    COLLAPSED = !COLLAPSED;
    localStorage.setItem("g99chatCollapsed", COLLAPSED ? "1" : "0");
    $("panes").classList.toggle("nochat", COLLAPSED);
    $("togglePane").setAttribute("aria-pressed", String(COLLAPSED));
    $("togglePane").title = COLLAPSED ? "Show the chat panel" : "Hide the chat panel";
    $("togglePaneLabel").textContent = COLLAPSED ? "Show chat" : "Hide chat";
  };
  $("mobtabs").onclick = (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    // Toggle rather than reassign — .nochat must survive a tab switch.
    const panes = $("panes");
    panes.classList.toggle("show-chat", b.dataset.v === "chat");
    panes.classList.toggle("show-preview", b.dataset.v === "preview");
    [...$("mobtabs").children].forEach((x) => {
      const on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", String(on));
    });
  };
  const rl = $("reload"); if (rl) rl.onclick = reloadPreview;
  document.querySelectorAll("[data-m]").forEach((b) => {
    b.onclick = () => {
      MODE = b.dataset.m;
      document.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b));
      const st = $("stage"); if (st) st.className = "pv-stage " + MODE;
    };
  });
}

// ------------------------------------------------------------------ attachments
// Read client-side (FileReader → base64), previewed instantly via an object URL
// (images only — a PDF/JSON/Word chip just gets a file icon), and only actually
// uploaded to the server once the message is sent — picking a file and then not
// sending should cost nothing.
async function addAttachment(file) {
  // Some OS file pickers report a .json file as text/plain rather than application/json —
  // the extension is the fallback for exactly that case. The server re-derives the kind
  // from the actual bytes regardless, so a wrong guess here only affects the chip's icon.
  const kind = ATTACH_KIND[file.type] || (/\.json$/i.test(file.name) ? "json" : null) || (/\.docx$/i.test(file.name) ? "docx" : null);
  if (!kind) {
    // Old Word/Excel/PowerPoint (.doc/.xls/.ppt) is a different, much older binary format than the
    // ZIP-based .docx — worth naming specifically since "unsupported" alone doesn't tell someone with
    // a .doc file what to actually do about it.
    if (/\.(doc|xls|ppt)$/i.test(file.name)) {
      toast(`${file.name} is an old .doc/.xls/.ppt file (Word 97-2003 format) — only the modern .docx is supported. Save it as .docx and try again.`);
    } else {
      toast(`${file.name}: only images, PDF, JSON or Word (.docx) files are supported.`);
    }
    return;
  }
  if (file.size > ATTACH_MAX_BYTES) { toast(`${file.name} is too large — max 10MB.`); return; }
  let dataBase64;
  try {
    dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("could not read file"));
      r.readAsDataURL(file);
    });
  } catch (e) { toast(`Could not read ${file.name}.`); return; }
  const isImage = kind === "image";
  ATTACH.push({ filename: file.name, mime: file.type, dataBase64, kind, isImage, previewUrl: isImage ? URL.createObjectURL(file) : null });
  renderAttach();
}
const ATTACH_KIND_LABEL = { pdf: "PDF", json: "JSON", docx: "Word" };
function renderAttach() {
  const el = $("attachStrip");
  if (!el) return;
  el.innerHTML = ATTACH.map((a, i) => `
    <div class="attach-chip">
      ${a.isImage ? `<img src="${a.previewUrl}" alt="">` : `<span class="af" title="${esc(ATTACH_KIND_LABEL[a.kind] || a.kind)}">${svg("file", 14)}</span>`}
      <span class="an" title="${esc(a.filename)}">${esc(a.filename)}</span>
      <button type="button" class="ax" data-i="${i}" aria-label="Remove ${esc(a.filename)}">${svg("close", 11, 2.4)}</button>
    </div>`).join("");
}

// Groups the options by provider so "Ollama" reads as a provider with models
// under it, rather than five unrelated names in a flat list.
function fillModels() {
  const sel = $("model");
  if (!sel) return;
  const list = MODELS.length ? MODELS : [{ id: "gemini", label: "Gemini", group: "Google", available: true }];
  if (!list.some((m) => m.id === MODEL && m.available)) MODEL = "gemini";
  const groups = [];
  list.forEach((m) => {
    const g = groups.find((x) => x.name === m.group) || (groups.push({ name: m.group, items: [] }), groups[groups.length - 1]);
    g.items.push(m);
  });
  sel.innerHTML = groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((m) =>
    `<option value="${esc(m.id)}"${m.id === MODEL ? " selected" : ""}${m.available ? "" : " disabled"}>${esc(m.label)}${m.available ? "" : " — key not set"}</option>`
  ).join("")}</optgroup>`).join("");
  sel.value = MODEL;
}

function reloadPreview() {
  const f = $("pv");
  if (!f) return;
  // Cache-bust so a just-deployed change actually shows up.
  const u = new URL(SITE.liveUrl);
  u.searchParams.set("_g99", Date.now());
  f.src = u.toString();
}

// ------------------------------------------------------------------ actions
async function send() {
  if (SENDING) return;
  const text = $("input").value.trim();
  if (!text && !ATTACH.length) return;
  if (!SITE.githubRepo) { toast("This website has no repository set in NocoDB."); return; }
  if (TARGET && TARGET.resolveError) { toast("No editable theme resolved — see the site page."); return; }

  const pending = ATTACH.slice();   // snapshot — ATTACH is cleared before the async upload below

  // Sending opens a real pull request against a client repo — never on a
  // stray Enter. Confirm names the repo, the theme and the merge policy.
  const ok = await window.G99.confirm({
    title: "Ship this change?",
    body: "Studio will write the change, open a pull request and merge it automatically once the build passes.",
    details: {
      Site: SITE.businessName,
      Repository: SITE.githubRepo,
      Theme: (TARGET && TARGET.themeSlug) || "resolving…",
      Change: text ? (text.length > 120 ? text.slice(0, 120) + "…" : text) : "(uses the attached file only)",
      ...(pending.length ? { Attached: pending.map((a) => a.filename).join(", ") } : {}),
    },
    confirmLabel: "Ship it",
  });
  if (!ok) return;

  SENDING = true;
  $("send").disabled = true;
  $("input").value = ""; $("input").style.height = "auto";
  ATTACH = []; renderAttach();

  // Attachments upload first so the chat bubble and the job prompt can both carry the
  // real, stable /uploads/… URL rather than a throwaway object URL.
  let attachments = [];
  if (pending.length) {
    const uploading = { role: "ai", text: `Uploading ${pending.length} file${pending.length > 1 ? "s" : ""}…`, jobId: null, job: null };
    THREAD.push(uploading); renderThread();
    try {
      const uploaded = await Promise.all(pending.map((a) => postJSON("/api/upload-attachment", { filename: a.filename, dataBase64: a.dataBase64 })));
      attachments = uploaded.map((u, i) => ({ url: u.url, filename: pending[i].filename, kind: u.kind }));
    } catch (e) {
      THREAD.splice(THREAD.indexOf(uploading), 1);
      toast("Could not upload the attached file: " + e.message);
      pending.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      renderThread();
      SENDING = false; $("send").disabled = false;
      return;
    }
    THREAD.splice(THREAD.indexOf(uploading), 1);
    pending.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
  }

  const finalText = text || "Use the attached file as directed.";
  THREAD.push({ role: "user", text: finalText, attachments });
  const ai = { role: "ai", text: `On it — applying that to ${SITE.businessName}. It merges automatically once the build passes.`, jobId: null, job: null };
  THREAD.push(ai);
  renderThread(); save();

  try {
    const d = await postJSON("/api/edit-run", { siteId: SITE.siteId, prompt: finalText, aiModel: MODEL, attachments });
    ai.jobId = d.jobId;
    save(); renderThread(); startPolling();
  } catch (e) {
    ai.text = "That didn't start: " + e.message;
    renderThread(); save();
  } finally {
    SENDING = false;
    $("send").disabled = false;
  }
}

// ------------------------------------------------------------------ polling
async function refreshJobs() {
  const ids = THREAD.filter((m) => m.jobId).map((m) => m.jobId);
  if (!ids.length) return false;
  let live = false, justFinished = false;
  const jobs = await Promise.all(ids.map((id) => getJSON("/api/job?id=" + encodeURIComponent(id)).catch(() => null)));
  THREAD.filter((m) => m.jobId).forEach((m, i) => {
    const j = jobs[i];
    if (!j) { if (!m.job) m.missing = true; return; }   // never resolved → it's gone
    m.missing = false;
    const was = m.job && m.job.status;
    m.job = j;
    if (was && was !== "done" && j.status === "done") justFinished = true;
    if (j.status === "running" || j.status === "queued") live = true;
  });
  renderThread();
  if (justFinished) { toast("Change is live — reloading the preview."); setTimeout(reloadPreview, 1500); }
  return live;
}

function startPolling() {
  clearInterval(poll);
  const tick = async () => { const live = await refreshJobs(); if (!live) clearInterval(poll); };
  tick();
  poll = setInterval(tick, 3000);
}

// ------------------------------------------------------------------ storage
function save() {
  try {
    localStorage.setItem(threadKey(), JSON.stringify(THREAD.map((m) => ({ role: m.role, text: m.text, jobId: m.jobId || null, attachments: m.attachments || undefined }))));
  } catch (e) { /* quota — the thread is a convenience, jobs are the source of truth */ }
}
function restore() {
  try { THREAD = JSON.parse(localStorage.getItem(threadKey()) || "[]"); } catch (e) { THREAD = []; }
  if (!THREAD.length) {
    THREAD = [{ role: "ai", text: `I'm looking at ${SITE.businessName}. Tell me what you'd like to change and I'll ship it to ${SITE.githubRepo || "its repo"} as a pull request. The live site is on the right.` }];
  }
}

// ------------------------------------------------------------------ boot
async function load() {
  try {
    const d = await getJSON("/api/sites");
    SITES = (d.sites || []).sort((a, b) => (a.businessName || "").localeCompare(b.businessName || ""));
  } catch (e) {
    $("shell").innerHTML = `<p class="empty">Could not load websites: ${esc(e.message)}</p>`;
    return;
  }
  const want = qs.get("site");
  SITE = SITES.find((s) => s.siteId === want) || null;
  if (!SITE) {
    $("shell").innerHTML = `
      <div style="margin:auto;text-align:center;max-width:420px">
        <h1 style="font-size:20px;margin:0 0 8px">Edit a site</h1>
        <p class="empty" style="padding:0 0 16px">Pick a website to edit.</p>
        <div style="display:flex;gap:9px;justify-content:center">
          <a class="btn" href="/sites">All sites</a>
          <a class="btn" href="/">Overview</a>
        </div>
      </div>`;
    showPicker();
    return;
  }

  document.title = "Growth99 · Editing " + SITE.businessName;
  getJSON("/api/ai-models").then((d) => { MODELS = d.models || []; fillModels(); }).catch(() => {});
  restore();
  render();
  startPolling();

  // Confirm which theme an edit would target; surface the error inline if none.
  getJSON("/api/site-history?siteId=" + encodeURIComponent(SITE.siteId))
    .then((t) => {
      TARGET = t;
      if (t.resolveError) {
        THREAD.push({ role: "ai", text: "Heads up — I couldn't work out which theme to edit for this site: " + t.resolveError });
        renderThread();
      }
    })
    .catch(() => {});
}

ensureAuth().then((ok) => {
  if (!ok) { $("shell").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
