import { ethicsQuestions } from "../policy/ethics.js";
import { parseProtocol } from "../protocol.js";
import { allSections } from "../render/walk.js";
import type { Finding, ReviewFinding } from "../types.js";
import { documentOf } from "./document.js";
import type { LoadedProject } from "./project.js";

/**
 * The closing checks: ETH-001 and POL-AI-001 (G6), REV-001 (G9) and FIN-001 (G10). Several of them
 * only become errors once every section is approved (phase review or later): until then the thesis
 * is unfinished by definition and the checks say what is still open as warnings.
 */

const lateStates = new Set(["review", "final", "submitted"]);
const isLate = (project: LoadedProject): boolean =>
  project.state !== undefined && lateStates.has(project.state.phase);

const protocolFile = "research/protocol.md";

/** ETH-001: the questionnaire is answered and every triggered requirement has a resolution. */
export function checkEthics(project: LoadedProject): Finding[] {
  if (project.protocolText === undefined) return [];
  const data = parseProtocol(project.protocolText).data;
  if (!data) return [];
  const findings: Finding[] = [];
  const answers =
    typeof data.ethics === "object" && data.ethics !== null && !Array.isArray(data.ethics)
      ? (data.ethics as Record<string, unknown>)
      : {};
  const missing = ethicsQuestions.filter((question) => typeof answers[question.id] !== "boolean");
  if (missing.length > 0)
    findings.push({
      code: "ETH-001",
      gate: "G6",
      severity: "error",
      file: protocolFile,
      message: `The ethics questionnaire is incomplete: ${missing.map((question) => question.id).join(", ")} unanswered`,
      hint: "Run /thesis:revise A -- <feedback> so the methodologist answers all 11 questions.",
    });
  const requirements = Array.isArray(data.ethicsRequirements) ? data.ethicsRequirements : [];
  const resolutions = project.state?.ethicsResolutions ?? {};
  // Without a workspace state there is nothing to resolve against; the CLI check on a bare folder
  // therefore only validates the questionnaire.
  if (!project.state) return findings;
  const severity = isLate(project) ? "error" : "warning";
  for (const entry of requirements) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || resolutions[id]?.text) continue;
    const text = String((entry as Record<string, unknown>).text ?? "").slice(0, 120);
    findings.push({
      code: "ETH-001",
      gate: "G6",
      severity,
      file: protocolFile,
      message: `Ethics requirement ${id} has no recorded resolution: ${text}`,
      hint: `Record how it was met: /thesis:approve ${id} -- <resolution, for example the committee approval number and the annex that holds it>.`,
    });
  }
  return findings;
}

/** POL-AI-001: the AI-use declaration exists when the resolved policy requires one. */
export function checkAiDeclaration(project: LoadedProject): Finding[] {
  if (!project.profile?.aiDeclaration.required || !project.state) return [];
  const assembled = documentOf(project);
  if (!assembled) return [];
  const present = allSections(assembled.document).some(
    (section) => section.role === "ai-declaration" && section.blocks.length > 0,
  );
  if (present) return [];
  // While sections are still being written the declaration is just one more section to draft.
  return [
    {
      code: "POL-AI-001",
      gate: "G6",
      severity: isLate(project) ? "error" : "warning",
      message:
        "The resolved policy requires an AI-use declaration, but no chapter has the ai-declaration role",
      hint: "Draft the ai_declaration section of the outline (/thesis:draft), or add a chapter file with `role: ai-declaration`.",
    },
  ];
}

export function parseReviewFinding(text: string): ReviewFinding | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as ReviewFinding).id === "string" &&
      typeof (value as ReviewFinding).status === "string" &&
      typeof (value as ReviewFinding).severity === "string"
    )
      return value as ReviewFinding;
  } catch {
    // reported by the caller
  }
  return undefined;
}

/** REV-001: no open critical or major finding. */
export function checkReviews(project: LoadedProject): Finding[] {
  const findings: Finding[] = [];
  for (const file of project.reviewFiles) {
    const parsed = parseReviewFinding(file.content);
    if (!parsed) {
      findings.push({
        code: "REV-001",
        gate: "G9",
        severity: "error",
        file: file.path,
        message: "The finding file is not a valid review finding",
      });
      continue;
    }
    if (parsed.status === "open" && (parsed.severity === "critical" || parsed.severity === "major"))
      findings.push({
        code: "REV-001",
        gate: "G9",
        severity: "error",
        file: file.path,
        section: parsed.target,
        message: `${parsed.id} is an open ${parsed.severity} finding in ${parsed.target} (${parsed.category}): ${parsed.description.slice(0, 160)}`,
        hint: `Fix it with /thesis:revise ${parsed.id}, or dismiss it with a reason: /thesis:approve ${parsed.id} -- <reason>.`,
      });
  }
  return findings;
}

export interface FinalProblems {
  /** What must hold before the final steps can start. */
  blocking: string[];
  /** The final steps themselves, done by /thesis:finalize. */
  pending: string[];
}

/** FIN-001's conditions: all human gates, all sections, the PDF/A build (spec 9.2). */
export function finalProblems(project: LoadedProject): FinalProblems {
  const out: FinalProblems = { blocking: [], pending: [] };
  const state = project.state;
  if (!state) return out;
  for (const name of ["A", "B", "OUTLINE"] as const)
    if (state.humanGates[name].status !== "approved")
      out.blocking.push(`Human Gate ${name} is not approved`);
  const unapproved = Object.entries(state.sections)
    .filter(([, section]) => section.status !== "approved")
    .map(([id]) => id);
  if (unapproved.length > 0)
    out.blocking.push(
      `${unapproved.length} section(s) are not approved: ${unapproved.slice(0, 6).join(", ")}${unapproved.length > 6 ? ", ..." : ""}`,
    );
  if (state.humanGates.C.status !== "approved") out.pending.push("Human Gate C is not approved");
  if (!state.finalBuild) out.pending.push("The PDF/A build has not succeeded");
  return out;
}

/** FIN-001 (G10). Before every section is approved it only reports progress. */
export function checkFinal(project: LoadedProject): Finding[] {
  const state = project.state;
  if (!state || Object.keys(state.sections).length === 0) return [];
  const problems = finalProblems(project);
  if (!isLate(project)) {
    const approved = Object.values(state.sections).filter((s) => s.status === "approved").length;
    return [
      {
        code: "FIN-001",
        gate: "G10",
        severity: "info",
        message: `Not final yet: ${approved} of ${Object.keys(state.sections).length} sections are approved`,
      },
    ];
  }
  return [...problems.blocking, ...problems.pending].map((message) => ({
    code: "FIN-001",
    gate: "G10" as const,
    severity: "error" as const,
    message,
    hint: "Run /thesis:finalize.",
  }));
}
