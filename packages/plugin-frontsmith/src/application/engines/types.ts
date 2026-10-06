import type { ArchitectureConfig } from "../../domain/architecture/config.js";
import type { BudgetsConfig } from "../../domain/budgets/evaluate.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import type { EngineId, ResolvedRule } from "../../domain/rules/model.js";
import type { TokensData, UnitContext } from "../../domain/rules/unit.js";
import type { StackProfile } from "../../domain/stack/profile.js";
import type { AriaCatalog } from "../ports/aria-catalog.js";
import type { FileAnalysis, FileAnalyzer } from "../ports/file-analyzer.js";
import type { ImportGraph } from "../ports/import-graph.js";

/** One problem an engine found; the runner turns it into a `Finding`. */
export interface RawFinding {
  file: string;
  line: number;
  column: number;
  /** Extra detail appended to the rule message, in parentheses. */
  detail?: string;
  /** The finding is a REVIEW item whatever the rule kind or severity (spec 12.1, 10.1). */
  review?: boolean;
}

export interface EngineOutcome {
  findings: RawFinding[];
  /** The engine could not run for a stated reason: the check is SKIPPED, never PASS. */
  skipped?: string;
}

export interface BudgetAsset {
  path: string;
  bytes: number;
  gzipBytes: number;
  width?: number;
  height?: number;
}

export type { BudgetsConfig };

export interface BudgetInput {
  config: BudgetsConfig;
  /** Built assets and images with measured sizes. */
  assets: BudgetAsset[];
  baseline?: { initialJsGzipBytes?: number; initialCssGzipBytes?: number };
}

export interface WorkspaceData {
  files: readonly string[];
  readText(path: string): Promise<string | undefined>;
  /** `package.json` of the nearest directory at or above `path`. */
  manifestFor(path: string): { path: string; manifest: Record<string, unknown> } | undefined;
}

export interface EngineContext {
  rule: ResolvedRule;
  params: Record<string, unknown>;
  stack: StackProfile;
  config: FrontsmithConfig;
  /** Analyses of the files this rule selects (`files` minus `excludeFiles`, narrowed by `paths`). */
  files: FileAnalysis[];
  /** Every workspace path the rule selects, analysable or not (`package.json`, configs). */
  matchedPaths: string[];
  /** Every analysed file of the workspace. */
  all: ReadonlyMap<string, FileAnalysis>;
  graph: ImportGraph;
  aria: AriaCatalog;
  workspace: WorkspaceData;
  analyzer: FileAnalyzer;
  architecture?: ArchitectureConfig;
  unit?: UnitContext;
  tokens?: TokensData;
  budget?: BudgetInput;
}

export interface Engine {
  id: EngineId;
  /** Problems with `params`, reported as PCK-006 at pack load. */
  validateParams(params: Record<string, unknown>): string[];
  run(context: EngineContext): Promise<EngineOutcome> | EngineOutcome;
}
