import type { GateName } from "../domain/pack.js";
import { detectDuplicates, type SourceText } from "../gates/dry.js";
import {
  isSourceFile,
  isTestFile,
  parseEslintComplexity,
  parseIstanbulSummary,
  parseStrykerReport,
  toFunctionMetrics,
} from "../gates/parsers.js";
import type { GateReport, GateRequest, GateRunner } from "../ports/gate-runner.js";
import { readText, resolveContained } from "../storage.js";
import type { CommandName, Toolchain, ToolchainCommand } from "../toolchains/profile.js";
import { evaluateThresholds } from "../toolchains/thresholds.js";
import { createExec, type Exec, type ExecResult, ProcessTracker } from "./process-exec.js";

export interface ProcessGateDeps {
  loadToolchain: (id: string) => Promise<Toolchain>;
  /** Test seam; production uses a bounded `spawn` that never goes through a shell. */
  exec?: Exec;
  tracker?: ProcessTracker;
  /** Read a report file relative to the working directory (contained, never following symlinks out). */
  readFile?: (workdir: string, relative: string) => Promise<string | undefined>;
  /** Per-command timeouts in milliseconds. */
  timeouts?: Partial<Record<CommandName | "git", number>>;
  maxOutput?: number;
}

const DEFAULT_TIMEOUTS: Record<CommandName | "git", number> = {
  test: 300_000,
  coverage: 600_000,
  complexity: 300_000,
  mutation: 1_800_000,
  acceptance: 600_000,
  git: 60_000,
};
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_SOURCE_FILES = 500;
const MAX_SOURCE_BYTES = 200_000;
const DRY_WINDOW = 6;

type Outcome = Pick<GateReport, "passed" | "findings" | "skipped" | "error" | "timedOut">;

const pass = (extra: Partial<Outcome> = {}): Outcome => ({ passed: true, findings: [], ...extra });
const fail = (findings: string[], extra: Partial<Outcome> = {}): Outcome => ({
  passed: false,
  findings,
  ...extra,
});
const broken = (error: string): Outcome => ({ passed: false, findings: [error], error });

function tail(result: ExecResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-40).join("\n");
  return text.length > 3000 ? text.slice(-3000) : text;
}

/** Gate runner over the node-ts toolchain profile: argv arrays, timeouts, caps, scrubbed env. */
export class ProcessGateRunner implements GateRunner {
  private readonly tracker: ProcessTracker;
  private readonly exec: Exec;
  private readonly timeouts: Record<CommandName | "git", number>;

