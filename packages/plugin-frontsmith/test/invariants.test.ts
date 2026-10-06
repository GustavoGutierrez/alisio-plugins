import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentNames, roleSkills, roles, skillNames } from "../src/application/agents/roster.js";
import { engines, engineValidators } from "../src/application/engines/index.js";
import { envelopeKinds } from "../src/domain/envelopes/parse.js";
import { isShippedRuleId } from "../src/domain/ids.js";
import { shippedAgentTiers } from "../src/domain/models/agents.js";
import { parseResource } from "../src/domain/resources/frontmatter.js";
import { engineIds } from "../src/domain/rules/model.js";
import { gateIds, modelSources } from "../src/domain/state/feature-state.js";
import { approvalsForLevel, levels, phasesForLevel } from "../src/domain/state/levels.js";
import { phases } from "../src/domain/state/phases.js";
import { registerFrontsmith } from "../src/index.js";
import { loadShippedAdapters, packageRoot } from "../src/infrastructure/packs/adapter-loader.js";
import { loadShippedPacks } from "../src/infrastructure/packs/loader.js";
import { createHarness } from "./helpers/harness.js";

/** Quantities that must hold across the package (spec 0.1). Later phases extend this file. */
const packs = await loadShippedPacks(engineValidators);
const rules = packs.flatMap((pack) => pack.rules.map((rule) => ({ pack, rule })));

describe("package invariants", () => {
  it("ships 15 rule packs with 130 rules, 91 non-advisory and 39 advisory", async () => {
    expect(packs).toHaveLength(15);
    expect((await readdir(join(packageRoot(), "rule-packs"))).length).toBe(15);
    expect(rules).toHaveLength(130);
    expect(rules.filter(({ rule }) => rule.kind !== "advisory")).toHaveLength(91);
    expect(rules.filter(({ rule }) => rule.kind === "advisory")).toHaveLength(39);
  });

  it("has the documented rule count per pack", () => {
    const counts = Object.fromEntries(packs.map((pack) => [pack.packId, pack.rules.length]));
    expect(counts).toEqual({
      "fs-a11y": 14,
      "fs-angular": 3,
      "fs-architecture": 7,
      "fs-components": 9,
      "fs-css": 12,
      "fs-design": 38,
      "fs-governance": 8,
      "fs-next": 3,
      "fs-performance": 7,
      "fs-react": 1,
      "fs-svelte": 2,
      "fs-tailwind": 7,
      "fs-testing": 7,
      "fs-tokens": 8,
      "fs-vue": 4,
    });
  });

  it("has twenty engine ids, nineteen implementations and one advisory without findings", () => {
    expect(engineIds).toHaveLength(20);
    expect(Object.keys(engines)).toHaveLength(20);
    expect(engineIds.filter((id) => id !== "advisory")).toHaveLength(19);
    expect(engines.advisory.run({} as never)).toMatchObject({ findings: [] });
  });

  it("uses only engines of the closed set and unique, well formed rule ids", () => {
    const ids = rules.map(({ rule }) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { rule } of rules) {
      expect(isShippedRuleId(rule.id), rule.id).toBe(true);
      expect(engineIds).toContain(rule.engine);
      expect(rule.engine === "advisory", rule.id).toBe(rule.kind === "advisory");
    }
  });

  it("never marks a blocker or major rule suppressible (B-02 keeps FS-CMP-009 waiver-only)", () => {
    for (const { rule } of rules)
      if (rule.suppressible) expect(["minor", "nit"], rule.id).toContain(rule.severity);
    expect(rules.find(({ rule }) => rule.id === "FS-CMP-009")?.rule).toMatchObject({
      severity: "major",
      suppressible: false,
    });
  });

  it("contains no pointer to the research documents in any shipped rule or catalog", async () => {
    // Built from pieces so that this guard does not itself name the local-only research documents.
    const forbidden = new RegExp(
      `\\b(?:METH|FID)\\s*§|${["frontend-agent", "engineering"].join("-")}|${["fidelidad", "ui"].join("-")}`,
    );
    for (const { rule } of rules) expect(JSON.stringify(rule), rule.id).not.toMatch(forbidden);
    const catalog = await readFile(join(packageRoot(), "catalog", "antipatterns.json"), "utf8");
    expect(catalog).not.toMatch(forbidden);
  });

  it("ships the anti-pattern catalog and every rule it names exists", async () => {
    const catalog = JSON.parse(
      await readFile(join(packageRoot(), "catalog", "antipatterns.json"), "utf8"),
    ) as {
      entries: Array<{ id: string; title: string; detectedBy: string[]; reviewHint: string }>;
    };
    const known = new Set(rules.map(({ rule }) => rule.id));
    expect(catalog.entries).toHaveLength(52);
    expect(catalog.entries.filter((e) => e.id.startsWith("METH-AP-"))).toHaveLength(12);
    expect(catalog.entries.filter((e) => /^AC\d\d$/.test(e.id))).toHaveLength(20);
    expect(catalog.entries.filter((e) => /^AV\d\d$/.test(e.id))).toHaveLength(20);
    for (const entry of catalog.entries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.reviewHint.length).toBeGreaterThan(0);
      for (const id of entry.detectedBy)
        expect(known.has(id), `${entry.id} names unknown rule ${id}`).toBe(true);
    }
  });

  it("ships the eleven stack adapters", async () => {
    expect(await loadShippedAdapters()).toHaveLength(11);
  });

  it("keeps every shipped pack inside the pack validation rules", () => {
    for (const pack of packs) {
      expect(pack.schemaVersion).toBe(1);
      expect(pack.packId.startsWith("fs-")).toBe(true);
      expect(pack.overrides).toEqual([]);
    }
  });
});

