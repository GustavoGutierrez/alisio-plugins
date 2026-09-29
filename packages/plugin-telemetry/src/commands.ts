/**
 * Operator commands: setup, status, maintenance.
 *
 * Alisio namespaces external plugin commands as `<plugin id>:<name>`. This
 * plugin registers the names below, so the real invocation form is
 * `/telemetry:telemetry-setup`, `/telemetry:telemetry-status`,
 * `/telemetry:telemetry-flush` and `/telemetry:telemetry-prune`.
 *
 * `telemetry-setup` persists configuration non-interactively and reports exactly
 * which fields changed. It never echoes a credential: the OTLP token is only
 * ever referenced by the name of the environment variable that holds it.
 */
import type { CommandContext, PluginAPI } from "@alisio/sdk";
import {
  ConfigError,
  createDefaultConfig,
  describeConfig,
  type TelemetryOverrides,
  updateConfig,
  writeConfigFile,
} from "./config.js";
import { sanitizeField } from "./format.js";
import type { TelemetryRuntime } from "./runtime.js";

export const COMMAND_NAMES = [
  "telemetry-setup",
  "telemetry-status",
  "telemetry-flush",
  "telemetry-prune",
] as const;

const SETUP_USAGE = [
  "Usage: /telemetry:telemetry-setup [options]",
  "  --enable-remote | --disable-remote",
  "  --endpoint <url>",
  "  --token-env <ENV_VAR_NAME>        (the value is never stored)",
  "  --service-name <name>  --environment <name>  --instance-id <id>",
  "  --sampling <0..1>  --retention-days <n>",
  "  --capture <prompts,completions,tool-arguments,tool-results|none>",
  "  --redaction <strict|standard>",
  "  --flush-interval-ms <n>  --batch-size <n>  --otlp-batch-size <n>",
  "  --gzip | --no-gzip  --json",
].join("\n");

interface ParsedArguments {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArguments(args: string): ParsedArguments {
  const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--")) return { values, flags };
    const key = token.slice(2);
    if (key === "") return { values, flags };
    if (["enable-remote", "disable-remote", "gzip", "no-gzip", "json"].includes(key)) {
      flags.add(key);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      values.set(key, "");
      continue;
    }
    values.set(key, value);
    index += 1;
  }
  return { values, flags };
}

function integerValue(parsed: ParsedArguments, key: string): number | undefined {
  const raw = parsed.values.get(key);
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`--${key}: expected an integer`);
  return Number(raw);
}

function ratioValue(parsed: ParsedArguments, key: string): number | undefined {
  const raw = parsed.values.get(key);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new ConfigError(`--${key}: expected a number between 0 and 1`);
  return value;
}

function captureValue(parsed: ParsedArguments): Partial<TelemetryOverrides["capture"]> | undefined {
  const raw = parsed.values.get("capture");
  if (raw === undefined) return undefined;
  if (raw === "none" || raw === "")
    return { prompts: false, completions: false, toolArguments: false, toolResults: false };
  const enabled = new Set(raw.split(",").map((value) => value.trim().toLowerCase()));
  const known = ["prompts", "completions", "tool-arguments", "tool-results"];
  for (const value of enabled) {
    if (!known.includes(value)) throw new ConfigError(`--capture: unknown value "${value}"`);
  }
  return {
    prompts: enabled.has("prompts"),
    completions: enabled.has("completions"),
    toolArguments: enabled.has("tool-arguments"),
    toolResults: enabled.has("tool-results"),
  };
}

