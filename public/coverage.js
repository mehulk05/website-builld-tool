// Growth99 Website Studio — page coverage AND the build control surface.
// The table is driven by the PAGE PLAN (one row per page we would build), not by the raw
// URL list: several of their URLs collapse onto one of our pages, so the plan is the only
// grouping where one checkbox means one unit of work.
"use strict";

const { esc, relTime, getJSON, postJSON, ensureAuth, svg, toast } = window.G99;
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const DEMO = !params.get("siteId") && !params.get("url") && params.get("demo") !== "0";
const SITE = params.get("url") || "";
const SITE_ID = params.get("siteId") || "";

// Sections start collapsed except the ones that need action — the point of the page is
// "what's left to build", so open those first.
const OPEN = new Set(["Core pages", "Treatment / service pages"]);
const SELECTED = new Set();     // plan keys (slug, or "home" for the front page)
let DATA = null;

const STATUS = {
  built: ["good", "Built"],
  pending: ["warn", "To build"],
  queued: ["accent", "Queued"],
  building: ["accent", "Building"],
  failed: ["bad", "Failed"],
  skipped: ["", "Skipped"],
};
const ENGINE_LABEL = { stitch: "Stitch", "stitch-then-clone": "Stitch → clone", clone: "Clone" };

const keyOf = (r) => r.slug || "home";
const selectable = (r) => r.status !== "built";

function tiles(d) {
  const t = d.totals;
  const p = d.planTotals || {};
  const pct = p.total ? Math.round((p.built / p.total) * 100) : 0;
  return `
    <div class="tiles">
      <div class="tile"><b>${t.existing}</b><span>Pages on their site</span></div>
      <div class="tile"><b>${p.total || 0}</b><span>Pages to build</span></div>
      <div class="tile built"><b>${p.built || 0}</b><span>Built</span></div>
      <div class="tile pending"><b>${p.pending || 0}</b><span>Still to build</span></div>
      <div class="tile new"><b>${d.batchSize || 6}</b><span>Pages per batch</span></div>
      <div class="tile"><b>${t.notPlanned}</b><span>Out of scope</span></div>
    </div>
    <div class="card pad">
      <div class="bar-wrap">
        <div class="cbar"><i class="b" style="width:${pct}%"></i><i class="p" style="width:${100 - pct}%"></i></div>
        <span class="pctlabel">${pct}% built <span style="color:var(--muted);font-weight:600">(${p.built || 0} of ${p.total || 0} planned pages)</span></span>
      </div>
      <p class="foot" style="margin:10px 0 0">
        Read from <b>${esc(d.discoveredVia)}</b>${d.sitemaps ? ` (${d.sitemaps} sitemaps)` : ""} ·
        ${esc(d.site)} · built set: <b>${esc(d.builtSource)}</b> ·
        ${t.existing} URLs → <b>${p.total || 0}</b> pages (their duplicates consolidated) ·
        checked ${esc(relTime(d.checkedAt))}
      </p>
    </div>`;
}

function planRow(r) {
  const k = keyOf(r);
  const [cls, label] = STATUS[r.status] || ["", r.status];
  const src = r.sourcePaths || [];
  const can = selectable(r);
  return `<tr class="${SELECTED.has(k) ? "sel" : ""}" data-key="${esc(k)}">
    <td class="cbcell">
      ${can
        ? `<input type="checkbox" class="rowcb" data-key="${esc(k)}"${SELECTED.has(k) ? " checked" : ""}>`
        : `<span class="lockicon" title="Already built — use Rebuild to regenerate">${svg("check", 13)}</span>`}
    </td>
    <td class="title">${esc(r.title || k)}
      <div class="slug">/${esc(r.slug)}${r.sourceTitle && r.sourceTitle !== r.title ? ` · theirs: ${esc(r.sourceTitle)}` : ""}</div></td>
    <td class="pathcell">${src.length ? esc(src[0]) : "—"}
      ${src.length > 1 ? `<span class="more" title="${esc(src.slice(1).join(" · "))}">+${src.length - 1} more</span>` : ""}</td>
    <td class="nowrap"><span class="echip">${esc(ENGINE_LABEL[r.engine] || r.engine)}</span></td>
    <td class="nowrap"><span class="pill ${cls}">${esc(label)}</span></td>
    <td class="nowrap ract">${can
      ? `<button class="mini" data-one="${esc(k)}">Build</button>`
      : `<button class="mini ghost" data-rebuild="${esc(k)}">Rebuild</button>`}</td>
  </tr>`;
}