describe("package invariants (agents, skills, envelopes, models)", () => {
  const root = packageRoot();

  it("ships 12 agents, one primary and eleven subagents, with default tiers pinned", async () => {
    const files = (await readdir(join(root, ".agents", "agents"))).sort();
    expect(files).toEqual(agentNames.map((name) => `${name}.md`).sort());
    const modes = await Promise.all(
      files.map(
        async (file) =>
          parseResource(await readFile(join(root, ".agents", "agents", file), "utf8"), file)
            .frontmatter.mode,
      ),
    );
    expect(modes.filter((mode) => mode === "primary")).toHaveLength(1);
    expect(modes.filter((mode) => mode === "subagent")).toHaveLength(11);
    expect(Object.keys(shippedAgentTiers).sort()).toEqual([...agentNames].sort());
    expect(roles).toHaveLength(12);
  });

  it("ships 16 skills and every role loads skills that exist", async () => {
    expect(await readdir(join(root, ".agents", "skills"))).toHaveLength(16);
    expect(skillNames).toHaveLength(16);
    for (const role of roles)
      for (const skill of roleSkills[role]) expect(skillNames).toContain(skill);
  });

  it("has ten envelope kinds, each with its own validator source file", async () => {
    expect(envelopeKinds).toHaveLength(10);
    const files = new Set(
      (await readdir(join(root, "src", "domain", "envelopes"))).map((file) =>
        file.replace(/\.ts$/, ""),
      ),
    );
    const fileOf = (kind: string): string => (kind === "a11y-audit" ? "audit" : kind);
    for (const kind of envelopeKinds) expect(files.has(fileOf(kind)), kind).toBe(true);
  });

  it("has five model resolution layers, 18 patterns, 11 adapters and 4 architecture presets", async () => {
    expect(modelSources).toEqual(["runtime", "agents-md", "config", "host-options", "default"]);
    const patterns = JSON.parse(await readFile(join(root, "catalog", "patterns.json"), "utf8")) as {
      patterns: unknown[];
    };
    expect(patterns.patterns).toHaveLength(18);
    expect(await loadShippedAdapters()).toHaveLength(11);
    expect(await readdir(join(root, "presets", "architecture"))).toHaveLength(4);
  });

  it("keeps the shipped agent and skill files free of research-document pointers", async () => {
    const forbidden = new RegExp(
      `\\b(?:METH|FID)\\b|${["frontend-agent", "engineering"].join("-")}|${["fidelidad", "ui"].join("-")}|/home/|/Users/`,
    );
    for (const name of agentNames)
      expect(await readFile(join(root, ".agents", "agents", `${name}.md`), "utf8")).not.toMatch(
        forbidden,
      );
    for (const name of skillNames)
      expect(await readFile(join(root, ".agents", "skills", name, "SKILL.md"), "utf8")).not.toMatch(
        forbidden,
      );
  });
});

describe("package invariants (workflow)", () => {
  const root = packageRoot();

  it("has 11 gates, 13 phases and 4 levels with the documented phase lists and approvals", () => {
    expect(gateIds).toEqual(["G0", "G1", "G2", "G2T", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]);
    expect(phases).toHaveLength(13);
    expect(levels).toEqual(["L0", "L1", "L2", "L3"]);
    expect(phasesForLevel("L0")).toEqual([
      "intake",
      "context",
      "build",
      "validate",
      "review",
      "closed",
    ]);
    expect(phasesForLevel("L2")).toHaveLength(12);
    expect(phasesForLevel("L2", { tokensNeeded: true })).toHaveLength(13);
    expect(approvalsForLevel("L3")).toEqual([
      "spec",
      "ui-contract",
      "plan",
      "acceptance",
      "review-signoff",
    ]);
  });

  it("has one source file per gate under domain/gates", async () => {
    const files = new Set(
      (await readdir(join(root, "src", "domain", "gates"))).map((f) => f.replace(/\.ts$/, "")),
    );
    for (const id of gateIds) expect(files.has(id.toLowerCase()), id).toBe(true);
    expect(files.has("aggregate")).toBe(true);
  });

  it("registers the 19 plugin tools and the 21 slash commands", () => {
    const harness = createHarness();
    registerFrontsmith(harness.api);
    expect([...harness.tools.keys()].sort()).toEqual(
      [
        "fs_a11y_run",
        "fs_answer",
        "fs_approval_request",
        "fs_architecture_check",
        "fs_budget_check",
        "fs_contrast",
        "fs_detect_stack",
        "fs_feature_new",
        "fs_fidelity_run",
        "fs_gate_run",
        "fs_inventory",
        "fs_models",
        "fs_next",
        "fs_palette_generate",
        "fs_phase_run",
        "fs_rules_check",
        "fs_rules_list",
        "fs_status",
        "fs_tokens_check",
      ].sort(),
    );
    expect(harness.tools.size).toBe(19);
    const planned = [
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
      "rules",
      "arch",
      "tokens",
      "fidelity",
      "baseline",
      "budget",
      "models",
      "dashboard",
    ];
    expect([...harness.commands.keys()].sort()).toEqual([...planned].sort());
    expect(harness.commands.size).toBe(21);
  });
});
