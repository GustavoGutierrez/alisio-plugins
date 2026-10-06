import type { PlanEnvelope } from "../envelopes/plan.js";
import type { SpecEnvelope } from "../envelopes/spec.js";
import type { TestMapEnvelope } from "../envelopes/test-map.js";
import type { UiContractEnvelope } from "../envelopes/ui-contract.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G4Input {
  spec: SpecEnvelope;
  plan: PlanEnvelope;
  testMap: TestMapEnvelope;
  /** Absent at levels without a UI contract. */
  contract?: UiContractEnvelope;
}

/** G4 Tests (spec 7.2): every criterion can be verified and the right levels exist. */
export function gateG4(input: G4Input): GateOutcome {
  const { spec, testMap, contract } = input;
  const b = new GateBuilder();
  b.add("schema", "PASS", "test map envelope valid");
  const entries = new Map(testMap.entries.map((entry) => [entry.acId, entry]));

  const problems: string[] = [];
  for (const ac of spec.acceptanceCriteria) {
    const entry = entries.get(ac.id);
    if (!entry) {
      problems.push(`${ac.id} has no test map entry`);
      continue;
    }
    const automated = entry.tests.length > 0 && entry.levels.some((level) => level !== "manual");
    const manual = entry.manual !== null && entry.manual.justification.trim() !== "";
    if (!automated && !manual)
      problems.push(`${ac.id} has neither an automated test nor a justified manual check`);
  }
  b.problems("coverage", "TST-001", problems, "every criterion is verifiable", {
    fix: "Add a test entry, or a manual entry with procedure and justification.",
  });

  if (contract && contract.fidelityRules.length > 0) {
    const visualEntries = testMap.entries.filter((entry) => entry.levels.includes("visual"));
    const uncovered = [...new Set(contract.cases.map((c) => c.stateId))].filter((stateId) => {
      const caseIds = contract.cases.filter((c) => c.stateId === stateId).map((c) => c.id);
      return !visualEntries.some((entry) =>
        [entry.risk, entry.evidence, ...entry.tests.map((t) => t.name)].some(
          (text) => text.includes(stateId) || caseIds.some((id) => text.includes(id)),
        ),
      );
    });
    if (uncovered.length === 0)
      b.add("visual", "PASS", "every state with fidelity rules has a visual entry");
    else {
      b.add(
        "visual",
        "FAIL",
        `${uncovered.length} state${uncovered.length === 1 ? "" : "s"} without a visual entry`,
      );
      for (const stateId of uncovered)
        b.finding(
          "visual",
          "TST-002",
          "major",
          "FAIL",
          `State ${stateId} has fidelity rules but no visual test map entry that names it.`,
          {
            fix: "Add a visual entry whose evidence names the state or the case id.",
          },
        );
    }
  } else b.add("visual", "SKIPPED", "no fidelity rules", { required: false });

  if (contract && contract.interactions.length > 0)
    b.problems(
      "a11y-entries",
      "TST-003",
      testMap.entries.some((entry) => entry.levels.includes("a11y"))
        ? []
        : ["the contract has interactive elements but no accessibility entry"],
      "an accessibility entry exists",
    );
  else b.add("a11y-entries", "SKIPPED", "no interactions", { required: false });

  const critical = new Set(spec.acceptanceCriteria.filter((ac) => ac.critical).map((ac) => ac.id));
  const stray = testMap.entries.filter(
    (entry) => entry.levels.includes("e2e") && !critical.has(entry.acId),
  );
  if (stray.length === 0)
    b.add("e2e-scope", "PASS", "end-to-end tests only on critical criteria", { required: false });
  else {
    b.add(
      "e2e-scope",
      "REVIEW",
      `${stray.length} end-to-end entr${stray.length === 1 ? "y" : "ies"} on non-critical criteria`,
      { required: false },
    );
    for (const entry of stray)
      b.finding(
        "e2e-scope",
        "TST-004",
        "minor",
        "REVIEW",
        `${entry.acId} has an end-to-end entry but is not marked critical.`,
        {
          kind: "heuristic",
          fix: "Use a cheaper level or mark the criterion critical.",
        },
      );
  }
  return b.outcome;
}
