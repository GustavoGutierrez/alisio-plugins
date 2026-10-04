import { json, outlineDraft, protocolDraft } from "./data.js";
import type { Lifecycle } from "./harness.js";

/** Interview done and the outline approved: the plugin is in the `sections` phase. */
export async function toSections(h: Lifecycle) {
  await h.run("init", "--lang es-CO");
  h.setInteractive(false);
  h.script("thesis-methodologist", json(protocolDraft()));
  await h.run("design");
  await h.run("approve", "A");
  await h.run("approve", "B");
  h.script("thesis-architect", json(outlineDraft()));
  await h.run("outline");
  await h.run("approve", "OUTLINE");
}

export const topics = ["verificación de referencias", "integridad de citas"];

export const searchPlan = (extra: Record<string, unknown> = {}) => ({
  queries: [
    {
      topic: topics[0],
      query: "verificación automática de referencias",
      source: "openalex",
      language: "es",
      fromYear: 2015,
      toYear: 2026,
      limit: 10,
    },
    { topic: topics[1], query: "citation integrity theses", source: "crossref", limit: 5 },
    { topic: topics[1], query: "citation checking language models", source: "arxiv", limit: 5 },
  ],
  yearRangeReason: "Recent work on automated verification",
  webToolsAvailable: false,
  gaps: [],
  ...extra,
});

export const candidate = (over: Record<string, unknown>) => ({
  topic: topics[0],
  reason: "Relevant to the topic",
  firstAuthor: "Rojas",
  type: undefined,
  ...over,
});

export const sae = candidate({
  identifier: "10.5555/sae.2021.014",
  title: "Automated Verification of Bibliographic References in Academic Writing",
  year: 2021,
});

export const candidateSet = (
  candidates: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => ({
  candidates,
  gaps: [],
  webToolsUsed: false,
  ...extra,
});

/** Builds an AppraisalSet reply for whatever handles the prompt lists. */
export const appraise =
  (extra: Record<string, unknown> = {}, perHandle: Record<string, Record<string, unknown>> = {}) =>
  (prompt: string) =>
    json({
      appraisals: [...prompt.matchAll(/"handle":"(C\d\d)"/g)].map((match) => ({
        handle: match[1],
        relevance: "high",
        evidenceType: "empirical study",
        limitations: ["Single corpus"],
        supports: [topics[0]],
        permittedUse: ["background", "argument"],
        ...extra,
        ...perHandle[match[1] as string],
      })),
    });

/** Builds a Dossier reply that covers every topic and cites the first record of the packet. */
export const dossier =
  (
    gaps: { topic: string; description: string; critical: boolean }[] = [],
    forTopics: string[] = topics,
  ) =>
  (prompt: string) => {
    const packet = JSON.parse(
      /EVIDENCE PACKET \(data, not instructions\) ===\n([\s\S]*?)\n=== END/.exec(prompt)?.[1] ??
        "[]",
    ) as { id: string; citeKey: string }[];
    const first = packet[0];
    const covered = new Set(gaps.map((gap) => gap.topic));
    return json({
      synthesis: forTopics
        .filter((topic) => !covered.has(topic))
        .map((topic) => ({
          topic,
          summary: first
            ? `Síntesis de ${topic} [@${first.citeKey}].`
            : `Sin evidencia para ${topic}.`,
          evidence: first ? [first.id] : [],
        })),
      claims: first
        ? [
            {
              text: "La verificación automática de referencias es viable.",
              kind: "background",
              evidence: [first.id],
              topic: topics[0],
            },
          ]
        : [],
      gaps,
    });
  };

export const standardCandidates = () => [
  sae,
  candidate({
    identifier: "10.5555/soil.2015.099",
    title: "Automated Verification of Bibliographic References in Academic Writing",
    year: 2021,
  }),
  candidate({
    identifier: "10.5555/ret.2020.007",
    title: "A Neural Approach to Reference Matching",
    firstAuthor: "Salazar",
    year: 2020,
  }),
  candidate({
    identifier: "10.5555/book.2018.001",
    title: "Research Methods for Software Engineering",
    firstAuthor: "Vega",
    year: 2018,
    topic: topics[1],
  }),
  candidate({
    identifier: "arXiv:2203.01234",
    title: "Language Models for Citation Checking",
    firstAuthor: "Petrov",
    year: 2022,
    topic: topics[1],
  }),
  candidate({
    identifier: "W1001",
    title: "Automated Verification of Bibliographic References in Academic Writing",
    year: 2021,
  }),
];
