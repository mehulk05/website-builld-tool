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

function tiles(t, storedIn, poolError) {
  return `
    <div class="tiles">
      <div class="tile"><b>${t.clients}</b><span>Clients onboarded</span></div>
      <div class="tile good"><b>${t.done}</b><span>Sites live</span></div>
      <div class="tile accent"><b>${t.running}</b><span>Building now</span></div>
      <div class="tile bad"><b>${t.failed}</b><span>Failed</span></div>
      <div class="tile good"><b>${t.pagesBuilt}</b><span>Pages built</span></div>
      <div class="tile warn"><b>${t.pagesPending}</b><span>Pages pending</span></div>
    </div>
    <div class="store${poolError ? " degraded" : ""}">
      <span class="dot"></span>
      ${poolError
        ? `Pool store unreachable — showing only what's still in memory (${esc(poolError)}). History will be incomplete until it recovers.`
        : `Stored in <b>${esc(storedIn)}</b> — this list survives redeploys.`}
    </div>`;
}

function pages(r) {
  if (r.pagesPlanned == null) {
    return `<span class="pgnone">not scanned</span>`;
  }
  const pct = r.pagesPlanned ? Math.round(((r.pagesBuilt || 0) / r.pagesPlanned) * 100) : 0;
  return `<div class="pgbar"><i style="width:${pct}%"></i></div>
    <div class="pgtxt">${r.pagesBuilt || 0} / ${r.pagesPlanned} built${r.pagesPending ? ` · ${r.pagesPending} left` : ""}</div>`;
}

function row(r) {
  const [cls, label] = STATUS[r.status] || ["", r.status || "unknown"];
  const host = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const coverage = r.betaSite ? `/coverage?url=${encodeURIComponent(r.betaSite)}` : "/coverage";
  return `<tr>
    <td class="client"><b>${esc(r.client || "Client")}</b>
      <small>draft ${esc(r.draftId)}${r.builds > 1 ? ` · ${r.builds} runs` : ""}</small></td>
    <td class="mono">${r.betaSite ? `<a href="${esc(r.betaSite)}" target="_blank" rel="noopener">${esc(host(r.betaSite))}</a>` : "—"}</td>
    <td class="mono">${r.repo ? `<a href="https://github.com/${esc(r.repo)}" target="_blank" rel="noopener">${esc(r.repo)}</a>` : "—"}</td>
    <td class="nowrap"><span class="pill ${cls}">${esc(label)}</span>
      ${r.live && ["running", "queued"].includes(r.status) ? `<span class="live"><span class="pulse"></span><small style="color:var(--muted)">${esc(r.step || "")}</small></span>` : ""}</td>
    <td>${pages(r)}</td>
    <td class="nowrap" style="color:var(--muted);font-size:11.5px">${r.receivedAt ? esc(relTime(r.receivedAt)) : "—"}</td>
    <td><div class="acts">
      <a href="${esc(coverage)}">Pages</a>
      ${r.prUrl ? `<a href="${esc(r.prUrl)}" target="_blank" rel="noopener">PR</a>` : ""}
      <a class="primary" href="/job?id=${encodeURIComponent(r.draftId)}">Open</a>
    </div></td>
  </tr>`;
}

function render(d) {
  $("wrap").innerHTML = `
    <div class="page-h">
      <div>
        <h1>Clients</h1>
        <p>Every onboarding that reached the builder — which beta site it produced, and how many pages are done.</p>
      </div>
    </div>
    ${tiles(d.totals, d.storedIn, d.poolError)}
    ${d.rows.length ? `<div class="card-t"><div class="tablewrap"><table>
      <thead><tr>
        <th>Client</th><th>Beta site</th><th>Repo</th><th>Status</th>
        <th>Pages</th><th>Arrived</th><th></th>
      </tr></thead>
      <tbody>${d.rows.map(row).join("")}</tbody>
    </table></div></div>` : `<div class="card-t"><p class="empty">No clients yet. When an onboarding form is submitted, its row appears here and stays.</p></div>`}
    <p class="foot">“Pages” counts the page plan built from the client's existing site. Rows marked <b>not scanned</b> were built before page planning existed — open Pages to scan them.</p>`;
}

async function load() {
  try {
    render(await getJSON("/api/pool"));
  } catch (e) {
    $("wrap").innerHTML = `<p class="empty">Could not read the client pool: ${esc(e.message)}</p>`;
  }
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  load();
  setInterval(load, 10000);
});
