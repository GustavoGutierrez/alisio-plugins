import { type Assembled, assembleDocument } from "../render/assemble.js";
import { checkChartSpec } from "../render/charts.js";
import { validateLatex } from "../render/math.js";
import type { Block, ThesisDocument } from "../render/model.js";
import { allBlockLists, walkBlocks, walkInlines } from "../render/walk.js";
import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

/** Checks over the renderer-neutral document model (spec 10.0): no output format is involved. */

const cache = new WeakMap<LoadedProject, Assembled | undefined>();

/** The full-scope document of a project, parsed once per loaded project. */
export function documentOf(project: LoadedProject): Assembled | undefined {
  if (!cache.has(project)) {
    cache.set(
      project,
      assembleDocument(project, { scope: "full", sections: project.sections ?? {} }),
    );
  }
  return cache.get(project);
}

const at = (file: string | undefined, block: Block): Pick<Finding, "file" | "line"> => ({
  ...(file === undefined ? {} : { file }),
  ...(block.line === undefined ? {} : { line: block.line }),
});

/** XRF-001, XRF-002 and MTH-001. */
export function modelFindings(doc: ThesisDocument): Finding[] {
  const findings: Finding[] = [];
  const lists = allBlockLists(doc);

  const defined = new Map<string, { file: string | undefined; line: number | undefined }>();
  for (const { file, blocks } of lists) {
    walkBlocks(blocks, (block) => {
      if (!("label" in block) || !block.label) return;
      const previous = defined.get(block.label);
      if (previous) {
        findings.push({
          code: "XRF-001",
          gate: "G8",
          severity: "error",
          ...at(file, block),
          message: `Label ${block.label} is defined more than once (first at ${previous.file ?? "unknown"}${previous.line ? `:${previous.line}` : ""})`,
        });
      } else defined.set(block.label, { file, line: block.line });
    });
  }

  const referenced = new Set<string>();
  for (const { file, blocks } of lists) {
    walkInlines(blocks, (inline, owner) => {
      if (inline.kind === "crossref") {
        referenced.add(inline.label);
        if (!defined.has(inline.label)) {
          findings.push({
            code: "XRF-001",
            gate: "G8",
            severity: "error",
            ...at(file, owner),
            message: `Reference @${inline.label} does not match any label`,
            hint: "Label figures, tables, equations and headings with {#fig-x}, {#tbl-x}, {#eq-x} and {#sec-x}.",
          });
        }
      }
      if (inline.kind === "math") {
        const problem = validateLatex(inline.latex);
        if (problem) {
          findings.push({
            code: "MTH-001",
            gate: "G8",
            severity: "error",
            ...at(file, owner),
            message: problem,
          });
        }
      }
    });
    walkBlocks(blocks, (block) => {
      if (block.kind === "equation") {
        const problem = validateLatex(block.latex);
        if (problem) {
          findings.push({
            code: "MTH-001",
            gate: "G8",
            severity: "error",
            ...at(file, block),
            message: problem,
          });
        }
      }
    });
  }

  // FIG-004: a chart needs a caption and a source line.
  for (const { file, blocks } of lists) {
    walkBlocks(blocks, (block) => {
      if (block.kind !== "figure" || block.asset.kind !== "chart") return;
      if (block.caption.length === 0) {
        findings.push({
          code: "FIG-004",
          gate: "G8",
          severity: "error",
          ...at(file, block),
          message: `Chart ${block.asset.path} has no caption`,
          hint: "Write the caption as the figure's alt text: ![Caption. Source: ...](chart.vl.json).",
        });
      }
      if (!block.source) {
        findings.push({
          code: "FIG-004",
          gate: "G8",
          severity: "error",
          ...at(file, block),
          message: `Chart ${block.asset.path} has no source line`,
          hint: 'End the caption with "Source: ..." (Fuente: / Fonte:), for example "Source: own elaboration."',
        });
      }
    });
  }

  // XRF-003: a heading level may not skip a level (for example # followed by ###).
  let previous = 0;
  for (const section of [...doc.body, ...doc.annexes]) {
    walkBlocks(section.blocks, (block) => {
      if (block.kind !== "heading") return;
      if (block.level > previous + 1) {
        findings.push({
          code: "XRF-003",
          gate: "G8",
          severity: "warning",
          ...at(section.path, block),
          message:
            previous === 0
              ? `The first heading is level ${block.level}; start with a level 1 heading`
              : `Heading level jumps from ${previous} to ${block.level}`,
          hint: "Use consecutive heading levels so the table of contents and numbering stay meaningful.",
        });
      }
      previous = block.level;
    });
  }

  for (const { file, blocks } of lists) {
    walkBlocks(blocks, (block) => {
      if (
        (block.kind === "figure" || block.kind === "table") &&
        block.label &&
        !referenced.has(block.label)
      ) {
        findings.push({
          code: "XRF-002",
          gate: "G8",
          severity: "warning",
          ...at(file, block),
          message: `${block.kind === "figure" ? "Figure" : "Table"} ${block.label} is never referenced in the text`,
          hint: `Mention it with @${block.label}.`,
        });
      }
    });
  }
  return findings;
}

/** G7: HYG-001 from the dialect (raw HTML, raw Typst, placeholders, unknown attributes) and label notes. */
export function checkDocumentHygiene(project: LoadedProject): Finding[] {
  const assembled = documentOf(project);
  return assembled ? assembled.findings.filter((finding) => finding.gate === "G7") : [];
}

/** G8: cross-references and math. */
export function checkDocumentModel(project: LoadedProject): Finding[] {
  const assembled = documentOf(project);
  if (!assembled) return [];
  return modelFindings(assembled.document);
}

/** G8 BLD-001: the last recorded build must have succeeded (nothing is reported before a first build). */
export function checkBuildReport(project: LoadedProject): Finding[] {
  if (project.buildReportText === undefined) return [];
  let report: { ok?: unknown; errors?: unknown; scope?: unknown };
  try {
    report = JSON.parse(project.buildReportText) as typeof report;
  } catch {
    return [
      {
        code: "BLD-001",
        gate: "G8",
        severity: "error",
        file: "build/build-report.json",
        message: "The build report is unreadable; run /thesis:build again",
      },
    ];
  }
  if (report.ok === true) return [];
  return [
    {
      code: "BLD-001",
      gate: "G8",
      severity: "error",
      file: "build/build-report.json",
      message: `The last build (${typeof report.scope === "string" ? report.scope : "unknown scope"}) failed with ${typeof report.errors === "number" ? report.errors : "some"} error(s)`,
      hint: "Run /thesis:build and fix the reported errors.",
    },
  ];
}

/** FIG-001 to FIG-003: every chart spec under figures/ against the supported subset (G8). */
export function checkCharts(project: LoadedProject): Finding[] {
  const dataFiles = new Set(project.dataFiles);
  const findings: Finding[] = [];
  for (const spec of project.chartSpecs) {
    for (const issue of checkChartSpec(spec.content, { dataFiles }).issues) {
      findings.push({
        code: issue.code,
        gate: "G8",
        severity: "error",
        file: spec.path,
        message: issue.message,
        ...(issue.hint ? { hint: issue.hint } : {}),
      });
    }
  }
  return findings;
}
