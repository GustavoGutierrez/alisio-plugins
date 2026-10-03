/**
 * Pure mapping between Alisio decisions and the Laya `POST /v1/systemone` wire format.
 *
 * Question ids are positional (`q0`, `q1`, ...) so decision keys never reach the server and
 * responses are looked up only by ids this module generated.
 */
import type {
  DecisionAnswer,
  DecisionDefinition,
  DecisionProviderResult,
  DecisionRequest,
  JsonValue,
} from "@alisio/sdk";
import { LayaProtocolError, LayaRequestError } from "../errors.js";
import {
  isProbability,
  isRecord,
  nonNegativeInteger,
  optionalProbability,
  requireProbability,
} from "./validate.js";

export const MAX_DECISIONS = 16;
export const MAX_OPTIONS = 20;
export const MAX_LEVELS = 32;
export const MAX_STATE_BYTES = 16 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/;
const DEFAULT_TRUE_MEANING = "yes, the statement holds";
const DEFAULT_FALSE_MEANING = "no, the statement does not hold";

export type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export interface LayaWireRequest {
  state: JsonValue;
  questions: Record<string, WireQuestion>;
  model?: string;
  lang_guess?: string;
}

export interface PlanEntry {
  key: string;
  id: string;
  definition: DecisionDefinition;
}

/** Reverse map from generated wire ids to the caller's decisions. */
export interface EncodedPlan {
  entries: PlanEntry[];
}

export interface EncodeOptions {
  /** Checkpoint name pinned per request when a single checkpoint is configured. */
  model?: string;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LayaRequestError("invalid_text", `${what} must be a non-empty string`);
  }
  return value;
}

function byteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function encodeQuestion(definition: DecisionDefinition): WireQuestion {
  const instructions = requireText(definition?.instruction, "instruction");
  switch (definition.type) {
    case "select": {
      const keys = isRecord(definition.options) ? Object.keys(definition.options) : [];
      if (keys.length === 0 || keys.length > MAX_OPTIONS) {
        throw new LayaRequestError("bad_options", `a select needs 1 to ${MAX_OPTIONS} options`);
      }
      const criteria: Record<string, string> = {};
      for (const key of keys) {
        requireText(key, "option key");
        criteria[key] = requireText(definition.options[key], "option description");
      }
      return { type: "choice", instructions, criteria };
    }
    case "boolean":
      return {
        type: "noul",
        instructions,
        criteria: {
          true: definition.trueMeaning ?? DEFAULT_TRUE_MEANING,
          false: definition.falseMeaning ?? DEFAULT_FALSE_MEANING,
        },
      };
    case "ordinal": {
      const levels = definition.levels;
      if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_LEVELS) {
        throw new LayaRequestError("bad_levels", `an ordinal needs 1 to ${MAX_LEVELS} levels`);
      }
      for (const level of levels) requireText(level, "ordinal level");
      if (new Set(levels).size !== levels.length) {
        throw new LayaRequestError("duplicate_levels", "ordinal levels must be unique");
      }
      return { type: "score", instructions, criteria: [...levels] };
    }
    default:
      throw new LayaRequestError("bad_type", "unsupported decision type");
  }
}

function wrapState(state: JsonValue): JsonValue {
  if (typeof state === "string" || Array.isArray(state) || isRecord(state)) return state;
  return { value: state };
}

export function encodeRequest(
  request: DecisionRequest,
  options: EncodeOptions = {},
): { wire: LayaWireRequest; plan: EncodedPlan } {
  if (request.version !== 1) {
    throw new LayaProtocolError("unsupported_version", "unsupported decision request version");
  }
  const keys = isRecord(request.decisions) ? Object.keys(request.decisions) : [];
  if (keys.length === 0 || keys.length > MAX_DECISIONS) {
    throw new LayaRequestError(
      "bad_decision_count",
      `a request needs 1 to ${MAX_DECISIONS} decisions`,
    );
  }
  if (byteLength(request.state) > MAX_STATE_BYTES) {
    throw new LayaRequestError("state_too_large", "state exceeds 16 KB");
  }
  const questions: Record<string, WireQuestion> = {};
  const entries: PlanEntry[] = [];
  for (const [index, key] of keys.entries()) {
    if (!KEY_PATTERN.test(key)) {
      throw new LayaRequestError("bad_key", "decision key does not match the allowed pattern");
    }
    const definition = request.decisions[key] as DecisionDefinition;
    const id = `q${index}`;
    questions[id] = encodeQuestion(definition);
    entries.push({ key, id, definition });
  }
  const wire: LayaWireRequest = { state: wrapState(request.state), questions };
  if (options.model) wire.model = options.model;
  if (
    typeof request.language === "string" &&
    request.language.length <= 35 &&
    LANGUAGE_TAG.test(request.language)
  ) {
    wire.lang_guess = request.language;
  }
  if (byteLength(wire) > MAX_REQUEST_BYTES) {
    throw new LayaRequestError("request_too_large", "request exceeds 32 KB");
  }
  return { wire, plan: { entries } };
}

