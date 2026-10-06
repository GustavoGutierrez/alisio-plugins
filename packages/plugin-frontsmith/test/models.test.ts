import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelsService } from "../src/application/models/service.js";
import type { ModelCatalog } from "../src/application/ports/model-catalog.js";
import { shippedAgentTiers } from "../src/domain/models/agents.js";
import { parseAgentsMd } from "../src/domain/models/agents-md.js";
import { parseModelValue } from "../src/domain/models/grammar.js";
import {
  describeModelDiagnostic,
  type ModelLayer,
  validateModelLayer,
} from "../src/domain/models/layers.js";
import { resolveModel } from "../src/domain/models/resolve.js";
import { registerFrontsmith } from "../src/index.js";
import { FsModelsRuntimeStore } from "../src/infrastructure/fs/models-runtime-store.js";
import { FsProjectStore } from "../src/infrastructure/fs/project-store.js";
import { NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { ApiModelCatalog } from "../src/infrastructure/sdk/model-catalog.js";
import { compose } from "../src/interface/composition.js";
import { cliRun } from "./helpers/cli.js";
import { createHarness } from "./helpers/harness.js";
import { tempWorkspace } from "./helpers/workspace.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const AGENTS = Object.keys(shippedAgentTiers);
const block = (lines: string, fence = "```"): string =>
  `# Project\n\n${fence}frontsmith-models\n${lines}\n${fence}\n`;

describe("value grammar", () => {
  it("accepts inherit, tier references and model selectors", () => {
    expect(parseModelValue("inherit", { tierRef: true })).toEqual({
      ok: true,
      value: { kind: "inherit" },
    });
    expect(parseModelValue("@fast", { tierRef: true })).toEqual({
      ok: true,
      value: { kind: "tier", tier: "fast" },
    });
    for (const selector of [
      "gpt-5",
      "openai/gpt-5-codex",
      "openrouter/anthropic/claude-opus-4.1",
      "ollama/llama3.1:8b",
      "a",
    ])
      expect(parseModelValue(selector, { tierRef: false })).toEqual({
        ok: true,
        value: { kind: "model", selector },
      });
  });

  it("rejects a tier reference where a tier is being bound (FSM-005) and malformed values (FSM-006)", () => {
    expect(parseModelValue("@reasoning", { tierRef: false })).toMatchObject({
      ok: false,
      code: "FSM-005",
    });
    for (const bad of [
      "",
      "@bogus",
      "-x",
      "a b",
      "a//b",
      "a/",
      "/a",
      "x".repeat(201),
      "a\u0000b",
      "model!",
    ])
      expect(parseModelValue(bad, { tierRef: true }), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: "FSM-006",
      });
    expect(parseModelValue("x".repeat(200), { tierRef: true }).ok).toBe(true);
  });
});

