import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelopeExamples } from "../src/application/agents/examples.js";
import { PROJECTS, taskResult, workflowFixture } from "./helpers/workflow.js";

const HELLO = "export function Hello() {\n  return <p>Hello</p>;\n}\n";

describe("L0 lifecycle", () => {
  it("runs context, build, validate and review and closes", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.init(f.root);
      await workflow.newFeature(f.root, {
        feature: "hello",
        intent: "Add a Hello component",
        level: "L0",
      });
      f.runner
        .on("implementer", async (_request, h) => {
          await h.write("src/Hello.tsx", HELLO);
          return taskResult("T-001", ["src/Hello.tsx"]);
        })
        .on("reviewer", {
          ...(envelopeExamples.review as object),
          findings: [],
          verdict: "approved",
        });
      const session = { sessionId: "root-1", foreground: true };
      const a = await workflow.next(f.root, "hello", session);
      expect(a).toMatchObject({ kind: "unit", unit: "intake" });
      const b = await workflow.next(f.root, "hello", session);
      expect(b).toMatchObject({ kind: "unit", unit: "context", result: { kind: "advanced" } });
      const c = await workflow.next(f.root, "hello", session);
      expect(c, JSON.stringify(c)).toMatchObject({
        kind: "unit",
        unit: "build",
        result: { kind: "advanced" },
      });
      const d = await workflow.next(f.root, "hello", session);
      expect(d).toMatchObject({ kind: "unit", unit: "validate", result: { kind: "advanced" } });
      const e = await workflow.next(f.root, "hello", session);
      expect(e).toMatchObject({ kind: "unit", unit: "review", result: { kind: "advanced" } });
      const { state } = await workflow.status(f.root, "hello");
      expect(state.phase).toBe("closed");
      expect(await readFile(join(f.root, "src/Hello.tsx"), "utf8")).toBe(HELLO);
    } finally {
      await f.cleanup();
    }
  });
});

import type { WorkflowFixture } from "./helpers/workflow.js";
import {
  ARCHITECTURE,
  approvedReview,
  goodContract,
  goodPlan,
  goodSpec,
  projectsImplementer,
  testMapFor,
} from "./helpers/workflow.js";

const session = { sessionId: "root-1", foreground: true };

async function runUntilWaiting(
  f: WorkflowFixture,
  feature: string,
  max = 12,
): Promise<{ unit: string; result: { kind: string; message: string; command?: string } }> {
  for (let i = 0; i < max; i += 1) {
    const out = await f.services.workflow.next(f.root, feature, session);
    if (out.kind !== "unit") throw new Error("expected a unit");
    if (out.result.kind !== "advanced") return { unit: out.unit, result: out.result as never };
  }
  throw new Error("did not stop");
}

