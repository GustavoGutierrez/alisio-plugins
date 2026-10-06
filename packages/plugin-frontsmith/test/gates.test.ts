import { describe, expect, it } from "vitest";
import { envelopeExamples } from "../src/application/agents/examples.js";
import type { PlanEnvelope } from "../src/domain/envelopes/plan.js";
import { validateEnvelope } from "../src/domain/envelopes/registry.js";
import type { SpecEnvelope } from "../src/domain/envelopes/spec.js";
import type { TestMapEnvelope } from "../src/domain/envelopes/test-map.js";
import type { UiContractEnvelope } from "../src/domain/envelopes/ui-contract.js";
import { buildGateReport, type GateOutcome, type Prepared } from "../src/domain/gates/aggregate.js";
import { gateG0, requiredCommands } from "../src/domain/gates/g0.js";
import { gateG1, hasSelectorPattern } from "../src/domain/gates/g1.js";
import { derivedViewportWidths, gateG2 } from "../src/domain/gates/g2.js";
import { gateG2T } from "../src/domain/gates/g2t.js";
import { dependencyCycle, gateG3 } from "../src/domain/gates/g3.js";
import { gateG4 } from "../src/domain/gates/g4.js";
import { gateG5 } from "../src/domain/gates/g5.js";
import { gateG6 } from "../src/domain/gates/g6.js";
import { gateG7 } from "../src/domain/gates/g7.js";
import { gateG8 } from "../src/domain/gates/g8.js";
import { gateG9 } from "../src/domain/gates/g9.js";
import { buildTrace } from "../src/domain/traceability.js";

const report = (outcome: GateOutcome, gate = "G1" as const) =>
  buildGateReport({
    gate,
    feature: "projects",
    outcome,
    generatedAt: "2026-10-06T12:00:00Z",
    version: "0.1.0",
  });
