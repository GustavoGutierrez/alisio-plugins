import { describe, expect, it } from "vitest";
import { footerLine } from "../src/application/workflow/view.js";
import { goodPlan, goodSpec, workflowFixture } from "./helpers/workflow.js";

const options = { sessionId: "root-1" };

describe("coordinator view", () => {
  it("describes a fresh feature", async () => {
    const f = await workflowFixture();
    try {
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "x",
        level: "L1",
      });
      const view = await f.services.workflow.view(f.root, "projects");
      expect(view).toMatchObject({
        feature: "projects",
        level: "L1",
        phase: "intake",
        blocked: null,
        running: false,
        job: null,
        gate: null,
        openQuestions: [],
        owedApproval: null,
        pendingDependencies: [],
        artifacts: [],
        source: null,
        next: { kind: "next", command: "/frontsmith:next projects" },
      });
      expect(view.footer).toBe(
        "Feature: projects (L1, build) · Phase: intake · Gate: none · Next: /frontsmith:next projects",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("lists open questions with their options and clips long text", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      f.runner.on(
        "specifier",
        goodSpec({
          openQuestions: [
            {
              id: "Q-01",
              question: "q".repeat(900),
              blocking: true,
              options: ["mine", "all"],
              recommendation: "mine",
            },
          ],
        }),
      );
      for (let i = 0; i < 3; i += 1) await workflow.advance(f.root, "projects", options);
      await f.services.deps.jobs.wait("projects");
      const view = await workflow.view(f.root, "projects");
      expect(view.openQuestions).toHaveLength(1);
      expect(view.openQuestions[0]).toMatchObject({
        id: "Q-01",
        blocking: true,
        options: ["mine", "all"],
        recommendation: "mine",
      });
      expect(view.openQuestions[0]?.question.length).toBeLessThanOrEqual(500);
      expect(view.gate).toMatchObject({ id: "G1", verdict: "BLOCKED" });
      expect(view.next.kind).toBe("answer");
      expect(view.artifacts).toContain("docs/frontsmith/projects/spec.md");
    } finally {
      await f.cleanup();
    }
  });

  it("names the owed approval and the pending dependencies", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      f.runner.on("specifier", goodSpec());
      for (let i = 0; i < 3; i += 1) await workflow.advance(f.root, "projects", options);
      await f.services.deps.jobs.wait("projects");
      expect((await workflow.view(f.root, "projects")).owedApproval).toBe("spec");
      await workflow.approve(f.root, "projects", "spec");
      f.runner.on(
        "architect",
        goodPlan({
          dependencies: [{ name: "zod", version: "4.1.5", reason: "validate responses" }],
        }),
      );
      await workflow.advance(f.root, "projects", options);
      await f.services.deps.jobs.wait("projects");
      const view = await workflow.view(f.root, "projects");
      expect(view.pendingDependencies).toEqual(["zod"]);
    } finally {
      await f.cleanup();
    }
  });

  it("shows the running job in the footer", () => {
    expect(
      footerLine({
        feature: "a",
        level: "L2",
        mode: "build",
        phase: "build",
        gate: { id: "G6", verdict: "PASS", failing: [], blocking: [] },
        next: { kind: "job", command: "/frontsmith:status a", message: "" },
        job: { id: "j1", unit: "build" },
        running: true,
      }),
    ).toBe("Feature: a (L2, build) · Phase: build · Gate: G6 PASS · Next: waiting for job j1");
  });
});
