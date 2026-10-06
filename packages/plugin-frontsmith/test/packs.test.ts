import { describe, expect, it } from "vitest";
import { engineIds, type PackDef, type RuleDef } from "../src/domain/rules/model.js";
import { type PackDiagnostic, validatePack } from "../src/domain/rules/pack-validate.js";
import { resolveRules } from "../src/domain/rules/resolve.js";
import { parseSuppressions, suppressionFor } from "../src/domain/rules/suppressions.js";
import { activeWaivers, findWaiver, validateWaivers } from "../src/domain/rules/waivers.js";
import type { StackProfile } from "../src/domain/stack/profile.js";

const stack = (patch: Partial<StackProfile> = {}): StackProfile => ({
  packageManager: "pnpm",
  monorepo: false,
  typescript: true,
  framework: "react",
  meta: "none",
  styling: ["css", "tailwind"],
  state: [],
  tests: ["vitest"],
  storybook: false,
  playwrightResolvable: false,
  axeResolvable: false,
  sourceRoots: ["src"],
  scripts: {},
  evidence: [],
  ...patch,
});

const rule = (id: string, patch: Partial<RuleDef> = {}): RuleDef => ({
  id,
  title: `Title of ${id}`,
  severity: "minor",
  kind: "deterministic",
  category: "layout",
  engine: "css-declaration",
  params: { property: "^color$" },
  files: ["**/*.css"],
  appliesWhen: {},
  message: "m",
  fix: "f",
  rationale: "r",
  source: "s",
  suppressible: false,
  tags: [],
  ...patch,
});

const pack = (packId: string, rules: RuleDef[], patch: Partial<PackDef> = {}): PackDef => ({
  schemaVersion: 1,
  packId,
  version: "1.0.0",
  title: packId,
  description: "d",
  extends: [],
  appliesWhen: {},
  rules,
  overrides: [],
  ...patch,
});

const noParams = {
  validators: Object.fromEntries(engineIds.map((id) => [id, () => [] as string[]])),
};
const codes = (diagnostics: PackDiagnostic[]) => diagnostics.map((d) => d.code);

