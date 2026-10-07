import type { FigureBlock, MarkupLine } from "../markup.js";
import { levels as allLevels, type ItemType, itemTypes, type Level } from "../types.js";
import type { CheckCollector, Severity } from "./report.js";
import type {
  BankSource,
  CognitiveMix,
  FamilySource,
  LevelCalibration,
  LocalizedText,
  PackMeta,
  StaticItem,
  StaticOption,
  Topic,
  TopicObjective,
  TopicSource,
} from "./types.js";

export const KB_SCHEMA = "EVL-KB-001";
export const KB_COLLISION = "EVL-KB-002";
export const KB_REQUIRES = "EVL-KB-003";
export const KB_SOURCE = "EVL-KB-004";
export const KB_CALIBRATION = "EVL-KB-005";
export const KB_OBJECTIVES = "EVL-KB-006";
export const KB_ITEM_CHECK = "EVL-KB-007";

export const packIdPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const codePattern = /^[A-Z]{2,4}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const grew = (collector: CheckCollector, before: number): boolean =>
  collector.results.length > before;

function fail(collector: CheckCollector, id: string, subject: string, message: string): undefined {
  collector.error(id, subject, message);
  return undefined;
}

function readString(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
  max = 200,
  id = KB_SCHEMA,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    return fail(collector, id, subject, `${field} must be text of 1 to ${max} characters`);
  }
  return value;
}

function readSlug(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): string | undefined {
  const text = readString(value, subject, field, collector, 32);
  if (text === undefined) return undefined;
  if (!packIdPattern.test(text)) {
    return fail(collector, KB_SCHEMA, subject, `${field} must be a lowercase id (got "${text}")`);
  }
  return text;
}

function readCode(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): string | undefined {
  const text = readString(value, subject, field, collector, 4);
  if (text === undefined) return undefined;
  if (!codePattern.test(text)) {
    return fail(
      collector,
      KB_SCHEMA,
      subject,
      `${field} must be 2 to 4 uppercase letters (got "${text}")`,
    );
  }
  return text;
}

function readStringArray(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
  { required = false }: { required?: boolean } = {},
): string[] | undefined {
  if (value === undefined || value === null) {
    if (required) return fail(collector, KB_SCHEMA, subject, `${field} is required`);
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return fail(collector, KB_SCHEMA, subject, `${field} must be a list of text`);
  }
  return value as string[];
}

function readLocalized(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): LocalizedText | undefined {
  if (!isRecord(value)) return fail(collector, KB_SCHEMA, subject, `${field} must be a mapping`);
  const before = collector.results.length;
  const out: LocalizedText = {};
  for (const [language, text] of Object.entries(value)) {
    if (typeof text !== "string" || text.trim().length === 0) {
      collector.error(KB_SCHEMA, subject, `${field}.${language} must be text`);
      continue;
    }
    out[language] = text;
  }
  if (out.es === undefined)
    collector.error(KB_SCHEMA, subject, `${field} must include an "es" text`);
  return grew(collector, before) ? undefined : out;
}

function readLevels(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): Level[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(collector, KB_SCHEMA, subject, `${field} must be a non-empty list of levels`);
  }
  const out: Level[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(allLevels as readonly string[]).includes(entry)) {
      return fail(
        collector,
        KB_SCHEMA,
        subject,
        `${field} has an unknown level "${String(entry)}"; expected ${allLevels.join(", ")}`,
      );
    }
    if (!out.includes(entry as Level)) out.push(entry as Level);
  }
  return out;
}

function readIntPair(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): [number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => Number.isInteger(entry))
  ) {
    return fail(collector, KB_CALIBRATION, subject, `${field} must be a pair of integers`);
  }
  const [low, high] = value as [number, number];
  if (low > high) {
    return fail(collector, KB_CALIBRATION, subject, `${field} must have low <= high`);
  }
  if (field.endsWith("steps") && low < 0) {
    return fail(collector, KB_CALIBRATION, subject, `${field} cannot be negative`);
  }
  return [low, high];
}