const status = (outcome: GateOutcome, id: string) =>
  outcome.checks.find((c) => c.id === id)?.status;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const spec = (): SpecEnvelope => {
  const raw = clone(envelopeExamples.spec) as Record<string, unknown>;
  raw.states = [
    { id: "ST-initial", kind: "initial", description: "first paint" },
    { id: "ST-success", kind: "success", description: "loaded" },
  ];
  const result = validateEnvelope("spec", raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const plan = (mutate: (raw: Record<string, unknown>) => void = () => undefined): PlanEnvelope => {
  const raw = clone(envelopeExamples.plan) as Record<string, unknown>;
  mutate(raw);
  const result = validateEnvelope("plan", raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const contract = (
  mutate: (raw: Record<string, unknown>) => void = () => undefined,
): UiContractEnvelope => {
  const raw = clone(envelopeExamples["ui-contract"]) as Record<string, unknown>;
  mutate(raw);
  const result = validateEnvelope("ui-contract", raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};

describe("gate report", () => {
  it("allocates finding ids in stable order, lists them on their check and aggregates by precedence", () => {
    const outcome: GateOutcome = {
      checks: [
        { id: "a", status: "FAIL", required: true, summary: "x" },
        { id: "b", status: "PASS", required: true, summary: "y" },
      ],
      findings: [
        {
          check: "a",
          ruleId: "Z-1",
          severity: "major",
          status: "FAIL",
          kind: "deterministic",
          message: "m",
          file: "src/b.ts",
          line: 3,
        },
        {
          check: "a",
          ruleId: "A-1",
          severity: "major",
          status: "FAIL",
          kind: "deterministic",
          message: "m",
          file: "src/a.ts",
          line: 9,
        },
      ],
    };
    const built = report(outcome);
    expect(built.schema).toBe("frontsmith.gate-report/v1");
    expect(built.findings.map((f) => [f.id, f.file])).toEqual([
      ["F-0001", "src/a.ts"],
      ["F-0002", "src/b.ts"],
    ]);
    expect(built.checks[0]?.findings).toEqual(["F-0001", "F-0002"]);
    expect(built.verdict).toBe("FAIL");
    expect(built.coverage).toEqual({ required: 2, executed: 2, pending: 0 });
  });

  it("is BLOCKED when nothing was evidenced and REVIEW when only a review item remains", () => {
    expect(report({ checks: [], findings: [] }).verdict).toBe("BLOCKED");
    expect(
      report({ checks: [{ id: "a", status: "REVIEW", required: true, summary: "" }], findings: [] })
        .verdict,
    ).toBe("REVIEW");
  });
});

describe("G0 context", () => {
  const base = {
    level: "L2" as const,
    configProblems: [],
    packProblems: [],
    modelProblems: [],
    architectureProblems: [],
    stackDetected: true,
    commands: requiredCommands("L2").map((name) => ({ name, resolved: true, source: "config" })),
    gitRepository: true,
  };

  it("passes with everything in place", () => {
    expect(report(gateG0(base), "G0").verdict).toBe("PASS");
  });

  it("requires typecheck, lint and test, then build at L2 and e2e at L3", () => {
    expect(requiredCommands("L0")).toEqual(["typecheck", "lint", "test"]);
    expect(requiredCommands("L2")).toEqual(["typecheck", "lint", "test", "build"]);
    expect(requiredCommands("L3")).toEqual(["typecheck", "lint", "test", "build", "e2e"]);
  });

  it("FAILs on config, pack and model problems and BLOCKs on missing commands, stack and git", () => {
    expect(
      report(gateG0({ ...base, configProblems: ["CFG-001 /x: unknown key"] }), "G0").verdict,
    ).toBe("FAIL");
    expect(report(gateG0({ ...base, packProblems: ["PCK-001"] }), "G0").verdict).toBe("FAIL");
    expect(report(gateG0({ ...base, modelProblems: ["FSM-006"] }), "G0").verdict).toBe("FAIL");
    expect(report(gateG0({ ...base, architectureProblems: ["bad"] }), "G0").verdict).toBe("FAIL");
    const noLint = gateG0({
      ...base,
      commands: base.commands.map((c) => (c.name === "lint" ? { ...c, resolved: false } : c)),
    });
    expect(status(noLint, "command:lint")).toBe("BLOCKED");
    expect(report(noLint, "G0").verdict).toBe("BLOCKED");
    expect(report(gateG0({ ...base, stackDetected: false }), "G0").verdict).toBe("BLOCKED");
    expect(report(gateG0({ ...base, gitRepository: false }), "G0").verdict).toBe("BLOCKED");
  });

  it("lets L0 start without git (its diff checks are BLOCKED later) and ignores commands the level does not need", () => {
    const l0 = gateG0({
      ...base,
      level: "L0",
      gitRepository: false,
      commands: base.commands.map((c) => (c.name === "build" ? { ...c, resolved: false } : c)),
    });
    expect(status(l0, "git")).toBe("SKIPPED");
    expect(l0.checks.find((c) => c.id === "command:build")).toBeUndefined();
    expect(report(l0, "G0").verdict).toBe("PASS");
  });
});

describe("G1 spec", () => {
  it("passes a complete spec", () => {
    expect(
      report(gateG1({ spec: spec(), questions: [{ id: "Q-01", blocking: false }] })).verdict,
    ).toBe("PASS");
  });

  it("flags a requirement without criteria, an unknown requirement reference and missing states", () => {
    const s = spec();
    s.requirements.push({ id: "R-02", statement: "Export", priority: "should" });
    s.acceptanceCriteria[0]!.requirementId = "R-09";
    s.states = [{ id: "ST-initial", kind: "initial", description: "x" }];
    const outcome = gateG1({ spec: s, questions: [] });
    expect(status(outcome, "requirements")).toBe("FAIL");
    expect(status(outcome, "acceptance-refs")).toBe("FAIL");
    expect(status(outcome, "states")).toBe("FAIL");
    expect(outcome.findings.map((f) => f.ruleId)).toEqual(
      expect.arrayContaining(["SPC-001", "SPC-002", "SPC-003"]),
    );
  });

  it("flags a state named in the text but not defined", () => {
    const s = spec();
    // biome-ignore lint/suspicious/noThenProperty: `then` is a field of the spec envelope.
    s.acceptanceCriteria[0]!.then = "the page shows ST-nowhere";
    expect(status(gateG1({ spec: s, questions: [] }), "states")).toBe("FAIL");
  });

  it("blocks on an unanswered blocking question and passes once it is answered", () => {
    const s = spec();
    s.openQuestions = [
      { id: "Q-01", question: "Who?", blocking: true, options: [], recommendation: "" },
    ];
    const open = gateG1({ spec: s, questions: [{ id: "Q-01", blocking: true }] });
    expect(status(open, "open-questions")).toBe("BLOCKED");
    expect(report(open).verdict).toBe("BLOCKED");
    const answered = gateG1({
      spec: s,
      questions: [{ id: "Q-01", blocking: true, answer: "members" }],
    });
    expect(status(answered, "open-questions")).toBe("PASS");
  });

  it("rejects selector and DOM patterns in criteria (SPC-007) but not ordinary prose", () => {
    for (const bad of [
      'click ".coupon-form > button:nth-child(2)"',
      "the #total-value contains 90",
      "//div[@id='x']",
      "document.querySelector('a')",
      "[data-testid=x] is visible",
    ])
      expect(hasSelectorPattern(bad), bad).toBe(true);
    for (const good of [
      "the total shown is 90",
      "a member with two projects sees both listed.",
      "The price is $1.50 and tax is 5.5% (see section 3).",
      "files named like report.final.pdf can be downloaded",
    ])
      expect(hasSelectorPattern(good), good).toBe(false);
    const s = spec();
    s.acceptanceCriteria[0]!.when = "I click .coupon-form > button:nth-child(2)";
    expect(gateG1({ spec: s, questions: [] }).findings.some((f) => f.ruleId === "SPC-007")).toBe(
      true,
    );
  });
});

describe("G2 ui contract", () => {
  const input = (c = contract()) => ({
    contract: c,
    spec: spec(),
    mode: "build" as const,
    references: [],
  });

  it("passes a consistent contract once the matrix covers the spec states", () => {
    const c = contract((raw) => {
      raw.stateMatrix = [
        {
          stateId: "ST-initial",
          trigger: "t",
          ui: "u",
          actions: [],
          a11y: "",
          testLevel: ["component"],
        },
        {
          stateId: "ST-success",
          trigger: "t",
          ui: "u",
          actions: [],
          a11y: "",
          testLevel: ["component"],
        },
      ];
      raw.cases = [
        {
          id: "main-desktop-initial",
          surfaceId: "main-page",
          stateId: "ST-initial",
          viewport: [1024, 640],
          theme: "light",
          setup: {},
        },
      ];
      raw.fidelityRules = [];
    });
    expect(report(gateG2(input(c)), "G2").verdict).toBe("PASS");
  });

  it("flags a spec state without a matrix row and unknown element references", () => {
    const c = contract((raw) => {
      raw.interactions = [{ elementId: "ghost", on: "activate", result: "x", keyboard: "Enter" }];
    });
    const outcome = gateG2(input(c));
    expect(status(outcome, "state-matrix")).toBe("FAIL");
    expect(status(outcome, "element-refs")).toBe("FAIL");
  });

  it("blocks a blocking rule that rests on a pending value", () => {
    const c = contract((raw) => {
      (raw.fidelityRules as Array<Record<string, unknown>>)[0]!.severity = "blocking";
      (raw.fidelityRules as Array<Record<string, unknown>>)[0]!.provenance = "pending";
    });
    expect(status(gateG2(input(c)), "provenance")).toBe("BLOCKED");
  });

  it("fails a mask over a critical element", () => {
    const c = contract((raw) => {
      raw.masks = [{ selector: "[data-x]", reason: "clock", elementId: "primary-cta" }];
    });
    expect(status(gateG2(input(c)), "masks")).toBe("FAIL");
  });

  it("blocks missing references and replicate mode without any", () => {
    const withRef = contract((raw) => {
      raw.references = [{ file: "a.png", caseId: "main-desktop-initial" }];
    });
    const outcome = gateG2({ ...input(withRef), references: [{ file: "a.png", exists: false }] });
    expect(status(outcome, "references")).toBe("BLOCKED");
    expect(status(gateG2({ ...input(), mode: "replicate" }), "replicate-references")).toBe(
      "BLOCKED",
    );
    expect(status(gateG2({ ...input(), mode: "build" }), "replicate-references")).toBe("PASS");
  });

  it("reviews CSS locators and fails cases that name unknown surfaces", () => {
    const c = contract((raw) => {
      (raw.elements as Array<Record<string, unknown>>)[0]!.locator = { css: ".cta" };
      (raw.cases as Array<Record<string, unknown>>)[0]!.surfaceId = "nowhere";
    });
    const outcome = gateG2(input(c));
    expect(status(outcome, "locators")).toBe("REVIEW");
    expect(status(outcome, "cases")).toBe("FAIL");
  });

  it("derives the widths before, at and after every breakpoint plus the 320 px reflow", () => {
    expect(derivedViewportWidths([{ maxWidth: 599 }, { minWidth: 1024 }])).toEqual([
      320, 598, 599, 600, 1023, 1024, 1025,
    ]);
    expect(derivedViewportWidths([])).toEqual([320]);
  });
});

describe("G2T tokens", () => {
  const ok = {
    namingProblems: [],
    solver: { status: "ok" as const },
    pairs: [],
    lockedViolations: [],
  };

  it("passes when names, solver, pairs and locked colours are fine", () => {
    expect(report(gateG2T(ok), "G2T").verdict).toBe("PASS");
  });

  it("FAILs on UNSAT, a failing pair, a changed locked colour and bad names", () => {
    expect(
      status(
        gateG2T({ ...ok, solver: { status: "unsat", reason: "locked x violates y" } }),
        "solver",
      ),
    ).toBe("FAIL");
    const pair = { fg: "--a", bg: "--b", theme: "light", ratio: 4.499999, minimum: 4.5 };
    expect(status(gateG2T({ ...ok, pairs: [pair] }), "pairs")).toBe("FAIL");
    expect(status(gateG2T({ ...ok, pairs: [{ ...pair, ratio: 4.5 }] }), "pairs")).toBe("PASS");
    expect(status(gateG2T({ ...ok, lockedViolations: ["--color-brand changed"] }), "locked")).toBe(
      "FAIL",
    );
    expect(status(gateG2T({ ...ok, namingProblems: ["--bluebutton"] }), "naming")).toBe("FAIL");
  });

  it("does not count a skipped solver as evidence", () => {
    const outcome = gateG2T({ ...ok, solver: { status: "skipped", reason: "strategy none" } });
    expect(status(outcome, "solver")).toBe("SKIPPED");
    expect(report(outcome, "G2T").coverage.required).toBe(3);
  });
});

describe("G3 plan", () => {
  const input = (
    p = plan((raw) => {
      raw.risks = [];
      raw.architectureConfig = { x: 1 };
    }),
  ) => ({
    plan: p,
    spec: spec(),
    level: "L2" as const,
    limits: { maxTaskFiles: 8, maxTaskCriteria: 4 },
    patternIds: new Set(["PAT-POLYMORPHIC-AS"]),
    contractFiles: {},
    plannedGraph: { architecturePresent: true, violations: [] as string[] },
    approvedDependencies: new Set<string>(),
  });

  it("passes a mapped, acyclic plan", () => {
    expect(report(gateG3(input()), "G3").verdict).toBe("PASS");
  });

  it("fails when a criterion has no task or a task names an unknown criterion", () => {
    const s = spec();
    s.acceptanceCriteria.push({
      id: "AC-02",
      requirementId: "R-01",
      given: "a",
      when: "b",
      // biome-ignore lint/suspicious/noThenProperty: `then` is a field of the spec envelope.
      then: "c",
      critical: false,
    });
    expect(status(gateG3({ ...input(), spec: s }), "ac-mapping")).toBe("FAIL");
    const p = plan((raw) => {
      (raw.tasks as Array<Record<string, unknown>>)[0]!.acceptanceCriteria = ["AC-77"];
    });
    expect(status(gateG3(input(p)), "ac-refs")).toBe("FAIL");
  });

  it("detects dependency cycles and unknown dependencies", () => {
    const p = plan((raw) => {
      const base = (raw.tasks as Array<Record<string, unknown>>)[0]!;
      raw.tasks = [
        { ...base, id: "T-001", dependsOn: ["T-002"] },
        { ...base, id: "T-002", dependsOn: ["T-001"] },
      ];
    });
    expect(dependencyCycle(p.tasks)).toEqual(["T-001", "T-002", "T-001"]);
    expect(status(gateG3(input(p)), "dependencies-acyclic")).toBe("FAIL");
    expect(dependencyCycle(plan().tasks)).toEqual([]);
    const missing = plan((raw) => {
      (raw.tasks as Array<Record<string, unknown>>)[0]!.dependsOn = ["T-009"];
    });
    expect(status(gateG3(input(missing)), "dependencies-acyclic")).toBe("FAIL");
  });

  it("enforces the task size limits", () => {
    const p = plan((raw) => {
      (raw.tasks as Array<Record<string, unknown>>)[0]!.files = Array.from(
        { length: 9 },
        (_, i) => `src/f${i}.ts`,
      );
    });
    expect(status(gateG3(input(p)), "task-size")).toBe("FAIL");
  });

  it("reports planned-graph violations and skips the check without a configuration", () => {
    expect(
      status(
        gateG3({
          ...input(),
          plannedGraph: { architecturePresent: true, violations: ["src/a.ts imports forbidden"] },
        }),
        "planned-graph",
      ),
    ).toBe("FAIL");
    expect(
      status(
        gateG3({ ...input(), plannedGraph: { architecturePresent: false, violations: [] } }),
        "planned-graph",
      ),
    ).toBe("SKIPPED");
  });

  it("checks catalog patterns, contract files and operation ids", () => {
    const p = plan((raw) => {
      raw.components = [
        {
          name: "A",
          path: "src/a.ts",
          action: "new",
          atomicLevel: "atom",
          role: "util",
          patterns: ["PAT-MADE-UP"],
          props: [],
          imports: [],
        },
      ];
      raw.contracts = [
        { kind: "openapi", file: "api/p.json", operations: ["listProjects", "ghost"] },
      ];
    });
    expect(status(gateG3(input(p)), "patterns")).toBe("FAIL");
    expect(
      status(
        gateG3({ ...input(p), contractFiles: { "api/p.json": { exists: false } } }),
        "contracts",
      ),
    ).toBe("FAIL");
    expect(
      status(
        gateG3({
          ...input(p),
          contractFiles: { "api/p.json": { exists: true, operations: ["listProjects"] } },
        }),
        "contracts",
      ),
    ).toBe("FAIL");
    expect(
      status(
        gateG3({ ...input(p), contractFiles: { "api/p.json": { exists: true } } }),
        "contracts",
      ),
    ).toBe("PASS");
  });

  it("blocks unapproved dependencies until a person approves them", () => {
    const p = plan((raw) => {
      raw.dependencies = [{ name: "zod", version: "4.1.5", reason: "validation" }];
    });
    expect(status(gateG3(input(p)), "new-dependencies")).toBe("BLOCKED");
    expect(
      status(gateG3({ ...input(p), approvedDependencies: new Set(["zod"]) }), "new-dependencies"),
    ).toBe("PASS");
  });

  it("requires a decision record and a security or privacy risk at L3, and an architecture config from L2", () => {
    expect(status(gateG3({ ...input(), level: "L3" }), "high-risk")).toBe("FAIL");
    const rich = plan((raw) => {
      raw.adrs = [{ id: "ADR-001", title: "t", context: "c", decision: "d", consequences: "e" }];
      raw.risks = [{ category: "privacy", text: "r" }];
      raw.architectureConfig = null;
    });
    expect(status(gateG3({ ...input(rich), level: "L3" }), "high-risk")).toBe("PASS");
    expect(
      status(
        gateG3({ ...input(rich), plannedGraph: { architecturePresent: false, violations: [] } }),
        "architecture-config",
      ),
    ).toBe("FAIL");
    expect(
      status(
        gateG3({
          ...input(rich),
          level: "L1",
          plannedGraph: { architecturePresent: false, violations: [] },
        }),
        "architecture-config",
      ),
    ).toBe("SKIPPED");
  });
});

describe("G4 tests", () => {
  const testMap = (
    mutate: (raw: Record<string, unknown>) => void = () => undefined,
  ): TestMapEnvelope => {
    const raw = clone(envelopeExamples["test-map"]) as Record<string, unknown>;
    mutate(raw);
    const result = validateEnvelope("test-map", raw);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.value;
  };
  const input = (map = testMap(), c?: UiContractEnvelope) => ({
    spec: spec(),
    plan: plan(),
    testMap: map,
    ...(c ? { contract: c } : {}),
  });

  it("passes when every criterion has an automated entry", () => {
    expect(report(gateG4(input()), "G4").verdict).toBe("PASS");
  });

  it("fails a criterion without an entry or without any test or justified manual check", () => {
    expect(
      status(
        gateG4(
          input(
            testMap((raw) => {
              raw.entries = [];
            }),
          ),
        ),
        "coverage",
      ),
    ).toBe("FAIL");
    const weak = testMap((raw) => {
      (raw.entries as Array<Record<string, unknown>>)[0]!.tests = [];
    });
    expect(status(gateG4(input(weak)), "coverage")).toBe("FAIL");
    const manual = testMap((raw) => {
      const e = (raw.entries as Array<Record<string, unknown>>)[0]!;
      e.tests = [];
      e.levels = ["manual"];
      e.manual = { procedure: "open it", justification: "needs a screen reader" };
    });
    expect(status(gateG4(input(manual)), "coverage")).toBe("PASS");
  });

  it("requires a visual entry for each state with fidelity rules and an a11y entry for interactions", () => {
    const c = contract();
    const plain = gateG4(input(testMap(), c));
    expect(status(plain, "visual")).toBe("FAIL");
    expect(status(plain, "a11y-entries")).toBe("FAIL");
    const full = testMap((raw) => {
      const e = (raw.entries as Array<Record<string, unknown>>)[0]!;
      e.levels = ["component", "visual", "a11y"];
      e.evidence = "visual case main-desktop-initial";
    });
    const outcome = gateG4(input(full, c));
    expect(status(outcome, "visual")).toBe("PASS");
    expect(status(outcome, "a11y-entries")).toBe("PASS");
  });

  it("reviews an end-to-end entry on a criterion that is not critical", () => {
    const s = spec();
    s.acceptanceCriteria[0]!.critical = false;
    const e2e = testMap((raw) => {
      (raw.entries as Array<Record<string, unknown>>)[0]!.levels = ["e2e"];
    });
    expect(status(gateG4({ ...input(e2e), spec: s }), "e2e-scope")).toBe("REVIEW");
    expect(status(gateG4({ ...input(e2e), spec: spec() }), "e2e-scope")).toBe("PASS");
  });
});

describe("G5 task", () => {
  const task = () => plan().tasks[0]!;
  const input = (t = task(), over = {}) => ({
    task: t,
    sourceRoots: ["src"],
    dependencyStatus: {},
    l0: false,
    limits: { maxTaskFiles: 8, maxTaskCriteria: 4 },
    knownLayers: ["ui", "data", "test"],
    ...over,
  });

  it("passes a complete contract", () => {
    expect(report(gateG5(input()), "G5").verdict).toBe("PASS");
  });

  it("fails an incomplete contract, a file outside the source roots and an unknown layer", () => {
    const t = { ...task(), goal: "", files: ["lib/x.ts"], layer: "mobile" };
    const outcome = gateG5(input(t));
    expect(status(outcome, "contract")).toBe("FAIL");
    expect(status(outcome, "files")).toBe("FAIL");
    expect(status(outcome, "layer")).toBe("FAIL");
  });

  it("accepts listed test files outside the source roots", () => {
    const t = {
      ...task(),
      files: ["e2e/projects.spec.ts"],
      tests: [{ path: "e2e/projects.spec.ts", level: "e2e" as const }],
    };
    expect(status(gateG5(input(t)), "files")).toBe("PASS");
  });

  it("blocks while a dependency is not done and exempts L0 from the file and criteria rules", () => {
    const t = { ...task(), dependsOn: ["T-000"] };
    expect(
      status(gateG5(input(t, { dependencyStatus: { "T-000": "running" } })), "dependencies"),
    ).toBe("BLOCKED");
    expect(
      status(gateG5(input(t, { dependencyStatus: { "T-000": "done" } })), "dependencies"),
    ).toBe("PASS");
    const l0 = { ...task(), files: [], acceptanceCriteria: [], validation: [] };
    expect(report(gateG5(input(l0, { l0: true })), "G5").verdict).toBe("PASS");
  });
});

const pass = (summary = "ok"): Prepared => ({ status: "PASS", summary });
const fail = (summary = "bad"): Prepared => ({
  status: "FAIL",
  summary,
  findings: [
    {
      ruleId: "FS-X-001",
      severity: "major",
      status: "FAIL",
      kind: "deterministic",
      message: summary,
    },
  ],
});

describe("G6 implementation", () => {
  const input = () => ({
    envelope: pass(),
    protectedFiles: pass(),
    scope: pass(),
    rules: pass(),
    architecture: pass(),
    architectureConfigured: true,
    commands: { typecheck: pass(), lint: pass(), tests: pass() },
    testFirst: pass() as Prepared | undefined,
    custom: [] as Array<{ id: string; prepared: Prepared }>,
  });

  it("passes when every check passes", () => {
    expect(report(gateG6(input()), "G6").verdict).toBe("PASS");
  });

  it("is BLOCKED when a required command is missing and FAIL when any check fails", () => {
    const missing = gateG6({ ...input(), commands: { ...input().commands, lint: undefined } });
    expect(status(missing, "command:lint")).toBe("BLOCKED");
    expect(report(missing, "G6").verdict).toBe("BLOCKED");
    expect(report(gateG6({ ...input(), rules: fail() }), "G6").verdict).toBe("FAIL");
    expect(report(gateG6({ ...input(), protectedFiles: fail("FS-GOV-001") }), "G6").verdict).toBe(
      "FAIL",
    );
    const both = gateG6({
      ...input(),
      rules: fail(),
      commands: { ...input().commands, lint: undefined },
    });
    expect(report(both, "G6").verdict).toBe("FAIL");
  });

  it("skips architecture without a configuration and test-first for exempt tasks", () => {
    const outcome = gateG6({
      ...input(),
      architecture: undefined,
      architectureConfigured: false,
      testFirst: undefined,
    });
    expect(status(outcome, "architecture")).toBe("SKIPPED");
    expect(status(outcome, "test-first")).toBe("SKIPPED");
    expect(report(outcome, "G6").verdict).toBe("PASS");
  });

  it("blocks when architecture is configured but did not run, and includes custom gates", () => {
    expect(status(gateG6({ ...input(), architecture: undefined }), "architecture")).toBe("BLOCKED");
    expect(
      status(
        gateG6({ ...input(), custom: [{ id: "storybook", prepared: fail() }] }),
        "custom:storybook",
      ),
    ).toBe("FAIL");
  });
});

describe("G7 validation", () => {
  const input = (level: "L1" | "L2" | "L3" = "L2") => ({
    level,
    rules: pass() as Prepared | undefined,
    architecture: pass() as Prepared | undefined,
    architectureConfigured: true,
    commands: {
      test: pass() as Prepared | undefined,
      build: pass() as Prepared | undefined,
      e2e: undefined as Prepared | undefined,
    },
    e2eInTestMap: false,
    fidelityRequired: false,
    fidelity: undefined as Prepared | undefined,
    a11yRequired: false,
    a11y: undefined as Prepared | undefined,
    budgets: undefined as Prepared | undefined,
    audit: undefined as Prepared | undefined,
    custom: [] as Array<{ id: string; prepared: Prepared }>,
  });

  it("passes at L2 without fidelity, e2e or budgets and is BLOCKED without a build command", () => {
    expect(report(gateG7(input()), "G7").verdict).toBe("PASS");
    expect(
      status(
        gateG7({ ...input(), commands: { ...input().commands, build: undefined } }),
        "command:build",
      ),
    ).toBe("BLOCKED");
    expect(
      status(
        gateG7({ ...input("L1"), commands: { ...input().commands, build: undefined } }),
        "command:build",
      ),
    ).toBe("SKIPPED");
  });

  it("requires e2e at L3 or when the test map has e2e entries", () => {
    expect(status(gateG7(input("L3")), "command:e2e")).toBe("BLOCKED");
    expect(status(gateG7({ ...input(), e2eInTestMap: true }), "command:e2e")).toBe("BLOCKED");
    expect(
      status(
        gateG7({ ...input(), e2eInTestMap: true, commands: { ...input().commands, e2e: pass() } }),
        "command:e2e",
      ),
    ).toBe("PASS");
  });

  it("blocks when a required fidelity or a11y run is missing, and mandates a11y at L3", () => {
    expect(status(gateG7({ ...input(), fidelityRequired: true }), "fidelity")).toBe("BLOCKED");
    expect(
      status(
        gateG7({ ...input("L3"), commands: { ...input().commands, e2e: pass() } }),
        "a11y-runtime",
      ),
    ).toBe("BLOCKED");
    expect(status(gateG7({ ...input(), a11yRequired: true, a11y: pass() }), "a11y-runtime")).toBe(
      "PASS",
    );
  });

  it("FAILs on a failing fidelity run, a failing audit and a failing custom gate", () => {
    expect(
      report(gateG7({ ...input(), fidelityRequired: true, fidelity: fail() }), "G7").verdict,
    ).toBe("FAIL");
    expect(report(gateG7({ ...input(), audit: fail() }), "G7").verdict).toBe("FAIL");
    expect(
      report(gateG7({ ...input(), custom: [{ id: "x", prepared: fail() }] }), "G7").verdict,
    ).toBe("FAIL");
  });
});

describe("G8 review", () => {
  const review = (severity: string) => {
    const raw = clone(envelopeExamples.review) as {
      findings: Array<Record<string, unknown>>;
      verdict: string;
    };
    raw.findings[0]!.severity = severity;
    raw.verdict = severity === "BLOCKER" || severity === "MAJOR" ? "changes-requested" : "approved";
    const result = validateEnvelope("review", raw);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.value;
  };

  it("passes with only minor findings (as review items) and FAILs on a major or blocker", () => {
    const minor = gateG8({ level: "L2", reviews: [review("MINOR")] });
    expect(status(minor, "findings")).toBe("REVIEW");
    expect(report(minor, "G8").verdict).toBe("REVIEW");
    expect(report(gateG8({ level: "L2", reviews: [review("MAJOR")] }), "G8").verdict).toBe("FAIL");
    expect(report(gateG8({ level: "L2", reviews: [review("BLOCKER")] }), "G8").verdict).toBe(
      "FAIL",
    );
    expect(report(gateG8({ level: "L2", reviews: [review("NIT")] }), "G8").verdict).toBe("PASS");
  });

  it("needs two independent runs at L3 and one elsewhere", () => {
    expect(status(gateG8({ level: "L3", reviews: [review("NIT")] }), "runs")).toBe("BLOCKED");
    expect(status(gateG8({ level: "L3", reviews: [review("NIT"), review("NIT")] }), "runs")).toBe(
      "PASS",
    );
    expect(status(gateG8({ level: "L2", reviews: [] }), "runs")).toBe("BLOCKED");
  });
});

describe("traceability and G9", () => {
  const testMap = validateEnvelope("test-map", envelopeExamples["test-map"]);
  const trace = (over: Partial<Parameters<typeof buildTrace>[0]> = {}) =>
    buildTrace({
      spec: spec(),
      plan: plan(),
      testMap: testMap.ok ? testMap.value : undefined,
      manual: {},
      passedTasks: new Set(["T-001"]),
      validation: "PASS",
      ...over,
    });

  it("traces a requirement to its criterion, tasks, tests and evidence", () => {
    expect(trace()).toEqual([
      expect.objectContaining({
        requirementId: "R-01",
        acId: "AC-01",
        tasks: ["T-001"],
        tests: ["src/example.test.ts"],
        status: "PASS",
      }),
    ]);
  });

  it("marks a criterion MISSING when a task is not done or validation has not passed, and MANUAL with a recorded verification", () => {
    expect(trace({ passedTasks: new Set() })[0]?.status).toBe("MISSING");
    expect(trace({ validation: "FAIL" })[0]?.status).toBe("MISSING");
    expect(trace({ validation: undefined })[0]?.status).toBe("MISSING");
    expect(
      trace({
        passedTasks: new Set(),
        manual: { "AC-01": { at: "2026-10-06", evidence: "checked by hand" } },
      })[0],
    ).toMatchObject({ status: "MANUAL", evidence: "checked by hand" });
    expect(trace({ plan: undefined })[0]?.note).toContain("no task");
  });

  it("G9 fails a missing trace, blocks on blocked checks, fails expired waivers and lists deviations as review", () => {
    const base = { trace: trace(), blockedChecks: [], expiredWaivers: [], deviations: [] };
    expect(report(gateG9(base), "G9").verdict).toBe("PASS");
    expect(
      report(gateG9({ ...base, trace: trace({ passedTasks: new Set() }) }), "G9").verdict,
    ).toBe("FAIL");
    expect(report(gateG9({ ...base, blockedChecks: ["G7 command:build"] }), "G9").verdict).toBe(
      "BLOCKED",
    );
    expect(report(gateG9({ ...base, expiredWaivers: ["W-1"] }), "G9").verdict).toBe("FAIL");
    expect(report(gateG9({ ...base, deviations: ["used a different icon"] }), "G9").verdict).toBe(
      "REVIEW",
    );
    const manual = trace({
      passedTasks: new Set(),
      manual: { "AC-01": { at: "x", evidence: "y" } },
    });
    expect(report(gateG9({ ...base, trace: manual }), "G9").verdict).toBe("PASS");
  });
});
