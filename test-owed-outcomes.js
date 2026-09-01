// Does a finished run's outcome survive the process dying before it is posted?
//
// The bug this covers: the outcome comment is deferred by TED_SHOT_DELAY_MS so
// the screenshot is taken after the deploy lands, and for that minute the only
// record that a client's task is owed an answer was a setTimeout. A redeploy or
// a crash inside that window took the timer with it. The run had already merged
// to the client's repository, so what was lost was every trace that it happened
// — which is how PR #100 shipped to nuvoaestheticsclinic and task 45384 was
// never told.
//
// Runs against a fake TED. Nothing here touches the network or a real task.

process.env.TED_API_TOKEN = "test-token";
process.env.TED_BASE = "http://127.0.0.1:59317";
process.env.TED_SCREENSHOTS = "off";        // the screenshot path is not what is under test
process.env.TED_SUBTASK_POLL_MS = "0";
process.env.NODE_ENV = "test";

const http = require("http");
const assert = require("assert");

let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ok   ${name}`); pass++; };
const bad = (name, e) => { console.log(`  FAIL ${name}\n       ${e && e.message}`); fail++; };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ---- a TED that can be told how to behave ----------------------------------
let MODE = "ok";                 // ok | fail | html
const POSTED = [];               // every comment that actually landed
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = req.url.match(/^\/api\/tasks\/([^/]+)\/comments$/);
    if (!m || req.method !== "POST") { res.writeHead(404).end("{}"); return; }
    if (MODE === "fail") { res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}'); return; }
    if (MODE === "html") { res.writeHead(200, { "content-type": "text/html" }).end("<html>the angular shell</html>"); return; }
    let text = "";
    try { text = JSON.parse(body).text || ""; } catch (e) { text = body; }
    POSTED.push({ taskId: m[1], text });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: String(POSTED.length) }));
  });
});

(async () => {
  await new Promise((r) => server.listen(59317, "127.0.0.1", r));
  const S = require("./server.js");

  const makeJob = (id, taskId) => ({
    draftId: id, type: "edit", status: "done",
    payload: { source: "ted-subtask", tedSubtaskId: taskId, businessName: "Test Clinic", liveUrl: "" },
  });

  console.log("\nowed TED outcomes\n");

  await t("a delivered outcome leaves no debt behind", async () => {
    MODE = "ok"; POSTED.length = 0;
    const job = makeJob("edit-1", "111");
    S.noteOwedOutcome(job, "111", "Change is live");
    assert.ok(job.tedOwed, "the debt should exist while it is undelivered");
    const delivered = await S.tedComment("Change is live", null, 0, "111");
    S.settleOwedOutcome(job, delivered);
    assert.strictEqual(delivered, true, "tedComment should report success");
    assert.strictEqual(job.tedOwed, undefined, "a delivered outcome must clear the debt");
    assert.strictEqual(POSTED.length, 1);
  });

  await t("tedComment reports failure rather than pretending", async () => {
    MODE = "html";               // TED's SPA shell: a 200 that is not the API
    const delivered = await S.tedComment("anything", null, 0, "222");
    assert.strictEqual(delivered, false, "the Angular shell must not read as a successful post");
  });

  await t("a failed delivery keeps the debt and counts the attempt", async () => {
    MODE = "html";
    const job = makeJob("edit-2", "222");
    S.noteOwedOutcome(job, "222", "Change is live");
    S.settleOwedOutcome(job, await S.tedComment("Change is live", null, 0, "222"));
    assert.ok(job.tedOwed, "an undelivered outcome must stay owed");
    assert.strictEqual(job.tedOwed.attempts, 1);
  });

  // The real scenario: the job finished, the debt was recorded, and the process
  // died before the timer fired. On the next boot the job is loaded from
  // jobs.json with tedOwed still on it.
  await t("an outcome owed across a restart is delivered at boot", async () => {
    MODE = "ok"; POSTED.length = 0;
    const job = makeJob("edit-3", "45384");
    job.tedOwed = { taskId: "45384", text: "Change is live - NUVO Aesthetics Clinic v2", since: Date.now() - 3600e3, attempts: 0 };
    S.JOBS.set(job.draftId, job);

    await S.flushOwedTedOutcomes();

    assert.strictEqual(POSTED.length, 1, "the owed outcome should have been posted");
    assert.strictEqual(POSTED[0].taskId, "45384", "and onto the task that was waiting for it");
    assert.match(POSTED[0].text, /Change is live/);
    assert.strictEqual(job.tedOwed, undefined, "and the debt cleared");
    S.JOBS.delete(job.draftId);
  });

  await t("a boot flush that fails leaves the debt for the next boot", async () => {
    MODE = "html"; POSTED.length = 0;
    const job = makeJob("edit-4", "999");
    job.tedOwed = { taskId: "999", text: "Change is live", since: Date.now(), attempts: 0 };
    S.JOBS.set(job.draftId, job);

    await S.flushOwedTedOutcomes();

    assert.ok(job.tedOwed, "an outcome that still will not post stays owed");
    assert.strictEqual(job.tedOwed.attempts, 1);
    S.JOBS.delete(job.draftId);
  });

  await t("a permanently undeliverable outcome is abandoned, not retried forever", async () => {
    MODE = "ok"; POSTED.length = 0;   // would succeed — proving the cap, not the transport
    const job = makeJob("edit-5", "888");
    job.tedOwed = { taskId: "888", text: "Change is live", since: Date.now(), attempts: 5 };
    S.JOBS.set(job.draftId, job);

    await S.flushOwedTedOutcomes();

    assert.strictEqual(POSTED.length, 0, "past the attempt cap nothing further is sent");
    assert.ok(job.tedOwed, "and it is left visible rather than silently dropped");
    S.JOBS.delete(job.draftId);
  });

  await t("jobs with no debt are left alone", async () => {
    MODE = "ok"; POSTED.length = 0;
    const job = makeJob("edit-6", "777");
    S.JOBS.set(job.draftId, job);
    await S.flushOwedTedOutcomes();
    assert.strictEqual(POSTED.length, 0);
    S.JOBS.delete(job.draftId);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  // Close and let the loop drain on its own. process.exit() here aborts with a
  // libuv assertion on Windows (exit 127, which a CI run reads as a failure)
  // because the fake TED's sockets are still closing.
  process.exitCode = fail ? 1 : 0;
  server.close();
})();
