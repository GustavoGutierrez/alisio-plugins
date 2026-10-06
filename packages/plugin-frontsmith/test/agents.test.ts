import { describe, expect, it } from "vitest";
import { type DelegateDeps, delegate, narrowProfile } from "../src/application/agents/delegate.js";
import { envelopeExamples } from "../src/application/agents/examples.js";
import {
  buildPrompt,
  buildRetryPrompt,
  capDiff,
  MAX_DIFF_BYTES,
} from "../src/application/agents/prompts.js";
import { type AgentProfile, roleEnvelope, roles } from "../src/application/agents/roster.js";
import type { AgentRunner, RunRequest, RunResult } from "../src/application/ports/agent-runner.js";
import type { AttemptRecord, AttemptSink } from "../src/application/ports/attempt-sink.js";
import { envelopeKinds } from "../src/domain/envelopes/parse.js";
import { validateEnvelope } from "../src/domain/envelopes/registry.js";
import { ChildSessionRunner, childSpec } from "../src/infrastructure/sdk/child-session-runner.js";
import { loadAgentProfile } from "../src/resources.js";

describe("envelope examples", () => {
  it.each(envelopeKinds)("the %s example passes its own validator", (kind) => {
    const result = validateEnvelope(kind, envelopeExamples[kind]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});

describe("prompts", () => {
  it("names the kind and shows the envelope shape", () => {
    const prompt = buildPrompt("reviewer", "review", [
      { title: "Spec", body: "docs/frontsmith/x/spec.md" },
    ]);
    expect(prompt).toContain("kind `review`");
    expect(prompt).toContain('"schemaVersion": 1');
    expect(prompt).toContain("## Spec");
  });

  it("caps the diff at 200 KB and says it was truncated", () => {
    expect(capDiff("small")).toEqual({ text: "small", truncated: false });
    const big = capDiff("x".repeat(MAX_DIFF_BYTES + 500));
    expect(big.truncated).toBe(true);
    expect(big.text).toContain("truncated");
    expect(Buffer.byteLength(big.text)).toBeLessThan(MAX_DIFF_BYTES + 200);
  });

  it("lists at most twenty validation problems in a retry", () => {
    const errors = Array.from({ length: 30 }, (_, i) => ({ pointer: `/a/${i}`, message: "bad" }));
    const text = buildRetryPrompt("spec", errors);
    expect(text).toContain("/a/0");
    expect(text).not.toContain("/a/25");
    expect(text).toContain("10 more");
  });
});

const profile = async (name: string): Promise<AgentProfile> => loadAgentProfile(name);

class ScriptedRunner implements AgentRunner {
  readonly requests: RunRequest[] = [];
  cancelled = 0;
  constructor(private readonly replies: Array<RunResult | Error>) {}
  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return { sessionId: "child-1", ...next };
  }
  cancelAll(): void {
    this.cancelled += 1;
  }
}

class Attempts implements AttemptSink {
  readonly records: AttemptRecord[] = [];
  async begin(attempt: AttemptRecord): Promise<number> {
    this.records.push({ ...attempt });
    return this.records.length - 1;
  }
  async finish(seq: number, patch: Partial<AttemptRecord>): Promise<void> {
    Object.assign(this.records[seq] as AttemptRecord, patch);
  }
}

const text = (value: unknown): RunResult => ({ status: "completed", text: JSON.stringify(value) });

function deps(
  runner: AgentRunner,
  attempts = new Attempts(),
  model: string | null = null,
): DelegateDeps {
  return {
    runner,
    profiles: profile,
    attempts,
    models: {
      resolve: async () => ({ ok: true, model, source: model ? "config" : "default" }),
    },
    clock: { now: () => new Date("2026-10-06T12:00:00.000Z") },
  };
}

const request = {
  role: "reviewer" as const,
  kind: "review" as const,
  sections: [{ title: "Spec", body: "docs/frontsmith/x/spec.md" }],
  title: "review",
  workspace: "/w/app",
  parentSession: "root-1",
};

describe("delegate", () => {
  it("returns a validated envelope on the first answer and records the attempt", async () => {
    const attempts = new Attempts();
    const runner = new ScriptedRunner([text(envelopeExamples.review)]);
    const outcome = await delegate(deps(runner, attempts, "openai/gpt-5"), request);
    expect(outcome).toMatchObject({
      status: "ok",
      retried: false,
      model: "openai/gpt-5",
      source: "config",
      sessionId: "child-1",
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      model: "openai/gpt-5",
      parentSession: "root-1",
      workspace: "/w/app",
    });
    expect(attempts.records).toEqual([
      expect.objectContaining({
        kind: "child",
        agent: "fs-reviewer",
        model: "openai/gpt-5",
        modelSource: "config",
        status: "completed",
        sessionId: "child-1",
      }),
    ]);
  });

  it("accepts a fenced block and retries once in the same session with the errors", async () => {
    const runner = new ScriptedRunner([
      { status: "completed", text: "Looks good to me." },
      {
        status: "completed",
        text: `\`\`\`json\n${JSON.stringify(envelopeExamples.review)}\n\`\`\``,
      },
    ]);
    const outcome = await delegate(deps(runner), request);
    expect(outcome).toMatchObject({ status: "ok", retried: true });
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1]?.reuseSession).toBe("child-1");
    expect(runner.requests[1]?.prompt).toContain("not a single valid JSON value");
  });

  it("reports invalid after one retry and marks the attempt rejected", async () => {
    const attempts = new Attempts();
    const bad = { ...(envelopeExamples.review as object), verdict: "approved" };
    const runner = new ScriptedRunner([text(bad), text(bad)]);
    const outcome = await delegate(deps(runner, attempts), request);
    expect(outcome).toMatchObject({ status: "invalid", retried: true });
    if (outcome.status === "invalid") expect(outcome.errors[0]?.pointer).toBe("/verdict");
    expect(runner.requests).toHaveLength(2);
    expect(attempts.records[0]).toMatchObject({ status: "rejected" });
  });

  it("rejects a result cut off by the turn limit, even when the text parses", async () => {
    const runner = new ScriptedRunner([
      { status: "completed", text: JSON.stringify(envelopeExamples.review), turnsExceeded: true },
      { status: "completed", text: JSON.stringify(envelopeExamples.review), turnsExceeded: true },
    ]);
    expect(await delegate(deps(runner), request)).toMatchObject({ status: "invalid" });
  });

  it("surfaces a failed run, a thrown run and a cancelled run", async () => {
    expect(
      await delegate(
        deps(new ScriptedRunner([{ status: "failed", text: "", error: "boom" }])),
        request,
      ),
    ).toMatchObject({ status: "failed", error: "boom" });
    expect(
      await delegate(deps(new ScriptedRunner([new Error("socket closed")])), request),
    ).toMatchObject({
      status: "failed",
      error: "socket closed",
    });
    const attempts = new Attempts();
    expect(
      await delegate(
        deps(new ScriptedRunner([{ status: "cancelled", text: "" }]), attempts),
        request,
      ),
    ).toEqual({ status: "cancelled" });
    expect(attempts.records[0]).toMatchObject({ status: "interrupted" });
  });

  it("refuses to run when the model configuration is invalid", async () => {
    const runner = new ScriptedRunner([]);
    const outcome = await delegate(
      {
        ...deps(runner),
        models: {
          resolve: async () => ({
            ok: false,
            message: "Model configuration error in config: FSM-006",
          }),
        },
      },
      request,
    );
    expect(outcome).toEqual({
      status: "model-error",
      message: "Model configuration error in config: FSM-006",
    });
    expect(runner.requests).toHaveLength(0);
  });

  it("rejects an envelope kind the role does not return", async () => {
    await expect(
      delegate(deps(new ScriptedRunner([])), { ...request, kind: "spec" }),
    ).rejects.toThrow(/does not return a spec/);
  });

  it("passes the validation context to the fidelity-review validator", async () => {
    const runner = new ScriptedRunner([
      text({
        ...(envelopeExamples["fidelity-review"] as object),
        classifications: [
          { findingId: "F-0001", verdict: "acceptable-variation", rationale: "ok" },
        ],
      }),
    ]);
    const outcome = await delegate(deps(runner), {
      ...request,
      role: "fidelity-reviewer",
      kind: "fidelity-review",
      validation: { fidelityReview: { findings: { "F-0001": "REVIEW" } } },
    });
    expect(outcome).toMatchObject({ status: "ok" });
  });

  it("re-uses the session of a bounce", async () => {
    const runner = new ScriptedRunner([text(envelopeExamples["task-result"])]);
    await delegate(deps(runner), {
      ...request,
      role: "implementer",
      kind: "task-result",
      reuseSession: "child-9",
    });
    expect(runner.requests[0]?.reuseSession).toBe("child-9");
  });

  it("maps every role to an envelope kind that exists (coordinator has none)", () => {
    for (const role of roles)
      for (const kind of roleEnvelope[role]) expect(envelopeKinds).toContain(kind);
    expect(roleEnvelope.coordinator).toEqual([]);
  });
});

