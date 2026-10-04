import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { typstInstallDir } from "../../../cache.js";
import type { Finding } from "../../../types.js";
import { typstPins, typstVersion } from "../../../typst-pins.js";
import type { Availability } from "../../port.js";
import { parseTypstVersion, typstVersionOk } from "./version.js";

const execFileAsync = promisify(execFile);

export const compileTimeoutMs = 120_000;
/** Any network access from Typst must fail: nothing outside the vendored packages is allowed. */
export const proxyGuard = "http://127.0.0.1:9";

export interface EngineDeps {
  /** Run `<binary> --version` and return its stdout; rejects when the binary cannot run. */
  version(binary: string): Promise<string>;
  isExecutable(path: string): Promise<boolean>;
  platform: string;
  arch: string;
}

const defaultDeps = (): EngineDeps => ({
  async version(binary) {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout;
  },
  async isExecutable(path) {
    try {
      await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  platform: process.platform,
  arch: process.arch,
});

async function findOnPath(env: NodeJS.ProcessEnv, deps: EngineDeps): Promise<string | undefined> {
  const names = deps.platform === "win32" ? ["typst.exe", "typst.cmd"] : ["typst"];
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await deps.isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

async function check(binary: string, source: string, deps: EngineDeps): Promise<Availability> {
  let output: string;
  try {
    output = await deps.version(binary);
  } catch {
    return { available: false, reason: `${source}: the Typst binary could not be run` };
  }
  const version = parseTypstVersion(output);
  if (!version)
    return { available: false, reason: `${source}: the Typst version could not be read` };
  const text = version.join(".");
  if (!typstVersionOk(version)) {
    return {
      available: false,
      reason: `${source}: Typst ${text} is older than the required 0.15.0`,
    };
  }
  return { available: true, engine: `typst ${text}`, version: text, source, path: binary };
}

/**
 * Engine resolution order (spec 10.6): `ALISIO_THESIS_TYPST`, then `typst` on PATH, then the
 * binary installed by `/thesis:setup`. An explicit override that does not work is reported as is:
 * it never silently falls through to another engine.
 */
export async function resolveTypst(
  env: NodeJS.ProcessEnv,
  cacheRootPath: string,
  overrides: Partial<EngineDeps> = {},
): Promise<Availability> {
  const deps = { ...defaultDeps(), ...overrides };
  if (env.ALISIO_THESIS_TYPST) return check(env.ALISIO_THESIS_TYPST, "ALISIO_THESIS_TYPST", deps);
  const onPath = await findOnPath(env, deps);
  if (onPath) {
    const found = await check(onPath, "PATH", deps);
    if (found.available) return found;
  }
  const pin = typstPins[`${deps.platform}-${deps.arch}`];
  if (pin) {
    const cached = join(typstInstallDir(cacheRootPath, typstVersion), pin.executable);
    if (await deps.isExecutable(cached)) {
      const found = await check(cached, "setup cache", deps);
      if (found.available) return found;
    }
  }
  return {
    available: false,
    reason: "No Typst 0.15 engine was found (ALISIO_THESIS_TYPST, PATH, setup cache)",
    hint: "Run /thesis:setup to install the pinned Typst, or set ALISIO_THESIS_TYPST to a Typst 0.15 binary.",
  };
}

export interface TypstRun {
  binary: string;
  /** Directory holding main.typ; also the `--root`. */
  buildDir: string;
  /** Per-build empty package cache directory. */
  packageCache: string;
  /** Vendored packages root (contains `preview/`). */
  packagePath: string;
  input: string;
  output: string;
  fontPaths?: string[];
  ignoreSystemFonts?: boolean;
  pdfa?: boolean;
  /** Export HTML (experimental feature of Typst) instead of PDF; used to read rendered citations. */
  html?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** The argv for one compile. Exported for tests: the process is always spawned without a shell. */
export function compileArgs(run: TypstRun): string[] {
  const args = [
    "compile",
    "--root",
    run.buildDir,
    "--package-path",
    run.packagePath,
    "--package-cache-path",
    run.packageCache,
    "--diagnostic-format",
    "short",
  ];
  for (const path of run.fontPaths ?? []) args.push("--font-path", path);
  if (run.ignoreSystemFonts) args.push("--ignore-system-fonts");
  if (run.pdfa) args.push("--pdf-standard", "a-2b");
  if (run.html) args.push("--features", "html", "--format", "html");
  args.push(run.input, run.output);
  return args;
}

/** Environment for the child: proxies point at a closed port; Typst's own overrides are dropped. */
export function typstEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^typst_/i.test(key) || /^(?:https?|all|no)_proxy$/i.test(key)) continue;
    env[key] = value;
  }
  env.HTTPS_PROXY = proxyGuard;
  env.https_proxy = proxyGuard;
  env.ALL_PROXY = proxyGuard;
  env.all_proxy = proxyGuard;
  env.HTTP_PROXY = proxyGuard;
  env.http_proxy = proxyGuard;
  return env;
}

export interface TypstOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runTypst(run: TypstRun): Promise<TypstOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(run.binary, compileArgs(run), {
      cwd: run.buildDir,
      env: typstEnv(run.env ?? process.env),
      encoding: "utf8",
      timeout: compileTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      ...(run.signal ? { signal: run.signal } : {}),
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      timedOut: failure.killed === true,
    };
  }
}

const located = /^(.+?):(\d+):(\d+): (error|warning): (.*)$/;
const bare = /^(error|warning): (.*)$/;

/** Turn `--diagnostic-format short` output into findings (BLD-001 errors, BLD-003 warnings). */
export function parseDiagnostics(text: string): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: "error" | "warning", message: string, file?: string, line?: number) => {
    findings.push({
      code: severity === "error" ? "BLD-001" : "BLD-003",
      gate: "G8",
      severity,
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      message: message.trim().slice(0, 500),
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const match = located.exec(line);
    if (match) {
      add(
        match[4] as "error" | "warning",
        match[5] as string,
        `build/${match[1]}`,
        Number(match[2]),
      );
      continue;
    }
    const plain = bare.exec(line);
    if (plain) {
      add(plain[1] as "error" | "warning", plain[2] as string);
      continue;
    }
    const last = findings[findings.length - 1];
    if (last && /^\s*(?:hint|help):/i.test(line))
      last.hint = line.replace(/^\s*(?:hint|help):\s*/i, "");
  }
  return findings;
}

/** Page count from the PDF page tree (Typst writes `/Type/Pages/Count N` unencrypted). */
export function pdfPageCount(pdf: Buffer): number | undefined {
  const text = pdf.toString("latin1");
  let best: number | undefined;
  for (const dictionary of text.matchAll(/<<[^<>]*\/Type\s*\/Pages\b[^<>]*>>/g)) {
    const count = /\/Count\s+(\d+)/.exec(dictionary[0]);
    if (count && (best === undefined || Number(count[1]) > best)) best = Number(count[1]);
  }
  return best;
}