function sectionCard(sec, i) {
  const rows = sec.rows;
  const pend = rows.filter(selectable);
  const allSel = pend.length > 0 && pend.every((r) => SELECTED.has(keyOf(r)));
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const pills = Object.entries(counts).map(([k, n]) => {
    const [cls, label] = STATUS[k] || ["", k];
    return `<span class="pill ${cls}">${n} ${esc(label)}</span>`;
  }).join("");
  return `<section class="sec${OPEN.has(sec.label) ? " open" : ""}" data-i="${i}">
    <div class="sec-h">
      <label class="seccb" title="Select every page still to build in this section">
        <input type="checkbox" class="allcb" data-sec="${esc(sec.label)}"${allSel ? " checked" : ""}${pend.length ? "" : " disabled"}>
      </label>
      <div class="sec-t" data-toggle="${i}">
        <h2>${esc(sec.label)}</h2>
        <span class="count">${rows.length} page${rows.length === 1 ? "" : "s"}</span>
      </div>
      <span class="right">${pills}${svg("chevron", 15)}</span>
    </div>
    <div class="sec-body"><div class="tablewrap"><table>
      <thead><tr><th class="cbcell"></th><th>Page</th><th>Their URL</th><th>Engine</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(planRow).join("")}</tbody>
    </table></div></div>
  </section>`;
}

// Group the flat plan by section, in the planner's own priority order, so revenue pages
// sit above the long tail.
function planSections(plan) {
  const map = new Map();
  for (const r of plan || []) {
    const label = r.sectionLabel || r.section;
    if (!map.has(label)) map.set(label, { label, priority: r.priority, rows: [] });
    map.get(label).rows.push(r);
  }
  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

function actionBar() {
  const n = SELECTED.size;
  return `<div class="actionbar${n ? " on" : ""}" id="abar">
    <span class="acount">${n} page${n === 1 ? "" : "s"} selected</span>
    <button class="btn ghost" id="selPending">Select all pending</button>
    <button class="btn ghost" id="clearSel"${n ? "" : " disabled"}>Clear</button>
    <button class="btn primary" id="buildBtn"${n ? "" : " disabled"}>Build pages</button>
  </div>`;
}

function render() {
  const d = DATA;
  const secs = planSections(d.plan);
  $("wrap").innerHTML = `
    <div class="page-h">
      <div>
        <h1>Page coverage</h1>
        <p>Every page ${esc(d.site.replace(/^https?:\/\//, ""))} publishes today, grouped into the pages we would build. Tick the ones you want, then Build.</p>
      </div>
    </div>
    ${/simulated/.test(d.builtSource) ? `<div class="banner-demo">${svg("warn", 16)}
      Demo view — the “built” column is a <b>simulated</b> beta site. No generation jobs were run.
    </div>` : ""}
    ${tiles(d)}
    ${secs.map(sectionCard).join("")}
    <p class="foot">
      One row = one page we would build; several of their URLs can feed a single row (eight Botox URLs → one <code>/botox/</code>).
      “Out of scope” covers blog posts, store/product pages, video items, legal and careers — content migration rather than site build.
      Built rows are locked so a live page can't be overwritten by accident; Rebuild is deliberate.
    </p>
    ${actionBar()}`;
  wire();
}

function refreshBar() {
  const bar = $("abar");
  if (!bar) return;
  const n = SELECTED.size;
  bar.classList.toggle("on", !!n);
  bar.querySelector(".acount").textContent = `${n} page${n === 1 ? "" : "s"} selected`;
  $("buildBtn").disabled = !n;
  $("clearSel").disabled = !n;
  // Keep each section's master checkbox honest about its own rows.
  const secs = planSections(DATA.plan);
  document.querySelectorAll(".allcb").forEach((cb) => {
    const sec = secs.find((s) => s.label === cb.dataset.sec);
    const pend = sec ? sec.rows.filter(selectable) : [];
    cb.checked = pend.length > 0 && pend.every((r) => SELECTED.has(keyOf(r)));
  });
  document.querySelectorAll("tr[data-key]").forEach((tr) => {
    tr.classList.toggle("sel", SELECTED.has(tr.dataset.key));
  });
}

function wire() {
  document.querySelectorAll("[data-toggle]").forEach((h) => {
    h.onclick = () => {
      const sec = h.closest(".sec");
      sec.classList.toggle("open");
      const label = sec.querySelector("h2").textContent;
      if (sec.classList.contains("open")) OPEN.add(label); else OPEN.delete(label);
    };
  });
  document.querySelectorAll(".rowcb").forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) SELECTED.add(cb.dataset.key); else SELECTED.delete(cb.dataset.key);
      refreshBar();
    };
  });
  document.querySelectorAll(".allcb").forEach((cb) => {
    cb.onchange = () => {
      const sec = planSections(DATA.plan).find((s) => s.label === cb.dataset.sec);
      for (const r of (sec ? sec.rows : []).filter(selectable)) {
        if (cb.checked) SELECTED.add(keyOf(r)); else SELECTED.delete(keyOf(r));
      }
      document.querySelectorAll(".rowcb").forEach((c) => { c.checked = SELECTED.has(c.dataset.key); });
      refreshBar();
    };
  });
  document.querySelectorAll("[data-one]").forEach((b) => { b.onclick = () => quote([b.dataset.one]); });
  document.querySelectorAll("[data-rebuild]").forEach((b) => { b.onclick = () => quote([b.dataset.rebuild], true); });
  $("selPending").onclick = () => {
    for (const r of (DATA.plan || []).filter(selectable)) SELECTED.add(keyOf(r));
    document.querySelectorAll(".rowcb").forEach((c) => { c.checked = true; });
    refreshBar();
  };
  $("clearSel").onclick = () => {
    SELECTED.clear();
    document.querySelectorAll(".rowcb").forEach((c) => { c.checked = false; });
    refreshBar();
  };
  $("buildBtn").onclick = () => quote([...SELECTED]);
}

