// Growth99 Website Studio — run detail (build + edit). Plain-language progress
// up top, engineer detail behind a disclosure, real actions against the runner.
"use strict";

const { esc, avatarColor, initials, croColor, relTime, toast, getJSON, postJSON, emitHops,
        stepEmissions,
        ensureAuth, svg, jobState, jobCost } = window.G99;

const $ = (id) => document.getElementById(id);
const ID = new URLSearchParams(location.search).get("id");

let JOB = null, TECH_OPEN = false, diffLoaded = false, timer;
let GENPROG = { phase: "idle", pages: {} };   // live per-page Stitch progress
// Which disclosures the user opened. The page re-renders on every poll (3s), which
// would otherwise wipe <details open> — that's why a brief collapsed while reading.
const OPEN = new Set();

const verdict = (d) => d == null ? "" : d >= 15 ? "Significant improvement" : d >= 5 ? "Improved" : d >= 0 ? "Stable" : "Regressed";

// ---- per-step detail ---------------------------------------------------------
// The brand system chosen in "Compose build prompt": swatches + fonts + the full
// generated brief behind a disclosure.
function brandBlock(j) {
  const c = j.composed;
  if (!c) return "";
  const sw = (hex, label) => hex ? `<span class="sw"><i style="background:${esc(hex)}"></i><b>${esc(label)}</b><code>${esc(hex)}</code></span>` : "";
  const fonts = [c.headingFont, c.bodyFont].filter(Boolean).join(" + ");
  return `<div class="sub-detail">
    <div class="swatches">${sw(c.primary, "Primary")}${sw(c.secondary, "Secondary")}${sw(c.accent, "Accent")}</div>
    ${fonts ? `<div class="kv">Typography · ${esc(fonts)}</div>` : ""}
    ${c.brief ? `<details class="brief">
      <summary>View the full build prompt (${c.brief.length} chars)</summary>
      <div class="briefwrap">
        <button class="copybtn" data-copy="brief" title="Copy the prompt">${svg("copy", 13)} Copy</button>
        <div class="brieftext" id="brieftext">${esc(c.brief)}</div>
      </div>
    </details>` : ""}
  </div>`;
}
// Per-page generation status. While the step is running we use the live global
// progress (queued → generating → post-processing → done); once finished we use
// the job's own snapshot so the breakdown survives a reload.
const PAGE_ORDER = [["home", "Home"], ["services", "Services"], ["about", "About"], ["contact", "Contact"]];
const PG_TXT = { queued: "queued", generating: "generating…", "post-processing": "optimising images / SEO…", done: "", error: "" };
function pageRows(j, live) {
  const src = live && GENPROG && GENPROG.pages && Object.keys(GENPROG.pages).length ? GENPROG.pages : (j.pages || {});
  const keys = Object.keys(src);
  if (!keys.length) return "";
  const order = PAGE_ORDER.filter(([k]) => keys.includes(k)).concat(keys.filter((k) => !PAGE_ORDER.some(([p]) => p === k)).map((k) => [k, k]));
  return `<div class="sub-detail"><div class="pages">${order.map(([k, label]) => {
    const st = src[k] || {};
    const status = st.status || "queued";
    const right = status === "done" ? (st.bytes ? (st.bytes / 1024).toFixed(1) + " KB" : "done")
      : status === "error" ? (st.error || "failed") : (PG_TXT[status] || status);
    const dot = status === "done" ? "done" : status === "error" ? "error" : status === "queued" ? "queued" : "running";
    return `<div class="pg ${status}"><span class="dot ${dot}"></span><span class="pgn">${esc(label)}</span><span class="pgs">${esc(right)}</span></div>`;
  }).join("")}</div></div>`;
}
// What left the building at this step: the callback posted to product-service, and any ledger event
// that callback wrote for TED. Rendered on the step itself, because "kaunsa event kab nikla" is a
// question about a step and a list at the bottom of the page cannot answer it.
function stepEvents(j, i, s) {
  const rows = stepEmissions(j, i, s.key, s.status);
  if (!rows.length) return "";
  return `<div class="sev">${rows.map((e) => `
    <div class="sev-row ${e.state} ${e.kind}">
      <span class="dot ${e.state === "ok" ? "done" : "error"}"></span>
      <span class="sev-n">${esc(e.label)}</span>
      ${e.type ? `<code class="sev-t">${esc(e.type)}</code>` : ""}
      ${e.task ? `<span class="sev-k" title="TED task closed by this event">${esc(e.task)}</span>` : ""}
      <span class="sev-d">${esc(e.detail)}</span>
      <span class="sev-w">${e.at ? esc(relTime(e.at)) : (e.state === "missing" ? "never" : "")}</span>
      ${e.error ? `<span class="sev-e">${esc(e.error)}</span>` : ""}
    </div>`).join("")}</div>`;
}

// "/" is a path, not a place. Everywhere else in this tool a page is called by
// its name, and a report that says a note was left on "/" makes the reader do a
// translation the page could have done for them.
function pageName(p) {
  const s = String(p || "/").replace(/^\/+|\/+$/g, "");
  if (!s) return "Home";
  const last = s.split("/").pop();
  return last.replace(/-/g, " ").replace(/ [a-z]/g, (c) => c.toUpperCase());
}

function stepper(j) {
// One row per note: what was asked, which part of which page it was left on,
// and what became of it.
//
// The outcome text is written by the engine, not summarised here — a refusal
// says what could not be done and often what to do instead, and shortening that
// would throw away the only part the reviewer can act on.
//
// The section is named, not numbered. "Testimonials" is a place on the page the
// reviewer recognises; an element id is not.
function noteRows(j) {
  const items = Array.isArray(j.feedbackItems) ? j.feedbackItems : [];
  if (!items.length) return "";
  return `<div class="fblist">${items.map((x) => `<div class="fbrow ${x.ok ? "is-ok" : "is-refused"}">`
    + `<span class="vk ${x.ok ? "yes" : "no"}">${x.ok ? svg("check", 11, 3.4) : svg("close", 11, 3.4)}</span>`
    + `<div class="fbcontent">`
    + `<div class="fbtitle">${esc(x.note || "(no wording)")}</div>`
    + (x.outcome ? `<div class="fbout">${esc(x.outcome)}</div>` : "")
    + `</div>`
    + `<div class="fbmeta">`
    + `<span class="fbtag">${esc(pageName(x.page))}${x.section ? " · " + esc(x.section) : ""}</span>`
    + `<span class="fbpill ${x.ok ? "good" : "bad"}">${x.ok ? "Applied" : "Refused"}</span>`
    + `</div></div>`).join("")}</div>`;
}

  const ic = { done: svg("check", 13, 3), running: `<span class="spin" style="margin:0;border-color:var(--accent);border-top-color:transparent"></span>`, error: svg("close", 13, 3), pending: "" };
  const isBuild = j.type === "build";
  return `<div class="steps">${(j.steps || []).map((s, i) => {
    let extra = "";
    if (isBuild && i === 1 && s.status !== "pending") extra = brandBlock(j);
    if (isBuild && i === 2 && s.status !== "pending") extra = pageRows(j, s.status === "running");
    // A feedback run's whole point is which notes landed and which did not, but
    // keeping it inside a collapsible disclosure keeps the stepper timeline clean.
    if (j.type === "feedback" && i === 1 && s.status !== "pending") {
      const items = Array.isArray(j.feedbackItems) ? j.feedbackItems : [];
      if (items.length) {
        const done = items.filter((x) => x.ok).length;
        const key = "fb-step-notes";
        extra = `<details class="brief notes-d" data-k="${key}"${OPEN.has(key) ? " open" : ""}><summary>View note breakdown (${done} of ${items.length} applied)</summary>${noteRows(j)}</details>`;
      }
    }
    extra += stepEvents(j, i, s);
    // A build most often stalls waiting on the mu-plugin to flip the live theme —
    // let that one step retry on its own (PR is already merged; no need to
    // re-run Stitch/CI to try again) instead of forcing a full "Run again".
    const canRetryStep = isBuild && s.key === "theme_activation_watch" && s.status === "error" && j.status === "error";
    return `
    <div class="jstep ${s.status}">
      <span class="ic">${ic[s.status] || ""}</span>
      <div class="jb">
        <span class="lb">${esc(s.label)}</span>
        ${s.detail ? `<span class="dt"${s.status === "error" ? ' style="color:var(--bad)"' : ""}>${esc(s.detail)}</span>` : ""}
        ${canRetryStep ? `<button class="btn sm" data-act="retry-step" data-step="theme_activation_watch" style="margin-top:8px">${svg("refresh", 14)}Retry this step</button>` : ""}
        ${extra}
      </div>
    </div>`;
  }).join("")}</div>`;
}


