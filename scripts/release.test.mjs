// Regression fixtures for the release tooling's argument construction and
// truthful batch summary. Both are pure functions so no registry or pack runs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageCheckSteps, summarizeOutcomes } from "./lib/release.mjs";

describe("package check steps", () => {
  it("passes the package name to pack:check without a forwarded -- separator", () => {
    const pkg = { name: "@alisio/plugin-wayfinder", version: "0.1.0" };
    const steps = packageCheckSteps(pkg);

    const packStep = steps.find((step) => step.label.startsWith("pack:check"));
    assert.deepEqual(packStep.args, ["pack:check", "@alisio/plugin-wayfinder"]);
    assert.equal(packStep.args.includes("--"), false, "pnpm forwards -- into the script argv");
    for (const step of steps) assert.equal(step.args.includes("--"), false);
  });
});

describe("publish-all outcome summary", () => {
  it("counts published, dry-run, skipped, not attempted and failed truthfully", () => {
    const rows = [
      { status: "published" },
      { status: "dry-run" },
      { status: "skipped" },
      { status: "failed" },
      { status: "not-attempted" },
    ];
    const summary = summarizeOutcomes(rows);

    assert.deepEqual(summary, {
      total: 5,
      published: 1,
      dryRun: 1,
      skipped: 1,
      notAttempted: 1,
      failed: 1,
    });
    const counted =
      summary.published + summary.dryRun + summary.skipped + summary.notAttempted + summary.failed;
    assert.equal(counted, summary.total, "buckets must add up to the discovered total");
  });

  it("keeps a mid-run failure and a blocked package distinct from an intentional skip", () => {
    const summary = summarizeOutcomes([
      { status: "dry-run" },
      { status: "failed" },
      { status: "not-attempted" },
      { status: "skipped" },
    ]);

    assert.equal(summary.failed, 1, "the preflight failure is a failure, not a skip");
    assert.equal(summary.notAttempted, 1, "a blocked package is not attempted");
    assert.equal(summary.skipped, 1, "only an expected skip counts as skipped");
    assert.equal(
      summary.published + summary.dryRun + summary.skipped + summary.notAttempted + summary.failed,
      summary.total,
    );
  });
});
