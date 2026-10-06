import type { CommandName } from "../../../domain/config/defaults.js";
import type { GateOutcome } from "../../../domain/gates/aggregate.js";
import { gateG0 } from "../../../domain/gates/g0.js";
import type { StackProfile } from "../../../domain/stack/profile.js";
import type { CommandPlan } from "../../detect/commands.js";
import type { InventoryRow } from "../../detect/inventory.js";
import { detectStack } from "../../detect/stack.js";
import { renderContextMd } from "../../render/context-md.js";
import {
  finishGate,
  type PhaseEnv,
  passes,
  readState,
  type UnitResult,
  writeArtifact,
} from "../env.js";
import { inventoryRows, loadCommandPlan } from "../project.js";
import { advance } from "./shared.js";

const DOCS =
  /^(?:AGENTS|CLAUDE|README|ARCHITECTURE|CONVENTIONS|DESIGN_SYSTEM|TESTING|SECURITY)\.md$|^docs\/[^/]+\.md$/i;

export interface ContextFacts {
  outcome: GateOutcome;
  stack: StackProfile;
  plan: CommandPlan;
  rows: InventoryRow[];
  files: string[];
  problems: string[];
  architecturePresent: boolean;
}

/** The deterministic facts of the repository and the G0 checks over them (spec 8, 7.2). */
export async function gatherContext(env: PhaseEnv): Promise<ContextFacts> {
  const { deps, root } = env;
  const fs = deps.fsFor(root);
  const state = await readState(env);
  env.progress("context: detecting the stack");
  const stack = await detectStack(fs, deps.resolver);
  const rulesContext = await deps.rules.loadContext(root, state.level);
  const plan = await loadCommandPlan(env, stack);
  const listing = await fs.listFiles();
  const rows = await inventoryRows(env);

  // The rule context reports every problem as text; sort them into the G0 checks, none is dropped.
  const problems = rulesContext.problems;
  const isConfig = (p: string): boolean => p.startsWith("CFG-") || p.startsWith("waivers.json");
  const isArchitecture = (p: string): boolean => p.startsWith("architecture.json");
  const names: CommandName[] = ["typecheck", "lint", "test", "build", "e2e"];
  const outcome = gateG0({
    level: state.level,
    configProblems: problems.filter(isConfig),
    architectureProblems: problems.filter(isArchitecture),
    packProblems: problems.filter((p) => !isConfig(p) && !isArchitecture(p)),
    modelProblems: await deps.modelProblems(root),
    stackDetected: stack.framework !== "none" || (await fs.exists("package.json")),
    commands: names.map((name) => ({
      name,
      resolved: plan[name] !== undefined,
      source: plan[name]?.source ?? "",
    })),
    gitRepository: await deps.git.isRepo(root),
  });
  return {
    outcome,
    stack,
    plan,
    rows,
    files: listing.files,
    problems,
    architecturePresent: !problems.some(isArchitecture) && rulesContext.architecture !== undefined,
  };
}

/** Context discovery (spec 8): deterministic, then gate G0. */
export async function runContext(env: PhaseEnv): Promise<UnitResult> {
  const { stack, plan, rows, files, outcome, architecturePresent } = await gatherContext(env);
  const count = (kind: string): number => rows.filter((row) => row.kind === kind).length;
  const names: CommandName[] = ["typecheck", "lint", "test", "build", "e2e"];
  await writeArtifact(
    env,
    "context",
    "context.md",
    renderContextMd(
      {
        stack,
        commands: (Object.entries(plan) as Array<[string, { argv: string[]; source: string }]>).map(
          ([name, c]) => ({
            name,
            argv: c.argv,
            source: c.source,
          }),
        ),
        inventory: {
          components: count("component"),
          hooks: count("hook"),
          stores: count("store"),
          tokens: count("token"),
        },
        docs: files.filter((path) => DOCS.test(path)).slice(0, 20),
        architecturePresent,
        unknowns: names.filter((name) => !plan[name]).map((name) => `no ${name} command`),
      },
      env.feature,
    ),
  );
  const report = await finishGate(env, "G0", outcome);
  if (!passes(report.verdict)) {
    const failing = report.checks
      .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
      .map((c) => `${c.id}: ${c.summary}`);
    return {
      kind: "blocked",
      gate: "G0",
      message: `G0 ${report.verdict}. ${failing.join("; ")}. Fix these, then run /frontsmith:next ${env.feature}.`,
    };
  }
  await advance(env);
  return {
    kind: "advanced",
    message: `Context ready (${stack.framework}, ${stack.packageManager}). G0 ${report.verdict}.`,
  };
}
