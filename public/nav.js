// Growth99 Website Studio — app shell (left rail + sticky header + ⌘K palette)
// and the small helper namespace every Studio page script builds on.
// Injected on every page. Opt a page out of the chrome with <body data-shell="none">.
(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers
  // One admin-key fetch wrapper for the whole app. Idempotent: older page
  // scripts install their own, and wrapping twice only re-sets the header.
  if (!window.__g99Fetch) {
    const raw = window.fetch.bind(window);
    window.__g99Fetch = raw;
    window.fetch = (url, opts = {}) => {
      if (String(url).startsWith("/api/")) opts.headers = { ...(opts.headers || {}), "x-admin-key": localStorage.getItem("g99AdminKey") || "" };
      return raw(url, opts);
    };
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Deterministic per-site colour, drawn from the design's accent family so the
  // avatars across Overview / Sites / Activity read as one palette.
  // Avatars carry white initials, so every entry clears 4.5:1 against #fff.
  const PALETTE = ["#5b4df0", "#0c8378", "#a76809", "#c64c6c", "#2563eb", "#64748b", "#7c3aed", "#07809e"];
  function avatarColor(s) {
    let h = 0;
    for (const c of String(s || "?")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  const initials = (name) => (name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const host = (url) => { try { return new URL(url).host; } catch (e) { return String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); } };

  function thumbBg(color) { return `linear-gradient(135deg, color-mix(in srgb, ${color} 13%, #ffffff), var(--surface-2))`; }

  // CRO score → the design's three-band colour ramp.
  // croColor is for display-size numbers (≥18.66px bold / ≥24px), where 3:1 applies.
  // croInk is the same ramp for anything smaller, where 4.5:1 does.
  function croColor(c) { return c == null ? "var(--muted)" : c >= 80 ? "var(--good)" : c >= 65 ? "var(--accent)" : "var(--warn)"; }
  function croInk(c) { return c == null ? "var(--muted)" : c >= 80 ? "var(--good-ink)" : c >= 65 ? "var(--accent)" : "var(--warn-ink)"; }
  // Signed deltas are always small text.
  const deltaInk = (d) => (d == null ? "var(--muted)" : d >= 0 ? "var(--good-ink)" : "var(--bad-ink)");

  function relTime(iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 172800) return "yesterday";
    return Math.round(s / 86400) + "d ago";
  }

  let toastT;
  function toast(m) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    // Announced to screen readers: the toast is this app's only feedback channel.
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    t.textContent = m; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3600);
  }

  // Promise<boolean> confirmation for anything irreversible or expensive.
  // Resolves false on cancel, scrim click or Escape. Focus lands on the cancel
  // button so a stray Enter never confirms.
  function confirmAction({ title, body, details, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "primary" }) {
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      scrim.className = "g99scrim";
      scrim.innerHTML = `
        <div class="g99panel" role="dialog" aria-modal="true" aria-labelledby="g99cft">
          <div class="pb">
            <h2 id="g99cft">${esc(title)}</h2>
            ${body ? `<p>${esc(body)}</p>` : ""}
            ${details ? `<dl>${Object.entries(details).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
          </div>
          <div class="pf">
            <button class="btn" data-x="no">${esc(cancelLabel)}</button>
            <button class="btn ${tone === "danger" ? "danger" : tone === "warn" ? "warn" : "primary"}" data-x="yes">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      const done = (v) => { window.removeEventListener("keydown", onKey, true); scrim.remove(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      };
      scrim.addEventListener("click", (e) => { if (e.target === scrim) done(false); });
      scrim.querySelector('[data-x="no"]').onclick = () => done(false);
      scrim.querySelector('[data-x="yes"]').onclick = () => done(true);
      window.addEventListener("keydown", onKey, true);
      document.body.appendChild(scrim);
      scrim.querySelector('[data-x="no"]').focus();
    });
  }

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

  async function getJSON(url) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || "request failed (" + r.status + ")");
    return d;
  }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || "request failed (" + r.status + ")");
    return d;
  }

  const IC = {
    home: `<path stroke-linecap="round" stroke-linejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/>`,
    sites: `<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6" fill="currentColor"/>`,
    plus: `<path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m7-7H5"/>`,
    activity: `<path stroke-linecap="round" stroke-linejoin="round" d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
    search: `<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z"/>`,
    edit: `<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z"/>`,
    build: `<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>`,
    chart: `<path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m0 0v-6a2 2 0 012-2h2a2 2 0 012 2v6a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>`,
    ext: `<path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>`,
    back: `<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>`,
    check: `<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>`,
    warn: `<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>`,
    arrow: `<path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5-5 5M5 12h13"/>`,
    close: `<path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18"/>`,
    globe: `<path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18 15 15 0 010-18z"/>`,
    repo: `<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v13.5A2.5 2.5 0 006.5 20H20M4 4h13a3 3 0 013 3v13M8 8h6"/>`,
    spark: `<path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.3 6.9L21 12l-5.7 2.1L13 21l-2.3-6.9L5 12l5.7-2.1L13 3z"/>`,
    desktop: `<rect x="3" y="4" width="18" height="12" rx="2"/><path stroke-linecap="round" d="M8 20h8M12 16v4"/>`,
    mobile: `<rect x="7" y="3" width="10" height="18" rx="2"/><path stroke-linecap="round" d="M11 18h2"/>`,
    refresh: `<path stroke-linecap="round" stroke-linejoin="round" d="M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8"/>`,
    code: `<path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>`,
    chevron: `<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>`,
    menu: `<path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M4 12h16M4 17h16"/>`,
    panel: `<rect x="3" y="4" width="18" height="16" rx="2"/><path stroke-linecap="round" d="M10 4v16"/>`,
    clock: `<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3.5 2"/>`,
  };
  // svg(name) → a 1em icon; svg(name, 18) → sized.
  const svg = (name, size, sw) =>
    `<svg style="width:${size || 15}px;height:${size || 15}px;flex:none" fill="none" stroke="currentColor" stroke-width="${sw || 2}" viewBox="0 0 24 24">${IC[name] || ""}</svg>`;

  // ------------------------------------------------------------ job mapping
  // Both build and edit jobs carry a `steps[]` of {label,status,detail}; every
  // screen that shows a run derives its pill / bar / caption from these three.
  function jobProgress(j) {
    const st = j.steps || [];
    if (!st.length) return j.status === "done" ? 100 : 0;
    return Math.round((st.filter((s) => s.status === "done").length / st.length) * 100);
  }
  function jobState(j) {
    if (j.awaitingApproval && !j.approved) return { key: "approval", label: "Needs approval", cls: "warn", bar: "var(--warn)" };
    return ({
      running: { key: "running", label: "Running", cls: "accent", bar: "var(--accent)" },
      queued: { key: "queued", label: "Queued", cls: "", bar: "var(--muted)" },
      done: { key: "done", label: "Done", cls: "good", bar: "var(--good)" },
      error: { key: "error", label: "Failed", cls: "bad", bar: "var(--bad)" },
      cancelled: { key: "cancelled", label: "Cancelled", cls: "bad", bar: "var(--bad)" },
    })[j.status] || { key: j.status, label: j.status, cls: "", bar: "var(--muted)" };
  }
  function jobCost(j) { const c = j.cost || {}; return "$" + ((c.gemini || 0) * 0.001 + (c.stitch || 0) * 0.01).toFixed(2); }
  function jobStepLabel(j) {
    const st = j.steps || [];
    const running = st.find((s) => s.status === "running");
    if (running) return running.label;
    const err = st.find((s) => s.status === "error");
    if (err) return err.label;
    const done = st.filter((s) => s.status === "done");
    return done.length ? done[done.length - 1].label : (st[0] || {}).label || "";
  }
  const isActiveJob = (j) => j.status === "running" || j.status === "queued";

  // Runs belonging to one NocoDB website. Edit jobs carry payload.siteId; build
  // jobs don't, so a site's history is its edit runs. /api/jobs is newest-first.
  const siteJobs = (siteId, jobs) => (jobs || []).filter((j) => j.payload && j.payload.siteId === siteId);
  function siteStatus(site, jobs) {
    const mine = siteJobs(site.siteId, jobs);
    if (mine.some((j) => j.awaitingApproval && !j.approved)) return { key: "attention", label: "Needs approval", cls: "warn", dot: "var(--warn)" };
    if (mine.some(isActiveJob)) return { key: "building", label: "Building", cls: "accent", dot: "var(--accent)" };
    if (!site.githubRepo || !site.liveUrl) return { key: "attention", label: "Needs setup", cls: "warn", dot: "var(--warn)" };
    if (mine.length && mine[0].status === "error") return { key: "attention", label: "Last run failed", cls: "bad", dot: "var(--bad)" };
    return { key: "live", label: "Live", cls: "good", dot: "var(--good)" };
  }

  window.G99 = {
    esc, avatarColor, initials, host, thumbBg, croColor, croInk, deltaInk, relTime, toast,
    ensureAuth, getJSON, postJSON, IC, svg, confirm: confirmAction,
    jobProgress, jobState, jobCost, jobStepLabel, isActiveJob, siteJobs, siteStatus,
  };

  // ------------------------------------------------------------ shell chrome
  if (document.body.dataset.shell === "none") { injectPalette(); return; }

  const path = location.pathname;
  const NAV = [
    { href: "/", label: "Overview", icon: "home", exact: true },
    { href: "/sites", label: "Sites", icon: "sites" },
    { href: "/dashboard", label: "Build a site", icon: "plus" },
    { href: "/jobs", label: "Activity", icon: "activity" },
  ];
  // /site?id=… is a child of Sites; /job?id=… is a child of Activity.
  const CHILD = { "/site": "/sites", "/job": "/jobs" };
  const active = CHILD[path] || (NAV.find((n) => (n.exact ? path === n.href || path === "/index.html" : path.startsWith(n.href))) || {}).href;

  const css = `
    :root { --g99rail: 252px; --g99head: 60px; }
    body { padding-left: var(--g99rail); padding-top: var(--g99head); }

    /* The shell is injected into legacy pages too, and those re-declare a
       lighter --muted/--ink-3 in their own stylesheet. Pin the chrome's text
       colours so it stays above 4.5:1 wherever it lands. */
    .g99rail, .g99head, .g99pal, .g99scrim { --muted: #6e6e75; --ink-3: #5c5c65; --ink-2: #52525b; }

    .g99rail {
      position: fixed; left: 0; top: 0; bottom: 0; width: var(--g99rail);
      background: var(--surface-2); border-right: 1px solid var(--line);
      padding: 16px 14px; display: flex; flex-direction: column; gap: 3px;
      z-index: 60; font-family: var(--sans);
    }
    .g99rail .brand { display: flex; align-items: center; gap: 10px; padding: 8px 8px 18px; }
    .g99rail .brand .lg {
      width: 28px; height: 28px; border-radius: 8px; flex: none;
      background: var(--ink-btn); color: var(--ink-btn-ink);
      display: grid; place-items: center; font-weight: 800; font-size: 14px;
    }
    .g99rail .brand b { display: block; font-weight: 800; font-size: 15px; color: var(--ink); letter-spacing: -.02em; }
    .g99rail .brand i { display: block; font-style: normal; font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: .02em; }
    .g99rail a {
      display: flex; align-items: center; gap: 11px; padding: 9px 11px;
      border-radius: 10px; text-decoration: none; color: var(--ink-2);
      font-size: 13.5px; font-weight: 600; transition: background .14s, color .14s;
    }
    .g99rail a:hover { background: var(--line-2); color: var(--ink); }
    .g99rail a.on { background: var(--accent-soft); color: var(--accent); }
    .g99rail .sp { flex: 1; }
    .g99rail .me {
      display: flex; align-items: center; gap: 10px; padding: 9px 8px;
      border-top: 1px solid var(--line); margin-top: 6px;
    }
    .g99rail .me .av {
      width: 28px; height: 28px; border-radius: 8px; flex: none; color: #fff;
      background: linear-gradient(135deg, #5b4df0, #c64c6c);
      display: grid; place-items: center; font-weight: 700; font-size: 12px;
    }
    .g99rail .me b { display: block; font-size: 12.5px; font-weight: 700; color: var(--ink); }
    .g99rail .me i { display: block; font-style: normal; font-size: 10.5px; color: var(--muted); font-weight: 600; }

    .g99head {
      position: fixed; top: 0; left: var(--g99rail); right: 0; height: var(--g99head);
      display: flex; align-items: center; gap: 14px; padding: 0 34px; z-index: 55;
      background: color-mix(in srgb, var(--bg) 80%, transparent);
      backdrop-filter: blur(12px); border-bottom: 1px solid var(--line);
    }
    .g99head .ttl { font-weight: 700; font-size: 15px; letter-spacing: -.01em; color: var(--ink); }
    .g99head .searchbtn {
      margin-left: auto; display: flex; align-items: center; gap: 9px; width: 300px;
      background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
      padding: 8px 11px; color: var(--muted); font: inherit; font-size: 13px;
      cursor: pointer; box-shadow: var(--shadow-sm); transition: border-color .14s;
    }
    .g99head .searchbtn:hover { border-color: var(--ink-3); }
    .g99head .searchbtn span { flex: 1; text-align: left; }
    .g99head kbd {
      font-family: var(--mono); font-size: 10.5px; font-weight: 600;
      background: var(--line-2); border: 1px solid var(--line);
      border-radius: 6px; padding: 2px 6px; color: var(--ink-3);
    }
    /* hamburger — only exists below the drawer breakpoint */
    .g99head .menu { display: none; }
    .g99railscrim { display: none; }

    .g99pal {
      position: fixed; inset: 0; z-index: 300; background: rgba(18, 18, 26, .32);
      backdrop-filter: blur(3px); justify-content: center; align-items: flex-start;
      padding-top: 12vh; display: none;
    }
    .g99pal.open { display: flex; }
    .g99pal .box {
      width: min(560px, 92vw); background: var(--surface); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: var(--shadow-lg); overflow: hidden;
      animation: g99pop .18s ease both;
    }
    .g99pal .top { display: flex; align-items: center; gap: 11px; padding: 15px 18px; border-bottom: 1px solid var(--line); }
    .g99pal .top input { flex: 1; border: none; outline: none; background: none; font: inherit; font-size: 15px; color: var(--ink); padding: 0; box-shadow: none; }
    .g99pal .top input:focus { box-shadow: none; }
    .g99pal .list { padding: 8px; max-height: 52vh; overflow: auto; }
    .g99pal .grp { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 8px 10px 4px; }
    .g99pal .it { display: flex; align-items: center; gap: 12px; padding: 10px 11px; border-radius: 10px; cursor: pointer; }
    .g99pal .it:hover, .g99pal .it.cur { background: var(--line-2); }
    .g99pal .it .ic { width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
    .g99pal .it .lb { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .g99pal .it .hint { font-size: 11px; color: var(--muted); font-weight: 600; }

    /* Below 900px the rail becomes an off-canvas drawer behind a hamburger,
       so navigation costs 60px of chrome instead of ~170px. */
    @media (max-width: 900px) {
      :root { --g99rail: 0px; }
      body { padding-left: 0; }
      .g99rail {
        width: 264px; transform: translateX(-100%);
        transition: transform .2s ease; box-shadow: var(--shadow-lg);
      }
      .g99rail.open { transform: none; }
      .g99railscrim {
        display: block; position: fixed; inset: 0; z-index: 59;
        background: rgba(18, 18, 26, .32); opacity: 0; pointer-events: none;
        transition: opacity .2s ease;
      }
      .g99railscrim.open { opacity: 1; pointer-events: auto; }
      .g99head { left: 0; padding: 0 14px; gap: 10px; }
      .g99head .menu {
        display: grid; place-items: center; width: 38px; height: 38px; flex: none;
        border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
        border-radius: 10px; cursor: pointer; padding: 0;
      }
      .g99head .searchbtn { width: auto; padding: 8px 10px; }
      .g99head .searchbtn span, .g99head kbd { display: none; }
      .g99head .newsite span { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .g99rail, .g99railscrim { transition: none; }
    }
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // Primary navigation is a real <nav> landmark, with the current page marked
  // via aria-current rather than colour alone.
  const rail = document.createElement("nav");
  rail.className = "g99rail";
  rail.setAttribute("aria-label", "Primary");
  rail.innerHTML = `
    <div class="brand"><span class="lg" aria-hidden="true">g</span><div><b>Growth99</b><i>Studio</i></div></div>
    ${NAV.map((n) => `<a href="${n.href}" class="${active === n.href ? "on" : ""}"${active === n.href ? ' aria-current="page"' : ""}>${svg(n.icon, 17)}${n.label}</a>`).join("")}
    <div class="sp"></div>
    <div class="me"><span class="av" aria-hidden="true">G</span><div><b>Growth99 team</b><i>Internal Beta</i></div></div>`;

  // Page title: <body data-title="…"> wins, else the part of <title> after "· ".
  const title = document.body.dataset.title || (document.title.split("·").pop() || "Studio").trim();
  const head = document.createElement("header");
  head.className = "g99head";
  // "New site" is the header's primary action — pointless on the page it opens.
  const onBuild = path === "/dashboard" || path === "/dashboard.html";
  head.innerHTML = `
    <button class="menu" id="g99menu" aria-label="Open navigation" aria-expanded="false" aria-controls="g99rail">${svg("menu", 18)}</button>
    <div class="ttl">${esc(title)}</div>
    <button class="searchbtn" id="g99search" aria-label="Search sites and actions">${svg("search", 15)}<span>Search sites, actions…</span><kbd>⌘K</kbd></button>
    ${onBuild ? "" : `<a class="btn primary newsite" href="/dashboard">${svg("plus", 15, 2.2)}<span>New site</span></a>`}`;

  const skip = document.createElement("a");
  skip.className = "g99skip";
  skip.textContent = "Skip to main content";

  const railScrim = document.createElement("div");
  railScrim.className = "g99railscrim";

  // Point the skip link at the page's main region. Pages keep whatever id their
  // own script already queries (site/job render into #wrap), so adopt it rather
  // than renaming and breaking them.
  const wrap = document.querySelector("main, .wrap, .shell");
  if (wrap) {
    if (!wrap.id) wrap.id = "g99main";
    if (wrap.tagName !== "MAIN") wrap.setAttribute("role", "main");
    if (!wrap.hasAttribute("tabindex")) wrap.setAttribute("tabindex", "-1");
    skip.href = "#" + wrap.id;
  } else {
    skip.style.display = "none";
  }

  document.body.insertBefore(railScrim, document.body.firstChild);
  document.body.insertBefore(head, document.body.firstChild);
  document.body.insertBefore(rail, document.body.firstChild);
  document.body.insertBefore(skip, document.body.firstChild);
  head.querySelector("#g99search").onclick = () => openPalette();

  // ---- mobile drawer ----
  rail.id = "g99rail";
  const menuBtn = head.querySelector("#g99menu");
  const setDrawer = (open) => {
    rail.classList.toggle("open", open);
    railScrim.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    if (open) rail.querySelector("a").focus();
  };
  menuBtn.onclick = () => setDrawer(!rail.classList.contains("open"));
  railScrim.onclick = () => setDrawer(false);
  rail.addEventListener("click", (e) => { if (e.target.closest("a")) setDrawer(false); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && rail.classList.contains("open")) { setDrawer(false); menuBtn.focus(); }
  });

  injectPalette();

  // ---------------------------------------------------------- ⌘K palette
  function injectPalette() {
    const ACTIONS = [
      { label: "Build a new site", hint: "Create", icon: "plus", go: "/dashboard" },
      { label: "Edit a live site", hint: "Change", icon: "edit", go: "/edit" },
      { label: "View all sites", hint: "Go to", icon: "sites", go: "/sites" },
      { label: "Open activity log", hint: "Go to", icon: "activity", go: "/jobs" },
      { label: "Overview dashboard", hint: "Go to", icon: "home", go: "/" },
      // The original 6-step build wizard. Kept out of the rail to match the
      // design, but it must be reachable from somewhere.
      { label: "Step-by-step build wizard", hint: "Advanced", icon: "build", go: "/wizard" },
    ];
    let sites = [];      // lazily loaded on first open
    let items = [];      // current filtered rows
    let cur = 0;

    const pal = document.createElement("div");
    pal.className = "g99pal";
    pal.innerHTML = `
      <div class="box" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="top">${svg("search", 17)}<input id="g99palq" placeholder="Type a command or search…"
          role="combobox" aria-expanded="true" aria-controls="g99pallist" aria-autocomplete="list" autocomplete="off"><button class="btn sm" id="g99palx" aria-label="Close" style="padding:5px 7px">${svg("close", 15, 2.2)}</button></div>
        <div class="list" id="g99pallist" role="listbox" aria-label="Results"></div>
      </div>`;
    document.body.appendChild(pal);
    const q = pal.querySelector("#g99palq");
    const list = pal.querySelector("#g99pallist");

    function rows() {
      const term = q.value.toLowerCase().trim();
      const acts = ACTIONS.filter((a) => !term || a.label.toLowerCase().includes(term))
        .map((a) => ({ grp: "Actions", label: a.label, hint: a.hint, icon: a.icon, go: a.go }));
      const hits = (term ? sites.filter((s) => (s.businessName + " " + (s.liveUrl || "") + " " + (s.githubRepo || "")).toLowerCase().includes(term)) : sites.slice(0, 5))
        .slice(0, 6)
        .map((s) => ({ grp: "Sites", label: s.businessName, hint: host(s.liveUrl) || "no domain", icon: "sites", go: "/site?id=" + encodeURIComponent(s.siteId) }));
      return acts.concat(hits);
    }
    function paint() {
      items = rows();
      if (cur >= items.length) cur = Math.max(0, items.length - 1);
      let html = "", grp = null;
      items.forEach((it, i) => {
        if (it.grp !== grp) { grp = it.grp; html += `<div class="grp" role="presentation">${esc(grp)}</div>`; }
        html += `<div class="it${i === cur ? " cur" : ""}" id="g99opt${i}" role="option" aria-selected="${i === cur}" data-i="${i}"><span class="ic" aria-hidden="true">${svg(it.icon, 15)}</span><span class="lb">${esc(it.label)}</span><span class="hint">${esc(it.hint)}</span></div>`;
      });
      list.innerHTML = html || `<div class="empty">No matches.</div>`;
      // The input keeps focus; the active option is announced via activedescendant.
      if (items.length) q.setAttribute("aria-activedescendant", "g99opt" + cur);
      else q.removeAttribute("aria-activedescendant");
      list.querySelectorAll(".it").forEach((el) => { el.onclick = () => run(items[+el.dataset.i]); });
    }
    function run(it) { if (it) { close(); location.href = it.go; } }
    function close() { pal.classList.remove("open"); }
    function open() {
      pal.classList.add("open"); q.value = ""; cur = 0; paint(); q.focus();
      if (!sites.length) {
        getJSON("/api/sites").then((d) => { sites = d.sites || []; if (pal.classList.contains("open")) paint(); }).catch(() => {});
      }
    }
    window.G99.openPalette = open;
    pal.onclick = (e) => { if (e.target === pal) close(); };
    pal.querySelector("#g99palx").onclick = close;
    q.oninput = () => { cur = 0; paint(); };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(items.length - 1, cur + 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); run(items[cur]); }
    };
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") { e.preventDefault(); pal.classList.contains("open") ? close() : open(); }
      else if (e.key === "Escape" && pal.classList.contains("open")) close();
    });
  }
  function openPalette() { window.G99.openPalette(); }
})();
