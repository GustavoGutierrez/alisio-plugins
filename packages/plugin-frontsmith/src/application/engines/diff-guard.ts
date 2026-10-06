import { compileGlob, matchAny } from "../../domain/glob.js";
import { parseSuppressions } from "../../domain/rules/suppressions.js";
import type { UnitChange, UnitContext } from "../../domain/rules/unit.js";
import type { FileAnalyzer } from "../ports/file-analyzer.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const GUARDS = [
  "protected",
  "suppressions",
  "testWeakening",
  "dependencies",
  "scope",
  "lockfile",
  "snapshots",
] as const;
type Guard = (typeof GUARDS)[number];
const PARAMS = ["guard", "globs", "testGlobs"] as const;
const DEFAULT_TEST_GLOBS = [
  "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "e2e/**",
  "tests/**",
  "cypress/**",
];
const DEFAULT_SNAPSHOT_GLOBS = [
  "**/__snapshots__/**",
  "**/*-snapshots/**",
  ".frontsmith/baselines/**",
];
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
]);
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const WEAKENING_CALL = /(?:^|\.)(?:skip|only|todo|fixme)$|^(?:xit|fit|xtest|xdescribe|fdescribe)$/;
const ASSERTION_CALL =
  /^(?:expect|assert)(?:\.|$)|(?:^|\.)(?:toHaveScreenshot|toMatchAriaSnapshot)$/;
const THRESHOLD = /\b(lines|functions|branches|statements)["']?\s*:\s*(\d+(?:\.\d+)?)/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function parseManifest(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dependencyChanges(change: UnitChange, approved: ReadonlySet<string>): string[] {
  const before = parseManifest(change.before);
  const after = parseManifest(change.after);
  const names: string[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const a = isRecord(before[section]) ? (before[section] as Record<string, unknown>) : {};
    const b = isRecord(after[section]) ? (after[section] as Record<string, unknown>) : {};
    for (const name of Object.keys(b))
      if (a[name] !== b[name] && !approved.has(name)) names.push(`${section}.${name}`);
  }
  return names;
}

function scriptChanges(change: UnitChange): string[] {
  const before = parseManifest(change.before);
  const after = parseManifest(change.after);
  const a = isRecord(before.scripts) ? (before.scripts as Record<string, unknown>) : {};
  const b = isRecord(after.scripts) ? (after.scripts as Record<string, unknown>) : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((name) => a[name] !== b[name])
    .sort();
}

function assertionCount(
  analyzer: FileAnalyzer,
  path: string,
  text: string | undefined,
): { assertions: number; weakening: number; names: string[] } {
  if (text === undefined) return { assertions: 0, weakening: 0, names: [] };
  const analysis = analyzer.analyze(path, text);
  const calls = analysis.scripts.flatMap((piece) => piece.view.calls);
  return {
    assertions: calls.filter((call) => ASSERTION_CALL.test(call.callee)).length,
    weakening: calls.filter((call) => WEAKENING_CALL.test(call.callee)).length,
    names: analysis.scripts.flatMap((piece) => piece.view.testCases.map((test) => test.name)),
  };
}

type GuardRunner = (
  unit: UnitContext,
  params: { globs?: string[]; testGlobs: string[] },
  analyzer: FileAnalyzer,
) => RawFinding[];

const at = (file: string, detail: string): RawFinding => ({ file, line: 1, column: 1, detail });

const RUNNERS: Record<Guard, GuardRunner> = {
  protected(unit, params) {
    const globs = [".frontsmith/**", ...unit.protectedGlobs, ...(params.globs ?? [])];
    const approved = new Set(unit.approvedDependencies);
    const findings: RawFinding[] = [];
    for (const change of unit.changes) {
      if (matchAny(globs, change.path))
        findings.push(at(change.path, `${change.path} is a protected file`));
      if (baseName(change.path) === "package.json") {
        for (const name of scriptChanges(change))
          findings.push(at(change.path, `package.json script "${name}" changed`));
        for (const name of dependencyChanges(change, approved))
          findings.push(at(change.path, `package.json ${name} changed`));
      }
    }
    return findings;
  },
  suppressions(unit, _params, analyzer) {
    const findings: RawFinding[] = [];
    for (const change of unit.changes) {
      if (change.after === undefined) continue;
      const read = (text: string | undefined) =>
        text === undefined ? [] : parseSuppressions(analyzer.analyze(change.path, text).comments);
      const before = new Map<string, number>();
      for (const s of read(change.before))
        before.set(`${s.ruleId}\0${s.reason}`, (before.get(`${s.ruleId}\0${s.reason}`) ?? 0) + 1);
      for (const s of read(change.after)) {
        const key = `${s.ruleId}\0${s.reason}`;
        const remaining = before.get(key) ?? 0;
        if (remaining > 0) {
          before.set(key, remaining - 1);
          continue;
        }
        const rule = unit.rules[s.ruleId];
        const policyOk =
          rule === undefined ||
          (rule.suppressible && (rule.severity === "minor" || rule.severity === "nit"));
        if (!s.valid || !policyOk)
          findings.push({
            file: change.path,
            line: s.line - 1,
            column: 1,
            detail: `suppression of ${s.ruleId} ${!s.valid ? "has no valid reason" : "is not allowed for this rule"}`,
          });
      }
    }
    return findings;
  },
  testWeakening(unit, params, analyzer) {
    const isTest = (path: string): boolean => matchAny(params.testGlobs, path);
    const moved = new Set<string>();
    for (const change of unit.changes)
      for (const name of assertionCount(analyzer, change.path, change.after).names) moved.add(name);
    const findings: RawFinding[] = [];
    for (const change of unit.changes) {
      if (change.status === "D" && isTest(change.path)) {
        const lost = assertionCount(analyzer, change.path, change.before).names;
        if (lost.length === 0 || lost.some((name) => !moved.has(name)))
          findings.push(at(change.path, "test file deleted"));
        continue;
      }
      if (change.status === "M" && isTest(change.path)) {
        const before = assertionCount(analyzer, change.path, change.before);
        const after = assertionCount(analyzer, change.path, change.after);
        const lostNames = before.names.filter((name) => !after.names.includes(name));
        const relocated =
          lostNames.length > 0 &&
          lostNames.every((name) => moved.has(name) && !after.names.includes(name));
        if (after.assertions < before.assertions && !relocated)
          findings.push(
            at(change.path, `assertions dropped from ${before.assertions} to ${after.assertions}`),
          );
        if (after.weakening > before.weakening)
          findings.push(at(change.path, "a test was skipped, focused or marked todo"));
      }
      if (
        change.before !== undefined &&
        change.after !== undefined &&
        /(?:vitest|jest|vite)\.config\.|\.nycrc|(?:^|\/)package\.json$/.test(change.path)
      ) {
        const read = (text: string): Map<string, number> => {
          const values = new Map<string, number>();
          for (const m of text.matchAll(THRESHOLD)) values.set(m[1] as string, Number(m[2]));
          return values;
        };
        const before = read(change.before);
        for (const [key, value] of read(change.after))
          if ((before.get(key) ?? 0) > value)
            findings.push(
              at(
                change.path,
                `coverage threshold ${key} lowered from ${before.get(key)} to ${value}`,
              ),
            );
      }
    }
    return findings;
  },
  dependencies(unit) {
    const approved = new Set(unit.approvedDependencies);
    const findings: RawFinding[] = [];
    for (const change of unit.changes)
      if (baseName(change.path) === "package.json") {
        for (const name of dependencyChanges(change, approved))
          findings.push(at(change.path, `${name} was added or changed without approval`));
        for (const name of scriptChanges(change))
          findings.push(at(change.path, `script "${name}" was changed`));
      }
    return findings;
  },
  scope(unit) {
    const allowed = [...unit.taskFiles, ...unit.testPaths, ...unit.allowedGeneratedPaths];
    const roots = unit.sourceRoots.map((root) => root.replace(/\/$/, ""));
    const findings: RawFinding[] = [];
    for (const change of unit.changes) {
      const inTask = allowed.some(
        (entry) =>
          entry === change.path || (/[*?{[]/.test(entry) && compileGlob(entry)(change.path)),
      );
      const inL0 =
        unit.scope === "l0" &&
        roots.some((root) => root === "." || change.path.startsWith(`${root}/`));
      if (!inTask && !inL0)
        findings.push(at(change.path, `${change.path} is outside the task scope`));
    }
    return findings;
  },
  lockfile(unit) {
    const manifestChanged = unit.changes.some((change) => baseName(change.path) === "package.json");
    if (manifestChanged) return [];
    return unit.changes
      .filter((change) => LOCKFILES.has(baseName(change.path)))
      .map((change) => at(change.path, "lockfile changed without a package.json change"));
  },
  snapshots(unit, params) {
    const globs = params.globs ?? DEFAULT_SNAPSHOT_GLOBS;
    return unit.changes
      .filter((change) => matchAny(globs, change.path))
      .map((change) => at(change.path, `${change.path} is a snapshot or baseline`));
  },
};

export const diffGuard: Engine = {
  id: "diff-guard",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.oneOf("guard", GUARDS, true);
    reader.globs("globs");
    reader.globs("testGlobs");
    return reader.errors;
  },
  run(context) {
    if (!context.unit) return { findings: [], skipped: "requires unit diff" };
    const reader = new ParamReader(context.params, PARAMS);
    const guard = reader.oneOf("guard", GUARDS, true) as Guard;
    const globs = reader.globs("globs");
    const testGlobs = reader.globs("testGlobs") ?? DEFAULT_TEST_GLOBS;
    return {
      findings: RUNNERS[guard](
        context.unit,
        { ...(globs ? { globs } : {}), testGlobs },
        context.analyzer,
      ),
    };
  },
};
