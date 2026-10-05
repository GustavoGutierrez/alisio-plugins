#!/usr/bin/env node
/**
 * Render authored Mermaid diagrams to SVG for the publishable packages.
 *
 *   node scripts/render-diagrams.mjs --plugin=plugin-wayfinder
 *   node scripts/render-diagrams.mjs --plugin=plugin-wayfinder,other --plugin=third
 *   node scripts/render-diagrams.mjs --all
 *   node scripts/render-diagrams.mjs --all --check
 *
 * Sources live at the REPOSITORY ROOT, one directory per plugin:
 *
 *   diagrams/<plugin-name>/*.mmd
 *
 * Rendered output lives inside the publishable package, next to the README
 * that embeds it:
 *
 *   packages/<plugin-name>/assets/<same-base>.svg
 *
 * An optional `mermaid.config.json` beside the sources is passed to the CLI via
 * `-c`. Wayfinder pins `look: classic` there, because Mermaid 12 changed the
 * default look and the older diagrams are authored for the classic rendering.
 *
 * A target can also render to a repository-level directory instead of a package.
 * When a `diagram.config.json` sits beside the sources and declares an `output`
 * directory relative to the repository root, the target is a repository-level
 * one: its SVGs go there and no `packages/<name>` directory is required. This is
 * an explicit, per-target opt-in rather than a silent fallback, so a mistyped or
 * misconfigured target still fails. The repository-level diagrams live in
 * `diagrams/repository/` and declare `{"output": "assets"}`, writing the shared
 * `assets/` directory the root READMEs embed from.
 *
 * BACKGROUND AND PADDING. Rendered SVGs get an opaque WHITE background (#ffffff)
 * and 24px of padding on every side by default, so lines stay visible on dark
 * themes. Mermaid CLI has no padding option, so the SVG is post-processed (see
 * `scripts/lib/diagram-style.mjs`): the renderer is run with `-b white`, then a
 * full-size background <rect> is inserted and the viewBox/width/height/max-width
 * grow by the padding. Override per target in `diagram.config.json`:
 *
 *   { "background": "#f5f5f5", "padding": 16 }   // CSS color or "transparent"; integer 0-200
 *   { "background": "transparent", "padding": 0 } // opt out entirely
 *
 * `output` is optional there; a file with only style keys keeps the default
 * `packages/<name>/assets` output. Invalid values fail with a clear error.
 *
 * WHY THE SOURCES SIT AT THE REPOSITORY ROOT. `pnpm-workspace.yaml` declares
 * `packages/*`, so a `diagrams/` directory placed under `packages/` would be
 * swallowed by the workspace glob and treated as a workspace package. Keeping
 * the sources one level up avoids that and keeps the published tarball clean:
 * only `assets/`, never the `.mmd` sources, ship to the registry.
 *
 * WHY A BROWSER. Mermaid renders in a real browser engine. This script uses a
 * Chrome-family browser that is ALREADY installed on the machine -- Chrome,
 * Chromium, Brave, or Edge -- and never downloads one. Puppeteer's bundled
 * download is roughly 300 MB, and asking for a diagram should not pull that
 * down as a side effect.
 *
 * WHY `--check` EXISTS. Rendering needs a browser; a staleness check does not.
 * Comparing source and output mtimes lets a review machine -- or a machine
 * with no browser at all -- report what changed without rendering anything.
 *
 * WHY @mermaid-js/mermaid-cli@12.0.0 AND NOT @11. The use case diagram landed in
 * Mermaid 12.0.0 behind the `usecase-beta` keyword; there is no backport. Probed
 * empirically: CLI 11.16.0 (mermaid 11.16.1) and the newest 11.x, CLI 11.17.0
 * (mermaid 11.17.2), both fail with "UnknownDiagramError: No diagram type
 * detected ... for text: usecase-beta". CLI 12.0.0 (mermaid 12.0.0) renders all
 * ten documented types, so it is the LOWEST version that covers them. Pinned
 * exactly rather than with a range so a later patch cannot silently change the
 * committed SVGs. Override with MERMAID_CLI_VERSION when needed.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDiagramStyle, resolveDiagramStyle } from "./lib/diagram-style.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIAGRAMS_ROOT = path.join(REPO_ROOT, "diagrams");
const PACKAGES_ROOT = path.join(REPO_ROOT, "packages");
const HOME = process.env.HOME || process.env.USERPROFILE || "";

/** npx is a shell script on POSIX and a batch wrapper on Windows. */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/** The mermaid-cli spec npx resolves and runs. Overridable for pinning. */
const CLI_SPEC = process.env.MERMAID_CLI_VERSION || "@mermaid-js/mermaid-cli@12.0.0";

