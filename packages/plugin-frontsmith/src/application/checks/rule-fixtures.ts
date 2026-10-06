import {
  type ArchitectureConfig,
  parseArchitectureConfig,
} from "../../domain/architecture/config.js";
import {
  defaultConfig,
  type FrontsmithConfig,
  resolveConfig,
} from "../../domain/config/defaults.js";
import { compileGlob } from "../../domain/glob.js";
import type { ResolvedRule, RuleDef } from "../../domain/rules/model.js";
import type { TokensData, UnitContext } from "../../domain/rules/unit.js";
import type { StackProfile } from "../../domain/stack/profile.js";
import type { BudgetInput } from "../engines/types.js";
import type { AriaCatalog } from "../ports/aria-catalog.js";
import { MemoryWorkspace } from "./memory-workspace.js";
import { type RulesCheckDeps, type RulesCheckResult, runRulesCheck } from "./rules-check.js";

/**
 * A rule fixture is either one source file, evaluated at a path that matches the rule's `files`,
 * or a JSON document with a top-level `$fixture` describing a virtual workspace.
 */
export interface FixtureSpec {
  files?: Record<string, string>;
  stack?: Partial<StackProfile>;
  unit?: UnitContext;
  tokens?: TokensData;
  budget?: BudgetInput;
  architecture?: unknown;
  config?: Record<string, unknown>;
}

export const defaultFixtureStack = (patch: Partial<StackProfile> = {}): StackProfile => ({
  packageManager: "pnpm",
  monorepo: false,
  typescript: true,
  framework: "react",
  frameworkVersion: "18.3.1",
  meta: "none",
  styling: ["css", "tailwind"],
  tailwindMajor: 3,
  state: [],
  tests: ["vitest"],
  storybook: false,
  playwrightResolvable: false,
  axeResolvable: false,
  sourceRoots: ["src"],
  scripts: {},
  evidence: [],
  ...patch,
});

/** A path that matches the first glob of a rule, for single-file fixtures. */
export function exampleFor(glob: string, ext: string): string {
  let out = glob.replace(/\{([^{}]*)\}/g, (_match, body: string) => {
    const options = body.split(",");
    return options.includes(ext) ? ext : (options[0] as string);
  });
  out = out
    .replace(/^\*\*\//, "src/")
    .replace(/\*\*\//g, "x/")
    .replace(/\/\*\*$/, "/x")
    .replace(/\*\*/g, "x")
    .replace(/\*/g, "fixture")
    .replace(/\?/g, "a");
  return out;
}

export interface FixtureRun {
  rule: RuleDef;
  packId: string;
  /** File extension of the fixture file, without the dot. */
  ext: string;
  text: string;
}

export interface FixtureContext {
  aria: AriaCatalog;
  deps: RulesCheckDeps;
  today: string;
}

/** Evaluate one rule against one fixture. */
export async function runRuleFixture(
  run: FixtureRun,
  context: FixtureContext,
): Promise<RulesCheckResult> {
  let spec: FixtureSpec = {};
  let files: Record<string, string> = {};
  const document =
    run.ext === "json" ? (JSON.parse(run.text) as { $fixture?: FixtureSpec }) : undefined;
  if (document?.$fixture) {
    spec = document.$fixture;
    files = { ...(spec.files ?? {}) };
  } else {
    const path = exampleFor(run.rule.files[0] as string, run.ext);
    if (!run.rule.files.some((glob) => compileGlob(glob)(path)))
      throw new Error(`derived path ${path} does not match ${run.rule.files.join(", ")}`);
    files = { [path]: run.text };
  }
  let architecture: ArchitectureConfig | undefined;
  if (spec.architecture) {
    const parsed = parseArchitectureConfig(spec.architecture);
    if (!parsed.ok)
      throw new Error(`fixture architecture is invalid: ${JSON.stringify(parsed.errors)}`);
    architecture = parsed.config;
  }
  const config: FrontsmithConfig = resolveConfig({
    ...defaultConfig(),
    ...(spec.config ?? {}),
  } as never);
  const rule: ResolvedRule = {
    ...run.rule,
    packId: run.packId,
    origin: `shipped:${run.packId}`,
    trail: [{ source: `shipped:${run.packId}`, change: "defined" }],
  };
  return runRulesCheck(
    {
      fs: new MemoryWorkspace(files),
      rules: [rule],
      stack: defaultFixtureStack(spec.stack),
      config,
      aria: context.aria,
      today: context.today,
      ...(architecture ? { architecture } : {}),
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(spec.tokens ? { tokens: spec.tokens } : {}),
      ...(spec.budget ? { budget: spec.budget } : {}),
    },
    context.deps,
  );
}
