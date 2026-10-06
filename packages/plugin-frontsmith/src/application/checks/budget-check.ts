import {
  type BudgetBaseline,
  type BudgetLine,
  type BudgetMeasurement,
  type BudgetsConfig,
  evaluateBundle,
  validateBudgets,
} from "../../domain/budgets/evaluate.js";
import { readImageSize } from "../../domain/budgets/image-size.js";
import type { Prepared } from "../../domain/gates/aggregate.js";
import { compileGlob } from "../../domain/glob.js";
import type { Verdict } from "../../domain/verdict.js";
import type { BudgetAsset, BudgetInput } from "../engines/types.js";
import type { AssetReader } from "../ports/asset-reader.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";
import type { RulesService } from "../rules/rules-service.js";

export interface BudgetDeps {
  fsFor(root: string): WorkspaceFs;
  assets: AssetReader;
  rules: RulesService;
}

export interface BudgetCheckResult {
  /** `SKIPPED` when no `.frontsmith/budgets.json` exists: no universal numbers are invented. */
  status: Verdict;
  summary: string;
  lines: BudgetLine[];
  findings: NonNullable<Prepared["findings"]>;
  problems: string[];
}

const BASELINE_FILE = ".frontsmith/budgets.baseline.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJsonFile(
  fs: WorkspaceFs,
  path: string,
): Promise<{ value?: unknown; error?: string } | undefined> {
  const read = await fs.read(path);
  if (read.kind !== "text") return undefined;
  try {
    return { value: JSON.parse(read.text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Measure build output and images against `.frontsmith/budgets.json` (spec 10.6). */
export async function runBudgetCheck(
  deps: BudgetDeps,
  input: { root: string; strictDelta: boolean },
): Promise<BudgetCheckResult> {
  const fs = deps.fsFor(input.root);
  const raw = await readJsonFile(fs, ".frontsmith/budgets.json");
  if (!raw)
    return {
      status: "SKIPPED",
      summary: "no .frontsmith/budgets.json",
      lines: [],
      findings: [],
      problems: [],
    };
  if (raw.error)
    return {
      status: "BLOCKED",
      summary: "budgets.json is not valid JSON",
      lines: [],
      findings: [],
      problems: [raw.error],
    };
  const parsed = validateBudgets(raw.value);
  if (!parsed.ok)
    return {
      status: "BLOCKED",
      summary: "budgets.json is invalid",
      lines: [],
      findings: [],
      problems: parsed.diagnostics.map((d) => `${d.pointer || "/"}: ${d.message}`),
    };
  const config: BudgetsConfig = parsed.config;
  const baselineRaw = await readJsonFile(fs, BASELINE_FILE);
  const baseline: BudgetBaseline | undefined =
    baselineRaw?.value !== undefined && isRecord(baselineRaw.value)
      ? {
          ...(typeof baselineRaw.value.initialJsGzipBytes === "number"
            ? { initialJsGzipBytes: baselineRaw.value.initialJsGzipBytes }
            : {}),
          ...(typeof baselineRaw.value.initialCssGzipBytes === "number"
            ? { initialCssGzipBytes: baselineRaw.value.initialCssGzipBytes }
            : {}),
        }
      : undefined;

  const assets: BudgetAsset[] = [];
  const addAsset = async (path: string): Promise<BudgetAsset | undefined> => {
    const bytes = await deps.assets.read(input.root, path);
    if (!bytes) return undefined;
    const size = readImageSize(bytes);
    const asset: BudgetAsset = {
      path,
      bytes: bytes.length,
      gzipBytes: deps.assets.gzipSize(bytes),
      ...(size ? { width: size.width, height: size.height } : {}),
    };
    assets.push(asset);
    return asset;
  };
  const bundleFiles = await deps.assets.list(input.root, config.bundle.dir);
  const entryTests = config.bundle.entryGlobs.map((g) => compileGlob(g));
  const cssTests = config.bundle.cssGlobs.map((g) => compileGlob(g));
  const entryFiles: string[] = [];
  const cssFiles: string[] = [];
  for (const path of bundleFiles) {
    const isEntry = entryTests.some((t) => t(path));
    const isCss = cssTests.some((t) => t(path));
    if (!isEntry && !isCss) continue;
    const asset = await addAsset(path);
    if (!asset) continue;
    (isEntry ? entryFiles : cssFiles).push(path);
  }
  const imageTests = config.images.globs.map((g) => compileGlob(g));
  for (const path of (await fs.listFiles()).files)
    if (imageTests.some((t) => t(path)) && !assets.some((a) => a.path === path))
      await addAsset(path);

  const sum = (files: string[]): number =>
    assets.filter((a) => files.includes(a.path)).reduce((total, a) => total + a.gzipBytes, 0);
  const measured: BudgetMeasurement | undefined =
    entryFiles.length + cssFiles.length > 0
      ? {
          initialJsGzipBytes: sum(entryFiles),
          initialCssGzipBytes: sum(cssFiles),
          entryFiles,
          cssFiles,
        }
      : undefined;
  const lines = evaluateBundle({ config, measured, baseline, strict: input.strictDelta });

  // Images and inline data come from the `budget` rules, which share the engine and its messages.
  const budget: BudgetInput = { config, assets, ...(baseline ? { baseline } : {}) };
  const outcome = await deps.rules.check(input.root, { packs: ["fs-performance"], budget });
  const findings: BudgetCheckResult["findings"] = [];
  const problems: string[] = [];
  let rulesStatus: Verdict = "PASS";
  if (outcome.blocked) {
    rulesStatus = "BLOCKED";
    problems.push(...outcome.context.problems);
  } else {
    for (const f of outcome.result.findings)
      if (f.status === "FAIL" || f.status === "REVIEW")
        findings.push({
          ruleId: f.ruleId,
          severity: f.severity,
          status: f.status,
          kind: "deterministic",
          file: f.file,
          line: f.line,
          column: f.column,
          message: f.message,
        });
    if (outcome.result.findings.some((f) => f.status === "FAIL")) rulesStatus = "FAIL";
    else if (outcome.result.findings.some((f) => f.status === "REVIEW")) rulesStatus = "REVIEW";
  }
  const all: Verdict[] = [rulesStatus, ...lines.map((l) => l.status)];
  const status: Verdict = all.includes("FAIL")
    ? "FAIL"
    : all.includes("BLOCKED")
      ? "BLOCKED"
      : all.includes("REVIEW")
        ? "REVIEW"
        : "PASS";
  for (const line of lines)
    if (line.status === "BLOCKED")
      findings.push({
        ruleId: `BUDGET-${line.id.toUpperCase()}`,
        severity: "blocker",
        status: line.status,
        kind: "deterministic",
        message: line.summary,
      });
  return {
    status,
    summary: lines.map((l) => `${l.id}: ${l.status}`).join(", ") || "budgets evaluated",
    lines,
    findings,
    problems,
  };
}

export function budgetPrepared(result: BudgetCheckResult): Prepared | undefined {
  if (result.status === "SKIPPED") return undefined;
  return {
    status: result.status,
    summary: result.summary,
    required: false,
    findings: result.findings,
  };
}
