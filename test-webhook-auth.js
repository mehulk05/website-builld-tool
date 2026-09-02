// Does the TED subtask webhook refuse callers it cannot identify?
//
// The bug this covers: the handler read
//
//   if (secret && header !== secret) return 401
//
// so an unset TED_SUBTASK_WEBHOOK_SECRET meant no authentication at all — and
// that is exactly how it was deployed. A POST to the public Render URL with a
// task id was enough to start an edit run that merges to a client's repository,
// and task ids are small consecutive integers.
//
// The downstream checks (the parent must be a revision-cycle task, the subtask
// must carry a request, the tool must not have spoken last) stop an attacker
// writing their own instruction. They do not stop one replaying somebody else's.
//
// Its siblings — /api/webhook/email-change and /api/webhook/onboarding-submitted
// — have always failed closed. This pins the same rule here.

const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const PORT = 59421;

// The server is booted as a real process, because the behaviour under test is
// the HTTP handler's, and reading the env at request time is part of it.
function boot(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TED_API_TOKEN: "test-token",
      TED_BASE: "http://127.0.0.1:59422",   // unreachable on purpose: nothing must get that far
      TED_SUBTASK_POLL_MS: "0",
      REAUDIT_HOURS: "0",
      ADMIN_PASSWORD: "",
      NOCODB_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  return { child, log: () => out.join("") };
}

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/webhook/ted-subtask`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      if (r.status) return true;
    } catch (e) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server never came up");
};

const post = (headers, body) => fetch(`http://127.0.0.1:${PORT}/api/webhook/ted-subtask`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}),
});