function buildOverrides(parsed: ParsedArguments): TelemetryOverrides {
  const overrides: TelemetryOverrides = {};
  if (parsed.flags.has("enable-remote") || parsed.flags.has("disable-remote")) {
    overrides.otlp = {
      ...(overrides.otlp ?? {}),
      enabled: parsed.flags.has("enable-remote"),
    };
  }
  const endpoint = parsed.values.get("endpoint");
  if (endpoint !== undefined && endpoint !== "") {
    overrides.otlp = { ...(overrides.otlp ?? {}), endpoint };
  }
  const tokenEnv = parsed.values.get("token-env");
  if (tokenEnv !== undefined && tokenEnv !== "") {
    overrides.otlp = { ...(overrides.otlp ?? {}), tokenEnv };
  }
  const serviceName = parsed.values.get("service-name");
  if (serviceName !== undefined && serviceName !== "") {
    overrides.otlp = { ...(overrides.otlp ?? {}), serviceName };
  }
  const environment = parsed.values.get("environment");
  if (environment !== undefined) {
    overrides.otlp = { ...(overrides.otlp ?? {}), environment };
  }
  const instanceId = parsed.values.get("instance-id");
  if (instanceId !== undefined) {
    overrides.otlp = { ...(overrides.otlp ?? {}), instanceId };
  }
  const sampling = ratioValue(parsed, "sampling");
  if (sampling !== undefined)
    overrides.otlp = { ...(overrides.otlp ?? {}), samplingRatio: sampling };
  if (parsed.flags.has("gzip") || parsed.flags.has("no-gzip")) {
    overrides.otlp = { ...(overrides.otlp ?? {}), gzip: parsed.flags.has("gzip") };
  }
  const otlpBatchSize = integerValue(parsed, "otlp-batch-size");
  if (otlpBatchSize !== undefined)
    overrides.otlp = { ...(overrides.otlp ?? {}), batchSize: otlpBatchSize };

  const retentionDays = integerValue(parsed, "retention-days");
  if (retentionDays !== undefined) overrides.retentionDays = retentionDays;

  const capture = captureValue(parsed);
  if (capture !== undefined) overrides.capture = capture;

  const redaction = parsed.values.get("redaction");
  if (redaction !== undefined && redaction !== "") {
    if (redaction !== "strict" && redaction !== "standard")
      throw new ConfigError("--redaction: expected strict or standard");
    overrides.redaction = { mode: redaction };
  }

  const flushIntervalMs = integerValue(parsed, "flush-interval-ms");
  if (flushIntervalMs !== undefined)
    overrides.batch = { ...(overrides.batch ?? {}), flushIntervalMs };
  const batchSize = integerValue(parsed, "batch-size");
  if (batchSize !== undefined) overrides.batch = { ...(overrides.batch ?? {}), batchSize };

  return overrides;
}

/** Flatten a config to comparable dot-path primitives, without credentials. */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (value === null || typeof value !== "object") return { [prefix]: JSON.stringify(value) };
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    Object.assign(out, flatten(item, path));
  }
  return out;
}

function diffConfig(before: unknown, after: unknown): string[] {
  const left = flatten(before);
  const right = flatten(after);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    if (left[key] !== right[key])
      changes.push(`${key}: ${left[key] ?? "(unset)"} -> ${right[key] ?? "(unset)"}`);
  }
  return changes;
}

/** Replace a home-directory prefix with `~` so a path is not machine-specific. */
export function displayPath(path: string, home: string | undefined): string {
  if (home !== undefined && home !== "" && path.startsWith(home))
    return `~${path.slice(home.length)}`;
  return path;
}

function asJson(parsed: ParsedArguments): boolean {
  return parsed.flags.has("json");
}

