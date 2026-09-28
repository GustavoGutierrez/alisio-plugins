#!/usr/bin/env node
/**
 * Leak guard: fail when machine-specific paths or credentials appear in the
 * repository's tracked files or inside a packed npm tarball.
 *
 * WHY. A repository can be clean today and leak tomorrow: someone hardcodes a
 * home directory while debugging, a packed tarball picks up a `.env`, or a token
 * is pasted into a comment. This guard is the mechanical backstop. It runs in
 * `pnpm check` so every pull request is covered, and inside the release
 * preflight so a package whose tarball leaks is refused before it is published.
 *
 * USAGE
 *   node scripts/leak-check.mjs                    scan tracked files (git ls-files)
 *   node scripts/leak-check.mjs --tarball <path>   scan the text of entries in a .tgz
 *   node scripts/leak-check.mjs --package <name>   pack one publishable package and scan it
 *
 * EXIT CODES: 0 clean, 1 findings, 2 usage or I/O error.
 *
 * HISTORY AUDIT. The git history was audited manually before this guard existed
 * and was found clean: no npmrc or env files, no credential-named tracked files,
 * no local absolute paths in any commit, and the npm token name appears only as
 * an environment-variable or secret NAME, never as a value. This guard covers
 * the working tree and the packed artifacts produced from it; it is not a
 * history scanner.
 *
 * TARBALL READER. Tarballs are unpacked with the system `tar` binary through
 * `execFileSync` (the same tool and portability assumption already used by
 * `scripts/pack-check.mjs`), then each regular file is read as UTF-8 and
 * scanned. Binary entries (NUL bytes) and symlinks are skipped. This is a
 * deliberate choice: it is simpler and more robust than hand-parsing tar, and
 * adds no npm dependency.
 *
 * FORBIDDEN SHAPES
 *   - home-path: absolute personal home paths such as /home/<user> or
 *     /Users/<user>.
 *   - root-path: the root user's home directory.
 *   - windows-path: a drive-letter path under a Users directory.
 *   - tmp-session: a path under the system temp directory with a
 *     session-specific name; bare /tmp is allowed.
 *   - npm-auth-field: the npm registry auth-token config key.
 *   - npm-token: an npm_ prefixed token with 36 or more alphanumerics.
 *   - github-pat-classic and github-pat-fine: GitHub token prefixes.
 *   - aws-access-key: an AKIA access-key id.
 *   - private-key: a PEM private-key begin marker.
 *   - bearer-token: an Authorization: Bearer header with a 20+ char token.
 *
 * ALLOWLIST (each entry exists to neutralise a specific, known false positive)
 *   - env-var-name: the bare name NPM_TOKEN and any secrets.* reference. These
 *     are names injected by CI at runtime, never values, so they must not fail.
 *   - portable-path: ~/..., /usr/bin, /usr/local/bin, /Applications, /snap/bin,
 *     /var/lib/flatpak/..., bare /tmp, %ProgramFiles% and %LOCALAPPDATA%. These
 *     are generic or user-relative, not machine-specific.
 *   - public-url: project URLs under github.com/GustavoGutierrez or
 *     gustavogutierrez.github.io, and the maintainer's intentionally public
 *     name.
 *
 * CREDENTIAL SAFETY. Findings never print a credential. A secret-shaped finding
 * is reported with a redacted placeholder and a character count. A path finding
 * normally shows the path so it stays actionable, but if its matched token or
 * file label embeds a credential (for example a token inside a temp-session
 * path) the whole match is redacted too. The guard therefore cannot become a
 * leak, in the tracked-file scan and the tarball scan alike.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Forbidden patterns. `secret: true` means the matched text must never be
 * printed; the report redacts it. Every regex is anchored with a lookbehind so
 * it does not fire on a longer identifier, and is built so the literal source
 * of this file cannot match itself.
 */
export const FORBIDDEN_RULES = [
  {
    id: "home-path",
    description: "absolute personal home directory path",
    secret: false,
    regex: /(?<![A-Za-z0-9._-])\/(?:home|Users)\/[A-Za-z0-9][A-Za-z0-9._-]*/g,
  },
  {
    id: "root-path",
    description: "root user home directory path",
    secret: false,
    regex: /(?<![A-Za-z0-9._-])\/root\//g,
  },
  {
    id: "windows-path",
    description: "Windows drive path under a Users directory",
    secret: false,
    regex: /(?<![A-Za-z0-9])[A-Za-z]:(?:[\\/]){1,2}Users(?:[\\/]){1,2}[A-Za-z0-9._-]+/g,
  },
  {
    id: "tmp-session",
    description: "session-specific path under the system temp directory",
    secret: false,
    regex: /(?<![A-Za-z0-9._-])\/tmp\/[^\s"'`)\]};,]+/g,
  },
  {
    id: "npm-auth-field",
    description: "npm registry auth-token config key",
    secret: true,
    regex: /_auth[A-Za-z]*[Tt]oken/g,
  },
  {
    id: "npm-token",
    description: "npm token value",
    secret: true,
    regex: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36,}/g,
  },
  {
    id: "github-pat-classic",
    description: "GitHub classic personal access token",
    secret: true,
    regex: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}/g,
  },
  {
    id: "github-pat-fine",
    description: "GitHub fine-grained personal access token",
    secret: true,
    regex: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    id: "aws-access-key",
    description: "AWS access-key id",
    secret: true,
    regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  },
  {
    id: "private-key",
    description: "PEM private-key begin marker",
    secret: true,
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: "bearer-token",
    description: "Authorization Bearer header with a long token",
    secret: true,
    regex: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  },
];

