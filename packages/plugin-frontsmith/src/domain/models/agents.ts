import type { Tier } from "./grammar.js";

/**
 * The twelve shipped agents and their default tiers (spec 5.1). The agent files of a later phase
 * must declare the same `tier`; a test pins the two together.
 */
export const shippedAgentTiers: Readonly<Record<string, Tier>> = {
  "fs-coordinator": "standard",
  "fs-specifier": "reasoning",
  "fs-ui-contractor": "reasoning",
  "fs-tokensmith": "standard",
  "fs-architect": "reasoning",
  "fs-test-engineer": "standard",
  "fs-implementer": "standard",
  "fs-data-engineer": "standard",
  "fs-a11y-auditor": "standard",
  "fs-fidelity-reviewer": "standard",
  "fs-reviewer": "reasoning",
  "fs-archivist": "fast",
};

/** A custom agent without a `tier` runs on the standard tier (TODO(owner): spec 17.1 is silent). */
export const DEFAULT_CUSTOM_TIER: Tier = "standard";

export type BindingTarget = { kind: "tier"; name: Tier } | { kind: "agent"; name: string };

const AGENT_NAME = /^[a-z][a-z0-9-]{2,40}$/;

/** `tier.<t>` or `agent.<name>`, as used by `set`, `unset` and `pick`. */
export function parseBindingTarget(text: string): BindingTarget | undefined {
  const [kind, name, ...rest] = text.split(".");
  if (rest.length > 0 || name === undefined) return undefined;
  if (kind === "tier" && (name === "reasoning" || name === "standard" || name === "fast"))
    return { kind: "tier", name };
  if (kind === "agent" && AGENT_NAME.test(name)) return { kind: "agent", name };
  return undefined;
}
