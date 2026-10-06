import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig, resolveConfig } from "../src/domain/config/defaults.js";
import { validateConfig } from "../src/domain/config/validate.js";
import { validateAgainstSchema } from "./helpers/json-schema.js";

const schemaPath = new URL("../schemas/config.schema.json", import.meta.url);
const loadSchema = async () =>
  JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;

const valid: Array<[string, unknown]> = [
  ["minimal", { schemaVersion: 1 }],
  [
    "paths and defaults",
    {
      schemaVersion: 1,
      paths: { artifacts: "docs/fs", sourceRoots: ["src", "app"] },
      defaults: { level: "L1", mode: "refine" },
    },
  ],
  [
    "commands with files placeholder",
    {
      schemaVersion: 1,
      commands: {
        test: ["pnpm", "test"],
        testRelated: ["pnpm", "vitest", "related", "--run", "{files}"],
      },
    },
  ],
  [
    "rule override",
    {
      schemaVersion: 1,
      rules: {
        "FS-CSS-002": { severity: "nit", justification: "Utility layer uses !important by design" },
      },
    },
  ],
  [
    "fidelity",
    {
      schemaVersion: 1,
      fidelity: {
        baseUrl: "http://127.0.0.1:5173",
        serve: { command: ["pnpm", "dev"], readyUrl: "http://localhost:5173/", timeoutMs: 60000 },
        browser: "chromium",
        repetitions: 7,
        calibrationPosition: 0.5,
        maxImageBytes: 2000000,
      },
    },
  ],
  [
    "models and extension lists",
    {
      schemaVersion: 1,
      models: { tiers: { reasoning: "inherit" }, agents: { "fs-reviewer": "@reasoning" } },
      agents: { custom: [{ name: "acme-i18n-reviewer", attach: "review", tier: "standard" }] },
      gates: {
        custom: [
          {
            id: "storybook-tests",
            phase: "validate",
            command: ["pnpm", "test-storybook"],
            timeoutMs: 600000,
            report: "exit-code",
            required: true,
            severity: "major",
          },
        ],
      },
      adapters: { enable: ["react"], disable: [] },
      dashboard: { enabled: false },
    },
  ],
  ["full defaults", defaultConfig()],
];

const invalid: Array<[string, unknown, string, string]> = [
  ["not an object", [], "CFG-002", ""],
  ["missing schemaVersion", {}, "CFG-003", "/schemaVersion"],
  ["unsupported schemaVersion", { schemaVersion: 2 }, "CFG-003", "/schemaVersion"],
  ["unknown top-level key", { schemaVersion: 1, extra: 1 }, "CFG-001", "/extra"],
  [
    "effort is rejected as unknown",
    { schemaVersion: 1, models: { effort: "high" } },
    "CFG-001",
    "/models/effort",
  ],
  [
    "unknown nested key",
    { schemaVersion: 1, limits: { maxBounces: 2, nope: 1 } },
    "CFG-001",
    "/limits/nope",
  ],
  ["bad level", { schemaVersion: 1, defaults: { level: "L7" } }, "CFG-002", "/defaults/level"],
  [
    "negative limit",
    { schemaVersion: 1, limits: { maxBounces: -1 } },
    "CFG-002",
    "/limits/maxBounces",
  ],
  [
    "non integer limit",
    { schemaVersion: 1, limits: { maxTaskFiles: 1.5 } },
    "CFG-002",
    "/limits/maxTaskFiles",
  ],
  [
    "remote baseUrl",
    { schemaVersion: 1, fidelity: { baseUrl: "https://example.com" } },
    "CFG-004",
    "/fidelity/baseUrl",
  ],
  [
    "remote readyUrl",
    { schemaVersion: 1, fidelity: { serve: { command: ["x"], readyUrl: "http://10.0.0.1:80/" } } },
    "CFG-004",
    "/fidelity/serve/readyUrl",
  ],
  [
    "baseUrl without port",
    { schemaVersion: 1, fidelity: { baseUrl: "http://127.0.0.1" } },
    "CFG-004",
    "/fidelity/baseUrl",
  ],
  ["empty argv", { schemaVersion: 1, commands: { test: [] } }, "CFG-005", "/commands/test"],
  [
    "argv with NUL",
    { schemaVersion: 1, commands: { test: ["a\u0000b"] } },
    "CFG-005",
    "/commands/test/0",
  ],
  [
    "files placeholder not whole",
    { schemaVersion: 1, commands: { testRelated: ["x", "--f={files}"] } },
    "CFG-005",
    "/commands/testRelated/1",
  ],
  [
    "argv not strings",
    { schemaVersion: 1, commands: { lint: ["a", 2] } },
    "CFG-005",
    "/commands/lint/1",
  ],
  [
    "argv too long",
    { schemaVersion: 1, commands: { lint: Array.from({ length: 33 }, () => "a") } },
    "CFG-005",
    "/commands/lint",
  ],
  [
    "path escapes",
    { schemaVersion: 1, paths: { artifacts: "../out" } },
    "CFG-006",
    "/paths/artifacts",
  ],
  [
    "absolute source root",
    { schemaVersion: 1, paths: { sourceRoots: ["/etc"] } },
    "CFG-006",
    "/paths/sourceRoots/0",
  ],
  [
    "backslash path",
    { schemaVersion: 1, paths: { themeOutput: "a\\b.css" } },
    "CFG-006",
    "/paths/themeOutput",
  ],
  [
    "bad rule id",
    { schemaVersion: 1, rules: { nope: { severity: "nit" } } },
    "CFG-002",
    "/rules/nope",
  ],
  [
    "bad rule severity",
    { schemaVersion: 1, rules: { "FS-CSS-002": { severity: "huge" } } },
    "CFG-002",
    "/rules/FS-CSS-002/severity",
  ],
  [
    "bad pack id",
    { schemaVersion: 1, packs: { enable: ["Bad Pack"] } },
    "CFG-002",
    "/packs/enable/0",
  ],
  [
    "bad accessibility target",
    { schemaVersion: 1, accessibility: { target: "A" } },
    "CFG-002",
    "/accessibility/target",
  ],
  [
    "bad browser",
    { schemaVersion: 1, fidelity: { browser: "ie" } },
    "CFG-002",
    "/fidelity/browser",
  ],
  [
    "calibration position out of range",
    { schemaVersion: 1, fidelity: { calibrationPosition: 2 } },
    "CFG-002",
    "/fidelity/calibrationPosition",
  ],
  [
    "bad custom gate",
    {
      schemaVersion: 1,
      gates: { custom: [{ id: "X", phase: "validate", command: ["a"], report: "exit-code" }] },
    },
    "CFG-002",
    "/gates/custom/0/id",
  ],
  [
    "custom agent reserved prefix",
    { schemaVersion: 1, agents: { custom: [{ name: "fs-evil", attach: "review" }] } },
    "CFG-002",
    "/agents/custom/0/name",
  ],
  [
    "tier not a string",
    { schemaVersion: 1, models: { tiers: { reasoning: 3 } } },
    "CFG-002",
    "/models/tiers/reasoning",
  ],
];