function readMix(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): CognitiveMix | undefined {
  if (!isRecord(value)) {
    return fail(collector, KB_CALIBRATION, subject, `${field} must be a mapping`);
  }
  const parts: Record<string, number> = {};
  for (const key of ["recall", "apply", "reason"]) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      return fail(
        collector,
        KB_CALIBRATION,
        subject,
        `${field}.${key} must be a non-negative integer`,
      );
    }
    parts[key] = entry;
  }
  const total = (parts.recall ?? 0) + (parts.apply ?? 0) + (parts.reason ?? 0);
  if (total !== 100) {
    return fail(collector, KB_CALIBRATION, subject, `${field} must sum to 100 (got ${total})`);
  }
  return { recall: parts.recall ?? 0, apply: parts.apply ?? 0, reason: parts.reason ?? 0 };
}

function readCalibration(
  value: unknown,
  subject: string,
  level: string,
  collector: CheckCollector,
): LevelCalibration | undefined {
  if (!isRecord(value)) {
    return fail(collector, KB_CALIBRATION, subject, `missing calibration for level "${level}"`);
  }
  const before = collector.results.length;
  const steps = readIntPair(value.steps, subject, `levels.${level}.steps`, collector);
  const coefficientRange = readIntPair(
    value.coefficientRange,
    subject,
    `levels.${level}.coefficientRange`,
    collector,
  );
  const cognitiveMix = readMix(
    value.cognitiveMix,
    subject,
    `levels.${level}.cognitiveMix`,
    collector,
  );
  const seconds = value.secondsPerItem;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    collector.error(
      KB_CALIBRATION,
      subject,
      `levels.${level}.secondsPerItem must be a positive number`,
    );
  }
  if (grew(collector, before)) return undefined;
  return {
    steps: steps as [number, number],
    coefficientRange: coefficientRange as [number, number],
    cognitiveMix: cognitiveMix as CognitiveMix,
    secondsPerItem: seconds as number,
  };
}

export function validatePackMeta(
  input: unknown,
  subject: string,
  collector: CheckCollector,
): PackMeta | undefined {
  if (!isRecord(input)) return fail(collector, KB_SCHEMA, subject, "pack.yaml must be a mapping");
  const before = collector.results.length;
  if (input.schemaVersion !== 1) {
    collector.error(
      KB_SCHEMA,
      subject,
      `schemaVersion must be 1 (got ${String(input.schemaVersion)})`,
    );
  }
  const id = readSlug(input.id, subject, "id", collector);
  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    collector.error(KB_SCHEMA, subject, "version must be an integer >= 1");
  }
  const name = readLocalized(input.name, subject, "name", collector);
  const code = readCode(input.code, subject, "code", collector);
  const requires = readStringArray(input.requires, subject, "requires", collector);
  if (requires !== undefined) {
    for (const required of requires) {
      if (!packIdPattern.test(required)) {
        collector.error(KB_SCHEMA, subject, `requires entry "${required}" is not a pack id`);
      }
    }
  }
  let extendsId: string | null = null;
  if (input.extends !== undefined && input.extends !== null) {
    const parsed = readSlug(input.extends, subject, "extends", collector);
    if (parsed !== undefined) extendsId = parsed;
  }
  let overrides = false;
  if (input.overrides !== undefined) {
    if (typeof input.overrides !== "boolean") {
      collector.error(KB_SCHEMA, subject, "overrides must be a boolean");
    } else {
      overrides = input.overrides;
    }
  }
  const levels: Partial<Record<Level, LevelCalibration>> = {};
  if (!isRecord(input.levels)) {
    collector.error(KB_CALIBRATION, subject, "levels must be a mapping of the four levels");
  } else {
    for (const level of allLevels) {
      const calibration = readCalibration(input.levels[level], subject, level, collector);
      if (calibration !== undefined) levels[level] = calibration;
    }
  }
  if (grew(collector, before)) return undefined;
  return {
    schemaVersion: 1,
    id: id as string,
    version: version as number,
    name: name as LocalizedText,
    code: code as string,
    requires: requires ?? [],
    extends: extendsId,
    overrides,
    levels: levels as Record<Level, LevelCalibration>,
  };
}

