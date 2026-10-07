import { createHash } from "node:crypto";
import type { Blueprint } from "./blueprint.js";
import {
  type DistractorOption,
  families as familyRegistry,
  type ItemDraft,
} from "./families/index.js";
import type { CheckFinding } from "./knowledge/report.js";
import type { FamilySource, LevelCalibration, LoadedTopic, StaticItem } from "./knowledge/types.js";
import type { MarkupLine } from "./markup.js";
import { createRng } from "./math/rng.js";
import { canonicalJson } from "./storage.js";
import type { Cognitive, ItemType, Level } from "./types.js";
import { checkKeyDistribution, verifyDraft, verifyItem } from "./verify.js";

export interface ExamItem {
  id: string;
  ref: string;
  topic: string;
  family: string | null;
  source: "generator" | "bank" | "authored";
  type: ItemType;
  level: Level;
  cognitive: Cognitive;
  stem: MarkupLine[];
  options: DistractorOption[];
  answer: { canonical: string; display: string };
  solution: string[];
  points: number;
  estimatedSeconds: number;
  check: { kind: string; verifiedBy: string };
}

export const MAX_SLOT_ATTEMPTS = 50;

const KEY_ORDER = ["A", "B", "C", "D"] as const;

/** Relabels options so the correct one carries `targetKey`, then orders A-D (spec 8.4 spread). */
export function spreadOptionKeys(
  options: readonly DistractorOption[],
  targetKey: string,
): DistractorOption[] {
  const correctIndex = options.findIndex((option) => option.correct);
  const targetIndex = KEY_ORDER.indexOf(targetKey as (typeof KEY_ORDER)[number]);
  if (correctIndex < 0 || targetIndex < 0 || options.length <= targetIndex) return [...options];
  const copy = options.map((option) => ({ ...option }));
  const correct = copy[correctIndex];
  const displaced = copy[targetIndex];
  if (correct === undefined || displaced === undefined) return [...options];
  const previousKey = correct.key;
  correct.key = targetKey;
  displaced.key = previousKey;
  return copy.sort(
    (a, b) =>
      KEY_ORDER.indexOf(a.key as (typeof KEY_ORDER)[number]) -
      KEY_ORDER.indexOf(b.key as (typeof KEY_ORDER)[number]),
  );
}

function pointsFor(type: ItemType): number {
  return type === "practice" ? 2 : 1;
}

/** A family draft only supplies choice options for single_choice; open/practice reuse the core. */
function adaptOptions(draft: ItemDraft, type: ItemType): DistractorOption[] | undefined {
  if (type === "multiple_choice") return undefined;
  if (type === "single_choice") return draft.options;
  return [];
}

function refFor(code: string, item: Omit<ExamItem, "ref">, used: Set<string>): string {
  const digest = createHash("sha256").update(canonicalJson(item)).digest("hex").toUpperCase();
  const short = `${code}-${digest.slice(0, 4)}`;
  if (!used.has(short)) return short;
  return `${code}-${digest.slice(0, 6)}`;
}

function dedupeKey(item: ExamItem): string {
  return `${JSON.stringify(item.stem)}\u0001${item.answer.canonical}`;
}

export interface GenerateInput {
  blueprint: Blueprint;
  topics: readonly LoadedTopic[];
  level: Level;
  calibration: LevelCalibration;
  seed: string;
}

export interface GenerateResult {
  items: ExamItem[];
  findings: CheckFinding[];
}

function buildFamilyItem(
  topic: LoadedTopic,
  source: FamilySource,
  cell: { cognitive: Cognitive; type: ItemType },
  draft: ItemDraft,
  options: DistractorOption[],
  calibration: LevelCalibration,
  seedString: string,
): ExamItem {
  const seedHash = createHash("sha256").update(seedString).digest("hex").slice(0, 8);
  const withoutRef: Omit<ExamItem, "ref"> = {
    id: `${topic.fullId}/${source.family}#s=${seedHash}`,
    topic: topic.fullId,
    family: source.family,
    source: "generator",
    type: cell.type,
    level: draft.level,
    cognitive: cell.cognitive,
    stem: draft.stem,
    options,
    answer: draft.answer,
    solution: draft.solution,
    points: pointsFor(cell.type),
    estimatedSeconds: calibration.secondsPerItem,
    check: { kind: "recomputed", verifiedBy: source.family },
  };
  return { ...withoutRef, ref: "" };
}

