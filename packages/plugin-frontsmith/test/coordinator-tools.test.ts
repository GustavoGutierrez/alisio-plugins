import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskQuestionsRequest, ToolResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { pluginFixture } from "./helpers/plugin.js";
import { goodPlan, goodSpec } from "./helpers/workflow.js";

type Fixture = Awaited<ReturnType<typeof pluginFixture>>;
const textOf = (result: ToolResult): string => {
  const part = result.content[0];
  return part && part.type === "text" ? part.text : "";
};
const blockKinds = (result: ToolResult): string[] =>
  result.content.flatMap((c) => (c.type === "ui" ? [c.block.kind] : []));

const QUESTION = {
  id: "Q-01",
  question: "Which projects are listed?",
  blocking: true,
  options: ["mine", "all"],
  recommendation: "mine",
};

/** Drive a feature to the specify wait through the application, as a coordinator would. */
async function toSpecWait(fx: Fixture, spec: Record<string, unknown>, level: "L1" | "L2" = "L1") {
  const { workflow } = fx.composition.services;
  await workflow.newFeature(fx.f.root, { feature: "projects", intent: "x", level });
  fx.f.runner.on("specifier", spec);
  for (let i = 0; i < 3; i += 1) await workflow.advance(fx.f.root, "projects", { sessionId: "s1" });
  await fx.composition.services.deps.jobs.wait("projects");
}

const interactive = (
  answers: (request: AskQuestionsRequest) => Record<string, string | undefined>,
) => {
  const asked: AskQuestionsRequest[] = [];
  return {
    asked,
    ui: {
      interactive: () => true,
      askQuestions: async (request: AskQuestionsRequest) => {
        asked.push(request);
        return answers(request);
      },
    },
  };
};

