import { describe, expect, it } from "vitest";
import { goodSpec, workflowFixture } from "./helpers/workflow.js";

const options = (extra: Record<string, unknown> = {}) => ({ sessionId: "root-1", ...extra });

describe("WorkflowCoordinator.advance (fs_next)", () => {
  it("runs deterministic units inline and starts child units as jobs", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      expect(await workflow.advance(f.root, "projects", options())).toMatchObject({
        kind: "unit",
        unit: "intake",
      });
      expect(await workflow.advance(f.root, "projects", options())).toMatchObject({
        kind: "unit",
        unit: "context",
      });
      f.runner.on("specifier", goodSpec());
      const finished: Array<Record<string, unknown>> = [];
      const started = await workflow.advance(
        f.root,
        "projects",
        options({ onJobFinished: (e: Record<string, unknown>) => void finished.push(e) }),
      );
      expect(started).toMatchObject({ kind: "job-started", unit: "specify" });
      await f.services.deps.jobs.wait("projects");
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        feature: "projects",
        unit: "specify",
        outcome: "waiting",
        next: { kind: "approve", command: "/frontsmith:approve projects spec" },
      });
      expect(finished[0]?.id).toBe((started as { id: string }).id);
    } finally {
      await f.cleanup();
    }
  });

  it("returns the live job instead of an error", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      let release: (() => void) | undefined;
      f.runner.on("specifier", async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return goodSpec();
      });
      const first = await workflow.advance(f.root, "projects", options());
      const second = await workflow.advance(f.root, "projects", options());
      expect(second).toMatchObject({
        kind: "job",
        unit: "specify",
        id: (first as { id: string }).id,
      });
      for (let i = 0; i < 200 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
      release?.();
      await f.services.deps.jobs.wait("projects");
    } finally {
      await f.cleanup();
    }
  });

  it("stops at an owed approval, an open question and a closed feature without running anything", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      const question = {
        id: "Q-01",
        question: "Which?",
        blocking: true,
        options: ["a", "b"],
        recommendation: "a",
      };
      f.runner.on("specifier", goodSpec({ openQuestions: [question] }));
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      await f.services.deps.jobs.wait("projects");
      const runs = f.runner.requests.length;
      expect(await workflow.advance(f.root, "projects", options())).toMatchObject({
        kind: "waiting-for-person",
        next: { kind: "answer" },
      });
      expect(f.runner.requests).toHaveLength(runs);
      await workflow.answer(f.root, "projects", "Q-01", "a", { via: "dialog" });
      f.runner.on("specifier", goodSpec({ openQuestions: [question] }));
      await workflow.advance(f.root, "projects", options());
      await f.services.deps.jobs.wait("projects");
      expect(await workflow.advance(f.root, "projects", options())).toMatchObject({
        kind: "waiting-for-person",
        next: { kind: "approve" },
      });
      expect(f.runner.requests).toHaveLength(runs + 1);
    } finally {
      await f.cleanup();
    }
  });

  it("a thrown notice hook never breaks the job", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      f.runner.on("specifier", goodSpec());
      await workflow.advance(
        f.root,
        "projects",
        options({
          onJobFinished: () => {
            throw new Error("boom");
          },
        }),
      );
      await f.services.deps.jobs.wait("projects");
      expect((await workflow.status(f.root, "projects")).state.job).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
});

describe("answer provenance", () => {
  it("records the command by default and the dialog when told", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      const question = {
        id: "Q-01",
        question: "a?",
        blocking: false,
        options: ["x"],
        recommendation: "x",
      };
      const q2 = { ...question, id: "Q-02" };
      f.runner.on("specifier", goodSpec({ openQuestions: [question, q2] }));
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      await workflow.advance(f.root, "projects", options());
      await f.services.deps.jobs.wait("projects");
      await workflow.answer(f.root, "projects", "Q-01", "one");
      await workflow.answer(f.root, "projects", "Q-02", "two", { via: "dialog" });
      const { state } = await workflow.status(f.root, "projects");
      expect(state.questions.map((q) => q.answeredVia)).toEqual(["command", "dialog"]);
    } finally {
      await f.cleanup();
    }
  });
});
