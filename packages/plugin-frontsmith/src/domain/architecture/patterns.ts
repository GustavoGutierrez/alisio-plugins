import { isShippedRuleId, matchesId } from "../ids.js";

/** One entry of `catalog/patterns.json` (spec 14.2). */
export interface Pattern {
  id: string;
  name: string;
  intent: string;
  useWhen: string[];
  avoidWhen: string[];
  structure: string;
  /** Rule ids that verify the pattern; empty means advisory guidance only. */
  verifiedBy: string[];
  /** Framework ids the pattern applies to; `all` means any. */
  frameworks: string[];
}

export interface PatternsCatalog {
  schemaVersion: 1;
  patterns: Pattern[];
}

export type PatternsValidation =
  | { ok: true; catalog: PatternsCatalog }
  | { ok: false; errors: string[] };

const KEYS = [
  "id",
  "name",
  "intent",
  "useWhen",
  "avoidWhen",
  "structure",
  "verifiedBy",
  "frameworks",
];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = (value: unknown, min: number, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= max &&
  value.every((entry) => text(entry, 400));

export function parsePatternsCatalog(raw: unknown): PatternsValidation {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.patterns))
    return { ok: false, errors: ["catalog needs schemaVersion 1 and a patterns array"] };
  const errors: string[] = [];
  const seen = new Set<string>();
  const patterns: Pattern[] = [];
  raw.patterns.forEach((entry: unknown, index: number) => {
    const where = `/patterns/${index}`;
    if (!isRecord(entry)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    for (const key of Object.keys(entry))
      if (!KEYS.includes(key)) errors.push(`${where}/${key}: unknown key`);
    if (!matchesId("pattern", entry.id)) errors.push(`${where}/id: invalid pattern id`);
    else if (seen.has(entry.id)) errors.push(`${where}/id: duplicate ${entry.id}`);
    else seen.add(entry.id);
    if (!text(entry.name, 120)) errors.push(`${where}/name: required`);
    if (!text(entry.intent, 400)) errors.push(`${where}/intent: required`);
    if (!text(entry.structure, 600)) errors.push(`${where}/structure: required`);
    if (!list(entry.useWhen, 1, 8)) errors.push(`${where}/useWhen: 1 to 8 statements`);
    if (!list(entry.avoidWhen, 1, 8)) errors.push(`${where}/avoidWhen: 1 to 8 statements`);
    if (!list(entry.frameworks, 1, 20)) errors.push(`${where}/frameworks: 1 to 20 ids`);
    if (
      !Array.isArray(entry.verifiedBy) ||
      !entry.verifiedBy.every((id: unknown) => isShippedRuleId(id))
    )
      errors.push(`${where}/verifiedBy: must be a list of shipped rule ids`);
    if (errors.length === 0) patterns.push(entry as unknown as Pattern);
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, catalog: { schemaVersion: 1, patterns } };
}