(async () => {
  console.log("\nted-subtask webhook auth\n");

  // ---- no secret configured: the deployed state that was wide open ----------
  let s = boot({ TED_SUBTASK_WEBHOOK_SECRET: "" });
  try {
    await ready();

    await t("with no secret configured, an anonymous caller is refused", async () => {
      const r = await post({}, { taskId: "45384" });
      assert.strictEqual(r.status, 401, "an unset secret must not mean an open endpoint");
      const body = await r.json();
      assert.match(body.error, /not configured/i, "and it should say why, not just deny");
    });

    await t("a caller who invents a secret is refused too", async () => {
      const r = await post({ "x-webhook-secret": "hunter2" }, { taskId: "45384" });
      assert.strictEqual(r.status, 401);
    });

    await t("the refusal happens before the task id is even looked at", async () => {
      // TED_BASE points nowhere. A 401 rather than a timeout or a 502 proves
      // nothing downstream ran — no task fetch, and so no run.
      const r = await post({}, { data: { id: "45384" } });
      assert.strictEqual(r.status, 401);
    });

    await t("boot says plainly that the fast path is off", async () => {
      assert.match(s.log(), /TED subtask webhook: DISABLED/,
        "an unregistered webhook is invisible from this side; the least it can do is say it would refuse");
    });
  } finally { s.child.kill(); }

  // ---- secret configured: the state it should be deployed in ---------------
  s = boot({ TED_SUBTASK_WEBHOOK_SECRET: "s3cret-value" });
  try {
    await ready();

    await t("a caller with no header is refused", async () => {
      assert.strictEqual((await post({}, { taskId: "45384" })).status, 401);
    });

    await t("a caller with the wrong header is refused", async () => {
      assert.strictEqual((await post({ "x-webhook-secret": "nope" }, { taskId: "45384" })).status, 401);
    });

    await t("a caller with the right header gets past the gate", async () => {
      // TED's "Test Webhook" button sends exactly this: the envelope with an
      // empty data. It is a reachability check, so it answers 200 and says
      // nothing was done — otherwise the one control an operator has for
      // verifying their wiring reports a fault when the wiring is correct.
      const r = await post({ "x-webhook-secret": "s3cret-value" },
        { event: "SUBTASK_CREATED", timestamp: new Date().toISOString(), source: "ted", subscriptionId: "abc", data: {} });
      assert.strictEqual(r.status, 200, "the right secret must reach the handler proper");
      const body = await r.json();
      assert.strictEqual(body.test, true);
      assert.match(body.message, /nothing was done/i, "200 must not read as work having happened");
    });

    await t("the secret is accepted under any of the four header spellings TED might use", async () => {
      // Which label TED puts the secret behind is set on its side, not ours, and
      // this subscription has never delivered — so a header mismatch would have
      // been indistinguishable from the TED-side bug. /api/webhook/pre-release
      // and /api/webhook/ted-content-review already accept all four; this one
      // did not, and that gap could only ever cost a debugging round trip.
      const ping = { event: "SUBTASK_CREATED", timestamp: new Date().toISOString(), source: "ted", subscriptionId: "abc", data: {} };
      for (const headers of [
        { "x-ted-webhook-secret": "s3cret-value" },
        { "x-webhook-secret": "s3cret-value" },
        { "x-ted-secret": "s3cret-value" },
        { authorization: "Bearer s3cret-value" },
      ]) {
        const r = await post(headers, ping);
        assert.strictEqual(r.status, 200, `${Object.keys(headers)[0]} should be accepted`);
      }
    });

    await t("a populated payload that still hides the task id is a real failure", async () => {
      // Not a ping: data has content, so failing to find the id means we could
      // not read a genuine event, and that must stay loud.
      const r = await post({ "x-webhook-secret": "s3cret-value" },
        { event: "SUBTASK_CREATED", data: { somethingElse: "45385" } });
      assert.strictEqual(r.status, 422);
      assert.match((await r.json()).error, /no task id/i);
    });

    await t("boot says the fast path is armed, and where", async () => {
      assert.match(s.log(), /TED subtask webhook: armed/);
      assert.match(s.log(), /x-webhook-secret/, "whoever registers it in TED needs to know what to send");
    });
  } finally { s.child.kill(); }

  // ---- /api/webhook/pre-release --------------------------------------------
  // The same fail-open shape, and its own comment said it was copied from the
  // TED one. It matters more here: this endpoint clones, audits, opens and
  // MERGES a pull request against a client's repository. Unlike the TED subtask
  // hook it is genuinely registered in TED and delivering, so the fix is
  // deliberately loud about what to set.
  const prePost = (headers, body) => fetch(`http://127.0.0.1:${PORT}/api/webhook/pre-release`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}),
  });

  s = boot({ PRE_RELEASE_WEBHOOK_SECRET: "", TED_SUBTASK_WEBHOOK_SECRET: "x" });
  try {
    await ready();

    await t("pre-release: with no secret configured, an anonymous caller is refused", async () => {
      const r = await prePost({}, { trigger: { clientName: "Nashville Wellness & IV" } });
      assert.strictEqual(r.status, 401, "an endpoint that merges to client repos must not run open");
      assert.match((await r.json()).error, /PRE_RELEASE_WEBHOOK_SECRET/,
        "the 401 must name the variable, because this subscription is live and someone has to fix it fast");
    });

    await t("pre-release: the refusal happens before any client lookup", async () => {
      const r = await prePost({}, { trigger: { clientId: "1534", clientName: "NUVO" } });
      assert.strictEqual(r.status, 401);
    });
  } finally { s.child.kill(); }

  s = boot({ PRE_RELEASE_WEBHOOK_SECRET: "pre-s3cret", TED_SUBTASK_WEBHOOK_SECRET: "x" });
  try {
    await ready();

    await t("pre-release: a wrong secret is refused", async () => {
      assert.strictEqual((await prePost({ "x-webhook-secret": "nope" }, {})).status, 401);
    });

    await t("pre-release: every header TED might send it under is accepted", async () => {
      // TED's Secret Auth tab sends X-TED-Webhook-Secret; a header typed on the
      // Parameter tab is whatever was typed. Reading only one means the day
      // somebody fills in the wrong tab, every delivery 401s silently.
      // What is being asserted is "not 401" — the body is an empty ping, so
      // anything that gets past the gate lands on the 200 reachability answer.
      for (const h of ["x-ted-webhook-secret", "x-webhook-secret", "x-ted-secret"]) {
        const r = await prePost({ [h]: "pre-s3cret" }, {});
        assert.strictEqual(r.status, 200, `${h} should have been accepted as the secret`);
      }
      const r = await prePost({ authorization: "Bearer pre-s3cret" }, {});
      assert.strictEqual(r.status, 200, "a bearer token should be accepted too");
    });

    await t("pre-release: TED's Test button gets a 200 that says nothing was done", async () => {
      // The exact skeleton TED sends: seen keys were
      // ["timestamp","source","data","subscriptionId","event"].
      const r = await prePost({ "x-webhook-secret": "pre-s3cret" },
        { event: "TASK_STATUS_CHANGED", timestamp: new Date().toISOString(), source: "ted", subscriptionId: "abc", data: {} });
      assert.strictEqual(r.status, 200, "a reachability check on a correctly wired endpoint must not report a fault");
      const body = await r.json();
      assert.strictEqual(body.test, true);
      assert.match(body.message, /nothing was done/i);
    });

    await t("pre-release: a real event naming no client is still refused", async () => {
      // A template key means TED thought it had something to say, so a missing
      // client is a genuine problem rather than a ping.
      const r = await prePost({ "x-webhook-secret": "pre-s3cret" },
        { event: "TASK_STATUS_CHANGED", trigger: { templateKey: "beta_site.release_approval", status: "Completed" } });
      assert.strictEqual(r.status, 422);
      assert.match((await r.json()).error, /no client id or name/i);
    });
  } finally { s.child.kill(); }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
