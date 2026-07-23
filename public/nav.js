// Shared left-rail navigation — injected on every tool page (one source of truth).
(function () {
  "use strict";
  const path = location.pathname;
  const items = [
    { href: "/dashboard", label: "Build Site", icon: `<svg style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>` },
    { href: "/jobs", label: "Job Logs", icon: `<svg style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>` },
    { href: "/edit", label: "Edit Sites", icon: `<svg style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>` },
  ];
  const on = (h) => path === h || path.startsWith(h + "?") || (h !== "/" && path.startsWith(h));
  const css = `
    :root{--g99nav-w:224px}
    body{padding-left:var(--g99nav-w); background:transparent;}

    .g99nav {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--g99nav-w);
      background: var(--panel);
      border-right: 1px solid var(--line);
      padding: 22px 14px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      z-index: 60;
      font-family: var(--sans);
    }

    .g99nav .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 8px 22px;
    }

    .g99nav .brand .lg {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: var(--primary);
      color: var(--primary-ink);
      display: grid;
      place-items: center;
      font-family: var(--display);
      font-weight: 800;
      font-size: 14px;
    }

    .g99nav .brand b {
      font-family: var(--display);
      font-size: 15px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.02em;
    }

    /* Nav Links */
    .g99nav a {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 8px;
      text-decoration: none;
      color: var(--ink-2);
      font-size: 13.5px;
      font-weight: 600;
      transition: background .12s ease, color .12s ease;
    }

    .g99nav a svg { color: var(--muted); transition: color .12s ease; }
    .g99nav a:hover {
      background: var(--line-2);
      color: var(--ink);
    }
    .g99nav a:hover svg { color: var(--ink-2); }

    .g99nav a.on {
      background: var(--primary);
      color: var(--primary-ink);
    }
    .g99nav a.on svg { color: var(--primary-ink); }

    .g99nav .sp {
      flex: 1;
    }

    .g99nav .foot {
      font-size: 10.5px;
      color: var(--muted);
      padding: 0 10px;
      font-weight: 600;
      letter-spacing: .02em;
    }

    @media(max-width:760px){
      body{padding-left:0}
      .g99nav{
        position:static;
        width:auto;
        flex-direction:row;
        flex-wrap:wrap;
        bottom:auto;
        border-right:none;
        border-bottom:1px solid var(--line);
        padding:10px 14px;
      }
      .g99nav .brand{margin-bottom:0}
      .g99nav .sp, .g99nav .foot{display:none}
    }
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const aside = document.createElement("aside"); aside.className = "g99nav";
  aside.innerHTML = `
    <div class="brand">
      <span class="lg">g</span>
      <div><b>Growth99</b></div>
    </div>
    ${items.map((i) => `<a href="${i.href}" class="${on(i.href) ? "on" : ""}"><span>${i.icon}</span>${i.label}</a>`).join("")}
    <div class="sp"></div>
    <div class="foot">Internal Beta</div>
  `;
  document.body.insertBefore(aside, document.body.firstChild);
})();
