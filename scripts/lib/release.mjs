#!/usr/bin/env node
/**
 * Shared release primitives for the Alisio plugin publish tooling.
 *
 * WHY A MODULE. `publish-one.mjs` and `publish-all.mjs` must run the exact same
 * preflight, or the single-package and all-packages paths drift and one of them
 * becomes the "safe" path that nobody actually uses. Keeping the discovery,
 * argument parsing, authentication, clean-tree, version-consistency, leak and
 * registry checks here means there is one definition of "ready to publish".
 *
 * DEPENDENCY-FREE. Everything is a Node built-in; the publish helpers shell out
 * to the repository's own pnpm/npm/git tooling that the operator already has.
 * The leak preflight reuses `scripts/leak-check.mjs`, which is itself built on
 * Node built-ins plus the system `tar` already assumed by `pack-check.mjs`.
 *
 * NEVER LEAKS CREDENTIALS. The authentication check runs `npm whoami` and only
 * reports whether it succeeded. No token is read, printed, or passed through
 * this module. An `--otp` value is forwarded to the publish command only. The
 * leak preflight reports credential-shaped findings with a redacted placeholder.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFindings, scanTarball } from "../leak-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file's location so it never depends on cwd. */
export const REPO_ROOT = resolve(HERE, "..", "..");
export const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** Publishable package name contract, mirroring `scripts/pack-check.mjs`. */
export const PLUGIN_NAME_RE = /^@alisio\/plugin-[a-z0-9][a-z0-9-]*$/;

/** The only semantic bumps `bump-one.mjs` accepts. Prereleases use Changesets directly. */
export const BUMP_TYPES = ["patch", "minor", "major"];

/** Exit code reserved for usage errors, so scripts and CI can tell them apart. */
export const USAGE_EXIT = 2;

/** Thrown for a bad command line; callers print it and exit with `USAGE_EXIT`. */
export class UsageError extends Error {}

/**
 * pnpm forwards its `--` separator into `process.argv`, so `pnpm bump-one --
 * <name>` reaches the script as `["--", "<name>", ...]`. Drop a single leading
 * separator before parsing; later `--` still means "end of options".
 */
export function scriptArgs() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  return argv;
}

/**
 * Parse a command line into positionals plus a validated flag map.
 *
 * Unknown flags are a hard error, never silently ignored, because a typo like
 * `--publsih` must not degrade into a dry run the operator thinks is real.
 * Boolean flags may not take a value; value flags accept `--flag value` or
 * `--flag=value`.
 */
export function parseFlags(argv, { booleans = [], values = [] } = {}) {
  const booleanSet = new Set(booleans);
  const valueSet = new Set(values);
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new UsageError(`Unknown flag: ${arg}`);
      positionals.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    if (booleanSet.has(key)) {
      if (inline !== undefined) throw new UsageError(`Flag --${key} does not take a value`);
      flags[key] = true;
      continue;
    }
    if (!valueSet.has(key)) throw new UsageError(`Unknown flag: --${key}`);
    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || (value.startsWith("--") && inline === undefined))
      throw new UsageError(`Flag --${key} requires a value`);
    flags[key] = value;
  }
  return { positionals, flags };
}

/** Short package name: `@alisio/plugin-wayfinder` -> `wayfinder`. */
export function shortNameOf(name) {
  return name.replace(/^@alisio\/plugin-/, "");
}

/**
 * Discover every publishable `@alisio/plugin-*` package in the workspace.
 *
 * Non-plugin, private, and malformed manifests are skipped rather than fatal:
 * the workspace may legitimately hold tooling packages later. When `selected`
 * is given, exactly one package must match or the caller gets an error.
 */
export async function discoverPackages({ selected } = {}) {
  const packages = [];
  for (const entry of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_DIR, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (manifest.private || !PLUGIN_NAME_RE.test(manifest.name)) continue;
    packages.push({
      name: manifest.name,
      dir,
      relativeDir: `packages/${entry.name}`,
      version: manifest.version,
      versionSourcePath: join(dir, "src", "version.ts"),
    });
  }
  packages.sort((left, right) => left.name.localeCompare(right.name));
  if (selected === undefined) return packages;
  const matches = packages.filter((pkg) => pkg.name === selected);
  if (matches.length !== 1) throw new Error(`Publishable package not found: ${selected}`);
  return matches[0];
}

/** Read `VERSION` from a package's `src/version.ts`, or `null` when absent/unparseable. */
export async function readDeclaredVersion(pkg) {
  let source;
  try {
    source = await readFile(pkg.versionSourcePath, "utf8");
  } catch {
    return null;
  }
  const match = /export const VERSION = "([^"]+)"/.exec(source);
  return match ? match[1] : null;
}

