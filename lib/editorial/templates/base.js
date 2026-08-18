import { MOTION_CSS, MOTION_JS } from "./motion.js";

export const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const arr = (a) => (Array.isArray(a) ? a : []);
// image that removes its own container on load-error → never an empty placeholder
export const cover = (url) => (url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.closest('.card-img,.photo,.about-img,.hero-media,.showcase-img')?.remove()" />` : "");

// Shared tokens + reset + buttons. Layout-specific CSS is passed per template,
// so brand injection (:root) is identical everywhere but each design looks distinct.
export function head(k, layoutCss) {
  const t = k.theme || {};
  const b = k.brand || {};
  const fonts = t.googleFontsHref || "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Montserrat:wght@300;400;500;600&display=swap";
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(b.name || "Med Spa")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${esc(fonts)}" rel="stylesheet" />
<style>
  :root{
    --logo-fs:${(b.name || "").length > 26 ? "15px" : (b.name || "").length > 16 ? "18px" : "24px"};
    --cream:${t.cream || "#fffbf5"}; --white:${t.white || "#ffffff"}; --ink:${t.ink || "#323232"};
    --body:${t.body || "#585858"}; --line:${t.line || "#e5ddd2"}; --accent:${t.accent || "#8a7a63"};
    --serif:"${t.serifFont || "Cormorant Garamond"}", Georgia, serif;
    --sans:"${t.sansFont || "Montserrat"}", sans-serif; --wrap:1200px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:var(--sans);color:var(--body);background:var(--white);font-weight:300;line-height:1.8;font-size:15px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
  img{max-width:100%;display:block}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:var(--wrap);margin:0 auto;padding:0 28px}
  h1,h2,h3{font-family:var(--serif);color:var(--ink);font-weight:300;letter-spacing:.5px;line-height:1.1}
  .eyebrow{font-family:var(--sans);font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);font-weight:500;margin-bottom:18px}
  .btn{display:inline-block;font-family:var(--sans);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:14px 34px;border:1px solid var(--ink);color:var(--ink);background:transparent;cursor:pointer}
  .btn:hover{background:var(--ink);color:#fff}
  .btn--light{border-color:#fff;color:#fff}
  .btn--light:hover{background:#fff;color:var(--ink)}
  ${MOTION_CSS}
  ${layoutCss}
  /* g99 logo treatment (after layoutCss so it wins over each template's .logo):
     hard-LEFT in the nav, font size scaled to the name length (set as --logo-fs
     below), never wraps, and an optional icon scraped off the client's own site
     rides beside the wordmark to save the space a long name needs. */
  header .nav,.nav{min-height:78px;height:auto;flex-wrap:nowrap;gap:18px}
  .nav .logo{order:-1;margin-right:auto;text-align:left;display:flex;align-items:center;gap:10px;
    font-size:var(--logo-fs,24px);letter-spacing:1.5px;line-height:1.15;white-space:nowrap}
  .nav .logo .logo-tx{display:block;font-size:inherit;letter-spacing:inherit;white-space:nowrap}
  .nav .logo .logo-tx>span{display:block;text-align:left;white-space:normal;font-size:9px;letter-spacing:3px}
  .logo-ic{height:38px;width:auto;max-width:150px;display:block;object-fit:contain}
</style></head><body>`;
}

export const foot = () => `${MOTION_JS}</body></html>`;
