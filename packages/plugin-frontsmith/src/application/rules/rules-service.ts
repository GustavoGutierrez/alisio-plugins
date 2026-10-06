import type { ArchitectureConfig } from "../../domain/architecture/config.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import type { ConfigDiagnostic } from "../../domain/config/validate.js";
import { isPackId } from "../../domain/ids.js";
import type { PackDef, ResolvedRule, RuleDef } from "../../domain/rules/model.js";
import {
  type EngineParamValidators,
  type PackDiagnostic,
  validatePack,
} from "../../domain/rules/pack-validate.js";
import { type ResolvedRuleSet, resolveRules } from "../../domain/rules/resolve.js";
import type { TokensData, UnitContext } from "../../domain/rules/unit.js";
import type { Waiver } from "../../domain/rules/waivers.js";
import type { Severity } from "../../domain/severity.js";
import type { StackProfile } from "../../domain/stack/profile.js";
import type { Level } from "../../domain/state/levels.js";
import { runRuleFixture } from "../checks/rule-fixtures.js";
import { type RulesCheckResult, runRulesCheck } from "../checks/rules-check.js";
import { detectStack } from "../detect/stack.js";
import type { BudgetInput } from "../engines/types.js";
import type { AriaCatalog } from "../ports/aria-catalog.js";
import type { Clock } from "../ports/clock.js";
import type { FileAnalyzer } from "../ports/file-analyzer.js";
import type { ImportGraphBuilder } from "../ports/import-graph-builder.js";
import type { PackStore, ProjectStore } from "../ports/project-store.js";
import type { ModuleResolver, WorkspaceFs } from "../ports/workspace-fs.js";

export interface RulesServiceDeps {
  fsFor(root: string): WorkspaceFs;
  packs: PackStore;
  project: ProjectStore;
  resolver: ModuleResolver;
  analyzer: FileAnalyzer;
  graphBuilder: ImportGraphBuilder;
  aria(): Promise<AriaCatalog>;
  clock: Clock;
  validators: EngineParamValidators;
}

export interface RulesContext {
  root: string;
  stack: StackProfile;
  config: FrontsmithConfig;
  level: Level;
  resolved: ResolvedRuleSet;
  shipped: PackDef[];
  workspacePacks: PackDef[];
  architecture: ArchitectureConfig | undefined;
  waivers: Waiver[];
  /** Problems that make rule evaluation unreliable: any of these means BLOCKED. */
  problems: string[];
}

export interface CheckOptions {
  paths?: string[];
  packs?: string[];
  categories?: string[];
  minSeverity?: Severity;
  level?: Level;
  /** Token values and required pairs for `token-pair-contrast` (FS-TOK-008). */
  tokens?: TokensData;
  /**
   * The diff of one unit of work for the `diff-guard` rules (spec 7.2 G6). The known-rule map the
   * guards need is filled in from the resolved rules; without a unit those rules are SKIPPED (B-07).
   */
  unit?: Omit<UnitContext, "rules">;
  /** Measured build output for the `budget` rules. */
  budget?: BudgetInput;
}

export type CheckOutcome =
  | { blocked: true; context: RulesContext }
  | { blocked: false; context: RulesContext; result: RulesCheckResult };

export interface PackTestCase {
  ruleId: string;
  fixture: string;
  expected: "finding" | "clean";
  ok: boolean;
  detail: string;
}

export interface PackTestReport {
  packId: string;
  cases: PackTestCase[];
  withoutFixtures: string[];
}

const today = (clock: Clock): string => clock.now().toISOString().slice(0, 10);

const describeConfig = (diagnostics: readonly ConfigDiagnostic[]): string[] =>
  diagnostics.map((d) => `${d.code} ${d.pointer || "/"}: ${d.message}`);
const describePack = (diagnostics: readonly PackDiagnostic[]): string[] =>
  diagnostics.map((d) =>
    `${d.code} ${d.pack} ${d.where}: ${d.message}`.replace(/\s+/g, " ").trim(),
  );

/** One facade for rule packs: resolve, list, explain, check, test and promote (spec AD-12). */
export class RulesService {
  constructor(private readonly deps: RulesServiceDeps) {}

