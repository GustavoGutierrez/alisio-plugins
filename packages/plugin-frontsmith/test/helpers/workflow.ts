import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envelopeExamples } from "../../src/application/agents/examples.js";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
} from "../../src/application/ports/agent-runner.js";
import type {
  ExecOptions,
  ExecResult,
  ProcessRunner,
} from "../../src/application/ports/process-runner.js";
import type { FrontsmithServices } from "../../src/application/services.js";
import { compose } from "../../src/interface/composition.js";
import { loadAgentProfile } from "../../src/resources.js";
import { type TempWorkspace, tempWorkspace } from "./workspace.js";

export const NOW = "2026-10-06T12:00:00.000Z";

/** A reply a scripted child gives: an object (becomes JSON text), raw text, or a full result. */
export type Reply = unknown;
export type Script = (request: RunRequest, helpers: ScriptHelpers) => Reply | Promise<Reply>;
export interface ScriptHelpers {
  /** Write a file in the workspace the child works in. */
  write(path: string, content: string): Promise<void>;
  workspace: string;
}

/** Children that answer from a script per role, optionally editing files like a real implementer. */
export class ScriptedRunner implements AgentRunner {
  readonly requests: RunRequest[] = [];
  private readonly queues = new Map<string, Script[]>();
  cancelled = 0;
  private sessions = 0;

  /** Queue replies for a role (`implementer`, `reviewer`, ...); each run consumes one. */
  on(role: string, ...scripts: Array<Script | Reply>): this {
    const list = this.queues.get(role) ?? [];
    for (const script of scripts)
      list.push(typeof script === "function" ? (script as Script) : () => script);
    this.queues.set(role, list);
    return this;
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    const queue = this.queues.get(request.profile.role);
    const script = queue?.shift();
    if (!script) throw new Error(`No scripted reply left for ${request.profile.role}`);
    const sessionId = request.reuseSession ?? `child-${++this.sessions}`;
    const aborted = new Promise<"aborted">((resolve) => {
      if (request.signal?.aborted) resolve("aborted");
      request.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const reply = await Promise.race([
      Promise.resolve(
        script(request, {
          workspace: request.workspace,
          write: async (path, content) => {
            const target = join(request.workspace, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content);
          },
        }),
      ),
      aborted,
    ]);
    if (reply === "aborted") return { status: "cancelled", text: "", sessionId };
    if (
      reply &&
      typeof reply === "object" &&
      "status" in (reply as object) &&
      "text" in (reply as object)
    )
      return { sessionId, ...(reply as RunResult) };
    return {
      status: "completed",
      sessionId,
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage: { input: 10, output: 20 },
    };
  }

  cancelAll(): void {
    this.cancelled += 1;
  }

  runsOf(role: string): RunRequest[] {
    return this.requests.filter((r) => r.profile.role === role);
  }
}

/** A process runner that answers every command with exit 0 unless scripted otherwise. */
export class FakeProcess implements ProcessRunner {
  readonly calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  private readonly rules: Array<{
    match: (argv: readonly string[]) => boolean;
    reply: () => Partial<ExecResult>;
  }> = [];

  when(match: (argv: readonly string[]) => boolean, reply: () => Partial<ExecResult>): this {
    this.rules.unshift({ match, reply });
    return this;
  }

  async run(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push({ argv, cwd: options.cwd });
    const rule = this.rules.find((r) => r.match(argv));
    return {
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      cancelled: false,
      durationMs: 25,
      ...(rule?.reply() ?? {}),
    };
  }
}

/** The git calls the workflow makes go to a real repository; everything else is faked. */
const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
};

export const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "app",
      private: true,
      scripts: {
        typecheck: "tsc --noEmit",
        lint: "biome check .",
        test: "vitest run",
        build: "vite build",
        "test:e2e": "playwright test",
      },
      dependencies: { react: "^19.0.0" },
      devDependencies: { vitest: "^3.0.0", typescript: "^5.0.0" },
    },
    null,
    2,
  ),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  ".gitignore": ".alisio/\nnode_modules/\ndist/\n",
  "src/App.tsx": "export function App() {\n  return <main><h1>Projects</h1></main>;\n}\n",
};

export interface WorkflowFixture {
  ws: TempWorkspace;
  root: string;
  runner: ScriptedRunner;
  proc: FakeProcess;
  services: FrontsmithServices;
  /** Commit everything currently in the workspace (a clean baseline for diff checks). */
  commit(message?: string): void;
  cleanup(): Promise<void>;
}

