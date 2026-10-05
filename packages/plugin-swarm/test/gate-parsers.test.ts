import { describe, expect, it } from "vitest";
import {
  isSourceFile,
  isTestFile,
  parseEslintComplexity,
  parseIstanbulSummary,
  parseStrykerReport,
} from "../src/gates/parsers.js";

const root = "/scratch/p";

const summary = (lines: number, files: Record<string, number> = {}) =>
  JSON.stringify({
    total: { lines: { total: 10, covered: 8, skipped: 0, pct: lines } },
    ...Object.fromEntries(Object.entries(files).map(([file, pct]) => [file, { lines: { pct } }])),
  });

describe("parseIstanbulSummary", () => {
  it("reads total line coverage and per-file fractions relative to the root", () => {
    const parsed = parseIstanbulSummary(summary(82.5, { [`${root}/src/a.ts`]: 50 }), root);
    expect(parsed.coverage).toBe(82.5);
    expect(parsed.files.get("src/a.ts")).toBe(0.5);
  });

  it("rejects an unknown total and garbage", () => {
    expect(() => parseIstanbulSummary(summary("Unknown" as never), root)).toThrow(/coverage/i);
    expect(() => parseIstanbulSummary("not json", root)).toThrow(/unparseable|json/i);
    expect(() => parseIstanbulSummary("[]", root)).toThrow(/coverage/i);
  });
});

const eslint = (
  messages: Array<{ message: string; line?: number; ruleId?: string }>,
  file = `${root}/src/a.ts`,
) =>
  JSON.stringify([
    {
      filePath: file,
      messages: messages.map((m) => ({ ruleId: "complexity", line: 1, severity: 2, ...m })),
    },
  ]);

describe("parseEslintComplexity", () => {
  it("extracts named and anonymous functions with their complexity", () => {
    const out = parseEslintComplexity(
      eslint([
        { message: "Function 'load' has a complexity of 7. Maximum allowed is 1.", line: 3 },
        { message: "Arrow function has a complexity of 2. Maximum allowed is 1.", line: 9 },
        { message: "Method 'run' has a complexity of 4. Maximum allowed is 1.", line: 12 },
      ]),
      root,
    );
    expect(out).toEqual([
      { file: "src/a.ts", name: "load", complexity: 7 },
      { file: "src/a.ts", name: "anonymous:9", complexity: 2 },
      { file: "src/a.ts", name: "run", complexity: 4 },
    ]);
  });

  it("ignores other rules, test files and dependencies", () => {
    const text = JSON.stringify([
      {
        filePath: `${root}/src/a.test.ts`,
        messages: [
          { ruleId: "complexity", line: 1, message: "Function 'x' has a complexity of 9." },
        ],
      },
      {
        filePath: `${root}/node_modules/x/i.js`,
        messages: [
          { ruleId: "complexity", line: 1, message: "Function 'y' has a complexity of 9." },
        ],
      },
      {
        filePath: `${root}/src/b.ts`,
        messages: [{ ruleId: "no-unused-vars", line: 1, message: "nope" }],
      },
    ]);
    expect(parseEslintComplexity(text, root)).toEqual([]);
  });

  it("rejects garbage", () => {
    expect(() => parseEslintComplexity("Oops, eslint crashed", root)).toThrow(/unparseable|json/i);
    expect(() => parseEslintComplexity("{}", root)).toThrow(/array/i);
  });
});

const report = (files: Record<string, string[]>) =>
  JSON.stringify({
    schemaVersion: "2",
    files: Object.fromEntries(
      Object.entries(files).map(([file, statuses]) => [
        file,
        {
          mutants: statuses.map((status, index) => ({
            id: String(index),
            mutatorName: "ConditionalExpression",
            replacement: "true",
            status,
            location: {
              start: { line: index + 1, column: 1 },
              end: { line: index + 1, column: 5 },
            },
          })),
        },
      ]),
    ),
  });

describe("parseStrykerReport", () => {
  it("scores killed and timed-out mutants against survivors and uncovered ones", () => {
    const parsed = parseStrykerReport(
      report({
        "src/a.ts": ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "Ignored"],
      }),
    );
    expect(parsed.score).toBe(50);
    expect(parsed.detected).toBe(2);
    expect(parsed.undetected).toBe(2);
    expect(parsed.survivors).toHaveLength(2);
    expect(parsed.survivors[0]).toContain("src/a.ts:3");
  });

  it("is differential: only the changed files count", () => {
    const text = report({ "src/a.ts": ["Killed", "Killed"], "src/b.ts": ["Survived"] });
    expect(parseStrykerReport(text, ["src/a.ts"]).score).toBe(100);
    expect(parseStrykerReport(text, ["src/b.ts"]).score).toBe(0);
    expect(parseStrykerReport(text, ["src/other.ts"]).score).toBeUndefined();
  });

  it("has no score when nothing was mutated", () => {
    expect(parseStrykerReport(report({})).score).toBeUndefined();
  });

  it("rejects garbage and a wrong shape", () => {
    expect(() => parseStrykerReport("<html>")).toThrow(/unparseable|json/i);
    expect(() => parseStrykerReport(JSON.stringify({ nope: 1 }))).toThrow(/files/i);
  });

  it("caps the number of listed survivors", () => {
    const many = Array.from({ length: 60 }, () => "Survived");
    expect(parseStrykerReport(report({ "src/a.ts": many })).survivors.length).toBeLessThanOrEqual(
      20,
    );
  });
});

describe("file classification", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.mjs", true],
    ["test/a.ts", true],
    ["packages/x/__tests__/a.ts", true],
    ["src/a.ts", false],
    ["README.md", false],
  ])("isTestFile(%s) is %s", (path, expected) => expect(isTestFile(path)).toBe(expected));

  it.each([
    ["src/a.ts", true],
    ["src/a.d.ts", false],
    ["src/a.test.ts", false],
    ["dist/a.js", false],
    ["node_modules/x/a.js", false],
    ["docs/a.md", false],
    ["coverage/lcov.js", false],
  ])("isSourceFile(%s) is %s", (path, expected) => expect(isSourceFile(path)).toBe(expected));
});
