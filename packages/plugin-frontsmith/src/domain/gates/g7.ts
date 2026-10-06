import type { Level } from "../state/levels.js";
import { requirementsForLevel } from "../state/levels.js";
import { addPrepared, GateBuilder, type GateOutcome, type Prepared } from "./aggregate.js";
import { addEvidence } from "./evidence.js";

export interface G7Input {
  level: Level;
  /** Full rule packs on the feature scope. */
  rules: Prepared | undefined;
  architecture: Prepared | undefined;
  architectureConfigured: boolean;
  commands: { test: Prepared | undefined; build: Prepared | undefined; e2e: Prepared | undefined };
  /** The test map has end-to-end entries. */
  e2eInTestMap: boolean;
  /** The contract has fidelity rules, so the pipeline must have run for the required cases. */
  fidelityRequired: boolean;
  fidelity: Prepared | undefined;
  /** Runtime accessibility (axe, focus order, real pairs); mandatory at L3. */
  a11yRequired: boolean;
  a11y: Prepared | undefined;
  budgets: Prepared | undefined;
  /** Judgment: findings of the accessibility auditor, when it ran. */
  audit: Prepared | undefined;
  custom: ReadonlyArray<{ id: string; prepared: Prepared }>;
}

/** G7 Validation (spec 7.2): end-to-end proof for the whole feature. */
export function gateG7(input: G7Input): GateOutcome {
  const b = new GateBuilder();
  addEvidence(b, "rules", input.rules, {
    required: true,
    missing: "the rule packs could not be evaluated",
  });
  addEvidence(b, "architecture", input.architecture, {
    required: input.architectureConfigured,
    missing: input.architectureConfigured
      ? "the architecture check did not run"
      : "no architecture configuration",
  });
  addEvidence(b, "command:test", input.commands.test, {
    required: true,
    missing: "no test command",
  });
  const needsBuild = input.level === "L2" || input.level === "L3";
  addEvidence(b, "command:build", input.commands.build, {
    required: needsBuild,
    missing: needsBuild ? "no build command" : "build is not required at this level",
  });
  const needsE2e = input.level === "L3" || input.e2eInTestMap;
  addEvidence(b, "command:e2e", input.commands.e2e, {
    required: needsE2e,
    missing: needsE2e ? "no e2e command" : "end-to-end tests are not required",
  });
  addEvidence(b, "fidelity", input.fidelity, {
    required: input.fidelityRequired,
    missing: input.fidelityRequired
      ? "the fidelity pipeline did not run"
      : "the contract has no fidelity rules",
  });
  const a11yRequired = input.a11yRequired || requirementsForLevel(input.level).a11yAuditMandatory;
  addEvidence(b, "a11y-runtime", input.a11y, {
    required: a11yRequired,
    missing: a11yRequired
      ? "the runtime accessibility check did not run"
      : "no runtime accessibility evidence required",
  });
  addEvidence(b, "budgets", input.budgets, { required: false, missing: "no budgets configured" });
  if (input.audit) addPrepared(b, "a11y-audit", input.audit);
  for (const gate of input.custom) addPrepared(b, `custom:${gate.id}`, gate.prepared);
  return b.outcome;
}