/** `npm whoami` must succeed; the username is never a secret worth printing, only success. */
export function checkNpmAuth() {
  const result = spawnSync("npm", ["whoami"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error) return { ok: false, detail: `could not run npm: ${result.error.message}` };
  const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  return { ok: result.status === 0, detail };
}

/** `git status --porcelain` must be empty so the published tree is exactly what is reviewed. */
export function checkCleanTree() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error)
    return { ok: false, paths: [], detail: `could not run git: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, paths: [], detail: (result.stderr ?? "").trim() };
  const paths = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));
  return { ok: paths.length === 0, paths, detail: "" };
}

/**
 * Pack the package and scan the tarball that would ship for machine paths and
 * credentials. `pnpm pack` runs the package's own `prepack` build, so the scan
 * sees the same artifact `pnpm publish` uploads. Returns findings so callers
 * can print a precise, credential-redacted report.
 */
export async function checkLeakFree(pkg) {
  const temp = await mkdtemp(join(tmpdir(), "alisio-leak-preflight-"));
  try {
    const packed = spawnSync("pnpm", ["--dir", pkg.dir, "pack", "--pack-destination", temp], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (packed.error)
      return {
        ok: false,
        findings: [],
        detail: `could not run pnpm pack: ${packed.error.message}`,
      };
    if (packed.status !== 0)
      return {
        ok: false,
        findings: [],
        detail: `pnpm pack failed: ${(packed.stderr ?? "").trim() || `exit ${packed.status}`}`,
      };
    const lastLine = (packed.stdout ?? "").trim().split("\n").at(-1) ?? "";
    const { findings } = scanTarball(join(temp, basename(lastLine)));
    return { ok: findings.length === 0, findings, detail: "" };
  } catch (error) {
    return {
      ok: false,
      findings: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Ask the registry whether `<name>@<version>` already exists.
 *
 * A 404 means "not published yet" and is the good path. Any other failure means
 * the registry could not be reached, which is reported as an error: refusing to
 * publish is safer than guessing the version is free.
 */
export function checkPublished(pkg) {
  const result = spawnSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) return { ok: false, published: null, detail: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0 && (result.stdout ?? "").trim())
    return { ok: true, published: true, detail: (result.stdout ?? "").trim() };
  if (/E404|404 Not Found|is not in this registry/i.test(output))
    return { ok: true, published: false, detail: "not found" };
  return { ok: false, published: null, detail: output || `npm view exited ${result.status}` };
}

/** Default dist-tag: never promote a prerelease to `latest` by accident. */
export function resolveDistTag(version, explicitTag) {
  if (explicitTag) return explicitTag;
  return version.includes("-") ? "next" : "latest";
}

/** Dist-tags are labels, not versions: reject anything that looks like semver or a shell token. */
export function validateDistTag(tag) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag)) throw new UsageError(`Invalid dist-tag: ${tag}`);
  if (/^\d+\.\d+\.\d+/.test(tag))
    throw new UsageError(`Dist-tag cannot look like a version: ${tag}`);
  return tag;
}

/** Run one inherited-stdio step, throwing on a non-zero exit so callers can stop. */
export function runStep(label, command, args, { cwd = REPO_ROOT } = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? "unknown"})`);
  return result;
}

/**
 * The ordered test -> build -> pack:check steps for one package.
 *
 * NO `--` SEPARATOR. pnpm 10 forwards a literal `--` into the script's argv, so
 * `pnpm pack:check -- <name>` reaches `pack-check.mjs` as `["--", "<name>"]` and
 * it rejects `--` as an unknown package. Passing the name directly lets pnpm
 * append it as the script's first argument, which is what the check reads.
 */
export function packageCheckSteps(pkg) {
  return [
    { label: `test ${pkg.name}`, command: "pnpm", args: ["--filter", pkg.name, "test"] },
    { label: `build ${pkg.name}`, command: "pnpm", args: ["--filter", pkg.name, "build"] },
    { label: `pack:check ${pkg.name}`, command: "pnpm", args: ["pack:check", pkg.name] },
  ];
}

/** test -> build -> pack:check for one package; any failure is fatal. */
export function runPackageChecks(pkg) {
  for (const step of packageCheckSteps(pkg)) runStep(step.label, step.command, step.args);
}

