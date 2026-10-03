/** Installed-runtime bookkeeping: `runtime.json` and venv path helpers. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fs-util.js";
import { MANIFEST, type Manifest, type ModelName } from "./manifest.js";

export const RUNTIME_FILE = "runtime.json";
const VENV_NAME = /^venv-[A-Za-z0-9._-]{1,80}$/;
const MODEL_NAMES: readonly string[] = ["english", "multilingual", "typed-decisions"];

export interface RuntimeRecord {
  schemaVersion: 1;
  laya: string;
  python: string;
  torch: "cpu" | "default";
  device: string;
  models: ModelName[];
  /** Directory name of the venv, relative to the runtime root (never an absolute path). */
  venv: string;
  hub: { repo: string; revision: string };
  installedAt: string;
}

export function venvBinDir(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(venvDir, platform === "win32" ? "Scripts" : "bin");
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(venvBinDir(venvDir, platform), platform === "win32" ? "python.exe" : "python");
}

export function layaServe(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(
    venvBinDir(venvDir, platform),
    platform === "win32" ? "laya-serve.exe" : "laya-serve",
  );
}

export function isVenvName(name: string): boolean {
  return VENV_NAME.test(name);
}

export async function writeRuntimeRecord(runtimeDir: string, record: RuntimeRecord): Promise<void> {
  await atomicWriteFile(join(runtimeDir, RUNTIME_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export type InstalledRuntime =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "installed"; record: RuntimeRecord; venvDir: string; outdated: boolean };

/** Read and validate `runtime.json`; the venv must exist and carry the server entry point. */
export async function readInstalledRuntime(
  runtimeDir: string,
  manifest: Manifest = MANIFEST,
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledRuntime> {
  let raw: string;
  try {
    raw = await readFile(join(runtimeDir, RUNTIME_FILE), "utf8");
  } catch {
    return { kind: "none" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { kind: "invalid", reason: "runtime.json is not valid JSON" };
  }
  if (parsed.schemaVersion !== 1) {
    return { kind: "invalid", reason: "runtime.json has an unsupported schema version" };
  }
  const models = parsed.models;
  const hub = parsed.hub as Record<string, unknown> | undefined;
  if (
    typeof parsed.venv !== "string" ||
    !isVenvName(parsed.venv) ||
    typeof parsed.laya !== "string" ||
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every((m) => typeof m === "string" && MODEL_NAMES.includes(m)) ||
    typeof hub?.repo !== "string" ||
    typeof hub?.revision !== "string"
  ) {
    return { kind: "invalid", reason: "runtime.json is malformed" };
  }
  const venvDir = join(runtimeDir, parsed.venv);
  try {
    await stat(layaServe(venvDir, platform));
  } catch {
    return {
      kind: "invalid",
      reason: "the installed environment is missing; run /laya:setup --repair",
    };
  }
  const record = parsed as unknown as RuntimeRecord;
  const outdated =
    record.laya !== manifest.laya.version || record.hub.revision !== manifest.hub.revision;
  return { kind: "installed", record, venvDir, outdated };
}
