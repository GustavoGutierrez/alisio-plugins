import type { CommandName } from "../../domain/config/defaults.js";
import type { PackageManager } from "../../domain/stack/profile.js";

export interface PlannedCommand {
  argv: string[];
  /** `config`, `inferred:package.json#scripts.<name>` or `inferred:<test runner>`. */
  source: string;
}

export type CommandPlan = Partial<Record<CommandName, PlannedCommand>>;

/** Script names tried per command, in order; the first one present wins (spec 15.3). */
export const scriptPatterns: Record<
  "typecheck" | "lint" | "test" | "e2e" | "build",
  readonly string[]
> = {
  typecheck: ["typecheck", "type-check", "tsc", "check:types"],
  lint: ["lint"],
  test: ["test"],
  e2e: ["test:e2e", "e2e", "playwright"],
  build: ["build"],
};

/** Which script matched each command name, for the stack profile. */
export function matchedScripts(scripts: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [command, names] of Object.entries(scriptPatterns)) {
    const name = names.find((candidate) => scripts[candidate] !== undefined);
    if (name !== undefined) out[command] = scripts[name] as string;
  }
  return out;
}

/** Executable prefix that runs a locally installed binary, per package manager (spec 15.3). */
const binaryRunner: Record<PackageManager, readonly string[]> = {
  npm: ["npx"],
  pnpm: ["pnpm", "exec"],
  yarn: ["yarn"],
  bun: ["bunx"],
};

/**
 * Infer project commands from `package.json#scripts`. `testRelated` is inferred only for vitest
 * and jest, run through the package manager's own binary runner; otherwise gates fall back to
 * `test`.
 */
export function inferCommands(
  packageManager: PackageManager,
  scripts: Readonly<Record<string, string>>,
  tests: readonly string[],
): CommandPlan {
  const plan: CommandPlan = {};
  for (const [command, names] of Object.entries(scriptPatterns)) {
    const name = names.find((candidate) => scripts[candidate] !== undefined);
    if (name !== undefined)
      plan[command as keyof typeof scriptPatterns] = {
        argv: [packageManager, "run", name],
        source: `inferred:package.json#scripts.${name}`,
      };
  }
  if (tests.includes("vitest"))
    plan.testRelated = {
      argv: [...binaryRunner[packageManager], "vitest", "related", "--run", "{files}"],
      source: "inferred:vitest",
    };
  else if (tests.includes("jest"))
    plan.testRelated = {
      argv: [...binaryRunner[packageManager], "jest", "--findRelatedTests", "{files}"],
      source: "inferred:jest",
    };
  return plan;
}

/** Configured commands win over inferred ones. */
export function resolveCommands(
  inferred: CommandPlan,
  configured: Partial<Record<CommandName, string[]>>,
): CommandPlan {
  const plan: CommandPlan = { ...inferred };
  for (const [name, argv] of Object.entries(configured) as Array<[CommandName, string[]]>)
    plan[name] = { argv: [...argv], source: "config" };
  return plan;
}
