// Mint a review link per site. The tool already had the endpoint; what it did
// not have was anywhere to press it, so handing links to a designer for twenty
// sites meant twenty curls.
(function () {
  "use strict";
  var listEl = document.getElementById("list");
  var msgEl = document.getElementById("msg");

  function msg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = "msg on " + (kind || "");
    if (!text) msgEl.className = "msg";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
        return d;
      });
    });
  }

  function render(sites) {
    listEl.innerHTML = "";
    if (!sites.length) {
      listEl.innerHTML = '<p class="hint">No sites are known to the tool yet.</p>';
      return;
    }
    sites.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "site";
      row.innerHTML =
        '<div style="min-width:0">'
        + '<div class="nm">' + esc(s.businessName || s.siteId) + "</div>"
        + '<div class="sub">' + esc(s.liveUrl || "no beta URL on record") + "</div>"
        + '<div class="lnk"></div>'
        + "</div>"
        + '<div class="act">'
        + '<button class="btn" data-act="mint">Create link</button>'
        + '<button class="btn secondary" data-act="copy" style="display:none">Copy</button>'
        + '<button class="btn secondary" data-act="open" style="display:none">Open</button>'
        + "</div>";

      var lnk = row.querySelector(".lnk");
      var mint = row.querySelector('[data-act="mint"]');
      var copy = row.querySelector('[data-act="copy"]');
      var open = row.querySelector('[data-act="open"]');
      var url = "";

      mint.addEventListener("click", function () {
        var reviewer = document.getElementById("reviewer").value.trim();
        if (!reviewer) { msg("Put the reviewer's name in first — it is shown in the widget and recorded against every change they make.", "err"); return; }
        msg("");
        mint.disabled = true; mint.textContent = "Creating…";
        api("/api/review/mint", {
          method: "POST",
          body: JSON.stringify({ site: s.siteId, reviewer: reviewer, minutes: Number(document.getElementById("minutes").value) }),
        }).then(function (d) {
          url = d.url;
          lnk.textContent = url;
          lnk.className = "lnk on";
          copy.style.display = ""; open.style.display = "";
          mint.textContent = "New link";
          msg("Link ready for " + reviewer + " — expires " + new Date(d.expiresAt).toLocaleString() + ".", "ok");
        }).catch(function (e) {
          msg(s.businessName + ": " + e.message, "err");
          mint.textContent = "Create link";
        }).finally(function () { mint.disabled = false; });
      });

      copy.addEventListener("click", function () {
        if (!url) return;
        navigator.clipboard.writeText(url).then(function () {
          copy.textContent = "Copied";
          setTimeout(function () { copy.textContent = "Copy"; }, 1500);
        });
      });
      open.addEventListener("click", function () { if (url) window.open(url, "_blank", "noopener"); });

      listEl.appendChild(row);
    });
  }

  api("/api/sites")
    .then(function (d) { render((d && d.sites) || []); })
    .catch(function (e) { msg("Could not load the site list — " + e.message, "err"); });
})();
