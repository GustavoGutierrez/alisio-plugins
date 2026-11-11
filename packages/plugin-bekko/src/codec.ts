/**
 * Pure mapping between Alisio's `DecisionRequest` v1 and Bekko's typed questions (choice, noul,
 * score). Decoding treats the model output as untrusted: every probability must be a finite number
 * in [0, 1] and every answer must match the question it belongs to, otherwise the whole result is
 * rejected and the host falls back.
 */
import type { DecisionAnswer, DecisionProviderResult, DecisionRequest } from "@alisio/sdk";
import type { Question, RawAnswer } from "./types.js";

export const MAX_DECISIONS = 16;
export const MAX_REQUEST_BYTES = 32_768;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A request the provider cannot encode (the host already validates; this is defense in depth). */
export class BekkoRequestError extends Error {
  override name = "BekkoRequestError";
}

/** Model output that does not match the request. */
export class BekkoResponseError extends Error {
  override name = "BekkoResponseError";
}

export interface Encoded {
  state: string;
  questions: Question[];
  keys: string[];
  definitions: DecisionRequest["decisions"];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BekkoRequestError(`invalid ${label}`);
  return value;
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BekkoResponseError(`invalid probability: ${label}`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BekkoResponseError("missing probabilities");
  }
  return value as Record<string, unknown>;
}

export function encode(request: DecisionRequest): Encoded {
  if (request.version !== 1) throw new BekkoRequestError("unsupported decision request version");
  const keys = Object.keys(request.decisions ?? {});
  if (keys.length === 0 || keys.length > MAX_DECISIONS) {
    throw new BekkoRequestError("invalid number of decisions");
  }
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
    throw new BekkoRequestError("request exceeds 32 KiB");
  }
  const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
  const questions = keys.map((key): Question => {
    if (!KEY.test(key)) throw new BekkoRequestError("invalid decision key");
    const definition = request.decisions[key];
    if (!definition) throw new BekkoRequestError("missing decision");
    const instructions = text(definition.instruction, "instruction");
    switch (definition.type) {
      case "select": {
        const entries = Object.entries(definition.options ?? {});
        if (entries.length < 2 || entries.length > 20) {
          throw new BekkoRequestError("select expects 2 to 20 options");
        }
        const criteria: Record<string, string> = {};
        for (const [name, meaning] of entries) criteria[name] = text(meaning, `option ${name}`);
        return { id: key, type: "choice", instructions, options: Object.keys(criteria), criteria };
      }
      case "boolean":
        return {
          id: key,
          type: "noul",
          instructions,
          options: ["no", "yes"],
          criteria: {
            true: definition.trueMeaning?.trim() || "Yes, the condition in the question holds.",
            false:
              definition.falseMeaning?.trim() || "No, the condition in the question does not hold.",
          },
        };
      case "ordinal": {
        const levels = definition.levels;
        if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
          throw new BekkoRequestError("ordinal expects 2 to 10 levels");
        }
        if (new Set(levels).size !== levels.length) throw new BekkoRequestError("duplicate level");
        return {
          id: key,
          type: "score",
          instructions,
          options: levels.map((level) => text(level, "ordinal level")),
        };
      }
      default:
        throw new BekkoRequestError("unknown decision type");
    }
  });
  return { state, questions, keys, definitions: request.decisions };
}

export function decode(
  encoded: Encoded,
  answers: readonly RawAnswer[],
  truncated: boolean,
): DecisionProviderResult {
  if (truncated) throw new BekkoRequestError("input truncated by the model; refusing to answer");
  if (!Array.isArray(answers) || answers.length !== encoded.keys.length) {
    throw new BekkoResponseError("unexpected answer count");
  }
  const decisions: Record<string, DecisionAnswer> = {};
  encoded.keys.forEach((key, i) => {
    const definition = encoded.definitions[key];
    const answer = answers[i];
    if (!definition || !answer || typeof answer !== "object") {
      throw new BekkoResponseError("missing answer");
    }
    if (definition.type === "select") {
      if (
        answer.type !== "choice" ||
        typeof answer.choice !== "string" ||
        !Object.hasOwn(definition.options, answer.choice)
      ) {
        throw new BekkoResponseError("invalid choice answer");
      }
      const raw = record(answer.probabilities);
      const probabilities: Record<string, number> = {};
      for (const option of Object.keys(definition.options)) {
        probabilities[option] = probability(raw[option], option);
      }
      decisions[key] = {
        type: "select",
        value: answer.choice,
        confidence: probability(answer.confidence, "confidence"),
        probabilities,
      };
    } else if (definition.type === "boolean") {
      if (answer.type !== "noul") throw new BekkoResponseError("invalid boolean answer");
      const yes = probability(answer.noul, "noul");
      decisions[key] = {
        type: "boolean",
        value: yes >= 0.5,
        confidence: Math.max(yes, 1 - yes),
        probability: yes,
      };
    } else {
      if (answer.type !== "score") throw new BekkoResponseError("invalid ordinal answer");
      const raw = record(answer.probabilities);
      const distribution = definition.levels.map((_, j) =>
        probability(raw[String(j)], `level ${j}`),
      );
      const confidence = Math.max(...distribution);
      const index = distribution.indexOf(confidence);
      const level = definition.levels[index];
      if (level === undefined) throw new BekkoResponseError("invalid ordinal answer");
      decisions[key] = { type: "ordinal", level, index, confidence, distribution };
    }
  });
  return { decisions };
}