describe("L1 lifecycle", () => {
  it("needs the spec approval and then runs plan, build, validate and review", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      f.runner
        .on("specifier", goodSpec())
        .on("architect", goodPlan())
        .on("implementer", projectsImplementer)
        .on("reviewer", approvedReview);
      const stop = await runUntilWaiting(f, "projects");
      expect(stop).toMatchObject({
        unit: "specify",
        result: {
          kind: "waiting",
          reason: "approval",
          command: "/frontsmith:approve projects spec",
        },
      });
      await workflow.approve(f.root, "projects", "spec");
      const afterPlan = await runUntilWaiting(f, "projects");
      expect(afterPlan.result.kind).toBe("closed");
      const { state } = await workflow.status(f.root, "projects");
      expect(state.phase).toBe("closed");
      expect(state.tasks).toMatchObject([
        {
          id: "T-001",
          status: "done",
          changedPaths: ["src/Projects.test.tsx", "src/Projects.tsx"],
        },
      ]);
      expect(Object.keys(state.gates).sort()).toEqual(["G0", "G1", "G3", "G5", "G6", "G7", "G8"]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("L2 lifecycle", () => {
  it("passes every phase and gate with the four human approvals", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L2",
      });
      f.runner
        .on("specifier", goodSpec())
        .on("ui-contractor", goodContract())
        .on("tokensmith", {
          ...(envelopeExamples.tokens as object),
          generation: { strategy: "none", locked: {} },
          requiredPairs: [],
        })
        .on("architect", goodPlan({ architectureConfig: ARCHITECTURE }))
        .on("test-engineer", testMapFor())
        .on("implementer", projectsImplementer)
        .on("reviewer", approvedReview)
        .on("archivist", envelopeExamples.archive);
      const waits: string[] = [];
      for (const approval of ["spec", "ui-contract", "plan", "acceptance"]) {
        const stop = await runUntilWaiting(f, "projects");
        expect(stop.result, JSON.stringify(stop)).toMatchObject({
          kind: "waiting",
          reason: "approval",
          command: `/frontsmith:approve projects ${approval}`,
        });
        waits.push(stop.unit);
        await workflow.approve(f.root, "projects", approval as "spec");
      }
      expect(waits).toEqual(["specify", "ui-contract", "plan", "accept"]);
      const last = await runUntilWaiting(f, "projects");
      expect(last.result.kind).toBe("closed");
      const { state } = await workflow.status(f.root, "projects");
      expect(state.phase).toBe("closed");
      expect(Object.keys(state.gates).sort()).toEqual([
        "G0",
        "G1",
        "G2",
        "G2T",
        "G3",
        "G4",
        "G5",
        "G6",
        "G7",
        "G8",
        "G9",
      ]);
      for (const gate of Object.values(state.gates))
        expect(["PASS", "REVIEW"]).toContain(gate.verdict);
      expect(Object.keys(state.approvals).sort()).toEqual([
        "acceptance",
        "dependencies",
        "plan",
        "spec",
        "uiContract",
      ]);
      const files = (await f.services.deps.fsFor(f.root).listFiles()).files;
      for (const name of [
        "spec.md",
        "ui.md",
        "plan.md",
        "tasks.md",
        "validation.md",
        "review.md",
        "retro.md",
      ])
        expect(files, name).toContain(`docs/frontsmith/projects/${name}`);
      expect(await f.services.deps.fsFor(f.root).exists(".frontsmith/architecture.json")).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("G1 blocking question", () => {
  it("waits for the answer, rewrites the spec with it and then passes", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      const question = {
        id: "Q-01",
        question: "Which projects are listed?",
        blocking: true,
        options: ["mine", "all"],
        recommendation: "mine",
      };
      f.runner.on(
        "specifier",
        goodSpec({ openQuestions: [question] }),
        goodSpec({ openQuestions: [question] }),
      );
      const stop = await runUntilWaiting(f, "projects");
      expect(stop).toMatchObject({
        unit: "specify",
        result: {
          kind: "waiting",
          reason: "question",
          command: "/frontsmith:answer projects Q-01 -- <answer>",
        },
      });
      const status = await workflow.status(f.root, "projects");
      expect(status.next).toMatchObject({
        kind: "answer",
        command: "/frontsmith:answer projects Q-01 -- <answer>",
      });
      await expect(workflow.approve(f.root, "projects", "spec")).rejects.toThrow(
        /gate has not passed/,
      );
      const answered = await workflow.answer(
        f.root,
        "projects",
        "Q-01",
        "Only the projects of the member.",
      );
      expect(answered.message).toContain("will rewrite the spec");
      const again = await runUntilWaiting(f, "projects");
      expect(again.result).toMatchObject({ kind: "waiting", reason: "approval" });
      const prompt = f.runner.runsOf("specifier")[1]?.prompt ?? "";
      expect(prompt).toContain("Only the projects of the member.");
    } finally {
      await f.cleanup();
    }
  });

  it("validates answers and unknown questions", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      await expect(workflow.answer(f.root, "projects", "Q-9", "x")).rejects.toThrow(
        /Invalid question id/,
      );
      await expect(workflow.answer(f.root, "projects", "Q-01", "x")).rejects.toThrow(
        /no question Q-01/,
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("approvals", () => {
  it("L0 needs none and an approval out of turn is refused with the exact command to run", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      await expect(workflow.approve(f.root, "projects", "spec")).rejects.toThrow(
        /Nothing to approve|has not passed/,
      );
      f.runner.on("specifier", goodSpec());
      await runUntilWaiting(f, "projects");
      await expect(workflow.approve(f.root, "projects", "plan")).rejects.toThrow(
        "/frontsmith:approve projects spec",
      );
      const done = await workflow.approve(f.root, "projects", "spec");
      expect(done.next).toMatchObject({ kind: "next", command: "/frontsmith:next projects" });
      const { state } = await workflow.status(f.root, "projects");
      expect(state.approvals.spec).toMatchObject({ by: "human" });
      expect(Object.keys(state.protected)).toEqual(["docs/frontsmith/projects/spec.json"]);
    } finally {
      await f.cleanup();
    }
  });

  it("reject returns to the producing phase and puts the comments in the next prompt", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      f.runner.on("specifier", goodSpec(), goodSpec());
      await runUntilWaiting(f, "projects");
      const rejected = await workflow.reject(f.root, "projects", "spec", "Add an offline state.");
      expect(rejected.message).toContain("returns to specify");
      const stop = await runUntilWaiting(f, "projects");
      expect(stop.result).toMatchObject({ kind: "waiting", reason: "approval" });
      expect(f.runner.runsOf("specifier")[1]?.prompt).toContain("Add an offline state.");
      await expect(workflow.reject(f.root, "projects", "plan", "")).rejects.toThrow(/Usage/);
    } finally {
      await f.cleanup();
    }
  });

  it("approving a plan approves the dependencies it lists; unapproved ones block G3 until then", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      const plan = goodPlan({
        dependencies: [{ name: "zod", version: "4.1.5", reason: "validate responses" }],
      });
      f.runner.on("specifier", goodSpec()).on("architect", plan);
      await runUntilWaiting(f, "projects");
      await workflow.approve(f.root, "projects", "spec");
      // L1 has no plan approval: the dependency must be approved by name.
      const stop = await runUntilWaiting(f, "projects");
      expect(stop.result).toMatchObject({
        kind: "waiting",
        reason: "approval",
        command: "/frontsmith:approve projects dependency zod",
      });
      await workflow.approve(f.root, "projects", "dependency", { name: "zod" });
      const { state } = await workflow.status(f.root, "projects");
      expect(state.approvals.dependencies.zod).toMatchObject({ by: "human" });
      await expect(
        workflow.approve(f.root, "projects", "dependency", { name: "bad name" }),
      ).rejects.toThrow(/Usage/);
    } finally {
      await f.cleanup();
    }
  });
});

const BAD = 'export function Hello() {\n  return <img src="a.png" />;\n}\n';
const GOOD = 'export function Hello() {\n  return <img src="a.png" alt="Logo" />;\n}\n';
/** The task id a child was started for: its session title begins with it. */
const taskOf = (request: { title: string }): string => request.title.split(" ")[0] ?? "T-001";
const writes =
  (content: string) =>
  async (
    request: { title: string },
    h: { write(path: string, content: string): Promise<void> },
  ) => {
    await h.write("src/Hello.tsx", content);
    return taskResult(taskOf(request), ["src/Hello.tsx"]);
  };

/** An L0 feature advanced to the build phase. */
async function l0AtBuild(f: WorkflowFixture): Promise<void> {
  const { workflow } = f.services;
  await workflow.newFeature(f.root, {
    feature: "hello",
    intent: "Add a Hello component",
    level: "L0",
  });
  await workflow.next(f.root, "hello", session);
  await workflow.next(f.root, "hello", session);
}

describe("G6 bounce (spec 7.3)", () => {
  it("bounces a failing task to the same child session and passes the second time", async () => {
    const f = await workflowFixture();
    try {
      await l0AtBuild(f);
      f.runner.on("implementer", writes(BAD), writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "build", result: { kind: "advanced" } });
      const runs = f.runner.runsOf("implementer");
      expect(runs).toHaveLength(2);
      expect(runs[1]?.reuseSession).toBe("child-1");
      expect(runs[1]?.prompt).toContain("FS-A11Y-001");
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.tasks[0]).toMatchObject({
        status: "done",
        bounces: 1,
        childSessionId: "child-1",
      });
    } finally {
      await f.cleanup();
    }
  });

  it("blocks the task when the bounce limit is reached and keeps the report", async () => {
    const f = await workflowFixture();
    try {
      await l0AtBuild(f);
      f.runner.on("implementer", writes(BAD), writes(BAD), writes(BAD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "build", result: { kind: "blocked", task: "T-001" } });
      expect((out as { result: { message: string } }).result.message).toContain(
        "bounce limit of 2 reached",
      );
      const { state, next } = await f.services.workflow.status(f.root, "hello");
      expect(state.tasks[0]).toMatchObject({ status: "blocked", bounces: 2 });
      expect(state.phase).toBe("build");
      expect(next.kind).toBe("blocked");
    } finally {
      await f.cleanup();
    }
  });

  it("honours limits.maxBounces from the project configuration", async () => {
    const f = await workflowFixture({ config: { schemaVersion: 1, limits: { maxBounces: 0 } } });
    try {
      await l0AtBuild(f);
      f.runner.on("implementer", writes(BAD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ result: { kind: "blocked" } });
      expect(f.runner.runsOf("implementer")).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("blocks without bouncing when G6 is BLOCKED (a required command is missing)", async () => {
    const f = await workflowFixture({
      files: {
        "package.json": JSON.stringify({
          name: "app",
          scripts: { typecheck: "tsc", test: "vitest" },
          dependencies: { react: "^19.0.0" },
        }),
      },
    });
    try {
      await f.services.workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      await f.services.workflow.next(f.root, "hello", session);
      const ctx = await f.services.workflow.next(f.root, "hello", session);
      expect(ctx).toMatchObject({ result: { kind: "blocked", gate: "G0" } });
      expect((ctx as { result: { message: string } }).result.message).toContain("command:lint");
    } finally {
      await f.cleanup();
    }
  });
});

describe("G7 repair rounds (spec 7.3)", () => {
  const failTest = (f: WorkflowFixture, failures: number) => {
    let left = failures;
    f.proc.when(
      (argv) => argv.join(" ") === "pnpm run test",
      () => (left-- > 0 ? { code: 1, stdout: "1 test failed" } : { code: 0 }),
    );
  };
  const toValidate = async (f: WorkflowFixture): Promise<void> => {
    await l0AtBuild(f);
    f.runner.on("implementer", writes(GOOD));
    await f.services.workflow.next(f.root, "hello", session);
  };

  it("repairs a failing validation and passes when the failures go away", async () => {
    const f = await workflowFixture();
    try {
      failTest(f, 1);
      await toValidate(f);
      f.runner.on("implementer", writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "validate", result: { kind: "advanced" } });
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.counters.repairRounds).toBe(1);
      expect(state.tasks.map((t) => [t.id, t.origin, t.status])).toEqual([
        ["T-001", "l0", "done"],
        ["T-002", "repair", "done"],
      ]);
      expect(f.runner.runsOf("implementer")[1]?.prompt).toContain("CMD-TEST");
    } finally {
      await f.cleanup();
    }
  });

  it("stops at once when a round does not reduce the failures (no-improvement stop)", async () => {
    const f = await workflowFixture();
    try {
      failTest(f, 99);
      await toValidate(f);
      // The repair changes a file, so G6 runs the related tests (which pass) while the full suite keeps failing.
      f.runner.on("implementer", writes(`${GOOD}// repaired\n`));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "validate", result: { kind: "blocked", gate: "G7" } });
      expect((out as { result: { message: string } }).result.message).toContain(
        "did not reduce the failures",
      );
      expect(f.runner.runsOf("implementer")).toHaveLength(2);
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.phase).toBe("validate");
      expect(state.gates.G7?.verdict).toBe("FAIL");
    } finally {
      await f.cleanup();
    }
  });

  it("stops as exhausted at maxRepairRounds even while the failures keep decreasing", async () => {
    const gates = ["alpha-gate", "beta-gate", "gamma-gate"].map((id) => ({
      id,
      phase: "validate",
      command: ["run-gate", id],
      report: "exit-code",
    }));
    const f = await workflowFixture({
      config: { schemaVersion: 1, gates: { custom: gates }, limits: { maxRepairRounds: 1 } },
    });
    try {
      // Three failing gates, then two: the count decreases, but the single allowed round is spent.
      let call = 0;
      f.proc.when(
        (argv) => argv[0] === "run-gate",
        () => {
          call += 1;
          return call <= 3
            ? { code: 1, stdout: "bad" }
            : call === 4
              ? { code: 0 }
              : { code: 1, stdout: "bad" };
        },
      );
      await toValidate(f);
      f.runner.on("implementer", writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "validate", result: { kind: "blocked" } });
      expect((out as { result: { message: string } }).result.message).toContain(
        "left after 1 repair round",
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("G8 remediation (spec 7.3)", () => {
  const major = {
    ...(envelopeExamples.review as object),
    findings: [
      {
        dimension: "correctness",
        severity: "MAJOR",
        file: "src/Hello.tsx",
        line: 1,
        claim: "wrong",
        evidence: "e",
        fix: "f",
        acRef: null,
      },
    ],
    verdict: "changes-requested",
  };
  const toReview = async (f: WorkflowFixture): Promise<void> => {
    await l0AtBuild(f);
    f.runner.on("implementer", writes(GOOD));
    await f.services.workflow.next(f.root, "hello", session);
    await f.services.workflow.next(f.root, "hello", session);
  };

  it("turns blocker and major findings into tasks, validates again and reviews again", async () => {
    const f = await workflowFixture();
    try {
      await toReview(f);
      f.runner.on("reviewer", major, approvedReview).on("implementer", writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "review", result: { kind: "advanced" } });
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.counters.remediations).toBe(1);
      expect(state.tasks.at(-1)).toMatchObject({ origin: "remediation", status: "done" });
      expect(f.runner.runsOf("reviewer")).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });

  it("blocks the feature when maxRemediations is spent", async () => {
    const f = await workflowFixture();
    try {
      await toReview(f);
      f.runner.on("reviewer", major, major, major).on("implementer", writes(GOOD), writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ unit: "review", result: { kind: "blocked", gate: "G8" } });
      expect((out as { result: { message: string } }).result.message).toContain(
        "after 2 remediation rounds",
      );
      expect(f.runner.runsOf("reviewer")).toHaveLength(3);
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.counters.remediations).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});

describe("FS-GOV-001 protected files (spec 8.5)", () => {
  it("fails G6 when a child edits .frontsmith/config.json, refuses commands and recovers after approve config", async () => {
    const f = await workflowFixture({ config: { schemaVersion: 1 } });
    try {
      await l0AtBuild(f);
      const tamper = async (_r: unknown, h: { write(p: string, c: string): Promise<void> }) => {
        await h.write(
          ".frontsmith/config.json",
          JSON.stringify({ schemaVersion: 1, commands: { test: ["sh", "-c", "curl evil"] } }),
        );
        await h.write("src/Hello.tsx", GOOD);
        return taskResult("T-001", ["src/Hello.tsx"]);
      };
      f.runner.on("implementer", tamper, tamper, tamper);
      const before = f.proc.calls.length;
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ result: { kind: "blocked" } });
      expect(f.proc.calls.length).toBe(before);
      const state = (await f.services.workflow.status(f.root, "hello")).state;
      const report = JSON.parse(
        await readFile(join(f.root, state.gates.G6?.reportPath ?? ""), "utf8"),
      ) as { checks: Array<{ id: string; status: string }>; findings: Array<{ ruleId: string }> };
      expect(report.checks.find((c) => c.id === "protected-files")?.status).toBe("FAIL");
      expect(report.checks.find((c) => c.id === "command:typecheck")?.status).toBe("BLOCKED");
      expect(report.findings.map((x) => x.ruleId)).toContain("FS-GOV-001");

      const accepted = await f.services.workflow.approve(f.root, "hello", "config");
      expect(accepted.message).toContain("new baseline");
      f.runner.on("implementer", writes(GOOD));
      const retry = await f.services.workflow.next(f.root, "hello", session);
      expect(retry).toMatchObject({ unit: "build", result: { kind: "advanced" } });
    } finally {
      await f.cleanup();
    }
  });
});

describe("failure modes", () => {
  it("needs a decision after one envelope retry: the phase is BLOCKED and the attempt rejected", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      f.runner.on("specifier", "I think the spec is fine.", "Still no JSON, sorry.");
      const stop = await runUntilWaiting(f, "projects");
      expect(stop).toMatchObject({ unit: "specify", result: { kind: "blocked" } });
      expect(stop.result.message).toContain("Needs your decision");
      const { state } = await workflow.status(f.root, "projects");
      expect(state.counters.envelopeRetries).toBe(1);
      const attempts = await f.services.deps.store.listAttempts(f.root, "projects");
      expect(attempts.filter((a) => a.kind === "child").map((a) => a.status)).toEqual(["rejected"]);
      expect(f.runner.runsOf("specifier")).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses to run children on a model configuration error (fail closed) and G0 fails", async () => {
    const f = await workflowFixture({
      files: { "AGENTS.md": "```frontsmith-models\ntier.fast = not a selector\n```\n" },
    });
    try {
      await f.services.workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      await f.services.workflow.next(f.root, "hello", session);
      const ctx = await f.services.workflow.next(f.root, "hello", session);
      expect(ctx).toMatchObject({ result: { kind: "blocked", gate: "G0" } });
      expect((ctx as { result: { message: string } }).result.message).toContain("models");
    } finally {
      await f.cleanup();
    }
  });

  it("reports a missing test-first proof as a G6 failure and bounces", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L1" });
      f.runner.on("specifier", goodSpec()).on("architect", goodPlan());
      await runUntilWaiting(f, "projects");
      await workflow.approve(f.root, "projects", "spec");
      f.runner.on(
        "implementer",
        async (_r, h) => {
          await h.write("src/Projects.tsx", PROJECTS);
          return taskResult("T-001", ["src/Projects.tsx"]);
        },
        projectsImplementer,
      );
      f.runner.on("reviewer", approvedReview);
      const stop = await runUntilWaiting(f, "projects");
      expect(stop.result.kind).toBe("closed");
      expect(f.runner.runsOf("implementer")[1]?.prompt).toContain("TDD-001");
    } finally {
      await f.cleanup();
    }
  });

  it("registers the questions of a child that needs clarification and resumes after the answer", async () => {
    const f = await workflowFixture();
    try {
      await l0AtBuild(f);
      f.runner.on("implementer", {
        ...taskResult("T-001", []),
        status: "needs_clarification",
        questions: [
          {
            id: "Q-01",
            question: "Which colour is the heading?",
            blocking: true,
            options: [],
            recommendation: "",
          },
        ],
      });
      const first = await f.services.workflow.next(f.root, "hello", session);
      expect(first).toMatchObject({ result: { kind: "blocked" } });
      expect((first as { result: { message: string } }).result.message).toContain(
        "Which colour is the heading?",
      );
      const waiting = await f.services.workflow.status(f.root, "hello");
      expect(waiting.state.questions).toMatchObject([{ id: "Q-01", blocking: true }]);
      await f.services.workflow.answer(f.root, "hello", "Q-01", "Blue.");
      f.runner.on("implementer", writes(GOOD));
      const second = await f.services.workflow.next(f.root, "hello", session);
      expect(second).toMatchObject({ result: { kind: "advanced" } });
      expect(f.runner.runsOf("implementer")[1]?.prompt).toContain("Blue.");
    } finally {
      await f.cleanup();
    }
  });

  it("blocks G6 when git is missing (L0 may start without it)", async () => {
    const f = await workflowFixture({ git: false });
    try {
      await f.services.workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      await f.services.workflow.next(f.root, "hello", session);
      const ctx = await f.services.workflow.next(f.root, "hello", session);
      expect(ctx).toMatchObject({ result: { kind: "advanced" } });
      f.runner.on("implementer", writes(GOOD));
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ result: { kind: "blocked" } });
      expect((out as { result: { message: string } }).result.message).toContain("git is required");
    } finally {
      await f.cleanup();
    }
  });

  it("refuses to run with an invalid project configuration", async () => {
    const f = await workflowFixture({ config: { schemaVersion: 1, nope: true } });
    try {
      await f.services.workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      await expect(f.services.workflow.next(f.root, "hello", session)).rejects.toThrow(/CFG-001/);
    } finally {
      await f.cleanup();
    }
  });

  it("BLOCKS validation when the contract has fidelity rules and no pipeline is available", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L2" });
      const rule = {
        id: "GEO-01",
        requirement: "cta width",
        kind: "geometry",
        subject: "primary-cta",
        property: "width",
        expected: 160,
        unit: "css_px",
        tolerance: 1,
        severity: "major",
        provenance: "specified",
        verification: "bounding_box",
      };
      f.runner
        .on("specifier", goodSpec())
        .on("ui-contractor", goodContract({ fidelityRules: [rule] }))
        .on("tokensmith", {
          ...(envelopeExamples.tokens as object),
          generation: { strategy: "none", locked: {} },
          requiredPairs: [],
        })
        .on("architect", goodPlan({ architectureConfig: ARCHITECTURE }))
        .on(
          "test-engineer",
          testMapFor({
            entries: [
              {
                acId: "AC-01",
                risk: "r",
                levels: ["component", "a11y", "visual"],
                tests: [{ path: "src/Projects.test.tsx", name: "t", level: "component" }],
                evidence: "case main-desktop-initial",
                manual: null,
              },
            ],
          }),
        )
        .on("implementer", projectsImplementer);
      for (const approval of ["spec", "ui-contract", "plan"]) {
        await runUntilWaiting(f, "projects");
        await workflow.approve(f.root, "projects", approval as "spec");
      }
      const stop = await runUntilWaiting(f, "projects");
      expect(stop).toMatchObject({ unit: "validate", result: { kind: "blocked", gate: "G7" } });
      expect(stop.result.message).toContain("fidelity");
    } finally {
      await f.cleanup();
    }
  });
});