/**
 * Optional per-target declaration that redirects a diagram target to a
 * repository-level output directory. See the header for the policy.
 */
const DIAGRAM_CONFIG = "diagram.config.json";

function parseArgs(argv) {
  const args = { plugins: [], all: false, check: false, noSandbox: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takePlugin = (value) => {
      for (const name of value.split(",")) {
        const trimmed = name.trim();
        if (trimmed) args.plugins.push(trimmed);
      }
    };
    if (arg.startsWith("--plugin=")) takePlugin(arg.slice("--plugin=".length));
    else if (arg === "--plugin") {
      i += 1;
      takePlugin(argv[i] ?? "");
    } else if (arg === "--all") args.all = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--no-sandbox") args.noSandbox = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument "${arg}".`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/render-diagrams.mjs <selection> [--check] [--no-sandbox]",
    "",
    "  --plugin=<name>   Render one plugin; repeat the flag or comma-separate names.",
    "  --all             Render every directory under diagrams/.",
    "  --check           Report stale or missing SVGs and exit non-zero. No browser needed.",
    "  --no-sandbox      Add --no-sandbox to the browser args (containers/root only).",
    "",
    `  A target with ${DIAGRAM_CONFIG} beside its sources renders to that`,
    '  repository-relative "output" directory instead of packages/<name>/assets.',
    '  It may also set "background" (CSS color or "transparent"; default #ffffff)',
    '  and "padding" (integer px, 0-200; default 24).',
    "",
    `  MERMAID_CLI_VERSION   Override the npx spec (default ${CLI_SPEC}).`,
    "  MERMAID_BROWSER       Explicit browser executable; also PUPPETEER_EXECUTABLE_PATH.",
  ].join("\n");
}

