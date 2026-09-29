/**
 * Configuration, path resolution and safe persistence.
 *
 * PRECEDENCE (highest first): explicit non-secret command/tool argument, then
 * environment, then the config file, then built-in safe defaults. The config
 * file lives at `<configHome>/telemetry/config.json`; the database lives at
 * `ALISIO_TELEMETRY_DB` or `<stateHome>/telemetry/telemetry.sqlite`.
 *
 * CREDENTIALS ARE NEVER PERSISTED. The OTLP token is read from an environment
 * variable at export time only. The config file may reference *which* variable
 * holds it (`otlp.tokenEnv`) but never its value. Secret-shaped keys anywhere in
 * the file are rejected with an actionable message rather than silently kept.
 *
 * FAIL CLOSED. An invalid file or environment produces a structured error, not a
 * throw that could crash the host. The plugin disables telemetry and surfaces the
 * message; the agent run continues.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RedactionMode } from "./redact.js";

export type Environment = Record<string, string | undefined>;

export const ENV_KEYS = {
  db: "ALISIO_TELEMETRY_DB",
  configHome: "ALISIO_CONFIG_HOME",
  stateHome: "ALISIO_STATE_HOME",
  xdgConfigHome: "XDG_CONFIG_HOME",
  xdgStateHome: "XDG_STATE_HOME",
  home: "HOME",
  retentionDays: "ALISIO_TELEMETRY_RETENTION_DAYS",
  otlpEnabled: "ALISIO_TELEMETRY_OTLP_ENABLED",
  otlpEndpoint: "ALISIO_TELEMETRY_OTLP_ENDPOINT",
  otlpTokenEnv: "ALISIO_TELEMETRY_OTLP_TOKEN_ENV",
  otlpInstanceId: "ALISIO_TELEMETRY_OTLP_INSTANCE_ID",
  serviceName: "ALISIO_TELEMETRY_SERVICE_NAME",
  environment: "ALISIO_TELEMETRY_ENVIRONMENT",
  samplingRatio: "ALISIO_TELEMETRY_SAMPLING_RATIO",
  capturePrompts: "ALISIO_TELEMETRY_CAPTURE_PROMPTS",
  captureCompletions: "ALISIO_TELEMETRY_CAPTURE_COMPLETIONS",
  captureToolArguments: "ALISIO_TELEMETRY_CAPTURE_TOOL_ARGUMENTS",
  captureToolResults: "ALISIO_TELEMETRY_CAPTURE_TOOL_RESULTS",
  redactionMode: "ALISIO_TELEMETRY_REDACTION_MODE",
  otlpSignals: "ALISIO_TELEMETRY_OTLP_SIGNALS",
  otlpGzip: "ALISIO_TELEMETRY_OTLP_GZIP",
  batchSize: "ALISIO_TELEMETRY_BATCH_SIZE",
  flushIntervalMs: "ALISIO_TELEMETRY_FLUSH_INTERVAL_MS",
  maxQueue: "ALISIO_TELEMETRY_MAX_QUEUE",
} as const;

/**
 * The credential itself is intentionally NOT listed above: it is read directly
 * from this name at export time and never flows through configuration.
 */
export const OTLP_TOKEN_ENV = "ALISIO_TELEMETRY_OTLP_TOKEN";

export type OtlpSignal = "traces" | "logs" | "metrics";

export interface CaptureSettings {
  prompts: boolean;
  completions: boolean;
  toolArguments: boolean;
  toolResults: boolean;
}

export interface RedactionSettings {
  mode: RedactionMode;
}

export interface OtlpSettings {
  enabled: boolean;
  endpoint: string | null;
  /** Non-secret headers only. Authorization is built at export time from the token env. */
  headers: Record<string, string>;
  /** Name of the environment variable that holds the token. Never its value. */
  tokenEnv: string;
  instanceId: string;
  serviceName: string;
  environment: string;
  samplingRatio: number;
  signals: Record<OtlpSignal, boolean>;
  gzip: boolean;
  maxAttempts: number;
  timeoutMs: number;
  batchSize: number;
}

