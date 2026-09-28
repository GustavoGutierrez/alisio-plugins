#!/usr/bin/env node
/**
 * Preflight-and-publish ONE plugin. Dry run by default.
 *
 * USAGE
 *   pnpm publish-one -- @alisio/plugin-<name> [--publish] [--tag <dist-tag>] [--otp <code>]
 *
 * SAFETY. Without `--publish` this never touches the registry for a write; it
 * runs the full preflight and `pnpm pack` dry run so the operator can review
 * exactly what would ship. With `--publish` it publishes under the chosen
 * dist-tag with public access.
 *
 * DIST-TAGS. Default `latest`. A version with a prerelease suffix (for example
 * `0.2.0-alpha.1`) defaults to `next`, so a prerelease is never promoted to
 * `latest` by accident; pass `--tag` to override explicitly.
 */
import {
  checkCleanTree,
  checkNpmAuth,
  discoverPackages,
  parseFlags,
  preflightPackage,
  printSummaryTable,
  publishPackage,
  resolveDistTag,
  runPackageChecks,
  scriptArgs,
  USAGE_EXIT,
  UsageError,
  validateDistTag,
} from "./lib/release.mjs";

const USAGE =
  "Usage: pnpm publish-one -- @alisio/plugin-<name> [--publish] [--tag <dist-tag>] [--otp <code>]";

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
if (positionals.length !== 1) {
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

const name = positionals[0];
let pkg;
try {
  pkg = await discoverPackages({ selected: name });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let tag;
try {
  tag = validateDistTag(resolveDistTag(pkg.version, flags.tag));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

const dryRun = flags.publish !== true;
console.log(`\n${dryRun ? "DRY RUN" : "PUBLISH"} ${pkg.name}@${pkg.version} (dist-tag: ${tag})`);

const auth = checkNpmAuth();
const tree = checkCleanTree();
const preflight = await preflightPackage(pkg, { auth, tree });
if (preflight.kind !== "ok") {
  console.error(`\nCannot publish ${pkg.name}: ${preflight.message}`);
  printSummaryTable([
    {
      name: pkg.name,
      version: pkg.version,
      action: "skipped",
      outcome: preflight.kind,
      note: preflight.message.split("\n")[0],
    },
  ]);
  process.exit(1);
}

try {
  runPackageChecks(pkg);
  publishPackage(pkg, { dryRun, tag, otp: flags.otp });
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

printSummaryTable([
  {
    name: pkg.name,
    version: pkg.version,
    action: dryRun ? "dry-run publish" : "published",
    outcome: "ok",
    note: dryRun ? "repeat with --publish to release" : `dist-tag: ${tag}`,
  },
]);

if (dryRun) {
  console.log(`Dry run only. Repeat with: pnpm publish-one -- ${name} --publish`);
} else {
  console.log(`Published ${pkg.name}@${pkg.version} under dist-tag "${tag}".`);
  console.log(`Install with: alisio install npm:${name}@${pkg.version}`);
}
