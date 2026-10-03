/**
 * Managed installation: isolated venv, pinned packages, pinned and verified model download.
 * Every network-touching step runs as a child process through an injected `Runner`; nothing here
 * runs before the caller has obtained consent.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LayaConfig } from "../config.js";
import { assertContained } from "../paths.js";
import { isVenvName, type RuntimeRecord, venvPython, writeRuntimeRecord } from "./install-state.js";
import {
  allowPatterns,
  checkpointBytes,
  MANIFEST,
  type Manifest,
  type ModelName,
  modelsToInstall,
} from "./manifest.js";
import type { Runner, RunResult } from "./runner.js";

/** Constant download script: inputs arrive through argv, never string interpolation. */
export const DOWNLOAD_SCRIPT = [
  "import sys",
  "from huggingface_hub import snapshot_download",
  "repo, revision = sys.argv[1], sys.argv[2]",
  "snapshot_download(repo_id=repo, revision=revision, allow_patterns=sys.argv[3:])",
].join("\n");

const CPU_VENV_BYTES = 992e6;
const DEFAULT_VENV_BYTES = 5.4e9;

export class InstallCancelled extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "InstallCancelled";
  }
}

export class InstallFailure extends Error {
  readonly code: string;
  readonly step: string;
  constructor(code: string, step: string, message: string) {
    super(message);
    this.name = "InstallFailure";
    this.code = code;
    this.step = step;
  }
}

export interface InstallPlan {
  requirement: string;
  torch: "cpu" | "default";
  models: ModelName[];
  downloadBytes: number;
  diskBytes: number;
  hosts: string[];
}

export interface PlanInput {
  config: LayaConfig;
  platform: NodeJS.Platform;
  nvidia: boolean;
  manifest?: Manifest;
}

export function buildPlan(input: PlanInput): InstallPlan {
  const manifest = input.manifest ?? MANIFEST;
  const { device } = input.config;
  let torch: "cpu" | "default";
  if (device === "cpu") torch = "cpu";
  else if (device === "cuda" || device === "mps") torch = "default";
  else if (input.platform === "darwin") torch = "default";
  else torch = input.nvidia ? "default" : "cpu";
  const models = modelsToInstall(input.config.model);
  const downloadBytes = models.reduce((sum, m) => sum + checkpointBytes(m, manifest), 0);
  const hosts = manifest.hosts.filter((h) => torch === "cpu" || h !== "download.pytorch.org");
  return {
    requirement: manifest.laya.requirement,
    torch,
    models,
    downloadBytes,
    diskBytes: downloadBytes + (torch === "cpu" ? CPU_VENV_BYTES : DEFAULT_VENV_BYTES),
    hosts,
  };
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** The exact plan the user consents to; derived from the manifest, never hand-written. */
export function formatConsentText(plan: InstallPlan, runtimeLabel: string): string {
  return [
    "Laya setup will download and install software on this machine:",
    `- Python packages: ${plan.requirement}${plan.torch === "cpu" ? " plus the CPU build of PyTorch" : " plus PyTorch (default wheels)"}`,
    `- Model checkpoint(s): ${plan.models.join(", ")} (${formatBytes(plan.downloadBytes)} to download)`,
    `- Disk space: about ${formatBytes(plan.diskBytes)} in ${runtimeLabel}`,
    `- Hosts contacted during setup only: ${plan.hosts.join(", ")}`,
    "After setup the server runs offline on 127.0.0.1 and nothing leaves this machine.",
  ].join("\n");
}

const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
];

function childEnv(
  host: Readonly<Record<string, string | undefined>>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = host[key];
    if (value) env[key] = value;
  }
  return { ...env, PYTHONNOUSERSITE: "1", HF_HUB_DISABLE_TELEMETRY: "1", ...extra };
}

/** One short, path-free line from the tail of stderr. */
export function sanitizeHint(stderr: string, home?: string): string {
  const last = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return "";
  let text = home ? last.split(home).join("~") : last;
  text = text.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, "<path>");
  return text.slice(0, 200);
}