export interface BatchSettings {
  batchSize: number;
  flushIntervalMs: number;
  maxQueue: number;
}

export interface TelemetryConfig {
  version: 1;
  retentionDays: number;
  capture: CaptureSettings;
  redaction: RedactionSettings;
  otlp: OtlpSettings;
  batch: BatchSettings;
}

export interface TelemetryPaths {
  configFile: string;
  database: string;
}

export interface TelemetryOverrides {
  retentionDays?: number;
  capture?: Partial<CaptureSettings>;
  redaction?: Partial<RedactionSettings>;
  otlp?: Partial<Omit<OtlpSettings, "signals">> & {
    signals?: Partial<Record<OtlpSignal, boolean>>;
  };
  batch?: Partial<BatchSettings>;
}

export type ConfigResult =
  | { ok: true; config: TelemetryConfig; paths: TelemetryPaths }
  | { ok: false; error: string; paths: TelemetryPaths };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(message: string): never {
  throw new ConfigError(message);
}

export function createDefaultConfig(): TelemetryConfig {
  return {
    version: 1,
    retentionDays: 30,
    capture: { prompts: false, completions: false, toolArguments: false, toolResults: false },
    redaction: { mode: "strict" },
    otlp: {
      enabled: false,
      endpoint: null,
      headers: {},
      tokenEnv: OTLP_TOKEN_ENV,
      instanceId: "",
      serviceName: "alisio",
      environment: "",
      samplingRatio: 1,
      signals: { traces: true, logs: true, metrics: false },
      gzip: false,
      maxAttempts: 5,
      timeoutMs: 10_000,
      batchSize: 200,
    },
    batch: { batchSize: 50, flushIntervalMs: 5_000, maxQueue: 10_000 },
  };
}

/** Resolve config/state homes with the documented precedence. */
export function resolveTelemetryPaths(
  env: Environment = process.env,
  overrides: { configFile?: string; database?: string } = {},
): TelemetryPaths {
  const home = env[ENV_KEYS.home]?.trim() || homedir();
  const xdgConfig = env[ENV_KEYS.xdgConfigHome]?.trim();
  const xdgState = env[ENV_KEYS.xdgStateHome]?.trim();
  const configHome =
    env[ENV_KEYS.configHome]?.trim() ||
    (xdgConfig ? join(xdgConfig, "alisio") : join(home, ".config", "alisio"));
  const stateHome =
    env[ENV_KEYS.stateHome]?.trim() ||
    (xdgState ? join(xdgState, "alisio") : join(home, ".local", "state", "alisio"));
  const database =
    overrides.database?.trim() ||
    env[ENV_KEYS.db]?.trim() ||
    join(stateHome, "telemetry", "telemetry.sqlite");
  const configFile = overrides.configFile?.trim() || join(configHome, "telemetry", "config.json");
  return { configFile, database };
}

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECRET_KEY =
  /(?:secret|password|passwd|credential|authorization|bearer|cookie|private[_-]?key|api[_-]?key|apikey)/i;
const TOKEN_KEY = /(?:^|[_-])token(?:$|[_-])/i;

/** A key that must never appear in the persisted configuration. */
function isSecretKey(key: string): boolean {
  if (key === "tokenEnv") return false;
  return SECRET_KEY.test(key) || key.toLowerCase() === "token" || TOKEN_KEY.test(key);
}

