import { allSections } from "../render/walk.js";
import { type CheckReport, type Finding, type Gate, gates } from "../types.js";
import { checkBrief } from "./brief.js";
import { checkCitations } from "./citations.js";
import { checkClaims, checkObjectivesReached } from "./claims.js";
import { checkAiDeclaration, checkEthics, checkFinal, checkReviews } from "./closing.js";
import { checkDesign } from "./design.js";
import {
  checkBuildReport,
  checkCharts,
  checkDocumentHygiene,
  checkDocumentModel,
  documentOf,
} from "./document.js";
import { checkBibliography, checkEvidence } from "./evidence.js";
import { checkHygiene } from "./hygiene.js";
import { checkLanguage } from "./language.js";
import { checkOutline } from "./outline.js";
import { checkPolicy } from "./policy.js";
import type { LoadedProject } from "./project.js";
import { checkStyles } from "./styles.js";
import { checkWriting } from "./writing.js";

export { type LoadedProject, type LoadProjectOptions, loadProject } from "./project.js";

/** Each check is a pure function over the loaded project. */
export interface CheckDefinition {
  id: string;
  gate: Gate;
  run(project: LoadedProject): Finding[];
}

export const checkRegistry: readonly CheckDefinition[] = [
  { id: "brief", gate: "G0", run: checkBrief },
  { id: "policy", gate: "G0", run: checkPolicy },
  { id: "styles", gate: "G0", run: checkStyles },
  { id: "design", gate: "G1", run: checkDesign },
  { id: "evidence", gate: "G2", run: checkEvidence },
  { id: "outline", gate: "G4", run: checkOutline },
  { id: "claims", gate: "G3", run: checkClaims },
  { id: "bibliography", gate: "G5", run: checkBibliography },
  { id: "citations", gate: "G5", run: checkCitations },
  { id: "ethics", gate: "G6", run: checkEthics },
  { id: "ai-declaration", gate: "G6", run: checkAiDeclaration },
  { id: "hygiene", gate: "G7", run: checkHygiene },
  { id: "language", gate: "G7", run: checkLanguage },
  { id: "writing", gate: "G7", run: checkWriting },
  { id: "document-hygiene", gate: "G7", run: checkDocumentHygiene },
  { id: "document-model", gate: "G8", run: checkDocumentModel },
  { id: "charts", gate: "G8", run: checkCharts },
  { id: "build-report", gate: "G8", run: checkBuildReport },
  { id: "reviews", gate: "G9", run: checkReviews },
  { id: "objectives", gate: "G10", run: checkObjectivesReached },
  { id: "final", gate: "G10", run: checkFinal },
];

export function parseGates(values: readonly string[]): Gate[] {
  const selected: Gate[] = [];
  for (const value of values) {
    const gate = value.toUpperCase();
    if (!(gates as readonly string[]).includes(gate)) {
      throw new Error(`Unknown gate "${value}". Use one of: ${gates.join(", ")}`);
    }
    if (!selected.includes(gate as Gate)) selected.push(gate as Gate);
  }
  return selected;
}

const severityOrder = { error: 0, warning: 1, info: 2 } as const;
const gateOrder = (gate: Gate) => gates.indexOf(gate);

export interface RunOptions {
  gates?: readonly Gate[];
  now?: () => Date;
  /** Keep only the findings of one section (and the files of it), as `thesis_check` offers. */
  section?: string;
}

export function runChecks(project: LoadedProject, options: RunOptions = {}): CheckReport {
  const selected = options.gates && options.gates.length > 0 ? options.gates : undefined;
  const findings = checkRegistry
    .filter((check) => !selected || selected.includes(check.gate))
    .flatMap((check) => check.run(project))
    .sort(
      (a, b) =>
        gateOrder(a.gate) - gateOrder(b.gate) ||
        severityOrder[a.severity] - severityOrder[b.severity] ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.message.localeCompare(b.message),
    );
  const files = new Set(
    options.section
      ? allSections(
          (documentOf(project)?.document ?? { frontMatter: [], body: [], annexes: [] }) as never,
        )
          .filter((section) => section.section === options.section)
          .map((section) => section.path)
      : [],
  );
  const kept = options.section
    ? findings.filter(
        (finding) =>
          finding.section === options.section ||
          (finding.section === undefined && finding.file !== undefined && files.has(finding.file)),
      )
    : findings;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of kept) counts[finding.severity] += 1;
  return {
    at: (options.now ?? (() => new Date()))().toISOString(),
    ok: counts.error === 0,
    counts,
    findings: kept,
  };
}

/** Plain-text rendering shared by the command, the tool summary and the CLI. */
export function formatReport(report: CheckReport): string {
  const lines = [
    report.ok ? "Checks passed" : "Checks failed",
    `${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} info`,
  ];
  for (const finding of report.findings) {
    const where = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(
      `${finding.severity.toUpperCase()} ${finding.code} [${finding.gate}]${where} ${finding.message}`,
    );
    if (finding.hint) lines.push(`  hint: ${finding.hint}`);
  }
  return lines.join("\n");
}