  async loadContext(root: string, level?: Level): Promise<RulesContext> {
    const { deps } = this;
    const problems: string[] = [];
    const configResult = await deps.project.readConfig(root);
    problems.push(...describeConfig(configResult.diagnostics));
    const config = configResult.config;
    const shipped = await deps.packs.shipped();
    const workspace = await deps.packs.workspace(root);
    problems.push(...describePack(workspace.diagnostics));
    const architecture = await deps.project.readArchitecture(root);
    problems.push(
      ...architecture.errors.map((e) => `architecture.json ${e.pointer || "/"}: ${e.message}`),
    );
    const waivers = await deps.project.readWaivers(root);
    problems.push(...waivers.errors.map((e) => `waivers.json ${e.pointer || "/"}: ${e.message}`));
    const stack = await detectStack(deps.fsFor(root), deps.resolver);
    const effectiveLevel = level ?? config.defaults.level;
    const resolved = resolveRules({
      stack,
      level: effectiveLevel,
      config: { packs: config.packs, rules: config.rules },
      shipped,
      workspace: workspace.packs,
      architectureConfig: architecture.config !== undefined,
    });
    problems.push(...describePack(resolved.diagnostics));
    return {
      root,
      stack,
      config,
      level: effectiveLevel,
      resolved,
      shipped,
      workspacePacks: workspace.packs,
      architecture: architecture.config,
      waivers: waivers.waivers,
      problems,
    };
  }