// What the tool understood the request to mean, before it went looking for
// files. Shown next to the request itself so a misread is obvious at a glance —
// and so the parts it deliberately did not action are stated rather than
// silently missing from the result.
function workOrder(j) {
  const w = j.workOrder;
  if (!w || !w.changes || !w.changes.length) return "";
  // Once the run has checked its own work, each item carries a verdict from the
  // diff. Before that — and if the check could not run — they stay unmarked
  // rather than showing a tick nothing has earned.
  const v = (j.verification && j.verification.results) || [];
  const mark = (i) => {
    const r = v.find((x) => x.n === i + 1);
    if (!r || r.done == null) return `<span class="vk none" title="Not checked"></span>`;
    return r.done
      ? `<span class="vk yes" title="Confirmed in the diff${r.how ? " · " + r.how : ""}">${svg("check", 11, 3.4)}</span>`
      : `<span class="vk no" title="No change in the diff does this">${svg("close", 11, 3.4)}</span>`;
  };
  // A swap reads as old → new. Showing one blob of text made it impossible to
  // tell what was being replaced from what it was becoming.
  const text = (c) => {
    if (c.replaces && c.literal) return `<span class="lit"><s>${esc(c.replaces)}</s> → ${esc(c.literal)}</span>`;
    if (c.literal) return `<span class="lit">${esc(c.literal)}</span>`;
    if (c.replaces) return `<span class="lit">remove: <s>${esc(c.replaces)}</s></span>`;
    return "";
  };
  const items = w.changes.map((c, i) => `<li>${mark(i)}${esc(c.what)}${c.where ? ` <span class="whr">· ${esc(c.where)}</span>` : ""}${text(c)}</li>`).join("");
  const note = (label, list) => (list && list.length ? `<div class="wo-note"><b>${label}</b> ${esc(list.join("; "))}</div>` : "");
  const chk = j.verification;
  return (chk ? `<div class="wo-hd">${chk.done} of ${chk.total} confirmed in the changes${chk.missed ? ` · ${chk.missed} not done` : ""}${j.retried ? " · retried once" : ""}</div>` : "")
    + `<ul class="wo">${items}</ul>`
    + note("Left alone as asked:", w.constraints)
    + note("Not actioned — too vague to do without guessing:", w.unclear);
}

function scoresCard(j) {
  if (!j.before && !j.after) return "";
  const before = j.before ? j.before.overall : null;
  const after = j.after ? j.after.overall : null;
  return `<div class="card scores">
    <div class="n"><b style="font-size:30px;color:var(--muted)">${before == null ? "—" : before}</b><i>Before</i></div>
    ${svg("arrow", 20)}
    <div class="n"><b style="font-size:44px;color:${croColor(after)}">${after == null ? "—" : after}</b><i>Now</i></div>
    <div style="margin-left:auto;text-align:right">
      ${j.delta == null ? "" : `<span class="pill ${j.delta >= 0 ? "good" : "bad"}" style="font-size:15px;padding:4px 12px">${j.delta >= 0 ? "+" : ""}${j.delta}</span>`}
      <div style="font-size:12px;color:var(--ink-3);font-weight:600;margin-top:6px">CRO score${j.delta == null ? "" : " · " + verdict(j.delta)}</div>
    </div>
  </div>`;
}

function techCard(j) {
  const c = j.cost || {};
  return `<div class="card pad">
    <button class="disc-btn" id="techBtn" aria-expanded="${TECH_OPEN}" aria-controls="tech">
      ${svg("code", 16)}<span class="t">Technical details</span><span class="h">for engineers</span>
    </button>
    <div class="tech${TECH_OPEN ? " open" : ""}" id="tech">
      <div class="grid">
        <div><span class="k">Repository</span><div class="v">${esc(jobRepo(j) || "—")}</div></div>
        <div><span class="k">Theme</span><div class="v">${esc((j.payload && j.payload.themeSlug) || "—")}</div></div>
        <div><span class="k">Branch</span><div class="v">${esc(j.branch || "—")}</div></div>
        <div><span class="k">Usage</span><div class="v">${c.gemini || 0} Gemini · ${c.stitch || 0} Stitch · ${esc(jobCost(j))}</div></div>
      </div>
      ${j.prUrl ? `<a href="${esc(j.prUrl)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;margin-top:14px;font-size:12.5px;font-weight:700">Open pull request on GitHub${svg("ext", 13)}</a>` : ""}
      ${j.prUrl ? `<pre class="diff" id="diffBox" style="margin-top:14px"><span class="spin"></span>loading diff…</pre>` : ""}
    </div>
  </div>`;
}

function actions(j) {
  const b = [];
  if (j.awaitingApproval && !j.approved) b.push(`<button class="btn primary" data-act="approve">${svg("check", 15, 2.2)}Approve &amp; ship</button>`);
  if (j.status === "running" || j.status === "queued") b.push(`<button class="btn danger" data-act="cancel">Cancel</button>`);
  // A snapshot taken the moment pages were generated/assembled (or service pages were added) —
  // survives the NEXT build overwriting generated/site/, so nothing gets silently lost between runs.
  if (j.zipUrl) b.push(`<a class="btn" href="${esc(j.zipUrl)}">${svg("download", 15)}Download ZIP</a>`);
  if (["done", "error", "cancelled"].includes(j.status)) b.push(`<button class="btn" data-act="retry">${svg("refresh", 15)}Run again</button>`);
  b.push(`<div style="position:relative">
    <button class="dots-btn" id="dotsBtn" title="More options">&#8942;</button>
    <div class="job-menu" id="jobMenu">
      <button data-act="edit-job">&#9998; Edit job data</button>
      <button data-act="stitch-key">&#128273; Change Stitch key &amp; re-run</button>
    </div>
  </div>`);
  return b.join("");
}

const TYPE_LABEL = { edit: "Edit", enrich: "Enrich", restore: "Restore", build: "Build", seo: "SEO", "pre-release": "Pre-release", "wireframe-audit": "Wireframe QA" };