function readSource(
  value: unknown,
  subject: string,
  index: number,
  collector: CheckCollector,
): TopicSource | undefined {
  if (!isRecord(value)) {
    return fail(collector, KB_SCHEMA, subject, `sources[${index}] must be a mapping`);
  }
  if (value.kind === "family") {
    const family = readString(value.family, subject, `sources[${index}].family`, collector, 64);
    const levels = readLevels(value.levels, subject, `sources[${index}].levels`, collector);
    const params = value.params;
    if (params !== undefined && !isRecord(params)) {
      return fail(collector, KB_SCHEMA, subject, `sources[${index}].params must be a mapping`);
    }
    if (family === undefined || levels === undefined) return undefined;
    const source: FamilySource = { kind: "family", family, levels };
    if (params !== undefined) source.params = { ...params };
    return source;
  }
  if (value.kind === "bank") {
    const file = readString(value.file, subject, `sources[${index}].file`, collector, 256);
    if (file === undefined) return undefined;
    if (!/^items\/[A-Za-z0-9._-]+\.yaml$/.test(file) || file.includes("..")) {
      return fail(
        collector,
        KB_SCHEMA,
        subject,
        `sources[${index}].file must be an items/*.yaml path (got "${file}")`,
      );
    }
    const source: BankSource = { kind: "bank", file };
    return source;
  }
  return fail(collector, KB_SCHEMA, subject, `sources[${index}].kind must be "family" or "bank"`);
}

export function validateTopic(
  input: unknown,
  subject: string,
  collector: CheckCollector,
): Topic | undefined {
  if (!isRecord(input)) return fail(collector, KB_SCHEMA, subject, "topic file must be a mapping");
  const before = collector.results.length;
  const id = readSlug(input.id, subject, "id", collector);
  const name = readLocalized(input.name, subject, "name", collector);
  const code = readCode(input.code, subject, "code", collector);
  const grades = readStringArray(input.grades, subject, "grades", collector) ?? [];
  const prerequisites =
    readStringArray(input.prerequisites, subject, "prerequisites", collector) ?? [];
  const keywords = readStringArray(input.keywords, subject, "keywords", collector) ?? [];

  const objectives: TopicObjective[] = [];
  if (!Array.isArray(input.objectives) || input.objectives.length === 0) {
    collector.error(KB_OBJECTIVES, subject, "objectives must be a non-empty list");
  } else {
    input.objectives.forEach((entry, index) => {
      const item = `objectives[${index}]`;
      if (!isRecord(entry)) {
        collector.error(KB_SCHEMA, subject, `${item} must be a mapping`);
        return;
      }
      const objectiveId = readSlug(entry.id, subject, `${item}.id`, collector);
      const text = readLocalized(entry.text, subject, `${item}.text`, collector);
      const levels = readLevels(entry.levels, subject, `${item}.levels`, collector);
      if (objectiveId && text && levels) objectives.push({ id: objectiveId, text, levels });
    });
  }

  const supports = Object.fromEntries(itemTypes.map((type) => [type, false])) as Record<
    ItemType,
    boolean
  >;
  if (input.supports !== undefined) {
    if (!isRecord(input.supports)) {
      collector.error(KB_SCHEMA, subject, "supports must be a mapping of item type to boolean");
    } else {
      for (const [key, value] of Object.entries(input.supports)) {
        if (!(itemTypes as readonly string[]).includes(key)) {
          collector.error(KB_SCHEMA, subject, `supports has unknown item type "${key}"`);
          continue;
        }
        if (typeof value !== "boolean") {
          collector.error(KB_SCHEMA, subject, `supports.${key} must be a boolean`);
          continue;
        }
        supports[key as ItemType] = value;
      }
    }
  }

  const sources: TopicSource[] = [];
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    collector.error(KB_SCHEMA, subject, "sources must be a non-empty list");
  } else {
    input.sources.forEach((entry, index) => {
      const source = readSource(entry, subject, index, collector);
      if (source !== undefined) sources.push(source);
    });
  }
  if (grew(collector, before)) return undefined;
  return {
    id: id as string,
    name: name as LocalizedText,
    code: code as string,
    grades,
    prerequisites,
    objectives,
    keywords,
    supports,
    sources,
  };
}