describe("AGENTS.md directive block", () => {
  const parse = (text: string) => parseAgentsMd(text, { knownAgents: AGENTS, sha256 });

  it("returns an empty layer when there is no block", () => {
    expect(parse("# Notes\n\nNothing here.\n")).toMatchObject({
      present: false,
      diagnostics: [],
      tiers: {},
      agents: {},
    });
  });

  it("reads tiers and agents, skipping blanks and comments", () => {
    const result = parse(
      block(
        "# comment\n\ntier.reasoning = openrouter/anthropic/claude-opus-4.1\ntier.standard  = inherit\nagent.fs-reviewer    = @reasoning\n  agent.fs-implementer = openai/gpt-5-codex  ",
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.present).toBe(true);
    expect(result.tiers).toEqual({
      reasoning: "openrouter/anthropic/claude-opus-4.1",
      standard: "inherit",
    });
    expect(result.agents).toEqual({
      "fs-reviewer": "@reasoning",
      "fs-implementer": "openai/gpt-5-codex",
    });
    expect(result.blockSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts tilde fences and CRLF and hashes only the block", () => {
    const lf = block("tier.fast = inherit", "~~~");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(parse(crlf).tiers).toEqual({ fast: "inherit" });
    const a = parse(lf);
    const b = parse(`Extra paragraph.\n\n${lf}\nMore text.\n`);
    expect(a.blockSha256).toBe(b.blockSha256);
    expect(parse(block("tier.fast = gpt-5")).blockSha256).not.toBe(
      parse(block("tier.fast = inherit")).blockSha256,
    );
  });

  it("closes a fence only with the same character at least as long as the opening", () => {
    const text = "````frontsmith-models\ntier.fast = inherit\n```\ntier.standard = inherit\n````\n";
    const result = parse(text);
    expect(result.tiers).toEqual({ fast: "inherit", standard: "inherit" });
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([["FSM-001", 3]]);
  });

  it("ignores an example block nested inside another fenced block", () => {
    const text =
      "````markdown\n```frontsmith-models\ntier.fast = inherit\n```\n````\n\n```frontsmith-models\ntier.fast = gpt-5\n```\n";
    const result = parse(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.tiers).toEqual({ fast: "gpt-5" });
  });

  it("reports FSM-002 for two blocks and applies no values", () => {
    const result = parse(`${block("tier.fast = inherit")}\n${block("tier.standard = inherit")}`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["FSM-002"]);
    expect(result.tiers).toEqual({});
  });

  it("reports FSM-001 with the line number of a malformed line, including an effort line", () => {
    const text =
      "# Project\n\n```frontsmith-models\ntier.fast = inherit\nthis is not a directive\nagent.fs-reviewer.effort = high\nagent.fs-reviewer = \n```\n";
    const result = parse(text);
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["FSM-001", 5],
      ["FSM-001", 6],
      ["FSM-001", 7],
    ]);
    expect(parse(block("effort = high")).diagnostics[0]).toMatchObject({
      code: "FSM-001",
      line: 4,
    });
  });

  it("reports FSM-003 for a duplicate key, FSM-004 for an unknown agent and FSM-005 / FSM-006 for values", () => {
    const result = parse(
      block(
        [
          "tier.fast = inherit",
          "tier.fast = gpt-5",
          "agent.fs-nobody = inherit",
          "tier.reasoning = @standard",
          "agent.fs-reviewer = not a selector",
          "agent.fs-archivist = @bogus",
        ].join("\n"),
      ),
    );
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["FSM-003", 5],
      ["FSM-004", 6],
      ["FSM-005", 7],
      ["FSM-001", 8],
      ["FSM-006", 9],
    ]);
  });

  it("accepts a custom agent name when it is known", () => {
    const result = parseAgentsMd(block("agent.acme-i18n-reviewer = @fast"), {
      knownAgents: [...AGENTS, "acme-i18n-reviewer"],
      sha256,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.agents).toEqual({ "acme-i18n-reviewer": "@fast" });
  });
});

describe("JSON layers", () => {
  const check = (raw: unknown, layer: ModelLayer["name"] = "config") =>
    validateModelLayer(raw, { layer, knownAgents: AGENTS });

  it("accepts the documented shape and an empty object", () => {
    expect(check({})).toMatchObject({ ok: true, layer: { tiers: {}, agents: {} } });
    expect(
      check({ tiers: { reasoning: "openai/gpt-5" }, agents: { "fs-reviewer": "@reasoning" } }),
    ).toMatchObject({ ok: true, layer: { name: "config", tiers: { reasoning: "openai/gpt-5" } } });
  });

  it("reports unknown keys (effort is CFG-001), values and agents with the layer", () => {
    const bad = check(
      {
        effort: "high",
        tiers: { reasoning: "@fast", fast: "no good", ultra: "x" },
        agents: { "fs-nobody": "inherit", "fs-reviewer": "@nope" },
      },
      "host-options",
    );
    if (bad.ok) throw new Error("expected diagnostics");
    expect(bad.diagnostics.map((d) => `${d.code} ${d.layer} ${d.message.split(":")[0]}`)).toEqual([
      "CFG-001 host-options /effort",
      "FSM-005 host-options /tiers/reasoning",
      "FSM-006 host-options /tiers/fast",
      "CFG-001 host-options /tiers/ultra",
      "FSM-004 host-options /agents/fs-nobody",
      "FSM-006 host-options /agents/fs-reviewer",
    ]);
    expect(check([]).ok).toBe(false);
    expect(check({ tiers: "x" }).ok).toBe(false);
    expect(check({ agents: { "fs-reviewer": 4 } }).ok).toBe(false);
  });
});

