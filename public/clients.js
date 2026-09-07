// Growth99 Website Studio — the client pool. Every onboarding that ever reached this
// tool, with how far its beta site got and how many pages are built vs pending.
// Backed by NocoDB, so unlike /jobs it survives a redeploy.
"use strict";

const { esc, relTime, getJSON, ensureAuth, svg } = window.G99;
const $ = (id) => document.getElementById(id);

const STATUS = {
  done: ["good", "Live"],
  running: ["accent", "Building"],
  queued: ["", "Queued"],
  error: ["bad", "Failed"],
  cancelled: ["", "Cancelled"],
  interrupted: ["warn", "Interrupted"],
};

function summary(t, storedIn, poolError) {
  // Four figures, not six: "pages built" and "pages pending" repeated what the
  // Pages column already shows per row, so they were noise at the top.
  return `
    <div class="sum">
      <div><b>${t.clients}</b><span>Clients onboarded</span></div>
      <div class="good"><b>${t.done}</b><span>Sites live</span></div>
      <div class="accent"><b>${t.running}</b><span>Building now</span></div>
      <div class="bad"><b>${t.failed}</b><span>Failed</span></div>
    </div>
    <div class="store${poolError ? " degraded" : ""}">
      <span class="dot"></span>
      ${poolError
        ? `Pool store unreachable \u2014 showing only what is still in memory (${esc(poolError)}). History will be incomplete until it recovers.`
        : `Stored in <b>${esc(storedIn)}</b> \u2014 this list survives redeploys.`}
    </div>`;
}

function pages(r) {
  if (r.pagesPlanned == null) {
    return `<span class="pgnone">not scanned</span>`;
  }
  const pct = r.pagesPlanned ? Math.round(((r.pagesBuilt || 0) / r.pagesPlanned) * 100) : 0;
  return `<div class="pgbar"><i style="width:${pct}%"></i></div>
    <div class="pgtxt">${r.pagesBuilt || 0} / ${r.pagesPlanned} built${r.pagesPending ? ` \u00b7 ${r.pagesPending} left` : ""}</div>`;
}

const host = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Everything about a client that a typed query could reasonably mean. */
function haystack(r) {
  return [r.client, r.draftId, r.betaSite, r.repo, r.status, (STATUS[r.status] || [])[1]]
    .filter(Boolean).join(" ").toLowerCase();
}

/**
 * Rows matching the query.
 *
 * Every whitespace-separated word must match somewhere, so "nuvo failed"
 * narrows instead of widening — that is what people expect from a search box,
 * and over a list this size it costs nothing.
 */
function filterRows(rows, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => { const h = haystack(r); return words.every((w) => h.includes(w)); });
}

