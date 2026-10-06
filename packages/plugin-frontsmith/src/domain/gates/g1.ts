import type { SpecEnvelope } from "../envelopes/spec.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G1Question {
  id: string;
  blocking: boolean;
  answer?: string;
}

export interface G1Input {
  spec: SpecEnvelope;
  /** The questions as tracked in the feature state (answers live there). */
  questions: readonly G1Question[];
}

const STATE_ID = /\bST-[a-z][a-z0-9-]{1,30}\b/g;

/** Selector, XPath and structural DOM patterns that never belong in an acceptance criterion (SPC-007). */
const SELECTOR_PATTERNS: readonly RegExp[] = [
  /:nth-(?:child|of-type)\b/i,
  /(^|[\s(])\/\/[a-z*@[]/i,
  /\b(?:querySelector(?:All)?|getElementBy\w+|document\.\w+)\b/,
  /(^|[\s"'`(])#[a-z][\w-]{1,}\b/i,
  /(^|[\s"'`(])\.[a-z][\w-]{2,}(?=[\s>+~:.[,)"'`]|$)[^.]*[>+~]\s*[.#a-z]/i,
  /\S\s*>\s*(?:\.|#|[a-z]+[\s>.:[])/i,
  /\[[a-z-]+[~|^$*]?=[^\]]*\]/i,
];

export const hasSelectorPattern = (text: string): boolean =>
  SELECTOR_PATTERNS.some((pattern) => pattern.test(text));

/** G1 Spec (spec 7.2): structure, coverage, states, blocking questions and selector-free criteria. */
export function gateG1(input: G1Input): GateOutcome {
  const { spec } = input;
  const b = new GateBuilder();
  b.add("schema", "PASS", "envelope valid; ids unique and well formed");

  const covered = new Set(spec.acceptanceCriteria.map((ac) => ac.requirementId));
  const uncovered = spec.requirements.filter((req) => !covered.has(req.id));
  if (spec.requirements.length === 0) {
    b.add("requirements", "FAIL", "the spec has no requirements");
    b.finding("requirements", "SPC-006", "major", "FAIL", "The spec has no requirements.");
  } else {
    b.problems(
      "requirements",
      "SPC-001",
      uncovered.map((req) => `${req.id} has no acceptance criterion`),
      `${spec.requirements.length} requirements, each with a criterion`,
      { fix: "Add at least one acceptance criterion for the requirement." },
    );
  }

  const known = new Set(spec.requirements.map((req) => req.id));
  b.problems(
    "acceptance-refs",
    "SPC-002",
    spec.acceptanceCriteria
      .filter((ac) => !known.has(ac.requirementId))
      .map((ac) => `${ac.id} refers to unknown requirement ${ac.requirementId}`),
    "every criterion refers to an existing requirement",
  );

  const stateIds = new Set(spec.states.map((state) => state.id));
  const stateProblems: string[] = [];
  for (const required of ["initial", "success"] as const)
    if (!spec.states.some((state) => state.kind === required))
      stateProblems.push(`the spec lacks a state of kind ${required}`);
  const texts = [
    ...spec.requirements.map((req) => req.statement),
    ...spec.acceptanceCriteria.flatMap((ac) => [ac.given, ac.when, ac.then]),
  ];
  for (const text of texts)
    for (const match of text.matchAll(STATE_ID))
      if (!stateIds.has(match[0])) stateProblems.push(`${match[0]} is named but not defined`);
  b.problems(
    "states",
    "SPC-003",
    [...new Set(stateProblems)],
    "initial and success states present",
    {
      fix: "Define the state in `states` or fix the reference.",
    },
  );

  const answered = new Map(
    input.questions.map((q) => [q.id, q.answer !== undefined && q.answer !== ""]),
  );
  const open = spec.openQuestions.filter((q) => q.blocking && answered.get(q.id) !== true);
  if (open.length === 0) b.add("open-questions", "PASS", "no blocking question is open");
  else {
    b.add(
      "open-questions",
      "BLOCKED",
      `${open.length} blocking question${open.length === 1 ? "" : "s"} unanswered`,
    );
    for (const q of open)
      b.finding("open-questions", "SPC-005", "blocker", "BLOCKED", `${q.id}: ${q.question}`, {
        fix: `/frontsmith:answer <feature> ${q.id} -- <your answer>`,
      });
  }

  const selectorProblems: string[] = [];
  for (const ac of spec.acceptanceCriteria)
    if ([ac.given, ac.when, ac.then].some(hasSelectorPattern))
      selectorProblems.push(`${ac.id} describes DOM structure instead of an observable outcome`);
  b.problems("selectors", "SPC-007", selectorProblems, "criteria are free of selectors", {
    fix: "Rewrite the criterion in terms of what a person sees or does.",
  });
  return b.outcome;
}
