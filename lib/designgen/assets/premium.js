/* ============================================================================
   PREMIUM MOTION ENGINE — auto-enhances any generated page.
   The model writes plain semantic HTML; this script finds the structure and
   attaches the choreography, so page quality no longer depends on the model
   remembering to write motion code.
   ========================================================================== */
(function () {
  "use strict";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var vh = function () { return window.innerHeight || document.documentElement.clientHeight; };
  var seen = new WeakSet();

  /* ---------- helpers ---------- */
  function visibleArea(el) { var r = el.getBoundingClientRect(); return r.width * r.height; }
  function isHidden(el) {
    var cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  }
  // the page may ship its own reveal (opacity:0 + observer). Never double-animate.
  function alreadyAnimated(el) {
    var cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < .35) return true;
    if (cs.transitionDuration !== "0s" && /opacity|transform|all/.test(cs.transitionProperty)) return true;
    if (cs.animationName !== "none") return true;
    return false;
  }
  function tag(el, attr) { if (!el.hasAttribute(attr)) el.setAttribute(attr, ""); }

  /* ---------- 1. split the big headlines into masked, rising words ---------- */
  function splitHeadings() {
    var heads = document.querySelectorAll("h1, h2");
    for (var i = 0; i < heads.length && i < 40; i++) {
      var h = heads[i];
      if (h.querySelector("img, svg, .pm-line") || !h.textContent.trim()) continue;
      if (parseFloat(getComputedStyle(h).fontSize) < 26) continue;      // small headings stay still
      if (h.textContent.trim().length > 130) continue;                   // paragraphs-as-headings
      var frag = document.createDocumentFragment(), ok = true;
      // only split when the heading is plain text or simple inline markup
      for (var n = 0; n < h.childNodes.length; n++) {
        var node = h.childNodes[n];
        if (node.nodeType === 3) {
          var words = node.nodeValue.split(/(\s+)/);
          for (var w = 0; w < words.length; w++) {
            if (!words[w]) continue;
            if (/^\s+$/.test(words[w])) { frag.appendChild(document.createTextNode(" ")); continue; }
            var span = document.createElement("span");
            span.className = "pm-line";
            var inner = document.createElement("i");
            inner.textContent = words[w];
            span.appendChild(inner);
            frag.appendChild(span);
          }
        } else if (node.nodeType === 1 && !node.querySelector("*")) {
          frag.appendChild(node.cloneNode(true));
        } else { ok = false; break; }
      }
      if (!ok) continue;
      h.textContent = "";
      h.appendChild(frag);
      h.classList.add("pm-split");
      var parts = h.querySelectorAll(".pm-line > i");
      for (var p = 0; p < parts.length; p++) parts[p].style.setProperty("--pm-delay", (p * 55) + "ms");
    }
  }

  /* ---------- 2. mark what should reveal, and stagger siblings ---------- */
  function markReveals() {
    var sel = "section, header + div, main > div, footer";
    var blocks = document.querySelectorAll(sel);
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      if (block.closest("[data-pm-nav]")) continue;
      var kids = block.querySelectorAll(
        ":scope h1, :scope h2, :scope h3, :scope > p, :scope > * > p, :scope figure, :scope img," +
        " :scope article, :scope li, :scope [class*=card], :scope [class*=item], :scope [class*=col]," +
        " :scope [class*=box], :scope a[class*=btn], :scope > * > a"
      );
      var groups = new Map();
      for (var k = 0; k < kids.length; k++) {
        var el = kids[k];
        if (seen.has(el) || isHidden(el)) continue;
        if (el.closest("[data-pm-reveal]")) continue;          // parent already reveals
        if (visibleArea(el) < 400) continue;                    // icons, tiny bits
        if (alreadyAnimated(el)) { seen.add(el); continue; }
        seen.add(el);
        el.setAttribute("data-pm-reveal", "");
        if (el.matches("h1, h2") && el.classList.contains("pm-split")) el.classList.add("pm-split");
        var key = el.parentElement;
        if (!groups.has(key)) groups.set(key, 0);
        var idx = groups.get(key);
        groups.set(key, idx + 1);
        if (idx) el.style.setProperty("--pm-delay", Math.min(idx * 95, 620) + "ms");
      }
    }
  }

  /* ---------- 3. image treatments: hover-zoom in cards, scroll-scale in bands -- */
  function markImages() {
    var imgs = document.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i], r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 90) continue;                       // logos, icons
      if (/logo/i.test(img.className + " " + (img.alt || ""))) continue;
      var host = img.parentElement;
      if (!host || host.tagName === "BODY") continue;
      var hs = getComputedStyle(host);
      if (hs.position === "static") host.style.position = "relative";
      var clickable = !!img.closest("a, [class*=card], article, figure");
      if (clickable && r.height < vh() * .72) {
        tag(host, "data-pm-zoom");
      } else if (r.height > vh() * .38) {
        tag(host, "data-pm-scale");                                        // big editorial image
      } else {
        tag(host, "data-pm-zoom");
      }
    }
  }

  /* ---------- 4. hover states for cards, links, buttons ---------- */
  function markInteractive() {
    var cards = document.querySelectorAll("article, [class*=card], [class*=tile], [class*=service], [class*=member], [class*=team] > div, li[class]");
    for (var c = 0; c < cards.length; c++) {
      var el = cards[c];
      if (visibleArea(el) < 8000) continue;
      var cs = getComputedStyle(el);
      if (cs.borderStyle === "none" && cs.boxShadow === "none" && cs.backgroundColor === "rgba(0, 0, 0, 0)" && !el.querySelector("img")) continue;
      tag(el, "data-pm-card");
    }
    var links = document.querySelectorAll("a");
    for (var l = 0; l < links.length; l++) {
      var a = links[l], t = (a.textContent || "").trim();
      if (!t || t.length > 60) continue;
      var acs = getComputedStyle(a);
      var looksButton = acs.backgroundColor !== "rgba(0, 0, 0, 0)" || acs.borderTopWidth !== "0px" ||
        /btn|button|cta/i.test(a.className);
      if (looksButton) tag(a, "data-pm-btn");
      else if (a.closest("nav, footer, header") || acs.display === "inline") tag(a, "data-pm-link");
    }
    var btns = document.querySelectorAll("button, [role=button], input[type=submit]");
    for (var b2 = 0; b2 < btns.length; b2++) tag(btns[b2], "data-pm-btn");
  }

  /* ---------- 5. nav behaviour ---------- */
  var nav = null;
  function markNav() {
    var cands = document.querySelectorAll("header, nav, [class*=nav], [class*=header]");
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i], cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if ((cs.position === "fixed" || cs.position === "sticky") && r.top <= 4 && r.width > innerWidth * .6) { nav = el; break; }
    }
    if (!nav) { var h = document.querySelector("header"); if (h && h.getBoundingClientRect().top < 10) nav = h; }
    if (nav) nav.setAttribute("data-pm-nav", "");
  }

  /* ---------- 6. stat counters ---------- */
  function markCounters() {
    var all = document.querySelectorAll("span, div, p, h2, h3, strong, dt, dd");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length) continue;
      var t = (el.textContent || "").trim();
      var m = t.match(/^(\d{1,3}(?:,\d{3})*|\d+)([+%★]?)$/);
      if (!m) continue;
      var val = parseInt(m[1].replace(/,/g, ""), 10);
      if (!val || val < 3 || val > 100000) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 24) continue;
      el.setAttribute("data-pm-count", String(val));
      el.setAttribute("data-pm-suffix", m[2] || "");
      el.textContent = "0" + (m[2] || "");
    }
  }
  function runCounter(el) {
    var target = parseInt(el.getAttribute("data-pm-count"), 10);
    var suffix = el.getAttribute("data-pm-suffix") || "";
    var t0 = performance.now(), dur = 1500;
    (function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------- 7. observers + scroll loop ---------- */
  function start() {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("pm-in");
        if (e.target.hasAttribute("data-pm-count")) runCounter(e.target);
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: .08 });

    document.querySelectorAll("[data-pm-reveal], .pm-split, [data-pm-count]").forEach(function (el) { io.observe(el); });

    // above-the-fold content plays immediately as an entrance
    requestAnimationFrame(function () {
      document.querySelectorAll("[data-pm-reveal], .pm-split").forEach(function (el) {
        if (el.getBoundingClientRect().top < vh() * .92) el.classList.add("pm-in");
      });
    });

    // failsafe — nothing may ever stay invisible
    setTimeout(function () {
      document.querySelectorAll("[data-pm-reveal]:not(.pm-in)").forEach(function (el) {
        if (el.getBoundingClientRect().top < vh() * 1.4) el.classList.add("pm-in");
      });
    }, 2600);

    var lastY = scrollY, ticking = false;
    var scaleEls = [].slice.call(document.querySelectorAll("[data-pm-scale]"));
    var pending = [].slice.call(document.querySelectorAll("[data-pm-reveal], .pm-split"));
    function frame() {
      ticking = false;
      var y = scrollY;
      // hard guard: an observer miss must never leave content invisible. Anything
      // that has entered the viewport is revealed here regardless of the observer.
      if (pending.length) {
        for (var q = pending.length - 1; q >= 0; q--) {
          var pe = pending[q];
          if (pe.classList.contains("pm-in")) { pending.splice(q, 1); continue; }
          var pr = pe.getBoundingClientRect();
          if (pr.top < vh() * .95 && pr.bottom > 0) {
            pe.classList.add("pm-in");
            if (pe.hasAttribute("data-pm-count")) runCounter(pe);
            pending.splice(q, 1);
          }
        }
      }
      if (nav) {
        nav.classList.toggle("pm-nav-stuck", y > 40);
        if (y > 220 && y > lastY + 6) nav.classList.add("pm-nav-up");
        else if (y < lastY - 6 || y < 120) nav.classList.remove("pm-nav-up");
      }
      for (var i = 0; i < scaleEls.length; i++) {
        var el = scaleEls[i], r = el.getBoundingClientRect();
        if (r.bottom < -100 || r.top > vh() + 100) continue;
        var prog = 1 - Math.min(1, Math.max(0, (r.top + r.height) / (vh() + r.height)));
        el.style.setProperty("--pm-s", (1.16 - prog * 0.16).toFixed(4));
      }
      lastY = y;
    }
    addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
    frame();
  }

  function boot() {
    try { markNav(); } catch (e) {}
    try { splitHeadings(); } catch (e) {}
    try { markImages(); } catch (e) {}
    try { markInteractive(); } catch (e) {}
    try { markCounters(); } catch (e) {}
    try { markReveals(); } catch (e) {}
    try { start(); } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  // re-measure once webfonts and images settle (sizes drive several decisions)
  addEventListener("load", function () { setTimeout(function () { try { markImages(); } catch (e) {} }, 250); });
})();
