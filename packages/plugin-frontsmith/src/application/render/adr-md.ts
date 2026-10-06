import type { PlanEnvelope } from "../../domain/envelopes/plan.js";
import { document } from "./md.js";

export type Adr = PlanEnvelope["adrs"][number];

/** `adr/ADR-001.md`. */
export function renderAdrMd(adr: Adr): string {
  return document(
    `# ${adr.id}: ${adr.title}`,
    "## Context",
    adr.context,
    "## Decision",
    adr.decision,
    "## Consequences",
    adr.consequences,
  );
}