export async function workflowFixture(
  options: {
    files?: Record<string, string>;
    git?: boolean;
    level?: "L0" | "L1" | "L2" | "L3";
    config?: unknown;
    fidelity?: NonNullable<Parameters<typeof compose>[0]>["fidelity"];
  } = {},
): Promise<WorkflowFixture> {
  const files = { ...PROJECT_FILES, ...(options.files ?? {}) };
  if (options.config !== undefined)
    files[".frontsmith/config.json"] = JSON.stringify(options.config);
  const ws = await tempWorkspace(files);
  const root = ws.root;
  if (options.git !== false) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "baseline");
  }
  const runner = new ScriptedRunner();
  const proc = new FakeProcess();
  let ids = 0;
  const composition = compose({
    clock: { now: () => new Date(NOW) },
    runner,
    process: proc,
    profiles: loadAgentProfile,
    newId: () => `id${++ids}`,
    version: "0.1.0",
    ...(options.fidelity ? { fidelity: options.fidelity } : {}),
  });
  return {
    ws,
    root,
    runner,
    proc,
    services: composition.services,
    commit(message = "step") {
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", message, "--allow-empty");
    },
    cleanup: () => ws.cleanup(),
  };
}

export const taskResult = (
  taskId: string,
  changedPaths: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(envelopeExamples["task-result"] as object),
  taskId,
  changedPaths,
  acceptance: [],
  testFirst: null,
  ...extra,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const goodSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...clone(envelopeExamples.spec as object),
  states: [
    { id: "ST-initial", kind: "initial", description: "first paint" },
    { id: "ST-success", kind: "success", description: "projects are listed" },
  ],
  openQuestions: [],
  ...over,
});

export const goodPlan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...clone(envelopeExamples.plan as object),
  tasks: [
    {
      id: "T-001",
      title: "Projects list",
      goal: "List the projects",
      layer: "ui",
      files: ["src/Projects.tsx", "src/Projects.test.tsx"],
      acceptanceCriteria: ["AC-01"],
      tests: [{ path: "src/Projects.test.tsx", level: "component" }],
      validation: ["typecheck", "lint", "testRelated"],
      constraints: [],
      dependsOn: [],
      stopConditions: [],
      tdd: "required",
      tddExemptReason: null,
    },
  ],
  ...over,
});

export const ARCHITECTURE = {
  schemaVersion: 1,
  sourceRoots: ["src"],
  layers: [{ name: "app", paths: ["src/**"] }],
  allow: { app: [] },
  allowSameLayer: ["app"],
  atomic: null,
  ignore: [],
};

export const goodContract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...clone(envelopeExamples["ui-contract"] as object),
  stateMatrix: [
    {
      stateId: "ST-initial",
      trigger: "first load",
      ui: "skeleton",
      actions: [],
      a11y: "busy state announced",
      testLevel: ["component"],
    },
    {
      stateId: "ST-success",
      trigger: "data loaded",
      ui: "list",
      actions: [],
      a11y: "list semantics",
      testLevel: ["component"],
    },
  ],
  fidelityRules: [],
  cases: [
    {
      id: "main-desktop-initial",
      surfaceId: "main-page",
      stateId: "ST-initial",
      viewport: [1024, 640],
      theme: "light",
      setup: {},
    },
  ],
  tokensNeeded: [],
  ...over,
});

export const TEST_FILE =
  'import { describe, expect, it } from "vitest";\n\ndescribe("Projects", () => {\n  it("lists the projects", () => {\n    expect(["a", "b"]).toHaveLength(2);\n  });\n});\n';
export const PROJECTS = "export function Projects() {\n  return <ul><li>Alpha</li></ul>;\n}\n";

/** The implementer of the L1 and L2 plans: test first, then the component. */
export const projectsImplementer = async (
  _request: RunRequest,
  h: ScriptHelpers,
): Promise<unknown> => {
  await h.write("src/Projects.test.tsx", TEST_FILE);
  await h.write("src/Projects.tsx", PROJECTS);
  return taskResult("T-001", ["src/Projects.tsx", "src/Projects.test.tsx"], {
    testFirst: {
      testPath: "src/Projects.test.tsx",
      failingOutputExcerpt: "1 failed: Projects is not defined",
      passingOutputExcerpt: "1 passed",
    },
    acceptance: [{ acId: "AC-01", satisfiedBy: ["src/Projects.tsx"] }],
  });
};

export const approvedReview = {
  ...(envelopeExamples.review as object),
  findings: [],
  verdict: "approved",
};
export const testMapFor = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...clone(envelopeExamples["test-map"] as object),
  entries: [
    {
      acId: "AC-01",
      risk: "the list hides projects",
      levels: ["component", "a11y"],
      tests: [{ path: "src/Projects.test.tsx", name: "lists the projects", level: "component" }],
      evidence: "component test",
      manual: null,
    },
  ],
  ...over,
});
