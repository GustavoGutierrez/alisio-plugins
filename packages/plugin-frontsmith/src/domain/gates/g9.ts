import type { Trace } from "../traceability.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G9Input {
  trace: readonly Trace[];
  /** Required checks that are BLOCKED in the latest gate reports and not waived. */
  blockedChecks: readonly string[];
  /** Waivers the feature relies on that have expired. */
  expiredWaivers: readonly string[];
  /** Deviations reported by tasks, listed for the acceptance report. */
  deviations: readonly string[];
}

/** G9 Accept (spec 7.2): traceability, no blocked required check, valid waivers, deviations listed. */
export function gateG9(input: G9Input): GateOutcome {
  const b = new GateBuilder();
  const untraced = input.trace.filter((row) => row.status === "MISSING");
  b.problems(
    "traceability",
    "TRC-001",
    untraced.map((row) => `${row.acId}: no evidence (${row.note})`),
    `${input.trace.length} criteria traced to evidence`,
    {
      fix: "Run the missing validation, or record /frontsmith:verify-manual <feature> <AC-id> -- <evidence>.",
    },
  );
  if (input.blockedChecks.length === 0)
    b.add("blocked-checks", "PASS", "no required check is blocked");
  else {
    b.add(
      "blocked-checks",
      "BLOCKED",
      `${input.blockedChecks.length} required check${input.blockedChecks.length === 1 ? "" : "s"} blocked`,
    );
    for (const check of input.blockedChecks)
      b.finding(
        "blocked-checks",
        "G9-BLOCKED",
        "blocker",
        "BLOCKED",
        `${check} is blocked and not waived.`,
      );
  }
  b.problems(
    "waivers",
    "G9-WAIVER",
    input.expiredWaivers.map((id) => `waiver ${id} has expired`),
    "waivers are valid",
    {
      severity: "major",
    },
  );
  if (input.deviations.length === 0)
    b.add("deviations", "PASS", "no deviations recorded", { required: false });
  else {
    b.add(
      "deviations",
      "REVIEW",
      `${input.deviations.length} deviation${input.deviations.length === 1 ? "" : "s"} to review`,
      { required: false },
    );
    for (const d of input.deviations)
      b.finding("deviations", "G9-DEVIATION", "minor", "REVIEW", d, { kind: "heuristic" });
  }
  return b.outcome;
}
