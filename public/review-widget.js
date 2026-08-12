// Growth99 content review widget — loaded ONLY inside a valid review session.
// The mu-plugin does not print this file for a normal visitor, so there is no
// "am I allowed" check here: reaching this code already means the server said yes.
//
// What it does: turn a text selection on the page into an exact old -> new pair,
// batch a session's pairs, and hand them to the tool in one submission. Exact
// pairs are what let the change be applied in code rather than by a model, so
// the widget's real job is to capture the ORIGINAL string faithfully.
(function () {
  "use strict";
  var CFG = window.G99_REVIEW;
  if (!CFG || !CFG.rest) return;

  var MIN = 3, MAX = 600;
  var queue = [];
  var pending = null;      // the selection currently being edited
  var poll = null;

  // ---- shell ---------------------------------------------------------------
  var css = ""
    + ".g99r-hide{display:none!important}"
    + "#g99r-chip{position:fixed;z-index:2147483000;padding:6px 12px;border-radius:999px;border:0;"
    + "background:#111;color:#fff;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28)}"
    + "#g99r-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;"
    + "padding:11px 16px;border-radius:999px;border:0;background:#111;color:#fff;cursor:pointer;"
    + "font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3)}"
    + "#g99r-launch b{background:#fff;color:#111;border-radius:999px;padding:1px 7px;font-size:12px}"
    + "#g99r-panel{position:fixed;right:20px;bottom:76px;width:370px;max-height:72vh;overflow:auto;z-index:2147483000;"
    + "background:#fff;color:#111;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);"
    + "font:14px/1.45 system-ui,sans-serif;padding:16px}"
    + "#g99r-panel h4{margin:0 0 4px;font-size:14px}"
    + "#g99r-panel .g99r-sub{color:#666;font-size:12px;margin:0 0 12px}"
    + "#g99r-panel textarea{width:100%;box-sizing:border-box;border:1px solid #d6d6d6;border-radius:8px;padding:8px;"
    + "font:13px/1.4 system-ui,sans-serif;resize:vertical}"
    + "#g99r-panel textarea[readonly]{background:#f5f5f5;color:#555}"
    + "#g99r-panel label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px}"
    + ".g99r-btn{border:0;border-radius:8px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer}"
    + ".g99r-primary{background:#111;color:#fff}.g99r-primary[disabled]{opacity:.45;cursor:default}"
    + ".g99r-ghost{background:#eee;color:#111}"
    + ".g99r-row{display:flex;gap:8px;margin-top:12px}"
    + ".g99r-item{border-top:1px solid #eee;padding:9px 0;font-size:12px}"
    + ".g99r-item del{color:#9b1c1c;text-decoration:line-through}.g99r-item ins{color:#136c2e;text-decoration:none}"
    + ".g99r-item button{float:right;border:0;background:none;color:#888;cursor:pointer;font-size:14px;line-height:1}"
    + ".g99r-warn{background:#fff6e5;color:#7a4b00;border-radius:8px;padding:8px;font-size:12px;margin-top:10px}"
    + ".g99r-note{color:#666;font-size:12px;margin-top:10px}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }

  var launch = el("button", { id: "g99r-launch", type: "button" });
  var panel = el("div", { id: "g99r-panel", class: "g99r-hide" });
  var chip = el("button", { id: "g99r-chip", class: "g99r-hide", type: "button" }, "Suggest an edit");
  document.body.appendChild(launch);
  document.body.appendChild(panel);
  document.body.appendChild(chip);

  function paintLaunch() {
    launch.innerHTML = "✎ Content review" + (queue.length ? " <b>" + queue.length + "</b>" : "");
  }

  // ---- selection capture ---------------------------------------------------
  // Refuses a selection that spans elements. The tool matches the original
  // string against the page template character-for-character, and a selection
  // crossing a tag boundary produces a string that exists on screen but not in
  // the source — so it would silently match nothing. Better to say so here.
  function ours(node) {
    while (node) {
      if (node.id === "g99r-panel" || node.id === "g99r-launch" || node.id === "g99r-chip") return true;
      node = node.parentNode;
    }
    return false;
  }

  document.addEventListener("mouseup", function (e) {
    if (ours(e.target)) return;
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return hideChip();
      var text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < MIN || text.length > MAX) return hideChip();
      var range = sel.getRangeAt(0);
      if (ours(range.startContainer)) return hideChip();
      var split = range.startContainer !== range.endContainer;
      var rect = range.getBoundingClientRect();
      pending = { text: text, split: split };
      chip.style.left = Math.max(8, Math.min(window.innerWidth - 140, rect.left)) + "px";
      chip.style.top = Math.max(8, rect.top - 40) + "px";
      chip.classList.remove("g99r-hide");
    }, 10);
  });
  function hideChip() { chip.classList.add("g99r-hide"); }

  chip.addEventListener("click", function () {
    hideChip();
    if (pending) openEditor(pending);
  });

  // How many times this exact text appears in the visible page. More than one
  // means the swap will hit every copy, which is worth saying before they submit
  // rather than explaining afterwards.
  function occurrences(text) {
    var body = document.body.innerText.replace(/\s+/g, " ");
    var n = 0, i = 0;
    while ((i = body.indexOf(text, i)) !== -1) { n++; i += text.length; }
    return n;
  }

  // ---- panel ---------------------------------------------------------------
  function openEditor(sel) {
    var many = occurrences(sel.text);
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "Change this text"));
    panel.appendChild(el("p", { class: "g99r-sub" }, esc(CFG.reviewer) + " · " + esc(CFG.path)));
    panel.appendChild(el("label", null, "Currently on the page"));
    var orig = el("textarea", { rows: "3", readonly: "readonly" });
    orig.value = sel.text;
    panel.appendChild(orig);
    panel.appendChild(el("label", null, "Change it to"));
    var next = el("textarea", { rows: "3", placeholder: "Type the exact replacement wording" });
    panel.appendChild(next);

    // Headings are routinely built as "Line one,<br><span>line two</span>", so
    // the whole headline exists on screen as one sentence and in the template as
    // two. Selecting one line at a time always matches; saying so is worth more
    // than warning that something "may" not work.
    if (sel.split) {
      panel.appendChild(el("div", { class: "g99r-warn" },
        "This selection runs across a line break, so it does not exist as one piece in the page. "
        + "Change one line at a time and it will be applied exactly."));
    }
    if (many > 1) {
      panel.appendChild(el("div", { class: "g99r-warn" },
        "This text appears " + many + " times on this page — every copy will be updated."));
    }
    // Counted on screen only; the page's own alt text, meta description and the
    // other templates are invisible from here. A lone word almost always occurs
    // in places the reviewer cannot see, so it is refused rather than guessed at.
    if (!/\s/.test(sel.text.trim())) {
      panel.appendChild(el("div", { class: "g99r-warn" },
        "That is a single word. It will only be changed if it appears exactly once on this page — "
        + "select the whole phrase around it to be sure of the change."));
    }

    var row = el("div", { class: "g99r-row" });
    var add = el("button", { class: "g99r-btn g99r-primary", type: "button" }, "Add change");
    var cancel = el("button", { class: "g99r-btn g99r-ghost", type: "button" }, "Cancel");
    row.appendChild(add); row.appendChild(cancel);
    panel.appendChild(row);
    panel.classList.remove("g99r-hide");
    next.focus();

    cancel.addEventListener("click", showQueue);
    add.addEventListener("click", function () {
      var v = next.value.trim();
      if (!v) return next.focus();
      if (v === sel.text) return next.focus();
      queue.push({ original: sel.text, replacement: v });
      pending = null;
      paintLaunch();
      showQueue();
    });
  }

  function showQueue() {
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "Content review"));
    panel.appendChild(el("p", { class: "g99r-sub" }, esc(CFG.reviewer) + " · " + esc(CFG.path)));

    if (!queue.length) {
      panel.appendChild(el("p", { class: "g99r-note" },
        "Select any text on the page, then choose <b>Suggest an edit</b>. "
        + "Add as many changes as you like across as many pages as you like — they are sent together."));
    } else {
      queue.forEach(function (c, i) {
        var item = el("div", { class: "g99r-item" },
          '<button type="button" title="Remove" data-i="' + i + '">&times;</button>'
          + "<del>" + esc(clip(c.original, 90)) + "</del><br><ins>" + esc(clip(c.replacement, 90)) + "</ins>");
        panel.appendChild(item);
      });
      panel.addEventListener("click", onRemove);
      var row = el("div", { class: "g99r-row" });
      var apply = el("button", { class: "g99r-btn g99r-primary", type: "button" },
        "Apply " + queue.length + " change" + (queue.length > 1 ? "s" : ""));
      row.appendChild(apply);
      panel.appendChild(row);
      panel.appendChild(el("p", { class: "g99r-note" },
        "They go live automatically. You do not need to stay on this page."));
      apply.addEventListener("click", submit);
    }
    panel.classList.remove("g99r-hide");
  }

  function onRemove(e) {
    var t = e.target;
    if (t.tagName !== "BUTTON" || !t.hasAttribute("data-i")) return;
    queue.splice(Number(t.getAttribute("data-i")), 1);
    paintLaunch();
    showQueue();
  }

  // ---- submit --------------------------------------------------------------
  // `query` is kept separate rather than baked into `route` on purpose. A site
  // without pretty permalinks gets rest_url() = ".../index.php?rest_route=/g99/v1",
  // so a route ending in "?job=1" would make the job id part of the route name
  // and arrive as no parameter at all.
  function api(route, query, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (CFG.nonce) opts.headers["X-WP-Nonce"] = CFG.nonce;
    var url = CFG.rest + route;
    if (query) url += (url.indexOf("?") > -1 ? "&" : "?") + query;
    return fetch(url, opts).then(function (r) { return r.json(); });
  }

  // `refused` is the list of corrections the tool declined, with its reasons.
  // Shown in full: a reviewer who is told "done" while one of their changes was
  // silently dropped has no way to notice, and will assume the page is wrong
  // rather than that the request was refused.
  function status(msg, note, refused) {
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "Content review"));
    panel.appendChild(el("p", { class: "g99r-sub" }, esc(CFG.reviewer)));
    panel.appendChild(el("p", null, esc(msg)));
    if (note) panel.appendChild(el("p", { class: "g99r-note" }, esc(note)));
    (refused || []).forEach(function (r) {
      panel.appendChild(el("div", { class: "g99r-warn" }, "Not applied — " + esc(r)));
    });
    var row = el("div", { class: "g99r-row" });
    var back = el("button", { class: "g99r-btn g99r-ghost", type: "button" }, "Keep reviewing");
    row.appendChild(back);
    panel.appendChild(row);
    back.addEventListener("click", showQueue);
    panel.classList.remove("g99r-hide");
  }

  function submit() {
    var batch = queue.slice();
    status("Sending " + batch.length + " change" + (batch.length > 1 ? "s" : "") + "…");
    api("/feedback", null, {
      method: "POST",
      body: JSON.stringify({ path: CFG.path, url: location.href, changes: batch }),
    }).then(function (d) {
      if (!d || !d.ok) return status("That could not be sent.", (d && d.error) || "Try again in a moment.");
      queue = [];
      paintLaunch();
      status("Applying " + batch.length + " change" + (batch.length > 1 ? "s" : "") + "…",
        "Usually live within a couple of minutes. You can carry on reviewing other pages.");
      watch(d.jobId);
    }).catch(function () {
      status("That could not be sent.", "The site could not reach the build tool.");
    });
  }

  function watch(jobId) {
    if (poll) clearInterval(poll);
    var tries = 0;
    poll = setInterval(function () {
      if (++tries > 90) return clearInterval(poll);
      api("/status", "job=" + encodeURIComponent(jobId)).then(function (d) {
        if (!d || !d.ok) return;
        if (d.status === "done") {
          clearInterval(poll);
          if (d.dryRun) status("Dry run — captured, nothing applied.", "The build tool is in dry-run mode, so no change was made to the site.");
          else status("Your changes are live.", "Reload the page to see them.", d.refused);
        } else if (d.status === "error" || d.status === "cancelled") {
          clearInterval(poll);
          status("That change could not be completed.", d.error || "A developer has been notified.", d.refused);
        }
      }).catch(function () {});
    }, 10000);
  }

  // ---- go ------------------------------------------------------------------
  launch.addEventListener("click", function () {
    if (panel.classList.contains("g99r-hide")) showQueue();
    else panel.classList.add("g99r-hide");
  });
  paintLaunch();
})();