// ---- SEO run detail ----------------------------------------------------------
// What the run decided, page by page, plus the two things it deliberately did
// not change on its own: URLs it renamed (with the redirect behind them) and
// content it judged off-topic.
function seoCards(j) {
  if (j.type !== "seo") return "";
  const out = [];

  // A dry run's whole output is on disk, so the paths are the result.
  if (j.payload && j.payload.dryRun) {
    out.push(`<div class="card pad"><div class="card-h"><h2>Dry run</h2><span class="right" style="font-size:12px;color:var(--muted)">nothing reached GitHub</span></div>
      <div class="wo-note" style="margin-top:4px">Every step ran and the result was written to disk — no branch, no pull request.</div>
      ${j.previewDir ? `<div class="seorow"><div class="seohd"><span class="seokw">Preview folder</span></div><div class="seot"><code>${esc(j.previewDir)}</code></div></div>` : ""}
      ${j.reportPath ? `<div class="seorow"><div class="seohd"><span class="seokw">Report</span></div><div class="seot"><code>${esc(j.reportPath)}</code></div></div>` : ""}
    </div>`);
  }
  const chk = j.seoCheck;
  const rowFor = (slug) => (chk && chk.rows.find((r) => r.slug === slug)) || null;

  if (j.seoPages && j.seoPages.length) {
    out.push(`<div class="card pad">
      <div class="card-h"><h2>Every page</h2>${chk ? `<span class="right" style="font-size:12px;color:var(--muted)">${chk.pass} of ${chk.total} checks pass</span>` : ""}</div>
      <div class="seolist">${j.seoPages.map((p) => {
        const r = rowFor(p.slug);
        const fails = r ? r.checks.filter((c) => !c.ok) : [];
        return `<div class="seorow">
          <div class="seohd">
            <span class="seoslug">/${esc(p.slug === "home" ? "" : p.slug + "/")}</span>
            ${r ? `<span class="pill ${fails.length ? "warn" : "good"}">${r.pass}/${r.total}</span>` : ""}
            <span class="seokw">${esc(p.primaryKeyword || "")}</span>
          </div>
          <div class="seot">${esc(p.metaTitle)} <i>${p.metaTitle.length}</i></div>
          <div class="seod">${esc(p.metaDescription)} <i>${p.metaDescription.length}</i></div>
          ${fails.length ? `<div class="seofail">${fails.map((c) => `${esc(c.k)} — ${esc(c.got)}`).join(" · ")}</div>` : ""}
        </div>`;
      }).join("")}</div>
    </div>`);
  }

  if (j.seoRenames && j.seoRenames.length) {
    out.push(`<div class="card pad"><div class="card-h"><h2>URLs renamed</h2><span class="right" style="font-size:12px;color:var(--muted)">301 redirects shipped alongside</span></div>
      <div class="seolist">${j.seoRenames.map((r) => `<div class="seorow"><div class="seohd"><span class="seoslug"><s>/${esc(r.from)}/</s> → /${esc(r.to)}/</span></div><div class="seod">${esc(r.why)}</div></div>`).join("")}</div></div>`);
  }

  const links = (j.seoLinks && j.seoLinks.added) || [];
  const broken = (j.seoLinks && j.seoLinks.broken) || [];
  if (links.length || broken.length) {
    out.push(`<div class="card pad"><div class="card-h"><h2>Internal links</h2></div>
      ${links.length ? `<div class="seolist">${links.map((p) => `<div class="seorow"><div class="seohd"><span class="seoslug">/${esc(p.slug)}/</span></div><div class="seod">${p.links.map((l) => `“${esc(l.anchor)}” → <code>${esc(l.to)}</code>`).join(" · ")}</div></div>`).join("")}</div>` : ""}
      ${broken.length ? `<div class="wo-note"><b>Broken links found:</b> ${broken.map((p) => `/${esc(p.slug)}/ → ${p.broken.map((b) => esc(b.href)).join(", ")}`).join(" · ")}</div>` : ""}
    </div>`);
  }

  if (j.contentAudit && j.contentAudit.length) {
    const sorted = [...j.contentAudit].sort((a, b) => (a.onTopicPercent ?? 101) - (b.onTopicPercent ?? 101));
    out.push(`<div class="card pad">
      <div class="card-h"><h2>Content audit</h2><span class="right" style="font-size:12px;color:var(--muted)">reported, not rewritten</span></div>
      <div class="seolist">${sorted.map((a) => {
        const pct = a.onTopicPercent;
        const tone = pct == null ? "" : pct >= 75 ? "good" : pct >= 60 ? "warn" : "bad";
        return `<div class="seorow">
          <div class="seohd">
            <span class="seoslug">/${esc(a.slug === "home" ? "" : a.slug + "/")}</span>
            <span class="pill ${tone}">${pct == null ? "—" : pct + "% on topic"}</span>
            <span class="seokw">${a.words} words</span>
          </div>
          <div class="seod">${esc(a.verdict)}</div>
          ${a.missing.length ? `<ul class="seomiss">${a.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
        </div>`;
      }).join("")}</div>
    </div>`);
  }
  return out.join("\n");
}


// ---- Pre-release mobile evidence --------------------------------------------
function mobileCards(j) {
  if (j.type !== "pre-release") return "";
  const before = j.mobileBefore || [];
  const after = j.mobileAfter || [];
  if (!before.length && !after.length) return "";
  const afterBySlug = new Map(after.map((p) => [p.slug, p]));
  const summary = j.mobileSummary;
  const issueText = (p) => {
    if (!p) return "";
    if (p.error) return `<div class="moberr">${esc(p.error)}</div>`;
    const issues = p.issues || [];
    return issues.length
      ? `<ul class="mobissues">${issues.map((x) => `<li><b>${esc(x.severity || "issue")}</b> ${esc(x.description || x.kind)}${x.evidence ? `<span>${esc(x.evidence)}</span>` : ""}</li>`).join("")}</ul>`
      : `<span class="pill good">Pass</span>`;
  };
  const shot = (p, label) => p && p.screenshot
    ? `<a class="mobshot" href="${esc(p.screenshot)}" target="_blank" rel="noopener"><span>${label}</span><img src="${esc(p.screenshot)}" alt="${esc(label + " mobile screenshot for " + p.title)}" loading="lazy"></a>`
    : "";
  const rows = before.length ? before : after;
  return `<div class="card pad">
    <div class="card-h"><h2>Mobile responsiveness</h2>
      ${summary ? `<span class="right pill ${summary.pass ? "good" : "bad"}">${summary.pass ? "Passed" : "Needs review"} · ${summary.pages} pages</span>` : ""}
    </div>
    ${summary ? `<div class="mobsummary"><b>${summary.beforeIssues}</b> issue(s) before · <b>${summary.afterIssues}</b> after · <b>${summary.changedFiles}</b> file(s) changed</div>` : ""}
    <div class="moblist">${rows.map((p) => {
      const a = afterBySlug.get(p.slug);
      return `<section class="mobrow">
        <div class="mobhd"><a href="${esc(p.url)}" target="_blank" rel="noopener">/${esc(p.slug === "home" ? "" : p.slug + "/")}</a><span>${esc(p.title || p.file)}</span></div>
        <div class="mobgrid">${shot(p, "Before")}${shot(a, a && a.phase === "before" ? "Release proof" : "After")}</div>
        ${a && a !== p ? issueText(a) : issueText(p)}
      </section>`;
    }).join("")}</div>
  </div>`;
}
// Build jobs carry the target on the job record (from the HubSpot deal); edit and
// enrich jobs carry it on the payload. Read both so the value is never blank.
const jobRepo = (j) => j.repo || (j.payload && (j.payload.githubRepo || j.payload.betaSiteRepo)) || null;
const jobBeta = (j) => j.liveUrl || (j.payload && (j.payload.liveUrl || j.payload.betaSiteUrl)) || null;

// Who this run is for, and where it builds to — the information the onboarding
// form brought in. Sits at the top so a run is identifiable at a glance.
function clientCard(j) {
  const repo = jobRepo(j), beta = jobBeta(j);
  const ex = j.payload && j.payload.existingWebsite;
  const ref = j.payload && j.payload.referenceWebsite;
  const when = j.receivedAt || j.createdAt;
  const row = (k, v, href) => v
    ? `<div class="kv"><span class="k">${esc(k)}</span>${href
        ? `<a class="v" href="${esc(href)}" target="_blank" rel="noopener">${esc(v)}</a>`
        : `<span class="v">${esc(v)}</span>`}</div>`
    : "";
  const body = [
    row("Client", j.businessName),
    row("Beta site", beta, beta),
    row("Repository", repo, repo ? "https://github.com/" + repo : null),
    row("Existing site", ex, ex),
    row("Reference site", ref, ref),
    row("Form received", when ? new Date(when).toLocaleString() + " · " + relTime(when) : null),
    row("Draft", j.draftId),
  ].filter(Boolean).join("");
  if (!body) return "";
  return `<div class="card pad">
    <div class="card-h"><h2>Client &amp; build target</h2>${j.source ? `<span class="right pill">${esc(j.source)}</span>` : ""}</div>
    ${body}
  </div>`;
}

// Green all-done banner with the clickable live URL (+ deep links once the
// enrichment shipped service pages and the brand guide).
function successBanner(j) {
  const base = String(j.liveUrl).replace(/\/+$/, "");
  const enriched = j.type === "enrich" || (j.steps || []).some((s) => /^Service pages/.test(s.label) && s.status === "done");
  const links = [
    `<a href="${esc(base)}/" target="_blank" rel="noopener">${esc(base.replace(/^https?:\/\//, ""))}</a>`,
    enriched ? `<a href="${esc(base)}/services/" target="_blank" rel="noopener">Treatments</a>` : "",
    enriched ? `<a href="${esc(base)}/brand-guide/" target="_blank" rel="noopener">Brand guide</a>` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="banner good">${svg("check", 18)}<div style="flex:1"><div class="bt">All done — the site is live</div><div class="bd">${links}</div></div></div>`;
}

// Enrich "What this adds" card: per-service rows with the grounding source and
// the AI-composed brief, plus where the design/content came from. Old runs
// without serviceDetail fall back to plain pills.
function enrichDetailCard(j) {
  const plan = j.enrichPlan || {};
  const P = j.payload || {};
  const detail = j.serviceDetail;
  const head = `<div class="card-h"><h2>What this adds</h2>${plan.truncated ? `<span class="right" style="font-size:12px;color:var(--muted)">capped at ${j.servicePages.length} of ${plan.total}</span>` : ""}</div>`;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  const srcLine = [
    P.existingWebsite ? `content grounded in <a href="${esc(P.existingWebsite)}" target="_blank" rel="noopener">${esc(hostOf(P.existingWebsite))}</a>` : "",
    plan.mimicked ? `design structure mimicked from <a href="${esc(plan.mimicked)}" target="_blank" rel="noopener">${esc(hostOf(plan.mimicked))}</a>` : (P.referenceWebsite ? `reference ${esc(hostOf(P.referenceWebsite))}` : ""),
    plan.engine ? `generated with ${esc(plan.engine === "stitch" ? "Stitch" : "Gemini")}` : "",
  ].filter(Boolean).join(" · ");
  // live per-service status: prefer GEN_PROGRESS while generating, else the snapshot
  const live = (j.steps || [])[2] && j.steps[2].status === "running" && GENPROG.pages && Object.keys(GENPROG.pages).length;
  const ST = { queued: ["queued", "queued"], generating: ["generating…", "running"], "post-processing": ["optimising…", "running"], done: ["generated", "done"], error: ["failed", "error"] };
  const body = detail && detail.length
    ? `<div class="svc-list">${detail.map((s) => {
        const st = (live && GENPROG.pages[s.slug] ? GENPROG.pages[s.slug].status : s.status) || (j.status === "done" ? "done" : "queued");
        const [txt, cls] = ST[st] || [st, "queued"];
        const key = "brief-" + s.slug;
        return `
        <div class="svc">
          <div class="svc-hd">
            <span class="dot ${cls}"></span>
            <span class="svc-nm">${esc(s.name)}</span>
            <code class="svc-slug">/${esc(s.slug)}/</code>
            <span class="svc-st ${cls}">${esc(txt)}${s.engine ? ` · ${esc(s.engine)}` : ""}</span>
            ${s.sourceUrl ? `<a class="svc-src" href="${esc(s.sourceUrl)}" target="_blank" rel="noopener" title="${esc(s.sourceUrl)}">from ${esc(hostOf(s.sourceUrl))}${svg("ext", 11)}</a>` : `<span class="svc-src none">no source page matched</span>`}
          </div>
          ${s.brief ? `<details class="brief" data-k="${esc(key)}"${OPEN.has(key) ? " open" : ""}><summary>View the AI-composed brief (${s.brief.length} chars)</summary><div class="brieftext">${esc(s.brief)}</div></details>` : ""}
        </div>`;
      }).join("")}
        <div class="svc"><div class="svc-hd"><span class="dot ${j.status === "done" ? "done" : "queued"}"></span><span class="svc-nm">Brand guide</span><code class="svc-slug">/brand-guide/</code><span class="svc-src none">from this build's brand system</span></div></div>
      </div>`
    : `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 4px">
        ${j.servicePages.map((s) => `<span class="pill" style="background:var(--accent-soft);color:var(--accent)">${esc(s.name)}</span>`).join("")}
        <span class="pill good">Brand guide</span>
      </div>`;
  return `<div class="card pad">${head}${body}
    <div class="meta" style="margin-top:12px">${j.servicePages.length} service page(s) under a Treatments dropdown, a services hub, and a public /brand-guide page${plan.refCount ? ` · reference site has ${plan.refCount} service pages` : ""}${srcLine ? `<br>${srcLine}` : ""}</div></div>`;
}

// Did this run's outcome actually leave the building? Two hops, each with its own dot,
// timestamp and — when it broke — the error verbatim, so "the site is live but the TED
// ticket is still open" can be diagnosed here instead of by reading Render logs that a
// redeploy has already thrown away.
function emissionCard(j) {
  // Enrich/edit runs report through the parent build's callback; say so and link there
  // rather than showing an empty audit that reads as "nothing was sent".
  if (j.type !== "build") {
    const pid = j.payload && j.payload.parentDraftId;
    if (!pid) return "";
    return `<div class="emit note">Status for this run is reported to Growth99 on
      <a href="/job?id=${encodeURIComponent(pid)}">the build run it belongs to</a>.</div>`;
  }
  const a = emitHops(j);
  if (!a) return "";
  const rows = a.hops.map((h) => {
    const bits = [
      h.at ? `<span class="et" title="${esc(h.at)}">${esc(relTime(h.at))}</span>` : "",
      h.httpStatus ? `<span class="ec">HTTP ${h.httpStatus}</span>` : "",
      h.attempts > 1 ? `<span class="ec">${h.attempts} attempts</span>` : "",
      h.events.length ? `<span class="ec" title="Ledger events written">${esc(h.events.join(", "))}</span>` : "",
    ].filter(Boolean).join("");
    return `<div class="erow ${h.state}">
      <span class="dot ${h.ui.cls}"></span>
      <div class="eb">
        <span class="en">${esc(h.name)}<span class="pill ${h.ui.pill} sm">${esc(h.ui.label)}</span></span>
        <span class="ew">${esc(h.why)}</span>
        ${bits ? `<span class="em">${bits}</span>` : ""}
        ${h.error ? `<span class="ee">${esc(h.error)}</span>` : ""}
      </div>
    </div>`;
  }).join("");
  // The tail matters when a build flaps: one 502 followed by a success is a different
  // story from four 502s, and only the per-attempt list tells them apart.
  const hist = a.history.length > 1
    ? `<details class="ehist"><summary>${a.history.length} callback attempt(s)</summary>
        <div class="ehl">${a.history.slice().reverse().map((x) => `<div class="ehr ${x.error ? "bad" : "ok"}">
          <span class="eht" title="${esc(x.at)}">${esc(relTime(x.at))}</span>
          <span class="ehs">${esc(x.status || "?")}${x.step != null ? " · step " + x.step : ""}</span>
          <span class="ehv">${x.error ? esc(x.error) : (x.events && x.events.length ? esc(x.events.join(", ")) : (x.httpStatus ? "HTTP " + x.httpStatus + " · no new event" : "sent"))}</span>
        </div>`).join("")}</div></details>`
    : "";
  // Only offered when something broke: a resend on a healthy job is a no-op that invites doubt
  // about whether the green ticks meant anything.
  const resend = a.failed
    ? `<button class="btn sm" data-act="resend" style="margin-top:10px">${svg("refresh", 14)}Resend event</button>`
    : "";
  return `<div class="emit${a.failed ? " has-error" : ""}">
    <div class="eh">Event delivery</div>${rows}${hist}${resend}</div>`;
}

function render() {
  const j = JOB;
  const st = jobState(j);
  const isEdit = j.type === "edit";
  const isEnrich = j.type === "enrich";
  const site = (j.payload && j.payload.siteId) || null;
  const c = j.cost || {};

  $("wrap").innerHTML = `
    <a class="back" href="${site ? "/site?id=" + encodeURIComponent(site) : "/jobs"}">${svg("back", 14, 2.2)}${site ? "Back to site" : "All activity"}</a>

    <div class="hero">
      <span class="ava lg" style="width:42px;height:42px;border-radius:11px;font-size:15px;background:${avatarColor(j.businessName)}">${esc(initials(j.businessName))}</span>
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h1>${esc(j.editSummary || (isEdit ? "Website edit" : isEnrich ? "Service pages + brand guide" : j.type === "seo" ? "SEO — " + j.businessName : j.type === "pre-release" ? "Pre-release — " + j.businessName : "Build " + j.businessName))}</h1>
          <span class="pill ${st.cls}">${esc(st.label)}</span>
        </div>
        <div class="meta">${TYPE_LABEL[j.type] || "Build"} · ${esc(j.businessName)} · started ${esc(relTime(j.startedAt || j.createdAt))} · ${c.gemini || 0} AI planning · ${c.stitch || 0} generation calls · ${esc(jobCost(j))} est.</div>
      </div>
      <div class="acts">${actions(j)}</div>
    </div>

    ${j.awaitingApproval && !j.approved ? `<div class="banner">${svg("warn", 18)}<div style="flex:1"><div class="bt">Paused for your approval${j.verification ? ` — ${j.verification.done} of ${j.verification.total} item(s) done` : ""}</div><div class="bd">${j.verification && j.verification.missed ? `${j.verification.missed} requested item(s) could not be found in the changes — listed above.` : "The change is written and the pull request is open — it merges only once you approve."}</div></div></div>` : ""}
    ${j.status === "error" ? `<div class="banner bad">${svg("warn", 18)}<div style="flex:1"><div class="bt">This run failed</div><div class="bd">${esc((j.error || "").slice(0, 240))}</div></div></div>` : ""}
    ${j.status === "done" && j.liveUrl ? successBanner(j) : ""}

    ${clientCard(j)}

    ${scoresCard(j)}

    ${isEnrich && j.servicePages ? enrichDetailCard(j) : ""}

    ${seoCards(j)}
    ${mobileCards(j)}

    ${isEdit && j.payload && j.payload.prompt ? `<div class="card pad"><div class="card-h"><h2>The request</h2></div><p class="req">${esc(j.payload.prompt)}</p>${workOrder(j)}</div>` : ""}

    <div class="card pad">
      <div class="card-h"><h2>Progress</h2>${j.prUrl ? `<a class="right linkbtn" href="${esc(j.prUrl)}" target="_blank" rel="noopener">Pull request${svg("ext", 13)}</a>` : ""}</div>
      <div style="padding-top:10px">${stepper(j)}</div>
      ${emissionCard(j)}
      ${j.editPlan && j.editPlan.length ? `<div class="filebox"><div class="fhead">${j.editPlan.length} file${j.editPlan.length > 1 ? "s" : ""} changed</div>${j.editPlan.map((f) => `<div class="frow"><span class="fop ${esc((f.op || "edit").toLowerCase())}">${esc(f.op || "edit")}</span><span class="fpath">${esc(f.path)}</span></div>`).join("")}</div>` : ""}
      ${(j.siteUrl || j.reportUrl || j.enrichJobId || (j.payload && j.payload.parentDraftId)) ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;align-items:center">
        ${j.siteUrl ? `<a class="linkbtn" href="${esc(j.siteUrl)}" target="_blank" rel="noopener">Assembled site${svg("ext", 13)}</a>` : ""}
        ${j.reportUrl ? `<a class="linkbtn" href="${esc(j.reportUrl)}" target="_blank" rel="noopener">Comparison report${svg("ext", 13)}</a>` : ""}
        ${j.enrichJobId ? `<a class="btn sm" href="/job?id=${encodeURIComponent(j.enrichJobId)}">${svg("spark", 14)}View service pages run</a>` : ""}
        ${(j.payload && j.payload.parentDraftId) ? `<a class="btn sm" href="/job?id=${encodeURIComponent(j.payload.parentDraftId)}">${svg("back", 14)}Back to the build run</a>` : ""}
      </div>` : ""}
    </div>

    ${techCard(j)}`;

  $("techBtn").onclick = () => {
    TECH_OPEN = !TECH_OPEN;
    $("tech").classList.toggle("open", TECH_OPEN);
    $("techBtn").setAttribute("aria-expanded", String(TECH_OPEN));
    if (TECH_OPEN) loadDiff();
  };
  // remember which briefs are open so the 3s re-render doesn't collapse them
  document.querySelectorAll("details[data-k]").forEach((d) => {
    d.addEventListener("toggle", () => { if (d.open) OPEN.add(d.dataset.k); else OPEN.delete(d.dataset.k); });
  });
  document.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = (e) => {
      if (b.dataset.act === "edit-job") { e.stopPropagation(); closeJobMenu(); openDrawer(); return; }
      if (b.dataset.act === "stitch-key") { e.stopPropagation(); closeJobMenu(); openKeyModal(); return; }
      act(b.dataset.act, b, b.dataset.step);
    };
  });
  const dotsBtn = $("dotsBtn"), jobMenu = $("jobMenu");
  if (dotsBtn && jobMenu) {
    dotsBtn.onclick = (e) => { e.stopPropagation(); jobMenu.classList.toggle("open"); };
    document.addEventListener("click", closeJobMenu, { once: true });
  }
  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async (e) => {
      // Inside a <summary>-less <details> body, but still guard: a click must not toggle it.
      e.preventDefault(); e.stopPropagation();
      const text = (b.parentElement.querySelector(".brieftext") || {}).textContent || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        // clipboard API needs a secure context; fall back to a hidden textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e2) { toast("could not copy", true); }
        ta.remove();
      }
      b.classList.add("copied");
      b.innerHTML = svg("check", 13) + " Copied";
      setTimeout(() => { b.classList.remove("copied"); b.innerHTML = svg("copy", 13) + " Copy"; }, 1600);
    };
  });
  if (TECH_OPEN) loadDiff();
}

