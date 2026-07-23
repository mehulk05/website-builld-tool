// Growth99 — Edit a live site. Pick a site, describe a change, ship it as a PR.
"use strict";

// auth (same admin-key handling as the rest of the tool)
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

const PRESETS = [
  ["Add a page", "Add a new __ page. Give it a clear title, on-brand copy with a few sections, and link it in the main navigation."],
  ["Change hero headline", "Change the homepage hero headline to \"__\" and adjust the sub-headline to match."],
  ["Update colors", "Update the brand colors to __ (primary) and __ (accent) across the whole theme, keeping contrast accessible."],
  ["Add a section", "Add a new __ section to the home page (e.g. testimonials / FAQ / financing), styled like the existing sections."],
  ["Edit contact / footer", "Update the footer / contact details: __."],
  ["Fix mobile layout", "Improve the mobile layout of the __ — fix spacing, overflow, and tap targets."],
];

let SEL = null;

function renderSites(sites) {
  if (!sites.length) { $("sites").innerHTML = '<p class="hint">No sites found. Build one first, or click Refresh.</p>'; return; }
  $("sites").innerHTML = sites.map((s) =>
    `<div class="site" data-id="${esc(s.siteId)}">
       <div class="nm">${esc(s.businessName)}${s.active ? ' <span style="font-size:10px;font-weight:700;color:#fff;background:var(--good);border-radius:999px;padding:1px 8px;vertical-align:middle">● LIVE</span>' : ""}</div>
       <div class="meta">${esc(s.themeSlug)}</div>
       <div class="meta">last: ${esc((s.lastChange || "—").slice(0, 48))}</div>
     </div>`).join("");
  [...document.querySelectorAll(".site")].forEach((el) => el.onclick = () => {
    document.querySelectorAll(".site").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    SEL = sites.find((s) => s.siteId === el.dataset.id);
    $("editCard").classList.remove("disabledCard");
    $("historyCard").classList.remove("disabledCard");
    if ($("approvalToggle")) $("approvalToggle").checked = !!SEL.requireApproval;
    loadHistory(SEL.siteId);
  });
}

// Per-site "require approval before merge" toggle → persisted in the registry.
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "approvalToggle" && SEL) {
    fetch("/api/site-approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: SEL.siteId, requireApproval: e.target.checked }) })
      .then((r) => r.json()).then((d) => { if (!d.error) { SEL.requireApproval = d.requireApproval; toast(d.requireApproval ? "Approval required before merge" : "Auto-merge on green"); } })
      .catch(() => toast("Could not update approval setting"));
  }
});

const TYPE_COLOR = { build: "var(--muted)", edit: "var(--accent)" };
async function loadHistory(siteId) {
  $("history").innerHTML = '<p class="hint"><span class="spin"></span>Loading history…</p>';
  try {
    const d = await (await fetch("/api/site-history?siteId=" + encodeURIComponent(siteId))).json();
    const h = d.history || [];
    if (!h.length) { $("history").innerHTML = '<p class="hint">No PRs found for this site.</p>'; return; }
    $("history").innerHTML = h.map((p) => {
      const when = (p.date || "").replace("T", " ").slice(0, 16);
      const badge = p.state === "MERGED" ? "merged" : p.state.toLowerCase();
      const col = p.state === "MERGED" ? "var(--good)" : "var(--muted)";
      return `<div style="display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:${TYPE_COLOR[p.type]};width:44px">${esc(p.type)}</span>
        <a href="${esc(p.url)}" target="_blank" style="flex:1;font-size:13.5px;text-decoration:none">#${p.number} ${esc(p.title)}</a>
        <span style="font-size:11px;color:${col}">${esc(badge)}</span>
        <span style="font-size:11px;color:var(--muted)">${esc(when)}</span>
      </div>`;
    }).join("");
  } catch (e) { $("history").innerHTML = '<p class="hint">Could not load history: ' + esc(e.message) + "</p>"; }
}

async function loadSites(refresh) {
  $("sites").innerHTML = '<p class="hint"><span class="spin"></span>Loading sites…</p>';
  try {
    const d = await (await fetch("/api/sites" + (refresh ? "?refresh=1" : ""))).json();
    renderSites(d.sites || []);
  } catch (e) { $("sites").innerHTML = '<p class="hint">Could not load: ' + esc(e.message) + "</p>"; }
}

function renderPresets() {
  $("presets").innerHTML = PRESETS.map((p, i) => `<button class="preset" data-i="${i}">${esc(p[0])}</button>`).join("");
  [...document.querySelectorAll(".preset")].forEach((el) => el.onclick = () => { $("prompt").value = PRESETS[el.dataset.i][1]; $("prompt").focus(); });
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

async function apply() {
  if (!SEL) { toast("Pick a site first"); return; }
  const prompt = $("prompt").value.trim();
  if (!prompt) { toast("Describe the change first"); return; }
  if (!confirm(`Apply this change to "${SEL.businessName}"?\n\nIt will open a PR, and auto-merge once the build passes.`)) return;
  $("applyBtn").disabled = true; $("applyBtn").textContent = "Starting…";
  try {
    const r = await fetch("/api/edit-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: SEL.siteId, prompt }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "failed");
    toast("Edit job started — opening the jobs monitor…");
    setTimeout(() => location.href = "/jobs", 900);
  } catch (e) { toast("Error: " + e.message); $("applyBtn").disabled = false; $("applyBtn").textContent = "Apply change →"; }
}

$("refresh").onclick = (e) => { e.preventDefault(); loadSites(true); };
$("suggestBtn").onclick = suggest;
$("applyBtn").onclick = apply;

ensureAuth().then((ok) => {
  if (!ok) { toast("Unauthorized — reload and enter the admin password."); return; }
  renderPresets();
  loadSites(true);   // refresh from repo on open
});