describe("config validator", () => {
  it.each(valid)("accepts %s", (_name, raw) => {
    const result = validateConfig(raw);
    expect(result.ok).toBe(true);
  });

  it.each(invalid)("rejects %s", (_name, raw, code, pointer) => {
    const result = validateConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, pointer }));
    }
  });

  it("reports several problems at once", () => {
    const result = validateConfig({ schemaVersion: 1, extra: 1, defaults: { level: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
  });
});

describe("config defaults", () => {
  it("fills every documented default", () => {
    const config = resolveConfig({ schemaVersion: 1 });
    expect(config.paths.artifacts).toBe("docs/frontsmith");
    expect(config.paths.sourceRoots).toEqual(["src"]);
    expect(config.defaults).toEqual({ level: "L2", mode: "build" });
    expect(config.limits).toEqual({
      maxBounces: 2,
      maxRepairRounds: 3,
      maxRemediations: 2,
      maxTaskFiles: 8,
      maxTaskCriteria: 4,
      commandTimeoutMs: 600000,
    });
    expect(config.fidelity.repetitions).toBe(7);
    expect(config.fidelity.browser).toBe("chromium");
    expect(config.accessibility).toEqual({
      target: "AA",
      operationalMargin: { text: 4.5, nonText: 3 },
    });
    expect(config.models.tiers).toEqual({
      reasoning: "inherit",
      standard: "inherit",
      fast: "inherit",
    });
    expect(config.dashboard.enabled).toBe(true);
    expect(config.commands).toEqual({});
  });

  it("lets explicit values win and merges nested objects", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      limits: { maxBounces: 5 },
      fidelity: { repetitions: 9 },
    });
    expect(config.limits.maxBounces).toBe(5);
    expect(config.limits.maxRepairRounds).toBe(3);
    expect(config.fidelity.repetitions).toBe(9);
    expect(config.fidelity.calibrationPosition).toBe(0.5);
  });
});

describe("config schema agreement", () => {
  it.each(valid)("schema accepts %s", async (_name, raw) => {
    expect(validateAgainstSchema(await loadSchema(), raw)).toEqual([]);
  });

  it.each(invalid)("schema rejects %s", async (_name, raw) => {
    expect(validateAgainstSchema(await loadSchema(), raw).length).toBeGreaterThan(0);
  });
});
