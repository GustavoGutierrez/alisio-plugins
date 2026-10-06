import type { SpecEnvelope } from "../envelopes/spec.js";
import type { UiContractEnvelope } from "../envelopes/ui-contract.js";
import type { Mode } from "../state/feature-state.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface ReferenceStatus {
  file: string;
  exists: boolean;
  sha256?: string;
}

export interface G2Input {
  contract: UiContractEnvelope;
  spec: SpecEnvelope;
  mode: Mode;
  references: readonly ReferenceStatus[];
}

/** Widths the pipeline measures around each breakpoint: one below, at and one above, plus 320 (spec 7.2 G2). */
export function derivedViewportWidths(
  breakpoints: ReadonlyArray<{ maxWidth?: number; minWidth?: number }>,
): number[] {
  const widths = new Set<number>([320]);
  for (const breakpoint of breakpoints) {
    const edge = breakpoint.maxWidth ?? breakpoint.minWidth;
    if (edge === undefined) continue;
    for (const width of [edge - 1, edge, edge + 1]) if (width >= 1) widths.add(width);
  }
  return [...widths].sort((a, b) => a - b);
}

/** G2 UI (spec 7.2): the contract is complete, consistent and anchored in existing references. */
export function gateG2(input: G2Input): GateOutcome {
  const { contract, spec } = input;
  const b = new GateBuilder();
  b.add("schema", "PASS", "contract envelope valid");

  const matrixStates = new Set(contract.stateMatrix.map((row) => row.stateId));
  b.problems(
    "state-matrix",
    "UIC-001",
    spec.states
      .filter((s) => !matrixStates.has(s.id))
      .map((s) => `${s.id} has no row in the state matrix`),
    "every spec state has a matrix row",
    { fix: "Add a state matrix row with its trigger, UI and test level." },
  );

  const elementIds = new Set(contract.elements.map((e) => e.id));
  const refs: string[] = [];
  const need = (where: string, id: string): void => {
    if (!elementIds.has(id)) refs.push(`${where} refers to unknown element ${id}`);
  };
  for (const rule of contract.fidelityRules) {
    need(`rule ${rule.id} subject`, rule.subject);
    if (rule.object !== undefined) need(`rule ${rule.id} object`, rule.object);
  }
  for (const region of contract.regions) need(`region ${region.id}`, region.elementId);
  for (const interaction of contract.interactions) need("an interaction", interaction.elementId);
  for (const id of contract.focusOrder) need("the focus order", id);
  for (const typography of contract.typography) need("typography", typography.elementId);
  b.problems("element-refs", "UIC-002", refs, "every reference names a declared element");

  const pending = contract.fidelityRules.filter(
    (rule) => rule.severity === "blocking" && rule.provenance === "pending",
  );
  if (pending.length === 0)
    b.add("provenance", "PASS", "no blocking rule rests on a pending value");
  else {
    b.add(
      "provenance",
      "BLOCKED",
      `${pending.length} blocking rule${pending.length === 1 ? "" : "s"} still pending`,
    );
    for (const rule of pending)
      b.finding(
        "provenance",
        "UIC-003",
        "blocker",
        "BLOCKED",
        `${rule.id} blocks acceptance but its value is pending.`,
        {
          fix: "Obtain the value (design file, measurement or decision) or lower the rule's severity.",
        },
      );
  }

  const critical = new Set(contract.elements.filter((e) => e.critical).map((e) => e.id));
  b.problems(
    "masks",
    "UIC-004",
    contract.masks
      .filter((mask) => mask.elementId !== null && critical.has(mask.elementId))
      .map((mask) => `the mask over ${mask.elementId} hides a critical element`),
    "no mask covers a critical element",
    { severity: "blocker", fix: "Remove the mask or stabilise the content instead of hiding it." },
  );

  const caseIds = new Set(contract.cases.map((c) => c.id));
  const surfaceIds = new Set(contract.surfaces.map((s) => s.id));
  const caseProblems: string[] = [];
  for (const c of contract.cases) {
    if (!surfaceIds.has(c.surfaceId))
      caseProblems.push(`case ${c.id} names unknown surface ${c.surfaceId}`);
    if (!matrixStates.has(c.stateId))
      caseProblems.push(`case ${c.id} names state ${c.stateId} without a matrix row`);
  }
  for (const reference of contract.references)
    if (!caseIds.has(reference.caseId))
      caseProblems.push(`reference ${reference.file} names unknown case ${reference.caseId}`);
  b.problems(
    "cases",
    "UIC-008",
    caseProblems,
    "cases name existing surfaces, states and references",
  );

  const missing = input.references.filter((r) => !r.exists);
  if (missing.length === 0)
    b.add(
      "references",
      "PASS",
      input.references.length === 0
        ? "no references declared"
        : `${input.references.length} references present and hashed`,
    );
  else {
    b.add(
      "references",
      "BLOCKED",
      `${missing.length} reference file${missing.length === 1 ? "" : "s"} missing`,
    );
    for (const reference of missing)
      b.finding(
        "references",
        "UIC-005",
        "blocker",
        "BLOCKED",
        `Reference ${reference.file} does not exist under .frontsmith/references.`,
        {
          fix: "Add the file and its meta.json entry, or remove the reference.",
        },
      );
  }

  if (input.mode === "replicate" && contract.references.length === 0) {
    b.add("replicate-references", "BLOCKED", "mode replicate needs at least one reference");
    b.finding(
      "replicate-references",
      "UIC-007",
      "blocker",
      "BLOCKED",
      "Mode replicate has no reference file.",
      {
        fix: "Add reference images under .frontsmith/references/<feature>/ or change the mode.",
      },
    );
  } else b.add("replicate-references", "PASS", "references fit the mode", { required: false });

  const css = contract.elements.filter((e) => e.locator.css !== undefined);
  if (css.length > 0) {
    b.add(
      "locators",
      "REVIEW",
      `${css.length} element${css.length === 1 ? "" : "s"} located by CSS`,
      { required: false },
    );
    for (const element of css)
      b.finding(
        "locators",
        "UIC-012",
        "minor",
        "REVIEW",
        `${element.id} is located by a CSS selector, which breaks with markup changes.`,
        {
          fix: "Prefer a role and accessible name, a label, or a test id.",
          kind: "heuristic",
        },
      );
  } else b.add("locators", "PASS", "no CSS locators", { required: false });

  const widths = derivedViewportWidths(contract.breakpoints);
  b.add("viewports", "PASS", `measured widths: ${widths.join(", ")}`, { required: false });
  return b.outcome;
}