describe("resolution across the five layers", () => {
  const layer = (
    name: ModelLayer["name"],
    tiers: ModelLayer["tiers"] = {},
    agents: ModelLayer["agents"] = {},
  ): ModelLayer => ({ name, tiers, agents });

  it("uses the plugin default (frontmatter tier, inherit) when nothing is configured", () => {
    const result = resolveModel("fs-reviewer", "reasoning", []);
    expect(result).toMatchObject({
      model: null,
      source: "default",
      effectiveTier: "reasoning",
      defaultTier: "reasoning",
    });
    expect(result.trail).toEqual([
      { layer: "default", key: "agent.fs-reviewer", value: "@reasoning" },
      { layer: "default", key: "tier.reasoning", value: "inherit" },
    ]);
  });

  it("resolves a tier binding through the highest layer that sets it", () => {
    const layers = [
      layer("runtime"),
      layer("agents-md", { reasoning: "agents/md" }),
      layer("config", { reasoning: "config/model" }),
      layer("host-options", { reasoning: "host/model" }),
    ];
    expect(resolveModel("fs-reviewer", "reasoning", layers)).toMatchObject({
      model: "agents/md",
      source: "agents-md",
    });
    expect(resolveModel("fs-reviewer", "reasoning", layers.slice(2))).toMatchObject({
      model: "config/model",
      source: "config",
    });
    expect(resolveModel("fs-reviewer", "reasoning", layers.slice(3))).toMatchObject({
      model: "host/model",
      source: "host-options",
    });
  });

  it("lets an agent assignment beat tier bindings and follows @tier indirection with a trail", () => {
    const layers = [
      layer("runtime", {}, { "fs-reviewer": "runtime/direct" }),
      layer("agents-md", {}, { "fs-implementer": "@reasoning" }),
      layer("config", { reasoning: "openrouter/claude" }),
    ];
    expect(resolveModel("fs-reviewer", "reasoning", layers)).toMatchObject({
      model: "runtime/direct",
      source: "runtime",
      effectiveTier: null,
    });
    const indirect = resolveModel("fs-implementer", "standard", layers);
    expect(indirect).toMatchObject({
      model: "openrouter/claude",
      source: "config",
      effectiveTier: "reasoning",
      defaultTier: "standard",
    });
    expect(indirect.trail).toEqual([
      { layer: "agents-md", key: "agent.fs-implementer", value: "@reasoning" },
      { layer: "config", key: "tier.reasoning", value: "openrouter/claude" },
    ]);
  });

  it("treats an explicit inherit as no model and an unset tier as inherit", () => {
    const explicit = resolveModel("fs-specifier", "reasoning", [
      layer("config", { reasoning: "x/y" }, { "fs-specifier": "inherit" }),
    ]);
    expect(explicit).toMatchObject({ model: null, source: "config" });
    const unset = resolveModel("fs-archivist", "fast", [layer("config", { reasoning: "x/y" })]);
    expect(unset).toMatchObject({ model: null, source: "default", effectiveTier: "fast" });
  });

  it("resolves a tier bound to inherit above a lower layer's model as inherit", () => {
    const result = resolveModel("fs-reviewer", "reasoning", [
      layer("runtime", { reasoning: "inherit" }),
      layer("config", { reasoning: "x/y" }),
    ]);
    expect(result).toMatchObject({ model: null, source: "runtime" });
  });
});

