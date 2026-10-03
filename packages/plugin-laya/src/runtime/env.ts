/** Allowlisted environment for the Laya child process. Nothing else is inherited. */
import { delimiter } from "node:path";
import type { LayaConfig } from "../config.js";
import { type ModelName, modelsToInstall } from "./manifest.js";

export interface ChildEnvInput {
  host: Readonly<Record<string, string | undefined>>;
  port: number;
  token: string;
  config: LayaConfig;
  hfHome: string;
  runtimeDir: string;
  venvBin: string;
  /** Nested `LAYA_SHA256_DIGESTS` JSON for the installed checkpoints. */
  digests: string;
  cpus: number;
  platform?: NodeJS.Platform;
}

const PASSTHROUGH = ["HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG"];

export function threadsFor(cpus: number): number {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = input.host[key];
    if (value) env[key] = value;
  }
  const systemPath =
    platform === "win32"
      ? [`${input.host.SYSTEMROOT ?? "C:\\Windows"}\\System32`]
      : ["/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = [input.venvBin, ...systemPath].join(platform === "win32" ? ";" : delimiter);

  const models: ModelName[] = modelsToInstall(input.config.model);
  Object.assign(env, {
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: String(input.port),
    LAYA_API_KEY: input.token,
    LAYA_MODELS: models.join(","),
    LAYA_MAX_LOADED: String(models.length),
    // The supervisor only starts the server when a model is wanted, so always warm it.
    LAYA_PRELOAD: "1",
    LAYA_REVISION: "reviewed",
    LAYA_SHA256_DIGESTS: input.digests,
    LAYA_AUTO_TASK: "0",
    LAYA_THREADS: String(threadsFor(input.cpus)),
    HF_HOME: input.hfHome,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
  });
  if (input.config.model !== "auto") env.LAYA_DEFAULT_MODEL = input.config.model;
  if (input.config.device !== "auto") env.LAYA_DEVICE = input.config.device;
  return env;
}