describe("fs_status coordinator view", () => {
  it("appends a parsable json view after the summary", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      const result = await fx.harness.callTool("fs_status", { feature: "projects" }, fx.f.root);
      const text = textOf(result);
      const match = /```json\n([\s\S]*?)\n```/.exec(text);
      expect(match).not.toBeNull();
      const view = JSON.parse(match?.[1] ?? "{}");
      expect(view).toMatchObject({
        feature: "projects",
        phase: "specify",
        next: { kind: "answer" },
        gate: { id: "G1", verdict: "BLOCKED" },
        openQuestions: [{ id: "Q-01", options: ["mine", "all"], recommendation: "mine" }],
      });
      expect(view.footer).toContain("Feature: projects (L1, build)");
      expect(blockKinds(result)[0]).toBe("progress");
      expect(fx.harness.tools.get("fs_status")?.effect).toBe("read");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("keeps the list form without a json view", async () => {
    const fx = await pluginFixture();
    try {
      const result = await fx.harness.callTool("fs_status", {}, fx.f.root);
      expect(textOf(result)).not.toContain("```json");
    } finally {
      await fx.f.cleanup();
    }
  });
});

describe("fs_feature_new", () => {
  const FILES = {
    "specs/p.md": "# Projects\n\nList them.\n",
    "specs/s.json": JSON.stringify(goodSpec()),
  };

  it("is a write tool whose paths() names the spec file", async () => {
    const fx = await pluginFixture();
    try {
      const tool = fx.harness.tools.get("fs_feature_new");
      expect(tool?.effect).toBe("write");
      expect(tool?.paths?.({ feature: "a", fromSpec: "specs/p.md" })).toEqual(["specs/p.md"]);
      expect(tool?.paths?.({ feature: "a", intent: "x" })).toEqual([]);
    } finally {
      await fx.f.cleanup();
    }
  });

  it("validates its input", async () => {
    const fx = await pluginFixture({ files: FILES });
    try {
      const call = (input: Record<string, unknown>) =>
        fx.harness.callTool("fs_feature_new", input, fx.f.root, { session: "s1" });
      expect((await call({ feature: "projects" })).isError).toBe(true);
      expect((await call({ feature: "Bad_Name", intent: "x" })).isError).toBe(true);
      expect((await call({ feature: "projects", intent: "x", extra: 1 })).isError).toBe(true);
      expect((await call({ feature: "projects", intent: "x", level: "L9" })).isError).toBe(true);
      expect(
        textOf(await call({ feature: "projects", fromSpec: "specs/p.md", level: "L0" })),
      ).toContain("SRC-008");
      expect(textOf(await call({ feature: "projects", fromSpec: "../p.md" }))).toContain("SRC-001");
      expect(textOf(await call({ feature: "projects", intent: "x".repeat(4001) }))).toContain(
        "4000",
      );
    } finally {
      await fx.f.cleanup();
    }
  });

  it("headless creates nothing and returns the exact command", async () => {
    const fx = await pluginFixture({ files: FILES });
    try {
      const result = await fx.harness.callTool(
        "fs_feature_new",
        { feature: "projects", fromSpec: "specs/p.md", level: "L2", mode: "refine" },
        fx.f.root,
        { session: "s1" },
      );
      expect(textOf(result)).toContain(
        "/frontsmith:new projects --level L2 --mode refine --from-spec specs/p.md",
      );
      expect(textOf(result)).toContain("nothing was created");
      expect(await fx.composition.services.workflow.list(fx.f.root)).toHaveLength(0);
    } finally {
      await fx.f.cleanup();
    }
  });

  it("interactive: the level the person picks wins over the proposal", async () => {
    const io = interactive(() => ({ level: "L3" }));
    const fx = await pluginFixture({ files: FILES, ui: io.ui });
    try {
      const result = await fx.harness.callTool(
        "fs_feature_new",
        { feature: "projects", fromSpec: "specs/p.md", level: "L1" },
        fx.f.root,
        { session: "s1" },
      );
      expect(textOf(result)).toContain("Created `projects` (L3, build)");
      expect(io.asked[0]).toMatchObject({ session: "s1", label: "Frontsmith › projects" });
      const question = io.asked[0]?.questions[0];
      expect(question?.options.map((o) => o.value)).toEqual(["L1", "L2", "L3"]);
      expect(question?.options.filter((o) => o.recommended).map((o) => o.value)).toEqual(["L1"]);
      expect(question?.question).toContain("projects");
      expect(question?.question).toContain("specs/p.md");
      expect(question?.question).toMatch(/sha256 [0-9a-f]{12}/);
      const state = (await fx.composition.services.workflow.status(fx.f.root, "projects")).state;
      expect(state.source?.path).toBe("specs/p.md");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("interactive: skipping cancels and without a source L0 is offered", async () => {
    const skip = interactive(() => ({}));
    const fx = await pluginFixture({ files: FILES, ui: skip.ui });
    try {
      const result = await fx.harness.callTool(
        "fs_feature_new",
        { feature: "projects", intent: "Add a link" },
        fx.f.root,
        { session: "s1" },
      );
      expect(textOf(result)).toContain("nothing was created");
      expect(skip.asked[0]?.questions[0]?.options.map((o) => o.value)).toEqual([
        "L0",
        "L1",
        "L2",
        "L3",
      ]);
      expect(await fx.composition.services.workflow.list(fx.f.root)).toHaveLength(0);
    } finally {
      await fx.f.cleanup();
    }
  });
});

describe("fs_next", () => {
  it("waits for the person at a gate and runs nothing", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      const runs = fx.f.runner.requests.length;
      const result = await fx.harness.callTool("fs_next", { feature: "projects" }, fx.f.root, {
        session: "s1",
      });
      expect(textOf(result)).toContain("waiting for the person");
      expect(textOf(result)).toContain("/frontsmith:answer projects Q-01");
      expect(fx.f.runner.requests).toHaveLength(runs);
      expect(blockKinds(result)[0]).toBe("progress");
      expect(fx.harness.tools.get("fs_next")?.effect).toBe("process");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("starts a child unit as a job and queues a code-only notice when it ends", async () => {
    const queued: Array<[string, string]> = [];
    const fx = await pluginFixture({
      sessions: { enqueue: (id: string, text: string) => void queued.push([id, text]) },
    });
    try {
      const { workflow } = fx.composition.services;
      await workflow.newFeature(fx.f.root, { feature: "projects", intent: "x", level: "L1" });
      fx.f.runner.on("specifier", goodSpec());
      const call = () =>
        fx.harness.callTool("fs_next", { feature: "projects" }, fx.f.root, { session: "s1" });
      expect(textOf(await call())).toContain("intake");
      expect(textOf(await call())).toContain("context");
      const started = await call();
      expect(textOf(started)).toContain("Started job");
      expect(textOf(started)).toContain("specify");
      await fx.composition.services.deps.jobs.wait("projects");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.[0]).toBe("s1");
      expect(queued[0]?.[1]).toMatch(
        /^\[Frontsmith\] Job \S+ \(specify\) of projects finished: waiting\. Next: \/frontsmith:approve projects spec$/,
      );
    } finally {
      await fx.f.cleanup();
    }
  });

  it("is fail-open when enqueue is absent or throws", async () => {
    for (const sessions of [
      {},
      {
        enqueue: () => {
          throw new Error("no");
        },
      },
    ]) {
      const fx = await pluginFixture({ sessions });
      try {
        const { workflow } = fx.composition.services;
        await workflow.newFeature(fx.f.root, { feature: "projects", intent: "x", level: "L1" });
        fx.f.runner.on("specifier", goodSpec());
        for (let i = 0; i < 3; i += 1)
          await fx.harness.callTool("fs_next", { feature: "projects" }, fx.f.root, {
            session: "s1",
          });
        await fx.composition.services.deps.jobs.wait("projects");
        expect((await workflow.status(fx.f.root, "projects")).state.job).toBeUndefined();
      } finally {
        await fx.f.cleanup();
      }
    }
  });

  it("validates its input and reports a live job", async () => {
    const fx = await pluginFixture();
    try {
      expect((await fx.harness.callTool("fs_next", {}, fx.f.root)).isError).toBe(true);
      expect(
        (await fx.harness.callTool("fs_next", { feature: "projects", x: 1 }, fx.f.root)).isError,
      ).toBe(true);
      expect((await fx.harness.callTool("fs_next", { feature: "ghost" }, fx.f.root)).isError).toBe(
        true,
      );
    } finally {
      await fx.f.cleanup();
    }
  });
});

describe("fs_answer", () => {
  const call = (fx: Fixture, input: Record<string, unknown>) =>
    fx.harness.callTool(
      "fs_answer",
      { feature: "projects", questionId: "Q-01", ...input },
      fx.f.root,
      {
        session: "s1",
      },
    );
  const stateOf = async (fx: Fixture) =>
    (await fx.composition.services.workflow.status(fx.f.root, "projects")).state;

  it("records an option pick verbatim with dialog provenance", async () => {
    const io = interactive(() => ({ answer: "opt-1" }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      const result = await call(fx, {});
      expect(textOf(result)).toContain("Recorded Q-01");
      const q = (await stateOf(fx)).questions[0];
      expect(q).toMatchObject({ answer: "all", answeredVia: "dialog" });
      const question = io.asked[0]?.questions[0];
      expect(question?.question).toContain("Which projects are listed?");
      expect(question?.options.map((o) => o.label)).toEqual(["mine", "all", "Other"]);
      expect(question?.options.filter((o) => o.recommended)).toHaveLength(1);
      expect(question?.options[2]?.textInput).toBeDefined();
    } finally {
      await fx.f.cleanup();
    }
  });

  it("records the Other text from the <id>:text key", async () => {
    const io = interactive(() => ({ answer: "other", "answer:text": "Only archived ones." }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      await call(fx, {});
      expect((await stateOf(fx)).questions[0]?.answer).toBe("Only archived ones.");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("an answer relayed by the model is recorded only after Record, quoted exactly", async () => {
    let choice = "no";
    const io = interactive(() => ({ confirm: choice }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      const declined = await call(fx, { answer: "Mine, but only active." });
      expect(textOf(declined)).toContain("Nothing was recorded");
      expect((await stateOf(fx)).questions[0]?.answer).toBeUndefined();
      expect(io.asked[0]?.questions[0]?.question).toContain("Mine, but only active.");
      choice = "record";
      const done = await call(fx, { answer: "Mine, but only active." });
      expect(textOf(done)).toContain("Recorded Q-01");
      expect((await stateOf(fx)).questions[0]).toMatchObject({
        answer: "Mine, but only active.",
        answeredVia: "dialog",
      });
      const again = await call(fx, { answer: "Changed" });
      expect(again.isError).toBe(true);
      expect(textOf(again)).toContain("already answered");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("headless records nothing and returns the exact command", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      const result = await call(fx, { answer: "Mine" });
      expect(textOf(result)).toContain("/frontsmith:answer projects Q-01 -- Mine");
      expect(textOf(result)).toContain("Nothing was recorded");
      expect((await stateOf(fx)).questions[0]?.answer).toBeUndefined();
    } finally {
      await fx.f.cleanup();
    }
  });

  it("refuses unknown questions and bad input", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec({ openQuestions: [QUESTION] }));
      expect((await call(fx, { questionId: "Q-09", answer: "x" })).isError).toBe(true);
      expect((await call(fx, { questionId: "q1", answer: "x" })).isError).toBe(true);
      expect((await call(fx, { answer: "x", extra: 1 })).isError).toBe(true);
      expect((await call(fx, { answer: "" })).isError).toBe(true);
      expect(fx.harness.tools.get("fs_answer")?.effect).toBe("write");
    } finally {
      await fx.f.cleanup();
    }
  });
});

describe("fs_approval_request", () => {
  const call = (fx: Fixture, input: Record<string, unknown>) =>
    fx.harness.callTool("fs_approval_request", { feature: "projects", ...input }, fx.f.root, {
      session: "s1",
    });
  const stateOf = async (fx: Fixture) =>
    (await fx.composition.services.workflow.status(fx.f.root, "projects")).state;

  it("is a write tool and refuses what is not owed, config and bad input", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec());
      expect(fx.harness.tools.get("fs_approval_request")?.effect).toBe("write");
      const plan = await call(fx, { target: "plan" });
      expect(plan.isError).toBe(true);
      expect(textOf(plan)).toContain("spec");
      const config = await call(fx, { target: "config" });
      expect(config.isError).toBe(true);
      expect(textOf(config)).toContain("/frontsmith:approve projects config");
      expect((await call(fx, { target: "nope" })).isError).toBe(true);
      expect((await call(fx, { target: "spec", extra: 1 })).isError).toBe(true);
      expect((await stateOf(fx)).approvals.spec).toBeUndefined();
    } finally {
      await fx.f.cleanup();
    }
  });

  it("approve records the approval only after the click", async () => {
    const io = interactive(() => ({ decision: "approve" }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec());
      const result = await call(fx, { target: "spec" });
      expect(textOf(result)).toContain("Approved spec");
      expect((await stateOf(fx)).approvals.spec).toMatchObject({ by: "human" });
      const asked = io.asked[0];
      expect(asked).toMatchObject({ session: "s1", label: "Frontsmith › projects" });
      expect(asked?.questions[0]?.question).toContain("G1");
      expect(asked?.questions[0]?.question).toContain("docs/frontsmith/projects/spec.md");
    } finally {
      await fx.f.cleanup();
    }
  });

  it("reject with comments records the rejection and quotes the comments in the dialog", async () => {
    const io = interactive(() => ({ decision: "reject" }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec());
      const result = await call(fx, { target: "spec", comments: "Add an offline state." });
      expect(textOf(result)).toContain("Rejected spec");
      const state = await stateOf(fx);
      expect(state.feedback?.spec).toEqual(["Add an offline state."]);
      expect(state.approvals.spec).toBeUndefined();
      const question = io.asked[0]?.questions[0];
      expect(question?.question).toContain("Add an offline state.");
      expect(question?.options.find((o) => o.value === "reject")?.description).toContain(
        "comments shown below",
      );
    } finally {
      await fx.f.cleanup();
    }
  });

  it("reject without comments, details and a skipped dialog record nothing", async () => {
    for (const [decision, expected] of [
      ["reject", "/frontsmith:reject projects spec -- <comments>"],
      ["details", "docs/frontsmith/projects"],
      [undefined, "/frontsmith:approve projects spec"],
    ] as const) {
      const io = interactive(() => (decision ? { decision } : {}));
      const fx = await pluginFixture({ ui: io.ui });
      try {
        await toSpecWait(fx, goodSpec());
        const result = await call(fx, { target: "spec" });
        expect(textOf(result)).toContain(expected);
        const state = await stateOf(fx);
        expect(state.approvals.spec).toBeUndefined();
        expect(state.feedback?.spec ?? []).toEqual([]);
      } finally {
        await fx.f.cleanup();
      }
    }
  });

  it("headless returns both commands and records nothing", async () => {
    const fx = await pluginFixture();
    try {
      await toSpecWait(fx, goodSpec());
      const result = await call(fx, { target: "spec" });
      expect(textOf(result)).toContain("/frontsmith:approve projects spec");
      expect(textOf(result)).toContain("/frontsmith:reject projects spec -- <comments>");
      expect((await stateOf(fx)).approvals.spec).toBeUndefined();
    } finally {
      await fx.f.cleanup();
    }
  });

  it("a dependency must be pending in the plan", async () => {
    const io = interactive(() => ({ decision: "approve" }));
    const fx = await pluginFixture({ ui: io.ui });
    try {
      await toSpecWait(fx, goodSpec());
      const { workflow } = fx.composition.services;
      await workflow.approve(fx.f.root, "projects", "spec");
      fx.f.runner.on(
        "architect",
        goodPlan({
          dependencies: [{ name: "zod", version: "4.1.5", reason: "validate responses" }],
        }),
      );
      await workflow.advance(fx.f.root, "projects", { sessionId: "s1" });
      await fx.composition.services.deps.jobs.wait("projects");
      expect((await call(fx, { target: "dependency", name: "left-pad" })).isError).toBe(true);
      expect((await call(fx, { target: "dependency" })).isError).toBe(true);
      const ok = await call(fx, { target: "dependency", name: "zod" });
      expect(textOf(ok)).toContain("Approved dependency zod");
      expect((await stateOf(fx)).approvals.dependencies.zod).toMatchObject({ by: "human" });
    } finally {
      await fx.f.cleanup();
    }
  });
});

describe("source-backed features through the tool", () => {
  it("reads the snapshot written by fs_feature_new", async () => {
    const io = interactive(() => ({ level: "L1" }));
    const fx = await pluginFixture({ files: { "specs/p.md": "# P\n" }, ui: io.ui });
    try {
      await fx.harness.callTool(
        "fs_feature_new",
        { feature: "projects", fromSpec: "specs/p.md" },
        fx.f.root,
        {
          session: "s1",
        },
      );
      expect(
        await readFile(join(fx.f.root, "docs/frontsmith/projects/source-spec.md"), "utf8"),
      ).toBe("# P\n");
      const view = await fx.composition.services.workflow.view(fx.f.root, "projects");
      expect(view.source).toMatchObject({ path: "specs/p.md", format: "markdown" });
    } finally {
      await fx.f.cleanup();
    }
  });
});