export interface InstallInput {
  runtimeDir: string;
  hfHome: string;
  config: LayaConfig;
  python: { command: string; args: string[]; version: string };
  manifest: Manifest;
  runner: Runner;
  smoke: (venvDir: string, models: ModelName[], signal: AbortSignal) => Promise<void>;
  platform: NodeJS.Platform;
  hostEnv: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  onStep: (n: number, name: string) => void;
  nvidia: boolean;
  now: () => Date;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function repoCacheDir(hfHome: string, repo: string): string {
  return join(hfHome, "hub", `models--${repo.split("/").join("--")}`);
}

async function verifyModels(input: InstallInput, models: ModelName[]): Promise<void> {
  const { manifest } = input;
  const snapshot = join(
    repoCacheDir(input.hfHome, manifest.hub.repo),
    "snapshots",
    manifest.hub.revision,
  );
  for (const name of models) {
    const pin = manifest.models[name];
    for (const file of pin.files) {
      const path = join(snapshot, pin.subfolder ?? "", file.path);
      let ok = false;
      try {
        ok = (await stat(path)).size === file.size && (await sha256File(path)) === file.sha256;
      } catch {
        ok = false;
      }
      if (!ok) {
        await rm(repoCacheDir(input.hfHome, manifest.hub.repo), { recursive: true, force: true });
        throw new InstallFailure(
          "checksum_mismatch",
          "verifying model",
          "a downloaded model file is missing or does not match its pinned checksum; the partial download was removed",
        );
      }
    }
  }
}

export async function runInstall(input: InstallInput): Promise<RuntimeRecord> {
  const { manifest, runner, signal } = input;
  const plan = buildPlan({
    config: input.config,
    platform: input.platform,
    nvidia: input.nvidia,
    manifest,
  });
  const venvName = `venv-${manifest.laya.version}-${randomBytes(4).toString("hex")}`;
  const venvDir = join(input.runtimeDir, venvName);
  const env = childEnv(input.hostEnv);
  const hfEnv = childEnv(input.hostEnv, { HF_HOME: input.hfHome });
  let step = "starting";

  const begin = (n: number, name: string): void => {
    if (signal.aborted) throw new InstallCancelled();
    step = name;
    input.onStep(n, name);
  };
  const check = (result: RunResult, code: string): void => {
    if (result.aborted || signal.aborted) throw new InstallCancelled();
    if (result.code !== 0) {
      const hint = sanitizeHint(result.stderr, input.hostEnv.HOME);
      throw new InstallFailure(
        code,
        step,
        hint ? `${step} failed: ${hint}` : `${step} failed (exit ${result.code ?? "none"})`,
      );
    }
  };
  const pip = [
    "-m",
    "pip",
    "install",
    "--no-input",
    "--disable-pip-version-check",
    "--require-virtualenv",
  ];
  const py = venvPython(venvDir, input.platform);

  try {
    await assertContained(input.runtimeDir, venvDir);
    begin(1, "creating environment");
    check(
      await runner.run(input.python.command, [...input.python.args, "-m", "venv", venvDir], {
        env,
        signal,
      }),
      "venv_failed",
    );

    begin(2, "installing packages");
    // The pip bundled with older venvs (22.0.x on Ubuntu 22.04) crashes resolving laya[serve]
    // with an AssertionError; a current pip from PyPI (already a contacted host) avoids it.
    check(await runner.run(py, [...pip, "--upgrade", "pip>=24"], { env, signal }), "pip_failed");
    if (plan.torch === "cpu") {
      check(
        await runner.run(py, [...pip, "--index-url", manifest.torch.cpuIndexUrl, "torch"], {
          env,
          signal,
        }),
        "pip_failed",
      );
    }
    check(await runner.run(py, [...pip, manifest.laya.requirement], { env, signal }), "pip_failed");

    begin(3, "downloading model");
    const patterns = plan.models.flatMap((name) => allowPatterns(name, manifest));
    check(
      await runner.run(
        py,
        ["-c", DOWNLOAD_SCRIPT, manifest.hub.repo, manifest.hub.revision, ...patterns],
        {
          env: hfEnv,
          signal,
        },
      ),
      "download_failed",
    );

    begin(4, "verifying model");
    await verifyModels(input, plan.models);

    begin(5, "smoke test");
    try {
      await input.smoke(venvDir, plan.models, signal);
    } catch (error) {
      if (signal.aborted) throw new InstallCancelled();
      throw error instanceof InstallFailure
        ? error
        : new InstallFailure(
            "smoke_failed",
            "smoke test",
            "the smoke test against the local server failed",
          );
    }

    begin(6, "committing");
    const record: RuntimeRecord = {
      schemaVersion: 1,
      laya: manifest.laya.version,
      python: input.python.version,
      torch: plan.torch,
      device: input.config.device,
      models: plan.models,
      venv: venvName,
      hub: { ...manifest.hub },
      installedAt: input.now().toISOString(),
    };
    await writeRuntimeRecord(input.runtimeDir, record);
    for (const entry of await readdir(input.runtimeDir)) {
      if (entry !== venvName && isVenvName(entry)) {
        const old = join(input.runtimeDir, entry);
        await assertContained(input.runtimeDir, old);
        await rm(old, { recursive: true, force: true });
      }
    }
    return record;
  } catch (error) {
    await rm(venvDir, { recursive: true, force: true });
    if (error instanceof InstallCancelled || error instanceof InstallFailure) throw error;
    throw new InstallFailure("install_failed", step, `${step} failed unexpectedly`);
  }
}

export interface UninstallInput {
  runtimeRoot: string;
  /** Directory that must contain `runtimeRoot` after symlinks are resolved. */
  parent: string;
}

const KNOWN_ENTRIES = ["runtime.json", "jobs", "hf", "server.pid"];

/** Remove only what setup created inside the runtime root, then the root itself if empty. */
export async function uninstallRuntime(input: UninstallInput): Promise<void> {
  if (resolve(input.runtimeRoot) === resolve(input.parent)) {
    throw new Error("refusing to remove the runtime's parent directory");
  }
  await assertContained(input.parent, input.runtimeRoot, { forbidSymlink: true });
  let entries: string[];
  try {
    entries = await readdir(input.runtimeRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (KNOWN_ENTRIES.includes(entry) || isVenvName(entry)) {
      const target = join(input.runtimeRoot, entry);
      await assertContained(input.runtimeRoot, target, { forbidSymlink: true });
      await rm(target, { recursive: true, force: true });
    }
  }
  try {
    const left = await readdir(input.runtimeRoot);
    if (left.length === 0) await rm(input.runtimeRoot, { recursive: true });
  } catch {
    /* already gone */
  }
}
