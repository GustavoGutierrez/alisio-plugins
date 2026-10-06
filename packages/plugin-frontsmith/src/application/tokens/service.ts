import { canonicalJson } from "../../domain/canonical-json.js";
import type { PairGraph } from "../../domain/color/pairs.js";
import {
  type PaletteCatalog,
  type PaletteRequest,
  type PaletteResult,
  solvePalette,
} from "../../domain/color/palette.js";
import { buildTokensJson, parseTokensFile } from "../../domain/color/tokens-file.js";
import { compileGlob } from "../../domain/glob.js";
import type { Verdict } from "../../domain/verdict.js";
import { aggregate } from "../../domain/verdict.js";
import type { RulesCheckResult } from "../checks/rules-check.js";
import type { FileAnalyzer } from "../ports/file-analyzer.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";
import type { WorkspaceWriter } from "../ports/workspace-writer.js";
import { renderThemeCss } from "../render/theme-css.js";
import type { RulesService } from "../rules/rules-service.js";
import { type PairRow, pairRows, tokensFromStyles, withDefaultPairs } from "./token-sets.js";

export interface TokensServiceDeps {
  fsFor(root: string): WorkspaceFs;
  project: ProjectStore;
  rules: RulesService;
  analyzer: FileAnalyzer;
  writer: WorkspaceWriter;
  palette(): Promise<PaletteCatalog>;
  pairGraph(): Promise<PairGraph>;
  sha256(text: string): string;
}

export interface TokenSource {
  kind: "tokens-json" | "css";
  path: string;
  tokens: number;
  pairs: number;
}

export type TokensCheckOutcome =
  | { blocked: true; problems: string[] }
  | {
      blocked: false;
      verdict: Verdict;
      result: RulesCheckResult;
      sources: TokenSource[];
      rows: PairRow[];
      notEvaluated: string[];
    };

export interface GeneratePlan {
  tokensPath: string;
  themeCssPath: string;
  tokensText: string;
  cssText: string;
  palette: Extract<PaletteResult, { ok: true }>;
  /** Paths that already exist and would be replaced. */
  existing: string[];
}

export type GenerateOutcome =
  | { state: "invalid"; reason: string }
  | { state: "unsat"; reason: string }
  | { state: "plan"; plan: GeneratePlan }
  | { state: "written"; plan: GeneratePlan };

const WORST: Verdict[] = ["FAIL", "BLOCKED", "REVIEW", "PASS", "SKIPPED"];
const worst = (a: Verdict, b: Verdict): Verdict => (WORST.indexOf(a) <= WORST.indexOf(b) ? a : b);

/**
 * Combine the results of one rules run per tokens file into one result.
 * TODO(owner): `token-pair-contrast` takes one token set per run (spec 10.4), so several
 * `tokens.json` files are checked by one run each and merged here.
 */
export function mergeRulesResults(results: readonly RulesCheckResult[]): RulesCheckResult {
  const [first] = results;
  if (!first) throw new Error("nothing to merge");
  if (results.length === 1) return first;
  const checks = new Map<string, RulesCheckResult["checks"][number]>();
  for (const result of results)
    for (const check of result.checks) {
      const seen = checks.get(check.ruleId);
      if (!seen || WORST.indexOf(check.status) < WORST.indexOf(seen.status))
        checks.set(check.ruleId, check);
    }
  const findings = new Map<string, RulesCheckResult["findings"][number]>();
  for (const result of results)
    for (const finding of result.findings)
      findings.set(
        `${finding.ruleId}|${finding.file}|${finding.line}|${finding.column}|${finding.message}`,
        finding,
      );
  const sorted = [...findings.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId),
  );
  sorted.forEach((finding, index) => {
    finding.id = `F-${String(index + 1).padStart(4, "0")}`;
  });
  const merged = [...checks.values()];
  return {
    verdict: results.map((r) => r.verdict).reduce(worst),
    coverage: aggregate(merged).coverage,
    checks: merged,
    findings: sorted,
    skippedFiles: first.skippedFiles,
    truncated: results.some((r) => r.truncated),
    expiredWaivers: first.expiredWaivers,
  };
}

/** Tokens, contrast and palettes behind one facade (AD-12). */
export class TokensService {
  constructor(private readonly deps: TokensServiceDeps) {}

