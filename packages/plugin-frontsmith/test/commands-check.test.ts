import { describe, expect, it } from "vitest";
import {
  commandPrepared,
  expandArgv,
  runProjectCommand,
  selectTestCommand,
} from "../src/application/checks/commands-check.js";
import { runCustomGates, validateGateReportJson } from "../src/application/checks/custom-gates.js";
import type {
  ExecOptions,
  ExecResult,
  ProcessRunner,
} from "../src/application/ports/process-runner.js";

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  cancelled: false,
  durationMs: 1200,
  ...over,
});

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ argv: readonly string[]; options: ExecOptions }> = [];
  constructor(
    private readonly replies: Array<ExecResult | ((argv: readonly string[]) => ExecResult)> = [],
  ) {}
  async run(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push({ argv, options });
    const next = this.replies.shift() ?? result();
    return typeof next === "function" ? next(argv) : next;
  }
}

const writes: Array<{ path: string; content: string }> = [];
const writer = {
  write: async (_root: string, path: string, content: string) =>
    void writes.push({ path, content }),
};
const deps = (runner: ProcessRunner) => ({ process: runner, writer });
const base = {
  root: "/w/app",
  timeoutMs: 1000,
  logPath: ".alisio/frontsmith/evidence/projects/r1/typecheck.log",
};

describe("expandArgv", () => {
  it("replaces a whole {files} element with the file list", () => {
    expect(
      expandArgv(["pnpm", "exec", "vitest", "related", "--run", "{files}"], ["a.ts", "b.ts"]),
    ).toEqual({
      ok: true,
      argv: ["pnpm", "exec", "vitest", "related", "--run", "a.ts", "b.ts"],
    });
  });

  it("leaves an argv without the placeholder untouched and never expands a partial element", () => {
    expect(expandArgv(["pnpm", "test"], ["a.ts"])).toEqual({ ok: true, argv: ["pnpm", "test"] });
    expect(expandArgv(["x", "--files={files}"], ["a.ts"])).toEqual({
      ok: true,
      argv: ["x", "--files={files}"],
    });
  });

  it("rejects more than 200 files and unsafe file names", () => {
    expect(
      expandArgv(
        ["x", "{files}"],
        Array.from({ length: 201 }, (_, i) => `f${i}.ts`),
      ),
    ).toEqual({ ok: false, reason: "too-many-files" });
    expect(expandArgv(["x", "{files}"], ["../escape.ts"])).toEqual({
      ok: false,
      reason: "unsafe-file",
    });
    expect(expandArgv(["x", "{files}"], ["-rf"])).toEqual({ ok: false, reason: "unsafe-file" });
  });
});

describe("selectTestCommand", () => {
  const plan = {
    test: { argv: ["pnpm", "run", "test"], source: "inferred:package.json#scripts.test" },
    testRelated: {
      argv: ["pnpm", "exec", "vitest", "related", "--run", "{files}"],
      source: "inferred:vitest",
    },
  };

  it("prefers related tests and falls back to the full suite for no files, many files or no related command", () => {
    expect(selectTestCommand(plan, ["a.ts"])).toMatchObject({
      name: "testRelated",
      argv: ["pnpm", "exec", "vitest", "related", "--run", "a.ts"],
    });
    expect(selectTestCommand(plan, [])).toMatchObject({ name: "test" });
    expect(
      selectTestCommand(
        plan,
        Array.from({ length: 201 }, (_, i) => `f${i}.ts`),
      ),
    ).toMatchObject({ name: "test" });
    expect(selectTestCommand({ test: plan.test }, ["a.ts"])).toMatchObject({ name: "test" });
    expect(selectTestCommand({}, ["a.ts"])).toBeUndefined();
  });
});

