import type { ModelSource } from "../state/feature-state.js";
import { isTier, parseModelValue, type Tier, tierNames } from "./grammar.js";

export type LayerName = Exclude<ModelSource, "default">;

/** A validated layer: raw value strings that already satisfy the grammar. */
export interface ModelLayer {
  name: LayerName;
  tiers: Partial<Record<Tier, string>>;
  agents: Record<string, string>;
}

export interface ModelDiagnostic {
  code:
    | "FSM-001"
    | "FSM-002"
    | "FSM-003"
    | "FSM-004"
    | "FSM-005"
    | "FSM-006"
    | "FSM-007"
    | "CFG-001"
    | "CFG-002";
  layer: LayerName;
  /** 1-based line within AGENTS.md. */
  line?: number;
  message: string;
}

/** `Model configuration error in <layer>: <diagnostic>` (spec 16.5). */
export const describeModelDiagnostic = (diagnostic: ModelDiagnostic): string =>
  `Model configuration error in ${diagnostic.layer}: ${diagnostic.code}${diagnostic.line ? ` line ${diagnostic.line}` : ""}: ${diagnostic.message}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type LayerValidation =
  | { ok: true; layer: ModelLayer }
  | { ok: false; diagnostics: ModelDiagnostic[] };

/**
 * Validate the JSON shape shared by the runtime file, the project config and the host options:
 * `{ "tiers": { "<tier>": "<value>" }, "agents": { "<agent>": "<value>" } }`. Unknown keys, an
 * `effort` key included, are `CFG-001` (B-05).
 */
export function validateModelLayer(
  raw: unknown,
  options: { layer: LayerName; knownAgents: readonly string[] },
): LayerValidation {
  const { layer } = options;
  const diagnostics: ModelDiagnostic[] = [];
  const add = (code: ModelDiagnostic["code"], pointer: string, message: string): void => {
    diagnostics.push({ code, layer, message: `${pointer}: ${message}` });
  };
  if (!isRecord(raw)) {
    add("CFG-002", "", "must be an object with tiers and agents");
    return { ok: false, diagnostics };
  }
  for (const key of Object.keys(raw))
    if (key !== "tiers" && key !== "agents") add("CFG-001", `/${key}`, "unknown key");
  const tiers: Partial<Record<Tier, string>> = {};
  const agents: Record<string, string> = {};
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) add("CFG-002", "/tiers", "must be an object");
    else
      for (const [key, value] of Object.entries(raw.tiers)) {
        if (!isTier(key)) {
          add("CFG-001", `/tiers/${key}`, `unknown tier (use ${tierNames.join(", ")})`);
          continue;
        }
        if (typeof value !== "string") {
          add("CFG-002", `/tiers/${key}`, "must be a string");
          continue;
        }
        const parsed = parseModelValue(value, { tierRef: false });
        if (parsed.ok) tiers[key] = value;
        else add(parsed.code, `/tiers/${key}`, parsed.message);
      }
  }
  if (raw.agents !== undefined) {
    if (!isRecord(raw.agents)) add("CFG-002", "/agents", "must be an object");
    else
      for (const [key, value] of Object.entries(raw.agents)) {
        if (!options.knownAgents.includes(key)) {
          add("FSM-004", `/agents/${key}`, "unknown agent");
          continue;
        }
        if (typeof value !== "string") {
          add("CFG-002", `/agents/${key}`, "must be a string");
          continue;
        }
        const parsed = parseModelValue(value, { tierRef: true });
        if (parsed.ok) agents[key] = value;
        else add(parsed.code, `/agents/${key}`, parsed.message);
      }
  }
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, layer: { name: layer, tiers, agents } };
}