async function act(kind, btn, step) {
  // Edit jobs carry the target repo on their payload; build jobs don't, so the
  // row is omitted rather than filled with a placeholder.
  const repo = (JOB.payload && JOB.payload.githubRepo) || null;
  const withRepo = (d) => (repo ? { ...d, Repository: repo } : d);
  const ASK = {
    approve: {
      title: "Approve and merge?",
      body: "This merges the pull request and ships the change to the live site. It can only be undone with another change.",
      details: withRepo({ Site: JOB.businessName, ...(JOB.prUrl ? { "Pull request": JOB.prUrl } : {}) }),
      confirmLabel: "Approve & ship",
    },
    cancel: {
      title: "Cancel this run?",
      body: "The run stops at the next step boundary. Work already pushed stays on its branch — nothing is rolled back.",
      details: { Site: JOB.businessName, Run: JOB.draftId },
      confirmLabel: "Cancel run", tone: "danger",
    },
    resend: {
      title: "Resend this event?",
      body: "Posts this run's final status to Growth99 again. The receiver is idempotent, so nothing is duplicated — it only fills in the event that never arrived.",
      details: { Site: JOB.businessName, Run: JOB.draftId },
      confirmLabel: "Resend",
    },
    retry: {
      title: "Run this again?",
      body: JOB.type === "build"
        ? "Starts a fresh build: audit, brand, page generation, theme and deploy. Takes several minutes and spends AI credits."
        : "Starts a fresh edit run with the same request, opening a new pull request.",
      details: withRepo({ Site: JOB.businessName }),
      confirmLabel: "Run again",
    },
    "retry-step": {
      title: "Retry the theme-activation wait?",
      body: "Re-checks whether the mu-plugin has switched the live theme, then re-runs the after-audit and service-page enrichment. Does NOT re-run Stitch, the pull request, or CI — those are assumed already done.",
      details: withRepo({ Site: JOB.businessName, "Live URL": JOB.liveUrl }),
      confirmLabel: "Retry step",
    },
  }[kind];

  if (!(await window.G99.confirm(ASK))) return;

  const cfg = {
    approve: ["/api/job-approve", "Approved — merging…"],
    cancel: ["/api/job-cancel", "Cancelling…"],
    retry: ["/api/job-retry", "Retrying — new run started…"],
    "retry-step": ["/api/job-retry-step", "Retrying theme activation…"],
    resend: ["/api/job-emit-resend", "Resending — watch the delivery panel…"],
  }[kind];
  btn.disabled = true;
  try {
    const d = await postJSON(cfg[0], { id: ID, ...(step ? { step } : {}) });
    toast(cfg[1]);
    if (d.jobId) setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 700);
    else {
      // A step retry flips this same job back to "running" server-side, but the
      // poll loop may have already stopped (it clears itself once a job settles
      // into error/done) — restart it so progress shows up without a manual reload.
      if (kind === "retry-step") { clearInterval(timer); timer = setInterval(load, 3000); }
      load();
    }
  } catch (e) { toast("Failed: " + e.message); btn.disabled = false; }
}