describe("pack validation", () => {
  const valid = (patch: Record<string, unknown> = {}) => ({
    ...pack("fs-demo", [rule("FS-CSS-001")]),
    ...patch,
  });

  it("validates appliesWhen.architectureConfig as a boolean at pack load", () => {
    expect(
      validatePack(valid({ appliesWhen: { architectureConfig: true } }), {
        scope: "shipped",
        ...noParams,
      }).ok,
    ).toBe(true);
    const bad = validatePack(valid({ appliesWhen: { architectureConfig: "yes" } }), {
      scope: "shipped",
      ...noParams,
    });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.diagnostics).toEqual([
      expect.objectContaining({ code: "PCK-001", where: "/appliesWhen/architectureConfig" }),
    ]);
    const ruleLevel = validatePack(
      valid({ rules: [rule("FS-CSS-001", { appliesWhen: { architectureConfig: 1 as never } })] }),
      { scope: "shipped", ...noParams },
    );
    expect(ruleLevel.ok).toBe(false);
  });

  it("accepts a well formed shipped pack", () => {
    const result = validatePack(valid(), { scope: "shipped", ...noParams });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["not an object", 7],
    ["missing rules", { ...valid(), rules: undefined }],
    ["unknown top-level key", { ...valid(), extra: 1 }],
    ["bad schemaVersion", { ...valid(), schemaVersion: 2 }],
    ["bad pack id", { ...valid(), packId: "Bad Pack" }],
    ["bad severity", { ...valid(), rules: [rule("FS-CSS-001", { severity: "huge" as never })] }],
    ["bad kind", { ...valid(), rules: [rule("FS-CSS-001", { kind: "magic" as never })] }],
    ["bad category", { ...valid(), rules: [rule("FS-CSS-001", { category: "misc" as never })] }],
    ["bad rule id", { ...valid(), rules: [rule("css-001")] }],
    ["empty message", { ...valid(), rules: [rule("FS-CSS-001", { message: "" })] }],
    ["unknown rule key", { ...valid(), rules: [{ ...rule("FS-CSS-001"), surprise: 1 }] }],
    ["bad glob", { ...valid(), rules: [rule("FS-CSS-001", { files: ["!x"] })] }],
    [
      "bad appliesWhen key",
      { ...valid(), rules: [rule("FS-CSS-001", { appliesWhen: { nope: ["x"] } as never })] },
    ],
    [
      "suppressible major rule",
      { ...valid(), rules: [rule("FS-CSS-001", { severity: "major", suppressible: true })] },
    ],
    [
      "suppressible blocker rule",
      { ...valid(), rules: [rule("FS-CSS-001", { severity: "blocker", suppressible: true })] },
    ],
    [
      "advisory without advisory engine",
      { ...valid(), rules: [rule("FS-CSS-001", { kind: "advisory" })] },
    ],
    [
      "advisory engine without advisory kind",
      {
        ...valid(),
        rules: [rule("FS-CSS-001", { engine: "advisory", params: { guidance: "g" } })],
      },
    ],
    [
      "advisory without guidance",
      {
        ...valid(),
        rules: [rule("FS-CSS-001", { kind: "advisory", engine: "advisory", params: {} })],
      },
    ],
  ])("PCK-001 rejects %s", (_name, raw) => {
    const result = validatePack(raw, { scope: "shipped", ...noParams });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.diagnostics)).toContain("PCK-001");
  });

  it("PCK-006 rejects an unknown engine and invalid engine params", () => {
    const unknown = validatePack(
      valid({ rules: [rule("FS-CSS-001", { engine: "magic" as never })] }),
      { scope: "shipped", ...noParams },
    );
    expect(unknown.ok === false && codes(unknown.diagnostics)).toContain("PCK-006");
    const failing = {
      validators: { ...noParams.validators, "css-declaration": () => ["property: invalid regex"] },
    };
    const bad = validatePack(valid(), { scope: "shipped", ...failing });
    expect(
      bad.ok === false && bad.diagnostics.find((d) => d.code === "PCK-006")?.message,
    ).toContain("invalid regex");
  });

  it("PCK-005 keeps the FS- namespace for shipped packs and rejects it in workspace packs", () => {
    const ws = validatePack(valid({ packId: "acme", rules: [rule("FS-CSS-001")] }), {
      scope: "workspace",
      ...noParams,
    });
    expect(ws.ok === false && codes(ws.diagnostics)).toContain("PCK-005");
    const shipped = validatePack(valid({ rules: [rule("ACME-UI-001")] }), {
      scope: "shipped",
      ...noParams,
    });
    expect(shipped.ok).toBe(false);
    const okWs = validatePack(
      valid({ packId: "acme", rules: [rule("ACME-UI-001", { suppressible: true })] }),
      { scope: "workspace", ...noParams },
    );
    expect(okWs.ok).toBe(true);
  });

  it("rejects duplicate rule ids inside one pack and bad overrides", () => {
    const dup = validatePack(valid({ rules: [rule("FS-CSS-001"), rule("FS-CSS-001")] }), {
      scope: "shipped",
      ...noParams,
    });
    expect(dup.ok === false && codes(dup.diagnostics)).toContain("PCK-002");
    const badOverride = validatePack(
      valid({
        packId: "acme",
        rules: [],
        overrides: [{ id: "FS-CSS-001", override: true, severity: "huge", justification: "x" }],
      }),
      { scope: "workspace", ...noParams },
    );
    expect(badOverride.ok).toBe(false);
  });

  it("validates workspace rule params through the engine validators", () => {
    const strict = {
      validators: { ...noParams.validators, "jsx-element": () => ["element: required"] },
    };
    const result = validatePack(
      valid({
        packId: "acme",
        rules: [rule("ACME-UI-001", { engine: "jsx-element", params: {} })],
      }),
      { scope: "workspace", ...strict },
    );
    expect(result.ok === false && codes(result.diagnostics)).toContain("PCK-006");
  });
});

