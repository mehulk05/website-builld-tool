// Growth99 review widget — loaded ONLY inside a valid review session.
// The mu-plugin does not print this file for a normal visitor, so there is no
// "am I allowed" check here: reaching this code already means the server said yes.
//
// Two modes, because two different jobs turned out to need it:
//
//   Text     select words, type the replacement. Produces an exact old -> new
//            pair, which the tool applies in code with no model involved. This
//            is the safest kind of change and stays the default.
//
//   Design   click an element, describe what should be different ("this button
//            should be rounded", "this link should go to /contact"). Produces a
//            note against that element's Elementor id, which the tool resolves
//            against the page's JSON and patches — with a model where it has to.
//
// The queue is kept in localStorage, tagged with the page each item was added
// on. That is not a nicety: these are ordinary WordPress page loads, so without
// it everything a reviewer queued was silently thrown away the moment they
// clicked through to another page — while the panel told them they could review
// as many pages as they liked.
(function () {
  "use strict";
  var CFG = window.G99_REVIEW;
  if (!CFG || !CFG.rest) return;

  var MIN = 3, MAX = 600, MAX_NOTE = 1000, MAX_ITEMS = 40;
  var STORE_KEY = "g99r.queue.v2";
  var queue = [];          // [{kind:"text"|"note", page, ...}]
  var pending = null;      // the selection currently being edited
  var picking = false;     // design mode armed
  var hovered = null;
  var poll = null;
  var lastResult = null;   // per-item outcomes from the last submission

  // ---- storage -------------------------------------------------------------
  // A reviewer's session outlives any one page, so the queue has to as well.
  // Failure here is not worth breaking the widget over — a private window with
  // storage disabled should still be able to submit the current page.
  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      queue = Array.isArray(arr) ? arr.slice(0, MAX_ITEMS) : [];
    } catch (e) { queue = []; }
  }
  function persist() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(queue.slice(0, MAX_ITEMS))); }
    catch (e) { /* storage unavailable: the session still works, it just won't survive navigation */ }
  }
  function clearStore() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ }
  }

  // ---- shell ---------------------------------------------------------------
  var css = ""
    + ".g99r-hide{display:none!important}"
    + "#g99r-chip{position:fixed;z-index:2147483000;padding:6px 12px;border-radius:999px;border:0;"
    + "background:#111;color:#fff;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28)}"
    + "#g99r-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;"
    + "padding:11px 16px;border-radius:999px;border:0;background:#111;color:#fff;cursor:pointer;"
    + "font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3)}"
    + "#g99r-launch b{background:#fff;color:#111;border-radius:999px;padding:1px 7px;font-size:12px}"
    + "#g99r-panel{position:fixed;right:20px;bottom:76px;width:380px;max-height:74vh;overflow:auto;z-index:2147483000;"
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
    + ".g99r-where{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.04em}"
    + ".g99r-pagehead{margin:14px 0 2px;font-size:12px;font-weight:700;color:#111;border-bottom:1px solid #111;padding-bottom:3px}"
    + ".g99r-pagehead:first-of-type{margin-top:6px}"
    + ".g99r-warn{background:#fff6e5;color:#7a4b00;border-radius:8px;padding:8px;font-size:12px;margin-top:10px}"
    + ".g99r-note{color:#666;font-size:12px;margin-top:10px}"
    + ".g99r-modes{display:flex;gap:6px;margin-bottom:10px}"
    + ".g99r-mode{flex:1;border:1px solid #ddd;background:#fff;border-radius:8px;padding:7px;cursor:pointer;"
    + "font:600 12px system-ui,sans-serif;color:#444}"
    + ".g99r-mode.on{background:#111;color:#fff;border-color:#111}"
    + ".g99r-ok{color:#136c2e}.g99r-bad{color:#9b1c1c}"
    + ".g99r-scope{display:flex;flex-direction:column;gap:5px;margin-top:8px}"
    + ".g99r-scope label{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;margin:0;cursor:pointer}"
    + ".g99r-scope input{margin:0}"
    + ".g99r-drop{border:1px dashed #c8c8c8;border-radius:9px;padding:12px;text-align:center;font-size:12px;color:#666;cursor:pointer;margin-top:8px}"
    + ".g99r-drop.on{border-color:#2f6df6;color:#2f6df6}"
    + ".g99r-thumb{max-width:100%;max-height:120px;border-radius:7px;margin-top:8px;display:block}"
    // The picker's own highlight. outline rather than border so nothing reflows
    // under the cursor while the reviewer is aiming at it.
    + ".g99r-target{outline:2px solid #2f6df6!important;outline-offset:-2px!important;cursor:crosshair!important}"
    + "#g99r-hint button{border:0;background:rgba(255,255,255,.22);color:#fff;border-radius:999px;"
    + "padding:3px 10px;font:600 12px system-ui,sans-serif;cursor:pointer;margin:0 2px}"
    + "#g99r-hint{position:fixed;left:50%;transform:translateX(-50%);top:16px;z-index:2147483000;"
    + "background:#111;color:#fff;padding:8px 14px;border-radius:999px;font:600 12px system-ui,sans-serif;"
    + "box-shadow:0 6px 20px rgba(0,0,0,.3)}";
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
  var hint = el("div", { id: "g99r-hint", class: "g99r-hide" },
    "Click anything you want changed · <button type=\"button\" id=\"g99r-hint-list\">see list</button> · Esc to stop");
  document.body.appendChild(launch);
  document.body.appendChild(panel);
  document.body.appendChild(chip);
  document.body.appendChild(hint);

  // The floating control is a MODE TOGGLE, not a menu. Leaving the first note
  // used to take three clicks — open the panel, choose "pick an element", then
  // click the thing — which is two too many for the job it does. Now: one click
  // turns commenting on, and every click after that is a note. Clicking it again
  // gives the page back so the reviewer can navigate normally.
  function paintLaunch() {
    launch.innerHTML = (picking ? "● Commenting" : "✎ Comment")
      + (queue.length ? " <b>" + queue.length + "</b>" : "");
    launch.style.background = picking ? "#2f6df6" : "#111";
  }

  function ours(node) {
    while (node) {
      if (node.id === "g99r-panel" || node.id === "g99r-launch" || node.id === "g99r-chip" || node.id === "g99r-hint") return true;
      node = node.parentNode;
    }
    return false;
  }

  // ---- text mode -----------------------------------------------------------
  // Refuses a selection that spans elements. The tool matches the original
  // string against the page template character-for-character, and a selection
  // crossing a tag boundary produces a string that exists on screen but not in
  // the source — so it would silently match nothing.
  document.addEventListener("mouseup", function (e) {
    if (picking || ours(e.target)) return;
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
    if (pending) openTextEditor(pending);
  });

  // How many times this exact text appears in the visible page. More than one
  // means the swap will hit every copy, which is worth saying before they submit
  // rather than explaining afterwards.
  // Which copy of a repeated phrase the reviewer highlighted, counting in
  // document order. Returns 0 when it cannot be worked out — the caller then
  // does not offer "only this one" at all, rather than aiming at a guess.
  function occurrenceIndexOf(sel) {
    try {
      var s = window.getSelection();
      if (!s || !s.rangeCount) return 0;
      var range = s.getRangeAt(0);
      var before = document.createRange();
      before.setStart(document.body, 0);
      before.setEnd(range.startContainer, range.startOffset);
      var head = before.toString().replace(/\s+/g, " ");
      // Same basis as occurrences(): raw DOM text, whitespace-collapsed.
      var needle = sel.text;
      var n = 0, i = 0;
      while ((i = head.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
      return n + 1;
    } catch (e) { return 0; }
  }

  function occurrences(text) {
    var body = pageText();
    var n = 0, i = 0;
    while ((i = body.indexOf(text, i)) !== -1) { n++; i += text.length; }
    return n;
  }

  // The page's text as the DOM holds it, which is NOT innerText: a nav styled
  // with text-transform renders "CONTACT" while the markup says "Contact", so
  // counting one way and indexing the other disagreed — the panel said a phrase
  // appeared twice and then offered to change "#3" of them. The source is what
  // the tool matches against, so raw DOM text is the basis for both.
  function pageText() {
    try {
      var r = document.createRange();
      r.selectNodeContents(document.body);
      return r.toString().replace(/\s+/g, " ");
    } catch (e) { return document.body.innerText.replace(/\s+/g, " "); }
  }

  // ---- design mode ---------------------------------------------------------
  // The nearest ancestor carrying an Elementor element id. That id is the whole
  // basis of the design loop: it is in the rendered DOM and in the page's
  // Elementor JSON, so the tool can find the exact node without guessing from
  // a selector or a coordinate.
  function elementorTarget(node) {
    while (node && node !== document.body) {
      if (node.classList) {
        for (var i = 0; i < node.classList.length; i++) {
          var m = /^elementor-element-([A-Za-z0-9_-]{4,32})$/.exec(node.classList[i]);
          if (m) return { node: node, id: m[1] };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // Where the clicked node sits inside its section, as child indexes. Lets the
  // tool tell one of four identical buttons from the others without trusting a
  // selector the page could have changed under it.
  function childPath(from, to) {
    var out = [], n = from;
    while (n && n !== to && out.length < 24) {
      var p = n.parentElement;
      if (!p) break;
      out.unshift(Array.prototype.indexOf.call(p.children, n));
      n = p;
    }
    return out;
  }

  function describe(node, sectionNode) {
    var attrs = {};
    ["href", "src", "alt", "type", "id"].forEach(function (a) {
      var v = node.getAttribute && node.getAttribute(a);
      if (v) attrs[a] = String(v).slice(0, 200);
    });
    var cls = (node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className) || "";
    if (cls) attrs["class"] = String(cls).slice(0, 200);
    var r = node.getBoundingClientRect();
    return {
      tag: (node.tagName || "").toLowerCase(),
      text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      attrs: attrs,
      childPath: childPath(node, sectionNode),
      rect: { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function setPicking(on) {
    picking = on;
    hint.classList.toggle("g99r-hide", !on);
    if (!on && hovered) { hovered.classList.remove("g99r-target"); hovered = null; }
    if (on) panel.classList.add("g99r-hide");
    paintLaunch();
  }

  document.addEventListener("mousemove", function (e) {
    if (!picking || ours(e.target)) return;
    var hit = elementorTarget(e.target);
    var node = hit ? hit.node : null;
    if (node === hovered) return;
    if (hovered) hovered.classList.remove("g99r-target");
    hovered = node;
    if (hovered) hovered.classList.add("g99r-target");
  }, true);

  document.addEventListener("click", function (e) {
    if (!picking || ours(e.target)) return;
    var hit = elementorTarget(e.target);
    // Stop the click reaching the page: a reviewer aiming at a nav link would
    // otherwise navigate away mid-annotation and lose their aim, not their queue.
    e.preventDefault();
    e.stopPropagation();
    if (!hit) return;
    setPicking(false);
    openNoteEditor(hit.id, describe(e.target, hit.node), hit.node);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && picking) { setPicking(false); showQueue(); }
  });

  // ---- editors -------------------------------------------------------------
  function openTextEditor(sel) {
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
    // two. Selecting one line at a time always matches.
    if (sel.split) {
      panel.appendChild(el("div", { class: "g99r-warn" },
        "This selection runs across a line break, so it does not exist as one piece in the page. "
        + "Change one line at a time and it will be applied exactly."));
    }
    // More than one copy on the page is a decision, not a warning. Replacing
    // every one is right for a phone number and wrong for a heading that happens
    // to repeat, and only the person reading the page knows which this is.
    var scopeAll = true, nth = 1;
    if (many > 1) {
      nth = occurrenceIndexOf(sel);
      var box = el("div", { class: "g99r-warn" });
      box.appendChild(el("div", null,
        "This exact text appears <b>" + many + "</b> times on this page."));
      var pick = el("div", { class: "g99r-scope" });
      var rAll = el("label", null,
        '<input type="radio" name="g99r-scope" value="all" checked> Change all ' + many);
      var rOne = el("label", null,
        '<input type="radio" name="g99r-scope" value="one"> Only the one I selected'
        + (nth ? " (#" + nth + ")" : ""));
      pick.appendChild(rAll); pick.appendChild(rOne);
      box.appendChild(pick);
      panel.appendChild(box);
      pick.addEventListener("change", function (e) { scopeAll = e.target.value === "all"; });
      // Without a reliable index there is nothing to aim "only this one" at, so
      // the choice is not offered rather than offered and quietly wrong.
      if (!nth) { rOne.style.display = "none"; }
    }
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
      if (!v || v === sel.text) return next.focus();
      queue.push({
        kind: "text", page: CFG.path, original: sel.text, replacement: v,
        // Only sent when the reviewer actually chose; absent means "all", which
        // is what every earlier version did.
        scope: many > 1 && !scopeAll ? "one" : "all",
        nth: many > 1 && !scopeAll ? nth : 0,
        occurrences: many,
      });
      pending = null;
      persist(); paintLaunch(); showQueue();
    });
  }

  function openNoteEditor(elementId, target, node) {
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "What should be different here?"));
    panel.appendChild(el("p", { class: "g99r-sub" }, esc(CFG.reviewer) + " · " + esc(CFG.path)));

    var what = target.tag ? "<" + esc(target.tag) + ">" : "this element";
    panel.appendChild(el("div", { class: "g99r-where" },
      "Selected: " + what + (target.text ? " · " + esc(clip(target.text, 60)) : "")));

    var note = el("textarea", { rows: "4", placeholder: "e.g. make this button rounded, or point this link at /contact" });
    panel.appendChild(note);

    // Picture swap. Offered on an image, or on anything containing one — a
    // reviewer aiming at a hero usually hits the section, not the <img>.
    var innerImg = node && node.tagName === "IMG" ? node : (node && node.querySelector ? node.querySelector("img") : null);
    var picked = null;
    if (innerImg) {
      panel.appendChild(el("label", null, "Replace the picture (optional)"));
      var drop = el("div", { class: "g99r-drop" }, "Choose an image from your computer");
      var file = el("input", { type: "file", accept: "image/*", style: "display:none" });
      var thumb = el("img", { class: "g99r-thumb g99r-hide" });
      panel.appendChild(drop); panel.appendChild(file); panel.appendChild(thumb);
      drop.addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        if (!f) return;
        drop.textContent = "Reading " + f.name + "…";
        shrink(f, function (dataUrl, err) {
          if (err) { drop.textContent = "That file could not be read — try a PNG or JPEG"; return; }
          picked = { dataUrl: dataUrl, filename: f.name };
          thumb.setAttribute("src", dataUrl);
          thumb.classList.remove("g99r-hide");
          drop.textContent = f.name + " — click to choose a different one";
          drop.className = "g99r-drop on";
        });
      });
    }

    panel.appendChild(el("p", { class: "g99r-note" },
      "Say what you want changed, not how to code it. One thing per note reads best."));

    var row = el("div", { class: "g99r-row" });
    var add = el("button", { class: "g99r-btn g99r-primary", type: "button" }, "Add note");
    var again = el("button", { class: "g99r-btn g99r-ghost", type: "button" }, "Pick another");
    var cancel = el("button", { class: "g99r-btn g99r-ghost", type: "button" }, "Cancel");
    row.appendChild(add); row.appendChild(again); row.appendChild(cancel);
    panel.appendChild(row);
    panel.classList.remove("g99r-hide");
    note.focus();

    function save() {
      var v = note.value.trim().slice(0, MAX_NOTE);
      // A replacement picture IS the instruction; making them also type
      // "change this image" would be busywork.
      if (!v && picked) v = "Replace this image with the one attached.";
      if (!v) { note.focus(); return false; }
      if (queue.length >= MAX_ITEMS) {
        panel.appendChild(el("div", { class: "g99r-warn" }, "That is as many as one submission can carry. Send these first."));
        return false;
      }
      queue.push({
        kind: "note", page: CFG.path, elementId: elementId, note: v, target: target,
        image: picked || null,
      });
      persist(); paintLaunch();
      return true;
    }
    cancel.addEventListener("click", showQueue);
    add.addEventListener("click", function () { if (save()) showQueue(); });
    again.addEventListener("click", function () { if (save()) setPicking(true); });
  }

  // Downscale in the browser before anything is sent. The upload travels inside
  // the feedback batch, through a WordPress REST proxy with a 20s timeout, so a
  // 12MP phone photo would simply never arrive. 1600px wide is more than any of
  // these layouts renders at.
  function shrink(fileObj, done) {
    var MAXW = 1600, MAXH = 1600;
    var reader = new FileReader();
    reader.onerror = function () { done(null, "read failed"); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { done(null, "not an image"); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAXW / w, MAXH / h);
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        try {
          var cv = document.createElement("canvas");
          cv.width = cw; cv.height = ch;
          cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
          // JPEG unless it might need transparency; a PNG photo is needlessly huge.
          var isPng = /\.png$/i.test(fileObj.name || "");
          done(cv.toDataURL(isPng ? "image/png" : "image/jpeg", 0.85));
        } catch (e) { done(null, "could not be resized"); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(fileObj);
  }

  // ---- the queue -----------------------------------------------------------
  function pageGroups() {
    var order = [], byPage = {};
    queue.forEach(function (c, i) {
      var p = c.page || "/";
      if (!byPage[p]) { byPage[p] = []; order.push(p); }
      byPage[p].push({ item: c, index: i });
    });
    return order.map(function (p) { return { page: p, rows: byPage[p] }; });
  }

  function itemLine(row) {
    var c = row.item;
    var body;
    if (c.kind === "text") {
      body = "<del>" + esc(clip(c.original, 80)) + "</del><br><ins>" + esc(clip(c.replacement, 80)) + "</ins>";
    } else {
      var t = c.target || {};
      var where = (t.tag ? "&lt;" + esc(t.tag) + "&gt;" : "section")
        + (t.text ? " · " + esc(clip(t.text, 40)) : "")
        + (c.image ? " · 🖼 image attached" : "");
      body = '<div class="g99r-where">' + where + "</div>" + esc(clip(c.note, 120));
    }
    return el("div", { class: "g99r-item" },
      '<button type="button" title="Remove" data-i="' + row.index + '">&times;</button>' + body);
  }

  function showQueue() {
    setPicking(false);
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "Review"));
    panel.appendChild(el("p", { class: "g99r-sub" }, esc(CFG.reviewer) + " · " + esc(CFG.path)));

    var modes = el("div", { class: "g99r-modes" });
    var mPick = el("button", { class: "g99r-mode", type: "button" }, "＋ Comment on something");
    modes.appendChild(mPick);
    panel.appendChild(modes);
    mPick.addEventListener("click", function () { setPicking(true); });

    if (!queue.length) {
      panel.appendChild(el("p", { class: "g99r-note" },
        "Hit <b>Comment</b> (bottom right), then click anything on the page to say what should be "
        + "different about it. To correct exact wording instead, just select the text. "
        + "Add as many as you like across as many pages as you like — they are kept until you send them."));
    } else {
      var groups = pageGroups();
      groups.forEach(function (g) {
        panel.appendChild(el("div", { class: "g99r-pagehead" },
          esc(g.page) + " · " + g.rows.length + (g.rows.length > 1 ? " items" : " item")));
        g.rows.forEach(function (row) { panel.appendChild(itemLine(row)); });
      });
      panel.addEventListener("click", onRemove);

      var row = el("div", { class: "g99r-row" });
      var label = groups.length > 1
        ? "Apply " + queue.length + " changes across " + groups.length + " pages"
        : "Apply " + queue.length + " change" + (queue.length > 1 ? "s" : "");
      var apply = el("button", { class: "g99r-btn g99r-primary", type: "button" }, label);
      var clear = el("button", { class: "g99r-btn g99r-ghost", type: "button" }, "Clear");
      row.appendChild(apply); row.appendChild(clear);
      panel.appendChild(row);
      panel.appendChild(el("p", { class: "g99r-note" },
        "They go live automatically. You do not need to stay on this page."));
      apply.addEventListener("click", submit);
      clear.addEventListener("click", function () {
        queue = []; clearStore(); paintLaunch(); showQueue();
      });
    }

    if (lastResult) {
      panel.appendChild(el("div", { class: "g99r-pagehead" }, "Last submission"));
      lastResult.forEach(function (r) {
        panel.appendChild(el("div", { class: "g99r-item" },
          '<span class="' + (r.ok ? "g99r-ok" : "g99r-bad") + '">' + (r.ok ? "✓" : "✕") + "</span> "
          + esc(clip(r.what || "", 70)) + (r.detail ? '<div class="g99r-note">' + esc(clip(r.detail, 110)) + "</div>" : "")));
      });
    }
    panel.classList.remove("g99r-hide");
  }

  function onRemove(e) {
    var t = e.target;
    if (t.tagName !== "BUTTON" || !t.hasAttribute("data-i")) return;
    queue.splice(Number(t.getAttribute("data-i")), 1);
    persist(); paintLaunch(); showQueue();
  }

  // ---- submit --------------------------------------------------------------
  // `query` is kept separate rather than baked into `route` on purpose. A site
  // without pretty permalinks gets rest_url() = ".../index.php?rest_route=/g99/v1",
  // so a route ending in "?job=1" would make the job id part of the route name
  // and arrive as no parameter at all.
  // Two transports, chosen by whether the page gave us a token.
  //
  // Without one (CFG.token unset) we are inside the WordPress mu-plugin: the
  // browser holds an HttpOnly session cookie, talks only to this site, and the
  // site forwards to the build tool. Cookies must ride along, hence
  // "same-origin", and the nonce proves the request came from this page.
  //
  // With one we are on a GitOps site, delivered as a WPCode snippet with no PHP
  // anywhere. There is no cookie and no proxy — the widget calls the build tool
  // directly, cross-origin, and the token IS the credential. Cookies are then
  // actively unwanted: sending them would ask the browser for a credentialed
  // CORS request, which the tool must answer with an exact origin and
  // Allow-Credentials, widening the surface for no gain. "omit" keeps the
  // request simple and the token the only thing being trusted.
  function api(route, query, opts) {
    opts = opts || {};
    opts.credentials = CFG.token ? "omit" : "same-origin";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    // A free ngrok tunnel answers a browser's first request with its own HTML
    // interstitial, which arrives here as unparseable JSON and looks exactly
    // like the build tool being broken. This header is that tunnel's documented
    // opt-out. It means nothing to any other host, so it is sent always rather
    // than guessed at from the URL.
    if (CFG.token) opts.headers["ngrok-skip-browser-warning"] = "1";
    if (CFG.nonce) opts.headers["X-WP-Nonce"] = CFG.nonce;
    var url = CFG.rest + route;
    if (query) url += (url.indexOf("?") > -1 ? "&" : "?") + query;
    // GET routes read the token from the query; POST bodies carry it themselves.
    if (CFG.token && opts.method !== "POST") {
      url += (url.indexOf("?") > -1 ? "&" : "?") + "t=" + encodeURIComponent(CFG.token);
    }
    return fetch(url, opts).then(function (r) { return r.json(); });
  }

  function status(msg, note, refused) {
    panel.innerHTML = "";
    panel.appendChild(el("h4", null, "Review"));
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

  // One key per submission attempt. The WordPress proxy in front of this gives
  // up long before a build finishes, so a reviewer whose first attempt appears
  // to time out will press the button again — and without this the tool would
  // open a second pull request for work already under way.
  function newKey() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  var submitKey = null;

  function submit() {
    var batch = queue.slice();
    if (!batch.length) return;
    if (!submitKey) submitKey = newKey();
    var texts = batch.filter(function (c) { return c.kind === "text"; });
    var notes = batch.filter(function (c) { return c.kind === "note"; });

    status("Sending " + batch.length + " change" + (batch.length > 1 ? "s" : "") + "…");
    api("/feedback", null, {
      method: "POST",
      body: JSON.stringify({
        path: CFG.path, url: location.href, key: submitKey,
        // Only set on the direct (GitOps/WPCode) transport. Through the
        // WordPress proxy the token never reaches JavaScript — the plugin adds
        // it server-side from the session — so this stays undefined and is
        // dropped by JSON.stringify.
        token: CFG.token || undefined,
        // Both lists carry their own page, so one submission can span pages.
        changes: texts.map(function (c) {
          return { original: c.original, replacement: c.replacement, page: c.page || "/" };
        }),
        notes: notes.map(function (c) {
          return {
            elementId: c.elementId, note: c.note, target: c.target, page: c.page || "/",
            image: c.image ? { dataUrl: c.image.dataUrl, filename: c.image.filename } : null,
          };
        }),
      }),
    }).then(function (d) {
      if (!d || !d.ok) return status("That could not be sent.", (d && d.error) || "Try again in a moment.");
      queue = []; clearStore(); submitKey = null;
      paintLaunch();
      status("Implementing now — 0/7",
        "Usually live within a couple of minutes. You can carry on reviewing other pages.");
      watch(d.jobId);
    }).catch(function () {
      status("That could not be sent.", "The site could not reach the build tool.");
    });
  }

  function watch(jobId) {
    if (poll) clearInterval(poll);
    var tries = 0;
    // Consecutive answers we could not read. A blip on one poll means nothing —
    // the next one is 4s away — but a job the tool cannot find will never
    // resolve, and reading that as "keep waiting" leaves the panel on
    // "Applying…" forever. It happens for real: the tool's job list does not
    // survive a redeploy, so a run in flight when one lands is unfindable.
    var misses = 0;
    poll = setInterval(function () {
      if (++tries > 150) {
        clearInterval(poll);
        return status("Still working on it.", "This is taking longer than usual. Reload the page in a few minutes to see if it landed.");
      }
      api("/status", "job=" + encodeURIComponent(jobId)).then(function (d) {
        if (!d || !d.ok) {
          if (++misses < 4) return;
          clearInterval(poll);
          return status("Could not follow this change.", "It may still be applying. Reload the page in a minute to see if it landed.");
        }
        misses = 0;
        if (Array.isArray(d.items)) lastResult = d.items;
        if (d.status === "done") {
          clearInterval(poll);
          if (d.dryRun) status("Dry run — captured, nothing applied.", "The build tool is in dry-run mode, so no change was made to the site.");
          else status("Your changes are live.", "Refresh the page to see them.", d.refused);
        } else if (d.status === "error" || d.status === "cancelled") {
          clearInterval(poll);
          status("That change could not be completed.", d.error || "A developer has been notified.", d.refused);
        } else if (d.steps && d.steps.total) {
          status("Implementing now — " + d.steps.done + "/" + d.steps.total, d.steps.label || "");
        }
      }).catch(function () {
        if (++misses >= 4) { clearInterval(poll); status("Could not follow this change.", "It may still be applying. Reload the page in a minute to see if it landed."); }
      });
    }, 4000);
  }

  // ---- go ------------------------------------------------------------------
  launch.addEventListener("click", function () {
    // One click in: commenting is on and the picker is live. One click out: the
    // page behaves normally again, so a reviewer can follow a link to the next
    // page without turning anything off first.
    if (picking) { setPicking(false); showQueue(); }
    else { panel.classList.add("g99r-hide"); setPicking(true); }
  });
  hint.addEventListener("click", function (e) {
    if (e.target && e.target.id === "g99r-hint-list") { setPicking(false); showQueue(); }
  });
  load();
  paintLaunch();
})();