async function loadDiff() {
  if (diffLoaded || !JOB || !JOB.prUrl || !$("diffBox")) return;
  diffLoaded = true;
  try {
    const d = await getJSON("/api/pr-diff?prUrl=" + encodeURIComponent(JOB.prUrl));
    $("diffBox").innerHTML = esc(d.diff || "(empty diff)").split("\n").map((l) =>
      l.startsWith("+") && !l.startsWith("+++") ? `<span class="a">${l}</span>` :
      l.startsWith("-") && !l.startsWith("---") ? `<span class="d">${l}</span>` : l).join("\n");
  } catch (e) {
    diffLoaded = false;
    if ($("diffBox")) $("diffBox").textContent = "Could not load diff: " + e.message;
  }
}

async function load() {
  try {
    JOB = await getJSON("/api/job?id=" + encodeURIComponent(ID));
  } catch (e) {
    // Only a real 404 means the run is gone; anything else (401, network, 5xx) must say so rather
    // than blaming "cleared" state — that mis-diagnosis sent us hunting for lost jobs that existed.
    const msg = e && e.status === 404
      ? `Run <b>${esc(ID)}</b> not found — it may have been cleared.`
      : e && e.status === 401
        ? `Unauthorized — reload the page and enter the admin password.`
        : `Could not load run <b>${esc(ID)}</b>: ${esc(e && e.message ? e.message : "request failed")}`;
    $("wrap").innerHTML = `<p class="empty">${msg} <a href="/jobs">← all activity</a></p>`;
    clearInterval(timer);
    return;
  }
  // While pages are being generated, pull the live per-page progress too.
  const genStep = (JOB.steps || [])[2];
  if (JOB.type !== "edit" && genStep && genStep.status === "running") {
    try { GENPROG = await getJSON("/api/generate-progress"); } catch (e) { /* keep last */ }
  }
  document.title = "Growth99 · " + JOB.businessName;
  render();
  // Keep polling while anything can still change. A build can be "done" while its
  // enrichment run is still going (that step mirrors it), so don't stop on status
  // alone — otherwise the page goes stale and needs a manual refresh.
  const settled = ["done", "error", "cancelled"].includes(JOB.status);
  const childRunning = (JOB.steps || []).some((s) => s.status === "running" || s.status === "pending");
  if (settled && !childRunning) clearInterval(timer);
}

