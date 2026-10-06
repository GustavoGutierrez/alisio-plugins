import { type EnvelopeResult, isSafeRelativePath, openEnvelope } from "./parse.js";
import { type TestLevel, testLevels } from "./test-map.js";

export const componentActions = ["new", "modify", "reuse"] as const;
export const atomicLevels = ["atom", "molecule", "organism", "template", "page", "none"] as const;
export const componentRoles = [
  "presentational",
  "container",
  "hook",
  "store",
  "service",
  "page",
  "layout",
  "util",
] as const;
export const stateOwners = ["local", "shared", "server-cache", "url", "form"] as const;
export const riskCategories = [
  "security",
  "privacy",
  "performance",
  "a11y",
  "compat",
  "delivery",
] as const;
export const tddModes = ["required", "exempt"] as const;
const LAYER = /^[a-z][a-z0-9-]{1,30}$/;

export interface PlanTask {
  id: string;
  title: string;
  goal: string;
  layer: string;
  files: string[];
  acceptanceCriteria: string[];
  tests: Array<{ path: string; level: TestLevel }>;
  validation: string[];
  constraints: string[];
  dependsOn: string[];
  stopConditions: string[];
  tdd: (typeof tddModes)[number];
  tddExemptReason: string | null;
}

export interface PlanEnvelope {
  schemaVersion: 1;
  kind: "plan";
  summary: string;
  components: Array<{
    name: string;
    path: string;
    action: (typeof componentActions)[number];
    atomicLevel: (typeof atomicLevels)[number];
    role: (typeof componentRoles)[number];
    patterns: string[];
    props: Array<{ name: string; type: string; required: boolean }>;
    imports: string[];
  }>;
  state: Array<{
    name: string;
    owner: (typeof stateOwners)[number];
    tool: string;
    location: string;
  }>;
  dataFlow: string[];
  contracts: Array<{ kind: string; file: string; operations: string[] }>;
  errors: Array<{ operation: string; cases: string[] }>;
  dependencies: Array<{ name: string; version: string; reason: string }>;
  adrs: Array<{
    id: string;
    title: string;
    context: string;
    decision: string;
    consequences: string;
  }>;
  risks: Array<{ category: (typeof riskCategories)[number]; text: string }>;
  /** `null` or a full architecture config proposal; `parseArchitectureConfig` checks it at G3. */
  architectureConfig: Record<string, unknown> | null;
  tasks: PlanTask[];
}

const KEYS = [
  "summary",
  "components",
  "state",
  "dataFlow",
  "contracts",
  "errors",
  "dependencies",
  "adrs",
  "risks",
  "architectureConfig",
  "tasks",
] as const;

/**
 * Structural validation of a `PlanEnvelope`. At L1 the code accepts empty `components`, `state`,
 * `contracts`, `errors`, `adrs`, `risks` and `dependencies` (B-13): the arrays are always allowed to
 * be empty here and the level-specific minimums belong to gate G3.
 */
