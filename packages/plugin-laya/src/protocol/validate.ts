import { LayaProtocolError } from "../errors.js";

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a finite number within [0, 1]. */
export function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A required probability; the message carries a short field code, never server text. */
export function requireProbability(value: unknown, field: string): number {
  if (!isProbability(value)) throw new LayaProtocolError("bad_number", `invalid ${field}`);
  return value;
}

/** An optional probability: `undefined` when absent, an error when present but invalid. */
export function optionalProbability(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireProbability(value, field);
}

/** A non-negative integer, or `undefined` for anything else. */
export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
