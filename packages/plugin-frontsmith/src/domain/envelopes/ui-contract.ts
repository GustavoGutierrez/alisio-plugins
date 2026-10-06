import { type EnvelopeResult, type OpenQuestion, openEnvelope, readQuestions } from "./parse.js";

export const uiModes = ["replicate", "refine", "redesign", "build"] as const;
export const ruleKinds = [
  "geometry",
  "relation",
  "typography",
  "color",
  "content",
  "asset",
  "overflow",
  "visual",
  "focus",
] as const;
export type FidelityRuleKind = (typeof ruleKinds)[number];

/** Allowed `property` values per rule kind (spec 9.2). */
export const propertiesByKind: Readonly<Record<FidelityRuleKind, readonly string[]>> = {
  geometry: ["x", "y", "width", "height"],
  relation: [
    "gapVertical",
    "gapHorizontal",
    "alignLeft",
    "alignTop",
    "alignRight",
    "columns",
    "sameWidth",
  ],
  typography: ["fontSize", "lineHeight", "fontWeight", "letterSpacing", "fontFamily", "lineCount"],
  color: ["color", "backgroundColor", "borderColor"],
  content: ["text", "presence", "absence"],
  asset: ["sha256", "naturalSize"],
  overflow: ["pageHorizontal", "clipped"],
  visual: ["regionDiff"],
  focus: ["visible", "order"],
};

export const fidelitySeverities = ["blocking", "major", "minor"] as const;
export const provenances = ["specified", "measured", "inferred", "pending"] as const;
export const verifications = [
  "computed_style",
  "bounding_box",
  "relation",
  "content",
  "asset_hash",
  "overflow",
  "region_diff",
  "focus_probe",
] as const;
export const reuseKinds = ["reuse", "extend", "new"] as const;
export const testLevelsUi = [
  "unit",
  "component",
  "integration",
  "e2e",
  "visual",
  "a11y",
  "manual",
] as const;

const ELEMENT = /^[a-z][a-z0-9-]{1,47}$/;
const VIEWPORT_LIMIT = 10_000;

export interface Locator {
  role?: string;
  name?: string;
  testId?: string;
  css?: string;
  label?: string;
  text?: string;
}

export interface UiContractEnvelope {
  schemaVersion: 1;
  kind: "ui-contract";
  mode: (typeof uiModes)[number];
  surfaces: Array<{ id: string; route: string; purpose: string }>;
  stateMatrix: Array<{
    stateId: string;
    trigger: string;
    ui: string;
    actions: string[];
    a11y: string;
    testLevel: string[];
  }>;
  viewports: Array<[number, number]>;
  breakpoints: Array<{ name: string; maxWidth?: number; minWidth?: number }>;
  elements: Array<{ id: string; locator: Locator; critical: boolean }>;
  componentMap: Array<{ design: string; code: string; reuse: (typeof reuseKinds)[number] }>;
  interactions: Array<{ elementId: string; on: string; result: string; keyboard: string }>;
  focusOrder: string[];
  fidelityRules: Array<{
    id: string;
    requirement: string;
    kind: FidelityRuleKind;
    subject: string;
    object?: string;
    property: string;
    expected: string | number | boolean;
    unit?: string;
    tolerance: number;
    severity: (typeof fidelitySeverities)[number];
    provenance: (typeof provenances)[number];
    verification: (typeof verifications)[number];
  }>;
  typography: Array<{
    elementId: string;
    fontSize: string;
    lineHeight: string;
    fontWeight: number;
  }>;
  regions: Array<{ id: string; elementId: string; critical: boolean }>;
  masks: Array<{ selector: string; reason: string; elementId: string | null }>;
  cases: Array<{
    id: string;
    surfaceId: string;
    stateId: string;
    viewport: [number, number];
    theme: "light" | "dark";
    setup: { query?: string; path?: string; localStorage?: Record<string, string> };
  }>;
  tokensNeeded: Array<{ name: string; role: string; status: "existing" | "new" }>;
  references: Array<{ file: string; caseId: string }>;
  questions: OpenQuestion[];
}

