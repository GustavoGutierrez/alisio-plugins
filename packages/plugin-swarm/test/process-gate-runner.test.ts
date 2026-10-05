import { describe, expect, it } from "vitest";
import type { Exec, ExecOptions, ExecResult } from "../src/adapters/process-exec.js";
import { ProcessGateRunner } from "../src/adapters/process-gate-runner.js";
import type { GateName } from "../src/domain/pack.js";
import { defaultThresholds } from "../src/domain/pack.js";
import type { GateRequest } from "../src/ports/gate-runner.js";
import { parseToolchain } from "../src/toolchains/profile.js";

const root = "/scratch/p";

const toolchain = parseToolchain({
  schemaVersion: 1,
  id: "node-ts",
  description: "fixture",
  detect: ["package.json"],
  commands: {
    test: { argv: ["fake-test"], parser: "exit-code" },
    coverage: {
      argv: ["fake-cov"],
      parser: "istanbul-summary",
      report: "coverage/coverage-summary.json",
    },
    complexity: { argv: ["fake-complexity"], parser: "eslint-complexity" },
    mutation: {
      argv: ["fake-mutate"],
      parser: "stryker-json",
      report: "reports/mutation/mutation.json",
    },
  },
});

const ok = (stdout = "", extra: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
  ...extra,
});

type Handler = (argv: string[], options: ExecOptions) => ExecResult | Promise<ExecResult>;

