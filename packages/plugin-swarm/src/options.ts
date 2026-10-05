import { rolePattern } from "./domain/identifiers.js";

export interface SwarmOptions {
  /** Roles running at once, below the host's subagent limits. */
  maxConcurrent: number;
  /** Per-role overrides (`pluginOverrides.swarm.options.roles.<role>.model`). */
  roles: Record<string, { model?: string }>;
  /** Soft cap on total tokens across the swarm (`options.tokenBudget`); absent means unlimited. */
  tokenBudget?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Lenient: an invalid option falls back to its default instead of breaking startup. */
export function parseOptions(raw: unknown): SwarmOptions {
  const options: SwarmOptions = { maxConcurrent: 3, roles: {} };
  if (!isRecord(raw)) return options;
  const cap = raw.maxConcurrent;
  if (typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 8) {
    options.maxConcurrent = cap;
  }
  const budget = raw.tokenBudget;
  if (typeof budget === "number" && Number.isInteger(budget) && budget >= 1000) {
    options.tokenBudget = budget;
  }
  if (isRecord(raw.roles)) {
    for (const [role, value] of Object.entries(raw.roles)) {
      if (!rolePattern.test(role) || !isRecord(value)) continue;
      const model = value.model;
      options.roles[role] =
        typeof model === "string" && model.length > 0 && model.length <= 200 ? { model } : {};
    }
  }
  return options;
}