/** Reject unknown and secret-shaped keys, with an actionable message. */
function assertKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    if (isSecretKey(key))
      fail(
        `${where}: field "${key}" is not allowed. Credentials are never persisted; set the token environment variable instead and reference its name with "otlp.tokenEnv".`,
      );
    fail(`${where}: unknown field "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

function readBoolean(value: unknown, where: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  fail(`${where}: expected a boolean, got ${JSON.stringify(value)}`);
}

function readInteger(value: unknown, where: string, min: number, max: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(numeric))
    fail(`${where}: expected an integer, got ${JSON.stringify(value)}`);
  if (numeric < min || numeric > max)
    fail(`${where}: expected an integer between ${min} and ${max}, got ${numeric}`);
  return numeric;
}

function readRatio(value: unknown, where: string): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1)
    fail(`${where}: expected a number between 0 and 1, got ${JSON.stringify(value)}`);
  return numeric;
}

function readBoundedString(value: unknown, where: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") fail(`${where}: expected a string, got ${JSON.stringify(value)}`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed === "") fail(`${where}: must not be empty`);
  if (trimmed.length > max) fail(`${where}: must be at most ${max} characters`);
  return trimmed;
}

/** Validate and normalize an OTLP base endpoint. Credentials in the URL are refused. */
export function parseEndpoint(value: string, where = "otlp.endpoint"): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail(`${where}: not a valid absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail(`${where}: must use http or https`);
  if (url.username !== "" || url.password !== "") fail(`${where}: must not embed credentials`);
  if (url.search !== "") fail(`${where}: must not include a query string`);
  if (url.hash !== "") fail(`${where}: must not include a fragment`);
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return base;
}

function readHeaders(value: unknown, where: string): Record<string, string> {
  if (!isPlainObject(value)) fail(`${where}: expected an object of string headers`);
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSecretKey(key))
      fail(
        `${where}: header "${key}" looks like a credential and is refused. Only non-secret headers are persisted; authorization is injected at export time from the token environment variable.`,
      );
    if (typeof raw !== "string") fail(`${where}.${key}: header value must be a string`);
    if (raw.length > 1000) fail(`${where}.${key}: header value is too long`);
    headers[key] = raw;
  }
  return headers;
}

function readSignals(value: unknown, where: string): Record<OtlpSignal, boolean> {
  if (isPlainObject(value)) assertKeys(value, ["traces", "logs", "metrics"], where);
  else fail(`${where}: expected an object of booleans`);
  const object = value as Record<string, unknown>;
  return {
    traces: object.traces === undefined ? true : readBoolean(object.traces, `${where}.traces`),
    logs: object.logs === undefined ? true : readBoolean(object.logs, `${where}.logs`),
    metrics: object.metrics === undefined ? false : readBoolean(object.metrics, `${where}.metrics`),
  };
}

// ---------------------------------------------------------------------------
// Config-file validation and merging
// ---------------------------------------------------------------------------

