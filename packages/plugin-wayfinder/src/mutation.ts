import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  MutationConcurrency,
  MutationScopeMode,
  MutationScopeSupport,
  MutationStack,
  MutationSurvivor,
} from "./types.js";

/** Hard bounds that keep every mutation phase scoped, concurrent, and time-boxed. */
export const mutationBounds = {
  concurrency: 2,
  scopeLimit: 20,
  survivorLimit: 50,
  timeoutMs: 600_000,
} as const;

/** Mutation remediation runs on its own budget so it cannot starve verification remediation. */
export const mutationRemediationLimit = 2;

export interface MutationTool {
  name: string;
  scopeSupport: MutationScopeSupport;
  concurrency: MutationConcurrency;
  build: (scope: string[], mode: MutationScopeMode) => string[];
}

export interface MutationEnvironment {
  stack: MutationStack;
  candidates: MutationStack[];
  markers: string[];
  packageManager?: string;
  tool?: MutationTool;
}

export interface MutationPlan {
  available: boolean;
  stack: MutationStack;
  tool?: string;
  mode: MutationScopeMode;
  scopeSupport: MutationScopeSupport;
  concurrency: number;
  concurrencyApplied: boolean;
  timeoutMs: number;
  survivorLimit: number;
  scope: string[];
  command: string;
  args: string[];
  reason?: string;
}

