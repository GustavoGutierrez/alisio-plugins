import type { ArchitectureConfig } from "../../domain/architecture/config.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import { compileGlob } from "../../domain/glob.js";
import type { Finding, ResolvedRule } from "../../domain/rules/model.js";
import { parseSuppressions, suppressionFor } from "../../domain/rules/suppressions.js";
import type { TokensData, UnitContext } from "../../domain/rules/unit.js";
import { activeWaivers, findWaiver, type Waiver } from "../../domain/rules/waivers.js";
import { atLeastSeverity, type Severity } from "../../domain/severity.js";
import type { StackProfile } from "../../domain/stack/profile.js";
import { aggregate, type Coverage, statusForFinding, type Verdict } from "../../domain/verdict.js";
import { engines } from "../engines/index.js";
import type { BudgetInput, EngineContext, RawFinding, WorkspaceData } from "../engines/types.js";
import type { AriaCatalog } from "../ports/aria-catalog.js";
import type { FileAnalysis, FileAnalyzer } from "../ports/file-analyzer.js";
import type { ImportGraphBuilder } from "../ports/import-graph-builder.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface RulesCheckDeps {
  analyzer: FileAnalyzer;
  graphBuilder: ImportGraphBuilder;
}

export interface RulesCheckInput {
  fs: WorkspaceFs;
  rules: readonly ResolvedRule[];
  stack: StackProfile;
  config: FrontsmithConfig;
  aria: AriaCatalog;
  architecture?: ArchitectureConfig;
  unit?: UnitContext;
  tokens?: TokensData;
  budget?: BudgetInput;
  waivers?: readonly Waiver[];
  /** `YYYY-MM-DD`, used to decide which waivers are still valid. */
  today: string;
  /** Restrict findings to files matching any of these globs (the whole workspace is still analysed). */
  paths?: readonly string[];
  categories?: readonly string[];
  packs?: readonly string[];
  minSeverity?: Severity;
}

export interface RuleCheck {
  ruleId: string;
  packId: string;
  status: Verdict;
  required: boolean;
  summary: string;
  findings: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface RulesCheckResult {
  verdict: Verdict;
  coverage: Coverage;
  checks: RuleCheck[];
  findings: Finding[];
  skippedFiles: SkippedFile[];
  /** More files than the analysis limit: the rest were not analysed. */
  truncated: boolean;
  expiredWaivers: Waiver[];
}

const ANALYSABLE = /\.(?:[cm]?[jt]sx?|css|scss|less|vue|svelte|astro|html?)$/i;

function manifestLookup(
  manifests: ReadonlyMap<string, Record<string, unknown>>,
): WorkspaceData["manifestFor"] {
  return (path) => {
    let directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (;;) {
      const manifest = manifests.get(directory);
      if (manifest)
        return { path: directory ? `${directory}/package.json` : "package.json", manifest };
      if (directory === "") return undefined;
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    }
  };
}

const stableSort = (findings: Finding[]): Finding[] =>
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId),
  );

