import { labelsFor } from "../labels.js";
import type { OutlineNode } from "../outline.js";
import type { Dossier } from "../schemas.js";
import type { EvidenceRecord, SectionId } from "../types.js";
import { citableForSection } from "./library.js";

export interface CoverageSummary {
  queries: number;
  sources: string[];
  failedQueries: number;
  candidates: number;
  verified: number;
  rejected: { reason: string; count: number }[];
  webToolsUsed: boolean;
  focus?: string;
}

const reference = (record: EvidenceRecord): string => {
  const authors = record.authors
    .slice(0, 3)
    .map((author) => (author.given ? `${author.family}, ${author.given}` : author.family))
    .join("; ");
  const more = record.authors.length > 3 ? " et al." : "";
  return `${authors}${more} (${record.year}). ${record.title}.${record.containerTitle ? ` ${record.containerTitle}.` : ""}${record.doi ? ` doi:${record.doi}` : record.url ? ` ${record.url}` : ""}`;
};

export const cell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderDossier(input: {
  section: OutlineNode;
  language: string;
  dossier: Dossier;
  records: readonly EvidenceRecord[];
  contextualApprovals: readonly string[];
  coverage: CoverageSummary;
  now: Date;
}): string {
  const l = labelsFor(input.language);
  const keyOf = new Map(input.records.map((record) => [record.id, record.citeKey]));
  const cites = (ids: readonly string[]) => ids.map((id) => `[@${keyOf.get(id) ?? id}]`).join(" ");
  const lines: string[] = [
    `# ${input.section.id} ${input.section.title}: ${l.dossier}`,
    "",
    `> ${input.now.toISOString().slice(0, 10)}. Statuses come from code verification; only VERIFIED_* records are citable, and CONTEXTUAL_ONLY ones need /thesis:approve ${input.section.id} -- contextual <EVD ids>.`,
    "",
    `## ${l.synthesis}`,
    "",
  ];
  for (const entry of input.dossier.synthesis) {
    lines.push(`### ${entry.topic}`, "", entry.summary, "");
    if (entry.evidence.length) lines.push(`${l.evidence}: ${cites(entry.evidence)}`, "");
  }
  lines.push(`## ${l.claims}`, "");
  if (input.dossier.claims.length === 0) lines.push(`- ${l.none}`);
  for (const claim of input.dossier.claims) {
    lines.push(
      `- (${claim.kind}) ${claim.text}${claim.evidence.length ? ` ${cites(claim.evidence)}` : ""}`,
    );
  }
  lines.push("", `## ${l.gaps}`, "");
  if (input.dossier.gaps.length === 0) lines.push(`- ${l.none}`);
  for (const gap of input.dossier.gaps) {
    lines.push(`- ${gap.critical ? `**${l.critical}** ` : ""}${gap.topic}: ${gap.description}`);
  }
  lines.push(
    "",
    `## ${l.evidence}`,
    "",
    "| Id | Key | Status | Citable | Relevance | Reference |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const record of input.records) {
    const citable = citableForSection(record, input.contextualApprovals);
    lines.push(
      `| ${record.id} | ${record.citeKey} | ${record.status} | ${citable ? l.yes : l.no} | ${record.appraisal.relevance} | ${cell(reference(record))} |`,
    );
  }
  const c = input.coverage;
  lines.push(
    "",
    `## ${l.searchCoverage}`,
    "",
    `- Queries: ${c.queries} (${c.sources.join(", ") || "none"}); failed: ${c.failedQueries}`,
    `- Candidates: ${c.candidates}; verified: ${c.verified}; not accepted: ${c.rejected.map((entry) => `${entry.count} ${entry.reason}`).join(", ") || "0"}`,
    `- Host web tools used: ${c.webToolsUsed ? l.yes : l.no}`,
    ...(c.focus ? [`- Focus of this round: ${c.focus}`] : []),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export const dossierPaths = (id: SectionId) => ({
  markdown: `evidence/dossiers/${id}.md`,
  json: `evidence/dossiers/${id}.json`,
});