function closeJobMenu() { const m = $("jobMenu"); if (m) m.classList.remove("open"); }

// ---- Edit drawer ------------------------------------------------------------
const ONBOARDING_FIELDS = [
  { key: "business_name",        label: "Business name",       type: "input" },
  { key: "primary_contact",      label: "Primary contact",     type: "input" },
  { key: "phone_for_website",    label: "Phone",               type: "input" },
  { key: "location",             label: "Location",            type: "input" },
  { key: "services_offered",     label: "Services offered",    type: "chips" },
  { key: "revenue_services",     label: "Revenue services",    type: "chips" },
  { key: "team_members",         label: "Team members (JSON)", type: "textarea" },
  { key: "booking_platform",     label: "Booking platform",    type: "input" },
  { key: "booking_platform_url", label: "Booking URL",         type: "input" },
  { key: "featured_review",      label: "Featured review",     type: "textarea" },
  { key: "site_love_1_url",      label: "Reference site URL",  type: "input" },
];

// Parse a value that may be a JSON array string or plain comma-list into string[]
function parseChips(raw) {
  if (!raw) return [];
  try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch (e) { /* not json */ }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function chipsHtml(key, chips) {
  const chipsMarkup = chips.map((c, i) =>
    `<span class="chip" data-chip-key="${esc(key)}" data-idx="${i}">${esc(c)}<button type="button" class="chip-rm" aria-label="Remove ${esc(c)}">&#10005;</button></span>`
  ).join("");
  return `<div class="chips-wrap" id="chips_${esc(key)}">${chipsMarkup}</div>
    <div class="chip-add-row">
      <input class="chip-input" id="chipinput_${esc(key)}" type="text" placeholder="Add service…">
      <button type="button" class="btn sm chip-add-btn" data-chip-target="${esc(key)}">Add</button>
    </div>`;
}

function injectDrawer() {
  if ($("jobDrawer")) return;
  const el = document.createElement("div");
  el.innerHTML = `
    <div class="drawer-overlay" id="drawerOverlay"></div>
    <div class="drawer" id="jobDrawer" role="dialog" aria-modal="true" aria-label="Edit job data">
      <div class="drawer-head">
        <h2>Edit job data</h2>
        <button id="drawerClose" title="Close">&#10005;</button>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
      <div class="drawer-foot">
        <button class="btn" id="drawerCancel">Cancel</button>
        <button class="btn" id="drawerSave">Save changes</button>
        <button class="btn primary" id="drawerSaveRun" style="display:${JOB && JOB.type === "build" ? "inline-flex" : "none"}">Save &amp; Run</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  $("drawerOverlay").onclick = closeDrawer;
  $("drawerClose").onclick = closeDrawer;
  $("drawerCancel").onclick = closeDrawer;
  $("drawerSave").onclick = () => saveDrawer(false);
  $("drawerSaveRun").onclick = () => saveDrawer(true);
}

// Server-side (mapG99Answers, runJob) stores answers as a plain object keyed by
// question key — {business_name: "...", services_offered: [...]}. Old job records
// (or a hand-pasted array) may still carry the webhook's original wire shape,
// [{key, value}], so tolerate both rather than assuming one.
function toAnswersObject(answers) {
  if (Array.isArray(answers)) {
    const o = {};
    for (const a of answers) { if (a && a.key) o[a.key] = a.value; }
    return o;
  }
  return (answers && typeof answers === "object") ? answers : {};
}
function getAnswer(answers, key) {
  const v = toAnswersObject(answers)[key];
  return v == null ? "" : (Array.isArray(v) ? JSON.stringify(v) : String(v));
}

let drawerTab = "fields";

function openDrawer() {
  injectDrawer();
  const j = JOB;
  const answers = toAnswersObject(j.payload && j.payload.answers);
  drawerTab = "fields";
  renderDrawerBody(j, answers);
  $("drawerOverlay").classList.add("open");
  $("jobDrawer").classList.add("open");
}

function renderDrawerBody(j, answers) {
  const fieldsHtml = ONBOARDING_FIELDS.map(({ key, label, type }) => {
    const raw = getAnswer(answers, key);
    if (type === "chips") {
      const chips = parseChips(raw);
      return `<div class="dfield">
        <label>${esc(label)}</label>
        ${chipsHtml(key, chips)}
      </div>`;
    }
    const val = esc(raw);
    return `<div class="dfield">
      <label for="df_${esc(key)}">${esc(label)}</label>
      ${type === "textarea"
        ? `<textarea id="df_${esc(key)}" data-akey="${esc(key)}" rows="3">${val}</textarea>`
        : `<input id="df_${esc(key)}" data-akey="${esc(key)}" type="text" value="${val}">`}
    </div>`;
  }).join("");

  const rawJson = esc(JSON.stringify(answers, null, 2));

  $("drawerBody").innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Build targets</div>
      <div class="dfield">
        <label for="df_repo">Git repository (owner/repo)</label>
        <input id="df_repo" type="text" value="${esc(j.repo || "")}" placeholder="e.g. growth99/client-site">
        <span class="hint">Used for edits, PR creation, and deploys</span>
      </div>
      <div class="dfield">
        <label for="df_liveUrl">Beta / live site URL</label>
        <input id="df_liveUrl" type="text" value="${esc(j.liveUrl || "")}" placeholder="https://...">
      </div>
      <div class="dfield">
        <label for="df_existingUrl">Existing site URL</label>
        <input id="df_existingUrl" type="text" value="${esc((j.payload && j.payload.existingWebsite) || "")}" placeholder="https://...">
        <span class="hint">Used for content grounding and SEO enrichment</span>
      </div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Onboarding answers</div>
      <div class="drawer-tabs">
        <button id="tabFields" class="${drawerTab === "fields" ? "active" : ""}">Fields</button>
        <button id="tabJson" class="${drawerTab === "json" ? "active" : ""}">Raw JSON</button>
      </div>
      <div id="tabFieldsPane" style="display:${drawerTab === "fields" ? "flex" : "none"};flex-direction:column;gap:10px">${fieldsHtml}</div>
      <div id="tabJsonPane" style="display:${drawerTab === "json" ? "block" : "none"}">
        <div class="dfield">
          <label>Full answers object (JSON)</label>
          <textarea id="df_rawJson" rows="18" style="font-family:var(--mono);font-size:11.5px">${rawJson}</textarea>
          <span class="hint">Edit individual keys above or paste the whole object here</span>
        </div>
      </div>
    </div>`;

  $("tabFields").onclick = () => { drawerTab = "fields"; syncJsonToFields(); renderDrawerBody(j, currentAnswers()); };
  $("tabJson").onclick  = () => { drawerTab = "json";   syncFieldsToJson();  renderDrawerBody(j, currentAnswers()); };
  wireChips();
}

// ── Stitch key modal ─────────────────────────────────────────────────────────
function injectKeyModal() {
  if ($("keyModalOverlay")) return;
  const el = document.createElement("div");
  el.innerHTML = `
    <div id="keyModalOverlay" class="drawer-overlay"></div>
    <div id="keyModal" class="drawer" style="max-width:460px">
      <div class="drawer-head">
        <span>Stitch API key</span>
        <button onclick="closeKeyModal()" style="background:none;border:none;cursor:pointer;font-size:18px;line-height:1">&#x2715;</button>
      </div>
      <div class="drawer-body" id="keyModalBody" style="gap:14px">
        <p style="margin:0;font-size:13px;color:var(--text-2)">Select which key to use for the next run. <strong>Auto</strong> lets the server rotate through all env keys normally.</p>
        <div class="dfield">
          <label for="km_sel">Key</label>
          <select id="km_sel">
            <option value="">Auto (use env keys)</option>
          </select>
        </div>
        <div id="km_customWrap" style="display:none;flex-direction:column;gap:8px">
          <div class="dfield">
            <label for="km_customKey">Custom key</label>
            <input id="km_customKey" type="text" placeholder="Paste your Stitch API key…">
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button id="km_validateBtn" style="padding:5px 12px;cursor:pointer;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">Validate</button>
            <span id="km_status" style="font-size:12px"></span>
          </div>
        </div>
      </div>
      <div class="drawer-foot">
        <button onclick="closeKeyModal()" style="padding:7px 16px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer">Cancel</button>
        <button id="km_saveBtn" style="padding:7px 16px;border:none;border-radius:6px;background:var(--accent,#6366f1);color:#fff;cursor:pointer;font-weight:600">Save &amp; re-run</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  $("keyModalOverlay").onclick = closeKeyModal;
}

async function openKeyModal() {
  injectKeyModal();
  const j = JOB;
  const savedOverride = (j.payload && j.payload.stitchKeyOverride) || "";
  const sel = $("km_sel");
  const customWrap = $("km_customWrap");

  // Clear and reload key options each open (server may have changed)
  while (sel.options.length > 1) sel.remove(1);
  let pooledKeys = [];
  try {
    const data = await (await fetch("/api/stitch-keys", { headers: { "x-admin-key": localStorage.getItem("g99AdminKey") || "" } })).json();
    pooledKeys = data.keys || [];
    pooledKeys.forEach(({ label, masked, key }) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${label} · ${masked}`;
      sel.appendChild(opt);
    });
  } catch (e) { /* non-fatal */ }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom key…";
  sel.appendChild(customOpt);

  // Restore saved override
  if (savedOverride) {
    const match = pooledKeys.find(k => k.key === savedOverride);
    if (match) {
      sel.value = savedOverride;
    } else {
      sel.value = "__custom__";
      customWrap.style.display = "flex";
      $("km_customKey").value = savedOverride;
    }
  } else {
    sel.value = "";
    customWrap.style.display = "none";
  }
  $("km_status").textContent = "";

  sel.onchange = () => {
    customWrap.style.display = sel.value === "__custom__" ? "flex" : "none";
    $("km_status").textContent = "";
  };

  $("km_validateBtn").onclick = async () => {
    const key = $("km_customKey").value.trim();
    if (!key) return;
    const btn = $("km_validateBtn"), st = $("km_status");
    btn.disabled = true; st.textContent = "Checking…"; st.style.color = "var(--text-2)";
    try {
      const r = await postJSON("/api/stitch-key-validate", { key });
      st.textContent = r.valid ? "✓ Valid" : ("✗ Invalid" + (r.error ? ` (${r.error})` : ""));
      st.style.color = r.valid ? "#22c55e" : "#ef4444";
    } catch (e) { st.textContent = "Error: " + e.message; st.style.color = "#ef4444"; }
    finally { btn.disabled = false; }
  };

  $("km_saveBtn").onclick = saveKeyAndRerun;

  $("keyModalOverlay").classList.add("open");
  $("keyModal").classList.add("open");
}

