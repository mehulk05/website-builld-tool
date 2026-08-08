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

function stepper(j) {
  const ic = { done: svg("check", 13, 3), running: `<span class="spin" style="margin:0;border-color:var(--accent);border-top-color:transparent"></span>`, error: svg("close", 13, 3), pending: "" };
  const isBuild = j.type === "build";
  return `<div class="steps">${(j.steps || []).map((s, i) => {
    let extra = "";
    if (isBuild && i === 1 && s.status !== "pending") extra = brandBlock(j);
    if (isBuild && i === 2 && s.status !== "pending") extra = pageRows(j, s.status === "running");
    extra += stepEvents(j, i, s);
    return `
    <div class="jstep ${s.status}">
      <span class="ic">${ic[s.status] || ""}</span>
      <div class="jb">
        <span class="lb">${esc(s.label)}</span>
        ${s.detail ? `<span class="dt"${s.status === "error" ? ' style="color:var(--bad)"' : ""}>${esc(s.detail)}</span>` : ""}
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
  if (["done", "error", "cancelled"].includes(j.status)) b.push(`<button class="btn" data-act="retry">${svg("refresh", 15)}Run again</button>`);
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
  document.querySelectorAll("[data-act]").forEach((b) => { b.onclick = () => act(b.dataset.act, b); });
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

async function act(kind, btn) {
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
  }[kind];

  if (!(await window.G99.confirm(ASK))) return;

  const cfg = {
    approve: ["/api/job-approve", "Approved — merging…"],
    cancel: ["/api/job-cancel", "Cancelling…"],
    retry: ["/api/job-retry", "Retrying — new run started…"],
    resend: ["/api/job-emit-resend", "Resending — watch the delivery panel…"],
  }[kind];
  btn.disabled = true;
  try {
    const d = await postJSON(cfg[0], { id: ID });
    toast(cfg[1]);
    if (d.jobId) setTimeout(() => { location.href = "/job?id=" + encodeURIComponent(d.jobId); }, 700);
    else load();
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

ensureAuth().then((ok) => {
  if (!ok) { $("wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  if (!ID) { $("wrap").innerHTML = '<p class="empty">No run id. <a href="/jobs">← all activity</a></p>'; return; }
  load();
  timer = setInterval(load, 3000);
});