function row(r) {
  const [cls, label] = STATUS[r.status] || ["", r.status || "unknown"];
  const coverage = r.betaSite ? `/coverage?url=${encodeURIComponent(r.betaSite)}` : "/coverage";
  // The row itself opens this client's generation history. The beta site URL is
  // the history key, so a client with no beta site yet has no history to open
  // and its row stays inert rather than landing on an empty screen.
  const hist = r.betaSite ? `/history?client=${encodeURIComponent(r.betaSite)}` : "";
  // Beta site and repo share one column now. They were spending 651px of 1267px
  // between them while the client name wrapped over four lines in 114px.
  const site = r.betaSite
    ? `<a class="trunc" href="${esc(r.betaSite)}" target="_blank" rel="noopener" title="${esc(r.betaSite)}">${esc(host(r.betaSite))}</a>`
    : `<span class="trunc" style="color:var(--muted)">no beta site yet</span>`;
  const repo = r.repo
    ? `<small class="trunc"><a href="https://github.com/${esc(r.repo)}" target="_blank" rel="noopener" title="${esc(r.repo)}">${esc(r.repo)}</a></small>`
    : "";
  return `<tr${hist ? ` class="rowlink" data-href="${esc(hist)}" tabindex="0" role="link" aria-label="Generation history for ${esc(r.client || "this client")}"` : ""}>
    <td class="client">
      <b class="trunc" title="${esc(r.client || "Client")}">${esc(r.client || "Client")}</b>
      <small class="trunc">${esc(r.draftId)}${r.builds > 1 ? ` \u00b7 ${r.builds} runs` : ""}</small></td>
    <td class="site">${site}${repo}</td>
    <td><span class="pill ${cls}">${esc(label)}</span>
      ${r.live && ["running", "queued"].includes(r.status)
        ? `<span class="live"><span class="pulse"></span><span class="trunc">${esc(r.step || "")}</span></span>` : ""}</td>
    <td>${pages(r)}</td>
    <td class="when">${r.receivedAt ? esc(relTime(r.receivedAt)) : "\u2014"}</td>
    <td><div class="acts">
      <a href="${esc(coverage)}">Pages</a>
      ${hist ? `<a href="${esc(hist)}">History</a>` : ""}
      <a class="primary" href="/job?id=${encodeURIComponent(r.draftId)}">Open</a>
    </div></td>
  </tr>`;
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

// The query lives here rather than in the DOM: the list reloads every ten
// seconds, and a re-render must not drop what someone is halfway through typing.
let query = "";
let data = null;

function table(rows, total) {
  if (!rows.length) {
    return `<div class="card-t"><p class="empty">${total
      ? `No client matches <b>${esc(query)}</b>.<br>Searches cover the name, draft id, beta site, repo and status.`
      : "No clients yet. When an onboarding form is submitted, its row appears here and stays."}</p></div>`;
  }
  return `<div class="card-t">
    <header>
      <h2>Client pool</h2>
      <span class="count">${rows.length === total ? `${total} client${total === 1 ? "" : "s"}` : `${rows.length} of ${total}`}</span>
    </header>
    <div class="tablewrap"><table>
      <colgroup><col class="c-client"><col class="c-site"><col class="c-status"><col class="c-pages"><col class="c-when"><col class="c-acts"></colgroup>
      <thead><tr>
        <th>Client</th><th>Beta site &amp; repo</th><th>Status</th>
        <th>Pages</th><th>Arrived</th><th></th>
      </tr></thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table></div></div>`;
}

/** Re-render only the table — leaves the search box, and its caret, alone. */
function paint() {
  const rows = filterRows(data.rows, query);
  $("rows").innerHTML = table(rows, data.rows.length);
}

function render(d) {
  data = d;
  $("wrap").innerHTML = `
    <div class="head">
      <div>
        <h1>Clients</h1>
        <p>Every onboarding that reached the builder \u2014 which beta site it produced, and how far it got.</p>
      </div>
      <div class="search${query ? " has" : ""}" id="search">
        ${SEARCH_ICON}
        <input id="q" type="search" placeholder="Search clients, sites, repos\u2026" autocomplete="off"
          spellcheck="false" aria-label="Search clients" value="${esc(query)}">
        <button class="clear" id="clearq" type="button" aria-label="Clear search">\u00d7</button>
      </div>
    </div>
    ${summary(d.totals, d.storedIn, d.poolError)}
    <div id="rows"></div>
    <p class="foot">Click a row to see everything that client has generated.
      \u201cPages\u201d counts the page plan built from the client's existing site \u2014 rows marked
      <b>not scanned</b> were built before page planning existed.</p>`;
  paint();

  const q = $("q");
  q.addEventListener("input", () => {
    query = q.value.trim();
    $("search").classList.toggle("has", !!q.value);
    paint();
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; q.dispatchEvent(new Event("input")); } });
  $("clearq").addEventListener("click", () => { q.value = ""; q.dispatchEvent(new Event("input")); q.focus(); });
}

// "/" focuses the search from anywhere on the page, the way every list UI does.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const q = $("q");
  if (q) { e.preventDefault(); q.focus(); q.select(); }
});

async function load() {
  try {
    const d = await getJSON("/api/pool");
    // First load builds the page; the ten-second refresh only repaints the
    // table, so the search box keeps its value, its focus and its caret.
    if ($("q")) { data = d; paint(); } else { render(d); }
  } catch (e) {
    if (!$("q")) $("wrap").innerHTML = `<p class="empty">Could not read the client pool: ${esc(e.message)}</p>`;
  }
}

// A clickable row, delegated once so the 10-second refresh never has to rebind.
// Delegation also keeps the row's own links working: a click that started on an
// <a> is the link's, not the row's.
document.addEventListener("click", (e) => {
  if (e.target.closest("a, button")) return;
  const tr = e.target.closest("tr.rowlink");
  if (!tr) return;
  const href = tr.getAttribute("data-href");
  if (href) location.href = href;
});
// Keyboard reaches it too — the row announces itself as a link, so it has to behave like one.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tr = e.target.closest && e.target.closest("tr.rowlink");
  if (!tr) return;
  e.preventDefault();
  const href = tr.getAttribute("data-href");
  if (href) location.href = href;
});

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
  setInterval(load, 10000);
});