function confidenceFrom(answer: Record<string, unknown>, fallback: number | undefined): number {
  const confidence = optionalProbability(answer.answer_confidence, "answer_confidence") ?? fallback;
  if (confidence === undefined) {
    throw new LayaProtocolError("missing_confidence", "answer carries no usable confidence");
  }
  return confidence;
}

function decodeSelect(
  answer: Record<string, unknown>,
  options: Record<string, string>,
): DecisionAnswer {
  const value = answer.choice;
  if (typeof value !== "string" || !Object.hasOwn(options, value)) {
    throw new LayaProtocolError("bad_choice", "choice is not one of the requested options");
  }
  let probabilities: Record<string, number> | undefined;
  if (answer.probabilities !== undefined) {
    if (!isRecord(answer.probabilities)) {
      throw new LayaProtocolError("bad_probabilities", "probabilities must be an object");
    }
    probabilities = {};
    for (const [label, p] of Object.entries(answer.probabilities)) {
      if (!Object.hasOwn(options, label)) {
        throw new LayaProtocolError("bad_probabilities", "probability for an unknown option");
      }
      probabilities[label] = requireProbability(p, "probability");
    }
  }
  const confidence = confidenceFrom(answer, probabilities?.[value]);
  return probabilities
    ? { type: "select", value, confidence, probabilities }
    : { type: "select", value, confidence };
}

function decodeBoolean(answer: Record<string, unknown>): DecisionAnswer {
  const probability = requireProbability(answer.noul, "noul");
  return {
    type: "boolean",
    value: probability >= 0.5,
    confidence: Math.max(probability, 1 - probability),
    probability,
  };
}

function decodeOrdinal(answer: Record<string, unknown>, levels: string[]): DecisionAnswer {
  const raw = answer.probabilities;
  if (!isRecord(raw)) {
    throw new LayaProtocolError("bad_probabilities", "score answer carries no probabilities");
  }
  const keys = Object.keys(raw);
  const distribution: number[] = [];
  for (let i = 0; i < levels.length; i++) {
    const p = raw[String(i)];
    if (!isProbability(p)) {
      throw new LayaProtocolError("bad_probabilities", "score probabilities are incomplete");
    }
    distribution.push(p);
  }
  if (keys.length !== levels.length) {
    throw new LayaProtocolError("bad_probabilities", "score probabilities have unexpected keys");
  }
  let index = 0;
  for (let i = 1; i < distribution.length; i++) {
    if ((distribution[i] as number) > (distribution[index] as number)) index = i;
  }
  const level = levels[index] as string;
  return {
    type: "ordinal",
    level,
    index,
    confidence: confidenceFrom(answer, distribution[index]),
    distribution,
  };
}

export function decodeResponse(body: unknown, plan: EncodedPlan): DecisionProviderResult {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new LayaProtocolError("bad_response", "response has no answers object");
  }
  const decisions: Record<string, DecisionAnswer> = {};
  for (const { key, id, definition } of plan.entries) {
    const answer = Object.hasOwn(body.answers, id) ? body.answers[id] : undefined;
    if (!isRecord(answer)) {
      throw new LayaProtocolError("missing_answer", "response is missing a requested answer");
    }
    switch (definition.type) {
      case "select":
        decisions[key] = decodeSelect(answer, definition.options);
        break;
      case "boolean":
        decisions[key] = decodeBoolean(answer);
        break;
      case "ordinal":
        decisions[key] = decodeOrdinal(answer, definition.levels);
        break;
    }
  }
  const result: DecisionProviderResult = { decisions };
  if (isRecord(body.usage)) {
    const inputUnits = nonNegativeInteger(body.usage.input_tokens);
    const outputUnits = nonNegativeInteger(body.usage.output_tokens);
    if (inputUnits !== undefined || outputUnits !== undefined) {
      result.usage = {
        ...(inputUnits !== undefined ? { inputUnits } : {}),
        ...(outputUnits !== undefined ? { outputUnits } : {}),
      };
    }
  }
  return result;
}