describe("ModelsService over a real workspace", () => {
  const catalogOf = (known: Record<string, string>, calls: string[] = []): ModelCatalog => ({
    async list() {
      return Object.values(known);
    },
    async resolve(selector) {
      calls.push(selector);
      const reference = known[selector];
      return reference
        ? { ok: true, reference }
        : { ok: false, message: `Model selector ${selector} is not available` };
    },
  });
  const serviceFor = (_root: string, catalog?: ModelCatalog) =>
    new ModelsService({
      fsFor: (r) => new NodeWorkspaceFs(r),
      project: new FsProjectStore(),
      runtime: new FsModelsRuntimeStore(),
      sha256,
      ...(catalog ? { catalog } : {}),
    });

  it("lists every shipped agent with its default tier and no override", async () => {
    const ws = await tempWorkspace({ "package.json": "{}" });
    try {
      const view = await serviceFor(ws.root).view(ws.root, {});
      expect(view.errors).toEqual([]);
      expect(view.rows.map((r) => r.agent)).toEqual(Object.keys(shippedAgentTiers));
      expect(view.rows).toHaveLength(12);
      const reviewer = view.rows.find((r) => r.agent === "fs-reviewer");
      expect(reviewer).toMatchObject({ defaultTier: "reasoning", model: null, source: "default" });
      expect(view.rows.find((r) => r.agent === "fs-coordinator")?.defaultTier).toBe("fast");
    } finally {
      await ws.cleanup();
    }
  });

  it("applies runtime, AGENTS.md, config and host options in that order and includes custom agents", async () => {
    const ws = await tempWorkspace({
      "AGENTS.md": block("tier.reasoning = agents/md\nagent.fs-specifier = @fast"),
      ".frontsmith/config.json": JSON.stringify({
        schemaVersion: 1,
        models: {
          tiers: { reasoning: "config/r", standard: "config/s" },
          agents: { "fs-archivist": "config/a" },
        },
        agents: { custom: [{ name: "acme-i18n-reviewer", attach: "review", tier: "reasoning" }] },
      }),
      ".alisio/frontsmith/models.runtime.json": JSON.stringify({
        agents: { "fs-implementer": "runtime/impl" },
        tiers: {},
      }),
    });
    try {
      const view = await serviceFor(ws.root).view(ws.root, {
        hostOptions: { tiers: { fast: "host/f", standard: "host/s" } },
      });
      expect(view.errors).toEqual([]);
      const by = (name: string) => view.rows.find((r) => r.agent === name);
      expect(by("fs-implementer")).toMatchObject({ model: "runtime/impl", source: "runtime" });
      expect(by("fs-reviewer")).toMatchObject({ model: "agents/md", source: "agents-md" });
      expect(by("fs-specifier")).toMatchObject({
        model: "host/f",
        source: "host-options",
        effectiveTier: "fast",
      });
      expect(by("fs-tokensmith")).toMatchObject({ model: "config/s", source: "config" });
      expect(by("fs-archivist")).toMatchObject({ model: "config/a", source: "config" });
      expect(by("fs-coordinator")).toMatchObject({ model: "host/f", source: "host-options" });
      expect(by("acme-i18n-reviewer")).toMatchObject({
        defaultTier: "reasoning",
        model: "agents/md",
      });
      expect(view.rows.at(-1)?.agent).toBe("acme-i18n-reviewer");
    } finally {
      await ws.cleanup();
    }
  });

  it("fails closed with the layer named when any layer is invalid", async () => {
    const ws = await tempWorkspace({
      "AGENTS.md": block("tier.reasoning = @fast\nbroken"),
      ".alisio/frontsmith/models.runtime.json": "{ nope",
    });
    try {
      const view = await serviceFor(ws.root).view(ws.root, { hostOptions: { effort: "high" } });
      expect(view.errors.map((e) => `${e.layer} ${e.code}`)).toEqual([
        "runtime CFG-002",
        "agents-md FSM-005",
        "agents-md FSM-001",
        "host-options CFG-001",
      ]);
      expect(describeModelDiagnostic(view.errors[1] as never)).toBe(
        "Model configuration error in agents-md: FSM-005 line 4: a tier cannot point to a tier (@fast)",
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("persists set, unset and reset in the runtime layer atomically", async () => {
    const ws = await tempWorkspace({ "package.json": "{}" });
    try {
      const service = serviceFor(ws.root);
      const file = join(ws.root, ".alisio/frontsmith/models.runtime.json");
      expect(await service.set(ws.root, "tier.reasoning", "openai/gpt-5")).toEqual({ ok: true });
      expect(await service.set(ws.root, "agent.fs-reviewer", "@fast")).toEqual({ ok: true });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        agents: { "fs-reviewer": "@fast" },
        tiers: { reasoning: "openai/gpt-5" },
      });
      expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
      const view = await service.view(ws.root, {});
      expect(view.rows.find((r) => r.agent === "fs-reviewer")).toMatchObject({
        source: "default",
        effectiveTier: "fast",
      });
      expect(await service.unset(ws.root, "agent.fs-reviewer")).toEqual({ ok: true });
      expect(await service.unset(ws.root, "agent.fs-reviewer")).toMatchObject({ ok: false });
      expect(JSON.parse(await readFile(file, "utf8")).agents).toEqual({});
      expect(await service.reset(ws.root)).toEqual({ ok: true, removed: true });
      await expect(readFile(file, "utf8")).rejects.toThrow();
      expect(await service.reset(ws.root)).toEqual({ ok: true, removed: false });
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects bad targets and values without touching the file", async () => {
    const ws = await tempWorkspace({ "package.json": "{}" });
    try {
      const service = serviceFor(ws.root);
      const file = join(ws.root, ".alisio/frontsmith/models.runtime.json");
      for (const [target, value, code] of [
        ["tier.ultra", "inherit", undefined],
        ["agent.fs-nobody", "inherit", "FSM-004"],
        ["tier.fast", "@standard", "FSM-005"],
        ["agent.fs-reviewer", "not a selector", "FSM-006"],
        ["effort", "high", undefined],
        ["agent.", "inherit", undefined],
      ] as const) {
        const result = await service.set(ws.root, target, value);
        expect(result.ok, `${target}=${value}`).toBe(false);
        if (code && !result.ok) expect(result.message).toContain(code);
      }
      await expect(readFile(file, "utf8")).rejects.toThrow();
    } finally {
      await ws.cleanup();
    }
  });

  it("refuses to overwrite a corrupt runtime file", async () => {
    const ws = await tempWorkspace({ ".alisio/frontsmith/models.runtime.json": "{ nope" });
    try {
      const result = await serviceFor(ws.root).set(ws.root, "tier.fast", "inherit");
      expect(result.ok).toBe(false);
      expect(await readFile(join(ws.root, ".alisio/frontsmith/models.runtime.json"), "utf8")).toBe(
        "{ nope",
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("check resolves every distinct selector once and reports FSM-007 for the rest", async () => {
    const ws = await tempWorkspace({
      "AGENTS.md": block("tier.reasoning = openai/gpt-5\nagent.fs-reviewer = nope/missing"),
      ".frontsmith/config.json": JSON.stringify({
        schemaVersion: 1,
        models: { tiers: { standard: "openai/gpt-5" } },
      }),
    });
    try {
      const calls: string[] = [];
      const service = serviceFor(ws.root, catalogOf({ "openai/gpt-5": "openai/gpt-5" }, calls));
      const checked = await service.check(ws.root, {});
      expect(checked.errors.map((e) => `${e.layer} ${e.code}`)).toEqual(["agents-md FSM-007"]);
      expect(checked.errors[0]?.message).toContain("nope/missing");
      expect([...new Set(calls)].sort()).toEqual(["nope/missing", "openai/gpt-5"]);
      expect(calls.filter((c) => c === "openai/gpt-5")).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });

  it("check without a model catalog says the selectors were not validated", async () => {
    const ws = await tempWorkspace({ "AGENTS.md": block("tier.fast = a/b") });
    try {
      const checked = await serviceFor(ws.root).check(ws.root, {});
      expect(checked.errors).toEqual([]);
      expect(checked.validated).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("explains the trail of one agent and rejects an unknown agent", async () => {
    const ws = await tempWorkspace({
      "AGENTS.md": block("agent.fs-reviewer = @reasoning\ntier.reasoning = x/y"),
    });
    try {
      const service = serviceFor(ws.root);
      const explained = await service.explain(ws.root, "fs-reviewer", {});
      expect(explained?.resolution.trail).toEqual([
        { layer: "agents-md", key: "agent.fs-reviewer", value: "@reasoning" },
        { layer: "agents-md", key: "tier.reasoning", value: "x/y" },
      ]);
      expect(await service.explain(ws.root, "fs-nobody", {})).toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });
});

describe("/frontsmith:models and fs_models", () => {
  const setup = async (files: Record<string, string> = { "package.json": "{}" }) => {
    const ws = await tempWorkspace(files);
    const harness = createHarness(() => ws.root);
    const api = harness.api as unknown as {
      sessions: Record<string, unknown>;
      models: Record<string, unknown>;
      ui: Record<string, unknown>;
      options?: Record<string, unknown>;
    };
    api.sessions.model = () => "session/model-x";
    registerFrontsmith(harness.api, { composition: compose() });
    return { ws, harness, api };
  };

  it("prints the table with the session model for inherited agents and the source layer", async () => {
    const { ws, harness } = await setup();
    try {
      const text = await harness.callCommand("models", "", "s");
      expect(text).toContain("| agent | default tier | effective tier | model | source |");
      expect(text).toContain(
        "| fs-reviewer | reasoning | reasoning | inherit (session: session/model-x) | default |",
      );
      expect(text.split("\n").filter((l) => l.startsWith("| fs-")).length).toBe(12);
      await expect(harness.callCommand("models", "")).rejects.toThrow();
    } finally {
      await ws.cleanup();
    }
  });

  it("host plugin options are the fourth layer", async () => {
    const { ws, harness, api } = await setup();
    try {
      api.options = { models: { tiers: { reasoning: "host/big" } } };
      const text = await harness.callCommand("models", "", "s");
      expect(text).toContain("| fs-reviewer | reasoning | reasoning | host/big | host-options |");
    } finally {
      await ws.cleanup();
    }
  });

  it("set, unset and reset change only the runtime layer and report usage errors", async () => {
    const { ws, harness } = await setup();
    try {
      expect(await harness.callCommand("models", "set tier.reasoning openai/gpt-5", "s")).toContain(
        "Set tier.reasoning",
      );
      expect(await harness.callCommand("models", "", "s")).toContain(
        "| fs-reviewer | reasoning | reasoning | openai/gpt-5 | runtime |",
      );
      expect(await harness.callCommand("models", "set tier.reasoning @fast", "s")).toContain(
        "FSM-005",
      );
      expect(await harness.callCommand("models", "set agent.fs-nobody inherit", "s")).toContain(
        "FSM-004",
      );
      expect(await harness.callCommand("models", "set tier.fast", "s")).toContain("Usage");
      expect(await harness.callCommand("models", "unset tier.reasoning", "s")).toContain("Removed");
      expect(await harness.callCommand("models", "unset tier.reasoning", "s")).toContain("not set");
      await harness.callCommand("models", "set agent.fs-reviewer inherit", "s");
      expect(await harness.callCommand("models", "reset", "s")).toContain("Removed");
      expect(await harness.callCommand("models", "reset", "s")).toContain("no runtime");
      expect(await harness.callCommand("models", "bogus", "s")).toContain("Usage");
      expect(await harness.callCommand("models", "set a b c", "s")).toContain("Usage");
    } finally {
      await ws.cleanup();
    }
  });

  it("check validates selectors with the host catalog and explain prints the trail", async () => {
    const { ws, harness, api } = await setup({
      "AGENTS.md": block("agent.fs-reviewer = nope/missing\ntier.fast = openai/gpt-5"),
    });
    try {
      api.models.list = async () => [
        {
          reference: "openai/gpt-5",
          provider: "openai",
          profile: "p",
          providerName: "OpenAI",
          model: { id: "gpt-5" },
        },
      ];
      api.models.resolve = async (ref: string) => {
        if (ref === "openai/gpt-5") return { reference: "openai/gpt-5" };
        throw new Error(`Model selector ${ref} is not available from configured /connect profiles`);
      };
      const checked = await harness.callCommand("models", "check", "s");
      expect(checked).toContain("FSM-007");
      expect(checked).toContain("nope/missing");
      const explained = await harness.callCommand("models", "explain fs-reviewer", "s");
      expect(explained).toContain("agent.fs-reviewer");
      expect(explained).toContain("agents-md");
      expect(await harness.callCommand("models", "explain fs-nobody", "s")).toContain(
        "Unknown agent",
      );
      expect(await harness.callCommand("models", "explain", "s")).toContain("Usage");
    } finally {
      await ws.cleanup();
    }
  });

  it("pick chooses a target and a model interactively, and falls back to set when headless", async () => {
    const { ws, harness, api } = await setup();
    try {
      expect(await harness.callCommand("models", "pick", "s")).toContain("/frontsmith:models set");
      api.ui.interactive = () => true;
      api.models.list = async () => [
        {
          reference: "openai/gpt-5",
          provider: "openai",
          profile: "p",
          providerName: "OpenAI",
          model: { id: "gpt-5" },
        },
      ];
      const asked: Array<{ title: string; options: Array<{ value: string }> }> = [];
      const answers = ["agent.fs-reviewer", "openai/gpt-5"];
      api.ui.select = async (request: { title: string; options: Array<{ value: string }> }) => {
        asked.push(request);
        return answers.shift();
      };
      const done = await harness.callCommand("models", "pick", "s");
      expect(done).toContain("Set agent.fs-reviewer");
      expect(asked[0]?.options.map((o) => o.value)).toContain("tier.reasoning");
      expect(asked[1]?.options.map((o) => o.value)).toEqual([
        "inherit",
        "@reasoning",
        "@standard",
        "@fast",
        "openai/gpt-5",
      ]);
      expect(await harness.callCommand("models", "", "s")).toContain(
        "| fs-reviewer | reasoning | - | openai/gpt-5 | runtime |",
      );
      api.ui.select = async () => undefined;
      expect(await harness.callCommand("models", "pick tier.fast", "s")).toContain("No change");
      expect(await harness.callCommand("models", "pick bogus", "s")).toContain("Usage");
      const tierAsked: string[][] = [];
      api.ui.select = async (request: { options: Array<{ value: string }> }) => {
        tierAsked.push(request.options.map((o) => o.value));
        return undefined;
      };
      await harness.callCommand("models", "pick tier.fast", "s");
      expect(tierAsked[0]).toEqual(["inherit", "openai/gpt-5"]);
    } finally {
      await ws.cleanup();
    }
  });

  it("fs_models returns the table, refuses extra input and flags configuration errors", async () => {
    const { ws, harness } = await setup({ "AGENTS.md": block("agent.fs-reviewer = @reasoning") });
    try {
      const ok = await harness.callTool("fs_models", {}, ws.root, { session: "s" });
      expect(ok.content.map((c) => (c.type === "ui" ? c.block.kind : c.type))).toEqual([
        "text",
        "table",
      ]);
      const table = (ok.content[1] as { block: { columns: string[]; rows: string[][] } }).block;
      expect(table.columns).toEqual(["agent", "default tier", "effective tier", "model", "source"]);
      expect(table.rows).toHaveLength(12);
      expect((await harness.callTool("fs_models", { x: 1 }, ws.root)).isError).toBe(true);
    } finally {
      await ws.cleanup();
    }
    const bad = await setup({ "AGENTS.md": block("tier.fast = @standard") });
    try {
      const result = await bad.harness.callTool("fs_models", {}, bad.ws.root);
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain(
        "Model configuration error in agents-md",
      );
    } finally {
      await bad.ws.cleanup();
    }
  });
});

describe("CLI models", () => {
  it("prints the table, JSON, and exits 3 on a configuration error", async () => {
    const ok = await tempWorkspace({ "package.json": "{}" });
    const bad = await tempWorkspace({ "AGENTS.md": block("tier.fast = @standard") });
    try {
      const text = await cliRun(["models", ok.root]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("fs-reviewer");
      expect(text.stdout).toContain("inherit");
      const json = JSON.parse((await cliRun(["models", ok.root, "--json"])).stdout);
      expect(json.agents).toHaveLength(12);
      expect(json.diagnostics).toEqual([]);
      const failing = await cliRun(["models", bad.root, "--json"]);
      expect(failing.code).toBe(3);
      expect(JSON.parse(failing.stdout).diagnostics[0].code).toBe("FSM-005");
      expect((await cliRun(["models", "--bogus"])).code).toBe(2);
    } finally {
      await Promise.all([ok.cleanup(), bad.cleanup()]);
    }
  });
});

describe("model catalog adapter", () => {
  const apiWith = (
    resolve: (ref: string) => Promise<{ reference: string }>,
    calls: string[] = [],
  ) =>
    ({
      models: {
        list: async () => [
          {
            reference: "openai/gpt-5",
            provider: "openai",
            profile: "p",
            providerName: "OpenAI",
            model: { id: "gpt-5" },
          },
        ],
        resolve: async (ref: string) => {
          calls.push(ref);
          return resolve(ref);
        },
      },
    }) as never;

  it("lists canonical references and caches successful resolutions only", async () => {
    const calls: string[] = [];
    let fail = true;
    const catalog = new ApiModelCatalog(
      apiWith(async (ref) => {
        if (ref === "later/model" && fail) throw new Error("not available");
        return { reference: ref === "gpt-5" ? "openai/gpt-5" : ref };
      }, calls),
    );
    expect(await catalog.list()).toEqual(["openai/gpt-5"]);
    expect(await catalog.resolve("gpt-5")).toEqual({ ok: true, reference: "openai/gpt-5" });
    expect(await catalog.resolve("gpt-5")).toEqual({ ok: true, reference: "openai/gpt-5" });
    expect(calls).toEqual(["gpt-5"]);
    expect(await catalog.resolve("later/model")).toEqual({ ok: false, message: "not available" });
    fail = false;
    expect(await catalog.resolve("later/model")).toEqual({ ok: true, reference: "later/model" });
  });
});

describe("ModelsService.forRun (the model of one child run)", () => {
  const catalog = (known: Record<string, string>): ModelCatalog => ({
    list: async () => Object.values(known),
    resolve: async (selector) =>
      known[selector]
        ? { ok: true, reference: known[selector] as string }
        : { ok: false, message: `Model selector ${selector} is not available` },
  });
  const service = () =>
    new ModelsService({
      fsFor: (r) => new NodeWorkspaceFs(r),
      project: new FsProjectStore(),
      runtime: new FsModelsRuntimeStore(),
      sha256,
    });

  it("inherits by default and resolves a bound selector to its canonical reference", async () => {
    const ws = await tempWorkspace({
      "AGENTS.md": block("tier.reasoning = gpt-5\nagent.fs-archivist = inherit"),
    });
    try {
      expect(await service().forRun(ws.root, "fs-implementer")).toMatchObject({
        ok: true,
        model: null,
        source: "default",
      });
      expect(
        await service().forRun(ws.root, "fs-reviewer", {
          catalog: catalog({ "gpt-5": "openai/gpt-5" }),
        }),
      ).toMatchObject({ ok: true, model: "openai/gpt-5", source: "agents-md" });
      expect(await service().forRun(ws.root, "fs-reviewer")).toMatchObject({ model: "gpt-5" });
    } finally {
      await ws.cleanup();
    }
  });

  it("fails closed on a configuration error, an unresolvable selector and an unknown agent", async () => {
    const bad = await tempWorkspace({ "AGENTS.md": block("tier.fast = not a selector") });
    const unresolved = await tempWorkspace({ "AGENTS.md": block("tier.reasoning = nope/missing") });
    try {
      const closed = await service().forRun(bad.root, "fs-reviewer");
      expect(closed).toMatchObject({ ok: false });
      if (!closed.ok) expect(closed.message).toContain("Model configuration error in agents-md");
      const refused = await service().forRun(unresolved.root, "fs-reviewer", {
        catalog: catalog({}),
      });
      expect(refused).toMatchObject({ ok: false });
      if (!refused.ok) expect(refused.message).toContain("FSM-007");
      expect(await service().forRun(unresolved.root, "fs-nobody")).toMatchObject({ ok: false });
    } finally {
      await bad.cleanup();
      await unresolved.cleanup();
    }
  });
});
