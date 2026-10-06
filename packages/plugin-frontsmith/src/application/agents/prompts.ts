import type { EnvelopeKind } from "../../domain/envelopes/parse.js";
import { envelopeExamples } from "./examples.js";
import type { FsRole } from "./roster.js";

/** One labelled block of input in a child prompt: a path list, a report, an excerpt. */
export interface PromptSection {
  title: string;
  body: string;
}

/** The reviewer's diff is prompt input, capped at 200 KB with the truncation stated (spec 5.3). */
export const MAX_DIFF_BYTES = 200_000;

export function capDiff(diff: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= MAX_DIFF_BYTES) return { text: diff, truncated: false };
  let cut = diff.slice(0, MAX_DIFF_BYTES);
  while (Buffer.byteLength(cut, "utf8") > MAX_DIFF_BYTES) cut = cut.slice(0, -1);
  return {
    text: `${cut}\n[diff truncated at ${MAX_DIFF_BYTES} bytes; the rest was not shown to you]`,
    truncated: true,
  };
}

/** What each role is asked to do, in one sentence; the agent file and skills carry the detail. */
const tasks: Record<Exclude<FsRole, "coordinator">, string> = {
  specifier: "Write the feature specification for the intent below.",
  "ui-contractor": "Write the UI contract for the approved specification below.",
  tokensmith: "Decide the token roles, themes and required contrast pairs below.",
  architect: "Write the minimal technical plan and the task contracts.",
  "test-engineer": "Do the test work described below.",
  implementer: "Implement exactly the task contract below.",
  "data-engineer": "Implement exactly the data-layer task contract below.",
  "a11y-auditor": "Audit the accessibility evidence below.",
  "fidelity-reviewer":
    "Classify the review items of the fidelity report below and order the repairs.",
  reviewer: "Review the feature independently and try to refute that it is ready.",
  archivist: "Write the retrospective and the rule candidates for the delivered feature.",
};

export const fence = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
};

/**
 * The prompt of one child run: the task sentence, the inputs as labelled sections, and the envelope
 * to return. Children get paths, structured reports and the schema, never orchestration details,
 * gate thresholds or another agent's narrative (spec 5.2).
 */
export function buildPrompt(
  role: Exclude<FsRole, "coordinator">,
  kind: EnvelopeKind,
  sections: readonly PromptSection[],
  options: { note?: string } = {},
): string {
  const parts = [tasks[role]];
  if (options.note) parts.push(options.note);
  for (const section of sections) parts.push(`## ${section.title}\n\n${section.body.trim()}`);
  parts.push(
    `## Envelope to return\n\nReturn one JSON object of kind \`${kind}\` with exactly these keys (the values are placeholders showing the shape):\n\n${fence(JSON.stringify(envelopeExamples[kind], null, 2))}\n\nNo prose before or after the JSON object.`,
  );
  return parts.join("\n\n");
}

/** The retry prompt after an invalid envelope: the errors, capped, and the same instruction. */
export function buildRetryPrompt(
  kind: EnvelopeKind,
  errors: ReadonlyArray<{ pointer: string; message: string }>,
  reason?: string,
): string {
  const shown = errors.slice(0, 20).map((e) => `- ${e.pointer || "(root)"}: ${e.message}`);
  const more =
    errors.length > shown.length ? `\n- ... and ${errors.length - shown.length} more` : "";
  return [
    reason ?? "Your previous final message was not a valid envelope.",
    shown.length > 0 ? `Problems:\n${shown.join("\n")}${more}` : "",
    `Return the corrected \`${kind}\` envelope: exactly one JSON object, no prose before or after it.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