function closeKeyModal() {
  $("keyModalOverlay") && $("keyModalOverlay").classList.remove("open");
  $("keyModal") && $("keyModal").classList.remove("open");
}

async function saveKeyAndRerun() {
  const sel = $("km_sel");
  let override = null;
  if (sel.value === "__custom__") {
    override = $("km_customKey").value.trim() || null;
  } else if (sel.value !== "") {
    override = sel.value; // full key from pooled option
  }
  // Auto (sel.value === "") → override stays null → server uses env rotation

  const btn = $("km_saveBtn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await postJSON("/api/job-update", { id: ID, stitchKeyOverride: override });
    toast("Key saved — starting new run…");
    closeKeyModal();
    const d = await postJSON("/api/job-retry", { id: ID });
    if (d.jobId) setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 500);
    else load();
  } catch (e) {
    toast("Failed: " + e.message, true);
    btn.disabled = false; btn.textContent = "Save & re-run";
  }
}

function wireChips() {
  // Remove chip on × click
  document.querySelectorAll(".chip-rm").forEach((btn) => {
    btn.onclick = () => {
      btn.closest(".chip").remove();
    };
  });
  // Add chip on button click or Enter in input
  document.querySelectorAll(".chip-add-btn").forEach((btn) => {
    const key = btn.dataset.chipTarget;
    const inp = $("chipinput_" + key);
    const addChip = () => {
      const val = inp ? inp.value.trim() : "";
      if (!val) return;
      const wrap = $("chips_" + key);
      if (!wrap) return;
      const span = document.createElement("span");
      span.className = "chip";
      span.dataset.chipKey = key;
      span.innerHTML = `${esc(val)}<button type="button" class="chip-rm" aria-label="Remove ${esc(val)}">&#10005;</button>`;
      span.querySelector(".chip-rm").onclick = () => span.remove();
      wrap.appendChild(span);
      if (inp) inp.value = "";
    };
    btn.onclick = addChip;
    if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addChip(); } };
  });
}

