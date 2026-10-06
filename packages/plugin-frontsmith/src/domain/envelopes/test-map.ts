import { type EnvelopeResult, openEnvelope } from "./parse.js";

export const testLevels = [
  "unit",
  "component",
  "integration",
  "e2e",
  "visual",
  "a11y",
  "perf",
  "manual",
] as const;
export type TestLevel = (typeof testLevels)[number];

export interface TestMapEnvelope {
  schemaVersion: 1;
  kind: "test-map";
  entries: Array<{
    acId: string;
    risk: string;
    levels: TestLevel[];
    tests: Array<{ path: string; name: string; level: TestLevel }>;
    evidence: string;
    manual: { procedure: string; justification: string } | null;
  }>;
}

export function validateTestMap(raw: unknown): EnvelopeResult<TestMapEnvelope> {
  const { check, root } = openEnvelope(raw, "test-map", ["entries"]);
  if (!root) return check.result(undefined as never);
  const entries = check.array(root, "entries", "", (item, at) => {
    const entry = check.object(item, at, ["acId", "risk", "levels", "tests", "evidence", "manual"]);
    if (!entry) return undefined;
    const levels = check.array(entry, "levels", at, (level, levelAt) => {
      if (typeof level === "string" && (testLevels as readonly string[]).includes(level))
        return level as TestLevel;
      check.fail(levelAt, `must be one of ${testLevels.join(", ")}`);
      return undefined;
    });
    const tests = check.array(entry, "tests", at, (test, testAt) => {
      const t = check.object(test, testAt, ["path", "name", "level"]);
      if (!t) return undefined;
      return {
        path: check.path(t, "path", testAt) ?? "",
        name: check.string(t, "name", testAt) ?? "",
        level: check.enum(t, "level", testAt, testLevels) ?? "unit",
      };
    });
    let manual: { procedure: string; justification: string } | null = null;
    if (entry.manual !== null && entry.manual !== undefined) {
      const m = check.object(entry.manual, `${at}/manual`, ["procedure", "justification"]);
      if (m)
        manual = {
          procedure: check.string(m, "procedure", `${at}/manual`) ?? "",
          justification: check.string(m, "justification", `${at}/manual`) ?? "",
        };
    }
    return {
      acId: check.id(entry, "acId", at, "acceptance") ?? "",
      risk: check.string(entry, "risk", at) ?? "",
      levels,
      tests,
      evidence: check.string(entry, "evidence", at, { allowEmpty: true }) ?? "",
      manual,
    };
  });
  return check.result({ schemaVersion: 1, kind: "test-map", entries });
}