const KEYS = [
  "mode",
  "surfaces",
  "stateMatrix",
  "viewports",
  "breakpoints",
  "elements",
  "componentMap",
  "interactions",
  "focusOrder",
  "fidelityRules",
  "typography",
  "regions",
  "masks",
  "cases",
  "tokensNeeded",
  "references",
  "questions",
] as const;

/**
 * Structural validation of a `UiContractEnvelope`. The `render`, `unknownBackground`,
 * `allowedOrigins` and `calibration` keys are code- or human-owned (B-15) and rejected here as
 * unknown keys; gate G2 checks the cross references (spec 7.2).
 */
export function validateUiContract(raw: unknown): EnvelopeResult<UiContractEnvelope> {
  const { check, root } = openEnvelope(raw, "ui-contract", KEYS);
  if (!root) return check.result(undefined as never);

  const viewport = (item: unknown, at: string): [number, number] | undefined => {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      !item.every((n) => Number.isInteger(n) && n >= 1 && n <= VIEWPORT_LIMIT)
    ) {
      check.fail(at, "must be [width, height] in whole CSS pixels");
      return undefined;
    }
    return [item[0] as number, item[1] as number];
  };

  const surfaces = check.array(root, "surfaces", "", (item, at) => {
    const s = check.object(item, at, ["id", "route", "purpose"]);
    if (!s) return undefined;
    return {
      id: check.string(s, "id", at, { pattern: ELEMENT }) ?? "",
      route: check.string(s, "route", at, { max: 300 }) ?? "",
      purpose: check.string(s, "purpose", at, { max: 200 }) ?? "",
    };
  });
  check.unique(surfaces, "/surfaces");

  const stateMatrix = check.array(root, "stateMatrix", "", (item, at) => {
    const row = check.object(item, at, [
      "stateId",
      "trigger",
      "ui",
      "actions",
      "a11y",
      "testLevel",
    ]);
    if (!row) return undefined;
    return {
      stateId: check.id(row, "stateId", at, "state") ?? "",
      trigger: check.string(row, "trigger", at) ?? "",
      ui: check.string(row, "ui", at) ?? "",
      actions: check.strings(row, "actions", at, { optional: true }),
      a11y: check.string(row, "a11y", at, { allowEmpty: true }) ?? "",
      testLevel: check.array(
        row,
        "testLevel",
        at,
        (level, levelAt) => {
          if (typeof level === "string" && (testLevelsUi as readonly string[]).includes(level))
            return level;
          check.fail(levelAt, `must be one of ${testLevelsUi.join(", ")}`);
          return undefined;
        },
        { min: 1 },
      ),
    };
  });

  const viewports = check.array(root, "viewports", "", viewport, { min: 1 });

  const breakpoints = check.array(root, "breakpoints", "", (item, at) => {
    const b = check.object(item, at, ["name", "maxWidth", "minWidth"]);
    if (!b) return undefined;
    const maxWidth = check.number(b, "maxWidth", at, { integer: true, min: 1, optional: true });
    const minWidth = check.number(b, "minWidth", at, { integer: true, min: 1, optional: true });
    if (maxWidth === undefined && minWidth === undefined)
      check.fail(at, "needs maxWidth or minWidth");
    return {
      name: check.string(b, "name", at, { max: 60 }) ?? "",
      ...(maxWidth !== undefined ? { maxWidth } : {}),
      ...(minWidth !== undefined ? { minWidth } : {}),
    };
  });

  const elements = check.array(root, "elements", "", (item, at) => {
    const e = check.object(item, at, ["id", "locator", "critical"]);
    if (!e) return undefined;
    const locatorAt = `${at}/locator`;
    const l = check.object(e.locator, locatorAt, [
      "role",
      "name",
      "testId",
      "css",
      "label",
      "text",
    ]);
    const locator: Locator = {};
    if (l) {
      for (const key of ["role", "name", "testId", "css", "label", "text"] as const) {
        const value = check.string(l, key, locatorAt, { optional: true, max: 300 });
        if (value !== undefined) locator[key] = value;
      }
      const primary = ["role", "testId", "css", "label", "text"].filter(
        (key) => locator[key as keyof Locator] !== undefined,
      );
      if (primary.length !== 1)
        check.fail(locatorAt, "needs exactly one of role, testId, css, label or text");
      if (locator.name !== undefined && locator.role === undefined)
        check.fail(`${locatorAt}/name`, "is only valid together with role");
    }
    return {
      id: check.string(e, "id", at, { pattern: ELEMENT }) ?? "",
      locator,
      critical: check.bool(e, "critical", at, true) ?? false,
    };
  });
  check.unique(elements, "/elements");

  const componentMap = check.array(root, "componentMap", "", (item, at) => {
    const c = check.object(item, at, ["design", "code", "reuse"]);
    if (!c) return undefined;
    return {
      design: check.string(c, "design", at, { max: 120 }) ?? "",
      code: check.path(c, "code", at) ?? "",
      reuse: check.enum(c, "reuse", at, reuseKinds) ?? "new",
    };
  });

  const interactions = check.array(root, "interactions", "", (item, at) => {
    const i = check.object(item, at, ["elementId", "on", "result", "keyboard"]);
    if (!i) return undefined;
    return {
      elementId: check.string(i, "elementId", at, { pattern: ELEMENT }) ?? "",
      on: check.string(i, "on", at, { max: 60 }) ?? "",
      result: check.string(i, "result", at) ?? "",
      keyboard: check.string(i, "keyboard", at, { allowEmpty: true, max: 200 }) ?? "",
    };
  });

  const fidelityRules = check.array(root, "fidelityRules", "", (item, at) => {
    const r = check.object(item, at, [
      "id",
      "requirement",
      "kind",
      "subject",
      "object",
      "property",
      "expected",
      "unit",
      "tolerance",
      "severity",
      "provenance",
      "verification",
    ]);
    if (!r) return undefined;
    const kind = check.enum(r, "kind", at, ruleKinds) ?? "geometry";
    const property = check.string(r, "property", at, { max: 40 }) ?? "";
    if (property && !propertiesByKind[kind].includes(property))
      check.fail(`${at}/property`, `${property} is not a ${kind} property`);
    const expected = r.expected;
    if (
      typeof expected !== "string" &&
      typeof expected !== "number" &&
      typeof expected !== "boolean"
    )
      check.fail(`${at}/expected`, "must be a string, number or boolean");
    const object = check.string(r, "object", at, { optional: true, pattern: ELEMENT });
    const unit = check.string(r, "unit", at, { optional: true, max: 20 });
    return {
      id: check.id(r, "id", at, "fidelityRule") ?? "",
      requirement: check.string(r, "requirement", at) ?? "",
      kind,
      subject: check.string(r, "subject", at, { pattern: ELEMENT }) ?? "",
      ...(object !== undefined ? { object } : {}),
      property,
      expected:
        typeof expected === "string" ||
        typeof expected === "number" ||
        typeof expected === "boolean"
          ? expected
          : "",
      ...(unit !== undefined ? { unit } : {}),
      tolerance: check.number(r, "tolerance", at, { min: 0 }) ?? 0,
      severity: check.enum(r, "severity", at, fidelitySeverities) ?? "major",
      provenance: check.enum(r, "provenance", at, provenances) ?? "pending",
      verification: check.enum(r, "verification", at, verifications) ?? "bounding_box",
    };
  });
  check.unique(fidelityRules, "/fidelityRules");

  const typography = check.array(root, "typography", "", (item, at) => {
    const t = check.object(item, at, ["elementId", "fontSize", "lineHeight", "fontWeight"]);
    if (!t) return undefined;
    return {
      elementId: check.string(t, "elementId", at, { pattern: ELEMENT }) ?? "",
      fontSize: check.string(t, "fontSize", at, { max: 20 }) ?? "",
      lineHeight: check.string(t, "lineHeight", at, { max: 20 }) ?? "",
      fontWeight: check.number(t, "fontWeight", at, { integer: true, min: 1, max: 1000 }) ?? 400,
    };
  });

  const regions = check.array(root, "regions", "", (item, at) => {
    const r = check.object(item, at, ["id", "elementId", "critical"]);
    if (!r) return undefined;
    return {
      id: check.string(r, "id", at, { pattern: ELEMENT }) ?? "",
      elementId: check.string(r, "elementId", at, { pattern: ELEMENT }) ?? "",
      critical: check.bool(r, "critical", at, true) ?? false,
    };
  });
  check.unique(regions, "/regions");

  const masks = check.array(root, "masks", "", (item, at) => {
    const m = check.object(item, at, ["selector", "reason", "elementId"]);
    if (!m) return undefined;
    return {
      selector: check.string(m, "selector", at, { max: 300 }) ?? "",
      reason: check.string(m, "reason", at) ?? "",
      elementId: check.string(m, "elementId", at, { nullable: true, pattern: ELEMENT }) ?? null,
    };
  });

  const cases = check.array(root, "cases", "", (item, at) => {
    const c = check.object(item, at, ["id", "surfaceId", "stateId", "viewport", "theme", "setup"]);
    if (!c) return undefined;
    // `storyId` is reserved and rejected in v1 (spec 9.2): the closed key list does the rejecting.
    const setupAt = `${at}/setup`;
    const setupRaw = check.object(c.setup, setupAt, ["query", "path", "localStorage"]);
    const setup: UiContractEnvelope["cases"][number]["setup"] = {};
    if (setupRaw) {
      const query = check.string(setupRaw, "query", setupAt, { optional: true, max: 300 });
      if (query !== undefined) {
        if (!query.startsWith("?")) check.fail(`${setupAt}/query`, "must start with ?");
        setup.query = query;
      }
      const path = check.string(setupRaw, "path", setupAt, { optional: true, max: 300 });
      if (path !== undefined) {
        if (!path.startsWith("/") || path.includes("//") || path.includes(".."))
          check.fail(`${setupAt}/path`, "must be an absolute route without '..'");
        setup.path = path;
      }
      if (setupRaw.localStorage !== undefined) {
        const holder = setupRaw.localStorage;
        if (typeof holder !== "object" || holder === null || Array.isArray(holder))
          check.fail(`${setupAt}/localStorage`, "must be an object of strings");
        else {
          const out: Record<string, string> = {};
          for (const [key, value] of Object.entries(holder)) {
            if (typeof value !== "string")
              check.fail(`${setupAt}/localStorage/${key}`, "must be a string");
            else out[key] = value;
          }
          setup.localStorage = out;
        }
      }
    }
    const theme = check.enum(c, "theme", at, ["light", "dark"] as const) ?? "light";
    return {
      id: check.string(c, "id", at, { pattern: ELEMENT }) ?? "",
      surfaceId: check.string(c, "surfaceId", at, { pattern: ELEMENT }) ?? "",
      stateId: check.id(c, "stateId", at, "state") ?? "",
      viewport: viewport(c.viewport, `${at}/viewport`) ?? [0, 0],
      theme,
      setup,
    };
  });
  check.unique(cases, "/cases");

  const tokensNeeded = check.array(root, "tokensNeeded", "", (item, at) => {
    const t = check.object(item, at, ["name", "role", "status"]);
    if (!t) return undefined;
    return {
      name: check.string(t, "name", at, { pattern: /^--[a-z][a-z0-9-]{1,79}$/ }) ?? "",
      role: check.string(t, "role", at, { max: 200 }) ?? "",
      status: check.enum(t, "status", at, ["existing", "new"] as const) ?? "new",
    };
  });

  const references = check.array(root, "references", "", (item, at) => {
    const r = check.object(item, at, ["file", "caseId"]);
    if (!r) return undefined;
    const file = check.string(r, "file", at, { max: 200 }) ?? "";
    if (file && (file.includes("/") || file.includes("\\") || file.includes("..")))
      check.fail(`${at}/file`, "must be a file name inside the feature's reference folder");
    return {
      file,
      caseId: check.string(r, "caseId", at, { pattern: ELEMENT }) ?? "",
    };
  });

  return check.result({
    schemaVersion: 1,
    kind: "ui-contract",
    mode: check.enum(root, "mode", "", uiModes) ?? "build",
    surfaces,
    stateMatrix,
    viewports,
    breakpoints,
    elements,
    componentMap,
    interactions,
    focusOrder: check.strings(root, "focusOrder", "", { optional: true }),
    fidelityRules,
    typography,
    regions,
    masks,
    cases,
    tokensNeeded,
    references,
    questions: readQuestions(check, root, "questions"),
  });
}