/** Path-shaped rule ids that the portable-path and public-url allowlists apply to. */
const PATH_RULE_IDS = new Set(["home-path", "root-path", "windows-path", "tmp-session"]);

/**
 * Non-global clones of the secret rules, used only to decide whether some other
 * text (a path finding's token or file label) embeds a credential and must be
 * redacted. The clones drop the `g` flag, so `test` is stateless and detection
 * never disturbs the `lastIndex` of the scanning regexes.
 */
const SECRET_DETECTORS = FORBIDDEN_RULES.filter((rule) => rule.secret).map(
  (rule) => new RegExp(rule.regex.source, rule.regex.flags.replace("g", "")),
);

/**
 * True when `text` contains any credential-shaped substring. A path rule can
 * match an entire temporary-directory or home-directory token that embeds a
 * credential, so a path finding is promoted to secret when this fires: the
 * report then redacts the whole match instead of printing the credential.
 *
 * Do not write a literal absolute path in this file, including inside comments:
 * the temporary-directory rule matches one and the guard would flag itself.
 */
export function containsSecretShape(text) {
  return SECRET_DETECTORS.some((detector) => detector.test(text));
}

/** Generic, user-relative, or OS-provided paths that are not machine-specific. */
const PORTABLE_PATHS = [
  /^~(?:\/.*)?$/, // home-relative, e.g. ~/.npmrc
  /^\/usr\/bin(?:\/.*)?$/,
  /^\/usr\/local\/bin(?:\/.*)?$/,
  /^\/Applications(?:\/.*)?$/,
  /^\/snap\/bin(?:\/.*)?$/,
  /^\/var\/lib\/flatpak(?:\/.*)?$/,
  /^\/tmp$/, // bare /tmp only; a session-suffixed path is a finding
  /^%ProgramFiles%(?:[\\/].*)?$/i,
  /^%LOCALAPPDATA%(?:[\\/].*)?$/i,
];

/**
 * Documented allowlist. Rules are deliberately narrow: a name allowlist only
 * neutralises secret-shaped matches, and a path allowlist only neutralises
 * path-shaped matches, so `NPM_TOKEN` cannot mask a real token on another line
 * and a portable path cannot mask a real one.
 */
export const ALLOWLIST = [
  {
    id: "env-var-name",
    reason: "NPM_TOKEN and secrets.* are CI-injected names, never values.",
    appliesTo: "secret",
    test: (token) => /\bNPM_TOKEN\b/.test(token) || /secrets\.[A-Za-z0-9_]+/.test(token),
  },
  {
    id: "portable-path",
    reason: "generic, user-relative, or OS-provided paths are not machine-specific.",
    appliesTo: "path",
    test: (token) => PORTABLE_PATHS.some((pattern) => pattern.test(token)),
  },
  {
    id: "public-url",
    reason: "public project URLs are intended to be published.",
    appliesTo: "path",
    test: (token, _line, match) => {
      const at = token.indexOf(match);
      return at > 0 && /https?:\/\//.test(token.slice(0, at));
    },
  },
];