  async check(root: string): Promise<TokensCheckOutcome> {
    const { deps } = this;
    const configResult = await deps.project.readConfig(root);
    if (configResult.diagnostics.length > 0)
      return {
        blocked: true,
        problems: configResult.diagnostics.map(
          (d) => `${d.code} ${d.pointer || "/"}: ${d.message}`,
        ),
      };
    const config = configResult.config;
    const graph = await deps.pairGraph();
    const fs = deps.fsFor(root);
    const { files } = await fs.listFiles();
    const problems: string[] = [];
    const sources: TokenSource[] = [];
    const sets: Array<{ data: ReturnType<typeof withDefaultPairs>["data"]; source: string }> = [];
    const notEvaluated: string[] = [];

    const artifacts = `${config.paths.artifacts.replace(/\/$/, "")}/`;
    const tokenJsonPaths = files
      .filter((path) => path.startsWith(artifacts) && path.endsWith("/tokens.json"))
      .sort();
    for (const path of tokenJsonPaths) {
      const read = await fs.read(path);
      if (read.kind !== "text") {
        problems.push(`${path}: could not be read`);
        continue;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(read.text);
      } catch (error) {
        problems.push(
          `${path}: not valid JSON (${error instanceof Error ? error.message : error})`,
        );
        continue;
      }
      const parsed = parseTokensFile(parsedJson);
      if (!parsed.ok) {
        problems.push(...parsed.errors.map((e) => `${path}: ${e}`));
        continue;
      }
      const { data, notEvaluated: skipped } = withDefaultPairs(
        path,
        parsed.values,
        parsed.pairs,
        graph,
      );
      notEvaluated.push(...skipped.map((entry) => `${path}: ${entry}`));
      sets.push({ data, source: path });
      sources.push({
        kind: "tokens-json",
        path,
        tokens: Object.keys(data.values).length,
        pairs: data.pairs.length,
      });
    }
    if (problems.length > 0) return { blocked: true, problems };

    if (sets.length === 0) {
      const tests = config.paths.tokenFiles.map((glob) => compileGlob(glob));
      const analyses: ReturnType<FileAnalyzer["analyze"]>[] = [];
      for (const path of files) {
        if (!/\.(?:css|scss|less)$/i.test(path) || !tests.some((test) => test(path))) continue;
        const read = await fs.read(path);
        if (read.kind === "text") analyses.push(deps.analyzer.analyze(path, read.text));
      }
      const css = tokensFromStyles(analyses, graph);
      notEvaluated.push(...css.notEvaluated);
      if (css.data) {
        sets.push({ data: css.data, source: css.data.path });
        sources.push({
          kind: "css",
          path: analyses.map((a) => a.path).join(", "),
          tokens: Object.keys(css.data.values).length,
          pairs: css.data.pairs.length,
        });
      }
    }

    const runs: RulesCheckResult[] = [];
    if (sets.length === 0) {
      const outcome = await deps.rules.check(root, { packs: ["fs-tokens"] });
      if (outcome.blocked) return { blocked: true, problems: outcome.context.problems };
      runs.push(outcome.result);
    }
    for (const set of sets) {
      const outcome = await deps.rules.check(root, { packs: ["fs-tokens"], tokens: set.data });
      if (outcome.blocked) return { blocked: true, problems: outcome.context.problems };
      runs.push(outcome.result);
    }
    const result = mergeRulesResults(runs);
    const rows = sets.flatMap((set) => pairRows(set.data, set.source, config.accessibility.target));
    return { blocked: false, verdict: result.verdict, result, sources, rows, notEvaluated };
  }

  /** Family ids the palette solver accepts (the catalog's curated scales). */
  async families(): Promise<string[]> {
    return [...(await this.deps.palette()).families];
  }

  /** Role id -> token name of a profile, to translate locked token colours to solver roles. */
  async roleTokens(profile?: string): Promise<Record<string, string>> {
    const catalog = await this.deps.palette();
    return {
      ...(catalog.profiles[profile ?? catalog.defaultProfile ?? "work-app"]?.tokenNames ?? {}),
    };
  }

  async palette(request: PaletteRequest, catalogVersion?: string): Promise<PaletteResult> {
    const catalog = await this.deps.palette();
    if (catalogVersion !== undefined && catalogVersion !== catalog.catalogVersion)
      return {
        ok: false,
        kind: "invalid",
        reason: `Catalog version ${catalogVersion} is not available; this build ships ${catalog.catalogVersion}`,
      };
    return solvePalette(catalog, request, this.deps.sha256);
  }

  /** Solve a palette and prepare `tokens.json` plus the theme CSS; write them only when asked. */
  async generate(
    root: string,
    request: PaletteRequest,
    options: { write: boolean },
  ): Promise<GenerateOutcome> {
    const { deps } = this;
    const solved = await this.palette(request);
    if (!solved.ok)
      return { state: solved.kind === "unsat" ? "unsat" : "invalid", reason: solved.reason };
    const catalog = await deps.palette();
    const profile = catalog.profiles[solved.profile];
    if (!profile) return { state: "invalid", reason: `Unknown palette profile ${solved.profile}` };
    const configResult = await deps.project.readConfig(root);
    if (configResult.diagnostics.length > 0)
      return {
        state: "invalid",
        reason: configResult.diagnostics
          .map((d) => `${d.code} ${d.pointer || "/"}: ${d.message}`)
          .join("; "),
      };
    const { artifacts, themeOutput } = configResult.config.paths;
    // TODO(owner): Appendix A gives `tokens generate --family <id>` no feature argument, so the
    // files go to the artifacts root; 8.1 places tokens.json per feature.
    const tokensPath = `${artifacts.replace(/\/$/, "")}/tokens.json`;
    const fs = deps.fsFor(root);
    const existing: string[] = [];
    for (const path of [tokensPath, themeOutput]) if (await fs.exists(path)) existing.push(path);
    const plan: GeneratePlan = {
      tokensPath,
      themeCssPath: themeOutput,
      tokensText: canonicalJson(buildTokensJson(solved, profile)),
      cssText: renderThemeCss(solved, profile),
      palette: solved,
      existing,
    };
    if (!options.write) return { state: "plan", plan };
    await deps.writer.write(root, tokensPath, plan.tokensText);
    await deps.writer.write(root, themeOutput, plan.cssText);
    return { state: "written", plan };
  }
}
