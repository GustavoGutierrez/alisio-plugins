import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G2TPair {
  fg: string;
  bg: string;
  theme: string;
  ratio: number;
  minimum: number;
}

export interface G2TInput {
  /** Tokens whose names break the FS-TOK naming rules. */
  namingProblems: string[];
  solver:
    | { status: "ok" }
    | { status: "unsat"; reason: string }
    | { status: "skipped"; reason: string };
  pairs: readonly G2TPair[];
  /** Locked brand colours whose value changed. */
  lockedViolations: string[];
}

/** G2T Tokens (spec 7.2): names, solver outcome, every required pair at target, locked colours intact. */
export function gateG2T(input: G2TInput): GateOutcome {
  const b = new GateBuilder();
  b.problems("naming", "FS-TOK-NAME", input.namingProblems, "token names follow the naming rules", {
    severity: "major",
  });
  if (input.solver.status === "unsat") {
    b.add("solver", "FAIL", `UNSAT: ${input.solver.reason}`);
    b.finding("solver", "TOK-UNSAT", "blocker", "FAIL", input.solver.reason, {
      fix: "Relax a locked colour or choose another family; contrast is never relaxed.",
    });
  } else if (input.solver.status === "skipped")
    b.add("solver", "SKIPPED", input.solver.reason, { required: false });
  else b.add("solver", "PASS", "the palette is satisfiable");
  const failing = input.pairs.filter((pair) => pair.ratio < pair.minimum);
  b.problems(
    "pairs",
    "TOK-PAIR",
    failing.map(
      (pair) =>
        `${pair.fg} on ${pair.bg} (${pair.theme}) is ${pair.ratio.toFixed(6)}, below ${pair.minimum}`,
    ),
    input.pairs.length === 0 ? "no pairs to evaluate" : `${input.pairs.length} pairs pass`,
    { severity: "blocker" },
  );
  b.problems("locked", "TOK-LOCKED", input.lockedViolations, "locked colours unchanged", {
    severity: "blocker",
  });
  return b.outcome;
}