describe("test engineer modes (W-03)", () => {
  it("narrows the build profile in design mode and keeps it in build mode", async () => {
    const build = await loadAgentProfile("fs-test-engineer");
    expect(build).toMatchObject({ readOnly: false, maxTurns: 30 });
    expect(narrowProfile(build, "build")).toBe(build);
    const design = narrowProfile(build, "design");
    expect(design).toMatchObject({
      readOnly: true,
      maxTurns: 8,
      permission: { write: "deny", process: "deny" },
    });
    expect(design.tools).not.toContain("write_file");
    expect(design.tools).not.toContain("run_process");
    const other = await loadAgentProfile("fs-implementer");
    expect(narrowProfile(other, "design")).toBe(other);
  });

  it("starts the design-mode child with the narrowed profile", async () => {
    const runner = new ScriptedRunner([text(envelopeExamples["test-map"])]);
    await delegate(deps(runner), {
      ...request,
      role: "test-engineer",
      kind: "test-map",
      mode: "design",
    });
    expect(runner.requests[0]?.profile).toMatchObject({ readOnly: true, maxTurns: 8 });
  });
});

describe("ChildSessionRunner", () => {
  const sessionsFake = (
    outcomes: Array<Partial<import("@alisio/sdk").ChildRunResult> | Error> = [],
  ) => {
    const created: import("@alisio/sdk").ChildSessionSpec[] = [];
    const runs: Array<{ id: string; prompt: string }> = [];
    const cancelled: string[] = [];
    return {
      created,
      runs,
      cancelled,
      sessions: {
        create: async (spec: import("@alisio/sdk").ChildSessionSpec) => {
          created.push(spec);
          return { id: `s-${created.length}` } as import("@alisio/sdk").ChildSessionInfo;
        },
        run: async (id: string, prompt: string) => {
          runs.push({ id, prompt });
          const next = outcomes.shift() ?? {};
          if (next instanceof Error) throw next;
          return {
            id,
            status: "completed",
            text: "{}",
            usage: { input: 3, output: 4 },
            ...next,
          } as import("@alisio/sdk").ChildRunResult;
        },
        cancel: (id: string) => {
          cancelled.push(id);
          return 1;
        },
      },
    };
  };

  const baseRequest = async (over: Partial<RunRequest> = {}): Promise<RunRequest> => ({
    profile: await loadAgentProfile("fs-implementer"),
    parentSession: "root-1",
    title: "T-001 implementer",
    prompt: "do it",
    workspace: "/w/app",
    model: null,
    ...over,
  });

  it("builds the spec from the profile and omits the model when inheriting", async () => {
    const spec = childSpec(await baseRequest());
    expect(spec).toMatchObject({
      parentId: "root-1",
      agent: "fs-implementer",
      readOnly: false,
      permission: { write: "allow", process: "allow" },
      maxTurns: 40,
      timeoutMs: 900000,
      maxOutputTokens: 16000,
      workspace: "/w/app",
    });
    expect(spec).not.toHaveProperty("model");
    expect(spec.tools?.deny).toEqual(["task", "delegate", "subagent", "sessions_create"]);
    expect(spec.instructions).toContain("# Loaded skill: fs-implement-ui");
    expect(childSpec(await baseRequest({ model: "openai/gpt-5-codex" })).model).toBe(
      "openai/gpt-5-codex",
    );
  });

  it("creates a fresh child per run and maps a completed result", async () => {
    const fake = sessionsFake();
    const runner = new ChildSessionRunner({ sessions: fake.sessions });
    const result = await runner.run(await baseRequest());
    expect(result).toMatchObject({
      status: "completed",
      sessionId: "s-1",
      usage: { input: 3, output: 4 },
    });
    await runner.run(await baseRequest());
    expect(fake.created).toHaveLength(2);
  });

  it("re-uses a session without creating a new one", async () => {
    const fake = sessionsFake();
    const runner = new ChildSessionRunner({ sessions: fake.sessions });
    await runner.run(await baseRequest({ reuseSession: "s-9" }));
    expect(fake.created).toHaveLength(0);
    expect(fake.runs[0]).toEqual({ id: "s-9", prompt: "do it" });
  });

  it("maps turnsExceeded, failed, cancelled, thrown and create failures", async () => {
    const fake = sessionsFake([
      { turnsExceeded: true },
      { status: "failed", error: "provider down" },
      { status: "interrupted" },
      new Error("network"),
    ]);
    const runner = new ChildSessionRunner({ sessions: fake.sessions });
    expect(await runner.run(await baseRequest())).toMatchObject({
      status: "completed",
      turnsExceeded: true,
    });
    expect(await runner.run(await baseRequest())).toMatchObject({
      status: "failed",
      error: "provider down",
    });
    expect(await runner.run(await baseRequest())).toMatchObject({ status: "cancelled" });
    expect(await runner.run(await baseRequest())).toMatchObject({
      status: "failed",
      error: "network",
    });
    const broken = new ChildSessionRunner({
      sessions: {
        ...fake.sessions,
        create: async () => {
          throw new Error("unknown selector");
        },
      },
    });
    expect(await broken.run(await baseRequest({ model: "nope/none" }))).toMatchObject({
      status: "failed",
      error: "unknown selector",
    });
  });

  it("aborts and cancels live children on cancelAll", async () => {
    let release: (value: import("@alisio/sdk").ChildRunResult) => void = () => undefined;
    const fake = sessionsFake();
    const sessions = {
      ...fake.sessions,
      run: (_id: string, _prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise<import("@alisio/sdk").ChildRunResult>((resolve, reject) => {
          release = resolve;
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const runner = new ChildSessionRunner({ sessions });
    const pending = runner.run(await baseRequest());
    await new Promise((r) => setTimeout(r, 5));
    runner.cancelAll();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(fake.cancelled).toContain("s-1");
    release({} as never);
  });

  it("forwards an abort signal of the request", async () => {
    const controller = new AbortController();
    const fake = sessionsFake();
    const sessions = {
      ...fake.sessions,
      run: (_id: string, _prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise<import("@alisio/sdk").ChildRunResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const runner = new ChildSessionRunner({ sessions });
    const pending = runner.run(await baseRequest({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
  });
});
