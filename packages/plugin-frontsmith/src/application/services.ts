import { validateBudgets } from "../domain/budgets/evaluate.js";
import { canonicalJson } from "../domain/canonical-json.js";
import type { GateReport } from "../domain/gates/aggregate.js";
import { compileGlob } from "../domain/glob.js";
import type { GateId } from "../domain/state/feature-state.js";
import type { ArchitectureService } from "./architecture/service.js";
import { type BudgetCheckResult, runBudgetCheck } from "./checks/budget-check.js";
import { type CommandOutcome, runProjectCommand } from "./checks/commands-check.js";
import type { FidelityService } from "./checks/fidelity-run.js";
import type { CommandPlan } from "./detect/commands.js";
import { detectStack } from "./detect/stack.js";
import type { ModelsService } from "./models/service.js";
import type { RulesService } from "./rules/rules-service.js";
import type { TokensService } from "./tokens/service.js";
import { WorkflowCoordinator } from "./workflow/coordinator.js";
import type { PhaseEnv, WorkflowDeps } from "./workflow/env.js";
import { checkGate } from "./workflow/gate-checks.js";
import { loadCommandPlan, readPackageScripts } from "./workflow/project.js";

export interface DoctorItem {
  name: string;
  status: "PASS" | "FAIL" | "REVIEW" | "BLOCKED";
  detail: string;
}

/** Node.js version required by the package (`engines.node`). */
const MIN_NODE = [22, 16] as const;

/**
 * One facade behind commands, tools, the CLI and the dashboard (AD-12): no surface reaches into the
 * workflow or the checks on its own, so they cannot drift apart.
 */
export class FrontsmithServices {
  readonly workflow: WorkflowCoordinator;

  constructor(
    readonly fidelity: FidelityService,
    readonly deps: WorkflowDeps,
    readonly rules: RulesService,
    readonly architecture: ArchitectureService,
    readonly tokens: TokensService,
    readonly models: ModelsService,
  ) {
    this.workflow = new WorkflowCoordinator(deps);
  }

  /** Evaluate one gate ad hoc (spec 7.2): `/frontsmith:check`, `fs_gate_run` and the CLI `gate`. */
  async checkGate(
    root: string,
    feature: string,
    gate: GateId,
    options: {
      taskId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      progress?: (line: string) => void;
    } = {},
  ): Promise<GateReport> {
    await this.workflow.load(root, feature, { mutating: true });
    const env: PhaseEnv = await this.workflow.makeEnv(root, feature, {
      sessionId: options.sessionId ?? "",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    });
    const lock = await this.deps.store.lock(root, feature);
    try {
      return await checkGate(env, gate, options.taskId);
    } finally {
      await lock.release();
    }
  }

  private async planFor(root: string): Promise<CommandPlan> {
    const context = await this.deps.rules.loadContext(root);
    const stack = await detectStack(this.deps.fsFor(root), this.deps.resolver);
    const env = {
      deps: this.deps,
      root,
      feature: "",
      parentSession: "",
      signal: new AbortController().signal,
      progress: () => undefined,
      evidenceDir: "",
      config: context.config,
    } as PhaseEnv;
    return loadCommandPlan(env, stack);
  }

  /** The project build command, when one is configured or inferable (spec 15.3). */
  async buildCommand(root: string): Promise<{ argv: string[]; source: string } | undefined> {
    return (await this.planFor(root)).build;
  }

