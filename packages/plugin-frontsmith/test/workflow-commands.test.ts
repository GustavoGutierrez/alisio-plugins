import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskQuestionsRequest } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { registerFrontsmith } from "../src/index.js";
import { compose } from "../src/interface/composition.js";
import { loadAgentProfile } from "../src/resources.js";
import { cliRun } from "./helpers/cli.js";
import { createHarness } from "./helpers/harness.js";
import { goodSpec, NOW, PROJECT_FILES, workflowFixture } from "./helpers/workflow.js";
import { tempWorkspace } from "./helpers/workspace.js";

type Ui = Parameters<typeof createHarness>[1];

/** The plugin registered on a fake host over a workspace with a git baseline. */
async function pluginFixture(ui?: Ui) {
  const f = await workflowFixture();
  const harness = createHarness(() => f.root, ui);
  const composition = compose({
    clock: { now: () => new Date(NOW) },
    runner: f.runner,
    process: f.proc,
    profiles: loadAgentProfile,
    version: "0.1.0",
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
  });
  registerFrontsmith(harness.api, { composition });
  return { f, harness, composition };
}

describe("workflow commands and tools", () => {
  it("registers the fourteen workflow commands and four tools", async () => {
    const { f, harness } = await pluginFixture();
    try {
      for (const name of [
        "init",
        "doctor",
        "new",
        "status",
        "next",
        "answer",
        "approve",
        "reject",
        "waive",
        "verify-manual",
        "stop",
        "resume",
        "check",
        "budget",
      ]) {
        const command = harness.commands.get(name);
        expect(command, name).toBeDefined();
        expect(command?.options?.description?.length).toBeGreaterThan(5);
      }
      for (const name of ["fs_gate_run", "fs_phase_run", "fs_status", "fs_budget_check"])
        expect(harness.tools.has(name), name).toBe(true);
      expect(harness.tools.get("fs_status")?.effect).toBe("read");
      expect(harness.tools.get("fs_gate_run")?.effect).toBe("process");
    } finally {
      await f.cleanup();
    }
  });

  it("init writes a minimal config once and the gitignore entry", async () => {
    const { f, harness } = await pluginFixture();
    try {
      const first = await harness.callCommand("init", "", "s1");
      expect(first).toContain(".frontsmith/config.json");
      expect(JSON.parse(await readFile(join(f.root, ".frontsmith/config.json"), "utf8"))).toEqual({
        schemaVersion: 1,
      });
      expect(await readFile(join(f.root, ".gitignore"), "utf8")).toContain(".alisio/frontsmith/");
      const second = await harness.callCommand("init", "", "s1");
      expect(second).toContain("already exists");
    } finally {
      await f.cleanup();
    }
  });

  it("new without --level is a usage error when headless (B-17) and asks with the session and label when interactive", async () => {
    const asked: AskQuestionsRequest[] = [];
    const interactive = await pluginFixture({
      interactive: () => true,
      askQuestions: async (request) => {
        asked.push(request);
        return { level: "L1" };
      },
    });
    const headless = await pluginFixture();
    try {
      expect(
        await headless.harness.callCommand("new", "projects -- List projects", "s1"),
      ).toContain("Usage:");
      expect(
        await headless.harness.callCommand("new", "projects --level L9 -- List projects", "s1"),
      ).toContain("Usage:");
      expect(await headless.harness.callCommand("new", "Bad_Name --level L1 -- x", "s1")).toContain(
        "Usage:",
      );
      const out = await interactive.harness.callCommand("new", "projects -- List projects", "s1");
      expect(out).toContain("Created `projects` (L1, build)");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ session: "s1", label: "Frontsmith › projects" });
      const options = asked[0]?.questions[0]?.options ?? [];
      expect(options.map((o) => o.value)).toEqual(["L0", "L1", "L2", "L3"]);
      expect(options.filter((o) => o.recommended).map((o) => o.value)).toEqual(["L2"]);
    } finally {
      await headless.f.cleanup();
      await interactive.f.cleanup();
    }
  });

  it("status lists features, shows one with the exact next command and refuses unknown ones", async () => {
    const { f, harness } = await pluginFixture();
    try {
      expect(await harness.callCommand("status", "", "s1")).toContain("No features yet");
      await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
      expect(await harness.callCommand("status", "", "s1")).toContain("| projects | L1 | intake |");
      const one = await harness.callCommand("status", "projects", "s1");
      expect(one).toContain("## projects (L1, build)");
      expect(one).toContain("`/frontsmith:next projects`");
      expect(await harness.callCommand("status", "ghost", "s1")).toContain("Unknown feature ghost");
    } finally {
      await f.cleanup();
    }
  });

  it("next runs a unit and reports the next command; a command without a session says so", async () => {
    const { f, harness } = await pluginFixture();
    try {
      await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
      const out = await harness.callCommand("next", "projects", "s1");
      expect(out).toContain("## projects: intake");
      expect(out).toContain("`/frontsmith:next projects`");
      await expect(harness.callCommand("next", "projects")).rejects.toThrow(/No session/);
    } finally {
      await f.cleanup();
    }
  });

  it("approve returns the exact command when the session cannot ask, and approves only on an interactive yes", async () => {
    const decisions: string[] = [];
    const headless = await pluginFixture();
    const asking = await pluginFixture({
      interactive: () => true,
      askQuestions: async () => ({ decision: decisions.shift() }),
    });
    try {
      for (const { f, harness } of [headless, asking]) {
        f.runner.on("specifier", goodSpec());
        await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
        await harness.callCommand("next", "projects", "s1");
        await harness.callCommand("next", "projects", "s1");
        await harness.callCommand("next", "projects", "s1");
      }
      const refused = await headless.harness.callCommand("approve", "projects spec", "s1");
      expect(refused).toContain("`/frontsmith:approve projects spec`");
      expect(
        (await headless.composition.services.workflow.status(headless.f.root, "projects")).state
          .approvals.spec,
      ).toBeUndefined();

      decisions.push("details", "reject", undefined as never, "approve");
      expect(await asking.harness.callCommand("approve", "projects spec", "s1")).toContain(
        "Read the artifacts",
      );
      expect(await asking.harness.callCommand("approve", "projects spec", "s1")).toContain(
        "/frontsmith:reject projects spec -- <comments>",
      );
      expect(await asking.harness.callCommand("approve", "projects spec", "s1")).toContain(
        "`/frontsmith:approve projects spec`",
      );
      const approved = await asking.harness.callCommand("approve", "projects spec", "s1");
      expect(approved).toContain("Approved spec");
      expect(
        (await asking.composition.services.workflow.status(asking.f.root, "projects")).state
          .approvals.spec,
      ).toMatchObject({ by: "human" });
    } finally {
      await headless.f.cleanup();
      await asking.f.cleanup();
    }
  });

  it("reject, answer, verify-manual, waive and stop validate their arguments", async () => {
    const { f, harness, composition } = await pluginFixture();
    try {
      await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
      expect(await harness.callCommand("reject", "projects spec", "s1")).toContain("Usage:");
      // B-08: a failed review sign-off is a G8 remediation, so it is not a reject target.
      expect(await harness.callCommand("reject", "projects review-signoff -- no", "s1")).toContain(
        "Usage:",
      );
      expect(await harness.callCommand("reject", "projects spec -- redo", "s1")).toContain(
        "returns to specify",
      );
      expect(await harness.callCommand("answer", "projects Q-01", "s1")).toContain("Usage:");
      expect(
        await harness.callCommand("verify-manual", "projects AC-01 -- looked fine", "s1"),
      ).toContain("no acceptance criterion");
      expect(
        await harness.callCommand("waive", "projects FS-CSS-001 src/** --until 2999-01-01", "s1"),
      ).toContain("Usage:");
      expect(
        await harness.callCommand(
          "waive",
          "projects FS-CSS-001 src/** --until 2000-01-01 -- legacy",
          "s1",
        ),
      ).toContain("in the past");
      expect(
        await harness.callCommand(
          "waive",
          "projects nope src/** --until 2999-01-01 -- legacy",
          "s1",
        ),
      ).toContain("not a rule id");
      const ok = await harness.callCommand(
        "waive",
        "projects FS-CSS-001 src/legacy/** --until 2999-01-01 -- legacy styles",
        "s1",
      );
      expect(ok).toContain("W-001");
      const waivers = JSON.parse(await readFile(join(f.root, ".frontsmith/waivers.json"), "utf8"));
      expect(waivers.waivers[0]).toMatchObject({
        id: "W-001",
        ruleId: "FS-CSS-001",
        paths: ["src/legacy/**"],
        approvedBy: "human",
        expires: "2999-01-01",
      });
      expect(
        await harness.callCommand(
          "waive",
          "projects FS-CSS-002 src/** --until 2999-01-01 -- again",
          "s1",
        ),
      ).toContain("W-002");
      expect(await harness.callCommand("stop", "projects", "s1")).toContain("no running job");
      expect(composition).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });

  it("check runs a gate ad hoc and fs_gate_run returns test-results first, then the findings table", async () => {
    const { f, harness } = await pluginFixture();
    try {
      await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
      const text = await harness.callCommand("check", "projects G0", "s1");
      expect(text).toContain("## G0: PASS");
      expect(await harness.callCommand("check", "projects G9", "s1")).toContain("needs a spec");
      expect(await harness.callCommand("check", "projects G77", "s1")).toContain("Usage:");
      const result = await harness.callTool(
        "fs_gate_run",
        { feature: "projects", gate: "G0" },
        f.root,
        { session: "s1" },
      );
      expect(result.isError).toBeUndefined();
      const kinds = result.content.map((c) => (c.type === "ui" ? c.block.kind : c.type));
      expect(kinds).toEqual(["text", "test-results", "table"]);
      const bad = await harness.callTool(
        "fs_gate_run",
        { feature: "projects", gate: "G77" },
        f.root,
      );
      expect(bad.isError).toBe(true);
      expect(
        (
          await harness.callTool(
            "fs_gate_run",
            { feature: "projects", gate: "G0", extra: 1 },
            f.root,
          )
        ).isError,
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("fs_status leads with a progress block and fs_phase_run runs the unit in the foreground with progress", async () => {
    const { f, harness } = await pluginFixture();
    try {
      await harness.callCommand("new", "projects --level L1 -- List projects", "s1");
      const status = await harness.callTool("fs_status", { feature: "projects" }, f.root);
      expect(status.content.map((c) => (c.type === "ui" ? c.block.kind : c.type))).toEqual([
        "text",
        "progress",
        "mermaid",
        "table",
      ]);
      const list = await harness.callTool("fs_status", {}, f.root);
      expect(list.content[1]).toMatchObject({ type: "ui", block: { kind: "table" } });
      const lines: unknown[] = [];
      const run = await harness.callTool(
        "fs_phase_run",
        { feature: "projects", foreground: true },
        f.root,
        { session: "s1", emit: (d) => void lines.push(d) },
      );
      expect(run.isError).toBeUndefined();
      expect(run.content[0]).toMatchObject({ type: "text" });
      const refused = await harness.callTool(
        "fs_phase_run",
        { feature: "projects", foreground: false },
        f.root,
      );
      expect(refused.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});

describe("budgets", () => {
  it("is skipped without budgets.json, checks the bundle against it, and records a baseline", async () => {
    const { f, harness } = await pluginFixture();
    try {
      expect(await harness.callCommand("budget", "check", "s1")).toContain("no universal numbers");
      await mkdir(join(f.root, "dist/assets"), { recursive: true });
      await writeFile(join(f.root, "dist/assets/index-abc.js"), "console.log('x');\n".repeat(2000));
      await mkdir(join(f.root, ".frontsmith"), { recursive: true });
      await writeFile(
        join(f.root, ".frontsmith/budgets.json"),
        JSON.stringify({ schemaVersion: 1, bundle: { maxInitialJsGzipKb: 0.01 } }),
      );
      const failed = await harness.callCommand("budget", "check", "s1");
      expect(failed).toContain("## Budgets: FAIL");
      expect(failed).toContain("exceeds 0.01 KiB");
      await writeFile(
        join(f.root, ".frontsmith/budgets.json"),
        JSON.stringify({
          schemaVersion: 1,
          bundle: { maxInitialJsGzipKb: 100, maxDeltaGzipKb: 1 },
        }),
      );
      expect(await harness.callCommand("budget", "check", "s1")).toContain(
        "| delta | skipped | no budgets.baseline.json recorded |",
      );
      const baseline = await harness.callCommand("budget", "baseline", "s1");
      expect(baseline).toContain(".frontsmith/budgets.baseline.json");
      expect(
        JSON.parse(await readFile(join(f.root, ".frontsmith/budgets.baseline.json"), "utf8")),
      ).toMatchObject({ schemaVersion: 1, initialJsGzipBytes: expect.any(Number) });
      expect(await harness.callCommand("budget", "check", "s1")).toContain("| delta | pass |");
      const tool = await harness.callTool("fs_budget_check", {}, f.root);
      expect(tool.content.map((c) => (c.type === "ui" ? c.block.kind : c.type))).toEqual([
        "text",
        "test-results",
        "table",
      ]);
      expect(await harness.callCommand("budget", "bogus", "s1")).toContain("Usage:");
    } finally {
      await f.cleanup();
    }
  });

  it("fs_budget_check with build runs the project build command first", async () => {
    const { f, harness } = await pluginFixture();
    try {
      const out = await harness.callTool("fs_budget_check", { build: true }, f.root);
      expect(f.proc.calls.map((c) => c.argv.join(" "))).toContain("pnpm run build");
      expect(out.isError).toBeUndefined();
      f.proc.when(
        (argv) => argv.join(" ") === "pnpm run build",
        () => ({ code: 1, stdout: "boom" }),
      );
      const failed = await harness.callTool("fs_budget_check", { build: true }, f.root);
      expect(failed.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});

describe("CLI gate, budget and doctor", () => {
  it("doctor reports the environment and exits by its worst status", async () => {
    const ws = await tempWorkspace({ ...PROJECT_FILES });
    try {
      const out = await cliRun(["doctor", ws.root, "--json"]);
      const report = JSON.parse(out.stdout) as {
        schema: string;
        items: Array<{ name: string; status: string }>;
      };
      expect(report.schema).toBe("frontsmith.doctor-report/v1");
      expect(report.items.find((i) => i.name === "node")?.status).toBe("PASS");
      expect(report.items.find((i) => i.name === "git")?.status).toBe("BLOCKED");
      expect(out.code).toBe(3);
      const text = await cliRun(["doctor", ws.root]);
      expect(text.stdout).toContain("## Doctor");
    } finally {
      await ws.cleanup();
    }
  });

  it("budget exits 0 when no budgets exist and 1 when a limit is exceeded", async () => {
    const ws = await tempWorkspace({ ...PROJECT_FILES });
    try {
      expect((await cliRun(["budget", ws.root])).code).toBe(0);
      await ws.write("dist/assets/index-a.js", "x".repeat(50_000));
      await ws.write(
        ".frontsmith/budgets.json",
        JSON.stringify({ schemaVersion: 1, bundle: { maxInitialJsGzipKb: 0.001 } }),
      );
      const out = await cliRun(["budget", ws.root, "--json"]);
      expect(out.code).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({
        schema: "frontsmith.budget-report/v1",
        verdict: "FAIL",
      });
    } finally {
      await ws.cleanup();
    }
  });

  it("gate runs one gate on a feature, prints the persisted report with --json and maps verdicts to exit codes", async () => {
    const f = await workflowFixture();
    try {
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List",
        level: "L1",
      });
      const out = await cliRun(["gate", "projects", "G0", f.root, "--json"]);
      expect(out.code).toBe(0);
      const report = JSON.parse(out.stdout) as { schema: string; gate: string; verdict: string };
      expect(report).toMatchObject({
        schema: "frontsmith.gate-report/v1",
        gate: "G0",
        verdict: "PASS",
      });
      const state = (await f.services.workflow.status(f.root, "projects")).state;
      expect(await readFile(join(f.root, state.gates.G0?.reportPath ?? ""), "utf8")).toBe(
        out.stdout,
      );
      const text = await cliRun(["gate", "projects", "G0", f.root]);
      expect(text.stdout).toContain("## G0: PASS");
      expect((await cliRun(["gate", "projects", "G77", f.root])).code).toBe(2);
      expect((await cliRun(["gate", "Bad Name", "G0", f.root])).code).toBe(2);
      expect((await cliRun(["gate", "projects", "G9", f.root])).code).toBe(2);
      expect((await cliRun(["gate", "projects", "G5", f.root, "--task", "bad"])).code).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