export function registerCommands(api: PluginAPI, runtime: TelemetryRuntime): void {
  const register = (
    name: (typeof COMMAND_NAMES)[number],
    description: string,
    argumentHint: string,
    handler: (args: string, context?: CommandContext) => Promise<string>,
  ): void => {
    api.commands.register(name, handler, { description, argumentHint });
  };

  register(
    "telemetry-setup",
    "Persist telemetry configuration non-interactively",
    "[options]",
    async (args) => {
      const parsed = parseArguments(args);
      try {
        const base = runtime.config ?? createDefaultConfig();
        const overrides = buildOverrides(parsed);
        const next = updateConfig(base, overrides);
        writeConfigFile(runtime.paths.configFile, next);
        const before = runtime.config ? describeConfig(runtime.config, runtime.env) : null;
        const after = describeConfig(next, runtime.env);
        const changes =
          before === null ? ["configuration file created"] : diffConfig(before, after);
        const payload = {
          saved: true,
          configFile: displayPath(runtime.paths.configFile, runtime.env.HOME),
          changed: changes,
          restartRequired: true,
          note: "The OTLP token is never stored. It is read at export time from the environment variable named below.",
          tokenEnv: next.otlp.tokenEnv,
        };
        if (asJson(parsed)) return JSON.stringify(payload);
        return [
          `Telemetry configuration saved to ${payload.configFile}.`,
          changes.length === 0 ? "No fields changed." : "Changed:",
          ...changes.map((change) => `  ${change}`),
          `Token environment variable: ${payload.tokenEnv} (value never stored).`,
          "Restart Alisio to apply the new settings.",
        ].join("\n");
      } catch (error) {
        const message =
          error instanceof ConfigError ? error.message : "configuration could not be saved";
        return asJson(parsed)
          ? JSON.stringify({ saved: false, error: message })
          : `Telemetry setup failed: ${message}\n${SETUP_USAGE}`;
      }
    },
  );

  register(
    "telemetry-status",
    "Show effective telemetry configuration and local store stats",
    "",
    async (args) => {
      const parsed = parseArguments(args);
      const counts = runtime.store?.counts() ?? null;
      const payload = {
        enabled: runtime.store !== null,
        error: runtime.configError,
        config: runtime.config ? describeConfig(runtime.config, runtime.env) : null,
        database: displayPath(runtime.paths.database, runtime.env.HOME),
        configFile: displayPath(runtime.paths.configFile, runtime.env.HOME),
        remoteExport: runtime.exporter !== null,
        counts,
      };
      if (asJson(parsed)) return JSON.stringify(payload);
      if (runtime.configError !== null) {
        return `Telemetry is disabled: ${runtime.configError}\nConfig file: ${payload.configFile}\nDatabase: ${payload.database}`;
      }
      const config = payload.config ?? {};
      return [
        "Telemetry status",
        `  local store:   ${runtime.store === null ? "unavailable" : "open"}`,
        `  remote export: ${payload.remoteExport ? "enabled" : "disabled (local-only)"}`,
        `  database:      ${payload.database}`,
        `  config file:   ${payload.configFile}`,
        `  retention:     ${(config as { retentionDays?: number }).retentionDays ?? "-"} day(s)`,
        `  counts:        ${counts ? `${counts.runs} run(s), ${counts.turns} turn(s), ${counts.toolCalls} tool call(s), ${counts.content} content row(s)` : "-"}`,
        `  batches:       ${counts ? `${counts.pendingBatches} pending, ${counts.deadBatches} dead` : "-"}`,
        "  content capture is metadata-only unless explicitly enabled; the OTLP token is never stored.",
      ].join("\n");
    },
  );

  register(
    "telemetry-flush",
    "Flush queued records and attempt remote export",
    "",
    async (args) => {
      const parsed = parseArguments(args);
      const report = await runtime.flush();
      const payload = {
        records: report.records,
        content: report.content,
        dropped: report.dropped,
        queueSize: report.queueSize,
        optimized: report.optimized,
        error: report.error,
        exports: report.exports.map((result) => ({
          signal: result.signal,
          status: result.status,
          attempts: result.attempts,
          httpStatus: result.httpStatus,
          error: sanitizeField(result.error ?? "", 200),
        })),
      };
      if (asJson(parsed)) return JSON.stringify(payload);
      const lines = [
        `Flushed ${report.records} record(s) (${report.content} content row(s)) to the local store.`,
        `Queue: ${report.queueSize} pending, ${report.dropped} dropped since start.`,
        report.error === null ? "No flush errors." : `Flush error: ${report.error}`,
      ];
      if (payload.exports.length === 0)
        lines.push("Remote export is disabled (local-only); no network call was made.");
      else
        for (const result of payload.exports)
          lines.push(
            `  ${result.signal}: ${result.status} after ${result.attempts} attempt(s)${result.httpStatus === null ? "" : ` (HTTP ${result.httpStatus})`}`,
          );
      return lines.join("\n");
    },
  );

  register(
    "telemetry-prune",
    "Delete telemetry older than the retention window",
    "[--days <n>] [--json]",
    async (args) => {
      const parsed = parseArguments(args);
      const days = integerValue(parsed, "days");
      try {
        const report = runtime.prune(days);
        const payload = {
          cutoff: report.cutoff,
          retentionDays: report.retentionDays,
          deleted: report.deleted,
          note: report.note,
        };
        if (asJson(parsed)) return JSON.stringify(payload);
        return [
          `Pruned telemetry older than ${report.retentionDays} day(s) (before ${report.cutoff}).`,
          `Deleted ${report.deleted.runs} run(s), ${report.deleted.turns} turn(s), ${report.deleted.toolCalls} tool call(s), ${report.deleted.content} content row(s).`,
          report.note,
        ].join("\n");
      } catch (error) {
        const message = error instanceof ConfigError ? error.message : "prune failed";
        return asJson(parsed)
          ? JSON.stringify({ pruned: false, error: message })
          : `Telemetry prune failed: ${message}`;
      }
    },
  );
}
