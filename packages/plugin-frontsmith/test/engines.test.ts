import { describe, expect, it } from "vitest";
import { engines, engineValidators } from "../src/application/engines/index.js";
import { engineIds } from "../src/domain/rules/model.js";

/** Minimal valid params per engine, and the invalid variants each must reject (PCK-006). */
const table: Record<
  string,
  { valid: Record<string, unknown>[]; invalid: Array<[string, Record<string, unknown>, RegExp]> }
> = {
  "css-declaration": {
    valid: [
      { property: "^color$" },
      {
        property: ".",
        important: true,
        notInsideAtRule: "layer",
        unlessFileHasAtRule: "x",
        requireSiblingProperty: { property: "a" },
      },
    ],
    invalid: [
      ["missing property", {}, /property: required/],
      ["bad regex", { property: "(" }, /invalid regex/],
      [
        "bad sibling",
        { property: "a", requireSiblingProperty: { value: "x" } },
        /requireSiblingProperty\.property/,
      ],
      ["unknown param", { property: "a", nope: 1 }, /unknown param/],
      ["non boolean", { property: "a", important: "yes" }, /important/],
    ],
  },
  "css-raw-value": {
    valid: [
      { properties: "^z-index$", kinds: ["integer"] },
      { properties: ".", kinds: ["color", "length"], allow: ["0"], tokenFiles: ["src/**"] },
    ],
    invalid: [
      ["missing kinds", { properties: "." }, /kinds: required/],
      ["unknown kind", { properties: ".", kinds: ["time"] }, /unknown kind/],
      ["bad glob", { properties: ".", kinds: ["color"], tokenFiles: ["!x"] }, /invalid glob/],
      ["bad regex", { properties: "[", kinds: ["color"] }, /invalid regex/],
    ],
  },
  "css-at-rule": {
    valid: [
      { name: "^font-face$" },
      { name: "x", prelude: "y", require: { property: "^font-display$" } },
    ],
    invalid: [
      ["missing name", {}, /name: required/],
      ["bad require", { name: "x", require: {} }, /require\.property/],
    ],
  },
  "css-file-guard": {
    valid: [
      { whenProperty: { property: "a" }, requiresAnywhere: { selector: "b", property: "c" } },
    ],
    invalid: [
      [
        "missing when",
        { requiresAnywhere: { selector: "b", property: "c" } },
        /whenProperty: required/,
      ],
      ["missing requires", { whenProperty: { property: "a" } }, /requiresAnywhere: required/],
      [
        "bad inner regex",
        { whenProperty: { property: "(" }, requiresAnywhere: { selector: "b", property: "c" } },
        /invalid regex/,
      ],
    ],
  },
  "jsx-element": {
    valid: [
      { element: "^div$" },
      {
        element: ".",
        hasAttr: ["a"],
        lacksAttr: ["b"],
        lacksAttrMode: "anyOf",
        attrValue: { name: "a", value: "x" },
        lacksAccessibleName: true,
        insideElement: "p",
        lacksDescendant: "q",
        exemptAttrValue: { names: ["class"], value: "x" },
        includeTemplates: true,
      },
    ],
    invalid: [
      ["missing element", {}, /element: required/],
      ["bad mode", { element: ".", lacksAttrMode: "some" }, /lacksAttrMode/],
      ["bad attrValue", { element: ".", attrValue: { name: "a" } }, /attrValue\.value/],
      ["bad exempt", { element: ".", exemptAttrValue: { value: "x" } }, /exemptAttrValue\.names/],
      ["non string attrs", { element: ".", hasAttr: [1] }, /hasAttr/],
    ],
  },
  "template-element": {
    valid: [{ element: "." }, { blocks: "^@html$" }],
    invalid: [
      ["neither element nor blocks", {}, /element: required/],
      ["bad blocks regex", { blocks: "(" }, /invalid regex/],
    ],
  },
  "jsx-label-association": {
    valid: [{}, { controls: "^input$", requirePlaceholder: true }],
    invalid: [
      ["bad regex", { controls: "(" }, /invalid regex/],
      ["unknown", { x: 1 }, /unknown param/],
    ],
  },
  "aria-attribute": {
    valid: [{ catalog: "aria-1.2" }],
    invalid: [
      ["missing", {}, /catalog: required/],
      ["unknown catalog", { catalog: "aria-9" }, /catalog/],
    ],
  },
  "import-specifier": {
    valid: [{ forbid: "^lodash$" }, { forbid: "x", allow: "y", ignoreTypeOnly: false }],
    invalid: [
      ["missing forbid", {}, /forbid: required/],
      ["bad regex", { forbid: "(" }, /invalid regex/],
    ],
  },
  "class-token": {
    valid: [
      { dynamicInterpolation: true },
      { token: "x" },
      { conflicts: [["p-*", "px-*"]] },
      { cssApply: true, maxApplyPerFile: 3 },
      { requireVariantCounterpart: { variant: "hover", counterparts: ["focus"] } },
    ],
    invalid: [
      ["nothing configured", {}, /no check configured/],
      ["bad conflicts", { conflicts: [["p"]] }, /conflicts/],
      ["apply without max", { cssApply: true }, /maxApplyPerFile/],
      ["bad variant", { requireVariantCounterpart: { variant: "hover" } }, /counterparts/],
    ],
  },
  "component-api": {
    valid: [
      { checks: ["propsTyped"] },
      { checks: ["maxBooleanProps"], maxBooleanProps: 4 },
      { checks: ["forwardRefPrimitives"], forwardRefPrimitives: ["**/ui/**"] },
      {
        checks: [
          "noEffectOnlySetsState",
          "noUnneededUseClient",
          "definePropsTyped",
          "exportLetTyped",
          "noBypassSecurityTrust",
          "onPushRequired",
        ],
      },
    ],
    invalid: [
      ["missing checks", {}, /checks: required/],
      ["unknown check", { checks: ["magic"] }, /unknown check/],
      ["max without number", { checks: ["maxBooleanProps"] }, /maxBooleanProps: required/],
      ["primitives without globs", { checks: ["forwardRefPrimitives"] }, /forwardRefPrimitives/],
    ],
  },
  "file-metric": {
    valid: [
      { metric: "lines", max: 10 },
      { metric: "snapshotAssertions", max: 3, callee: "x" },
    ],
    invalid: [
      ["missing metric", { max: 1 }, /metric: required/],
      ["unknown metric", { metric: "bytes", max: 1 }, /metric/],
      ["missing max", { metric: "lines" }, /max: required/],
      ["negative", { metric: "lines", max: -1 }, /max/],
    ],
  },
  "test-locator": {
    valid: [
      { fragile: true },
      { fragile: "x" },
      { forbidCalls: "x" },
      { requireAssertions: true },
      { flagWithoutAlternative: { call: "a", alternatives: "b" } },
    ],
    invalid: [
      ["nothing", {}, /no check configured/],
      ["bad regex", { forbidCalls: "(" }, /invalid regex/],
      ["bad flag", { flagWithoutAlternative: { call: "a" } }, /alternatives/],
    ],
  },
  "package-json": {
    valid: [
      { scriptsForbid: "x" },
      { dependencyForbid: "x" },
      { requireDeclaredImports: true },
      { fileContent: "x", minTailwindMajor: 4 },
      { jsonLiteralCountMax: { key: "safelist", max: 20 } },
    ],
    invalid: [
      ["nothing", {}, /no check configured/],
      ["bad regex", { scriptsForbid: "(" }, /invalid regex/],
      ["bad literal", { jsonLiteralCountMax: { key: "x" } }, /max: required/],
    ],
  },
  "token-file": {
    valid: [
      { naming: "^--x" },
      { forbidNames: "x" },
      { themeParity: true },
      { unused: true },
      { undefinedRefs: true },
    ],
    invalid: [
      ["nothing", {}, /no check configured/],
      ["bad regex", { naming: "(" }, /invalid regex/],
      ["non boolean", { unused: "yes" }, /unused/],
    ],
  },
  "token-pair-contrast": {
    valid: [{ target: "AA" }, { target: "AAA", margin: 0.5 }],
    invalid: [
      ["missing target", {}, /target: required/],
      ["bad target", { target: "A" }, /target/],
      ["negative margin", { target: "AA", margin: -1 }, /margin/],
    ],
  },
  "diff-guard": {
    valid: [{ guard: "protected" }, { guard: "snapshots", globs: ["**/*.snap"] }],
    invalid: [
      ["missing guard", {}, /guard: required/],
      ["unknown guard", { guard: "all" }, /guard/],
      ["bad glob", { guard: "scope", globs: ["!x"] }, /invalid glob/],
    ],
  },
  architecture: {
    valid: [{ check: "direction" }, { check: "cycles" }],
    invalid: [
      ["missing check", {}, /check: required/],
      ["unknown check", { check: "everything" }, /check/],
    ],
  },
  budget: {
    valid: [{ kind: "initialJs" }, { kind: "fontDisplay" }],
    invalid: [
      ["missing kind", {}, /kind: required/],
      ["unknown kind", { kind: "ram" }, /kind/],
    ],
  },
  advisory: {
    valid: [{ guidance: "text" }],
    invalid: [
      ["missing guidance", {}, /guidance: required/],
      ["empty guidance", { guidance: "" }, /guidance/],
    ],
  },
};

