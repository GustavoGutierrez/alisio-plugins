import type { Severity } from "../severity.js";
import type { Mode } from "../state/feature-state.js";
import type { Level } from "../state/levels.js";

export type CommandName = "typecheck" | "lint" | "test" | "testRelated" | "e2e" | "build";
export const commandNames: readonly CommandName[] = [
  "typecheck",
  "lint",
  "test",
  "testRelated",
  "e2e",
  "build",
];

export interface RuleOverrideConfig {
  severity?: Severity;
  enabled?: boolean;
  justification?: string;
  files?: string[];
  params?: Record<string, unknown>;
}

export interface CustomAgentConfig {
  name: string;
  attach: string;
  tier?: "reasoning" | "standard" | "fast";
}

export interface CustomGateConfig {
  id: string;
  phase: "build" | "validate";
  command: string[];
  timeoutMs?: number;
  report: "exit-code" | "frontsmith-json";
  required?: boolean;
  severity?: Severity;
}

/** Fully resolved project configuration (spec 8.4): every default applied. */
export interface FrontsmithConfig {
  schemaVersion: 1;
  paths: { artifacts: string; sourceRoots: string[]; themeOutput: string; tokenFiles: string[] };
  defaults: { level: Level; mode: Mode };
  commands: Partial<Record<CommandName, string[]>>;
  packs: { enable: string[]; disable: string[]; order: string[] };
  rules: Record<string, RuleOverrideConfig>;
  accessibility: { target: "AA" | "AAA"; operationalMargin: { text: number; nonText: number } };
  fidelity: {
    baseUrl: string;
    serve?: { command: string[]; readyUrl: string; timeoutMs: number };
    browser: "chromium" | "firefox" | "webkit";
    repetitions: number;
    calibrationPosition: number;
    maxImageBytes: number;
  };
  limits: {
    maxBounces: number;
    maxRepairRounds: number;
    maxRemediations: number;
    maxTaskFiles: number;
    maxTaskCriteria: number;
    commandTimeoutMs: number;
  };
  models: {
    tiers: { reasoning: string; standard: string; fast: string };
    agents: Record<string, string>;
  };
  agents: { custom: CustomAgentConfig[] };
  gates: { custom: CustomGateConfig[] };
  adapters: { enable: string[]; disable: string[] };
  dashboard: { enabled: boolean };
}

/** The file shape: every key optional except `schemaVersion`. */
export type RawConfig = {
  schemaVersion: 1;
} & { [K in Exclude<keyof FrontsmithConfig, "schemaVersion">]?: DeepPartial<FrontsmithConfig[K]> };

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** The documented defaults (spec 8.4). `commands` stays empty: missing commands are inferred. */
export function defaultConfig(): FrontsmithConfig {
  return {
    schemaVersion: 1,
    paths: {
      artifacts: "docs/frontsmith",
      sourceRoots: ["src"],
      themeOutput: "src/styles/frontsmith-tokens.css",
      tokenFiles: ["src/styles/**/*.css"],
    },
    defaults: { level: "L2", mode: "build" },
    commands: {},
    packs: { enable: [], disable: [], order: [] },
    rules: {},
    accessibility: { target: "AA", operationalMargin: { text: 4.5, nonText: 3 } },
    fidelity: {
      baseUrl: "http://127.0.0.1:5173",
      browser: "chromium",
      repetitions: 7,
      calibrationPosition: 0.5,
      maxImageBytes: 2000000,
    },
    limits: {
      maxBounces: 2,
      maxRepairRounds: 3,
      maxRemediations: 2,
      maxTaskFiles: 8,
      maxTaskCriteria: 4,
      commandTimeoutMs: 600000,
    },
    models: { tiers: { reasoning: "inherit", standard: "inherit", fast: "inherit" }, agents: {} },
    agents: { custom: [] },
    gates: { custom: [] },
    adapters: { enable: [], disable: [] },
    dashboard: { enabled: true },
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function merge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Record-like maps (rules, models.agents, commands) are taken whole from the override.
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

/** Apply defaults to a validated raw config; explicit values win, nested objects are merged. */
export function resolveConfig(raw: RawConfig): FrontsmithConfig {
  return merge(defaultConfig(), raw) as FrontsmithConfig;
}