/** Evaluate resolved rules over the workspace (spec 10.5 `fs_rules_check`, 13). */
export async function runRulesCheck(
  input: RulesCheckInput,
  deps: RulesCheckDeps,
): Promise<RulesCheckResult> {
  const listing = await input.fs.listFiles();
  const skippedFiles: SkippedFile[] = [];
  const all = new Map<string, FileAnalysis>();
  const manifests = new Map<string, Record<string, unknown>>();
  const textCache = new Map<string, string | undefined>();

  const readText = async (path: string): Promise<string | undefined> => {
    if (textCache.has(path)) return textCache.get(path);
    let text: string | undefined;
    try {
      const read = await input.fs.read(path);
      text = read.kind === "text" ? read.text : undefined;
    } catch {
      text = undefined;
    }
    textCache.set(path, text);
    return text;
  };

  for (const path of listing.files) {
    if (path === "package.json" || path.endsWith("/package.json")) {
      const text = await readText(path);
      try {
        const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          manifests.set(
            path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
            parsed as Record<string, unknown>,
          );
      } catch {
        // An unreadable manifest simply has no declared dependencies.
      }
    }
    if (!ANALYSABLE.test(path)) continue;
    const read = await input.fs.read(path);
    if (read.kind === "too-large") {
      skippedFiles.push({ path, reason: `larger than the analysis limit (${read.size} bytes)` });
      continue;
    }
    if (read.kind !== "text") continue;
    textCache.set(path, read.text);
    all.set(path, deps.analyzer.analyze(path, read.text));
  }
  const graph = await deps.graphBuilder.build(input.fs, listing.files, all.values());
  const workspace: WorkspaceData = {
    files: listing.files,
    readText,
    manifestFor: manifestLookup(manifests),
  };
  const pathFilter =
    input.paths && input.paths.length > 0
      ? input.paths.map((glob) => compileGlob(glob))
      : undefined;
  const { active: activeList, expired } = activeWaivers(input.waivers ?? [], input.today);

  const checks: RuleCheck[] = [];
  const findings: Finding[] = [];
  const parsedSuppressions = new Map<string, ReturnType<typeof parseSuppressions>>();
  const suppressionsOf = (analysis: FileAnalysis) => {
    let found = parsedSuppressions.get(analysis.path);
    if (!found) {
      found = parseSuppressions(analysis.comments);
      parsedSuppressions.set(analysis.path, found);
    }
    return found;
  };
  const selectedAnywhere = new Set<string>();

  const wanted = input.rules.filter(
    (rule) =>
      rule.kind !== "advisory" &&
      (!input.categories ||
        input.categories.length === 0 ||
        input.categories.includes(rule.category)) &&
      (!input.packs || input.packs.length === 0 || input.packs.includes(rule.packId)) &&
      (!input.minSeverity || atLeastSeverity(rule.severity, input.minSeverity)),
  );

  for (const rule of wanted) {
    const required = rule.kind === "deterministic";
    const base = { ruleId: rule.id, packId: rule.packId, required };
    const include = rule.files.map((glob) => compileGlob(glob));
    const excludeRaw = rule.params.excludeFiles;
    const exclude = Array.isArray(excludeRaw)
      ? excludeRaw.map((glob) => compileGlob(String(glob)))
      : [];
    const matchedPaths = listing.files.filter(
      (path) =>
        include.some((test) => test(path)) &&
        !exclude.some((test) => test(path)) &&
        (!pathFilter || pathFilter.some((test) => test(path))),
    );
    const files = matchedPaths
      .map((path) => all.get(path))
      .filter((analysis): analysis is FileAnalysis => analysis !== undefined);
    for (const path of matchedPaths) selectedAnywhere.add(path);
    const engine = engines[rule.engine];
    const context: EngineContext = {
      rule,
      params: rule.params,
      stack: input.stack,
      config: input.config,
      files,
      matchedPaths,
      all,
      graph,
      aria: input.aria,
      workspace,
      analyzer: deps.analyzer,
      ...(input.architecture ? { architecture: input.architecture } : {}),
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.tokens ? { tokens: input.tokens } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
    };
    let raw: RawFinding[];
    try {
      const outcome = await engine.run(context);
      if (outcome.skipped !== undefined) {
        checks.push({
          ...base,
          required: false,
          status: "SKIPPED",
          summary: outcome.skipped,
          findings: 0,
        });
        continue;
      }
      raw = outcome.findings;
    } catch (error) {
      checks.push({
        ...base,
        status: "BLOCKED",
        summary: `engine failed: ${error instanceof Error ? error.message : String(error)}`,
        findings: 0,
      });
      continue;
    }
    const produced: Finding[] = [];
    for (const item of raw) {
      const analysis = all.get(item.file);
      const message = item.detail ? `${rule.message} (${item.detail})` : rule.message;
      let note: string | undefined;
      let suppressed = false;
      let waived = false;
      if (analysis) {
        const outcome = suppressionFor(
          { ruleId: rule.id, line: item.line },
          rule,
          suppressionsOf(analysis),
        );
        if (outcome.status === "honoured") {
          suppressed = true;
          note = `suppressed: ${outcome.reason}`;
        } else if (outcome.status === "ignored") note = `suppression ignored: ${outcome.reason}`;
      }
      const waiver = findWaiver({ ruleId: rule.id, file: item.file }, activeList);
      if (waiver) {
        waived = true;
        note = `waived: ${waiver.id}`;
      }
      produced.push({
        ruleId: rule.id,
        severity: rule.severity,
        kind: rule.kind,
        status:
          item.review && !suppressed && !waived
            ? "REVIEW"
            : statusForFinding(rule.severity, rule.kind, { suppressed, waived }),
        file: item.file,
        line: item.line,
        column: item.column,
        message,
        fix: rule.fix,
        source: rule.source,
        ...(note ? { note } : {}),
      });
    }
    findings.push(...produced);
    const statuses = produced.map((f) => f.status);
    const status: Verdict = statuses.includes("FAIL")
      ? "FAIL"
      : statuses.includes("REVIEW")
        ? "REVIEW"
        : "PASS";
    const open = produced.filter((f) => f.status === "FAIL" || f.status === "REVIEW").length;
    checks.push({
      ...base,
      status,
      summary: open === 0 ? "no findings" : `${open} finding${open === 1 ? "" : "s"}`,
      findings: open,
    });
  }

  // Files no rule could read are REVIEW items, never a crash (spec 10.3, FS-SRC-001).
  for (const analysis of all.values())
    if (selectedAnywhere.has(analysis.path))
      for (const diagnostic of analysis.diagnostics)
        findings.push({
          ruleId: diagnostic.code,
          severity: "minor",
          kind: "heuristic",
          status: "REVIEW",
          file: analysis.path,
          line: diagnostic.line,
          column: diagnostic.column,
          message: diagnostic.message,
        });

  stableSort(findings).forEach((finding, index) => {
    finding.id = `F-${String(index + 1).padStart(4, "0")}`;
  });
  const aggregated =
    checks.length === 0
      ? { verdict: "SKIPPED" as Verdict, coverage: { required: 0, executed: 0, pending: 0 } }
      : aggregate(checks);
  const sourceReview = findings.some((f) => f.ruleId === "FS-SRC-001");
  const verdict = aggregated.verdict === "PASS" && sourceReview ? "REVIEW" : aggregated.verdict;
  return {
    verdict,
    coverage: aggregated.coverage,
    checks,
    findings,
    skippedFiles,
    truncated: listing.truncated,
    expiredWaivers: expired,
  };
}
