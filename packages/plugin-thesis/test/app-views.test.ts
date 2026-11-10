import { afterEach, describe, expect, it } from "vitest";
import { nextStep, sectionStep } from "../src/app/views.js";
import { defaultState } from "../src/storage.js";
import type { ThesisState } from "../src/types.js";
import { cleanup, lifecycle } from "./helpers/harness.js";

afterEach(cleanup);

/** Independent reading of `/thesis:...` text: which app operation the chat names. */
const EXPECTED: Record<string, string> = {
  answer: "interview",
  design: "design.run",
  outline: "outline.run",
  approve: "approve",
  research: "research.run",
  draft: "draft.run",
  review: "review.run",
  revise: "findings",
  finalize: "finalize.run",
};

function fixtures(): [string, ThesisState][] {
  const base = (): ThesisState => {
    const state = defaultState("thesis");
    state.intake.completedRounds = [1, 2, 3];
    state.phase = "design";
    return state;
  };
  const at = (label: string, change: (s: ThesisState) => void): [string, ThesisState] => {
    const state = base();
    change(state);
    return [label, state];
  };
  const now = "2026-11-10T10:00:00.000Z";
  const sections = (entries: Record<string, ThesisState["sections"][string]>) => entries;
  return [
    at("design without protocol", () => undefined),
    at("gate A pending", (s) => {
      s.protocolAt = now;
    }),
    at("gate B pending", (s) => {
      s.protocolAt = now;
      s.humanGates.A = { status: "approved", at: now };
    }),
    at("outline not drafted", (s) => {
      s.phase = "outline";
    }),
    at("outline drafted", (s) => {
      s.phase = "outline";
      s.outlineAt = now;
    }),
    at("draft review first", (s) => {
      s.phase = "sections";
      s.sections = sections({
        "SEC-01": { status: "research_review" },
        "SEC-02": { status: "draft_review" },
      });
    }),
    at("research review", (s) => {
      s.phase = "sections";
      s.sections = sections({
        "SEC-01": { status: "approved" },
        "SEC-02": { status: "research_review" },
      });
    }),
    at("draftable", (s) => {
      s.phase = "sections";
      s.sections = sections({ "SEC-01": { status: "research_approved" } });
    }),
    at("research next", (s) => {
      s.phase = "sections";
      s.sections = sections({
        "SEC-01": { status: "planned" },
        "SEC-02": { status: "planned", dependsOn: ["SEC-01"] },
      });
    }),
    at("waiting", (s) => {
      s.phase = "sections";
      s.sections = sections({
        "SEC-01": { status: "researching", dependsOn: ["SEC-02"] },
        "SEC-02": { status: "researching", dependsOn: ["SEC-01"] },
      });
    }),
    at("review needed", (s) => {
      s.phase = "review";
      s.sections = sections({ "SEC-01": { status: "approved", updatedAt: now } });
    }),
    at("blocking findings", (s) => {
      s.phase = "review";
      s.sections = sections({ "SEC-01": { status: "approved", updatedAt: now } });
      s.lastReview = { at: now, scope: "all", sections: ["SEC-01"], findings: 2, blocking: 1 };
    }),
    at("ready to finalize", (s) => {
      s.phase = "review";
      s.sections = sections({ "SEC-01": { status: "approved", updatedAt: now } });
      s.lastReview = { at: now, scope: "all", sections: ["SEC-01"], findings: 0, blocking: 0 };
    }),
    at("final", (s) => {
      s.phase = "final";
    }),
    at("submitted", (s) => {
      s.phase = "submitted";
      s.submittedAt = now;
    }),
  ];
}

describe("nextStep vs nextCommand (THA-AC-12)", () => {
  it("names the same operation and target as /thesis:status for every fixture state", async () => {
    const h = await lifecycle();
    const next = (state: ThesisState) => h.coordinator.nextCommandFor(state);
    for (const [label, state] of fixtures()) {
      const command = next(state);
      const step = nextStep(state, next);
      const match = /^\/thesis:([a-z]+)(?:\s+(\S+))?/.exec(command);
      const name = match?.[1] ?? "";
      const expected = EXPECTED[name] ?? (state.phase === "submitted" ? "done" : "wait");
      expect(step.action, `${label}: ${command}`).toBe(expected);
      const target = match?.[2];
      if (expected === "review.run") expect(step.target, label).toBe(target ?? "all");
      else if (!["findings", "wait", "done"].includes(expected) && target)
        expect(step.target, label).toBe(target);
      expect(step.phase, label).toBe(state.phase);
      expect(step.reasonKey, label).toMatch(/^[a-z_]+$/);
    }
  });

  it("covers the states before the lifecycle starts", () => {
    const next = () => "/thesis:status";
    expect(nextStep(undefined, next)).toEqual({
      action: "project.init",
      phase: null,
      reasonKey: "start",
    });
    const pending = defaultState("thesis");
    pending.pendingQuestions = { round: 1, createdAt: "2026-11-10T10:00:00.000Z", questions: [] };
    expect(nextStep(pending, next).action).toBe("interview");
    const unfinished = defaultState("thesis");
    unfinished.intake.completedRounds = [1];
    expect(nextStep(unfinished, next)).toMatchObject({
      action: "project.init",
      reasonKey: "finish_interview",
    });
    const g0 = defaultState("thesis");
    g0.intake.completedRounds = [1, 2, 3];
    expect(nextStep(g0, next)).toMatchObject({ action: "check.run", reasonKey: "fix_g0" });
  });

  it("maps one section's next step, including dependency waits", () => {
    const state = defaultState("thesis");
    state.sections = { "SEC-02": { status: "research_review" } };
    expect(sectionStep("", state)).toBeNull();
    expect(sectionStep("waits for SEC-01, SEC-03", state)).toEqual({
      action: "wait",
      waitsFor: ["SEC-01", "SEC-03"],
    });
    expect(sectionStep("/thesis:research SEC-02", state)).toEqual({
      action: "research.run",
      target: "SEC-02",
    });
    expect(sectionStep("/thesis:approve SEC-02", state)).toEqual({
      action: "approve",
      target: "SEC-02",
    });
  });
});