describe("rule resolution", () => {
  const css = pack(
    "fs-css",
    [rule("FS-CSS-001", { severity: "major" }), rule("FS-CSS-002", { severity: "blocker" })],
    {
      appliesWhen: { styling: ["css", "scss"] },
    },
  );
  const react = pack(
    "fs-react",
    [rule("FS-RCT-001", { engine: "component-api", params: { checks: ["noIndexKey"] } })],
    {
      appliesWhen: { framework: ["react"] },
    },
  );
  const gov = pack("fs-governance", [rule("FS-GOV-001", { severity: "blocker" })]);
  const arch = pack(
    "fs-architecture",
    [
      rule("FS-ARC-001", {
        severity: "blocker",
        engine: "architecture",
        params: { check: "direction" },
      }),
    ],
    {
      appliesWhen: { architectureConfig: true },
    },
  );
  const shipped = [css, react, gov, arch];
  const base = {
    level: "L2" as const,
    config: { packs: { enable: [], disable: [], order: [] }, rules: {} },
    shipped,
    workspace: [],
    architectureConfig: false,
  };
  const ids = (set: { rules: Array<{ id: string }> }) => set.rules.map((r) => r.id).sort();

  it("activates shipped packs by stack and architecture config", () => {
    expect(ids(resolveRules({ ...base, stack: stack() }))).toEqual([
      "FS-CSS-001",
      "FS-CSS-002",
      "FS-GOV-001",
      "FS-RCT-001",
    ]);
    expect(
      ids(resolveRules({ ...base, stack: stack({ framework: "vue", styling: ["tailwind"] }) })),
    ).toEqual(["FS-GOV-001"]);
    expect(ids(resolveRules({ ...base, stack: stack(), architectureConfig: true }))).toContain(
      "FS-ARC-001",
    );
  });

  it("honours packs.enable and packs.disable", () => {
    const config = {
      packs: { enable: ["fs-architecture"], disable: ["fs-css"], order: [] },
      rules: {},
    };
    expect(ids(resolveRules({ ...base, stack: stack(), config }))).toEqual([
      "FS-ARC-001",
      "FS-GOV-001",
      "FS-RCT-001",
    ]);
  });

  it("evaluates rule level appliesWhen and reports inactive rules", () => {
    const gated = pack("fs-gated", [
      rule("FS-GAT-001", { appliesWhen: { level: "L3" } }),
      rule("FS-GAT-002", { appliesWhen: { typescript: true } }),
    ]);
    const set = resolveRules({ ...base, shipped: [gated], stack: stack({ typescript: false }) });
    expect(set.rules).toEqual([]);
    expect(set.inactive.map((i) => i.ruleId).sort()).toEqual(["FS-GAT-001", "FS-GAT-002"]);
    expect(ids(resolveRules({ ...base, level: "L3", shipped: [gated], stack: stack() }))).toEqual([
      "FS-GAT-001",
      "FS-GAT-002",
    ]);
    expect(set.inactive[0]?.reason).toMatch(/level|typescript/);
  });

  it("applies config rule overrides with a precedence trail", () => {
    const config = {
      packs: { enable: [], disable: [], order: [] },
      rules: {
        "FS-CSS-001": { severity: "nit" as const },
        "FS-CSS-002": {
          enabled: false,
          justification: "legacy utility layer uses it everywhere on purpose",
        },
      },
    };
    const set = resolveRules({ ...base, stack: stack(), config });
    const first = set.rules.find((r) => r.id === "FS-CSS-001");
    expect(first?.severity).toBe("nit");
    expect(first?.trail.map((t) => t.source)).toEqual(["shipped:fs-css", "config"]);
    expect(set.rules.find((r) => r.id === "FS-CSS-002")).toBeUndefined();
    expect(set.disabled.map((d) => d.ruleId)).toEqual(["FS-CSS-002"]);
    expect(set.diagnostics).toEqual([]);
  });

  it("PCK-004 requires a justification of 20 characters to disable or downgrade a blocker", () => {
    const short = resolveRules({
      ...base,
      stack: stack(),
      config: {
        packs: base.config.packs,
        rules: { "FS-CSS-002": { severity: "major" as const, justification: "too short" } },
      },
    });
    expect(codes(short.diagnostics)).toEqual(["PCK-004"]);
    const missing = resolveRules({
      ...base,
      stack: stack(),
      config: { packs: base.config.packs, rules: { "FS-GOV-001": { enabled: false } } },
    });
    expect(codes(missing.diagnostics)).toEqual(["PCK-004"]);
    const nonBlocker = resolveRules({
      ...base,
      stack: stack(),
      config: { packs: base.config.packs, rules: { "FS-CSS-001": { enabled: false } } },
    });
    expect(nonBlocker.diagnostics).toEqual([]);
  });

  it("PCK-002 rejects the same rule id in two active packs", () => {
    const other = pack("fs-other", [rule("FS-CSS-001")]);
    const set = resolveRules({ ...base, shipped: [css, other], stack: stack() });
    expect(codes(set.diagnostics)).toContain("PCK-002");
  });

  describe("workspace packs", () => {
    const acme = pack(
      "acme",
      [rule("ACME-UI-001", { engine: "jsx-element", params: { element: "^div$" } })],
      {
        extends: ["fs-css"],
        overrides: [
          {
            id: "FS-CSS-001",
            override: true,
            severity: "nit",
            justification: "House style accepts it",
          },
        ],
      },
    );

    it("loads after shipped packs and may override rules of extended packs", () => {
      const set = resolveRules({ ...base, stack: stack(), workspace: [acme] });
      expect(ids(set)).toContain("ACME-UI-001");
      const overridden = set.rules.find((r) => r.id === "FS-CSS-001");
      expect(overridden?.severity).toBe("nit");
      expect(overridden?.trail.map((t) => t.source)).toEqual(["shipped:fs-css", "workspace:acme"]);
      expect(set.rules.find((r) => r.id === "ACME-UI-001")?.packId).toBe("acme");
    });

    it("config.rules beat workspace overrides", () => {
      const config = {
        packs: base.config.packs,
        rules: { "FS-CSS-001": { severity: "major" as const } },
      };
      const set = resolveRules({ ...base, stack: stack(), workspace: [acme], config });
      expect(set.rules.find((r) => r.id === "FS-CSS-001")?.severity).toBe("major");
      expect(set.rules.find((r) => r.id === "FS-CSS-001")?.trail.map((t) => t.source)).toEqual([
        "shipped:fs-css",
        "workspace:acme",
        "config",
      ]);
    });

    it("PCK-007 refuses an override of a rule from a pack that is not extended", () => {
      const rogue = pack("rogue", [], {
        extends: [],
        overrides: [
          { id: "FS-CSS-001", override: true, severity: "nit", justification: "x".repeat(25) },
        ],
      });
      expect(
        codes(resolveRules({ ...base, stack: stack(), workspace: [rogue] }).diagnostics),
      ).toContain("PCK-007");
    });

    it("PCK-007 rejects extending an unknown pack and extends cycles", () => {
      const unknown = pack("w1", [], { extends: ["nope"] });
      expect(
        codes(resolveRules({ ...base, stack: stack(), workspace: [unknown] }).diagnostics),
      ).toContain("PCK-007");
      const a = pack("wa", [], { extends: ["wb"] });
      const b = pack("wb", [], { extends: ["wa"] });
      expect(
        codes(resolveRules({ ...base, stack: stack(), workspace: [a, b] }).diagnostics),
      ).toContain("PCK-007");
    });

    it("PCK-003 reports two workspace packs overriding one rule with no order", () => {
      const mk = (id: string, severity: "nit" | "minor") =>
        pack(id, [], {
          extends: ["fs-css"],
          overrides: [
            { id: "FS-CSS-001", override: true, severity, justification: "House style accepts it" },
          ],
        });
      const set = resolveRules({
        ...base,
        stack: stack(),
        workspace: [mk("wx", "nit"), mk("wy", "minor")],
      });
      const diagnostic = set.diagnostics.find((d) => d.code === "PCK-003");
      expect(diagnostic?.message).toContain("wx");
      expect(diagnostic?.message).toContain("wy");
    });

    it("lets config.packs.order break the tie: the later pack wins", () => {
      const mk = (id: string, severity: "nit" | "minor") =>
        pack(id, [], {
          extends: ["fs-css"],
          overrides: [
            { id: "FS-CSS-001", override: true, severity, justification: "House style accepts it" },
          ],
        });
      const config = { packs: { enable: [], disable: [], order: ["wx", "wy"] }, rules: {} };
      const set = resolveRules({
        ...base,
        stack: stack(),
        workspace: [mk("wx", "nit"), mk("wy", "minor")],
        config,
      });
      expect(set.diagnostics).toEqual([]);
      expect(set.rules.find((r) => r.id === "FS-CSS-001")?.severity).toBe("minor");
    });

    it("lets the LAST pack of config.packs.order win, whichever order they are declared in", () => {
      const mk = (id: string, severity: "nit" | "minor") =>
        pack(id, [], {
          extends: ["fs-css"],
          overrides: [
            { id: "FS-CSS-001", override: true, severity, justification: "House style accepts it" },
          ],
        });
      const resolve = (order: string[]) =>
        resolveRules({
          ...base,
          stack: stack(),
          workspace: [mk("wx", "nit"), mk("wy", "minor")],
          config: { packs: { enable: [], disable: [], order }, rules: {} },
        }).rules.find((r) => r.id === "FS-CSS-001")?.severity;
      expect(resolve(["wx", "wy"])).toBe("minor");
      expect(resolve(["wy", "wx"])).toBe("nit");
    });

    it("PCK-004 applies to workspace overrides that downgrade a blocker", () => {
      const weak = pack("weak", [], {
        extends: ["fs-css"],
        overrides: [
          { id: "FS-CSS-002", override: true, severity: "minor", justification: "short" },
        ],
      });
      expect(
        codes(resolveRules({ ...base, stack: stack(), workspace: [weak] }).diagnostics),
      ).toContain("PCK-004");
    });

    it("supports disabling a rule through an override", () => {
      const off = pack("off", [], {
        extends: ["fs-css"],
        overrides: [
          {
            id: "FS-CSS-001",
            override: true,
            enabled: false,
            justification: "Not applicable to this code base at all",
          },
        ],
      });
      const set = resolveRules({ ...base, stack: stack(), workspace: [off] });
      expect(set.rules.find((r) => r.id === "FS-CSS-001")).toBeUndefined();
      expect(set.disabled.map((d) => d.ruleId)).toEqual(["FS-CSS-001"]);
    });

    it("overrides files and params", () => {
      const tune = pack("tune", [], {
        extends: ["fs-css"],
        overrides: [
          {
            id: "FS-CSS-001",
            override: true,
            files: ["src/**/*.css"],
            params: { property: "^margin$" },
            justification: "Scope to app styles only please",
          },
        ],
      });
      const rule1 = resolveRules({ ...base, stack: stack(), workspace: [tune] }).rules.find(
        (r) => r.id === "FS-CSS-001",
      );
      expect(rule1?.files).toEqual(["src/**/*.css"]);
      expect(rule1?.params).toEqual({ property: "^margin$" });
    });
  });
});