export function validatePlan(raw: unknown): EnvelopeResult<PlanEnvelope> {
  const { check, root } = openEnvelope(raw, "plan", KEYS);
  if (!root) return check.result(undefined as never);

  const components = check.array(root, "components", "", (item, at) => {
    const c = check.object(item, at, [
      "name",
      "path",
      "action",
      "atomicLevel",
      "role",
      "patterns",
      "props",
      "imports",
    ]);
    if (!c) return undefined;
    return {
      name: check.string(c, "name", at, { max: 80 }) ?? "",
      path: check.path(c, "path", at) ?? "",
      action: check.enum(c, "action", at, componentActions) ?? "new",
      atomicLevel: check.enum(c, "atomicLevel", at, atomicLevels) ?? "none",
      role: check.enum(c, "role", at, componentRoles) ?? "presentational",
      patterns: check.strings(c, "patterns", at, {
        optional: true,
        pattern: /^PAT-[A-Z0-9-]{2,30}$/,
      }),
      props: check.array(
        c,
        "props",
        at,
        (prop, propAt) => {
          const p = check.object(prop, propAt, ["name", "type", "required"]);
          if (!p) return undefined;
          return {
            name: check.string(p, "name", propAt, { max: 60 }) ?? "",
            type: check.string(p, "type", propAt, { max: 200 }) ?? "",
            required: check.bool(p, "required", propAt) ?? false,
          };
        },
        { optional: true },
      ),
      imports: check.strings(c, "imports", at, { optional: true, path: true }),
    };
  });

  const state = check.array(root, "state", "", (item, at) => {
    const s = check.object(item, at, ["name", "owner", "tool", "location"]);
    if (!s) return undefined;
    return {
      name: check.string(s, "name", at, { max: 80 }) ?? "",
      owner: check.enum(s, "owner", at, stateOwners) ?? "local",
      tool: check.string(s, "tool", at, { max: 120, allowEmpty: true }) ?? "",
      location: check.path(s, "location", at) ?? "",
    };
  });

  const contracts = check.array(root, "contracts", "", (item, at) => {
    const c = check.object(item, at, ["kind", "file", "operations"]);
    if (!c) return undefined;
    return {
      kind: check.string(c, "kind", at, { max: 30 }) ?? "",
      file: check.path(c, "file", at) ?? "",
      operations: check.strings(c, "operations", at, { optional: true }),
    };
  });

  const errors = check.array(root, "errors", "", (item, at) => {
    const e = check.object(item, at, ["operation", "cases"]);
    if (!e) return undefined;
    return {
      operation: check.string(e, "operation", at, { max: 120 }) ?? "",
      cases: check.strings(e, "cases", at),
    };
  });

  const dependencies = check.array(root, "dependencies", "", (item, at) => {
    const d = check.object(item, at, ["name", "version", "reason"]);
    if (!d) return undefined;
    return {
      name: check.string(d, "name", at, { max: 214 }) ?? "",
      version: check.string(d, "version", at, { max: 100 }) ?? "",
      reason: check.string(d, "reason", at) ?? "",
    };
  });

  const adrs = check.array(root, "adrs", "", (item, at) => {
    const a = check.object(item, at, ["id", "title", "context", "decision", "consequences"]);
    if (!a) return undefined;
    return {
      id: check.id(a, "id", at, "adr") ?? "",
      title: check.string(a, "title", at, { max: 200 }) ?? "",
      context: check.string(a, "context", at) ?? "",
      decision: check.string(a, "decision", at) ?? "",
      consequences: check.string(a, "consequences", at) ?? "",
    };
  });
  check.unique(adrs, "/adrs");

  const risks = check.array(root, "risks", "", (item, at) => {
    const r = check.object(item, at, ["category", "text"]);
    if (!r) return undefined;
    return {
      category: check.enum(r, "category", at, riskCategories) ?? "delivery",
      text: check.string(r, "text", at) ?? "",
    };
  });

  let architectureConfig: PlanEnvelope["architectureConfig"] = null;
  if (root.architectureConfig !== null && root.architectureConfig !== undefined) {
    const holder = root.architectureConfig;
    if (typeof holder !== "object" || Array.isArray(holder))
      check.fail("/architectureConfig", "must be null or an architecture config object");
    else architectureConfig = holder as Record<string, unknown>;
  }

  const tasks = check.array(
    root,
    "tasks",
    "",
    (item, at): PlanTask | undefined => {
      const t = check.object(item, at, [
        "id",
        "title",
        "goal",
        "layer",
        "files",
        "acceptanceCriteria",
        "tests",
        "validation",
        "constraints",
        "dependsOn",
        "stopConditions",
        "tdd",
        "tddExemptReason",
      ]);
      if (!t) return undefined;
      const tdd = check.enum(t, "tdd", at, tddModes) ?? "required";
      const reason = check.string(t, "tddExemptReason", at, { nullable: true, optional: true });
      if (tdd === "exempt" && (reason === undefined || reason.trim() === ""))
        check.fail(`${at}/tddExemptReason`, "is required when tdd is exempt");
      return {
        id: check.id(t, "id", at, "task") ?? "",
        title: check.string(t, "title", at, { max: 200 }) ?? "",
        goal: check.string(t, "goal", at) ?? "",
        layer: check.string(t, "layer", at, { pattern: LAYER }) ?? "ui",
        files: check.strings(t, "files", at, { path: true }),
        acceptanceCriteria: check.strings(t, "acceptanceCriteria", at, { pattern: /^AC-\d{2,3}$/ }),
        tests: check.array(
          t,
          "tests",
          at,
          (test, testAt) => {
            const x = check.object(test, testAt, ["path", "level"]);
            if (!x) return undefined;
            const level = x.level;
            if (typeof level !== "string" || !(testLevels as readonly string[]).includes(level)) {
              check.fail(`${testAt}/level`, `must be one of ${testLevels.join(", ")}`);
              return undefined;
            }
            return { path: check.path(x, "path", testAt) ?? "", level: level as TestLevel };
          },
          { optional: true },
        ),
        validation: check.strings(t, "validation", at, { optional: true }),
        constraints: check.strings(t, "constraints", at, { optional: true }),
        dependsOn: check.strings(t, "dependsOn", at, { optional: true, pattern: /^T-\d{3}$/ }),
        stopConditions: check.strings(t, "stopConditions", at, { optional: true }),
        tdd,
        tddExemptReason: reason ?? null,
      };
    },
    { min: 1 },
  );
  check.unique(tasks, "/tasks");
  for (const [index, task] of tasks.entries())
    for (const file of task.files)
      if (!isSafeRelativePath(file)) check.fail(`/tasks/${index}/files`, `unsafe path ${file}`);

  return check.result({
    schemaVersion: 1,
    kind: "plan",
    summary: check.string(root, "summary", "") ?? "",
    components,
    state,
    dataFlow: check.strings(root, "dataFlow", "", { optional: true }),
    contracts,
    errors,
    dependencies,
    adrs,
    risks,
    architectureConfig,
    tasks,
  });
}