/** Parse a raw config object into a partial config, rejecting unknown/secret keys. */
export function parsePartialConfig(raw: unknown, where = "config"): TelemetryOverrides {
  if (!isPlainObject(raw)) fail(`${where}: expected a JSON object`);
  assertKeys(raw, ["version", "retentionDays", "capture", "redaction", "otlp", "batch"], where);

  const partial: TelemetryOverrides = {};
  if (raw.version !== undefined && raw.version !== 1)
    fail(`${where}.version: unsupported version ${JSON.stringify(raw.version)}`);

  if (raw.retentionDays !== undefined)
    partial.retentionDays = readInteger(raw.retentionDays, `${where}.retentionDays`, 1, 3650);

  if (raw.capture !== undefined) {
    if (!isPlainObject(raw.capture)) fail(`${where}.capture: expected an object`);
    assertKeys(
      raw.capture,
      ["prompts", "completions", "toolArguments", "toolResults"],
      `${where}.capture`,
    );
    const capture: Partial<CaptureSettings> = {};
    for (const key of ["prompts", "completions", "toolArguments", "toolResults"] as const) {
      if (raw.capture[key] !== undefined)
        capture[key] = readBoolean(raw.capture[key], `${where}.capture.${key}`);
    }
    partial.capture = capture;
  }

  if (raw.redaction !== undefined) {
    if (!isPlainObject(raw.redaction)) fail(`${where}.redaction: expected an object`);
    assertKeys(raw.redaction, ["mode"], `${where}.redaction`);
    if (raw.redaction.mode !== undefined) {
      const mode = raw.redaction.mode;
      if (mode !== "strict" && mode !== "standard")
        fail(
          `${where}.redaction.mode: expected "strict" or "standard", got ${JSON.stringify(mode)}`,
        );
      partial.redaction = { mode };
    }
  }

  if (raw.otlp !== undefined) {
    if (!isPlainObject(raw.otlp)) fail(`${where}.otlp: expected an object`);
    assertKeys(
      raw.otlp,
      [
        "enabled",
        "endpoint",
        "headers",
        "tokenEnv",
        "instanceId",
        "serviceName",
        "environment",
        "samplingRatio",
        "signals",
        "gzip",
        "maxAttempts",
        "timeoutMs",
        "batchSize",
      ],
      `${where}.otlp`,
    );
    const otlp: NonNullable<TelemetryOverrides["otlp"]> = {};
    if (raw.otlp.enabled !== undefined)
      otlp.enabled = readBoolean(raw.otlp.enabled, `${where}.otlp.enabled`);
    if (raw.otlp.endpoint !== undefined) {
      if (raw.otlp.endpoint === null || raw.otlp.endpoint === "") otlp.endpoint = null;
      else
        otlp.endpoint = parseEndpoint(
          readBoundedString(raw.otlp.endpoint, `${where}.otlp.endpoint`, 2048),
          `${where}.otlp.endpoint`,
        );
    }
    if (raw.otlp.headers !== undefined)
      otlp.headers = readHeaders(raw.otlp.headers, `${where}.otlp.headers`);
    if (raw.otlp.tokenEnv !== undefined) {
      const name = readBoundedString(raw.otlp.tokenEnv, `${where}.otlp.tokenEnv`, 200);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        fail(`${where}.otlp.tokenEnv: must be a valid environment variable name`);
      otlp.tokenEnv = name;
    }
    if (raw.otlp.instanceId !== undefined)
      otlp.instanceId = readBoundedString(
        raw.otlp.instanceId,
        `${where}.otlp.instanceId`,
        200,
        true,
      );
    if (raw.otlp.serviceName !== undefined)
      otlp.serviceName = readBoundedString(raw.otlp.serviceName, `${where}.otlp.serviceName`, 200);
    if (raw.otlp.environment !== undefined)
      otlp.environment = readBoundedString(
        raw.otlp.environment,
        `${where}.otlp.environment`,
        100,
        true,
      );
    if (raw.otlp.samplingRatio !== undefined)
      otlp.samplingRatio = readRatio(raw.otlp.samplingRatio, `${where}.otlp.samplingRatio`);
    if (raw.otlp.signals !== undefined)
      otlp.signals = readSignals(raw.otlp.signals, `${where}.otlp.signals`);
    if (raw.otlp.gzip !== undefined) otlp.gzip = readBoolean(raw.otlp.gzip, `${where}.otlp.gzip`);
    if (raw.otlp.maxAttempts !== undefined)
      otlp.maxAttempts = readInteger(raw.otlp.maxAttempts, `${where}.otlp.maxAttempts`, 1, 10);
    if (raw.otlp.timeoutMs !== undefined)
      otlp.timeoutMs = readInteger(raw.otlp.timeoutMs, `${where}.otlp.timeoutMs`, 1_000, 120_000);
    if (raw.otlp.batchSize !== undefined)
      otlp.batchSize = readInteger(raw.otlp.batchSize, `${where}.otlp.batchSize`, 1, 10_000);
    partial.otlp = otlp;
  }

  if (raw.batch !== undefined) {
    if (!isPlainObject(raw.batch)) fail(`${where}.batch: expected an object`);
    assertKeys(raw.batch, ["batchSize", "flushIntervalMs", "maxQueue"], `${where}.batch`);
    const batch: Partial<BatchSettings> = {};
    if (raw.batch.batchSize !== undefined)
      batch.batchSize = readInteger(raw.batch.batchSize, `${where}.batch.batchSize`, 1, 10_000);
    if (raw.batch.flushIntervalMs !== undefined)
      batch.flushIntervalMs = readInteger(
        raw.batch.flushIntervalMs,
        `${where}.batch.flushIntervalMs`,
        250,
        600_000,
      );
    if (raw.batch.maxQueue !== undefined)
      batch.maxQueue = readInteger(raw.batch.maxQueue, `${where}.batch.maxQueue`, 100, 1_000_000);
    partial.batch = batch;
  }

  return partial;
}

