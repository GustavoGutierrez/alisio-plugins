import type { ReviewEnvelope } from "../envelopes/review.js";
import { reviewVerdict } from "../envelopes/review.js";
import type { Level } from "../state/levels.js";
import { requirementsForLevel } from "../state/levels.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G8Input {
  level: Level;
  /** Validated review envelopes, one per independent run. */
  reviews: readonly ReviewEnvelope[];
}

/** G8 Review (spec 7.2): the verdict is recomputed by code; any BLOCKER or MAJOR requests changes. */
export function gateG8(input: G8Input): GateOutcome {
  const b = new GateBuilder();
  const needed = requirementsForLevel(input.level).reviewRuns;
  if (input.reviews.length >= needed)
    b.add(
      "runs",
      "PASS",
      `${input.reviews.length} independent review run${input.reviews.length === 1 ? "" : "s"}`,
    );
  else {
    b.add("runs", "BLOCKED", `${input.reviews.length} of ${needed} review runs`);
    b.finding(
      "runs",
      "REV-001",
      "blocker",
      "BLOCKED",
      `This level needs ${needed} independent review runs.`,
    );
  }
  const findings = input.reviews.flatMap((review) => review.findings);
  const open = findings.filter((f) => f.severity === "BLOCKER" || f.severity === "MAJOR");
  const verdict = reviewVerdict(findings);
  if (verdict === "approved") {
    const minors = findings.filter((f) => f.severity === "MINOR").length;
    if (minors === 0) b.add("findings", "PASS", "no blocker or major finding");
    else
      b.add("findings", "REVIEW", `no blocker or major finding; ${minors} minor to fix or justify`);
  } else
    b.add(
      "findings",
      "FAIL",
      `${open.length} blocker or major finding${open.length === 1 ? "" : "s"} open`,
    );
  for (const f of findings)
    b.finding(
      "findings",
      `REV-${f.dimension.toUpperCase().replace(/[^A-Z]/g, "")}`.slice(0, 16),
      f.severity === "BLOCKER"
        ? "blocker"
        : f.severity === "MAJOR"
          ? "major"
          : f.severity === "MINOR"
            ? "minor"
            : "nit",
      f.severity === "BLOCKER" || f.severity === "MAJOR"
        ? "FAIL"
        : f.severity === "MINOR"
          ? "REVIEW"
          : "PASS",
      f.claim,
      { file: f.file, line: f.line, fix: f.fix, kind: "agent" },
    );
  return b.outcome;
}