function currentAnswers() {
  const raw = $("df_rawJson");
  if (raw) { try { return toAnswersObject(JSON.parse(raw.value)); } catch (e) { return toAnswersObject(JOB.payload && JOB.payload.answers); } }
  return buildAnswersFromFields();
}

function buildAnswersFromFields() {
  const base = { ...toAnswersObject(JOB.payload && JOB.payload.answers) };
  // regular inputs / textareas
  document.querySelectorAll("[data-akey]").forEach((el) => {
    base[el.dataset.akey] = el.value;
  });
  // chip fields — collect text from each .chip span (exclude the × button text)
  ONBOARDING_FIELDS.filter((f) => f.type === "chips").forEach(({ key }) => {
    const wrap = $("chips_" + key);
    if (!wrap) return;
    const chips = [...wrap.querySelectorAll(".chip")].map((s) => {
      const clone = s.cloneNode(true);
      clone.querySelector(".chip-rm") && clone.querySelector(".chip-rm").remove();
      return clone.textContent.trim();
    }).filter(Boolean);
    base[key] = chips;
  });
  return base;
}

function syncFieldsToJson() {
  const answers = buildAnswersFromFields();
  const raw = $("df_rawJson");
  if (raw) raw.value = JSON.stringify(answers, null, 2);
}

function syncJsonToFields() {
  // next renderDrawerBody call will re-read currentAnswers() from the textarea before re-render
}

function closeDrawer() {
  $("drawerOverlay") && $("drawerOverlay").classList.remove("open");
  $("jobDrawer") && $("jobDrawer").classList.remove("open");
}

async function saveDrawer(andRerun) {
  // Both buttons drive the SAME collection logic — the raw-JSON tab (whichever tab is
  // active when clicked) is the one source of truth that actually reaches the server;
  // there is no separate/second JSON box, this textarea IS what a rerun uses.
  const btn = andRerun ? $("drawerSaveRun") : $("drawerSave");
  const otherBtn = andRerun ? $("drawerSave") : $("drawerSaveRun");
  const label = andRerun ? "Save & Run" : "Save changes";
  btn.disabled = true; otherBtn.disabled = true; btn.textContent = andRerun ? "Starting run…" : "Saving…";
  try {
    let answers;
    if (drawerTab === "json") {
      try { answers = toAnswersObject(JSON.parse($("df_rawJson").value)); }
      catch (e) { toast("Invalid JSON — fix it and try again", true); btn.disabled = false; otherBtn.disabled = false; btn.textContent = label; return; }
    } else {
      answers = buildAnswersFromFields();
    }
    const d = await postJSON("/api/job-update", {
      id: ID,
      repo:            $("df_repo").value.trim() || null,
      liveUrl:         $("df_liveUrl").value.trim() || null,
      existingWebsite: $("df_existingUrl").value.trim() || null,
      answers,
      andRerun: !!andRerun,
    });
    if (andRerun && d.jobId) {
      toast("Saved — starting new run…");
      setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 500);
      return;
    }
    toast("Saved ✓");
    closeDrawer();
    load();
  } catch (e) {
    toast("Save failed: " + e.message, true);
    btn.disabled = false; otherBtn.disabled = false; btn.textContent = label;
  }
}

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  if (!ID) { $("wrap").innerHTML = '<p class="empty">No run id. <a href="/jobs">← all activity</a></p>'; return; }
  load();
  timer = setInterval(load, 3000);
});
