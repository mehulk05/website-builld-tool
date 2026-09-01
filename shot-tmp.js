const { chromium } = require("playwright");
(async () => {
  const tag = process.argv[2] || "before";
  const b = await chromium.launch();
  for (const [name, url] of [["home","/"],["services","/services/"],["about","/about/"],["contact","/contact/"]]) {
    const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    await p.goto("https://nuvoaestheticsclinic.gogroth.com" + url + "?g99=" + Date.now(), { waitUntil: "networkidle", timeout: 60000 }).catch(()=>{});
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${process.env.SHOTDIR}/${tag}-${name}.png`, fullPage: true });
    await p.close();
    console.log("shot", tag, name);
  }
  await b.close();
})();