describe("runProjectCommand", () => {
  it("passes on exit 0, passes the argv through without a shell and writes the log", async () => {
    writes.length = 0;
    const runner = new FakeRunner([result({ stdout: "ok\n", durationMs: 8200 })]);
    const outcome = await runProjectCommand(deps(runner), {
      ...base,
      name: "typecheck",
      argv: ["pnpm", "run", "typecheck"],
      source: "inferred:package.json#scripts.typecheck",
    });
    expect(outcome).toMatchObject({
      status: "PASS",
      exitCode: 0,
      summary: "exit 0 in 8.2 s",
      logPath: base.logPath,
    });
    expect(runner.calls[0]).toMatchObject({
      argv: ["pnpm", "run", "typecheck"],
      options: { cwd: "/w/app", timeoutMs: 1000 },
    });
    expect(writes[0]).toMatchObject({ path: base.logPath });
    expect(writes[0]?.content).toContain("ok");
  });

  it("FAILs on a non-zero exit and keeps the last 4000 characters as evidence", async () => {
    const noise = "x".repeat(6000);
    const runner = new FakeRunner([result({ code: 2, stderr: `${noise}\nthe real error` })]);
    const outcome = await runProjectCommand(deps(runner), {
      ...base,
      name: "lint",
      argv: ["pnpm", "run", "lint"],
      source: "config",
    });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.exitCode).toBe(2);
    expect(outcome.evidence?.length).toBeLessThanOrEqual(4000);
    expect(outcome.evidence).toContain("the real error");
  });

  it("is BLOCKED, never PASS, on a spawn error, a timeout, a truncated output and a cancellation", async () => {
    for (const reply of [
      result({ code: null, spawnError: "ENOENT" }),
      result({ code: null, timedOut: true }),
      result({ truncated: true }),
      result({ code: null, cancelled: true }),
    ]) {
      const outcome = await runProjectCommand(deps(new FakeRunner([reply])), {
        ...base,
        name: "build",
        argv: ["pnpm", "run", "build"],
        source: "config",
      });
      expect(outcome.status, JSON.stringify(reply)).toBe("BLOCKED");
    }
  });

  it("refuses config-derived and package-derived commands while FS-GOV-001 is open", async () => {
    const runner = new FakeRunner();
    const refused = await runProjectCommand(deps(runner), {
      ...base,
      name: "test",
      argv: ["pnpm", "run", "test"],
      source: "inferred:package.json#scripts.test",
      refuse: "FS-GOV-001 is open",
    });
    expect(refused).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("FS-GOV-001"),
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("maps an outcome to a gate check with a finding on failure", async () => {
    const failed = await runProjectCommand(
      deps(new FakeRunner([result({ code: 1, stdout: "boom" })])),
      { ...base, name: "lint", argv: ["pnpm", "run", "lint"], source: "config" },
    );
    const prepared = commandPrepared(failed);
    expect(prepared).toMatchObject({ status: "FAIL" });
    expect(prepared.findings?.[0]).toMatchObject({
      ruleId: "CMD-LINT",
      status: "FAIL",
      message: expect.stringContaining("boom"),
    });
    expect(
      commandPrepared({ ...failed, status: "PASS", evidence: undefined }).findings ?? [],
    ).toEqual([]);
  });
});

describe("custom gates (spec 17.3)", () => {
  const gate = (over: object = {}) => ({
    id: "storybook-tests",
    phase: "validate" as const,
    command: ["pnpm", "test-storybook", "--ci"],
    report: "exit-code" as const,
    ...over,
  });
  const input = (
    gates: ReturnType<typeof gate>[],
    phase: "build" | "validate" = "validate",
    refuse?: string,
  ) => ({
    root: "/w/app",
    gates,
    phase,
    defaultTimeoutMs: 5000,
    logDir: ".alisio/frontsmith/evidence/projects/r1",
    ...(refuse ? { refuse } : {}),
  });

  it("runs only the gates of the phase and maps exit codes", async () => {
    const runner = new FakeRunner([
      result({ code: 0 }),
      result({ code: 1, stdout: "story failed" }),
    ]);
    const ok = await runCustomGates(
      deps(runner),
      input([gate(), gate({ id: "other", phase: "build" })]),
    );
    expect(ok.map((g) => [g.id, g.prepared.status])).toEqual([["storybook-tests", "PASS"]]);
    const bad = await runCustomGates(deps(runner), input([gate()]));
    expect(bad[0]?.prepared).toMatchObject({ status: "FAIL" });
    expect(bad[0]?.prepared.findings?.[0]?.message).toContain("story failed");
  });

  it("downgrades a failing gate that is not required to REVIEW and honours the timeout", async () => {
    const runner = new FakeRunner([result({ code: 1 })]);
    const out = await runCustomGates(
      deps(runner),
      input([gate({ required: false, timeoutMs: 42 })]),
    );
    expect(out[0]?.prepared).toMatchObject({ status: "REVIEW", required: false });
    expect(runner.calls[0]?.options.timeoutMs).toBe(42);
  });

  it("reads a gate report from stdout and BLOCKs on invalid JSON", async () => {
    const report = {
      schema: "frontsmith.gate-report/v1",
      gate: "G7",
      feature: "x",
      verdict: "FAIL",
      coverage: { required: 1, executed: 1, pending: 0 },
      checks: [{ id: "a", status: "FAIL", required: true, summary: "bad" }],
      findings: [
        {
          id: "F-0001",
          ruleId: "ACME-1",
          severity: "major",
          status: "FAIL",
          kind: "deterministic",
          file: "src/a.ts",
          line: 1,
          column: 1,
          message: "bad thing",
        },
      ],
      generatedAt: "2026-10-06T12:00:00Z",
      tool: { name: "x", version: "1" },
    };
    const runner = new FakeRunner([
      result({ stdout: JSON.stringify(report) }),
      result({ stdout: "not json" }),
    ]);
    const good = await runCustomGates(deps(runner), input([gate({ report: "frontsmith-json" })]));
    expect(good[0]?.prepared).toMatchObject({ status: "FAIL" });
    expect(good[0]?.prepared.findings?.[0]).toMatchObject({ ruleId: "ACME-1", file: "src/a.ts" });
    const bad = await runCustomGates(deps(runner), input([gate({ report: "frontsmith-json" })]));
    expect(bad[0]?.prepared.status).toBe("BLOCKED");
  });

  it("never runs while FS-GOV-001 is open", async () => {
    const runner = new FakeRunner();
    const out = await runCustomGates(
      deps(runner),
      input([gate()], "validate", "FS-GOV-001 is open"),
    );
    expect(out[0]?.prepared.status).toBe("BLOCKED");
    expect(runner.calls).toHaveLength(0);
  });

  it("validates the report shape", () => {
    expect(validateGateReportJson({}).ok).toBe(false);
    expect(
      validateGateReportJson({
        schema: "frontsmith.gate-report/v1",
        verdict: "MAYBE",
        checks: [],
        findings: [],
      }).ok,
    ).toBe(false);
    expect(
      validateGateReportJson({
        schema: "frontsmith.gate-report/v1",
        verdict: "PASS",
        checks: [],
        findings: [],
      }).ok,
    ).toBe(true);
  });
});
