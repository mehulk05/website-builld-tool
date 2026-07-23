// Shared left-rail navigation — injected on every tool page (one source of truth).
(function () {
  "use strict";
  const path = location.pathname;
  const items = [
    { href: "/dashboard", label: "Build", icon: "🚀" },
    { href: "/jobs", label: "Jobs", icon: "📊" },
    { href: "/edit", label: "Edit sites", icon: "✏️" },
  ];
  const on = (h) => path === h || path.startsWith(h + "?") || (h !== "/" && path.startsWith(h));
  const css = `
    :root{--g99nav-w:214px}
    body{padding-left:var(--g99nav-w)}
    .g99nav{position:fixed;left:0;top:0;bottom:0;width:var(--g99nav-w);background:var(--panel,#fff);border-right:1px solid var(--line,#e6e8f0);padding:20px 14px;display:flex;flex-direction:column;gap:4px;z-index:60}
    .g99nav .brand{display:flex;align-items:center;gap:10px;margin:0 6px 18px}
    .g99nav .brand .lg{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent,#6d4e8c),var(--accent-2,#8a6bb0));color:#fff;display:grid;place-items:center;font-weight:800;font-size:17px}
    .g99nav .brand b{font-size:14px;color:var(--ink,#1c1d29)}.g99nav .brand small{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#6b6f82)}
    .g99nav a{display:flex;align-items:center;gap:11px;padding:10px 13px;border-radius:10px;text-decoration:none;color:var(--muted,#6b6f82);font-size:14px;font-weight:600;transition:.12s}
    .g99nav a:hover{background:rgba(109,78,140,.08);color:var(--ink,#1c1d29)}
    .g99nav a.on{background:linear-gradient(135deg,var(--accent,#6d4e8c),var(--accent-2,#8a6bb0));color:#fff}
    .g99nav .sp{flex:1}
    .g99nav .foot{font-size:11px;color:var(--muted,#6b6f82);padding:0 8px}
    @media(max-width:760px){body{padding-left:0}.g99nav{position:static;width:auto;flex-direction:row;flex-wrap:wrap;bottom:auto;border-right:none;border-bottom:1px solid var(--line,#e6e8f0);padding:10px}.g99nav .brand{margin-bottom:0}.g99nav .sp,.g99nav .foot{display:none}}
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const aside = document.createElement("aside"); aside.className = "g99nav";
  aside.innerHTML =
    `<div class="brand"><span class="lg">g</span><div><b>Growth99</b><small>Site Builder</small></div></div>` +
    items.map((i) => `<a href="${i.href}" class="${on(i.href) ? "on" : ""}"><span>${i.icon}</span>${i.label}</a>`).join("") +
    `<div class="sp"></div><div class="foot">beta · internal</div>`;
  document.body.insertBefore(aside, document.body.firstChild);
})();
