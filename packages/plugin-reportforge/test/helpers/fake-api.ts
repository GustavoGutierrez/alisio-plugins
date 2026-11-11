import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeRun {
  status?: string;
  text: string;
  turnsExceeded?: boolean;
  error?: string;
  /** Cumulative output tokens of the child, as the host reports them. */
  output?: number;
}

export interface FakeModel {
  reference: string;
  provider?: string;
  profile?: string;
  providerName?: string;
  model?: { id?: string; name?: string; maxOutputTokens?: number; contextWindow?: number };
}

/** A minimal host API for the service and generation code. */
export async function fakeHost(
  options: {
    run?: (prompt: string, signal?: AbortSignal, childId?: string) => Promise<FakeRun>;
    /** Replaces the model catalog; a function that throws simulates a failing list. */
    models?: FakeModel[] | (() => Promise<FakeModel[]>);
    /** The model a new child inherits from the session (the Alisio default). */
    sessionModel?: string;
  } = {},
) {
  const state = await mkdtemp(join(tmpdir(), "rf-state-"));
  const created: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const resolved: string[] = [];
  const prompts: string[] = [];
  const runs: string[] = [];
  const api = {
    paths: { state, config: join(state, "config"), cache: join(state, "cache") },
    options: {},
    models: {
      async list() {
        if (typeof options.models === "function") return options.models();
        return options.models ?? DEFAULT_MODELS;
      },
      async resolve(reference: string) {
        resolved.push(reference);
        const list =
          typeof options.models === "function"
            ? await options.models()
            : (options.models ?? DEFAULT_MODELS);
        const found = list.find((m) => m.reference === reference);
        if (!found) throw new Error(`Unknown model ${reference}`);
        return found;
      },
    },
    sessions: {
      workspace: (id: string) => `/workspaces/${id}`,
      model: () => options.sessionModel ?? "acme/fast",
      async create(spec: Record<string, unknown>) {
        created.push(spec);
        return { id: `child-${created.length}` };
      },
      async run(id: string, prompt: string, opts?: { signal?: AbortSignal }) {
        prompts.push(prompt);
        runs.push(id);
        const result = await (options.run ?? (async () => ({ text: "{}" })))(
          prompt,
          opts?.signal,
          id,
        );
        return {
          id,
          status: result.status ?? "completed",
          text: result.text,
          usage: { input: 1, output: result.output ?? 1 },
          turnsExceeded: result.turnsExceeded,
          ...(result.error ? { error: result.error } : {}),
        };
      },
      cancel(id: string) {
        cancelled.push(id);
        return 1;
      },
    },
  };
  return {
    api: api as never,
    state,
    created,
    cancelled,
    resolved,
    prompts,
    runs,
    cleanup: () => rm(state, { recursive: true, force: true }),
  };
}

const DEFAULT_MODELS: FakeModel[] = [
  {
    reference: "acme/fast",
    provider: "acme",
    profile: "default",
    providerName: "Acme",
    model: { id: "fast", name: "Fast" },
  },
];

export const VALID_ANSWER = {
  title: "Quarterly results",
  subtitle: "Sales grew",
  eyebrow: "EXECUTIVE",
  summary: "Revenue rose 12%.",
  blocks: [
    { id: "k1", type: "kpi", label: "Revenue", value: "$2.4M", change: "+12%" },
    {
      id: "c1",
      type: "bars",
      title: "Revenue by quarter",
      labels: ["Q1", "Q2"],
      values: [1, 2],
      unit: "M",
    },
    {
      id: "t1",
      type: "table",
      title: "Detail",
      columns: ["Q", "Rev"],
      rows: [
        ["Q1", 1],
        ["Q2", 2],
      ],
    },
    { id: "s1", type: "timeline", title: "Next", steps: [{ title: "Plan", body: "Now" }] },
    { id: "p1", type: "paragraph", text: "Context." },
    { id: "a1", type: "callout", title: "Risk", text: "Churn", tone: "warning" },
  ],
};
