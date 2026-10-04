import { parse, stringify } from "yaml";
import { labelsFor } from "./labels.js";
import type { EthicsRequirement } from "./policy/ethics.js";
import type { ProtocolDraft } from "./schemas.js";

export interface ProtocolObjective {
  id: string;
  verb: string;
  object: string;
  deliverable: string;
  text: string;
}

/** The authoritative content of `research/protocol.md` (its front matter). */
export interface ProtocolData {
  schemaVersion: 1;
  language: string;
  generatedAt: string;
  revision: number;
  problem: string;
  researchQuestions: string[];
  generalObjective: { id: "OBJ-G"; text: string };
  specificObjectives: ProtocolObjective[];
  justification: ProtocolDraft["justification"];
  scope: string;
  limitations: string[];
  hypotheses: string[];
  methodology: ProtocolDraft["methodology"];
  ethics: Record<string, boolean>;
  ethicsRequirements: Pick<EthicsRequirement, "id" | "trigger" | "ruleId" | "text" | "generic">[];
  openQuestions: string[];
}

const sentence = (verb: string, object: string) =>
  `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${object}`;

/** Objective ids are allocated by code: OBJ-G, then OBJ-01.. in the order the draft lists them. */
export function buildProtocol(
  draft: ProtocolDraft,
  meta: {
    language: string;
    now: Date;
    revision: number;
    ethicsRequirements: ProtocolData["ethicsRequirements"];
  },
): ProtocolData {
  return {
    schemaVersion: 1,
    language: meta.language,
    generatedAt: meta.now.toISOString(),
    revision: meta.revision,
    problem: draft.problem,
    researchQuestions: draft.researchQuestions,
    generalObjective: { id: "OBJ-G", text: draft.generalObjective },
    specificObjectives: draft.specificObjectives.map((objective, index) => ({
      id: `OBJ-${String(index + 1).padStart(2, "0")}`,
      verb: objective.verb,
      object: objective.object,
      deliverable: objective.deliverable,
      text: sentence(objective.verb, objective.object),
    })),
    justification: draft.justification,
    scope: draft.scope,
    limitations: draft.limitations,
    hypotheses: draft.hypotheses,
    methodology: draft.methodology,
    ethics: draft.ethics,
    ethicsRequirements: meta.ethicsRequirements,
    openQuestions: draft.openQuestions,
  };
}

const bullets = (items: readonly string[], none: string) =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${none}`;

export function renderProtocol(data: ProtocolData): string {
  const l = labelsFor(data.language);
  const yes = Object.entries(data.ethics).filter(([, value]) => value);
  const ethicsBody = yes.length
    ? yes
        .map(([trigger]) => {
          const requirements = data.ethicsRequirements.filter((item) => item.trigger === trigger);
          const detail = requirements.length
            ? requirements.map((item) => `  - ${item.id}: ${item.text}`).join("\n")
            : "";
          return `- ${trigger}: ${l.yes}${detail ? `\n${detail}` : ""}`;
        })
        .join("\n")
    : l.ethicsNone;
  const body = [
    `# ${l.protocol}`,
    `> ${l.editNote}`,
    `## ${l.problem}\n\n${data.problem}`,
    `## ${l.researchQuestions}\n\n${bullets(data.researchQuestions, l.none)}`,
    `## ${l.generalObjective}\n\n**${data.generalObjective.id}** ${data.generalObjective.text}`,
    `## ${l.specificObjectives}\n\n${data.specificObjectives
      .map((item) => `- **${item.id}** ${item.text}\n  - ${l.deliverable}: ${item.deliverable}`)
      .join("\n")}`,
    `## ${l.justification}\n\n- ${l.relevance}: ${data.justification.relevance}\n- ${l.novelty}: ${data.justification.novelty}\n- ${l.feasibility}: ${data.justification.feasibility}\n- ${l.beneficiaries}: ${data.justification.beneficiaries}`,
    `## ${l.scope}\n\n${data.scope}\n\n### ${l.limitations}\n\n${bullets(data.limitations, l.none)}`,
    ...(data.hypotheses.length
      ? [`## ${l.hypotheses}\n\n${bullets(data.hypotheses, l.none)}`]
      : []),
    `## ${l.methodology}\n\n- ${l.design}: ${data.methodology.design}\n- ${l.population}: ${data.methodology.population}\n- ${l.instruments}: ${data.methodology.instruments.join("; ") || l.none}\n- ${l.analysisPlan}: ${data.methodology.analysisPlan}\n- ${l.reportingGuideline}: ${data.methodology.reportingGuideline ?? l.none}`,
    `## ${l.ethics}\n\n${ethicsBody}`,
    ...(data.openQuestions.length
      ? [`## ${l.openQuestions}\n\n${bullets(data.openQuestions, l.none)}`]
      : []),
  ].join("\n\n");
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n${body}\n`;
}

export interface ParsedProtocol {
  data?: Record<string, unknown>;
  error?: string;
}

/** Read the front matter of protocol.md without assuming it is complete (DSN checks report gaps). */
export function parseProtocol(source: string): ParsedProtocol {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { error: "protocol.md has no front matter" };
  try {
    const value = parse(match[1] as string) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: "protocol.md front matter must be a mapping" };
    }
    return { data: value as Record<string, unknown> };
  } catch (error) {
    return {
      error: `protocol.md front matter is not valid YAML: ${(error as Error).message.split("\n")[0]}`,
    };
  }
}