function merge(base: TelemetryConfig, patch: TelemetryOverrides): TelemetryConfig {
  return {
    version: 1,
    retentionDays: patch.retentionDays ?? base.retentionDays,
    capture: { ...base.capture, ...(patch.capture ?? {}) },
    redaction: { ...base.redaction, ...(patch.redaction ?? {}) },
    otlp: {
      ...base.otlp,
      ...(patch.otlp ?? {}),
      signals: { ...base.otlp.signals, ...(patch.otlp?.signals ?? {}) },
    },
    batch: { ...base.batch, ...(patch.batch ?? {}) },
  };
}

/** Environment overrides parsed into the same partial shape as the config file. */
export function environmentOverrides(env: Environment): TelemetryOverrides {
  const raw: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    const [head, tail] = key.split(".") as [string, string | undefined];
    if (tail === undefined) {
      raw[head] = value;
      return;
    }
    const nested = (raw[head] as Record<string, unknown>) ?? {};
    nested[tail] = value;
    raw[head] = nested;
  };

  if (env[ENV_KEYS.retentionDays]?.trim()) put("retentionDays", env[ENV_KEYS.retentionDays]);
  if (env[ENV_KEYS.otlpEnabled] !== undefined) put("otlp.enabled", env[ENV_KEYS.otlpEnabled]);
  const endpointEnv = env[ENV_KEYS.otlpEndpoint];
  if (endpointEnv !== undefined && endpointEnv.trim() !== "") put("otlp.endpoint", endpointEnv);
  if (env[ENV_KEYS.otlpTokenEnv]?.trim()) put("otlp.tokenEnv", env[ENV_KEYS.otlpTokenEnv]);
  if (env[ENV_KEYS.otlpInstanceId] !== undefined)
    put("otlp.instanceId", env[ENV_KEYS.otlpInstanceId]);
  if (env[ENV_KEYS.serviceName]?.trim()) put("otlp.serviceName", env[ENV_KEYS.serviceName]);
  if (env[ENV_KEYS.environment] !== undefined) put("otlp.environment", env[ENV_KEYS.environment]);
  if (env[ENV_KEYS.samplingRatio]?.trim()) put("otlp.samplingRatio", env[ENV_KEYS.samplingRatio]);
  if (env[ENV_KEYS.otlpGzip] !== undefined) put("otlp.gzip", env[ENV_KEYS.otlpGzip]);
  if (env[ENV_KEYS.batchSize]?.trim()) put("otlp.batchSize", env[ENV_KEYS.batchSize]);
  if (env[ENV_KEYS.capturePrompts] !== undefined)
    put("capture.prompts", env[ENV_KEYS.capturePrompts]);
  if (env[ENV_KEYS.captureCompletions] !== undefined)
    put("capture.completions", env[ENV_KEYS.captureCompletions]);
  if (env[ENV_KEYS.captureToolArguments] !== undefined)
    put("capture.toolArguments", env[ENV_KEYS.captureToolArguments]);
  if (env[ENV_KEYS.captureToolResults] !== undefined)
    put("capture.toolResults", env[ENV_KEYS.captureToolResults]);
  if (env[ENV_KEYS.redactionMode]?.trim()) put("redaction.mode", env[ENV_KEYS.redactionMode]);
  const signalsEnv = env[ENV_KEYS.otlpSignals];
  if (signalsEnv?.trim()) {
    const enabled = new Set(signalsEnv.split(",").map((signal) => signal.trim().toLowerCase()));
    put("otlp.signals", {
      traces: enabled.has("traces"),
      logs: enabled.has("logs"),
      metrics: enabled.has("metrics"),
    });
  }
  if (env[ENV_KEYS.flushIntervalMs]?.trim())
    put("batch.flushIntervalMs", env[ENV_KEYS.flushIntervalMs]);
  if (env[ENV_KEYS.maxQueue]?.trim()) put("batch.maxQueue", env[ENV_KEYS.maxQueue]);

  return parsePartialConfig(raw, "environment");
}

