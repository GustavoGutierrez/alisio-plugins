import { isSafeRelativePath } from "../../domain/envelopes/parse.js";
import type { Prepared } from "../../domain/gates/aggregate.js";
import type { CommandPlan, PlannedCommand } from "../detect/commands.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { WorkspaceWriter } from "../ports/workspace-writer.js";

export interface CommandDeps {
  process: ProcessRunner;
  writer: WorkspaceWriter;
}

/** `{files}` expands to at most this many files; more falls back to the full suite (spec 8.4). */
export const MAX_RELATED_FILES = 200;
const MAX_LOG_BYTES = 1_000_000;
const EVIDENCE_CHARS = 4000;
const OUTPUT_CAP = 4 * 1024 * 1024;

export type ExpandResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: "too-many-files" | "unsafe-file" };

/**
 * Expand the `{files}` placeholder, which must be a whole argv element (spec 8.4). Files are
 * validated: relative, contained, and never an option-looking name.
 */
export function expandArgv(argv: readonly string[], files: readonly string[]): ExpandResult {
  if (!argv.includes("{files}")) return { ok: true, argv: [...argv] };
  if (files.length > MAX_RELATED_FILES) return { ok: false, reason: "too-many-files" };
  if (files.some((file) => !isSafeRelativePath(file) || file.startsWith("-")))
    return { ok: false, reason: "unsafe-file" };
  return { ok: true, argv: argv.flatMap((part) => (part === "{files}" ? [...files] : [part])) };
}

export interface SelectedCommand {
  name: "testRelated" | "test";
  argv: string[];
  source: string;
}

/** Related tests when possible, the full test command otherwise; nothing when neither exists. */
export function selectTestCommand(
  plan: CommandPlan,
  files: readonly string[],
): SelectedCommand | undefined {
  const related = plan.testRelated;
  if (related && files.length > 0) {
    const expanded = expandArgv(related.argv, files);
    if (expanded.ok) return { name: "testRelated", argv: expanded.argv, source: related.source };
  }
  const full: PlannedCommand | undefined = plan.test;
  return full ? { name: "test", argv: [...full.argv], source: full.source } : undefined;
}

export interface RunCommandInput {
  root: string;
  /** `typecheck`, `lint`, `test`, `testRelated`, `build`, `e2e` or a custom gate id. */
  name: string;
  argv: readonly string[];
  /** `config` or `inferred:...`. */
  source: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Workspace-relative log file; the full capped output is written there. */
  logPath?: string;
  /** Set while FS-GOV-001 is open: config- and package-derived commands never run (spec 8.5). */
  refuse?: string;
  /** Return the standard output in the outcome (custom gates that print a report). */
  captureStdout?: boolean;
}

export interface CommandOutcome {
  name: string;
  argv: string[];
  source: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  exitCode: number | null;
  summary: string;
  durationMs: number;
  logPath?: string;
  /** Last 4000 characters of the output of a failing command. */
  evidence?: string;
  stdout?: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Run one project command: argv only, scrubbed environment, bounded output, no shell (spec 19). */
export async function runProjectCommand(
  deps: CommandDeps,
  input: RunCommandInput,
): Promise<CommandOutcome> {
  const base = { name: input.name, argv: [...input.argv], source: input.source };
  if (input.refuse)
    return {
      ...base,
      status: "BLOCKED",
      exitCode: null,
      summary: `refused: ${input.refuse}`,
      durationMs: 0,
    };
  const result = await deps.process.run(input.argv, {
    cwd: input.root,
    timeoutMs: input.timeoutMs,
    maxOutput: OUTPUT_CAP,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  let logPath: string | undefined;
  if (input.logPath) {
    await deps.writer.write(input.root, input.logPath, output.slice(-MAX_LOG_BYTES));
    logPath = input.logPath;
  }
  const withLog = {
    ...(logPath ? { logPath } : {}),
    ...(input.captureStdout ? { stdout: result.stdout.slice(0, MAX_LOG_BYTES) } : {}),
  };
  if (result.spawnError)
    return {
      ...base,
      ...withLog,
      status: "BLOCKED",
      exitCode: null,
      summary: `could not start: ${result.spawnError}`,
      durationMs: result.durationMs,
    };
  if (result.cancelled)
    return {
      ...base,
      ...withLog,
      status: "BLOCKED",
      exitCode: null,
      summary: "cancelled",
      durationMs: result.durationMs,
    };
  if (result.timedOut)
    return {
      ...base,
      ...withLog,
      status: "BLOCKED",
      exitCode: null,
      summary: `timed out after ${seconds(input.timeoutMs)}`,
      durationMs: result.durationMs,
    };
  if (result.truncated)
    return {
      ...base,
      ...withLog,
      status: "BLOCKED",
      exitCode: result.code,
      summary: "output exceeded the 4 MiB cap",
      durationMs: result.durationMs,
    };
  if (result.code === 0)
    return {
      ...base,
      ...withLog,
      status: "PASS",
      exitCode: 0,
      summary: `exit 0 in ${seconds(result.durationMs)}`,
      durationMs: result.durationMs,
    };
  return {
    ...base,
    ...withLog,
    status: "FAIL",
    exitCode: result.code,
    summary: `exit ${result.code} in ${seconds(result.durationMs)}`,
    durationMs: result.durationMs,
    evidence: output.slice(-EVIDENCE_CHARS),
  };
}

/** A command outcome as a gate check (spec 10.2: `command:<name>`, log path as evidence). */
export function commandPrepared(outcome: CommandOutcome): Prepared {
  const failing = outcome.status === "FAIL";
  return {
    status: outcome.status,
    summary: outcome.summary,
    ...(outcome.logPath ? { logPath: outcome.logPath } : {}),
    findings:
      failing || outcome.status === "BLOCKED"
        ? [
            {
              ruleId: `CMD-${outcome.name
                .replace(/[^A-Za-z]/g, "")
                .toUpperCase()
                .slice(0, 12)}`,
              severity: "major",
              status: outcome.status,
              kind: "deterministic",
              message:
                `${outcome.argv.join(" ")}: ${outcome.summary}${outcome.evidence ? `\n${outcome.evidence}` : ""}`.slice(
                  0,
                  4400,
                ),
              fix: failing
                ? "Fix the failure the command reports, then run the task again."
                : "Make the command runnable.",
            },
          ]
        : [],
  };
}
