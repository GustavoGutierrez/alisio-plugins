import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildSessionSpec, PluginAppContext } from "@alisio/sdk";
import type { RuntimeOptions } from "../src/runtime.js";
import { type RuntimeLike, Service } from "../src/service.js";

// biome-ignore lint/suspicious/noExplicitAny: action results are loosely typed JSON in tests.
export type Loose = any;

/** A runtime that never spawns anything; tests script its outcomes. */
export class FakeRuntime implements RuntimeLike {
  running = false;
  installs: string[] = [];
  builds = 0;
  starts = 0;
  reloads = 0;
  buildFailures = 0;
  probeStatus: number | null = 200;
  logs = "";
  constructor(readonly options: RuntimeOptions) {}
  snapshot() {
    return {
      state: (this.running ? "running" : "stopped") as "running" | "stopped",
      url: this.running ? "http://127.0.0.1:5555" : null,
      port: this.running ? 5555 : null,
      startedAt: null,
      stoppedReason: null,
      logs: this.logs,
    };
  }
  log() {
    return this.logs;
  }
  touch() {}
  async idleCheck() {
    return false;
  }
  async install(_signal: AbortSignal, mode: "ci" | "install") {
    this.installs.push(mode);
  }
  async build() {
    this.builds++;
    if (this.buildFailures > 0) {
      this.buildFailures--;
      this.logs = "SyntaxError: Unexpected token in src/App.jsx (3:4)";
      const { LumbreError } = await import("../src/errors.js");
      throw new LumbreError("build_failed");
    }
    this.logs = "built";
  }
  async start() {
    this.starts++;
    this.running = true;
  }
  async stop() {
    this.running = false;
  }
  async probe() {
    return this.probeStatus;
  }
  reload() {
    this.reloads++;
  }
  killSync() {
    this.running = false;
  }
}

export interface Fixture {
  service: Service;
  root: string;
  workspace: string;
  runtimes: FakeRuntime[];
  specs: ChildSessionSpec[];
  prompts: string[];
  /** Queue the next model answers (objects are JSON-encoded). */
  answer: (...values: unknown[]) => void;
  ctx: (key?: string) => PluginAppContext;
  call: (action: string, input?: Record<string, unknown>, key?: string) => Promise<Loose>;
  waitJob: (jobId: string) => Promise<Loose>;
  opened: string[];
  cleanup: () => Promise<void>;
}

export async function fixture(
  options: {
    models?: Array<{ reference: string; contextWindow?: number }>;
    resolveFails?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lmb-svc-"));
  const workspace = await mkdtemp(join(tmpdir(), "lmb-ws-"));
  const runtimes: FakeRuntime[] = [];
  const specs: ChildSessionSpec[] = [];
  const prompts: string[] = [];
  const answers: string[] = [];
  const opened: string[] = [];
  const models = options.models ?? [{ reference: "acme/fast", contextWindow: 64_000 }];
  const service = await new Service({
    root: join(root, "state"),
    cacheDir: join(root, "cache"),
    models: {
      list: async () =>
        models.map((m) => ({
          reference: m.reference,
          provider: "acme",
          profile: "default",
          providerName: "Acme",
          model: {
            id: m.reference.split("/")[1] as string,
            name: "Fast",
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          },
        })),
      resolve: async (reference: string) => {
        const found = models.find((m) => m.reference === reference);
        if (!found || options.resolveFails) throw new Error("unknown model");
        return {
          reference,
          provider: "acme",
          profile: "default",
          providerName: "Acme",
          model: {
            id: "fast",
            ...(found.contextWindow ? { contextWindow: found.contextWindow } : {}),
          },
        };
      },
    },
    sessions: {
      create: async (spec) => {
        specs.push(spec);
        return { id: `child-${specs.length}` } as never;
      },
      run: async (id, prompt, opts) => {
        prompts.push(prompt);
        const text =
          answers.shift() ?? JSON.stringify({ message: "Nothing to change.", files: [] });
        if (text === "__slow__") {
          await new Promise((resolve) =>
            opts?.signal?.addEventListener("abort", resolve, { once: true }),
          );
          return { id, status: "cancelled", text: "", usage: { input: 1, output: 1 } };
        }
        return { id, status: "completed", text, usage: { input: 1, output: 1 } };
      },
      cancel: () => 1,
      model: () => "acme/fast",
    },
    instructions: async (mode) => `instructions:${mode}`,
    npmCli: () => "npm-cli.js",
    runtime: (opts) => {
      const r = new FakeRuntime(opts);
      runtimes.push(r);
      return r;
    },
    openUrl: async (url) => {
      opened.push(url);
    },
  }).init();
  let n = 0;
  const ctx = (key?: string): PluginAppContext => ({
    sessionId: "session-1",
    workspace,
    signal: new AbortController().signal,
    ...(key ? { idempotencyKey: key } : {}),
  });
  const call = (action: string, input: Record<string, unknown> = {}, key?: string) =>
    service.invoke(action, input, ctx(key ?? `k${++n}`)) as Promise<Loose>;
  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 500; i++) {
      const job = await service.invoke("jobs.get", { jobId }, ctx());
      if ((job as { state: string }).state !== "running") return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not finish");
  };
  return {
    service,
    root,
    workspace,
    runtimes,
    specs,
    prompts,
    opened,
    answer: (...values) =>
      answers.push(...values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)))),
    ctx,
    call,
    waitJob,
    cleanup: async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