function readConfigFile(path: string): { raw: unknown; missing: boolean } {
  try {
    const text = readFileSync(path, "utf8");
    return { raw: JSON.parse(text), missing: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: null, missing: true };
    if (error instanceof SyntaxError)
      fail(`config file ${path} is not valid JSON: ${error.message}`);
    fail(`cannot read config file ${path}`);
  }
}

export interface LoadConfigOptions {
  env?: Environment;
  paths?: TelemetryPaths;
  /** Explicit non-secret overrides (highest precedence). */
  overrides?: TelemetryOverrides;
  /** Injected file content for tests; skips disk. */
  file?: unknown;
  /** Skip reading the config file entirely. */
  skipFile?: boolean;
}

/**
 * Load, merge and validate the effective configuration. Returns a structured
 * result; it never throws, so an invalid configuration can never crash a host.
 */
export function loadTelemetryConfig(options: LoadConfigOptions = {}): ConfigResult {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveTelemetryPaths(env);
  try {
    let fromFile: TelemetryOverrides = {};
    if (!options.skipFile) {
      const { raw, missing } =
        options.file !== undefined
          ? { raw: options.file, missing: false }
          : readConfigFile(paths.configFile);
      if (!missing && raw !== null && raw !== undefined)
        fromFile = parsePartialConfig(raw, "config file");
    }
    const fromEnv = environmentOverrides(env);
    const merged = merge(
      merge(merge(createDefaultConfig(), fromFile), fromEnv),
      options.overrides ?? {},
    );
    // Re-parse the fully merged object so every value is re-validated in
    // context (a partial that was valid alone must stay valid combined).
    const validated = parsePartialConfig(merged, "configuration");
    const config = merge(createDefaultConfig(), validated);
    return { ok: true, config, paths };
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: message, paths };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Serialize a config for storage. The shape contains no credential by construction. */
export function serializeConfig(config: TelemetryConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Apply validated overrides on top of a base configuration and return the
 * effective result. Used by the setup command; throws `ConfigError` on invalid
 * input so the caller can report an actionable message.
 */
export function updateConfig(
  base: TelemetryConfig,
  overrides: TelemetryOverrides,
): TelemetryConfig {
  const merged = merge(base, overrides);
  const validated = parsePartialConfig(merged, "configuration");
  return merge(createDefaultConfig(), validated);
}

/**
 * Atomically write the config file with 0600 file mode and 0700 parent. Write
 * to a sibling temp file, fsync, rename over the target.
 */
export function writeConfigFile(path: string, config: TelemetryConfig): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Hardening only.
  }
  const temp = `${path}.${process.pid}.tmp`;
  const text = serializeConfig(config);
  const descriptor = openSync(temp, "w", 0o600);
  try {
    writeSync(descriptor, text, 0, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Hardening only.
  }
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Hardening only.
  }
}

/**
 * A display projection of the configuration. It contains no credential (there
 * is none) and reports whether the token environment variable is present
 * without ever reading or echoing its value.
 */
export function describeConfig(
  config: TelemetryConfig,
  env: Environment = process.env,
): Record<string, unknown> {
  return {
    version: config.version,
    retentionDays: config.retentionDays,
    capture: { ...config.capture },
    redaction: { ...config.redaction },
    otlp: {
      enabled: config.otlp.enabled,
      endpoint: config.otlp.endpoint,
      headers: Object.keys(config.otlp.headers),
      tokenEnv: config.otlp.tokenEnv,
      tokenConfigured: Boolean(env[config.otlp.tokenEnv]?.trim()),
      instanceId: config.otlp.instanceId,
      serviceName: config.otlp.serviceName,
      environment: config.otlp.environment,
      samplingRatio: config.otlp.samplingRatio,
      signals: { ...config.otlp.signals },
      gzip: config.otlp.gzip,
      maxAttempts: config.otlp.maxAttempts,
      timeoutMs: config.otlp.timeoutMs,
      batchSize: config.otlp.batchSize,
    },
    batch: { ...config.batch },
  };
}