function harness(handlers: Record<string, Handler>, files: Record<string, string> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (argv, options) => {
    calls.push(argv);
    const key = argv[0] === "git" ? `git ${argv[1]}` : (argv[0] as string);
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected command ${key}`);
    return handler(argv, options);
  };
  const runner = new ProcessGateRunner({
    loadToolchain: async () => toolchain,
    exec,
    readFile: async (_workdir, path) => files[path],
  });
  const request = (gate: GateName, extra: Partial<GateRequest> = {}): GateRequest => ({
    project: "demo",
    task: "add-login",
    role: "coder",
    gate,
    workdir: root,
    toolchain: "node-ts",
    thresholds: defaultThresholds,
    since: "abc1234567",
    ...extra,
  });
  return { runner, calls, request };
}

const summary = (pct: number) => JSON.stringify({ total: { lines: { pct } } });
const mutation = (statuses: string[], file = "src/a.ts") =>
  JSON.stringify({
    files: {
      [file]: {
        mutants: statuses.map((status, i) => ({
          id: String(i),
          status,
          mutatorName: "M",
          location: { start: { line: i + 1 } },
        })),
      },
    },
  });

describe("tests-green and acceptance", () => {
  it("passes on exit code 0 and fails with the output tail otherwise", async () => {
    const pass = harness({ "fake-test": () => ok("all good") });
    expect(await pass.runner.run(pass.request("tests-green"))).toMatchObject({
      gate: "tests-green",
      passed: true,
    });
    const fail = harness({ "fake-test": () => ok("1 failing\nexpected true", { code: 1 }) });
    const report = await fail.runner.run(fail.request("tests-green"));
    expect(report.passed).toBe(false);
    expect(report.findings.join("\n")).toContain("expected true");
  });

  it("reports a timeout as a failure and a missing command as an error", async () => {
    const slow = harness({ "fake-test": () => ok("", { code: null, timedOut: true }) });
    const timeout = await slow.runner.run(slow.request("tests-green"));
    expect(timeout).toMatchObject({ passed: false, timedOut: true });
    expect(timeout.findings.join(" ")).toMatch(/timed out/i);
    const missing = harness({ "fake-test": () => ok("", { code: null, spawnError: "ENOENT" }) });
    const error = await missing.runner.run(missing.request("tests-green"));
    expect(error.passed).toBe(false);
    expect(error.error).toMatch(/ENOENT/);
  });

  it("flags a runaway output as a failure", async () => {
    const h = harness({ "fake-test": () => ok("x", { code: null, truncated: true }) });
    const report = await h.runner.run(h.request("tests-green"));
    expect(report.passed).toBe(false);
    expect(report.findings.join(" ")).toMatch(/output/i);
  });

  it("runs the acceptance command when the profile has none by falling back to the tests", async () => {
    const h = harness({ "fake-test": () => ok("fine") });
    expect((await h.runner.run(h.request("acceptance"))).passed).toBe(true);
    expect(h.calls[0]).toEqual(["fake-test"]);
  });
});

describe("test-first", () => {
  const diff =
    (names: string[]): Handler =>
    () =>
      ok(names.join("\n"));

  it("passes when a test file is part of the diff", async () => {
    const h = harness({ "git diff": diff(["src/a.ts", "src/a.test.ts"]) });
    expect((await h.runner.run(h.request("test-first"))).passed).toBe(true);
    expect(h.calls[0]).toEqual([
      "git",
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "abc1234567..HEAD",
    ]);
  });

  it("fails when production code changed without a test", async () => {
    const h = harness({ "git diff": diff(["src/a.ts"]) });
    const report = await h.runner.run(h.request("test-first"));
    expect(report.passed).toBe(false);
    expect(report.findings.join(" ")).toMatch(/test file/i);
  });

  it("fails on an empty diff and errors without a base commit", async () => {
    const empty = harness({ "git diff": diff([]) });
    expect((await empty.runner.run(empty.request("test-first"))).passed).toBe(false);
    const none = harness({});
    const noBase = await none.runner.run(none.request("test-first", { since: undefined as never }));
    expect(noBase.error).toMatch(/base commit/i);
  });
});

describe("coverage", () => {
  const files = { "coverage/coverage-summary.json": summary(85) };

  it("passes at or above the threshold", async () => {
    const h = harness({ "fake-cov": () => ok() }, files);
    expect((await h.runner.run(h.request("coverage"))).passed).toBe(true);
  });

  it("fails below the threshold with the measured value", async () => {
    const h = harness(
      { "fake-cov": () => ok() },
      { "coverage/coverage-summary.json": summary(40) },
    );
    const report = await h.runner.run(h.request("coverage"));
    expect(report.passed).toBe(false);
    expect(report.findings[0]).toMatch(/40%.*80%/);
  });

  it("uses pack thresholds, never constants", async () => {
    const h = harness(
      { "fake-cov": () => ok() },
      { "coverage/coverage-summary.json": summary(60) },
    );
    const report = await h.runner.run(
      h.request("coverage", { thresholds: { ...defaultThresholds, coverage: 50 } }),
    );
    expect(report.passed).toBe(true);
  });

  it("errors on a garbage report and fails when the coverage run itself fails", async () => {
    const garbage = harness(
      { "fake-cov": () => ok() },
      { "coverage/coverage-summary.json": "<<<" },
    );
    expect((await garbage.runner.run(garbage.request("coverage"))).error).toMatch(/unparseable/i);
    const missing = harness({ "fake-cov": () => ok() }, {});
    expect((await missing.runner.run(missing.request("coverage"))).error).toMatch(/report/i);
    const red = harness({ "fake-cov": () => ok("boom", { code: 1 }) }, files);
    const report = await red.runner.run(red.request("coverage"));
    expect(report.passed).toBe(false);
    expect(report.findings.join(" ")).toMatch(/boom/);
  });
});

describe("crap", () => {
  const eslint = (complexity: number) =>
    JSON.stringify([
      {
        filePath: `${root}/src/a.ts`,
        messages: [
          {
            ruleId: "complexity",
            line: 4,
            message: `Function 'load' has a complexity of ${complexity}. Maximum allowed is 1.`,
          },
        ],
      },
    ]);
  const cov = (pct: number) =>
    JSON.stringify({ total: { lines: { pct } }, [`${root}/src/a.ts`]: { lines: { pct } } });
  const handlers = (
    complexity: number,
    changed = "src/a.ts\nsrc/a.test.ts",
  ): Record<string, Handler> => ({
    "git diff": () => ok(changed),
    "fake-complexity": () => ok(eslint(complexity), { code: 1 }),
    "fake-cov": () => ok(),
  });

  it("passes a simple, well-covered function", async () => {
    const h = harness(handlers(3), { "coverage/coverage-summary.json": cov(100) });
    expect((await h.runner.run(h.request("crap"))).passed).toBe(true);
  });

  it("fails a complex, uncovered function on complexity and CRAP", async () => {
    const h = harness(handlers(12), { "coverage/coverage-summary.json": cov(0) });
    const report = await h.runner.run(h.request("crap"));
    expect(report.passed).toBe(false);
    const text = report.findings.join("\n");
    expect(text).toContain("src/a.ts#load");
    expect(text).toMatch(/CRAP/);
  });

  it("only looks at files changed since the base commit", async () => {
    const h = harness(handlers(12, "src/other.ts"), {
      "coverage/coverage-summary.json": cov(0),
    });
    const report = await h.runner.run(h.request("crap"));
    expect(report.passed).toBe(true);
  });

  it("errors on unparseable lint output", async () => {
    const h = harness(
      {
        "git diff": () => ok("src/a.ts"),
        "fake-complexity": () => ok("crash"),
        "fake-cov": () => ok(),
      },
      { "coverage/coverage-summary.json": cov(100) },
    );
    expect((await h.runner.run(h.request("crap"))).error).toMatch(/unparseable/i);
  });
});

describe("dry", () => {
  const dup = [
    "const alpha = computeAlpha(input);",
    "const beta = computeBeta(alpha);",
    "const gamma = combine(alpha, beta);",
    "emitResult(gamma, options);",
    "return finish(gamma);",
    "logOutcome(gamma, beta);",
    "persist(gamma);",
  ].join("\n");
  const base = (changed: string): Record<string, Handler> => ({
    "git diff": () => ok(changed),
    "git ls-files": () => ok("src/a.ts\nsrc/b.ts\nREADME.md"),
  });

  it("fails when a changed file duplicates another block", async () => {
    const h = harness(base("src/a.ts"), { "src/a.ts": dup, "src/b.ts": dup });
    const report = await h.runner.run(h.request("dry"));
    expect(report.passed).toBe(false);
    expect(report.findings[0]).toMatch(/Duplicate block/);
  });

  it("passes when nothing changed is duplicated", async () => {
    const h = harness(base("src/a.ts"), {
      "src/a.ts": "const one = 1 + 2 + 3;\n",
      "src/b.ts": dup,
    });
    expect((await h.runner.run(h.request("dry"))).passed).toBe(true);
  });
});

describe("mutation", () => {
  const handlers = (changed: string): Record<string, Handler> => ({
    "git diff": () => ok(changed),
    "fake-mutate": () => ok(),
  });
  const reportFile = "reports/mutation/mutation.json";

  it("is differential: it mutates only the changed source files", async () => {
    const h = harness(handlers("src/a.ts\nsrc/a.test.ts\nREADME.md"), {
      [reportFile]: mutation(["Killed", "Killed", "Killed", "Killed", "Survived"]),
    });
    const report = await h.runner.run(h.request("mutation"));
    expect(report.passed).toBe(true);
    const run = h.calls.find((argv) => argv[0] === "fake-mutate") as string[];
    expect(run).toEqual(["fake-mutate", "--mutate", "src/a.ts"]);
  });

  it("fails below the threshold and lists survivors", async () => {
    const h = harness(handlers("src/a.ts"), {
      [reportFile]: mutation(["Killed", "Survived", "Survived", "NoCoverage"]),
    });
    const report = await h.runner.run(h.request("mutation"));
    expect(report.passed).toBe(false);
    expect(report.findings[0]).toMatch(/25%.*80%/);
    expect(report.findings.join("\n")).toContain("src/a.ts:2");
  });

  it("skips when no source file changed and errors on a garbage report", async () => {
    const none = harness(handlers("README.md"), {});
    expect(await none.runner.run(none.request("mutation"))).toMatchObject({ passed: true });
    expect((await none.runner.run(none.request("mutation"))).skipped).toMatch(/no changed source/i);
    const bad = harness(handlers("src/a.ts"), { [reportFile]: "<<<" });
    expect((await bad.runner.run(bad.request("mutation"))).error).toMatch(/unparseable/i);
  });

  it("times out as a failure", async () => {
    const h = harness(
      {
        "git diff": () => ok("src/a.ts"),
        "fake-mutate": () => ok("", { code: null, timedOut: true }),
      },
      {},
    );
    expect(await h.runner.run(h.request("mutation"))).toMatchObject({
      passed: false,
      timedOut: true,
    });
  });
});

describe("structure and unsupported gates", () => {
  it("is skipped with a stated reason rather than reported as verified", async () => {
    const h = harness({});
    const report = await h.runner.run(h.request("structure"));
    expect(report).toMatchObject({ passed: true });
    expect(report.skipped).toMatch(/no deterministic/i);
  });
});

describe("cancelAll", () => {
  it("stops tracked processes", async () => {
    const h = harness({});
    expect(() => h.runner.cancelAll()).not.toThrow();
  });
});
