#!/usr/bin/env node
/**
 * Bump ONE plugin by writing a Changesets entry and applying it.
 *
 * USAGE
 *   pnpm bump-one -- @alisio/plugin-<name> <patch|minor|major> --summary "<public change summary>"
 *
 * WHY CHANGESETS. This stays idiomatic: it authors a real `.changeset/*.md`
 * entry for the single package and bump, then runs `changeset version` (which
 * consumes pending entries and rewrites manifests/changelogs) followed by
 * `node scripts/sync-versions.mjs` (which rewrites each `src/version.ts`).
 *
 * IMPORTANT: `changeset version` applies EVERY pending changeset, not just the
 * one this script wrote. If other changesets are queued, they are released by
 * the same run. Run `pnpm publish-one -- <name>` (dry run) or inspect
 * `git status` afterwards to see the full effect before publishing.
 *
 * PRERELEASES ARE NOT HANDLED HERE. A prerelease is a Changesets-native flow
 * (`pnpm exec changeset pre enter <tag>` ... `changeset pre exit`), not a bump
 * type; this script refuses to guess one.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUMP_TYPES,
  discoverPackages,
  PLUGIN_NAME_RE,
  parseFlags,
  REPO_ROOT,
  runStep,
  scriptArgs,
  shortNameOf,
  USAGE_EXIT,
  UsageError,
} from "./lib/release.mjs";

const USAGE =
  'Usage: pnpm bump-one -- @alisio/plugin-<name> <patch|minor|major> --summary "<public change summary>"';

let parsed;
try {
  parsed = parseFlags(scriptArgs(), { values: ["summary"] });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

const { positionals, flags } = parsed;
if (positionals.length !== 2) {
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

const [name, bumpType] = positionals;
if (!PLUGIN_NAME_RE.test(name)) {
  console.error(`Invalid package name: ${name}`);
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}
if (!BUMP_TYPES.includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}`);
  console.error(
    `Choose one of: ${BUMP_TYPES.join(", ")}. Prerelease publishing is a different, Changesets-native flow (\`pnpm exec changeset pre enter <tag>\`), not a bump type.`,
  );
  process.exit(USAGE_EXIT);
}
const summary = (flags.summary ?? "").trim();
if (!summary) {
  console.error("A non-empty --summary is required; it becomes the changelog entry.");
  console.error(USAGE);
  process.exit(USAGE_EXIT);
}

let pkg;
try {
  pkg = await discoverPackages({ selected: name });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const slug = `bump-one-${shortNameOf(name)}-${randomUUID().slice(0, 8)}`;
const changesetPath = join(REPO_ROOT, ".changeset", `${slug}.md`);
await mkdir(join(REPO_ROOT, ".changeset"), { recursive: true });
await writeFile(changesetPath, `---\n"${name}": ${bumpType}\n---\n\n${summary}\n`);

console.log(`Wrote .changeset/${slug}.md (${name}: ${bumpType}).`);
console.log(
  "Running `changeset version` — this applies every pending changeset, not only this one.",
);

runStep("changeset version", "pnpm", ["exec", "changeset", "version"]);
runStep("sync versions", "node", ["scripts/sync-versions.mjs"]);

const manifest = JSON.parse(await readFile(join(pkg.dir, "package.json"), "utf8"));
console.log(`\n${name}: ${pkg.version} -> ${manifest.version}`);
console.log(`Review the diff, then run \`pnpm publish-one -- ${name}\` (dry run).`);