// ---- quote → confirm ---------------------------------------------------------
// Nothing is generated until the spend has been shown. A selection bigger than one batch is
// never rejected: it is split into chained batches, and the dialog says so.
async function quote(slugs, rebuild) {
  try {
    const q = await postJSON("/api/build-pages", { site: DATA.site, slugs, rebuild: !!rebuild });
    showQuote(q, slugs, rebuild);
  } catch (e) {
    toast(e.message || "could not price that selection", true);
  }
}

function showQuote(q, slugs, rebuild) {
  const e = q.estimate;
  const big = e.pages > 20;
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal">
    <h3>${rebuild ? "Rebuild" : "Build"} ${e.pages} page${e.pages === 1 ? "" : "s"}?</h3>
    <div class="qgrid">
      <div><b>${e.stitch}</b><span>Stitch runs</span></div>
      <div><b>${e.clones}</b><span>AI clones</span></div>
      <div><b>${e.batches}</b><span>batch${e.batches === 1 ? "" : "es"}</span></div>
      <div><b>~${e.minutes}m</b><span>estimated</span></div>
      <div><b>~$${e.usd.toFixed(2)}</b><span>estimated spend</span></div>
    </div>
    ${e.batches > 1 ? `<p class="qnote">${svg("spark", 14)} Too many for one job — this runs as
      <b>${e.batches} chained batches</b> of up to ${q.batchSize}, each opening its own PR. You click once.</p>` : ""}
    ${big ? `<p class="qnote bad">${svg("warn", 14)} Large selection — check the Stitch count above.
      A Stitch run costs ~10× and takes ~4× a clone.</p>` : ""}
    ${q.alreadyBuilt && q.alreadyBuilt.length ? `<p class="qnote">${q.alreadyBuilt.length} already-built page(s) skipped.</p>` : ""}
    <div class="qlist">${q.pages.map((p) => `<span class="qp">/${esc(p.slug === "home" ? "" : p.slug)}</span>`).join("")}</div>
    <div class="mact">
      <button class="btn ghost" id="qCancel">Cancel</button>
      <button class="btn primary" id="qGo">${rebuild ? "Rebuild" : "Build"} ${e.pages} page${e.pages === 1 ? "" : "s"}</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.onclick = (ev) => { if (ev.target === wrap) close(); };
  wrap.querySelector("#qCancel").onclick = close;
  wrap.querySelector("#qGo").onclick = async () => {
    const go = wrap.querySelector("#qGo");
    go.disabled = true;
    go.textContent = "Starting…";
    try {
      await postJSON("/api/build-pages", { site: DATA.site, slugs, rebuild: !!rebuild, confirm: true });
      close();
      toast("Build started");
      load();
    } catch (err) {
      go.disabled = false;
      go.textContent = "Build";
      toast(err.message || "could not start the build", true);
    }
  };
}

async function load() {
  try {
    const q = SITE_ID ? "?siteId=" + encodeURIComponent(SITE_ID)
      : DEMO ? "?demo=1" : "?url=" + encodeURIComponent(SITE);
    DATA = await getJSON("/api/site-inventory" + q);
    if (DATA.error) throw new Error(DATA.error);
    render();
  } catch (e) {
    $("wrap").innerHTML = `<p class="empty">Could not read the site: ${esc(e.message)}</p>`;
  }
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
});