/**
 * The single publish command for both scripts. Real publishing requires
 * `dryRun === false`; `--otp` is forwarded for two-factor accounts.
 *
 * PACK FIRST, THEN `npm publish <tarball>`. This mirrors the Alisio monorepo's
 * own publisher and is deliberate on three counts:
 *   1. the exact artifact the operator reviewed is the one that ships;
 *   2. publishing a file rather than a directory means the registry upload is
 *      decoupled from the package's `prepack` lifecycle;
 *   3. `npm publish` is what drives npm's two-factor approval flow, including
 *      the browser flow (`auth-type=web`) where npm prints a URL to approve.
 *      `pnpm publish` does not offer that flow.
 * Run this in an interactive terminal so npm can prompt or print its URL.
 */
export function publishPackage(pkg, { dryRun, tag, otp }) {
  const temp = mkdtempSync(join(tmpdir(), "alisio-publish-"));
  try {
    runStep(`pack ${pkg.name}`, "pnpm", ["pack", "--pack-destination", temp], { cwd: pkg.dir });
    const tarball = readdirSync(temp).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`pnpm pack produced no tarball for ${pkg.name}`);
    const args = ["publish", join(temp, tarball), "--access", "public", "--tag", tag];
    if (otp) args.push("--otp", otp);
    if (dryRun) args.push("--dry-run");
    runStep(`${dryRun ? "dry-run publish" : "publish"} ${pkg.name}@${pkg.version}`, "npm", args, {
      cwd: pkg.dir,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Run the ordered preflight for one package against already-collected global
 * checks. Returns a tagged result so callers can decide whether a condition is
 * an expected skip (`already-published`) or a real failure.
 */
export async function preflightPackage(pkg, { auth, tree }) {
  if (!auth.ok)
    return {
      kind: "auth",
      message: [
        "npm authentication is required before publishing.",
        `npm whoami failed: ${auth.detail}`,
        "Run `npm login` (or export NPM_TOKEN) and confirm you have publish rights on the @alisio scope, then retry.",
        "No token is ever requested or printed here.",
      ].join("\n"),
    };
  if (!tree.ok)
    return {
      kind: "dirty",
      message: [
        "the working tree is not clean; what you publish must be exactly what is committed.",
        tree.paths.length ? `Dirty paths:\n  ${tree.paths.join("\n  ")}` : tree.detail,
      ].join("\n"),
    };
  const declared = await readDeclaredVersion(pkg);
  if (declared === null)
    return {
      kind: "version",
      message: `cannot read VERSION from src/version.ts for ${pkg.name}. Recreate it with \`node scripts/sync-versions.mjs\`.`,
    };
  if (declared !== pkg.version)
    return {
      kind: "version",
      message: `version mismatch: package.json is ${pkg.version} but src/version.ts exports ${declared}. Run \`pnpm run version\` (or \`node scripts/sync-versions.mjs\`) and rebuild.`,
    };
  const leak = await checkLeakFree(pkg);
  if (!leak.ok && leak.findings.length > 0)
    return {
      kind: "leak",
      message: [
        `the packed tarball for ${pkg.name} contains machine paths or credentials and must not be published.`,
        ...formatFindings(leak.findings),
        "Remove the material from the source, commit the fix, and retry.",
      ].join("\n"),
    };
  if (!leak.ok)
    return {
      kind: "leak",
      message: `cannot verify the packed tarball for ${pkg.name}: ${leak.detail}`,
    };
  const published = checkPublished(pkg);
  if (!published.ok)
    return {
      kind: "registry",
      message: `cannot verify registry state for ${pkg.name}@${pkg.version}: ${published.detail}`,
    };
  if (published.published)
    return {
      kind: "already-published",
      message: `${pkg.name}@${pkg.version} is already published; refusing to overwrite. Bump the version first.`,
    };
  return { kind: "ok", message: "" };
}

/** Values that mean "skip this package and keep going" rather than "abort the run". */
export const EXPECTED_SKIPS = new Set(["already-published"]);

/** Print a padded summary table so the operator never guesses what went out. */
export function printSummaryTable(rows) {
  const headers = ["Package", "Version", "Action", "Outcome", "Note"];
  const body = rows.map((row) => [row.name, row.version, row.action, row.outcome, row.note ?? ""]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index].length)),
  );
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log("");
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) console.log(format(row));
  console.log("");
}

/**
 * Tell the truth about what a batch run did.
 *
 * Counting by `action`/`outcome` alone made a preflight failure look like a
 * skip (`outcome` was the failure kind, never `failed`), so a run that exited 1
 * could still print `0 failed`, and packages blocked by an abort were folded in
 * with packages intentionally skipped as already published. Each row carries an
 * explicit `status`; these buckets are mutually exclusive and sum to the number
 * of packages the run discovered.
 */
export function summarizeOutcomes(rows) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    published: count("published"),
    dryRun: count("dry-run"),
    skipped: count("skipped"),
    notAttempted: count("not-attempted"),
    failed: count("failed"),
  };
}
