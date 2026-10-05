import { describe, expect, it } from "vitest";
import { defaultThresholds } from "../src/domain/pack.js";
import { parseToolchain } from "../src/toolchains/profile.js";
import { crap, evaluateThresholds } from "../src/toolchains/thresholds.js";

describe("CRAP", () => {
  it("applies the published formula CC^2 * (1 - cov)^3 + CC", () => {
    expect(crap(1, 1)).toBe(1);
    expect(crap(3, 0)).toBe(12);
    expect(crap(6, 0.5)).toBeCloseTo(10.5, 10);
  });

  it("rejects impossible inputs", () => {
    expect(() => crap(0, 0.5)).toThrow(/complexity/i);
    expect(() => crap(2, 1.5)).toThrow(/coverage/i);
    expect(() => crap(2, -0.1)).toThrow(/coverage/i);
    expect(() => crap(Number.NaN, 0.5)).toThrow(/complexity/i);
  });
});

describe("evaluateThresholds", () => {
  it("passes when every supplied metric is inside its threshold", () => {
    const result = evaluateThresholds(defaultThresholds, {
      coverage: 91,
      mutation: 85,
      functions: [{ file: "a.ts", name: "f", complexity: 3, coverage: 1 }],
    });
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("reports each failing gate with a readable message", () => {
    const result = evaluateThresholds(defaultThresholds, {
      coverage: 70,
      mutation: 50,
      functions: [
        { file: "a.ts", name: "tangled", complexity: 9, coverage: 1 },
        { file: "b.ts", name: "risky", complexity: 4, coverage: 0 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.gate).sort()).toEqual([
      "complexity",
      "coverage",
      "crap",
      "crap",
      "mutation",
    ]);
    expect(result.failures.find((f) => f.gate === "complexity")?.message).toContain("tangled");
    expect(result.failures.find((f) => f.message.includes("risky"))?.gate).toBe("crap");
  });

  it("skips metrics that were not measured", () => {
    expect(evaluateThresholds(defaultThresholds, {})).toEqual({ passed: true, failures: [] });
  });

  it("treats thresholds as inclusive boundaries", () => {
    const result = evaluateThresholds(defaultThresholds, {
      coverage: 80,
      mutation: 80,
      functions: [{ file: "a.ts", name: "edge", complexity: 6, coverage: 1 }],
    });
    expect(result.passed).toBe(true);
  });
});

describe("parseToolchain", () => {
  const valid = {
    schemaVersion: 1,
    id: "node-ts",
    description: "Node and TypeScript",
    detect: ["package.json"],
    commands: {
      test: { argv: ["npm", "test"], parser: "exit-code" },
      coverage: { argv: ["npm", "run", "coverage"], parser: "istanbul-summary" },
    },
  };

  it("parses a profile", () => {
    expect(parseToolchain(valid).commands.test).toEqual({
      argv: ["npm", "test"],
      parser: "exit-code",
    });
  });

  it("rejects shell strings, unknown parsers, bad ids and unknown keys", () => {
    const bad = (patch: Record<string, unknown>) => () => parseToolchain({ ...valid, ...patch });
    expect(bad({ id: "Node TS" })).toThrow(/toolchain id/i);
    expect(bad({ extra: 1 })).toThrow(/unknown key/i);
    expect(bad({ commands: { test: { argv: "npm test", parser: "exit-code" } } })).toThrow(/argv/);
    expect(bad({ commands: { test: { argv: [], parser: "exit-code" } } })).toThrow(/argv/);
    expect(bad({ commands: { test: { argv: ["npm"], parser: "magic" } } })).toThrow(/parser/);
    expect(bad({ commands: { unknown: { argv: ["x"], parser: "exit-code" } } })).toThrow(/command/);
    expect(bad({ detect: ["../x"] })).toThrow(/relative path/i);
  });
});
