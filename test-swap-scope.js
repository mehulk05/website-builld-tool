// Does an exact-pair swap stay inside what was asked for?
//
// The bug this covers: applyTextSwaps' ceiling is Infinity unless the caller
// sets maxHits, and only the content-review path ever did. So an ordinary edit
// replaced every occurrence it could find. "Change this one button from #bf9664
// to #1f2124" recoloured all ten occurrences of the brand tan on the NUVO home
// page — six of which were not buttons — while the request said in those words
// to leave the others alone. PR #101, reverted.
//
// The rule that catches it already existed: a single token (a bare word, a hex
// colour) may only be swapped where it is unique. It was simply never consulted,
// because it is only reached when a ceiling is set at all.

process.env.TED_API_TOKEN = "";
process.env.TED_SUBTASK_POLL_MS = "0";

const assert = require("assert");
const S = require("./server.js");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// A stand-in for the NUVO home page: the brand tan used on one button and on
// several things that are not buttons.
const homePage = () => [{
  rel: "resources/pages/home/elementor.json",
  content: JSON.stringify({
    button: { background: "#bf9664" },
    heading: { color: "#bf9664" },
    divider: { color: "#bf9664" },
    icons: ["#bf9664", "#bf9664"],
    border: "#bf9664",
    css: ".c-btn{background:#bf9664}.c-rule{border-color:#bf9664}.c-tag{color:#bf9664}",
  }),
}];

const order = (replaces, literal, what) => ({ changes: [{ what: what || "colour change", replaces, literal }] });

// The options a live edit run now uses. write is captured rather than touching disk.
const editOpts = (sink, refused) => ({
  maxHits: S.EDIT_SWAP_MAX_HITS, refused, advisory: true,
  write: (rel, content) => sink.set(rel, content),
});

console.log("\nswap scope\n");

t("the ceiling is set for ordinary edits, not left at Infinity", () => {
  assert.strictEqual(typeof S.EDIT_SWAP_MAX_HITS, "number");
  assert.ok(S.EDIT_SWAP_MAX_HITS > 0, "a ceiling of 0 or NaN would read as unset and mean Infinity");
});

t("a hex colour used all over the page is NOT replaced everywhere", () => {
  const files = homePage(), written = new Map(), refused = [];
  const applied = S.applyTextSwaps(order("#bf9664", "#1f2124"), files, "/tmp", editOpts(written, refused));

  assert.strictEqual(applied.length, 0, "the blanket replace must not happen");
  assert.strictEqual(written.size, 0, "and nothing may be written");
  assert.ok(files[0].content.includes("#bf9664"), "the brand colour must survive untouched");
  assert.ok(!files[0].content.includes("#1f2124"), "and the new colour must not appear");
  assert.strictEqual(refused.length, 1, "the decision must be recorded, not silent");
  // 6 in the structured settings + 3 in the inline CSS.
  assert.strictEqual(refused[0].hits, 9, "and it must say how widespread the match was");
});

t("the decline reads as advisory, not as an instruction to the sender", () => {
  const refused = [];
  S.applyTextSwaps(order("#bf9664", "#1f2124"), homePage(), "/tmp", editOpts(new Map(), refused));
  // A reviewer is told to reselect; an edit is not refused at all, so telling
  // someone to "select the whole phrase" would describe an action nobody is
  // being asked to take.
  assert.match(refused[0].reason, /left to the planner/i);
  assert.doesNotMatch(refused[0].reason, /select the whole phrase/i);
});

t("a genuinely unique value still swaps", () => {
  const files = homePage(), written = new Map(), refused = [];
  const applied = S.applyTextSwaps(order("#f8f3ee", "#ffffff"), files, "/tmp", editOpts(written, refused));
  assert.strictEqual(applied.length, 0, "a value that is not present is simply not found");

  const files2 = [{ rel: "resources/pages/home/elementor.json", content: '{"button":{"background":"#bf9664"},"heading":{"color":"#1f2124"}}' }];
  const written2 = new Map(), refused2 = [];
  const applied2 = S.applyTextSwaps(order("#bf9664", "#1f2124"), files2, "/tmp", editOpts(written2, refused2));

  assert.strictEqual(applied2.length, 1, "one occurrence is unambiguous and must still be applied");
  assert.strictEqual(refused2.length, 0);
  assert.ok(files2[0].content.includes('"background":"#1f2124"'), "the button should have changed");
});

t("a repeated phrase under the ceiling still swaps", () => {
  const files = [{ rel: "a.json", content: "Book a Consultation ... Book a Consultation ... Book a Consultation" }];
  const written = new Map(), refused = [];
  const applied = S.applyTextSwaps(order("Book a Consultation", "Schedule a Visit"), files, "/tmp", editOpts(written, refused));

  assert.strictEqual(applied.length, 1, "a multi-word phrase repeated a few times is a normal edit");
  assert.strictEqual(refused.length, 0);
  assert.ok(!files[0].content.includes("Book a Consultation"));
});

t("a phrase over the ceiling is held back", () => {
  const many = Array(S.EDIT_SWAP_MAX_HITS + 1).fill("Book a Consultation").join(" ... ");
  const files = [{ rel: "a.json", content: many }];
  const written = new Map(), refused = [];
  const applied = S.applyTextSwaps(order("Book a Consultation", "Schedule a Visit"), files, "/tmp", editOpts(written, refused));

  assert.strictEqual(applied.length, 0);
  assert.strictEqual(refused.length, 1);
  assert.strictEqual(refused[0].hits, S.EDIT_SWAP_MAX_HITS + 1);
});

t("hits are counted across files, not per file", () => {
  const files = [
    { rel: "resources/pages/home/elementor.json", content: '{"a":"#bf9664"}' },
    { rel: "resources/pages/about/elementor.json", content: '{"a":"#bf9664"}' },
  ];
  const written = new Map(), refused = [];
  const applied = S.applyTextSwaps(order("#bf9664", "#1f2124"), files, "/tmp", editOpts(written, refused));

  assert.strictEqual(applied.length, 0, "one occurrence per file is still two occurrences");
  assert.strictEqual(refused[0].hits, 2);
});

t("the review path keeps its own stricter rules", () => {
  // Unchanged by this fix: a reviewer's correction is still capped at 5, still
  // visible-text only, and still told how to retype it.
  const files = [{ rel: "a.json", content: "tan tan tan" }];
  const refused = [];
  S.applyTextSwaps(order("tan", "charcoal"), files, "/tmp", { maxHits: 5, refused });
  assert.strictEqual(refused.length, 1);
  assert.match(refused[0].reason, /select the whole phrase/i);
});

t("the outcome comment says what was held back", () => {
  const job = {
    draftId: "edit-test", payload: { businessName: "NUVO Aesthetics Clinic v2", liveUrl: "https://example.com/" },
    swapDeclined: [{ n: 1, replaces: "#bf9664", literal: "#1f2124", hits: 10 }],
  };
  const text = S.tedOutcomeComment(job, { ok: true, detail: "done" });
  assert.match(text, /Held back from a blanket replace/i, "a silent decline is the same failure, quieter");
  assert.match(text, /#bf9664/);
  assert.match(text, /10 times/);
});

t("a run with nothing held back says nothing about it", () => {
  const job = { draftId: "edit-test", payload: { businessName: "X", liveUrl: "" }, swapDeclined: [] };
  const text = S.tedOutcomeComment(job, { ok: true, detail: "done" });
  assert.doesNotMatch(text, /Held back/i);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
