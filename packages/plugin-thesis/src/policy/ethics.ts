import type { ComplianceProfile } from "./resolver.js";

export const ethicsQuestions = [
  {
    id: "human_participants",
    question: "Will human participants take part (surveys, interviews, observation, experiments)?",
  },
  {
    id: "minors",
    question: "Will children or adolescents (minors) take part, or will their data be used?",
  },
  {
    id: "identifiable_personal_data",
    question: "Will you collect or process identifiable personal data?",
  },
  {
    id: "sensitive_data",
    question: "Will you handle sensitive data (health, ethnicity, beliefs, biometrics)?",
  },
  {
    id: "intervention",
    question: "Does the study include an intervention or manipulation applied to participants?",
  },
  { id: "risk_above_minimal", question: "Could participants face more than minimal risk?" },
  { id: "biological_samples", question: "Will you collect or analyze biological samples?" },
  { id: "animals", question: "Will animals be used?" },
  {
    id: "communities",
    question: "Does the work involve indigenous, ethnic or other protected communities?",
  },
  { id: "clinical_research", question: "Is this clinical research?" },
  {
    id: "additional_institutional_rules",
    question: "Does your institution add ethics rules beyond the law?",
  },
] as const;

export type EthicsTrigger = (typeof ethicsQuestions)[number]["id"];
export type EthicsAnswers = Partial<Record<EthicsTrigger, boolean>>;

const triggerIds: readonly string[] = ethicsQuestions.map((question) => question.id);

export function validateEthicsAnswers(raw: unknown): { answers: EthicsAnswers; errors: string[] } {
  const answers: EthicsAnswers = {};
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { answers, errors: ["Ethics answers must be a mapping of trigger id to true or false"] };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!triggerIds.includes(key)) {
      errors.push(`Unknown ethics trigger: ${key}`);
    } else if (typeof value !== "boolean") {
      errors.push(`Ethics answer ${key} must be true or false`);
    } else {
      answers[key as EthicsTrigger] = value;
    }
  }
  return { answers, errors };
}

export interface EthicsRequirement {
  id: string;
  trigger: EthicsTrigger;
  ruleId: string | null;
  text: string;
  /** ruleIds of consent, data-protection or risk rules that the trigger rule points to. */
  requires: string[];
  generic: boolean;
}

export interface EthicsMapping {
  requirements: EthicsRequirement[];
  /** Triggers answered yes that no rule in the profile covers. */
  unmapped: EthicsTrigger[];
  unanswered: EthicsTrigger[];
}

/** Map each `yes` answer to the `ethics_trigger` rules of the resolved compliance profile. */
export function mapEthicsRequirements(
  answers: EthicsAnswers,
  profile: ComplianceProfile,
): EthicsMapping {
  const requirements: EthicsRequirement[] = [];
  const unmapped: EthicsTrigger[] = [];
  const unanswered: EthicsTrigger[] = [];
  for (const { id } of ethicsQuestions) {
    const answer = answers[id];
    if (answer === undefined) {
      unanswered.push(id);
      continue;
    }
    if (!answer) continue;
    const rules = profile.rules
      .filter((rule) => rule.kind === "ethics_trigger" && rule.values.trigger === id)
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
    if (rules.length === 0) {
      unmapped.push(id);
      requirements.push({
        id: `ETH-${id.toUpperCase()}-00`,
        trigger: id,
        ruleId: null,
        text: `No policy rule covers "${id}". Ask your institution's ethics committee which approvals and documents are required. Never assume consent is unnecessary: only an ethics committee can waive it.`,
        requires: [],
        generic: true,
      });
      continue;
    }
    rules.forEach((rule, index) => {
      const values = rule.values;
      const pick = (key: string) =>
        typeof values[key] === "string" ? (values[key] as string) : undefined;
      const text = (
        pick("requirement") ??
        pick("quote") ??
        pick("definition") ??
        rule.source.reference
      ).slice(0, 400);
      const requires = Array.isArray(values.requires)
        ? values.requires.filter((entry): entry is string => typeof entry === "string")
        : [];
      requirements.push({
        id: `ETH-${id.toUpperCase()}-${String(index + 1).padStart(2, "0")}`,
        trigger: id,
        ruleId: rule.ruleId,
        text,
        requires,
        generic: false,
      });
    });
  }
  requirements.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { requirements, unmapped, unanswered };
}
