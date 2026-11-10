import type { Clock } from "../clock.js";
import { acceptAnswers, answerText, buildDraft, buildRound, nextRound } from "../interview.js";
import { localized } from "../knowledge/types.js";
import type { CatalogTopic, ExamDraft, RoundId, TeacherProfile, TopicCatalog } from "../types.js";

/**
 * The app's wizard (app spec D4). Pure: the frame sends every answer at once and this validates
 * them round by round with the chat's own `buildRound` + `acceptAnswers`, then calls `buildDraft`,
 * so the app and the chat accept exactly the same values. The topic is a catalog full id (O3).
 */

/** Every answer the wizard may send; `<id>:text` carries the number or text of an "other" option. */
export const WIZARD_FIELDS = [
  "topic",
  "grade",
  "grade:text",
  "level",
  "types",
  "count",
  "count:text",
  "distribution",
  "columns",
  "bank_size",
  "bank_size:text",
  "variants",
  "variants:text",
  "pages",
  "pages:text",
  "time",
  "time:text",
  "closing",
  "numbering",
] as const;
export type WizardField = (typeof WIZARD_FIELDS)[number];
export type WizardAnswers = Partial<Record<Exclude<WizardField, "types">, string>> & {
  types?: string[];
};

export type WizardErrorCode = "required" | "invalid" | "not_in_catalog" | "too_small";
export interface WizardError {
  field: string;
  code: WizardErrorCode;
}
export type WizardResult = { draft: ExamDraft } | { errors: WizardError[] };

export interface WizardContext {
  catalog: TopicCatalog;
  profile: TeacherProfile;
  clock: Clock;
}

/**
 * The catalog with the chosen topic first among the suggestions: the chat's topic question offers
 * only the first three, and `buildDraft` takes the title from the suggestion's label.
 */
export function pinTopic(catalog: TopicCatalog, topic: CatalogTopic): TopicCatalog {
  return {
    packs: () => catalog.packs(),
    resolvePack: (value) => catalog.resolvePack(value),
    ...(catalog.resolveTopic
      ? { resolveTopic: (text: string) => catalog.resolveTopic?.(text) }
      : {}),
    suggestions: (grade) => {
      const list = catalog.suggestions(grade);
      const own = list.find((entry) => entry.value === topic.id) ?? {
        value: topic.id,
        label: localized(topic.name),
      };
      return [own, ...list.filter((entry) => entry.value !== topic.id)];
    },
  };
}

function flatten(input: WizardAnswers): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const field of WIZARD_FIELDS) {
    const value = input[field];
    if (Array.isArray(value)) {
      if (value.length > 0) flat[field] = value.join(",");
    } else if (typeof value === "string" && value !== "") flat[field] = value;
  }
  return flat;
}

/** The question id an `acceptAnswers` message is about (`count: ...`, `count:text was ...`). */
function fieldOf(message: string): string {
  return /^([a-z_]+)/.exec(message)?.[1] ?? "answers";
}

export function runWizard(input: WizardAnswers, context: WizardContext): WizardResult {
  const topic = typeof input.topic === "string" ? context.catalog.topic?.(input.topic) : undefined;
  if (topic === undefined) {
    return { errors: [{ field: "topic", code: input.topic ? "not_in_catalog" : "required" }] };
  }
  const catalog = pinTopic(context.catalog, topic);
  const flat = flatten(input);
  const answers: Record<string, string> = {};
  const completed: RoundId[] = [];
  const errors: WizardError[] = [];
  for (;;) {
    const round = nextRound({ profileMissing: false, answers, completed });
    if (round === undefined) break;
    const questions = buildRound(round, { answers, catalog });
    const given: Record<string, string> = {};
    for (const question of questions) {
      for (const key of [question.id, `${question.id}:text`]) {
        if (flat[key] !== undefined) given[key] = flat[key];
      }
    }
    const { accepted, errors: problems } = acceptAnswers(questions, given);
    for (const problem of problems) {
      const field = fieldOf(problem);
      if (!errors.some((entry) => entry.field === field)) errors.push({ field, code: "invalid" });
    }
    Object.assign(answers, accepted);
    // Like the chat: a question that depends on another answer (the knowledge base once the topic
    // resolves, the distribution for one question) drops out once that answer is known.
    for (const question of buildRound(round, { answers, catalog })) {
      if (!errors.some((entry) => entry.field === question.id)) {
        errors.push({ field: question.id, code: "required" });
      }
    }
    completed.push(round);
  }
  if (answers.bank_size === "other") {
    const count = Number(answerText(answers, "count"));
    if (Number(answers["bank_size:text"]) < count + 5) {
      errors.push({ field: "bank_size", code: "too_small" });
    }
  }
  if (errors.length > 0) return { errors };
  return { draft: buildDraft(answers, context.profile, context.clock, catalog) };
}
