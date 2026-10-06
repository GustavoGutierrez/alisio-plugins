import { describe, expect, it } from "vitest";
import { toolResult } from "../src/interface/presenters/tool-result.js";

describe("ToolResultPresenter order", () => {
  it("puts the text summary first, then the primary block, the primary image and secondary blocks", () => {
    const result = toolResult({
      summary: "done",
      primary: { kind: "key-value", entries: [["a", "b"]] },
      image: { mimeType: "image/png", data: "AAAA" },
      secondary: [
        { kind: "json", value: { a: 1 } },
        { kind: "table", columns: ["x"], rows: [["1"]] },
      ],
    });
    expect(
      result.content.map((part) => (part.type === "ui" ? `ui:${part.block.kind}` : part.type)),
    ).toEqual(["text", "ui:key-value", "image", "ui:json", "ui:table"]);
    expect(result.isError).toBeUndefined();
  });

  it("marks errors and works with only a summary", () => {
    expect(toolResult({ summary: "bad", isError: true })).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskQuestionsRequest, PluginAPI, ToolResult } from "@alisio/sdk";
import { registerFrontsmith } from "../src/index.js";
import { compose } from "../src/interface/composition.js";
import { askQuestions, interactionLabel } from "../src/interface/presenters/interaction.js";
import { capOutput, MAX_MARKDOWN } from "../src/interface/presenters/markdown.js";
import { StatusPresenter } from "../src/interface/presenters/status.js";
import { createHarness } from "./helpers/harness.js";
import { ARCHITECTURE, NOW, PROJECT_FILES, workflowFixture } from "./helpers/workflow.js";
import { tempWorkspace } from "./helpers/workspace.js";

describe("InteractionPresenter", () => {
  const questions = [
    { id: "q", header: "H", question: "Q?", options: [{ value: "a", label: "A" }] },
  ];

  it("labels every interaction with the feature and always passes the session", async () => {
    const seen: AskQuestionsRequest[] = [];
    const api = {
      ui: {
        interactive: () => true,
        askQuestions: async (request: AskQuestionsRequest) => {
          seen.push(request);
          return { q: "a" };
        },
      },
    } as unknown as PluginAPI;
    expect(interactionLabel("login")).toBe("Frontsmith › login");
    const answer = await askQuestions(api, { scope: "login", session: "s-1", questions });
    expect(answer).toEqual({ q: "a" });
    expect(seen[0]).toMatchObject({ session: "s-1", label: "Frontsmith › login" });
  });

  it("returns undefined without asking when no interactive UI is bound", async () => {
    let asked = 0;
    const api = {
      ui: {
        interactive: () => false,
        askQuestions: async () => {
          asked += 1;
          return {};
        },
      },
    } as unknown as PluginAPI;
    expect(await askQuestions(api, { scope: "x", session: "s", questions })).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("limits a request to 4 questions with at most 4 options each", async () => {
    const api = {
      ui: { interactive: () => true, askQuestions: async () => ({}) },
    } as unknown as PluginAPI;
    const many = Array.from({ length: 5 }, (_, i) => ({ ...questions[0]!, id: `q${i}` }));
    await expect(askQuestions(api, { scope: "x", session: "s", questions: many })).rejects.toThrow(
      /at most 4 questions/,
    );
    const options = Array.from({ length: 5 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    await expect(
      askQuestions(api, { scope: "x", session: "s", questions: [{ ...questions[0]!, options }] }),
    ).rejects.toThrow(/at most 4 options/);
  });
});

describe("StatusPresenter", () => {
  it("sets the phase and job keys and clears both when idle", () => {
    const calls: Array<[string, string | undefined]> = [];
    const presenter = new StatusPresenter((key, text) => void calls.push([key, text]));
    presenter.phase("login", "build", "T-001");
    presenter.job("job-1", 1, 3);
    presenter.idle();
    expect(calls).toEqual([
      ["phase", "login build T-001"],
      ["job", "job-1 1/3"],
      ["phase", undefined],
      ["job", undefined],
    ]);
  });

  it("never throws when the host status call fails", () => {
    const presenter = new StatusPresenter(() => {
      throw new Error("no ui");
    });
    expect(() => presenter.phase("a", "b", "c")).not.toThrow();
    expect(() => presenter.idle()).not.toThrow();
  });
});

describe("MarkdownPresenter portability", () => {
  it("caps output at 12000 characters and names where the full report lives", () => {
    const long = "x".repeat(20_000);
    const capped = capOutput(long, "Full report: docs/frontsmith/f/reports/G7.json.");
    expect(capped.length).toBeLessThanOrEqual(MAX_MARKDOWN);
    expect(capped).toContain("docs/frontsmith/f/reports/G7.json");
    expect(capOutput("short", "note")).toBe("short");
  });

  it("emits no HTML, images or data URIs from the browsing commands", async () => {
    const f = await workflowFixture();
    try {
      const harness = createHarness(() => f.root);
      registerFrontsmith(harness.api);
      await f.services.workflow.newFeature(f.root, {
        feature: "login",
        intent: "Login",
        level: "L1",
      });
      const outputs = [
        await harness.callCommand("status", "", "s"),
        await harness.callCommand("status", "login", "s"),
        await harness.callCommand("rules", "list", "s"),
        await harness.callCommand("models", "", "s"),
        await harness.callCommand("doctor", "", "s"),
      ];
      for (const out of outputs) {
        expect(out.length).toBeLessThanOrEqual(MAX_MARKDOWN);
        expect(out).not.toMatch(/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i);
        expect(out).not.toMatch(/!\[[^\]]*\]\(/);
        expect(out).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+;base64/i);
      }
    } finally {
      await f.cleanup();
    }
  });
});

const kinds = (result: ToolResult): string[] =>
  result.content.map((part) => (part.type === "ui" ? `ui:${part.block.kind}` : part.type));

describe("primary block per tool (spec 18.3)", () => {
  it("returns text, then the primary block, for the read tools", async () => {
    const f = await workflowFixture({ files: PROJECT_FILES });
    try {
      const harness = createHarness(() => f.root);
      registerFrontsmith(harness.api);
      await f.services.workflow.newFeature(f.root, {
        feature: "login",
        intent: "Login",
        level: "L1",
      });
      const first = async (tool: string, input: Record<string, unknown>): Promise<string[]> =>
        kinds(await harness.callTool(tool, input, f.root));
      expect((await first("fs_status", { feature: "login" })).slice(0, 2)).toEqual([
        "text",
        "ui:progress",
      ]);
      expect(await first("fs_status", { feature: "login" })).toEqual([
        "text",
        "ui:progress",
        "ui:mermaid",
        "ui:table",
      ]);
      expect((await first("fs_detect_stack", {})).slice(0, 2)).toEqual(["text", "ui:key-value"]);
      expect((await first("fs_inventory", {})).slice(0, 2)).toEqual(["text", "ui:table"]);
      expect((await first("fs_rules_list", {})).slice(0, 2)).toEqual(["text", "ui:table"]);
      expect((await first("fs_models", {})).slice(0, 2)).toEqual(["text", "ui:table"]);
      expect(
        (
          await first("fs_contrast", {
            pairs: [{ fg: "#000000", bg: "#ffffff", kind: "normal_text" }],
          })
        ).slice(0, 2),
      ).toEqual(["text", "ui:table"]);
      expect((await first("fs_gate_run", { feature: "login", gate: "G0" })).slice(0, 2)).toEqual([
        "text",
        "ui:test-results",
      ]);
      expect((await first("fs_rules_check", {})).slice(0, 2)).toEqual(["text", "ui:test-results"]);
      await mkdir(join(f.root, ".frontsmith"), { recursive: true });
      await writeFile(join(f.root, ".frontsmith/architecture.json"), JSON.stringify(ARCHITECTURE));
      expect((await first("fs_architecture_check", {})).slice(0, 2)).toEqual([
        "text",
        "ui:test-results",
      ]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("headless fallbacks", () => {
  it("every interactive path answers with the exact command when no UI can ask", async () => {
    const f = await workflowFixture();
    try {
      const harness = createHarness(() => f.root); // interactive() is false
      registerFrontsmith(harness.api);
      await f.services.workflow.newFeature(f.root, {
        feature: "login",
        intent: "Login",
        level: "L1",
      });
      expect(await harness.callCommand("approve", "login spec", "s")).toContain(
        "/frontsmith:approve login spec",
      );
      expect(await harness.callCommand("new", "other -- Do it", "s")).toContain("/frontsmith:new");
      expect(await harness.callCommand("models", "pick", "s")).toContain("/frontsmith:models set");
      expect(await harness.callCommand("tokens", "generate --family blue", "s")).toContain(
        "--confirm WRITE",
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("frontsmith-state view", () => {
  it("is registered fail-open and returns the feature list or one status", async () => {
    const f = await workflowFixture();
    try {
      const harness = createHarness(() => f.root);
      const views: Array<{
        id: string;
        handler: (p: Record<string, unknown>, c: unknown) => unknown;
      }> = [];
      (harness.api as unknown as { views: unknown }).views = {
        register: (view: (typeof views)[number]) => {
          views.push(view);
          return () => undefined;
        },
      };
      registerFrontsmith(harness.api);
      await f.services.workflow.newFeature(f.root, {
        feature: "login",
        intent: "Login",
        level: "L1",
      });
      expect(views.map((v) => v.id)).toEqual(["frontsmith-state"]);
      const ctx = { sessionId: "s", workspace: f.root, signal: new AbortController().signal };
      const view = views[0]!;
      const all = (await view.handler({}, ctx)) as { features: Array<{ feature: string }> };
      expect(all.features.map((x) => x.feature)).toEqual(["login"]);
      const one = (await view.handler({ feature: "login" }, ctx)) as { state: { phase: string } };
      expect(one.state.phase).toBe("intake");
    } finally {
      await f.cleanup();
    }
  });

  it("registers nothing and does not throw on a host without views", () => {
    const harness = createHarness();
    expect(() => registerFrontsmith(harness.api)).not.toThrow();
  });

  it("does not throw when the host rejects the registration", () => {
    const harness = createHarness();
    (harness.api as unknown as { views: unknown }).views = {
      register: () => {
        throw new Error("duplicate view");
      },
    };
    expect(() => registerFrontsmith(harness.api)).not.toThrow();
  });
});

describe("/frontsmith:dashboard", () => {
  it("prints the loopback URL once per workspace and stops with dispose", async () => {
    const f = await workflowFixture();
    try {
      const harness = createHarness(() => f.root);
      const handle = registerFrontsmith(harness.api);
      await f.services.workflow.newFeature(f.root, {
        feature: "login",
        intent: "Login",
        level: "L1",
      });
      const first = await harness.callCommand("dashboard", "login", "s");
      expect(first).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}#login/);
      expect(first).toContain("only reachable from the machine running Alisio");
      const second = await harness.callCommand("dashboard", "", "s");
      expect(second).toContain("already running");
      expect(second).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?token=/);
      expect(await harness.callCommand("dashboard", "Bad_Name", "s")).toContain("Usage");
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(first)?.[0] as string;
      await handle.dispose();
      await expect(fetch(`${url}/api/state`)).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });

  it("explains when the dashboard is disabled in the configuration", async () => {
    const ws = await tempWorkspace({
      ".frontsmith/config.json": JSON.stringify({
        schemaVersion: 1,
        dashboard: { enabled: false },
      }),
    });
    try {
      const harness = createHarness(() => ws.root);
      registerFrontsmith(harness.api);
      expect(await harness.callCommand("dashboard", "", "s")).toContain("disabled");
    } finally {
      await ws.cleanup();
    }
  });
});

describe("ui.status wiring", () => {
  it("shows the running unit while it runs and clears both lines when it settles", async () => {
    const f = await workflowFixture();
    try {
      const lines: Array<[string, string | undefined]> = [];
      const harness = createHarness(() => f.root, {
        status: (key: string, text: string | undefined) => void lines.push([key, text]),
      });
      const composition = compose({
        clock: { now: () => new Date(NOW) },
        runner: f.runner,
        process: f.proc,
      });
      registerFrontsmith(harness.api, { composition });
      const { workflow, deps } = composition.services;
      await workflow.newFeature(f.root, { feature: "login", intent: "Login", level: "L1" });
      await deps.jobs.runInline({
        root: f.root,
        feature: "login",
        unit: "intake",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "ok";
        },
      });
      expect(lines[0]).toEqual(["phase", "login intake -"]);
      expect(lines.slice(-2)).toEqual([
        ["phase", undefined],
        ["job", undefined],
      ]);
    } finally {
      await f.cleanup();
    }
  });
});
