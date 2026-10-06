import type { AskQuestionsResult, PluginAPI, Question } from "@alisio/sdk";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

/** The label every Frontsmith interaction carries, so a person sees which feature is asking. */
export const interactionLabel = (scope: string): string => `Frontsmith › ${scope}`;

export interface InteractionInput {
  /** The feature (or area such as `tokens`) that is asking. */
  scope: string;
  /** The session the command or tool runs in: the host routes the question to its stream (H11). */
  session: string;
  questions: Question[];
}

/**
 * Ask the person through `ui.askQuestions` (spec 18.1). Always passes `session` and `label`, stays
 * within 4 questions of 4 options, and resolves `undefined` without calling the host when no
 * interactive UI is bound, so the caller falls back to the exact command and never defaults.
 * Free text is never required here: unsupported by the web panel (H12), it has a command fallback.
 */
export async function askQuestions(
  api: PluginAPI,
  input: InteractionInput,
): Promise<AskQuestionsResult | undefined> {
  if (input.questions.length > MAX_QUESTIONS)
    throw new Error(`An interaction asks at most ${MAX_QUESTIONS} questions`);
  for (const question of input.questions)
    if (question.options.length > MAX_OPTIONS)
      throw new Error(`A question offers at most ${MAX_OPTIONS} options`);
  if (!api.ui.interactive()) return undefined;
  return api.ui.askQuestions({
    session: input.session,
    label: interactionLabel(input.scope),
    questions: input.questions,
  });
}
