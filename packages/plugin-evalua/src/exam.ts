import { parse, stringify } from "yaml";
import type { ExamSpecLike } from "./model.js";
import { isRecord } from "./schemas.js";
import {
  type ClosingKind,
  type ExamDraft,
  type Instrument,
  type ItemType,
  itemTypes,
  type Level,
  levels,
} from "./types.js";

/** `exam.yaml` (spec 5.2): the frozen exam spec, plus the id, number, template and status. */

export type ExamStatus = "draft" | "approved-a" | "built" | "approved-b";

export interface ExamSpec extends Omit<ExamDraft, "status"> {
  id: string;
  number: number;
  template: string;
  status: ExamStatus;
  /** Agent-authored item instructions per family id; `{expr}` is replaced by the item's math. */
  itemPrompts?: Record<string, string[]>;
}

export function fromDraft(
  draft: ExamDraft,
  extra: { id: string; number: number; template?: string },
): ExamSpec {
  return {
    ...draft,
    id: extra.id,
    number: extra.number,
    template: extra.template ?? "classic",
    status: "approved-a",
  };
}

function readItemTypes(value: unknown): Record<ItemType, number> {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    itemTypes.map((type) => [type, Number.isInteger(source[type]) ? (source[type] as number) : 0]),
  ) as Record<ItemType, number>;
}

function readItemPrompts(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [family, templates] of Object.entries(value)) {
    if (
      Array.isArray(templates) &&
      templates.every((entry) => typeof entry === "string" && entry.trim() !== "")
    ) {
      out[family] = templates as string[];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseExam(text: string): ExamSpec {
  const parsed: unknown = parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  if (!isRecord(parsed)) throw new Error("exam.yaml must be a mapping");
  if (typeof parsed.title !== "string" || typeof parsed.theme !== "string") {
    throw new Error("exam.yaml needs a title and a theme");
  }
  if (!Number.isInteger(parsed.questionCount)) throw new Error("exam.yaml needs a questionCount");
  const level = (levels as readonly string[]).includes(String(parsed.level))
    ? (parsed.level as Level)
    : "basico";
  const closing = isRecord(parsed.closing) ? parsed.closing : {};
  return {
    schemaVersion: 1,
    id: typeof parsed.id === "string" ? parsed.id : "e01",
    number: Number.isInteger(parsed.number) ? (parsed.number as number) : 1,
    slug: typeof parsed.slug === "string" ? parsed.slug : "examen",
    title: parsed.title,
    theme: parsed.theme,
    grade: typeof parsed.grade === "string" ? parsed.grade : "",
    level,
    packs: Array.isArray(parsed.packs)
      ? parsed.packs.filter((pack): pack is string => typeof pack === "string")
      : [],
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((topic): topic is string => typeof topic === "string")
      : [],
    topicText: typeof parsed.topicText === "string" ? parsed.topicText : null,
    itemTypes: readItemTypes(parsed.itemTypes),
    questionCount: parsed.questionCount as number,
    distribution: parsed.distribution === "bank" ? "bank" : "same",
    ...(isRecord(parsed.bank)
      ? {
          bank: {
            size: Number(parsed.bank.size) || 0,
            variants: Number(parsed.bank.variants) || 1,
          },
        }
      : {}),
    columns: parsed.columns === 2 ? 2 : 1,
    maxPages: typeof parsed.maxPages === "number" ? parsed.maxPages : "auto",
    durationMinutes: Number.isInteger(parsed.durationMinutes)
      ? (parsed.durationMinutes as number)
      : 120,
    instrument: (["pencil", "pen", "any"] as const).includes(parsed.instrument as Instrument)
      ? (parsed.instrument as Instrument)
      : "any",
    calculator: parsed.calculator === true,
    introOverride: typeof parsed.introOverride === "string" ? parsed.introOverride : null,
    closing: {
      kind: (["quote", "bible"] as readonly string[]).includes(closing.kind as string)
        ? (closing.kind as ClosingKind)
        : "none",
      pinned: typeof closing.pinned === "string" ? closing.pinned : null,
    },
    template: typeof parsed.template === "string" ? parsed.template : "classic",
    ...(readItemPrompts(parsed.itemPrompts) === undefined
      ? {}
      : { itemPrompts: readItemPrompts(parsed.itemPrompts) as Record<string, string[]> }),
    schoolYear: Number.isInteger(parsed.schoolYear)
      ? (parsed.schoolYear as number)
      : new Date().getUTCFullYear(),
    status: (["approved-a", "built", "approved-b"] as readonly string[]).includes(
      parsed.status as string,
    )
      ? (parsed.status as ExamStatus)
      : "draft",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
  };
}

export function stringifyExam(spec: ExamSpec): string {
  return stringify(spec, { lineWidth: 0 });
}

/** The shape the document model and the build need. */
export function toSpecLike(spec: ExamSpec): ExamSpecLike {
  return {
    title: spec.title,
    theme: spec.theme,
    grade: spec.grade,
    questionCount: spec.questionCount,
    itemTypes: spec.itemTypes,
    durationMinutes: spec.durationMinutes,
    instrument: spec.instrument,
    calculator: spec.calculator,
    columns: spec.columns,
    introOverride: spec.introOverride,
    schoolYear: spec.schoolYear,
  };
}
