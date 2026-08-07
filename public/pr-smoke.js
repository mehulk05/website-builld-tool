// Growth99 Website Studio — GitHub access check.
// Not linked from the nav on purpose: every run pushes a real branch and opens a real PR,
// so it is reached by URL when you are deliberately testing credentials.
"use strict";

const { esc, postJSON, getJSON, ensureAuth, svg, toast } = window.G99;
const $ = (id) => document.getElementById(id);

function stepRow(s) {
  return `<div class="step ${s.ok ? "ok" : "no"}">
    <span class="mark">${s.ok ? "&#10003;" : "&#10007;"}</span>
    <div>
      <div class="lbl">${esc(s.label)}</div>
      ${s.detail ? `<div class="det">${esc(s.detail)}</div>` : ""}
      ${s.url ? `<div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>` : ""}
    </div>
  </div>`;
}

function busy(on) {
  document.querySelectorAll(".row button").forEach((b) => { b.disabled = on; });
}

async function run(mode) {
  const repo = $("repo").value.trim();
  const base = $("base").value.trim() || "main";
  if (!repo) return toast("enter a repository", true);
  busy(true);
  $("out").style.display = "block";
  $("out").innerHTML = `<div class="step">
    <span class="mark"><span class="spin"></span></span>
    <div><div class="lbl">Running (${esc(mode)})…</div>
    <div class="det">clone → commit → push → open PR</div></div></div>`;
  try {
    const d = await postJSON("/api/pr-smoke", { mode, repo, base });
    $("out").innerHTML = (d.steps || []).map(stepRow).join("");
    toast(d.ok ? "PR opened" : "check failed", !d.ok);
  } catch (e) {
    $("out").innerHTML = stepRow({ ok: false, label: "Request failed", detail: e.message });
    toast(e.message, true);
  }
  busy(false);
}

// Which credentials the server actually has, so the buttons aren't a guess.
async function showMode() {
  try {
    const d = await getJSON("/api/gh-auth");
    $("mode").textContent = d.mode;
    $("warn").innerHTML = d.warning
      ? `${svg("warn", 15)}<span>${esc(d.warning)}</span>`
      : `${svg("check", 15)}<span>GitHub App can drive the whole pipeline — push, PR and CI checks.</span>`;
  } catch (e) {
    $("warn").style.display = "none";
    $("mode").textContent = "unknown";
  }
}

ensureAuth().then((ok) => {
  if (!ok) { document.querySelector(".wrap").innerHTML = '<p class="empty">Unauthorized — reload and enter the admin password.</p>'; return; }
  showMode();
  $("auto").onclick = () => run("auto");
  $("app").onclick = () => run("app");
  $("pat").onclick = () => run("pat");
});
