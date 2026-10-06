import type { Severity } from "../severity.js";
import type { Level } from "../state/levels.js";
import type { RuleKind, Verdict } from "../verdict.js";

export type { RuleKind };

/** The closed set of rule engines (spec 10.4): 19 implementations plus `advisory`, which has none. */
export const engineIds = [
  "css-declaration",
  "css-raw-value",
  "css-at-rule",
  "css-file-guard",
  "jsx-element",
  "template-element",
  "jsx-label-association",
  "aria-attribute",
  "import-specifier",
  "class-token",
  "component-api",
  "file-metric",
  "test-locator",
  "package-json",
  "token-file",
  "token-pair-contrast",
  "diff-guard",
  "architecture",
  "budget",
  "advisory",
] as const;
export type EngineId = (typeof engineIds)[number];

export const ruleKinds = ["deterministic", "heuristic", "advisory"] as const;
export const ruleCategories = [
  "layout",
  "tokens",
  "a11y",
  "components",
  "architecture",
  "testing",
  "performance",
  "governance",
  "framework",
  "design",
] as const;
export type RuleCategory = (typeof ruleCategories)[number];

/** Pack and rule activation conditions: AND across keys, OR within a list (spec 13.2). */
export interface AppliesWhen {
  framework?: string[];
  meta?: string[];
  styling?: string[];
  tests?: string[];
  typescript?: boolean;
  /** Minimum feature level. */
  level?: Level;
  /** True when `.frontsmith/architecture.json` exists. */
  architectureConfig?: boolean;
}

export interface RuleDef {
  id: string;
  title: string;
  severity: Severity;
  kind: RuleKind;
  category: RuleCategory;
  engine: EngineId;
  params: Record<string, unknown>;
  files: string[];
  appliesWhen: AppliesWhen;
  message: string;
  fix: string;
  rationale: string;
  source: string;
  suppressible: boolean;
  tags: string[];
  fixtures?: { pass: string[]; fail: string[] };
}

export interface OverrideDef {
  id: string;
  override: true;
  severity?: Severity;
  files?: string[];
  params?: Record<string, unknown>;
  enabled?: boolean;
  justification: string;
}

export interface PackDef {
  schemaVersion: 1;
  packId: string;
  version: string;
  title: string;
  description: string;
  extends: string[];
  appliesWhen: AppliesWhen;
  rules: RuleDef[];
  overrides: OverrideDef[];
}

export interface TrailStep {
  /** `shipped:<pack>`, `workspace:<pack>` or `config`. */
  source: string;
  change: string;
}

export interface ResolvedRule extends RuleDef {
  packId: string;
  /** Where the winning definition came from. */
  origin: string;
  trail: TrailStep[];
}

/** One reported problem of a rule check. Ids (`F-0001`) are allocated when a report is built. */
export interface Finding {
  /** `F-0001`, allocated per report in stable order. */
  id?: string;
  ruleId: string;
  severity: Severity;
  kind: RuleKind;
  status: Verdict;
  file: string;
  line: number;
  column: number;
  message: string;
  fix?: string;
  source?: string;
  /** Why a finding was resolved to PASS: `suppressed: <reason>` or `waived: <id>`. */
  note?: string;
}

export const isEngineId = (value: unknown): value is EngineId =>
  typeof value === "string" && (engineIds as readonly string[]).includes(value);