/** The whitespace-delimited token containing a match, with common wrappers trimmed. */
function tokenAt(line, index, length) {
  let start = index;
  while (start > 0 && !/\s/.test(line[start - 1])) start -= 1;
  let end = index + length;
  while (end < line.length && !/\s/.test(line[end])) end += 1;
  return line
    .slice(start, end)
    .replace(/^[`"'([{<]+/, "")
    .replace(/[`"')\]}>.,;:]+$/, "");
}

/** True when a documented allowlist entry neutralises this finding. */
function isAllowlisted(rule, token, line, match) {
  const family = PATH_RULE_IDS.has(rule.id) ? "path" : "secret";
  return ALLOWLIST.some((entry) => entry.appliesTo === family && entry.test(token, line, match));
}

/**
 * Scan a text blob for forbidden shapes. Returns findings as
 * `{ file, line, rule, description, secret, match }`. The caller decides how to
 * print `match`; `secret: true` means it must be redacted.
 */
export function scanText(text, label) {
  const findings = [];
  if (text.includes("\u0000")) return findings; // binary, not text
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of FORBIDDEN_RULES) {
      rule.regex.lastIndex = 0;
      let match = rule.regex.exec(line);
      while (match !== null) {
        if (match.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
        const value = match[0];
        const token = tokenAt(line, match.index, value.length);
        if (!isAllowlisted(rule, token, line, value)) {
          findings.push({
            file: label,
            line: index + 1,
            rule: rule.id,
            description: rule.description,
            secret: rule.secret || containsSecretShape(value) || containsSecretShape(token),
            match: value,
          });
        }
        match = rule.regex.exec(line);
      }
    }
  }
  return findings;
}

/** Read one file from disk and scan it. Missing or binary files yield no findings. */
export function scanFile(path, label = path) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return []; // a tracked file deleted in the working tree is not a leak
  }
  if (buffer.includes(0)) return [];
  return scanText(buffer.toString("utf8"), label);
}

/** Repository root, derived from git so the guard works from any subdirectory. */
export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** Scan every file git tracks, reading the working-tree copy. */
export function scanTrackedFiles(root = repoRoot()) {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listed.split("\u0000").filter(Boolean);
  const findings = files.flatMap((file) => scanFile(join(root, file), file));
  return { scanned: files, findings };
}

/** Every regular file under a directory, as forward-slash relative paths. */
function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** Scan the text of every regular file inside a packed tarball. */
export function scanTarball(archive) {
  const path = resolve(archive);
  const temp = mkdtempSync(join(tmpdir(), "alisio-leak-scan-"));
  try {
    execFileSync("tar", ["-xzf", path, "-C", temp], { stdio: ["ignore", "ignore", "pipe"] });
    const files = walkFiles(temp);
    const findings = files.flatMap((file) => scanFile(join(temp, file), file));
    return { scanned: files, findings };
  } catch (error) {
    throw new Error(
      `cannot inspect tarball ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Pack one publishable package into a temp directory and scan its tarball. */
export function scanPackage(name) {
  const root = repoRoot();
  const short = name.startsWith("@alisio/plugin-") ? name.slice("@alisio/plugin-".length) : name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) throw new Error(`invalid package name: ${name}`);
  const dir = join(root, "packages", short);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    throw new Error(`no package at packages/${short}`);
  }
  if (manifest.name !== `@alisio/plugin-${short}`)
    throw new Error(`packages/${short} is not @alisio/plugin-${short}`);

  const temp = mkdtempSync(join(tmpdir(), "alisio-leak-pack-"));
  try {
    const packed = execFileSync("pnpm", ["--dir", dir, "pack", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
    });
    const archive = join(temp, basename(packed.trim().split("\n").at(-1)));
    return scanTarball(archive);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Render findings as a precise, credential-free report. */
export function formatFindings(findings) {
  return findings.map((finding) => {
    const shown =
      finding.secret || containsSecretShape(finding.match)
        ? `<redacted ${finding.match.length}-character value>`
        : finding.match;
    const label = containsSecretShape(finding.file)
      ? "<redacted file name containing a credential>"
      : finding.file;
    return `  ${label}:${finding.line}  [${finding.rule}] ${finding.description}\n      ${shown}`;
  });
}

const USAGE = [
  "Usage:",
  "  node scripts/leak-check.mjs                    scan tracked files (git ls-files)",
  "  node scripts/leak-check.mjs --tarball <path>   scan a packed .tgz",
  "  node scripts/leak-check.mjs --package <name>   pack one publishable package and scan it",
].join("\n");

function parseCli(argv) {
  if (argv.length === 0) return { mode: "tracked" };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.length === 2 && argv[0] === "--tarball") return { mode: "tarball", target: argv[1] };
  if (argv.length === 2 && argv[0] === "--package") return { mode: "package", target: argv[1] };
  throw new Error(`unknown arguments: ${argv.join(" ")}`);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (parsed.mode === "help") {
    console.log(USAGE);
    return 0;
  }

  let result;
  try {
    if (parsed.mode === "tracked") result = scanTrackedFiles();
    else if (parsed.mode === "tarball") result = scanTarball(parsed.target);
    else result = scanPackage(parsed.target);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (result.findings.length === 0) {
    console.log(`leak-check: clean (${result.scanned.length} file(s) scanned)`);
    return 0;
  }
  console.error(
    `leak-check: ${result.findings.length} finding(s) in ${result.scanned.length} file(s)`,
  );
  console.error(formatFindings(result.findings).join("\n"));
  console.error(
    "Remove the machine path or credential from the source, commit the fix, and retry.",
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
