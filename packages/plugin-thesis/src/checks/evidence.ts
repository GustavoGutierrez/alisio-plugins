import { flattenOutline, parseOutline } from "../outline.js";
import { generateBibtex } from "../research/bibtex.js";
import { citableForSection, parseLibraryText } from "../research/library.js";
import {
  classifyHost,
  officialDomainsFromProfile,
  primaryTypes,
  similarityThreshold,
} from "../research/verify.js";
import {
  citableStatuses,
  type EvidenceRecord,
  type Finding,
  type SectionStatus,
} from "../types.js";
import type { LoadedProject } from "./project.js";

const libraryFile = "evidence/library.jsonl";
const bibliographyFile = "bibliography/references.bib";

const finding = (
  code: string,
  gate: Finding["gate"],
  severity: Finding["severity"],
  file: string,
  message: string,
  extra: Partial<Finding> = {},
): Finding => ({ code, gate, severity, file, message, ...extra });

/** Why a citable status is not justified by the record's own verification data (spec 8.4). */
function statusProblem(
  record: EvidenceRecord,
  domains: ReturnType<typeof officialDomainsFromProfile>,
): string | undefined {
  const { method, metadataMatch } = record.verification;
  const viaApi = method === "crossref" || method === "openalex";
  switch (record.status) {
    case "VERIFIED_PEER_REVIEWED":
      if (!viaApi) return "peer-reviewed status needs Crossref or OpenAlex verification";
      if (record.type !== "journal_article" && record.type !== "conference_paper")
        return `peer-reviewed status needs a journal article or conference paper, not ${record.type}`;
      if (metadataMatch < similarityThreshold)
        return `metadata match ${metadataMatch} is below ${similarityThreshold}`;
      return undefined;
    case "VERIFIED_AUTHORITATIVE_GREY":
      if (!viaApi) return "authoritative grey status needs Crossref or OpenAlex verification";
      if (metadataMatch < similarityThreshold)
        return `metadata match ${metadataMatch} is below ${similarityThreshold}`;
      return undefined;
    case "VERIFIED_PRIMARY":
      if (!primaryTypes.includes(record.type))
        return `primary status needs a law, standard, report or dataset, not ${record.type}`;
      if (classifyHost(record.url, record.type, domains).tier !== "primary")
        return "primary status needs a URL on an official domain of the policy";
      return undefined;
    default:
      return undefined;
  }
}

const evidenceStarted: readonly SectionStatus[] = [
  "research_approved",
  "drafting",
  "draft_review",
  "approved",
  "revising",
];

/** G2: the evidence library (EVD-*). */
export function checkEvidence(project: LoadedProject): Finding[] {
  if (project.libraryText === undefined) return [];
  const findings: Finding[] = [];
  const { records, errors } = parseLibraryText(project.libraryText);
  for (const error of errors) {
    findings.push(
      finding("EVD-001", "G2", "error", libraryFile, error.message, { line: error.line }),
    );
  }
  const domains = officialDomainsFromProfile(project.profile);
  const ids = new Map<string, number>();
  const keys = new Map<string, number>();
  const dois = new Map<string, string>();
  for (const record of records) {
    ids.set(record.id, (ids.get(record.id) ?? 0) + 1);
    keys.set(record.citeKey, (keys.get(record.citeKey) ?? 0) + 1);
    if (record.doi) {
      const doi = record.doi.toLowerCase();
      const first = dois.get(doi);
      if (first)
        findings.push(
          finding(
            "EVD-002",
            "G2",
            "error",
            libraryFile,
            `DOI ${doi} appears in both ${first} and ${record.id}`,
            { hint: "Duplicates merge into the oldest evidence id; re-run /thesis:research." },
          ),
        );
      else dois.set(doi, record.id);
    }
    if (citableStatuses.includes(record.status)) {
      const problem = statusProblem(record, domains);
      if (problem)
        findings.push(
          finding(
            "EVD-003",
            "G2",
            "error",
            libraryFile,
            `${record.id} is ${record.status} but ${problem}`,
            { hint: "Citable statuses come only from code verification (spec 8.4)." },
          ),
        );
      if (record.verification.retracted)
        findings.push(
          finding(
            "EVD-004",
            "G2",
            "error",
            libraryFile,
            `${record.id} is marked retracted but still has the citable status ${record.status}`,
          ),
        );
    }
  }
  for (const [id, count] of ids)
    if (count > 1)
      findings.push(
        finding("EVD-001", "G2", "error", libraryFile, `Evidence id ${id} appears ${count} times`),
      );
  for (const [key, count] of keys)
    if (count > 1)
      findings.push(
        finding(
          "EVD-001",
          "G2",
          "error",
          libraryFile,
          `Citation key ${key} appears ${count} times`,
        ),
      );

  // Contextual approvals must point at real records.
  for (const [sectionId, section] of Object.entries(project.sections ?? {})) {
    for (const id of section.contextualApprovals ?? []) {
      if (!ids.has(id))
        findings.push(
          finding(
            "EVD-005",
            "G2",
            "error",
            libraryFile,
            `${sectionId} approves unknown evidence ${id} for contextual use`,
          ),
        );
    }
  }

  // EVD-010: evidence minimums (warning). The policy sources give a minimum for the theoretical
  // framework as a whole, so it applies to the section(s) marked as that framework.
  const profile = project.profile;
  if (profile && project.outlineText !== undefined && project.sections) {
    const outline = parseOutline(project.outlineText).outline;
    const frameworks = outline
      ? flattenOutline(outline.sections).filter(
          (node) => node.requiredKey === "marco_teorico" || node.requiredKey === "estado_del_arte",
        )
      : [];
    for (const rule of profile.rules.filter((entry) => entry.kind === "evidence_minimum")) {
      const minimum = rule.values.minCitable;
      if (rule.values.scope !== "theoretical_framework" || typeof minimum !== "number") continue;
      for (const node of frameworks) {
        const section = project.sections[node.id];
        if (!section || !evidenceStarted.includes(section.status)) continue;
        const citable = records.filter(
          (record) =>
            record.sections.includes(node.id) &&
            citableForSection(record, section.contextualApprovals),
        ).length;
        if (citable < minimum) {
          findings.push(
            finding(
              "EVD-010",
              "G2",
              rule.values.severity === "error" ? "error" : "warning",
              libraryFile,
              `${node.id} has ${citable} citable record(s); ${rule.ruleId} suggests at least ${minimum} for this work type`,
              {
                hint: "A suggestion from the policy, not a standard; search more or override the rule with an institutional one.",
              },
            ),
          );
        }
      }
    }
  }
  return findings;
}

/** G5 (partial): references.bib is byte-identical to a fresh generation (CIT-004). */
export function checkBibliography(project: LoadedProject): Finding[] {
  if (project.libraryText === undefined && project.bibliographyText === undefined) return [];
  const { records, errors } = parseLibraryText(project.libraryText);
  if (errors.length > 0) return [];
  if (project.bibliographyText === generateBibtex(records)) return [];
  return [
    finding(
      "CIT-004",
      "G5",
      "error",
      bibliographyFile,
      "references.bib differs from a fresh generation of the evidence library",
      {
        hint: "references.bib is generated and never hand-edited; delete it and run /thesis:research for any section to rebuild it.",
      },
    ),
  ];
}