const stackMarkers: Array<{ stack: MutationStack; files: string[] }> = [
  { stack: "javascript", files: ["package.json"] },
  { stack: "rust", files: ["Cargo.toml"] },
  {
    stack: "python",
    files: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini"],
  },
  { stack: "go", files: ["go.mod"] },
  { stack: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
];

const scopePathPattern = /^[A-Za-z0-9._/ -]+$/;

/**
 * Stricter than `assertRelativePath`: mutation scope is handed to a child process as an argument
 * list, so it allows only letters, digits, `-`, `_`, `.`, space, and `/`. A segment that starts with
 * `-` is rejected so a path can never be mistaken for a CLI flag. Spaces stay allowed because the
 * scope is always passed as a single argv element (never re-joined into a shell string).
 */
export function assertScopePath(path: string): string {
  if (
    !path ||
    path.length > 512 ||
    path !== path.trim() ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    !scopePathPattern.test(path)
  ) {
    throw new Error(`Unsafe mutation scope path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("-"))) {
    throw new Error(`Unsafe mutation scope path: ${path}`);
  }
  return path;
}

const testPathSegments = new Set(["test", "tests", "__tests__"]);
const testPathBaseNames = new Set(["test", "tests", "spec", "specs"]);
const testFileMarkers = [".test.", ".spec.", "_test.", "Test.", "Spec."];

/**
 * Heuristic used to enforce that a `test-strengthening` unit edits tests only.
 * Matches a `test`/`tests`/`__tests__` path segment, a bare `test`/`tests`/`spec`/`specs` filename,
 * or a test-style filename. It is a guardrail over reported paths, not a hard sandbox.
 */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => testPathSegments.has(part))) return true;
  const file = parts[parts.length - 1] ?? "";
  const base = file.includes(".") ? file.slice(0, file.indexOf(".")) : file;
  if (testPathBaseNames.has(base)) return true;
  return testFileMarkers.some((marker) => file.includes(marker));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function anyFile(workspace: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (await isFile(join(workspace, file))) return true;
  }
  return false;
}

async function manifestContains(
  workspace: string,
  files: string[],
  needles: string[],
): Promise<boolean> {
  for (const file of files) {
    const text = await readText(join(workspace, file));
    if (text && needles.some((needle) => text.includes(needle))) return true;
  }
  return false;
}

export async function detectStack(
  workspace: string,
): Promise<{ stack: MutationStack; candidates: MutationStack[]; markers: string[] }> {
  const candidates: MutationStack[] = [];
  const markers: string[] = [];
  for (const entry of stackMarkers) {
    let matched = false;
    for (const file of entry.files) {
      if (await isFile(join(workspace, file))) {
        markers.push(file);
        matched = true;
      }
    }
    if (matched) candidates.push(entry.stack);
  }
  return { stack: candidates[0] ?? "unknown", candidates, markers };
}

async function detectPackageManager(workspace: string): Promise<string | undefined> {
  if (await isFile(join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (await isFile(join(workspace, "yarn.lock"))) return "yarn";
  if ((await isFile(join(workspace, "bun.lockb"))) || (await isFile(join(workspace, "bun.lock")))) {
    return "bun";
  }
  if (await isFile(join(workspace, "package-lock.json"))) return "npm";
  return undefined;
}

function strykerBuild(packageManager: string | undefined): MutationTool["build"] {
  const runner =
    packageManager === "pnpm"
      ? ["pnpm", "exec"]
      : packageManager === "yarn"
        ? ["yarn", "exec"]
        : packageManager === "bun"
          ? ["bunx", "--no-install"]
          : ["npx", "--no-install"];
  return (scope) => {
    const mutate = scope.length ? ["--mutate", scope.join(",")] : [];
    return [
      ...runner,
      "stryker",
      "run",
      ...mutate,
      "--concurrency",
      String(mutationBounds.concurrency),
      "--reporters",
      "json",
    ];
  };
}

function rustBuild(): MutationTool["build"] {
  return (scope) => {
    const files = scope.flatMap((file) => ["--file", file]);
    return [
      "cargo",
      "mutants",
      "--jobs",
      String(mutationBounds.concurrency),
      "--timeout",
      String(Math.ceil(mutationBounds.timeoutMs / 1000)),
      ...files,
    ];
  };
}

function pythonBuild(tool: string): MutationTool["build"] {
  return (scope) => {
    if (tool === "cosmic-ray") return ["cosmic-ray", "exec", "cosmic-ray.sqlite"];
    const paths = scope.length ? ["--paths-to-mutate", scope.join(",")] : [];
    return ["mutmut", "run", ...paths];
  };
}

function goBuild(tool: string): MutationTool["build"] {
  return (scope) => {
    const targets = scope.length ? scope.map((file) => `./${file}`) : ["./..."];
    if (tool === "go-mutesting") return ["go-mutesting", ...targets];
    return ["gremlins", "unleash", "--workers", String(mutationBounds.concurrency), ...targets];
  };
}

function javaBuild(gradleWrapper: boolean, gradle: boolean): MutationTool["build"] {
  return () => {
    if (gradle) return gradleWrapper ? ["./gradlew", "pitest"] : ["gradle", "pitest"];
    return ["mvn", "-q", "org.pitest:pitest-maven:mutationCoverage"];
  };
}

async function detectTool(
  workspace: string,
  stack: MutationStack,
  packageManager: string | undefined,
): Promise<MutationTool | undefined> {
  if (stack === "javascript") {
    const raw = await readText(join(workspace, "package.json"));
    let declared = false;
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const sections = ["dependencies", "devDependencies", "optionalDependencies"];
        declared = sections.some((section) => {
          const deps = pkg[section];
          return (
            Boolean(deps) &&
            typeof deps === "object" &&
            !Array.isArray(deps) &&
            Object.keys(deps as Record<string, unknown>).some(
              (name) => name === "@stryker-mutator/core" || name.startsWith("@stryker-mutator/"),
            )
          );
        });
      } catch {
        declared = false;
      }
    }
    const config = await anyFile(workspace, [
      ".stryker.conf.js",
      ".stryker.conf.cjs",
      ".stryker.conf.mjs",
      ".stryker.conf.json",
      "stryker.config.js",
      "stryker.config.cjs",
      "stryker.config.mjs",
      "stryker.config.json",
    ]);
    const binary = await isFile(join(workspace, "node_modules/.bin/stryker"));
    if (!declared && !config && !binary) return undefined;
    return {
      name: "stryker",
      scopeSupport: "paths",
      concurrency: "applied",
      build: strykerBuild(packageManager),
    };
  }
  if (stack === "rust") {
    if (await manifestContains(workspace, ["Cargo.toml"], ["cargo-mutants"])) {
      return {
        name: "cargo-mutants",
        scopeSupport: "paths",
        concurrency: "applied",
        build: rustBuild(),
      };
    }
    return undefined;
  }
  if (stack === "python") {
    const files = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini"];
    if (await manifestContains(workspace, files, ["mutmut"])) {
      return {
        name: "mutmut",
        scopeSupport: "paths",
        concurrency: "unsupported",
        build: pythonBuild("mutmut"),
      };
    }
    if (await manifestContains(workspace, files, ["cosmic-ray", "cosmic_ray"])) {
      return {
        name: "cosmic-ray",
        scopeSupport: "none",
        concurrency: "unsupported",
        build: pythonBuild("cosmic-ray"),
      };
    }
    return undefined;
  }
  if (stack === "go") {
    if (await manifestContains(workspace, ["go.mod", "go.sum"], ["gremlins"])) {
      return {
        name: "gremlins",
        scopeSupport: "paths",
        concurrency: "applied",
        build: goBuild("gremlins"),
      };
    }
    if (await manifestContains(workspace, ["go.mod", "go.sum"], ["go-mutesting"])) {
      return {
        name: "go-mutesting",
        scopeSupport: "paths",
        concurrency: "unsupported",
        build: goBuild("go-mutesting"),
      };
    }
    return undefined;
  }
  if (stack === "java") {
    if (await manifestContains(workspace, ["pom.xml"], ["pitest", "org.pitest"])) {
      return {
        name: "pitest",
        scopeSupport: "none",
        concurrency: "unsupported",
        build: javaBuild(false, false),
      };
    }
    if (await manifestContains(workspace, ["build.gradle", "build.gradle.kts"], ["pitest"])) {
      const wrapper = await isFile(join(workspace, "gradlew"));
      return {
        name: "pitest",
        scopeSupport: "none",
        concurrency: "unsupported",
        build: javaBuild(wrapper, true),
      };
    }
    return undefined;
  }
  return undefined;
}

export async function inspectMutationEnvironment(workspace: string): Promise<MutationEnvironment> {
  const detected = await detectStack(workspace);
  const packageManager =
    detected.stack === "javascript" ? await detectPackageManager(workspace) : undefined;
  const tool = await detectTool(workspace, detected.stack, packageManager);
  return {
    ...detected,
    ...(packageManager !== undefined ? { packageManager } : {}),
    ...(tool !== undefined ? { tool } : {}),
  };
}

function boundedScope(
  paths: string[],
  mode: MutationScopeMode,
): { scope: string[]; reason?: string } {
  if (mode === "full") return { scope: [] };
  const scope: string[] = [];
  for (const raw of paths) {
    let safe: string;
    try {
      safe = assertScopePath(raw);
    } catch {
      continue;
    }
    if (!scope.includes(safe)) scope.push(safe);
    if (scope.length >= mutationBounds.scopeLimit) break;
  }
  if (!scope.length) {
    return {
      scope: [],
      reason: paths.length
        ? "Changed paths could not be safely scoped for mutation testing."
        : "No changed paths were available to scope mutation testing.",
    };
  }
  return { scope };
}

function unavailableReason(environment: MutationEnvironment): string {
  if (environment.stack === "unknown") {
    return "No supported language stack was detected for mutation testing.";
  }
  return `No already-installed mutation tooling was detected for ${environment.stack}.`;
}

export function buildMutationPlan(
  environment: MutationEnvironment,
  options: { mode: MutationScopeMode; changedPaths: string[] },
): MutationPlan {
  const tool = environment.tool;
  const scopeSupport = tool?.scopeSupport ?? "none";
  const base = {
    stack: environment.stack,
    mode: options.mode,
    scopeSupport,
    concurrency: mutationBounds.concurrency,
    concurrencyApplied: tool?.concurrency === "applied",
    timeoutMs: mutationBounds.timeoutMs,
    survivorLimit: mutationBounds.survivorLimit,
  };
  const scoped = boundedScope(options.changedPaths, options.mode);
  if (options.mode === "changed" && scoped.scope.length === 0) {
    return {
      ...base,
      available: false,
      scope: [],
      command: "",
      args: [],
      ...(scoped.reason !== undefined ? { reason: scoped.reason } : {}),
    };
  }
  if (!tool) {
    return {
      ...base,
      available: false,
      scope: scoped.scope,
      command: "",
      args: [],
      reason: unavailableReason(environment),
    };
  }
  if (options.mode === "changed" && tool.scopeSupport === "none") {
    return {
      ...base,
      available: false,
      scope: scoped.scope,
      command: "",
      args: [],
      reason: `${tool.name} can only run whole-repository mutation; re-run with --mode full to allow it explicitly.`,
    };
  }
  const args = tool.build(scoped.scope, options.mode);
  return {
    ...base,
    available: true,
    tool: tool.name,
    scope: scoped.scope,
    command: args.join(" "),
    args,
  };
}

export function nonEquivalentSurvivors(survivors: MutationSurvivor[]): MutationSurvivor[] {
  return survivors.filter((survivor) => !survivor.equivalent);
}

export function boundedSurvivors(survivors: MutationSurvivor[]): {
  survivors: MutationSurvivor[];
  truncated: boolean;
} {
  if (survivors.length <= mutationBounds.survivorLimit) return { survivors, truncated: false };
  return { survivors: survivors.slice(0, mutationBounds.survivorLimit), truncated: true };
}
