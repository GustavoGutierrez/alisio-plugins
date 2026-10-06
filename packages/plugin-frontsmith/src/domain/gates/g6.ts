import { addPrepared, GateBuilder, type GateOutcome, type Prepared } from "./aggregate.js";
import { addEvidence } from "./evidence.js";

export interface G6Input {
  envelope: Prepared;
  /** FS-GOV-001: hashes of the protected set compared before and after the child run. */
  protectedFiles: Prepared;
  /** FS-GOV-005: changed paths against the task's files, tests and allowed generated paths. */
  scope: Prepared;
  /** Rule packs (diff guards included) on the changed files. */
  rules: Prepared | undefined;
  /** Architecture on the import closure of the changed files; absent without a configuration. */
  architecture: Prepared | undefined;
  architectureConfigured: boolean;
  commands: {
    typecheck: Prepared | undefined;
    lint: Prepared | undefined;
    /** Related tests, or the full test command when related tests are unavailable. */
    tests: Prepared | undefined;
  };
  /** Present when the task requires test-first (`tdd: required`). */
  testFirst: Prepared | undefined;
  custom: ReadonlyArray<{ id: string; prepared: Prepared }>;
}

/** G6 Implementation (spec 7.2): local proof after one build task. */
export function gateG6(input: G6Input): GateOutcome {
  const b = new GateBuilder();
  addPrepared(b, "envelope", input.envelope);
  addPrepared(b, "protected-files", input.protectedFiles);
  addPrepared(b, "scope", input.scope);
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
  addEvidence(b, "command:typecheck", input.commands.typecheck, {
    required: true,
    missing: "no typecheck command",
  });
  addEvidence(b, "command:lint", input.commands.lint, {
    required: true,
    missing: "no lint command",
  });
  addEvidence(b, "command:tests", input.commands.tests, {
    required: true,
    missing: "no test command",
  });
  addEvidence(b, "test-first", input.testFirst, {
    required: false,
    missing: "the task is exempt from test-first",
  });
  for (const gate of input.custom) addPrepared(b, `custom:${gate.id}`, gate.prepared);
  return b.outcome;
}