/** Plugin names that have a directory under diagrams/. */
function knownTargets() {
  if (!existsSync(DIAGRAMS_ROOT)) return [];
  return readdirSync(DIAGRAMS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Absolute install locations for a Chrome-family browser, per platform.
 *
 * These are checked with existsSync; the list is deliberately explicit rather
 * than a glob so a failure can name exactly what was looked for.
 */
function knownBrowserPaths() {
  const candidates = [];
  if (process.platform === "win32") {
    const bases = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const relatives = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
    ];
    for (const base of bases)
      for (const relative of relatives) candidates.push(path.join(base, ...relative));
  } else if (process.platform === "darwin") {
    const bases = ["/Applications", path.join(HOME, "Applications")];
    const relatives = [
      ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
      ["Brave Browser.app", "Contents", "MacOS", "Brave Browser"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
      ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"],
    ];
    for (const base of bases)
      for (const relative of relatives) candidates.push(path.join(base, ...relative));
  } else {
    const dirs = [
      "/usr/bin",
      "/usr/local/bin",
      "/opt/google/chrome",
      "/snap/bin",
      "/var/lib/flatpak/exports/bin",
      path.join(HOME, ".local", "bin"),
    ];
    const names = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
      "com.brave.Browser",
      "com.google.Chrome",
      "org.chromium.Chromium",
      "chrome",
    ];
    for (const dir of dirs) for (const name of names) candidates.push(path.join(dir, name));
  }
  return candidates;
}

/** Executable names looked up on PATH with `where` (Windows) or `which`. */
function pathBrowserNames() {
  if (process.platform === "win32") return ["chrome", "brave", "msedge", "chromium"];
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ];
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * The browser Mermaid renders in, resolved in a fixed precedence order:
 *
 *   1. An explicit override (MERMAID_BROWSER, then PUPPETEER_EXECUTABLE_PATH).
 *   2. Known absolute install paths for this platform.
 *   3. A PATH lookup that never opens a shell.
 *
 * Returns `{ browser, searched }`; `browser` is null when nothing was found.
 */
function findBrowser() {
  const searched = { overrides: [], absolute: [], path: pathBrowserNames() };

  const overrides = [
    ["MERMAID_BROWSER", process.env.MERMAID_BROWSER],
    ["PUPPETEER_EXECUTABLE_PATH", process.env.PUPPETEER_EXECUTABLE_PATH],
  ];
  for (const [key, value] of overrides) {
    if (!value) continue;
    searched.overrides.push(`${key}=${value}`);
    if (existsSync(value)) return { browser: value, searched };
  }

  const absolute = knownBrowserPaths();
  searched.absolute = absolute;
  for (const candidate of dedupe(absolute)) {
    if (existsSync(candidate)) return { browser: candidate, searched };
  }

  // `where`/`which` are OS binaries invoked without a shell, so this works on
  // every platform and never depends on POSIX syntax or /bin/bash.
  const lookup = process.platform === "win32" ? "where" : "which";
  for (const name of searched.path) {
    try {
      const found = execFileSync(lookup, [name], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      if (found) return { browser: found, searched };
    } catch {
      // Not on PATH; try the next candidate name.
    }
  }

  return { browser: null, searched };
}

function browserNotFoundMessage(searched) {
  const lines = [
    "No Chrome-family browser found. Mermaid renders in a real browser, and this",
    "script never downloads one (Puppeteer's bundled copy is roughly 300 MB).",
    "",
    "Set MERMAID_BROWSER (or PUPPETEER_EXECUTABLE_PATH) to an installed browser",
    "executable to point at it explicitly.",
    "",
  ];
  if (searched.overrides.length)
    lines.push(`Override(s) not found: ${searched.overrides.join(", ")}`);
  lines.push(`Absolute paths checked on ${process.platform}:`);
  for (const candidate of dedupe(searched.absolute)) lines.push(`  ${candidate}`);
  lines.push(`PATH names looked up via "${process.platform === "win32" ? "where" : "which"}":`);
  lines.push(`  ${searched.path.join(", ")}`);
  return lines.join("\n");
}

/** Sources for one target, sorted, or [] when the directory has none. */
function sourceFiles(name) {
  const dir = path.join(DIAGRAMS_ROOT, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".mmd"))
    .sort();
}

function outputPath(name, source) {
  return path.join(outputDir(name), source.replace(/\.mmd$/, ".svg"));
}

/**
 * The output directory for one target, from an explicit declaration only.
 *
 *   diagrams/<name>/diagram.config.json  { "output": "assets" }
 *
 * Without a declaration the target renders into its publishable package at
 * `packages/<name>/assets`. With one it may render anywhere INSIDE the
 * repository; an output that escapes the repository root is rejected. There is
 * deliberately no fallback: an undeclared target still needs its package
 * directory, so a typo cannot silently write somewhere unexpected.
 */
function outputDir(name) {
  return targetConfig(name)?.output ?? path.join(PACKAGES_ROOT, name, "assets");
}

/**
 * Parses `diagram.config.json` for a target, or returns undefined when absent.
 * Throws with a clear message when the file is present but malformed, so an
 * invalid declaration is reported rather than ignored.
 */
function targetConfig(name) {
  const file = path.join(DIAGRAMS_ROOT, name, DIAGRAM_CONFIG);
  if (!existsSync(file)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${DIAGRAM_CONFIG} for "${name}": ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${DIAGRAM_CONFIG} for "${name}" must be a JSON object`);
  const style = resolveDiagramStyle(parsed, name);
  if (!("output" in parsed)) return { style };
  if (typeof parsed.output !== "string" || !parsed.output.trim())
    throw new Error(`${DIAGRAM_CONFIG} for "${name}" must declare a non-empty "output" directory`);
  const output = path.resolve(REPO_ROOT, parsed.output);
  if (output !== REPO_ROOT && !output.startsWith(`${REPO_ROOT}${path.sep}`))
    throw new Error(
      `${DIAGRAM_CONFIG} for "${name}" output must stay inside the repository: ${parsed.output}`,
    );
  return { output, style };
}

/** Background and padding for one target: the config's values over the defaults. */
function targetStyle(name) {
  return targetConfig(name)?.style ?? resolveDiagramStyle({}, name);
}

/**
 * A diagram is stale when its SVG is missing or older than its source, or when
 * the shared `mermaid.config.json` beside the sources is newer than the SVG.
 *
 * LIMITATION: this is an mtime comparison, not a content hash. A fresh CI
 * checkout can give every file the same checkout timestamp, so a committed SVG
 * can look younger than its source even when the content is current. That is
 * why `diagrams:check` is NOT part of `pnpm check`: it is a local authoring
 * aid, not a reproducible CI gate.
 */
function staleSources(name) {
  const dir = path.join(DIAGRAMS_ROOT, name);
  const config = path.join(dir, "mermaid.config.json");
  const configTime = existsSync(config) ? statSync(config).mtimeMs : 0;
  return sourceFiles(name).filter((source) => {
    const output = outputPath(name, source);
    if (!existsSync(output)) return true;
    const outputTime = statSync(output).mtimeMs;
    if (statSync(path.join(dir, source)).mtimeMs > outputTime) return true;
    return configTime > outputTime;
  });
}

/**
 * cmd.exe metacharacter escaping, ported from cross-spawn's escape.js (MIT).
 *
 * WHY A SHELL REMAINS NECESSARY ON WINDOWS. `npx` is a `.cmd` shim there. Since
 * the CVE-2024-27980 fix, Node errors with EINVAL when a `.bat`/`.cmd` file is
 * passed to spawn/execFile with `shell: false`, and `shell: true` is deprecated
 * (DEP0190) because it concatenates arguments without escaping. The documented
 * workaround is to spawn `cmd.exe` explicitly and escape every argument, which
 * is what this does: `& | < > ( )` and spaces can no longer be reinterpreted,
 * and `%` expansion is neutralized.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(arg) {
  return arg.replace(CMD_META, "^$1");
}

function escapeCmdArgument(arg) {
  // Based on https://qntm.org/cmd: double backslashes before a quote, then
  // double trailing backslashes, then quote and caret-escape metacharacters.
  let value = `${arg}`;
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  value = value.replace(/(?=(\\+?)?)\1$/, "$1$1");
  value = `"${value}"`;
  return value.replace(CMD_META, "^$1");
}

/**
 * The argv for one renderer run. POSIX runs `npx` directly with no shell, so the
 * arguments are passed verbatim as argv. Windows routes the escaped command
 * through cmd.exe with `windowsVerbatimArguments` so Node adds no further
 * quoting of its own.
 */
function rendererInvocation(cliArgs) {
  if (process.platform !== "win32") {
    return { file: NPX, args: cliArgs, options: { shell: false } };
  }
  const command = [escapeCmdCommand(NPX), ...cliArgs.map(escapeCmdArgument)].join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    options: { shell: false, windowsVerbatimArguments: true },
  };
}

function render(browser, targets, noSandbox) {
  const env = {
    ...process.env,
    PUPPETEER_SKIP_DOWNLOAD: "1",
    PUPPETEER_EXECUTABLE_PATH: browser,
  };

  let sandboxDir = null;
  let puppeteerConfig;
  if (noSandbox) {
    sandboxDir = mkdtempSync(path.join(tmpdir(), "alisio-diagrams-"));
    puppeteerConfig = path.join(sandboxDir, "puppeteer.config.json");
    writeFileSync(
      puppeteerConfig,
      `${JSON.stringify({ args: ["--no-sandbox"] }, null, 2)}\n`,
      "utf8",
    );
  }

  try {
    let rendered = 0;
    for (const name of targets) {
      const sources = sourceFiles(name);
      if (sources.length === 0) {
        console.log(`${name}: no .mmd sources, nothing to render.`);
        continue;
      }
      const assetsDir = outputDir(name);
      mkdirSync(assetsDir, { recursive: true });
      const config = path.join(DIAGRAMS_ROOT, name, "mermaid.config.json");
      for (const source of sources) {
        const input = path.join(DIAGRAMS_ROOT, name, source);
        const output = outputPath(name, source);
        const display = path.relative(REPO_ROOT, output);
        process.stdout.write(`  ${name}/${source} -> ${display} ... `);
        const cliArgs = [
          "-y",
          CLI_SPEC,
          "-i",
          input,
          "-o",
          output,
          // White here; the configured background and padding are applied to the
          // generated SVG afterwards (applyDiagramStyle). Mermaid CLI cannot pad.
          "-b",
          "white",
        ];
        if (existsSync(config)) cliArgs.push("-c", config);
        if (puppeteerConfig) cliArgs.push("-p", puppeteerConfig);
        const invocation = rendererInvocation(cliArgs);
        try {
          execFileSync(invocation.file, invocation.args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
            ...invocation.options,
          });
          writeFileSync(
            output,
            applyDiagramStyle(readFileSync(output, "utf8"), targetStyle(name)),
            "utf8",
          );
          console.log("ok");
          rendered += 1;
        } catch (error) {
          console.log("FAILED");
          const detail = String(error.stderr || error.stdout || error.message).trim();
          if (detail) console.error(detail);
          // Throw rather than exit so the `finally` below still removes the
          // temporary --no-sandbox directory before the process ends.
          throw new Error("render failed");
        }
      }
    }
    console.log(`Rendered ${rendered} diagram(s).`);
  } finally {
    if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exit(2);
  }

  const targets = knownTargets();
  const known = targets.length ? targets.join(", ") : "(none)";

  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (args.all && args.plugins.length > 0) {
    console.error(
      `Cannot combine --all with --plugin (got ${args.plugins.join(", ")}); pass exactly one selection.\n\n${usage()}`,
    );
    process.exit(2);
  }

  if (!args.all && args.plugins.length === 0) {
    console.error(
      `Nothing selected. Pass --plugin=<name> or --all.\nKnown diagram targets: ${known}.`,
    );
    process.exit(2);
  }

  const selected = args.all ? targets : dedupe(args.plugins);
  if (!args.all) {
    const unknown = selected.filter((name) => !targets.includes(name));
    if (unknown.length) {
      console.error(
        `Unknown diagram target(s): ${unknown.join(", ")}.\nKnown diagram targets: ${known}.`,
      );
      process.exit(2);
    }
  }

  if (selected.length === 0) {
    console.error(`No diagram targets found under diagrams/.\nKnown diagram targets: ${known}.`);
    process.exit(2);
  }

  try {
    for (const name of selected) {
      // A declared output directory makes the target repository-level: no package
      // is required. Without a declaration the package must exist, so a typo is
      // still an error rather than a silent write into packages/<typo>/assets.
      if (targetConfig(name)?.output) continue;
      if (!isDirectory(path.join(PACKAGES_ROOT, name))) {
        console.error(
          `Diagram target "${name}" has no package directory at packages/${name} and no ${DIAGRAM_CONFIG}.`,
        );
        process.exit(2);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (args.check) {
    let staleCount = 0;
    for (const name of selected) {
      const stale = staleSources(name);
      if (stale.length === 0) continue;
      staleCount += stale.length;
      for (const source of stale) {
        const display = path.relative(REPO_ROOT, outputPath(name, source));
        console.error(`stale or missing: ${display} (from ${name}/${source})`);
      }
    }
    if (staleCount > 0) {
      const hint = args.all
        ? "pnpm diagrams"
        : `node scripts/render-diagrams.mjs --plugin=${selected.join(",")}`;
      console.error(`${staleCount} diagram(s) are stale or missing. Run: ${hint}`);
      process.exit(1);
    }
    console.log(`All ${selected.length} diagram target(s) are up to date.`);
    process.exit(0);
  }

  const { browser, searched } = findBrowser();
  if (!browser) {
    console.error(browserNotFoundMessage(searched));
    process.exit(1);
  }
  console.log(`Browser: ${browser}`);
  console.log(`Renderer: npx -y ${CLI_SPEC}`);
  try {
    render(browser, selected, args.noSandbox);
  } catch {
    // render() already reported the failure and its `finally` removed the
    // temporary --no-sandbox directory; exit non-zero only after that cleanup.
    process.exit(1);
  }
}

function isDirectory(candidate) {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

main();
