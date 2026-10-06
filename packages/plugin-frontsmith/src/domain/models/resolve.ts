import type { ModelSource } from "../state/feature-state.js";
import type { Tier } from "./grammar.js";
import type { ModelLayer } from "./layers.js";

export interface TrailStep {
  layer: ModelSource;
  key: string;
  value: string;
}

export interface ModelResolution {
  agent: string;
  defaultTier: Tier;
  /** The tier the agent resolves under, or `null` when it is bound directly to a model or inherit. */
  effectiveTier: Tier | null;
  /** Model selector, or `null` for `inherit` (the child uses the parent session's model). */
  model: string | null;
  /** The layer that produced the final model value, or `default`. */
  source: ModelSource;
  trail: TrailStep[];
}

/**
 * Resolve the model of one agent (spec 16.3). `layers` holds the validated layers 1 to 4, highest
 * first; the plugin default (frontmatter tier, tier binding `inherit`) is layer 5.
 */
export function resolveModel(
  agent: string,
  defaultTier: Tier,
  layers: readonly ModelLayer[],
): ModelResolution {
  const trail: TrailStep[] = [];
  const direct = layers.find((layer) => layer.agents[agent] !== undefined);
  const assigned = direct ? (direct.agents[agent] as string) : `@${defaultTier}`;
  const assignedFrom: ModelSource = direct ? direct.name : "default";
  trail.push({ layer: assignedFrom, key: `agent.${agent}`, value: assigned });
  if (!assigned.startsWith("@"))
    return {
      agent,
      defaultTier,
      effectiveTier: null,
      model: assigned === "inherit" ? null : assigned,
      source: assignedFrom,
      trail,
    };
  const tier = assigned.slice(1) as Tier;
  const bound = layers.find((layer) => layer.tiers[tier] !== undefined);
  const value = bound ? (bound.tiers[tier] as string) : "inherit";
  const source: ModelSource = bound ? bound.name : "default";
  trail.push({ layer: source, key: `tier.${tier}`, value });
  return {
    agent,
    defaultTier,
    effectiveTier: tier,
    model: value === "inherit" ? null : value,
    source,
    trail,
  };
}
