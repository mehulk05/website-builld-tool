"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeGeneratedFileContent, partitionPreReleaseCaptures, safeResponsivePlanFiles, buildPreReleaseReport, preReleaseReportPath, renderPreReleaseReportHtml } = require("../server");

test("failed captures are skipped while valid screenshots continue", () => {
  const result = partitionPreReleaseCaptures([
    { slug: "home", screenshot: "/home.jpg" },
    { slug: "missing", title: "Missing", error: "page returned HTTP 404" },
  ]);
  assert.deepEqual(result.successful.map((page) => page.slug), ["home"]);
  assert.deepEqual(result.skipped.map((page) => page.slug), ["missing"]);
});
test("fix plan cannot include uncaptured or non-failing page templates", () => {
  const theme = "web/app/themes/test";
  const manifest = ["front-page.php", "page-missing.php", "header.php"].map((file) => ({ path: `${theme}/${file}` }));
  const files = safeResponsivePlanFiles([
    { path: `${theme}/front-page.php`, instruction: "fix overflow" },
    { path: `${theme}/page-missing.php`, instruction: "guess at 404 page" },
    { path: `${theme}/header.php`, instruction: "unrelated shared edit" },
  ], theme, [{ title: "Home", file: "front-page.php", issues: [{ description: "Hero overflows" }] }], manifest);
  assert.deepEqual(files.map((file) => file.path), [`${theme}/front-page.php`]);
});
test("AI-generated files lose trailing whitespace without changing newline style", () => {
  const input = "<?php\r\n<div>ok</div>  \r\n  \r\n";
  const output = normalizeGeneratedFileContent(input);
  assert.equal(output, "<?php\r\n<div>ok</div>\r\n\r\n");
  assert.equal(/[ \t]+$/m.test(output), false);
});

test("both pre-release AI write boundaries normalize output", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const calls = source.match(/fs\.writeFileSync\(abs, normalizeGeneratedFileContent\((?:content|repaired)\)\);/g) || [];
  assert.equal(calls.length, 2);
});

test("completion report records all checks, findings, actions, evidence, and honest decision", () => {
  const job = {
    type: "pre-release", draftId: "pre-release-test", businessName: "Test Clinic", status: "done",
    startedAt: "2026-08-05T10:00:00.000Z", finishedAt: "2026-08-05T10:10:00.000Z",
    liveUrl: "https://example.com/", prUrl: "https://github.com/acme/site/pull/1", branch: "g99/test",
    steps: [
      { label: "Pull latest code", status: "done", detail: "main" },
      { label: "Verify pre-release", status: "done", detail: "Temporarily disabled" },
    ],
    mobileBefore: [{ slug: "home", title: "Home", file: "front-page.php", url: "https://example.com/", screenshot: "/before.jpg", issues: [
      { kind: "overflow", severity: "high", description: "Hero overflows", evidence: "right edge 12px outside viewport", fixHint: "Constrain hero width" },
    ], rejectedIssues: [{ kind: "overflow", severity: "low", description: "Decoration may overflow", evidence: "decorative blur" }] }],
    mobileAfter: [{ slug: "home", title: "Home", screenshot: "/after.jpg" }],
    mobileSummary: { pass: null, pages: 1, beforeIssues: 1, afterIssues: null, changedFiles: 1, verificationDisabled: true },
    mobilePages: [{ slug: "home" }, { slug: "missing" }],
    mobileSkipped: [{ slug: "missing", title: "Missing", file: "page-missing.php", url: "https://example.com/missing/", error: "page returned HTTP 404" }],
    mobileAfterSkipped: [{ slug: "home", title: "Home", file: "front-page.php", url: "https://example.com/", phase: "after", error: "Browserless 503" }],
    editPlan: [{ path: "web/app/themes/test/front-page.php", op: "modify" }],
  };
  const report = buildPreReleaseReport(job);
  assert.equal(report.decision.code, "review");
  assert.deepEqual(report.totals, { pagesRegistered: 2, pagesAudited: 1, pagesSkipped: 2, pagesWithIssues: 1, issuesFound: 1, fixed: 0, unresolved: 0, notVerified: 1, blocked: 0, dismissedCandidates: 1, filesChanged: 1, afterScreenshots: 1 });
  assert.equal(report.checks.length, 2);
  assert.equal(report.findings[0].outcome, "not-verified");
  assert.equal(report.findings[0].evidence, "right edge 12px outside viewport");
  assert.equal(report.findings[0].afterScreenshot, "/after.jpg");
  assert.equal(report.dismissedFindings[0].description, "Decoration may overflow");
  assert.equal(report.skippedPages[0].error, "page returned HTTP 404");
  assert.equal(report.skippedPages[1].phase, "After-fix capture");
  assert.equal(report.actions[0].result, "released");
});

test("failed jobs never claim findings were fixed", () => {
  const report = buildPreReleaseReport({
    status: "error", error: "git diff check failed", mobileBefore: [{ slug: "home", screenshot: "/home.jpg", issues: [{ description: "Overflow" }] }], editPlan: [{ path: "front-page.php" }], steps: [],
  });
  assert.equal(report.decision.code, "failed");
  assert.equal(report.findings[0].outcome, "blocked");
  assert.equal(report.totals.fixed, 0);
});
test("completed responsiveness report has a permanent URL and full standalone HTML", () => {
  const job = { draftId: "pre-release-178598581129", preReleaseReport: {
    runId: "pre-release-178598581129", businessName: "Test Clinic", finishedAt: "2026-08-05T10:10:00.000Z",
    decision: { label: "Completed - human action needed", detail: "One page skipped." },
    totals: { pagesAudited: 6, issuesFound: 2, fixed: 1, notVerified: 1, filesChanged: 1, pagesSkipped: 1 },
    checks: [{ name: "Capture mobile screenshots", result: "done", detail: "6 captured" }],
    findings: [], skippedPages: [{ page: "Missing", error: "HTTP 404", action: "Human action required" }],
    dismissedFindings: [], actions: [],
  } };
  assert.equal(preReleaseReportPath(job), "/reports/perform-responsiveness-178598581129.html");
  const html = renderPreReleaseReportHtml(job.preReleaseReport);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Perform Responsiveness report/);
  assert.match(html, /Capture mobile screenshots/);
  assert.match(html, /HTTP 404/);
});