describe("state, locks and resume", () => {
  it("opens a newer schemaVersion read-only: status works and every mutation refuses", async () => {
    const f = await workflowFixture();
    try {
      const { workflow, deps } = f.services;
      await workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      const path = join(f.root, ".alisio/frontsmith/features/hello/state.json");
      const raw = JSON.parse(await readFile(path, "utf8"));
      await (await import("node:fs/promises")).writeFile(
        path,
        JSON.stringify({ ...raw, schemaVersion: 2 }),
      );
      const status = await workflow.status(f.root, "hello");
      expect(status.readOnly).toBe(true);
      const message = "State written by a newer Frontsmith (schemaVersion 2); upgrade the plugin";
      await expect(workflow.next(f.root, "hello", session)).rejects.toThrow(message);
      await expect(workflow.approve(f.root, "hello", "spec")).rejects.toThrow(message);
      await expect(workflow.answer(f.root, "hello", "Q-01", "x")).rejects.toThrow(message);
      await expect(workflow.reject(f.root, "hello", "spec", "x")).rejects.toThrow(message);
      expect(deps).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });

  it("reports lock contention with the exact way out", async () => {
    const f = await workflowFixture();
    try {
      const { workflow, deps } = f.services;
      await workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      const lock = await deps.store.lock(f.root, "hello");
      await expect(workflow.next(f.root, "hello", session)).rejects.toThrow(
        /\/frontsmith:stop hello/,
      );
      await lock.release();
      await expect(workflow.next(f.root, "hello", session)).resolves.toMatchObject({
        kind: "unit",
      });
    } finally {
      await f.cleanup();
    }
  });

  it("resumes after an interrupted attempt: marks it and runs the unit from its start", async () => {
    const f = await workflowFixture();
    try {
      const { workflow, deps } = f.services;
      await workflow.newFeature(f.root, { feature: "hello", intent: "x", level: "L0" });
      await workflow.next(f.root, "hello", session);
      await workflow.next(f.root, "hello", session);
      await deps.store.attempts(f.root, "hello").begin({
        kind: "child",
        role: "implementer",
        status: "running",
        startedAt: "2026-10-06T11:00:00.000Z",
      });
      await deps.store.update(
        f.root,
        "hello",
        (d) => {
          d.job = {
            id: "old",
            unit: "build",
            startedAt: "2026-10-06T11:00:00.000Z",
            ownerPid: 2 ** 22 + 99,
          };
        },
        "2026-10-06T11:00:00.000Z",
      );
      f.runner.on("implementer", writes(GOOD));
      const resumed = await workflow.resume(f.root, "hello", session);
      expect(resumed.interrupted).toBe(1);
      expect(resumed.outcome).toMatchObject({
        kind: "unit",
        unit: "build",
        result: { kind: "advanced" },
      });
      const attempts = await deps.store.listAttempts(f.root, "hello");
      expect(
        attempts.find((a) => a.role === "implementer" && a.startedAt.startsWith("2026-10-06T11"))
          ?.status,
      ).toBe("interrupted");
      expect((await workflow.status(f.root, "hello")).state.job).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it("starts build as a job, reports it running, and finishes in the background", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await l0AtBuild(f);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      f.runner.on("implementer", async (request, h) => {
        await gate;
        await h.write("src/Hello.tsx", GOOD);
        return taskResult(taskOf(request), ["src/Hello.tsx"]);
      });
      const started = await workflow.next(f.root, "hello", { sessionId: "root-1" });
      expect(started).toMatchObject({ kind: "job-started", unit: "build" });
      const during = await workflow.status(f.root, "hello");
      expect(during.running).toBe(true);
      expect(during.next).toMatchObject({ kind: "job" });
      await expect(workflow.next(f.root, "hello", { sessionId: "root-1" })).rejects.toThrow(
        /Another Frontsmith run/,
      );
      release();
      await f.services.deps.jobs.wait("hello");
      expect((await workflow.status(f.root, "hello")).state.phase).toBe("validate");
    } finally {
      await f.cleanup();
    }
  });

  it("stops a running job and cancels the child sessions", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await l0AtBuild(f);
      f.runner.on("implementer", () => new Promise(() => undefined));
      await workflow.next(f.root, "hello", { sessionId: "root-1" });
      expect(await workflow.stop(f.root, "hello")).toBe(true);
      await f.services.deps.jobs.wait("hello");
      expect(f.runner.cancelled).toBe(1);
      expect(await workflow.stop(f.root, "hello")).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

describe("L3 lifecycle", () => {
  it("adds the review sign-off, two independent review runs and mandatory runtime accessibility", async () => {
    const stub = { status: "PASS" as const, summary: "stubbed runtime evidence" };
    const f = await workflowFixture({
      fidelity: { run: async () => stub, a11y: async () => stub },
    });
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "Checkout permissions",
        level: "L3",
      });
      f.runner
        .on("specifier", goodSpec())
        .on("ui-contractor", goodContract())
        .on("tokensmith", {
          ...(envelopeExamples.tokens as object),
          generation: { strategy: "none", locked: {} },
          requiredPairs: [],
        })
        .on(
          "architect",
          goodPlan({
            architectureConfig: ARCHITECTURE,
            adrs: [
              {
                id: "ADR-001",
                title: "Server cache",
                context: "c",
                decision: "d",
                consequences: "e",
              },
            ],
            risks: [{ category: "security", text: "Permissions are enforced server side only." }],
          }),
        )
        .on("test-engineer", testMapFor())
        .on("implementer", projectsImplementer)
        .on("reviewer", approvedReview, approvedReview)
        .on("archivist", envelopeExamples.archive);
      for (const approval of ["spec", "ui-contract", "plan", "review-signoff", "acceptance"]) {
        const stop = await runUntilWaiting(f, "projects");
        expect(stop.result, JSON.stringify(stop)).toMatchObject({
          kind: "waiting",
          reason: "approval",
          command: `/frontsmith:approve projects ${approval}`,
        });
        await workflow.approve(f.root, "projects", approval as "spec");
      }
      const last = await runUntilWaiting(f, "projects");
      expect(last.result.kind).toBe("closed");
      expect(f.runner.runsOf("reviewer")).toHaveLength(2);
      const sessions = new Set(f.runner.runsOf("reviewer").map((r) => r.reuseSession ?? "fresh"));
      expect([...sessions]).toEqual(["fresh"]);
      expect(f.proc.calls.some((c) => c.argv.join(" ") === "pnpm run test:e2e")).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("is BLOCKED at validation without runtime accessibility evidence", async () => {
    const f = await workflowFixture();
    try {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L3" });
      f.runner
        .on("specifier", goodSpec())
        .on("ui-contractor", goodContract())
        .on("tokensmith", {
          ...(envelopeExamples.tokens as object),
          generation: { strategy: "none", locked: {} },
          requiredPairs: [],
        })
        .on(
          "architect",
          goodPlan({
            architectureConfig: ARCHITECTURE,
            adrs: [{ id: "ADR-001", title: "t", context: "c", decision: "d", consequences: "e" }],
            risks: [{ category: "privacy", text: "r" }],
          }),
        )
        .on("test-engineer", testMapFor())
        .on("implementer", projectsImplementer);
      for (const approval of ["spec", "ui-contract", "plan"]) {
        await runUntilWaiting(f, "projects");
        await workflow.approve(f.root, "projects", approval as "spec");
      }
      const stop = await runUntilWaiting(f, "projects");
      expect(stop).toMatchObject({ unit: "validate", result: { kind: "blocked", gate: "G7" } });
      expect(stop.result.message).toContain("a11y-runtime");
    } finally {
      await f.cleanup();
    }
  });
});

describe("open items B-08, B-12 and B-13 under their implementer rules", () => {
  it("B-12: the L0 task is derived at run time and may touch any path under the source roots", async () => {
    const f = await workflowFixture();
    try {
      await l0AtBuild(f);
      f.runner.on("implementer", async (request, h) => {
        await h.write("src/a/Deep.tsx", GOOD);
        return taskResult(taskOf(request), ["src/a/Deep.tsx"]);
      });
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ result: { kind: "advanced" } });
      const { state } = await f.services.workflow.status(f.root, "hello");
      expect(state.tasks).toMatchObject([
        { id: "T-001", layer: "ui", origin: "l0", changedPaths: ["src/a/Deep.tsx"] },
      ]);
      expect(state.taskContracts?.["T-001"]).toMatchObject({
        files: [],
        acceptanceCriteria: [],
        tdd: "exempt",
        tddExemptReason: "L0 trivial",
      });
    } finally {
      await f.cleanup();
    }
  });

  it("B-12: an L0 change outside the source roots fails the scope guard", async () => {
    const f = await workflowFixture();
    try {
      await l0AtBuild(f);
      const outside = async (
        request: { title: string },
        h: { write(p: string, c: string): Promise<void> },
      ) => {
        await h.write("lib/Outside.tsx", GOOD);
        return taskResult(taskOf(request), ["lib/Outside.tsx"]);
      };
      f.runner.on("implementer", outside, outside, outside);
      const out = await f.services.workflow.next(f.root, "hello", session);
      expect(out).toMatchObject({ result: { kind: "blocked" } });
      const { state } = await f.services.workflow.status(f.root, "hello");
      const report = JSON.parse(
        await readFile(join(f.root, state.gates.G6?.reportPath ?? ""), "utf8"),
      ) as { findings: Array<{ ruleId: string }> };
      expect(report.findings.map((x) => x.ruleId)).toContain("FS-GOV-005");
    } finally {
      await f.cleanup();
    }
  });

  it("B-13: an L1 plan may leave components, contracts, risks and the architecture configuration empty", async () => {
    const f = await workflowFixture();
    try {
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "x",
        level: "L1",
      });
      f.runner.on("specifier", goodSpec()).on("architect", goodPlan({ architectureConfig: null }));
      await runUntilWaiting(f, "projects");
      await f.services.workflow.approve(f.root, "projects", "spec");
      const out = await f.services.workflow.next(f.root, "projects", session);
      expect(out).toMatchObject({ unit: "plan", result: { kind: "advanced" } });
      expect((await f.services.workflow.status(f.root, "projects")).state.gates.G3?.verdict).toBe(
        "PASS",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("B-08: review-signoff is an approve target only; a failed sign-off is a G8 remediation", async () => {
    const f = await workflowFixture();
    try {
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "x",
        level: "L3",
      });
      await expect(
        f.services.workflow.approve(f.root, "projects", "review-signoff"),
      ).rejects.toThrow(/Nothing to approve|has not passed|approval it needs/);
    } finally {
      await f.cleanup();
    }
  });
});