function buildBankItem(
  topic: LoadedTopic,
  bank: StaticItem,
  cell: { cognitive: Cognitive },
  calibration: LevelCalibration,
): ExamItem {
  const withoutRef: Omit<ExamItem, "ref"> = {
    id: `${topic.fullId}/${bank.id}`,
    topic: topic.fullId,
    family: null,
    source: "bank",
    type: bank.type,
    level: bank.level,
    cognitive:
      bank.cognitive === "recall" || bank.cognitive === "apply" || bank.cognitive === "reason"
        ? bank.cognitive
        : cell.cognitive,
    stem: bank.stem,
    options: (bank.options ?? []).map((option) => ({
      key: option.key,
      value: option.text,
      display: option.text,
      correct: option.correct,
      error: option.error ?? "none",
    })),
    answer: bank.answer,
    solution: bank.solution,
    points: pointsFor(bank.type),
    estimatedSeconds: calibration.secondsPerItem,
    check: { kind: bank.check.kind, verifiedBy: "load-time" },
  };
  return { ...withoutRef, ref: "" };
}

/** Generates and freezes exam items from the blueprint, redrawing failed candidates (spec 8.1). */
export function generateExam(input: GenerateInput): GenerateResult {
  const topicById = new Map(input.topics.map((topic) => [topic.fullId, topic]));
  const items: ExamItem[] = [];
  const findings: CheckFinding[] = [];
  const seen = new Set<string>();
  const usedRefs = new Set<string>();
  const keyOrder = createRng(`${input.seed}|keys`).shuffle([...KEY_ORDER]);
  let keyCursor = 0;

  const place = (item: ExamItem, refCode: string): boolean => {
    const key = dedupeKey(item);
    if (seen.has(key)) return false;
    const ref = refFor(refCode, item, usedRefs);
    if (usedRefs.has(ref)) return false;
    usedRefs.add(ref);
    seen.add(key);
    items.push({ ...item, ref });
    return true;
  };

  for (const cell of input.blueprint.cells) {
    const topic = topicById.get(cell.topic);
    if (topic === undefined) {
      findings.push({
        id: "EVL-ITM-009",
        severity: "error",
        subject: cell.topic,
        message: "blueprint cell names an unknown topic",
      });
      continue;
    }
    const familySources = topic.sources.filter(
      (source): source is FamilySource =>
        source.kind === "family" && source.levels.includes(input.level),
    );
    const bankItems = topic.bankItems.filter(
      (bank) => bank.type === cell.type && bank.level === input.level,
    );
    for (let index = 0; index < cell.count; index += 1) {
      let placed = false;
      for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS && !placed; attempt += 1) {
        const seedString = `${input.seed}|${cell.topic}|${cell.cognitive}|${cell.type}|${index}|${attempt}`;
        for (const source of familySources) {
          const family = familyRegistry[source.family];
          if (family === undefined) continue;
          const rawPrompts = source.params?.prompts;
          const prompts = Array.isArray(rawPrompts)
            ? rawPrompts.filter((entry): entry is string => typeof entry === "string")
            : undefined;
          const draft = family.generate({
            rng: createRng(seedString),
            level: input.level,
            calibration: input.calibration,
            ...(source.params === undefined ? {} : { params: source.params }),
            ...(prompts === undefined || prompts.length === 0 ? {} : { prompts }),
          });
          const options = adaptOptions(draft, cell.type);
          if (options === undefined) continue;
          if (verifyDraft(draft, family, input.level, input.calibration).length > 0) continue;
          let item = buildFamilyItem(
            topic,
            source,
            cell,
            draft,
            options,
            input.calibration,
            seedString,
          );
          if (item.type === "single_choice") {
            item = {
              ...item,
              options: spreadOptionKeys(item.options, keyOrder[keyCursor % keyOrder.length] ?? "A"),
            };
          }
          if (place(item, topic.code)) {
            placed = true;
            if (item.type === "single_choice") keyCursor += 1;
            break;
          }
        }
        if (placed) break;
        if (attempt === 0) {
          for (const bank of bankItems) {
            let item = buildBankItem(topic, bank, cell, input.calibration);
            if (item.type === "single_choice") {
              item = {
                ...item,
                options: spreadOptionKeys(
                  item.options,
                  keyOrder[keyCursor % keyOrder.length] ?? "A",
                ),
              };
            }
            if (verifyItem(item).length > 0) continue;
            if (place(item, topic.code)) {
              placed = true;
              if (item.type === "single_choice") keyCursor += 1;
              break;
            }
          }
        }
      }
      if (!placed) {
        findings.push({
          id: "EVL-ITM-009",
          severity: "error",
          subject: `${cell.topic} ${cell.type}`,
          message: `slot could not be filled within ${MAX_SLOT_ATTEMPTS} attempts`,
        });
      }
    }
  }

  findings.push(...checkKeyDistribution(items));
  return { items, findings };
}
