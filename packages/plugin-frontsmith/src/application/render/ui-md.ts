import type { UiContractEnvelope } from "../../domain/envelopes/ui-contract.js";
import { bullets, document, mdTable, section } from "./md.js";

/** `ui.md`: the contract in a form a person can review before approving it. */
export function renderUiMd(contract: UiContractEnvelope, feature: string): string {
  const locator = (l: UiContractEnvelope["elements"][number]["locator"]): string =>
    l.role !== undefined
      ? `role ${l.role}${l.name ? ` "${l.name}"` : ""}`
      : l.testId !== undefined
        ? `test id ${l.testId}`
        : l.label !== undefined
          ? `label "${l.label}"`
          : l.text !== undefined
            ? `text "${l.text}"`
            : `css ${l.css ?? ""}`;
  return document(
    `# UI Contract: ${feature}`,
    `Mode: ${contract.mode}`,
    section(
      "Surfaces",
      mdTable(
        ["ID", "Route", "Purpose"],
        contract.surfaces.map((s) => [s.id, s.route, s.purpose]),
      ),
    ),
    section(
      "State matrix",
      mdTable(
        ["State", "Trigger", "UI", "Actions", "Accessibility", "Test level"],
        contract.stateMatrix.map((r) => [
          r.stateId,
          r.trigger,
          r.ui,
          r.actions.join(", "),
          r.a11y,
          r.testLevel.join(", "),
        ]),
      ),
    ),
    section(
      "Viewports and breakpoints",
      bullets([
        ...contract.viewports.map(([w, h]) => `${w} x ${h} CSS px`),
        ...contract.breakpoints.map(
          (b) =>
            `${b.name}: ${b.maxWidth !== undefined ? `up to ${b.maxWidth} px` : `from ${b.minWidth} px`}`,
        ),
      ]),
    ),
    section(
      "Elements",
      mdTable(
        ["ID", "Locator", "Critical"],
        contract.elements.map((e) => [e.id, locator(e.locator), e.critical ? "yes" : "no"]),
      ),
    ),
    section(
      "Component map",
      mdTable(
        ["Design", "Code", "Reuse"],
        contract.componentMap.map((c) => [c.design, c.code, c.reuse]),
      ),
    ),
    section(
      "Interactions",
      mdTable(
        ["Element", "On", "Result", "Keyboard"],
        contract.interactions.map((i) => [i.elementId, i.on, i.result, i.keyboard]),
      ),
    ),
    section("Focus order", bullets(contract.focusOrder.map((id, i) => `${i + 1}. ${id}`))),
    section(
      "Fidelity rules",
      mdTable(
        ["ID", "Kind", "Subject", "Property", "Expected", "Tolerance", "Severity", "Provenance"],
        contract.fidelityRules.map((r) => [
          r.id,
          r.kind,
          r.object ? `${r.subject} / ${r.object}` : r.subject,
          r.property,
          `${r.expected}${r.unit ? ` ${r.unit}` : ""}`,
          String(r.tolerance),
          r.severity,
          r.provenance,
        ]),
      ),
    ),
    section(
      "Cases",
      mdTable(
        ["ID", "Surface", "State", "Viewport", "Theme"],
        contract.cases.map((c) => [
          c.id,
          c.surfaceId,
          c.stateId,
          `${c.viewport[0]} x ${c.viewport[1]}`,
          c.theme,
        ]),
      ),
    ),
    section("Masks", bullets(contract.masks.map((m) => `${m.selector}: ${m.reason}`))),
    section(
      "Tokens needed",
      mdTable(
        ["Token", "Role", "Status"],
        contract.tokensNeeded.map((t) => [t.name, t.role, t.status]),
      ),
    ),
    section("References", bullets(contract.references.map((r) => `${r.file} (case ${r.caseId})`))),
    section(
      "Open questions",
      bullets(
        contract.questions.map((q) => `${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}`),
      ),
    ),
  );
}
