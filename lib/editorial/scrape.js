import { chromium } from "playwright";

// Deterministic scrape. No AI here. Grabs ground truth: palette, fonts,
// images, and a structured text dump the AI step will classify + rewrite.
export async function scrape(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500); // let lazy stuff settle

  // auto-scroll to trigger lazy-loaded images; step small, dwell, then settle.
  // re-measures height each step because content grows as it loads.
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await sleep(220);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(400);
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const data = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };

    // ---- palette: frequency-count real colors ----
    const colorCount = {};
    const bump = (c) => {
      if (!c || c === "transparent" || c.includes("rgba(0, 0, 0, 0)")) return;
      colorCount[c] = (colorCount[c] || 0) + 1;
    };
    document.querySelectorAll("*").forEach((el) => {
      const s = getComputedStyle(el);
      bump(s.color);
      bump(s.backgroundColor);
    });
    const palette = Object.entries(colorCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([c]) => c);

    // ---- fonts: heading vs body ----
    const fontOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fontFamily : null;
    };
    const fonts = {
      heading: fontOf("h1") || fontOf("h2") || fontOf("h3"),
      body: getComputedStyle(document.body).fontFamily,
    };

    // ---- images: capture src + alt + size, filter junk ----
    // alt text is what lets the AI match an image to the right content
    // (e.g. a provider portrait whose alt is the person's name).
    const imgs = [];
    const seen = new Set();
    const isJunk = (u) => /logo|icon|sprite|favicon|pixel|badge|\.svg($|\?)/i.test(u);
    // classify so the AI never puts a background texture where a person should be
    const DECOR = /(^|[-_/])(bg|background|texture|pattern|marble|swirl|gradient|banner-?bg|hero-?bg|overlay|backdrop)([-_.\d]|$)/i;
    const PORTRAIT_HINT = /(headshot|portrait|team|staff|provider|-dr-|profile)/i;
    const kindOf = (src, alt, w, h, fromBg) => {
      if (DECOR.test(src)) return "decorative";
      const name = /^[A-Z][a-z]+ [A-Z][a-z']+/.test(alt); // "Jane Doe …"
      if (PORTRAIT_HINT.test(src) || name || (h > w && h > 0 && alt)) return "portrait";
      return "photo";
    };
    const push = (src, alt, w, h, fromBg = false) => {
      if (!src || src.startsWith("data:")) return;
      const a = abs(src);
      if (!a || seen.has(a) || isJunk(a)) return;
      seen.add(a);
      alt = (alt || "").trim().slice(0, 120);
      imgs.push({ src: a, alt, w: w || 0, h: h || 0, kind: kindOf(a, alt, w || 0, h || 0, fromBg) });
    };
    const bestSrc = (i) => {
      // prefer real src; fall back to common lazy-load attributes
      const lazy = i.getAttribute("data-src") || i.getAttribute("data-lazy-src") || i.getAttribute("data-original") || "";
      const set = (i.getAttribute("srcset") || i.getAttribute("data-srcset") || "").split(",")[0].trim().split(" ")[0];
      const s = i.currentSrc || i.src || "";
      // ignore inline placeholders / 1px spacers
      return (s && !s.startsWith("data:") ? s : "") || lazy || set;
    };
    document.querySelectorAll("img").forEach((i) => {
      const w = i.naturalWidth || i.width, h = i.naturalHeight || i.height;
      if (w && h && (w < 100 || h < 100)) return; // skip icons/thumbs
      push(bestSrc(i), i.alt, w, h);
    });
    document.querySelectorAll("*").forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) push(m[1], el.getAttribute("aria-label") || "", 0, 0, true);
    });

    // ---- logo guess (kept out of the content image pool above) ----
    let logo = null;
    document.querySelectorAll("img").forEach((i) => {
      const hay = ((i.src || "") + " " + (i.alt || "")).toLowerCase();
      if (!logo && hay.includes("logo")) logo = abs(i.currentSrc || i.src);
    });

    // ---- structured text dump for AI classification ----
    const blocks = [];
    document.querySelectorAll("h1,h2,h3,h4,p,li,a").forEach((el) => {
      const t = el.innerText.trim().replace(/\s+/g, " ");
      if (t.length > 1 && t.length < 400) blocks.push(`[${el.tagName}] ${t}`);
    });

    return {
      title: document.title,
      metaDesc: document.querySelector('meta[name="description"]')?.content || "",
      palette,
      fonts,
      images: imgs.slice(0, 60),
      logo,
      text: blocks.slice(0, 300).join("\n"),
    };
  });

  const screenshot = await page.screenshot({ fullPage: false }); // buffer, for AI vision
  await browser.close();
  return { url, ...data, screenshotB64: screenshot.toString("base64") };
}