  constructor(private readonly deps: ProcessGateDeps) {
    this.tracker = deps.tracker ?? new ProcessTracker();
    this.exec = deps.exec ?? createExec(this.tracker);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  cancelAll(under?: string): void {
    this.tracker.killAll(under);
  }

  async run(request: GateRequest): Promise<GateReport> {
    const started = Date.now();
    try {
      const toolchain = await this.deps.loadToolchain(request.toolchain);
      const outcome = await this.dispatch(request, toolchain);
      return { gate: request.gate, ...outcome, durationMs: Date.now() - started };
    } catch (error) {
      return {
        gate: request.gate,
        ...broken(error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - started,
      };
    }
  }

  private dispatch(request: GateRequest, toolchain: Toolchain): Promise<Outcome> {
    const gates: Record<GateName, () => Promise<Outcome>> = {
      "tests-green": () => this.testsGreen(request, toolchain, "test", "Tests"),
      acceptance: () =>
        this.testsGreen(
          request,
          toolchain,
          toolchain.commands.acceptance ? "acceptance" : "test",
          "Acceptance checks",
        ),
      "test-first": () => this.testFirst(request),
      coverage: () => this.coverage(request, toolchain),
      crap: () => this.crap(request, toolchain),
      dry: () => this.dry(request),
      mutation: () => this.mutation(request, toolchain),
      structure: async () =>
        pass({
          skipped:
            "There is no deterministic structure checker in this build; the architect role verifies it",
        }),
    };
    return gates[request.gate]();
  }

  // ---- helpers ----

  private command(toolchain: Toolchain, name: CommandName): ToolchainCommand {
    const command = toolchain.commands[name];
    if (!command) throw new Error(`The ${toolchain.id} toolchain has no ${name} command`);
    return command;
  }

  private run1(
    request: GateRequest,
    name: CommandName,
    command: ToolchainCommand,
    extra: string[] = [],
  ): Promise<ExecResult> {
    return this.exec([...command.argv, ...extra], {
      cwd: request.workdir,
      timeoutMs: this.timeouts[name],
      maxOutput: this.deps.maxOutput ?? MAX_OUTPUT,
    });
  }

  /** Spawn failures, timeouts, cancellation and runaway output are never a "pass". */
  private abnormal(result: ExecResult, label: string, timeoutMs: number): Outcome | undefined {
    if (result.cancelled) return broken("Gate cancelled");
    if (result.spawnError) return broken(`${label} could not start: ${result.spawnError}`);
    if (result.timedOut) {
      return fail([`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`], {
        timedOut: true,
      });
    }
    if (result.truncated) return fail([`${label} produced too much output and was stopped`]);
    return undefined;
  }

  private async changedFiles(request: GateRequest): Promise<string[]> {
    if (!request.since || !/^[0-9a-f]{7,40}$/.test(request.since)) {
      throw new Error("The gate needs the base commit of the role's work");
    }
    const result = await this.exec(
      ["git", "diff", "--name-only", "--diff-filter=ACMR", `${request.since}..HEAD`],
      {
        cwd: request.workdir,
        timeoutMs: this.timeouts.git,
        maxOutput: this.deps.maxOutput ?? MAX_OUTPUT,
      },
    );
    if (result.code !== 0)
      throw new Error(`git diff failed: ${tail(result) || `exit ${result.code}`}`);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async read(request: GateRequest, relative: string): Promise<string | undefined> {
    if (this.deps.readFile) return this.deps.readFile(request.workdir, relative);
    return readText(await resolveContained(request.workdir, relative));
  }

  private async report(
    request: GateRequest,
    command: ToolchainCommand,
    result: ExecResult,
    label: string,
  ): Promise<string> {
    if (!command.report) return result.stdout;
    const text = await this.read(request, command.report);
    if (text === undefined) {
      throw new Error(`${label} did not produce its report at ${command.report}\n${tail(result)}`);
    }
    return text;
  }

  // ---- gates ----

  private async testsGreen(
    request: GateRequest,
    toolchain: Toolchain,
    name: CommandName,
    label: string,
  ): Promise<Outcome> {
    const result = await this.run1(request, name, this.command(toolchain, name));
    const abnormal = this.abnormal(result, label, this.timeouts[name]);
    if (abnormal) return abnormal;
    if (result.code !== 0) return fail([`${label} failed (exit ${result.code})`, tail(result)]);
    return pass();
  }

  private async testFirst(request: GateRequest): Promise<Outcome> {
    const changed = await this.changedFiles(request);
    if (changed.length === 0) return fail(["The role made no changes since the base commit"]);
    const tests = changed.filter(isTestFile);
    if (tests.length === 0) {
      return fail([
        "No test file is part of the diff: write the failing test first and commit it with the change",
      ]);
    }
    return pass();
  }

  private async coverage(request: GateRequest, toolchain: Toolchain): Promise<Outcome> {
    const command = this.command(toolchain, "coverage");
    const result = await this.run1(request, "coverage", command);
    const abnormal = this.abnormal(result, "The coverage run", this.timeouts.coverage);
    if (abnormal) return abnormal;
    if (result.code !== 0)
      return fail([`The coverage run failed (exit ${result.code})`, tail(result)]);
    const summary = parseIstanbulSummary(
      await this.report(request, command, result, "The coverage run"),
      request.workdir,
    );
    const evaluation = evaluateThresholds(request.thresholds, { coverage: summary.coverage });
    return evaluation.passed ? pass() : fail(evaluation.failures.map((f) => f.message));
  }

  private async crap(request: GateRequest, toolchain: Toolchain): Promise<Outcome> {
    const changed = (await this.changedFiles(request)).filter(isSourceFile);
    if (changed.length === 0) return pass({ skipped: "No changed source files" });
    const coverageCommand = this.command(toolchain, "coverage");
    const coverageRun = await this.run1(request, "coverage", coverageCommand);
    const abnormal = this.abnormal(coverageRun, "The coverage run", this.timeouts.coverage);
    if (abnormal) return abnormal;
    if (coverageRun.code !== 0) {
      return fail([`The coverage run failed (exit ${coverageRun.code})`, tail(coverageRun)]);
    }
    const coverage = parseIstanbulSummary(
      await this.report(request, coverageCommand, coverageRun, "The coverage run"),
      request.workdir,
    );
    const lint = await this.run1(request, "complexity", this.command(toolchain, "complexity"));
    const lintAbnormal = this.abnormal(lint, "The complexity run", this.timeouts.complexity);
    if (lintAbnormal) return lintAbnormal;
    // ESLint exits non-zero whenever it reports a finding: the JSON is what matters.
    const entries = parseEslintComplexity(lint.stdout, request.workdir).filter((entry) =>
      changed.includes(entry.file),
    );
    const evaluation = evaluateThresholds(request.thresholds, {
      functions: toFunctionMetrics(entries, coverage.files),
    });
    return evaluation.passed ? pass() : fail(evaluation.failures.map((f) => f.message));
  }

  private async dry(request: GateRequest): Promise<Outcome> {
    const changed = (await this.changedFiles(request)).filter(isSourceFile);
    if (changed.length === 0) return pass({ skipped: "No changed source files" });
    const listing = await this.exec(["git", "ls-files"], {
      cwd: request.workdir,
      timeoutMs: this.timeouts.git,
      maxOutput: this.deps.maxOutput ?? MAX_OUTPUT,
    });
    if (listing.code !== 0) return broken(`git ls-files failed: ${tail(listing)}`);
    const names = [
      ...new Set([
        ...listing.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(isSourceFile),
        ...changed,
      ]),
    ].slice(0, MAX_SOURCE_FILES);
    const sources: SourceText[] = [];
    for (const path of names) {
      const text = await this.read(request, path);
      if (text !== undefined && text.length <= MAX_SOURCE_BYTES) sources.push({ path, text });
    }
    const findings = detectDuplicates(sources, { window: DRY_WINDOW, only: changed });
    return findings.length === 0 ? pass() : fail(findings);
  }

  private async mutation(request: GateRequest, toolchain: Toolchain): Promise<Outcome> {
    const changed = (await this.changedFiles(request)).filter(isSourceFile);
    if (changed.length === 0) return pass({ skipped: "No changed source files to mutate" });
    const command = this.command(toolchain, "mutation");
    const result = await this.run1(request, "mutation", command, ["--mutate", changed.join(",")]);
    const abnormal = this.abnormal(result, "The mutation run", this.timeouts.mutation);
    if (abnormal) return abnormal;
    // Stryker also exits non-zero below its own threshold; the pack threshold is judged here.
    const summary = parseStrykerReport(
      await this.report(request, command, result, "The mutation run"),
      changed,
    );
    if (summary.score === undefined) return pass({ skipped: "No mutants in the changed files" });
    const evaluation = evaluateThresholds(request.thresholds, { mutation: summary.score });
    if (evaluation.passed) return pass();
    return fail([
      ...evaluation.failures.map((f) => f.message),
      ...summary.survivors.map((line) => `Surviving mutant: ${line}`),
    ]);
  }
}
