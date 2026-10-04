import { parseProtocol } from "../protocol.js";
import { fold } from "../research/verify.js";
import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

const file = "research/protocol.md";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const filled = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

const error = (message: string, hint?: string): Finding => ({
  code: "DSN-001",
  gate: "G1",
  severity: "error",
  file,
  message,
  ...(hint ? { hint } : {}),
});

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => fold(entry).trim())
    : [];
}

/** G1: the protocol is complete (DSN-001) and its objective verbs are verifiable (DSN-002). */
export function checkDesign(project: LoadedProject): Finding[] {
  if (project.protocolText === undefined) return [];
  const parsed = parseProtocol(project.protocolText);
  if (!parsed.data) return [error(parsed.error ?? "protocol.md cannot be read")];
  const data = parsed.data;
  const findings: Finding[] = [];
  const hint = "Run /thesis:design again, or fix the front matter of research/protocol.md.";

  if (!filled(data.problem)) findings.push(error("The protocol has no problem statement", hint));
  if (!Array.isArray(data.researchQuestions) || !data.researchQuestions.some(filled)) {
    findings.push(error("The protocol has no research question", hint));
  }
  const general = data.generalObjective;
  if (!isObject(general) || !filled(general.text)) {
    findings.push(error("The protocol has no general objective", hint));
  }
  const objectives = Array.isArray(data.specificObjectives) ? data.specificObjectives : [];
  if (objectives.length < 2 || objectives.length > 6) {
    findings.push(
      error(`The protocol must have 2 to 6 specific objectives (found ${objectives.length})`, hint),
    );
  }
  objectives.forEach((objective, index) => {
    if (
      !isObject(objective) ||
      !filled(objective.id) ||
      !filled(objective.verb) ||
      !filled(objective.object) ||
      !filled(objective.deliverable)
    ) {
      findings.push(
        error(
          `Specific objective ${index + 1} needs an id, a verb, an object and a deliverable`,
          hint,
        ),
      );
    }
  });
  const justification = data.justification;
  if (
    !isObject(justification) ||
    !["relevance", "novelty", "feasibility", "beneficiaries"].every((key) =>
      filled(justification[key]),
    )
  ) {
    findings.push(
      error("The justification must state relevance, novelty, feasibility and beneficiaries", hint),
    );
  }
  const methodology = data.methodology;
  if (!isObject(methodology) || !filled(methodology.design) || !filled(methodology.analysisPlan)) {
    findings.push(error("The methodology needs at least a design and an analysis plan", hint));
  }

  // DSN-002: verbs against the approved list of the thesis language (warning, never blocking).
  const profile = project.profile;
  const rule = profile?.rules.find((entry) => entry.kind === "objective_verbs");
  if (profile && !rule) {
    findings.push({
      code: "DSN-002",
      gate: "G1",
      severity: "info",
      file,
      message: `No approved objective-verb list exists for language ${profile.inputs.language}; verbs were not checked`,
    });
  } else if (profile && rule) {
    const recommended = new Set(
      Object.values(
        isObject(rule.values.recommendedByLevel) ? rule.values.recommendedByLevel : {},
      ).flatMap(strings),
    );
    const unverifiable = new Set([
      ...strings(rule.values.avoid),
      ...strings(rule.values.ambiguous),
    ]);
    const downgrade = isObject(rule.values.qualitativeDowngrade)
      ? rule.values.qualitativeDowngrade
      : undefined;
    const downgraded = new Set(strings(downgrade?.verbs));
    const qualitative = profile.inputs.approach === "qualitative";
    for (const objective of objectives) {
      if (!isObject(objective) || !filled(objective.verb)) continue;
      const verb = fold(String(objective.verb)).trim();
      const id = filled(objective.id) ? String(objective.id) : "objective";
      if (recommended.has(verb) && !unverifiable.has(verb)) continue;
      const soft = qualitative && downgraded.has(verb);
      findings.push({
        code: "DSN-002",
        gate: "G1",
        severity: soft ? "info" : "warning",
        file,
        message: unverifiable.has(verb)
          ? `${id}: the verb "${String(objective.verb)}" is not verifiable; use a measurable action verb`
          : `${id}: the verb "${String(objective.verb)}" is not in the approved list for ${profile.inputs.language}`,
        hint: `Approved verbs come from ${rule.ruleId}; see /thesis:pack explain ${rule.ruleId}.`,
      });
    }
  }
  return findings;
}