describe("inline suppressions", () => {
  const comment = (text: string, line: number) => ({ text, line, column: 1 });

  it("parses the next-line syntax of every language", () => {
    const found = parseSuppressions([
      comment(" frontsmith-disable-next-line FS-TOK-002 -- legacy spacing scale kept for now", 3),
      comment(" frontsmith-disable-next-line FS-CSS-002 -- utility layer needs this one ", 9),
      comment("not a suppression", 11),
    ]);
    expect(found).toEqual([
      { ruleId: "FS-TOK-002", reason: "legacy spacing scale kept for now", line: 4, valid: true },
      { ruleId: "FS-CSS-002", reason: "utility layer needs this one", line: 10, valid: true },
    ]);
  });

  it("flags a missing or short reason as invalid", () => {
    const found = parseSuppressions([
      comment(" frontsmith-disable-next-line FS-TOK-002", 1),
      comment(" frontsmith-disable-next-line FS-TOK-002 -- short", 5),
    ]);
    expect(found.map((s) => s.valid)).toEqual([false, false]);
    expect(found[0]?.problem).toMatch(/reason/);
  });

  it("counts lines of multi-line block comments", () => {
    const [one] = parseSuppressions([
      comment(" frontsmith-disable-next-line FS-TOK-002 -- a reason long enough\n ", 2),
    ]);
    expect(one?.line).toBe(4);
  });

  it("honours a suppression only for the next line, a suppressible rule and minor or nit severity", () => {
    const suppressions = parseSuppressions([
      comment(" frontsmith-disable-next-line FS-TOK-002 -- legacy spacing scale kept for now", 3),
    ]);
    const ok = { id: "FS-TOK-002", severity: "minor" as const, suppressible: true };
    expect(suppressionFor({ ruleId: "FS-TOK-002", line: 4 }, ok, suppressions)).toEqual({
      status: "honoured",
      reason: "legacy spacing scale kept for now",
    });
    expect(suppressionFor({ ruleId: "FS-TOK-002", line: 5 }, ok, suppressions).status).toBe("none");
    expect(
      suppressionFor(
        { ruleId: "FS-TOK-002", line: 4 },
        { ...ok, suppressible: false },
        suppressions,
      ).status,
    ).toBe("ignored");
    expect(
      suppressionFor({ ruleId: "FS-TOK-002", line: 4 }, { ...ok, severity: "major" }, suppressions)
        .status,
    ).toBe("ignored");
    expect(suppressionFor({ ruleId: "FS-OTHER-1", line: 4 }, ok, suppressions).status).toBe("none");
  });
});

