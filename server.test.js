"use strict";

process.env.NOCODB_TOKEN = "";
process.env.GEMINI_KEYS = "";
process.env.STITCH_API_KEY = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  safeArtifactName,
  mobilePageUrl,
  isSafeArtifactSegment,
  browserlessScreenshotRequest,
  selectPrChecks,
  preReleaseMarkerUrl,
  screenshotBuffersEqual,
  issueSupportedBySource,
  browserlessLayoutRequest,
  issueSupportedByLayout,
  safeResponsivePlanFiles,
  readMuPages,
} = require("./server");

test("safeArtifactName strips traversal and unsafe characters", () => {
  assert.equal(safeArtifactName("../../PR Run 123"), "pr-run-123");
  assert.equal(safeArtifactName(""), "page");
  assert.equal(safeArtifactName("HOME_page"), "home_page");
});

test("artifact path segments reject traversal", () => {
  assert.equal(isSafeArtifactSegment("pre-release-123"), true);
  assert.equal(isSafeArtifactSegment("home.webp"), true);
  assert.equal(isSafeArtifactSegment(".."), false);
  assert.equal(isSafeArtifactSegment("."), false);
  assert.equal(isSafeArtifactSegment("../server.js"), false);
});
test("mobilePageUrl maps home and registered slugs", () => {
  assert.equal(mobilePageUrl("https://example.com/", "home"), "https://example.com/");
  assert.equal(mobilePageUrl("https://example.com", "/services/"), "https://example.com/services/");
});

test("Browserless request captures a full mobile page after navigation settles", () => {
  const request = browserlessScreenshotRequest("https://example.com/services/");
  assert.equal(request.url, "https://example.com/services/");
  assert.deepEqual(request.viewport, { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  assert.equal(request.gotoOptions.waitUntil, "networkidle2");
  assert.equal(request.options.fullPage, true);
  assert.equal(request.options.captureBeyondViewport, true);
  assert.equal(request.options.type, "jpeg");
});
test("strict pre-release CI includes late integration failures", () => {
  const rows = [
    ["build (8.3)", "pass", "20s", "https://ci/build"],
    ["test", "fail", "90s", "https://ci/test"],
  ];
  assert.deepEqual(selectPrChecks(rows, false).map((x) => x.name), ["build (8.3)"]);
  assert.deepEqual(selectPrChecks(rows, true).map((x) => [x.name, x.status]), [["build (8.3)", "pass"], ["test", "fail"]]);
});

test("deployment marker URL identifies the exact release and bypasses caches", () => {
  assert.equal(
    preReleaseMarkerUrl("https://example.com/", "g99-theme", "pre-release-123", "probe-1"),
    "https://example.com/app/themes/g99-theme/g99-pre-release-marker.txt?release=pre-release-123&probe=probe-1"
  );
});

test("unchanged screenshot proof is rejected", () => {
  assert.equal(screenshotBuffersEqual(Buffer.from("same"), Buffer.from("same")), true);
  assert.equal(screenshotBuffersEqual(Buffer.from("before"), Buffer.from("after")), false);
});
test("source grounding rejects invented controls but keeps real component findings", () => {
  const homeSource = `<span>Expert-Led Care</span><span>Advanced Technology</span>`;
  const homeIssue = { description: "The 'Advanced Technology' button is obscured by the 'Expert-Led Care' button." };
  assert.equal(issueSupportedBySource(homeIssue, homeSource), true);

  const cosmeticSource = `<button>Book Online</button><button>View Treatments</button>`;
  const inventedIssue = { description: "The 'Book Online' and 'Calendar' button container overflows." };
  assert.equal(issueSupportedBySource(inventedIssue, cosmeticSource), false);
});
test("Browserless DOM geometry grounds overflow findings", () => {
  const request = browserlessLayoutRequest("https://example.com/?proof=1");
  assert.equal(request.context.url, "https://example.com/?proof=1");
  assert.match(request.code, /scrollWidth/);
  assert.match(request.code, /overlaps/);
  const issue = { kind: "horizontal-overflow" };
  assert.equal(issueSupportedByLayout(issue, { horizontalOverflow: false, overlaps: [] }), false);
  assert.equal(issueSupportedByLayout(issue, { horizontalOverflow: true, overlaps: [] }), true);
});
test("layout grounding accepts model kind spelling variants", () => {
  const noOverflow = { horizontalOverflow: false, overlaps: [] };
  assert.equal(issueSupportedByLayout({ kind: "horizontal overflow" }, noOverflow), false);
  assert.equal(issueSupportedByLayout({ kind: "footer-layout-overflow" }, noOverflow), false);
  assert.equal(issueSupportedByLayout({ kind: "overlapping elements" }, noOverflow), false);
});

test("responsive planning normalizes relative paths and falls back to registered templates", () => {
  const theme = "web/app/themes/g99-theme";
  const manifest = [
    { path: `${theme}/front-page.php` },
    { path: `${theme}/page-service.php` },
    { path: `${theme}/header.php` },
    { path: `${theme}/footer.php` },
  ];
  const failing = [
    { file: "front-page.php", title: "Home", issues: [{ description: "Hero controls overlap" }] },
    { file: "page-service.php", title: "Service", issues: [{ description: "Footer content is clipped" }] },
  ];
  assert.deepEqual(
    safeResponsivePlanFiles([{ path: "front-page.php", op: "modify", instruction: "Fix hero" }], theme, failing, manifest).map((x) => x.path),
    [`${theme}/front-page.php`]
  );
  assert.deepEqual(
    safeResponsivePlanFiles([], theme, failing, manifest).map((x) => x.path),
    [`${theme}/front-page.php`, `${theme}/page-service.php`, `${theme}/footer.php`]
  );
});
test("readMuPages returns every backend-registered template", () => {
  const source = `<?php
$pages = [
    ['title' => 'Home', 'slug' => 'home', 'template' => ''],
    ['title' => 'Services', 'slug' => 'services', 'template' => 'page-services.php'],
    ['title' => 'About', 'slug' => 'about', 'template' => 'page-about.php'],
];
`;
  assert.deepEqual(readMuPages(source), [
    { title: "Home", slug: "home", template: "" },
    { title: "Services", slug: "services", template: "page-services.php" },
    { title: "About", slug: "about", template: "page-about.php" },
  ]);
});
