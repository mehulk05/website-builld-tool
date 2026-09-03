// Can the designgen engine read a reference site that refuses a plain fetch?
//
// The bug: the scrape announced itself as "Mozilla/5.0 DesignGen" with none of
// the headers a browser sends alongside its UA. Cloudflare tolerated that from
// a laptop and answered 403 from the deployed tool's datacenter IP — so a job
// that built fine locally died at step 3 on Render, on the same site.
//
// Two things have to hold:
//   1. real browser headers go out on every request aimed at a client's site,
//      including the ones whose failures used to be swallowed (stylesheets for
//      the palette, image validation) — those failed silently, which is worse
//      than failing loudly;
//   2. when the direct fetch IS refused, the HTML still arrives, through the
//      browser the engine was going to launch anyway.
//
// Test 2 needs the network and a browser, so it is skipped unless
// DESIGNGEN_FETCH_LIVE=1. Everything else runs offline.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const DG = require("./lib/designgen");

let pass = 0, fail = 0, skip = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) {
    if (e && e.skip) { console.log(`  skip ${name} — ${e.message}`); skip++; return; }
    console.log(`  FAIL ${name}\n       ${e.message}`); fail++;
  }
};
const skipUnless = (cond, why) => { if (!cond) { const e = new Error(why); e.skip = true; throw e; } };

const SRC = fs.readFileSync(path.join(__dirname, "lib", "designgen", "index.js"), "utf8");

(async () => {

console.log("\nheaders");

await t("the bot User-Agent is gone from every request", () => {
  // The comment explaining the fix names the old UA on purpose; only real code
  // counts.
  const lines = SRC.split("\n")
    .filter((l) => l.includes('"Mozilla/5.0 DesignGen"'))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.deepStrictEqual(lines, [], "still sending the old UA:\n" + lines.join("\n"));
});

await t("the UA is a real Chrome, with the headers that accompany one", () => {
  const H = DG.BROWSER_HEADERS;
  assert.match(H["User-Agent"], /^Mozilla\/5\.0 \(.+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/[\d.]+$/);
  // A UA with no companions is itself the bot signal — these are what make it
  // look like a navigation rather than a script.
  for (const h of ["Accept", "Accept-Language", "Sec-Fetch-Mode", "Upgrade-Insecure-Requests"]) {
    assert.ok(H[h], "missing " + h);
  }
  assert.strictEqual(H["Sec-Fetch-Mode"], "navigate");
});

await t("every request aimed at the client's site uses them", () => {
  // The three that used to carry the bot UA: the liveness probe, the stylesheet
  // read behind the palette, and image validation. The last two swallow their
  // errors, so a 403 there costs colours and pictures with nothing in the log.
  const uses = (SRC.match(/BROWSER_HEADERS/g) || []).length;
  assert.ok(uses >= 5, `expected the headers on every outbound site request, found ${uses} references`);
  // Gemini's own calls must NOT pretend to be a browser.
  const geminiCall = SRC.slice(SRC.indexOf("generativelanguage.googleapis.com"));
  assert.ok(!geminiCall.slice(0, 400).includes("BROWSER_HEADERS"), "browser headers leaked into the Gemini call");
});

console.log("\nfallback");

await t("a refused fetch falls through to the browser", async () => {
  skipUnless(process.env.DESIGNGEN_FETCH_LIVE === "1", "set DESIGNGEN_FETCH_LIVE=1 (needs network + playwright)");
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, url: "", text: async () => "" });
  try {
    const logs = [];
    const out = await DG.fetchReferenceHtml("https://ruma.com", (m) => logs.push(m));
    assert.ok(["browserless", "browser"].includes(out.via), "came from " + out.via);
    assert.ok(out.html.length > 2000, `browser returned only ${out.html.length} bytes`);
    assert.ok(/<html/i.test(out.html), "not an HTML document");
    assert.ok(out.finalUrl, "no final URL to resolve relative links against");
    assert.ok(logs.some((l) => /direct fetch refused/.test(l)), "the fallback was silent:\n" + logs.join("\n"));
  } finally { global.fetch = real; }
});

await t("a working fetch is used as-is, no browser launched", async () => {
  skipUnless(process.env.DESIGNGEN_FETCH_LIVE === "1", "set DESIGNGEN_FETCH_LIVE=1 (needs network)");
  const logs = [];
  const out = await DG.fetchReferenceHtml("https://ruma.com", (m) => logs.push(m));
  assert.strictEqual(out.via, "fetch");
  assert.ok(out.html.length > 2000);
  assert.deepStrictEqual(logs, [], "should say nothing when the direct fetch works");
});

await t("a challenge page answering 200 is not accepted as the site", async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, url: "https://x.test/", text: async () => "<html><script>challenge</script></html>" });
  try {
    let reason = "";
    // No browser here, so the fallback must fail — the point is that the thin
    // 200 was rejected rather than scraped as if it were the client's site.
    await DG.fetchReferenceHtml("https://x.test", () => {}).then(
      (r) => { reason = "accepted " + r.html.length + " bytes as the site"; },
      (e) => { reason = e.message; });
    assert.ok(/challenge page|could not be read/.test(reason), "unexpected: " + reason);
    assert.ok(!/accepted/.test(reason), reason);
  } finally { global.fetch = real; }
});

await t("both routes failing says what each one did", async () => {
  const real = global.fetch;
  global.fetch = async () => { throw new Error("socket hang up"); };
  try {
    let msg = "";
    await DG.fetchReferenceHtml("https://nope.invalid", () => {}).catch((e) => { msg = e.message; });
    assert.match(msg, /direct fetch: socket hang up/);
    // The message has to name each route it tried, so a failure on the deployed
    // tool says whether browserless was even configured.
    assert.match(msg, /browserless:/);
    assert.match(msg, /local browser:/);
  } finally { global.fetch = real; }
});

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);

})();
