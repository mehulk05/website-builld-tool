// Growth99 — Edit a live site. Pick a site, describe a change, ship it as a PR.
"use strict";

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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3600); }

// stable pleasant avatar color from the slug
function avatarColor(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 52% 48%)`; }
const initials = (name) => (name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const ICONS = {
  check: `<svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
  ext: `<svg style="width:13px;height:13px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`,
  page: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  text: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  color: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485"/></svg>`,
  section: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h14a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4z"/></svg>`,
  footer: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M3 6h18M3 14h18M3 18h18"/></svg>`,
  mobile: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18h.01M8 21h8a1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v16a1 1 0 001 1z"/></svg>`,
};
// CI status glyphs for the PR history (check / x / clock / dash)
const CI_ICON = {
  passing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
  failing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  none: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/></svg>`,
};

const PRESETS = [
  ["Add a page", ICONS.page, "Add a new __ page. Give it a clear title, on-brand copy with a few sections, and link it in the main navigation."],
  ["Change hero headline", ICONS.text, "Change the homepage hero headline to \"__\" and adjust the sub-headline to match."],
  ["Update colors", ICONS.color, "Update the brand colors to __ (primary) and __ (accent) across the whole theme, keeping contrast accessible."],
  ["Add a section", ICONS.section, "Add a new __ section to the home page (e.g. testimonials / FAQ / financing), styled like the existing sections."],
  ["Edit contact / footer", ICONS.footer, "Update the footer / contact details: __."],
  ["Fix mobile layout", ICONS.mobile, "Improve the mobile layout of the __ — fix spacing, overflow, and tap targets."],
];

let SEL = null;

function renderSites(sites) {
  if (!sites.length) { $("sites").innerHTML = '<p class="empty">No sites found yet. Build one first, or click Refresh.</p>'; return; }
  $("sites").innerHTML = sites.map((s) =>
    `<button class="site" data-id="${esc(s.siteId)}">
       <span class="ava" style="background:${avatarColor(s.themeSlug)}">${esc(initials(s.businessName))}</span>
       <span class="site-main">
         <span class="site-nm">${esc(s.businessName)}${s.active ? '<span class="live"><span class="dot"></span>LIVE</span>' : ""}</span>
         <span class="site-slug">${esc(s.themeSlug)}</span>
         <span class="site-last">${esc((s.lastChange || "—").slice(0, 46))}</span>
       </span>
       <span class="check">${ICONS.check}</span>
     </button>`).join("");
  [...document.querySelectorAll(".site")].forEach((el) => el.onclick = () => {
    document.querySelectorAll(".site").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    SEL = sites.find((s) => s.siteId === el.dataset.id);
    $("editCard").classList.remove("dim");
    $("historyCard").classList.remove("dim");
    if ($("approvalToggle")) $("approvalToggle").checked = !!SEL.requireApproval;
    loadHistory(SEL.siteId);
  });
}

document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "approvalToggle" && SEL) {
    fetch("/api/site-approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: SEL.siteId, requireApproval: e.target.checked }) })
      .then((r) => r.json()).then((d) => { if (!d.error) { SEL.requireApproval = d.requireApproval; toast(d.requireApproval ? "Approval required before merge" : "Auto-merge on green build"); } })
      .catch(() => toast("Could not update approval setting"));
  }
});

async function loadHistory(siteId) {
  $("history").innerHTML = '<p class="empty"><span class="spin"></span>Loading history…</p>';
  try {
    const d = await (await fetch("/api/site-history?siteId=" + encodeURIComponent(siteId))).json();
    const h = d.history || [];
    if (!h.length) { $("history").innerHTML = '<p class="empty">No pull requests found for this site yet.</p>'; return; }
    $("history").innerHTML = h.map((p) => {
      const day = (p.date || "").slice(0, 10);
      const st = (p.state || "").toLowerCase();
      const label = st === "merged" ? "Merged" : st === "closed" ? "Closed" : "Open";
      const cls = st === "merged" ? "merged" : st === "closed" ? "closed" : "open";
      const b = p.build || "none";
      const bLabel = { passing: "CI passed", failing: "CI failed", pending: "CI running", none: "no CI" }[b];
      return `<a class="hrow" href="${esc(p.url)}" target="_blank">
        <span class="htype ${p.type}">${esc(p.type)}</span>
        <span class="hnum">#${p.number}</span>
        <span class="htitle">${esc(p.title)}</span>
        <span class="hbuild ${b}">${CI_ICON[b]}${bLabel}</span>
        <span class="hstate ${cls}">${label}</span>
        <span class="hdate">${esc(day)}</span>
        <span class="hext">${ICONS.ext}</span>
      </a>`;
    }).join("");
  } catch (e) { $("history").innerHTML = '<p class="empty">Could not load history: ' + esc(e.message) + "</p>"; }
}

async function loadSites(refresh) {
  $("sites").innerHTML = '<p class="empty"><span class="spin"></span>Loading sites…</p>';
  try {
    const d = await (await fetch("/api/sites" + (refresh ? "?refresh=1" : ""))).json();
    renderSites(d.sites || []);
  } catch (e) { $("sites").innerHTML = '<p class="empty">Could not load: ' + esc(e.message) + "</p>"; }
}

function renderPresets() {
  $("presets").innerHTML = PRESETS.map((p, i) => `<button class="preset" data-i="${i}">${p[1]}${esc(p[0])}</button>`).join("");
  [...document.querySelectorAll(".preset")].forEach((el) => el.onclick = () => { $("prompt").value = PRESETS[el.dataset.i][2]; $("prompt").focus(); });
}

async function suggest() {
  if (!SEL) { toast("Pick a site first"); return; }
  const idea = $("prompt").value.trim();
  if (!idea) { toast("Type a rough idea first"); return; }
  $("suggestBtn").disabled = true; $("suggestHint").innerHTML = '<span class="spin"></span>Improving…';
  try {
    const d = await (await fetch("/api/edit-suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: SEL.siteId, idea }) })).json();
    if (d.prompt) { $("prompt").value = d.prompt; $("suggestHint").textContent = "Refined ✓"; }
    else throw new Error(d.error || "no suggestion");
  } catch (e) { $("suggestHint").textContent = ""; toast("Suggest failed: " + e.message); }
  finally { $("suggestBtn").disabled = false; }
}

const APPLY_LABEL = $("applyBtn").innerHTML;
async function apply() {
  if (!SEL) { toast("Pick a site first"); return; }
  const prompt = $("prompt").value.trim();
  if (!prompt) { toast("Describe the change first"); return; }
  const mode = SEL.requireApproval ? "open a PR and wait for your approval to merge" : "open a PR and auto-merge once the build passes";
  if (!confirm(`Apply this change to "${SEL.businessName}"?\n\nIt will ${mode}.`)) return;
  $("applyBtn").disabled = true; $("applyBtn").innerHTML = '<span class="spin"></span>Starting…';
  try {
    const r = await fetch("/api/edit-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: SEL.siteId, prompt }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "failed");
    toast("Edit job started — opening the jobs monitor…");
    setTimeout(() => location.href = "/jobs", 900);
  } catch (e) { toast("Error: " + e.message); $("applyBtn").disabled = false; $("applyBtn").innerHTML = APPLY_LABEL; }
}

$("refresh").onclick = (e) => { e.preventDefault(); loadSites(true); };
$("suggestBtn").onclick = suggest;
$("applyBtn").onclick = apply;

ensureAuth().then((ok) => {
  if (!ok) { toast("Unauthorized — reload and enter the admin password."); return; }
  renderPresets();
  loadSites(true);
});
