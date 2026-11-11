import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeRun {
  status?: string;
  text: string;
  turnsExceeded?: boolean;
}

/** A minimal host API for the service and generation code. */
export async function fakeHost(
  options: { run?: (prompt: string, signal?: AbortSignal) => Promise<FakeRun> } = {},
) {
  const state = await mkdtemp(join(tmpdir(), "rf-state-"));
  const created: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const resolved: string[] = [];
  const prompts: string[] = [];
  const api = {
    paths: { state, config: join(state, "config"), cache: join(state, "cache") },
    options: {},
    models: {
      async list() {
        return [
          {
            reference: "acme/fast",
            provider: "acme",
            profile: "default",
            providerName: "Acme",
            model: { name: "Fast" },
          },
        ];
      },
      async resolve(reference: string) {
        resolved.push(reference);
        return { reference };
      },
    },
    sessions: {
      workspace: (id: string) => `/workspaces/${id}`,
      async create(spec: Record<string, unknown>) {
        created.push(spec);
        return { id: `child-${created.length}` };
      },
      async run(_id: string, prompt: string, opts?: { signal?: AbortSignal }) {
        prompts.push(prompt);
        const result = await (options.run ?? (async () => ({ text: "{}" })))(prompt, opts?.signal);
        return {
          id: "x",
          status: result.status ?? "completed",
          text: result.text,
          usage: { input: 1, output: 1 },
          turnsExceeded: result.turnsExceeded,
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
    cleanup: () => rm(state, { recursive: true, force: true }),
  };
}

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
