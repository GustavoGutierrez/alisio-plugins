import { allBlockLists, allSections, walkInlines } from "../render/walk.js";
import { citableForSection, parseLibraryText } from "../research/library.js";
import type { EvidenceRecord, Finding } from "../types.js";
import { documentOf } from "./document.js";
import type { LoadedProject } from "./project.js";

/** G5 citation checks over the document model (spec 9.2): CIT-001, CIT-002 and CIT-003. */

interface Cited {
  key: string;
  file: string | undefined;
  line: number | undefined;
  section: string | undefined;
}

/** Every citation of the document with the section its file declares. */
export function citationsOf(project: LoadedProject): Cited[] {
  const assembled = documentOf(project);
  if (!assembled) return [];
  const doc = assembled.document;
  const sectionOfFile = new Map(allSections(doc).map((section) => [section.path, section.section]));
  const cited: Cited[] = [];
  for (const { file, blocks } of allBlockLists(doc)) {
    walkInlines(blocks, (inline, owner) => {
      if (inline.kind !== "citation") return;
      for (const item of inline.items)
        cited.push({
          key: item.key,
          file,
          line: owner.line,
          section: file === undefined ? undefined : sectionOfFile.get(file),
        });
    });
  }
  return cited;
}

const at = (cite: Cited): Pick<Finding, "file" | "line" | "section"> => ({
  ...(cite.file === undefined ? {} : { file: cite.file }),
  ...(cite.line === undefined ? {} : { line: cite.line }),
  ...(cite.section === undefined ? {} : { section: cite.section }),
});

export function checkCitations(project: LoadedProject): Finding[] {
  const assembled = documentOf(project);
  if (!assembled) return [];
  const { records } = parseLibraryText(project.libraryText);
  const byKey = new Map<string, EvidenceRecord>(records.map((record) => [record.citeKey, record]));
  const findings: Finding[] = [];
  const cited = citationsOf(project);
  const usedKeys = new Set<string>();
  for (const cite of cited) {
    usedKeys.add(cite.key);
    const record = byKey.get(cite.key);
    if (!record) {
      findings.push({
        code: "CIT-001",
        gate: "G5",
        severity: "error",
        ...at(cite),
        message: `Citation @${cite.key} is not in the evidence library`,
        hint: "Cite only keys of evidence/library.jsonl; research the source with /thesis:research first.",
      });
      continue;
    }
    const approvals = cite.section
      ? (project.sections?.[cite.section]?.contextualApprovals ?? [])
      : [];
    if (!citableForSection(record, approvals)) {
      findings.push({
        code: "CIT-002",
        gate: "G5",
        severity: "error",
        ...at(cite),
        message: `@${cite.key} (${record.id}) is ${record.status}, which is not citable${cite.section ? ` in ${cite.section}` : ""}`,
        hint: "Only verified records are citable; approve a CONTEXTUAL_ONLY source for this section with /thesis:approve SEC -- contextual EVD-xxxxx.",
      });
    }
  }
  // CIT-003 applies from the review phase on: until then a library naturally holds unused sources.
  const phase = project.state?.phase;
  if (phase === "review" || phase === "final" || phase === "submitted") {
    for (const record of records) {
      if (record.status === "REJECTED" || usedKeys.has(record.citeKey)) continue;
      findings.push({
        code: "CIT-003",
        gate: "G5",
        severity: "warning",
        file: "evidence/library.jsonl",
        message: `${record.id} @${record.citeKey} is in the library but never cited`,
        hint: "Cite it where it supports a claim, or remove it from the library before the final bibliography.",
      });
    }
  }
  return findings;
}