function readOptions(
  value: unknown,
  subject: string,
  collector: CheckCollector,
): StaticOption[] | undefined {
  if (!Array.isArray(value)) {
    return fail(collector, KB_SCHEMA, subject, "options must be a list");
  }
  const options: StaticOption[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      return fail(collector, KB_SCHEMA, subject, `options[${index}] must be a mapping`);
    }
    const key = readString(entry.key, subject, `options[${index}].key`, collector, 4);
    const text = readString(entry.text, subject, `options[${index}].text`, collector, 400);
    if (typeof entry.correct !== "boolean") {
      return fail(collector, KB_SCHEMA, subject, `options[${index}].correct must be a boolean`);
    }
    const error = entry.error === undefined ? undefined : String(entry.error);
    if (key === undefined || text === undefined) return undefined;
    options.push({
      key,
      text,
      correct: entry.correct,
      ...(error === undefined ? {} : { error }),
    });
  }
  return options;
}

function readStemArray(
  value: unknown,
  subject: string,
  collector: CheckCollector,
): MarkupLine[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    collector.error(KB_SCHEMA, subject, "stem must be a non-empty list");
    return undefined;
  }
  const out: MarkupLine[] = [];
  value.forEach((entry, index) => {
    if (typeof entry === "string") {
      out.push(entry);
      return;
    }
    if (isRecord(entry) && isRecord(entry.figure) && typeof entry.figure.kind === "string") {
      out.push(entry as unknown as FigureBlock);
      return;
    }
    collector.error(KB_SCHEMA, subject, `stem[${index}] must be text or a figure block`);
  });
  return out.length === value.length ? out : undefined;
}

export function validateStaticItem(
  input: unknown,
  subject: string,
  source: string,
  collector: CheckCollector,
): StaticItem | undefined {
  if (!isRecord(input)) return fail(collector, KB_SCHEMA, subject, "static item must be a mapping");
  const before = collector.results.length;
  const id = readSlug(input.id, subject, "static item id", collector);
  if (typeof input.type !== "string" || !(itemTypes as readonly string[]).includes(input.type)) {
    collector.error(KB_SCHEMA, subject, `static item type must be one of ${itemTypes.join(", ")}`);
  }
  if (typeof input.level !== "string" || !(allLevels as readonly string[]).includes(input.level)) {
    collector.error(KB_SCHEMA, subject, `static item level must be one of ${allLevels.join(", ")}`);
  }
  const stem = readStemArray(input.stem, subject, collector);
  const solution = readStringArray(input.solution, subject, "solution", collector, {
    required: true,
  });
  const answer = input.answer;
  let canonical: string | undefined;
  let display: string | undefined;
  if (!isRecord(answer)) {
    collector.error(KB_SCHEMA, subject, "answer must be a mapping");
  } else {
    canonical = readString(answer.canonical, subject, "answer.canonical", collector, 400);
    display = readString(answer.display, subject, "answer.display", collector, 400);
  }
  let options: StaticOption[] | undefined;
  if (input.options !== undefined) options = readOptions(input.options, subject, collector);
  const check = input.check;
  let checkKind: string | undefined;
  let checkValue: string | undefined;
  if (!isRecord(check)) {
    collector.error(KB_SCHEMA, subject, "check must be a mapping");
  } else {
    checkKind = readString(check.kind, subject, "check.kind", collector, 64);
    checkValue = readString(check.value, subject, "check.value", collector, 400);
  }
  const cognitive = input.cognitive === undefined ? undefined : String(input.cognitive);
  if (grew(collector, before)) return undefined;
  return {
    id: id as string,
    type: input.type as StaticItem["type"],
    level: input.level as StaticItem["level"],
    ...(cognitive === undefined ? {} : { cognitive }),
    stem: stem as string[],
    ...(options === undefined ? {} : { options }),
    answer: { canonical: canonical as string, display: display as string },
    solution: solution as string[],
    check: { kind: checkKind as string, value: checkValue as string },
    source,
  };
}

export type { Severity };