describe("waivers", () => {
  const doc = {
    schemaVersion: 1,
    waivers: [
      {
        id: "W-001",
        ruleId: "FS-CSS-001",
        paths: ["src/legacy/**"],
        reason: "Legacy area",
        approvedBy: "human",
        createdAt: "2026-01-01T00:00:00Z",
        expires: "2026-12-31",
      },
      {
        id: "W-002",
        ruleId: "FS-CSS-001",
        paths: ["src/old/**"],
        reason: "Old",
        approvedBy: "human",
        createdAt: "2026-01-01T00:00:00Z",
        expires: "2026-02-01",
      },
    ],
  };

  it("validates the waiver document", () => {
    expect(validateWaivers(doc).ok).toBe(true);
    for (const bad of [
      { ...doc, schemaVersion: 2 },
      { ...doc, waivers: [{ ...doc.waivers[0], expires: "tomorrow" }] },
      { ...doc, waivers: [{ ...doc.waivers[0], approvedBy: "agent" }] },
      { ...doc, waivers: [{ ...doc.waivers[0], id: "X" }] },
      { ...doc, waivers: [{ ...doc.waivers[0], paths: [] }] },
      { ...doc, waivers: [{ ...doc.waivers[0] }, { ...doc.waivers[0] }] },
      { ...doc, waivers: [{ ...doc.waivers[0], extra: 1 }] },
      null,
    ])
      expect(validateWaivers(bad).ok).toBe(false);
  });

  it("separates active and expired waivers by date", () => {
    const result = validateWaivers(doc);
    if (!result.ok) throw new Error("invalid");
    const split = activeWaivers(result.waivers, "2026-06-01");
    expect(split.active.map((w) => w.id)).toEqual(["W-001"]);
    expect(split.expired.map((w) => w.id)).toEqual(["W-002"]);
    expect(activeWaivers(result.waivers, "2026-12-31").active.map((w) => w.id)).toEqual(["W-001"]);
    expect(activeWaivers(result.waivers, "2027-01-01").active).toEqual([]);
  });

  it("matches a finding by rule id and path glob for any severity", () => {
    const result = validateWaivers(doc);
    if (!result.ok) throw new Error("invalid");
    const { active } = activeWaivers(result.waivers, "2026-06-01");
    expect(findWaiver({ ruleId: "FS-CSS-001", file: "src/legacy/a.css" }, active)?.id).toBe(
      "W-001",
    );
    expect(findWaiver({ ruleId: "FS-CSS-001", file: "src/new/a.css" }, active)).toBeUndefined();
    expect(findWaiver({ ruleId: "FS-CSS-002", file: "src/legacy/a.css" }, active)).toBeUndefined();
  });
});
