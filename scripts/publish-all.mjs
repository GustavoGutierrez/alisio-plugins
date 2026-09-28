#!/usr/bin/env node
/**
 * Preflight-and-publish EVERY publishable plugin. Dry run by default.
 *
 * USAGE
 *   pnpm publish-all [--publish] [--tag <dist-tag>] [--otp <code>]
 *
 * This is the EXPLICIT flow. It runs the same preflight as `publish-one` for
 * each package, then test -> build -> pack:check, then `pnpm publish`. It is
 * not the Changesets-native flow: `changeset publish` creates git tags and is
 * still available as `pnpm release:changesets` (used by CI).
 *
 * FAILURE POLICY. A package that is already published at its current version,
 * or otherwise expected to be skipped, is reported and the run continues. A
 * real failure (authentication, dirty tree, version mismatch, registry
 * unreachable, failed check, failed publish) stops the run; the remaining
 * packages are reported as not attempted, and the exit code is non-zero so the
 * operator can always tell what went out and what did not.
 */
import {
  checkCleanTree,
  checkNpmAuth,
  discoverPackages,
  EXPECTED_SKIPS,
  parseFlags,
  preflightPackage,
  printSummaryTable,
  publishPackage,
  resolveDistTag,
  runPackageChecks,
  scriptArgs,
  summarizeOutcomes,
  USAGE_EXIT,
  UsageError,
  validateDistTag,
} from "./lib/release.mjs";

const USAGE = "Usage: pnpm publish-all [--publish] [--tag <dist-tag>] [--otp <code>]";

let parsed;
try {
  parsed = parseFlags(scriptArgs(), {
    booleans: ["publish"],
    values: ["tag", "otp"],
  });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

const { positionals, flags } = parsed;
if (positionals.length !== 0) {
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

if (flags.tag !== undefined) {
  try {
    validateDistTag(flags.tag);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(USAGE);
    process.exit(USAGE_EXIT);
  }
}

const packages = await discoverPackages();
if (packages.length === 0) {
  console.error("No publishable packages found.");
  process.exit(1);
}

const dryRun = flags.publish !== true;
console.log(
  `\n${dryRun ? "DRY RUN" : "PUBLISH"} across ${packages.length} package(s): ${packages
    .map((pkg) => pkg.name)
    .join(", ")}`,
);

const auth = checkNpmAuth();
const tree = checkCleanTree();
const rows = [];
let failed = false;

for (let index = 0; index < packages.length; index += 1) {
  const pkg = packages[index];
  if (failed) {
    rows.push({
      name: pkg.name,
      version: pkg.version,
      action: "not attempted",
      outcome: "not attempted",
      status: "not-attempted",
      note: "an earlier package failed",
    });
    continue;
  }

  const preflight = await preflightPackage(pkg, { auth, tree });
  if (preflight.kind !== "ok" && !EXPECTED_SKIPS.has(preflight.kind)) {
    rows.push({
      name: pkg.name,
      version: pkg.version,
      action: "failed",
      outcome: preflight.kind,
      status: "failed",
      note: preflight.message.split("\n")[0],
    });
    console.error(`\nCannot publish ${pkg.name}: ${preflight.message}`);
    failed = true;
    continue;
  }
  if (preflight.kind !== "ok") {
    rows.push({
      name: pkg.name,
      version: pkg.version,
      action: "skipped",
      outcome: preflight.kind,
      status: "skipped",
      note: preflight.message,
    });
    continue;
  }

  try {
    const tag = validateDistTag(resolveDistTag(pkg.version, flags.tag));
    runPackageChecks(pkg);
    publishPackage(pkg, { dryRun, tag, otp: flags.otp });
    rows.push({
      name: pkg.name,
      version: pkg.version,
      action: dryRun ? "dry-run publish" : "published",
      outcome: "ok",
      status: dryRun ? "dry-run" : "published",
      note: `dist-tag: ${tag}`,
    });
  } catch (error) {
    rows.push({
      name: pkg.name,
      version: pkg.version,
      action: dryRun ? "dry-run publish" : "publish",
      outcome: "failed",
      status: "failed",
      note: error instanceof Error ? error.message : String(error),
    });
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

printSummaryTable(rows);

const summary = summarizeOutcomes(rows);
console.log(
  `Summary: ${summary.published} published, ${summary.dryRun} dry-run ok, ${summary.skipped} skipped (already published), ${summary.notAttempted} not attempted, ${summary.failed} failed (of ${summary.total} discovered).`,
);
if (failed)
  console.log(
    `Exit 1: ${summary.failed} failed and ${summary.notAttempted} not attempted explain the non-zero exit.`,
  );
if (dryRun) console.log("Dry run only. Repeat with: pnpm publish-all --publish");

process.exit(failed ? 1 : 0);