  async check(root: string, options: CheckOptions = {}): Promise<CheckOutcome> {
    const context = await this.loadContext(root, options.level);
    if (context.problems.length > 0) return { blocked: true, context };
    const result = await runRulesCheck(
      {
        fs: this.deps.fsFor(root),
        rules: context.resolved.rules,
        stack: context.stack,
        config: context.config,
        aria: await this.deps.aria(),
        ...(context.architecture ? { architecture: context.architecture } : {}),
        waivers: context.waivers,
        today: today(this.deps.clock),
        ...(options.paths ? { paths: options.paths } : {}),
        ...(options.packs ? { packs: options.packs } : {}),
        ...(options.categories ? { categories: options.categories } : {}),
        ...(options.minSeverity ? { minSeverity: options.minSeverity } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
        ...(options.unit
          ? {
              unit: {
                ...options.unit,
                rules: Object.fromEntries(
                  context.resolved.rules.map((rule) => [
                    rule.id,
                    { severity: rule.severity, suppressible: rule.suppressible },
                  ]),
                ),
              },
            }
          : {}),
        ...(options.budget ? { budget: options.budget } : {}),
      },
      { analyzer: this.deps.analyzer, graphBuilder: this.deps.graphBuilder },
    );
    return { blocked: false, context, result };
  }

  /** Rules of the resolved set, optionally narrowed to one pack. */
  async list(
    root: string,
    pack?: string,
  ): Promise<{ context: RulesContext; rules: ResolvedRule[] }> {
    const context = await this.loadContext(root);
    const rules = context.resolved.rules.filter(
      (rule) => pack === undefined || rule.packId === pack,
    );
    return { context, rules };
  }

  /** One rule with its resolution trail, whether it is active, inactive or disabled. */
  async explain(
    root: string,
    ruleId: string,
  ): Promise<
    | { found: false }
    | { found: true; state: "active"; rule: ResolvedRule }
    | { found: true; state: "inactive"; rule: RuleDef; reason: string }
    | { found: true; state: "disabled"; rule: RuleDef; trail: ResolvedRule["trail"] }
  > {
    const context = await this.loadContext(root);
    const active = context.resolved.rules.find((rule) => rule.id === ruleId);
    if (active) return { found: true, state: "active", rule: active };
    const definition = [...context.shipped, ...context.workspacePacks]
      .flatMap((pack) => pack.rules)
      .find((rule) => rule.id === ruleId);
    if (!definition) return { found: false };
    const disabled = context.resolved.disabled.find((entry) => entry.ruleId === ruleId);
    if (disabled)
      return { found: true, state: "disabled", rule: definition, trail: disabled.trail };
    const inactive = context.resolved.inactive.find((entry) => entry.ruleId === ruleId);
    return {
      found: true,
      state: "inactive",
      rule: definition,
      reason: inactive?.reason ?? "its pack is not active for this stack",
    };
  }

  /** Run the fixtures of one workspace pack: fail fixtures must find, pass fixtures must stay clean. */
  async testPack(root: string, packId: string): Promise<PackTestReport | undefined> {
    const workspace = await this.deps.packs.workspace(root);
    const pack = workspace.packs.find((candidate) => candidate.packId === packId);
    if (!pack) return undefined;
    const report: PackTestReport = { packId, cases: [], withoutFixtures: [] };
    const aria = await this.deps.aria();
    const context = {
      aria,
      deps: { analyzer: this.deps.analyzer, graphBuilder: this.deps.graphBuilder },
      today: today(this.deps.clock),
    };
    for (const rule of pack.rules) {
      if (
        rule.kind === "advisory" ||
        !rule.fixtures ||
        rule.fixtures.fail.length + rule.fixtures.pass.length === 0
      ) {
        report.withoutFixtures.push(rule.id);
        continue;
      }
      for (const [expected, files] of [
        ["finding", rule.fixtures.fail],
        ["clean", rule.fixtures.pass],
      ] as const)
        for (const fixture of files) {
          const text = await this.deps.project.readPackFixture(root, packId, fixture);
          if (text === undefined) {
            report.cases.push({
              ruleId: rule.id,
              fixture,
              expected,
              ok: false,
              detail: "fixture file not found",
            });
            continue;
          }
          try {
            const ext = fixture.slice(fixture.lastIndexOf(".") + 1);
            const result = await runRuleFixture({ rule, packId, ext, text }, context);
            const own = result.findings.filter((finding) => finding.ruleId === rule.id);
            const ok = expected === "finding" ? own.length > 0 : own.length === 0;
            report.cases.push({
              ruleId: rule.id,
              fixture,
              expected,
              ok,
              detail: `${own.length} finding${own.length === 1 ? "" : "s"}`,
            });
          } catch (error) {
            report.cases.push({
              ruleId: rule.id,
              fixture,
              expected,
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
    }
    return report;
  }

  /** Problems that keep a retrospective candidate from being a valid workspace rule (empty when valid). */
  validateCandidate(rule: RuleDef): string[] {
    const checked = validatePack(
      {
        schemaVersion: 1,
        packId: "local",
        version: "1.0.0",
        title: "Candidate",
        description: "Candidate validation.",
        extends: [],
        appliesWhen: {},
        rules: [rule],
        overrides: [],
      },
      { scope: "workspace", validators: this.deps.validators },
    );
    return checked.ok ? [] : describePack(checked.diagnostics);
  }

  /** Append a rule candidate to `.frontsmith/packs/local/pack.json` (a human command). */
  async promote(
    root: string,
    candidateId: string,
  ): Promise<{ ok: true; ruleId: string } | { ok: false; reason: string }> {
    if (!/^CAND-\d{3}$/.test(candidateId))
      return { ok: false, reason: `Invalid candidate id: ${candidateId}` };
    const candidates = await this.deps.project.readCandidates(root);
    const candidate = candidates.find((entry) => entry.id === candidateId);
    if (!candidate)
      return { ok: false, reason: `No candidate ${candidateId} under .frontsmith/candidates` };
    const existing = await this.deps.project.readLocalPack(root);
    const pack: PackDef = existing ?? {
      schemaVersion: 1,
      packId: "local",
      version: "1.0.0",
      title: "Local rules",
      description: "Rules promoted from retrospective candidates.",
      extends: [],
      appliesWhen: {},
      rules: [],
      overrides: [],
    };
    if (pack.rules.some((rule) => rule.id === candidate.rule.id))
      return { ok: false, reason: `Rule ${candidate.rule.id} already exists in the local pack` };
    const next: PackDef = { ...pack, rules: [...pack.rules, candidate.rule] };
    const checked = validatePack(next, { scope: "workspace", validators: this.deps.validators });
    if (!checked.ok)
      return {
        ok: false,
        reason: `Candidate is not a valid rule: ${describePack(checked.diagnostics).join("; ")}`,
      };
    if (!isPackId(next.packId)) return { ok: false, reason: "Invalid local pack id" };
    await this.deps.project.writeLocalPack(root, next);
    return { ok: true, ruleId: candidate.rule.id };
  }
}
