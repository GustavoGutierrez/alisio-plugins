import type { Severity } from "../severity.js";

/** One file changed by a build unit, with its text before and after (spec 7.2 G6, 13.3 FS-GOV). */
export interface UnitChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  before?: string;
  after?: string;
}

/** Everything the `diff-guard` engine needs to judge a unit; built by the coordinator from git. */
export interface UnitContext {
  changes: UnitChange[];
  /** Files the task contract names. */
  taskFiles: string[];
  testPaths: string[];
  allowedGeneratedPaths: string[];
  /** `l0` units may touch any path under `sourceRoots` (B-12). */
  scope: "task" | "l0";
  sourceRoots: string[];
  /** Globs of protected oracles; `.frontsmith/**` is always protected. */
  protectedGlobs: string[];
  approvedDependencies: string[];
  /** Severity and suppressibility of every known rule, for the suppression guard. */
  rules: Record<string, { severity: Severity; suppressible: boolean }>;
}

export interface TokenPair {
  fg: string;
  bg: string;
  kind: "normal_text" | "large_text" | "non_text";
  states?: string[];
}

/** Resolved token values per theme plus the pairs that must pass contrast. */
export interface TokensData {
  path: string;
  /** token -> theme -> color. */
  values: Record<string, Record<string, string>>;
  pairs: TokenPair[];
}
