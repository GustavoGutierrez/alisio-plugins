import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Handoff } from "../src/domain/handoff.js";
import { type GateName, type Pack, parsePack } from "../src/domain/pack.js";
import type { AgentRunner, RunRequest, RunResult } from "../src/ports/agent-runner.js";
import type { GateReport, GateRequest, GateRunner } from "../src/ports/gate-runner.js";

export const roleSpec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: id,
  isolation: "worktree",
  receive: "task",
  propagation: "forward-only",
  ...extra,
});

/** Build a validated pack from role ids; the first role is the master. */
export function makePack(
  ids: string[],
  extra: Record<string, unknown> = {},
  roleExtras: Record<string, Record<string, unknown>> = {},
): Pack {
  return parsePack({
    schemaVersion: 1,
    name: "test-pack",
    description: "Test pack",
    toolchain: "node-ts",
    roles: ids.map((id, index) =>
      roleSpec(id, { ...(index === 0 ? { isolation: "master" } : {}), ...roleExtras[id] }),
    ),
    ...extra,
  });
}

const scratch: string[] = [];

/** A fresh scratch directory removed after each test. Call inside a test or beforeEach. */
export async function tempDir(prefix = "swarm-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let sequence = 0;

export function makeHandoff(partial: Partial<Handoff> = {}): Handoff {
  sequence += 1;
  return {
    id: `11111111-2222-4333-8444-${String(sequence).padStart(12, "0")}`,
    from: "coder",
    to: ["cleaner"],
    priority: 50,
    type: "git_handoff",
    task: "add-login",
    taskId: "20260102T030405678000Z-add-login",
    commit: "0123456789",
    approved: false,
    nonForwarding: false,
    createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, sequence)).toISOString(),
    body: "merge it",
    ...partial,
  };
}

export const fixedClock = (start = "2026-01-02T03:04:05.000Z") => {
  let tick = Date.parse(start);
  return {
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  };
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.test",
};

export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** Write a file and commit it; returns the ten-character commit id. */
export async function commitFile(
  dir: string,
  file: string,
  content: string,
  message = `feat: ${file}`,
): Promise<string> {
  await writeFile(join(dir, file), content);
  gitIn(dir, "add", file);
  gitIn(dir, "commit", "-m", message);
  return gitIn(dir, "rev-parse", "HEAD").slice(0, 10);
}

export const handoffEnvelope = (commit: string, summary = "Done"): string =>
  JSON.stringify({
    schemaVersion: 1,
    kind: "handoff",
    commit,
    summary,
    evidence: [{ requirement: "The behaviour works", proof: "tests pass" }],
  });

export const clarificationEnvelope = (question: string): string =>
  JSON.stringify({ schemaVersion: 1, kind: "needs_clarification", question });

export const blockedEnvelope = (reason: string): string =>
  JSON.stringify({ schemaVersion: 1, kind: "blocked", reason });

export type Step =
  | string
  | RunResult
  | ((request: RunRequest) => string | RunResult | Promise<string | RunResult>);

/** A fake AgentRunner: replies are scripted per role and may touch the real worktree. */
export class ScriptedRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  readonly maxParallel = new Map<string, number>();
  private readonly scripts = new Map<string, Step[]>();
  private readonly active = new Map<string, number>();
  cancelled: string[] = [];

  script(role: string, ...steps: Step[]): this {
    this.scripts.set(role, [...(this.scripts.get(role) ?? []), ...steps]);
    return this;
  }

  remaining(role: string): number {
    return this.scripts.get(role)?.length ?? 0;
  }

  callsFor(role: string): RunRequest[] {
    return this.calls.filter((call) => call.role === role);
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.calls.push(request);
    const step = this.scripts.get(request.role)?.shift();
    if (step === undefined) {
      return { status: "failed", text: "", error: `No scripted reply left for ${request.role}` };
    }
    const now = (this.active.get(request.role) ?? 0) + 1;
    this.active.set(request.role, now);
    this.maxParallel.set(request.role, Math.max(this.maxParallel.get(request.role) ?? 0, now));
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const value = typeof step === "function" ? await step(request) : step;
      return typeof value === "string" ? { status: "completed", text: value } : value;
    } finally {
      this.active.set(request.role, now - 1);
    }
  }

  cancelProject(project: string): void {
    this.cancelled.push(project);
  }
}

export type GateStep =
  | boolean
  | Partial<GateReport>
  | ((request: GateRequest) => GateReport | Partial<GateReport>);

/** A fake GateRunner: replies are scripted per role and gate; the default is a pass. */
export class ScriptedGates implements GateRunner {
  readonly calls: GateRequest[] = [];
  cancelled = 0;
  private readonly scripts = new Map<string, GateStep[]>();

  script(role: string, gate: GateName, ...steps: GateStep[]): this {
    const key = `${role}:${gate}`;
    this.scripts.set(key, [...(this.scripts.get(key) ?? []), ...steps]);
    return this;
  }

  callsFor(role: string, gate?: GateName): GateRequest[] {
    return this.calls.filter((call) => call.role === role && (!gate || call.gate === gate));
  }

  async run(request: GateRequest): Promise<GateReport> {
    this.calls.push(request);
    const step = this.scripts.get(`${request.role}:${request.gate}`)?.shift();
    const value = typeof step === "function" ? step(request) : step;
    if (value === undefined || value === true) {
      return { gate: request.gate, passed: true, findings: [] };
    }
    if (value === false) {
      return { gate: request.gate, passed: false, findings: [`${request.gate} failed`] };
    }
    return { gate: request.gate, passed: false, findings: [], ...value } as GateReport;
  }

  cancelAll(): void {
    this.cancelled += 1;
  }
}