describe("engine registry", () => {
  it("is the closed set of twenty engine ids", () => {
    expect(engineIds).toHaveLength(20);
    expect(Object.keys(engines).sort()).toEqual([...engineIds].sort());
    for (const id of engineIds) {
      expect(engines[id].id).toBe(id);
      expect(typeof engineValidators[id]).toBe("function");
    }
  });

  it("has a parameter table entry for every engine", () => {
    expect(Object.keys(table).sort()).toEqual([...engineIds].sort());
  });
});

describe.each(Object.entries(table))("%s parameter validation", (id, { valid, invalid }) => {
  const engine = engines[id as keyof typeof engines];

  it.each(valid.map((params, index) => [index, params] as const))(
    "accepts valid params #%s",
    (_index, params) => {
      expect(engine.validateParams(params)).toEqual([]);
    },
  );

  it.each(invalid)("rejects %s", (_name, params, message) => {
    const problems = engine.validateParams(params);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("; ")).toMatch(message);
  });

  it("accepts the common excludeFiles param and rejects a bad glob in it", () => {
    const base = valid[0] as Record<string, unknown>;
    expect(engine.validateParams({ ...base, excludeFiles: ["**/legacy/**"] })).toEqual([]);
    expect(engine.validateParams({ ...base, excludeFiles: ["!x"] }).join()).toMatch(/excludeFiles/);
  });
});

describe("token-pair-contrast REVIEW outcome (spec 12.1)", () => {
  const run = (values: Record<string, Record<string, string>>) =>
    engines["token-pair-contrast"].run({
      params: { target: "AA" },
      tokens: {
        path: "tokens.json",
        values,
        pairs: [{ fg: "--fg", bg: "--bg", kind: "normal_text" }],
      },
    } as never) as { findings: Array<{ review?: boolean; detail?: string }> };

  it("reports an unsupported colour format as a REVIEW finding, not a blocker", () => {
    const { findings } = run({
      "--fg": { light: "oklch(20% 0 0)" },
      "--bg": { light: "#FFFFFF" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.review).toBe(true);
    expect(findings[0]?.detail).toContain("unsupported color format");
  });

  it("keeps a failing supported pair a regular finding", () => {
    const { findings } = run({ "--fg": { light: "#777777" }, "--bg": { light: "#FFFFFF" } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.review).toBeUndefined();
  });

  it("keeps parseColor importable from domain/color/contrast.js", async () => {
    const mod = await import("../src/domain/color/contrast.js");
    expect(typeof mod.parseColor).toBe("function");
    expect(mod.parseColor("hsl(0 0% 0%)")).toBeUndefined();
  });
});
