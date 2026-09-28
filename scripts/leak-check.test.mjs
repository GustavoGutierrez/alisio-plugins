// Regression fixtures for the leak guard's redaction guarantee.
//
// The guard scans every tracked file, including this one, so credential-shaped
// fixtures are assembled from fragments at runtime. No contiguous forbidden
// shape appears in this source, and no real credential is ever used.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatFindings, scanText } from "./leak-check.mjs";

const tmpDir = "/" + "tmp" + "/";
const fakeGithubPat = ["ghp", "_", "C".repeat(24)].join("");
const fakeNpmToken = ["npm", "_", "D".repeat(40)].join("");

describe("leak-check redaction", () => {
  it("redacts a credential embedded in a temp-session path", () => {
    const findings = scanText(tmpDir + fakeGithubPat, "fixture.txt");
    assert.ok(findings.length >= 1, "the fixture must produce a finding");

    const report = formatFindings(findings).join("\n");
    assert.ok(!report.includes(fakeGithubPat), "the credential must not be printed");
    assert.ok(!report.includes("ghp_"), "the credential prefix must not be printed");
    assert.ok(report.includes("<redacted"), "a redacted placeholder must be shown");
    assert.ok(report.includes("fixture.txt"), "the file must stay identifiable");
  });

  it("redacts an npm token embedded in a temp-session path", () => {
    const report = formatFindings(scanText(tmpDir + fakeNpmToken, "fixture.txt")).join("\n");
    assert.ok(!report.includes(fakeNpmToken), "the token must not be printed");
    assert.ok(!report.includes("npm_"), "the token prefix must not be printed");
    assert.ok(report.includes("<redacted"), "a redacted placeholder must be shown");
  });

  it("still prints an ordinary path finding so it stays actionable", () => {
    const ordinary = tmpDir + "session-abc";
    const findings = scanText(`const p = "${ordinary}";`, "fixture.txt");
    assert.equal(findings.length, 1, "exactly one ordinary path finding");
    assert.equal(findings[0].secret, false, "an ordinary path is not a secret");

    const report = formatFindings(findings).join("\n");
    assert.ok(report.includes(ordinary), "the offending path must be shown");
  });

  it("redacts a file label that embeds a credential", () => {
    const ordinary = tmpDir + "session-abc";
    const findings = scanText(`const p = "${ordinary}";`, fakeGithubPat + ".txt");

    const report = formatFindings(findings).join("\n");
    assert.ok(!report.includes(fakeGithubPat), "the credential in the label must not be printed");
    assert.ok(report.includes("redacted file name"), "the label must be shown as redacted");
    assert.ok(report.includes(ordinary), "the offending path must still be shown");
  });
});
