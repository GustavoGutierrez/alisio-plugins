import { lstat, readFile } from "node:fs/promises";
import { atomicWriteFile } from "./fs-util.js";

export const DEVICES = ["auto", "cpu", "cuda", "mps"] as const;
export const MODELS = ["multilingual", "english", "typed-decisions", "auto"] as const;

export type LayaDevice = (typeof DEVICES)[number];
export type LayaModel = (typeof MODELS)[number];

export interface LayaConfig {
  device: LayaDevice;
  model: LayaModel;
  preload: boolean;
}

export type ConfigKey = keyof LayaConfig;
export type ConfigSource = "env" | "host" | "file" | "default";

export const DEFAULT_CONFIG: Readonly<LayaConfig> = Object.freeze({
  device: "auto",
  model: "multilingual",
  preload: true,
});

export const CONFIG_FILE_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024;
const SECRET_KEY = /key|token|secret|password|passwd|credential|auth/i;
const KEYS: readonly ConfigKey[] = ["device", "model", "preload"];

export interface Layer {
  values: Partial<LayaConfig>;
  errors: string[];
}

export type LayerOrigin = "env" | "host" | "file";

export interface ResolvedConfig {
  config: LayaConfig;
  sources: Record<ConfigKey, ConfigSource>;
  errors: string[];
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly validate one configuration layer. Never echoes a rejected value. */
export function validateLayer(raw: unknown, origin: LayerOrigin): Layer {
  const label =
    origin === "env" ? "environment" : origin === "host" ? "host options" : "config file";
  if (!isRecord(raw)) return { values: {}, errors: [`${label}: expected an object`] };
  const values: Partial<LayaConfig> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "version" && origin === "file") {
      if (value !== CONFIG_FILE_VERSION) {
        errors.push(
          `${label}: unsupported version (expected ${CONFIG_FILE_VERSION}); run /laya:setup`,
        );
      }
      continue;
    }
    if (SECRET_KEY.test(key)) {
      errors.push(
        `${label}: secret-shaped key "${key.slice(0, 40)}" is not allowed; secrets are never stored here`,
      );
      continue;
    }
    if (!(KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unknown key "${key.slice(0, 40)}"`);
      continue;
    }
    if (key === "device") {
      if ((DEVICES as readonly unknown[]).includes(value)) values.device = value as LayaDevice;
      else errors.push(`${label}: device must be one of ${DEVICES.join(", ")}`);
    } else if (key === "model") {
      if ((MODELS as readonly unknown[]).includes(value)) values.model = value as LayaModel;
      else errors.push(`${label}: model must be one of ${MODELS.join(", ")}`);
    } else {
      const parsed =
        origin === "env" ? parseBoolean(value) : typeof value === "boolean" ? value : undefined;
      if (parsed === undefined) errors.push(`${label}: preload must be a boolean`);
      else values.preload = parsed;
    }
  }
  return { values, errors };
}

export function parseEnvLayer(env: Readonly<Record<string, string | undefined>>): Layer {
  const raw: Record<string, unknown> = {};
  if (env.ALISIO_LAYA_DEVICE !== undefined) raw.device = env.ALISIO_LAYA_DEVICE.trim();
  if (env.ALISIO_LAYA_MODEL !== undefined) raw.model = env.ALISIO_LAYA_MODEL.trim();
  if (env.ALISIO_LAYA_PRELOAD !== undefined) raw.preload = env.ALISIO_LAYA_PRELOAD;
  return validateLayer(raw, "env");
}

export interface ResolveInput {
  env: Readonly<Record<string, string | undefined>>;
  hostOptions?: unknown;
  file?: unknown;
}

/** Precedence per key: environment, host options, config file, defaults. */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const layers: Array<[ConfigSource, Layer]> = [
    ["env", parseEnvLayer(input.env)],
    [
      "host",
      input.hostOptions === undefined ||
      (isRecord(input.hostOptions) && Object.keys(input.hostOptions).length === 0)
        ? { values: {}, errors: [] }
        : validateLayer(input.hostOptions, "host"),
    ],
    [
      "file",
      input.file === undefined ? { values: {}, errors: [] } : validateLayer(input.file, "file"),
    ],
  ];
  const config: LayaConfig = { ...DEFAULT_CONFIG };
  const sources: Record<ConfigKey, ConfigSource> = {
    device: "default",
    model: "default",
    preload: "default",
  };
  const errors: string[] = [];
  for (const [source, layer] of [...layers].reverse()) {
    errors.unshift(...layer.errors);
    for (const key of KEYS) {
      const value = layer.values[key];
      if (value !== undefined) {
        (config as unknown as Record<string, unknown>)[key] = value;
        sources[key] = source;
      }
    }
  }
  return { config, sources, errors };
}

export interface LoadedFile {
  raw?: unknown;
  error?: string;
}

/** Read the config file: absent is not an error; symlinks, huge files and bad JSON are. */
export async function loadConfigFile(path: string): Promise<LoadedFile> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: "config file is unreadable" };
  }
  if (!info.isFile()) return { error: "config file must be a regular file, not a symlink" };
  if (info.size > MAX_FILE_BYTES) return { error: "config file is too large" };
  try {
    return { raw: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch {
    return { error: "config file is not valid JSON" };
  }
}

export async function saveConfigFile(path: string, config: LayaConfig): Promise<void> {
  const body = {
    version: CONFIG_FILE_VERSION,
    device: config.device,
    model: config.model,
    preload: config.preload,
  };
  await atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`);
}
