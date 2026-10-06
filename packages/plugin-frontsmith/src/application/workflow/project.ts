import type { CommandName } from "../../domain/config/defaults.js";
import type { StackProfile } from "../../domain/stack/profile.js";
import { type CommandPlan, inferCommands, resolveCommands } from "../detect/commands.js";
import { buildInventory, type InventoryRow } from "../detect/inventory.js";
import type { PhaseEnv } from "./env.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Package scripts by name, from the workspace `package.json` (empty when absent or unreadable). */
export async function readPackageScripts(env: PhaseEnv): Promise<Record<string, string>> {
  const read = await env.deps.fsFor(env.root).read("package.json");
  if (read.kind !== "text") return {};
  try {
    const manifest: unknown = JSON.parse(read.text);
    const scripts = isRecord(manifest) ? manifest.scripts : undefined;
    if (!isRecord(scripts)) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Configured commands win over the ones inferred from `package.json` scripts (spec 15.3). */
export async function loadCommandPlan(env: PhaseEnv, stack: StackProfile): Promise<CommandPlan> {
  const scripts = await readPackageScripts(env);
  return resolveCommands(
    inferCommands(stack.packageManager, scripts, stack.tests),
    env.config.commands,
  );
}

export const COMMAND_NAMES: readonly CommandName[] = [
  "typecheck",
  "lint",
  "test",
  "testRelated",
  "e2e",
  "build",
];

const SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|less|vue|svelte|astro)$/i;

/** Components, hooks, stores and design tokens of the workspace (spec 10.5 `fs_inventory`). */
export async function inventoryRows(env: PhaseEnv): Promise<InventoryRow[]> {
  const fs = env.deps.fsFor(env.root);
  const listing = await fs.listFiles();
  const analyses = [];
  for (const path of listing.files) {
    if (!SOURCE.test(path)) continue;
    const read = await fs.read(path);
    if (read.kind === "text") analyses.push(env.deps.analyzer.analyze(path, read.text));
  }
  return buildInventory(analyses, { kinds: ["all"], tokenFiles: env.config.paths.tokenFiles });
}

/** The tokens phase runs when the contract declares new tokens or no token system exists (spec 7.1). */
export async function tokensPhaseNeeded(
  env: PhaseEnv,
  contract: { tokensNeeded: ReadonlyArray<{ status: string }> },
): Promise<boolean> {
  if (contract.tokensNeeded.some((t) => t.status === "new")) return true;
  return (await inventoryRows(env)).every((row) => row.kind !== "token");
}
