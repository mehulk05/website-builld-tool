// Does the request handed to the model contain only what a person asked for?
//
// The bug this covers: tedResolveSubtaskRequest built the instruction from the
// title, the description and EVERY comment on the subtask — including the ones
// this tool posted itself. A subtask that had already been run therefore fed the
// model its own acknowledgement, its own outcome, and any correction posted
// since, as though the client had written them.
//
// Found by dry-running the live webhook against task 45385, whose instruction
// came back carrying:
//
//   Picked up by Growth99 Studio ... Reading 1 reference image(s) ...
//   Change is live ... "#bf9664" "#1f2124" in elementor.json::doc x8 ...
//   Correction - this change was reverted. It is NOT live.
//
// The second of those is the dangerous one. It describes a site-wide colour
// replace, in the imperative, and handed back as part of the request it reads as
// an instruction to do it again — the exact behaviour test-swap-scope.js exists
// to prevent.

process.env.TED_API_TOKEN = "";
process.env.TED_SUBTASK_POLL_MS = "0";

const assert = require("assert");
const S = require("./server.js");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const MARK = S.TED_AUTOMATION_MARK;

// The real comment thread on task 45385, in order.
const thread = () => [
  { text: "Please action this using the attached reference screenshot - the button marked with the arrow.", aiGenerated: false },
  { text: `Picked up by Growth99 Studio - NUVO Aesthetics Clinic v2\nStudio job: edit-1788258113557\nReading 1 reference image(s): NUVO-our-story-button.png\n\n${MARK}`, aiGenerated: false },
  { text: `Change is live - NUVO Aesthetics Clinic v2\n"#bf9664" "#1f2124" in elementor.json::doc x8, elementor.json::css x2\n\n${MARK}`, aiGenerated: false },
  { text: `Correction - this change was reverted. It is NOT live.\n\n${MARK}`, aiGenerated: false },
  { text: "Also make the label text white, not cream.", aiGenerated: false },
];

console.log("\ninstruction source\n");

t("comments this tool posted are not part of the request", () => {
  const kept = S.commentsFromPeople(thread());
  assert.strictEqual(kept.length, 2, "only the two a person typed should survive");
  assert.match(kept[0].text, /reference screenshot/);
  assert.match(kept[1].text, /label text white/);
});

t("the outcome comment cannot be read back as an instruction", () => {
  const text = S.commentsFromPeople(thread()).map((c) => c.text).join("\n\n");
  // The specific loop this closes: an outcome describing a site-wide replace,
  // returning as part of the next request.
  assert.doesNotMatch(text, /elementor\.json::doc/, "the tool's own outcome must not reach the model");
  assert.doesNotMatch(text, /Change is live/);
  assert.doesNotMatch(text, /Picked up by Growth99 Studio/);
  assert.doesNotMatch(text, /Correction - this change was reverted/);
});

t("a comment marked aiGenerated is excluded even without the marker", () => {
  const kept = S.commentsFromPeople([
    { text: "posted as the AI agent, no marker", aiGenerated: true },
    { text: "a person", aiGenerated: false },
  ]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].text, "a person");
});

t("a person quoting the tool is still a person", () => {
  // The marker is what identifies ours, and it is appended by tedComment. A
  // human paraphrasing an outcome does not carry it.
  const kept = S.commentsFromPeople([
    { text: "You said the change is live but I still see the old colour.", aiGenerated: false },
  ]);
  assert.strictEqual(kept.length, 1, "a real complaint must not be filtered away as machine chatter");
});

t("an empty or malformed thread is handled", () => {
  assert.deepStrictEqual(S.commentsFromPeople([]), []);
  assert.deepStrictEqual(S.commentsFromPeople(null), []);
  assert.deepStrictEqual(S.commentsFromPeople(undefined), []);
  assert.strictEqual(S.commentsFromPeople([null, { text: "ok" }]).length, 1);
  assert.strictEqual(S.commentsFromPeople([{ aiGenerated: false }]).length, 1, "a comment with no text is still a comment");
});

t("the filter agrees with the guard that decides whether a request is new", () => {
  // tedResolveSubtaskRequest refuses when the NEWEST comment is ours. If that
  // guard and this filter disagreed about which comments are ours, one of them
  // would be wrong about whether there is anything to act on.
  const ours = { text: `anything\n\n${MARK}`, aiGenerated: false };
  assert.strictEqual(S.commentsFromPeople([ours]).length, 0);
  assert.ok(ours.text.includes(MARK), "the guard tests exactly this");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