  /** Run the project build command (`fs_budget_check` with `build: true`). */
  async runBuild(root: string, signal?: AbortSignal): Promise<CommandOutcome> {
    const planned = (await this.planFor(root)).build;
    const config = (await this.deps.project.readConfig(root)).config;
    if (!planned)
      return {
        name: "build",
        argv: [],
        source: "",
        status: "BLOCKED",
        exitCode: null,
        summary: "no build command",
        durationMs: 0,
      };
    return runProjectCommand(
      { process: this.deps.process, writer: this.deps.writer },
      {
        root,
        name: "build",
        argv: planned.argv,
        source: planned.source,
        timeoutMs: config.limits.commandTimeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
  }

  async budgetCheck(
    root: string,
    options: { strictDelta?: boolean } = {},
  ): Promise<BudgetCheckResult> {
    return runBudgetCheck(
      { fsFor: this.deps.fsFor, assets: this.deps.assets, rules: this.rules },
      { root, strictDelta: options.strictDelta ?? false },
    );
  }

  /** `/frontsmith:budget baseline`: a human command that records the current bundle sizes. */
  async budgetBaseline(
    root: string,
  ): Promise<
    | { ok: true; path: string; initialJsGzipBytes: number; initialCssGzipBytes: number }
    | { ok: false; reason: string }
  > {
    const result = await this.budgetCheck(root);
    if (result.status === "SKIPPED")
      return { ok: false, reason: "There is no .frontsmith/budgets.json: create it first." };
    const fs = this.deps.fsFor(root);
    const read = await fs.read(".frontsmith/budgets.json");
    if (read.kind !== "text") return { ok: false, reason: "budgets.json cannot be read." };
    // The recorded sizes are the measurement the delta check compares with.
    const measured = await this.measure(root, read.text);
    if (!measured)
      return {
        ok: false,
        reason: "No build output matches the entry globs: build the project first.",
      };
    const path = ".frontsmith/budgets.baseline.json";
    await this.deps.writer.write(
      root,
      path,
      canonicalJson({
        schemaVersion: 1,
        ...measured,
        recordedAt: this.deps.clock.now().toISOString(),
      }),
    );
    return { ok: true, path, ...measured };
  }

  private async measure(
    root: string,
    budgetsText: string,
  ): Promise<{ initialJsGzipBytes: number; initialCssGzipBytes: number } | undefined> {
    const parsed = validateBudgets(JSON.parse(budgetsText));
    if (!parsed.ok) return undefined;
    const files = await this.deps.assets.list(root, parsed.config.bundle.dir);
    const size = async (globs: string[]): Promise<number | undefined> => {
      const tests = globs.map((g) => compileGlob(g));
      const matched = files.filter((f) => tests.some((t) => t(f)));
      if (matched.length === 0) return undefined;
      let total = 0;
      for (const f of matched) {
        const bytes = await this.deps.assets.read(root, f);
        if (bytes) total += this.deps.assets.gzipSize(bytes);
      }
      return total;
    };
    const js = await size(parsed.config.bundle.entryGlobs);
    if (js === undefined) return undefined;
    return {
      initialJsGzipBytes: js,
      initialCssGzipBytes: (await size(parsed.config.bundle.cssGlobs)) ?? 0,
    };
  }

  /** `/frontsmith:doctor`: what a run needs, with the reason for every failure (spec Appendix A). */
  async doctor(root: string): Promise<DoctorItem[]> {
    const items: DoctorItem[] = [];
    const fs = this.deps.fsFor(root);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
    items.push({
      name: "node",
      status: nodeOk ? "PASS" : "FAIL",
      detail: `Node ${process.versions.node} (needs ${MIN_NODE.join(".")} or newer)`,
    });
    const git = await this.deps.git.isRepo(root);
    items.push({
      name: "git",
      status: git ? "PASS" : "BLOCKED",
      detail: git
        ? "git repository"
        : "not a git repository: diff guards and scope checks need git",
    });
    const context = await this.deps.rules.loadContext(root);
    items.push({
      name: "config and packs",
      status: context.problems.length === 0 ? "PASS" : "FAIL",
      detail:
        context.problems.length === 0
          ? `${context.resolved.rules.length} rules active`
          : context.problems.slice(0, 5).join("; "),
    });
    const stack = await detectStack(fs, this.deps.resolver);
    items.push({
      name: "stack",
      status: stack.framework === "none" && !(await fs.exists("package.json")) ? "BLOCKED" : "PASS",
      detail: `${stack.framework}, ${stack.packageManager}`,
    });
    const env = {
      deps: this.deps,
      root,
      feature: "",
      parentSession: "",
      signal: new AbortController().signal,
      progress: () => undefined,
      evidenceDir: "",
      config: context.config,
    } as PhaseEnv;
    const plan: CommandPlan = await loadCommandPlan(env, stack);
    for (const name of ["typecheck", "lint", "test", "build", "e2e"] as const)
      items.push({
        name: `command ${name}`,
        status: plan[name] ? "PASS" : name === "e2e" ? "REVIEW" : "BLOCKED",
        detail: plan[name]
          ? `${plan[name]?.argv.join(" ")} (${plan[name]?.source})`
          : "not configured and not inferable",
      });
    const scripts = await readPackageScripts(env);
    items.push({
      name: "package scripts",
      status: "PASS",
      detail: `${Object.keys(scripts).length} scripts`,
    });
    items.push({
      name: "playwright",
      status: stack.playwrightResolvable ? "PASS" : "REVIEW",
      detail: stack.playwrightResolvable
        ? "resolvable from the workspace"
        : "not installed: the fidelity pipeline will be BLOCKED",
    });
    items.push({
      name: "axe-core",
      status: stack.axeResolvable ? "PASS" : "REVIEW",
      detail: stack.axeResolvable
        ? "resolvable from the workspace"
        : "not installed: runtime accessibility will be BLOCKED",
    });
    const modelProblems = await this.deps.modelProblems(root);
    items.push({
      name: "models",
      status: modelProblems.length === 0 ? "PASS" : "FAIL",
      detail:
        modelProblems.length === 0
          ? "model configuration valid"
          : modelProblems.slice(0, 5).join("; "),
    });
    return items;
  }
}
