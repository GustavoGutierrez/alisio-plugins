import type { MarkupLine } from "../markup.js";
import type { ItemType, Level } from "../types.js";

export type Layer = "shipped" | "workspace";

export type LocalizedText = Record<string, string>;

export interface CognitiveMix {
  recall: number;
  apply: number;
  reason: number;
}

/** Level calibration shared by a pack's topics (spec 6.3). */
export interface LevelCalibration {
  steps: [number, number];
  coefficientRange: [number, number];
  cognitiveMix: CognitiveMix;
  secondsPerItem: number;
}

export interface FamilySource {
  kind: "family";
  family: string;
  levels: Level[];
  params?: Record<string, unknown>;
}

export interface BankSource {
  kind: "bank";
  file: string;
}

export type TopicSource = FamilySource | BankSource;

export interface TopicObjective {
  id: string;
  text: LocalizedText;
  levels: Level[];
}

export interface Topic {
  id: string;
  name: LocalizedText;
  code: string;
  grades: string[];
  prerequisites: string[];
  objectives: TopicObjective[];
  keywords: string[];
  supports: Record<ItemType, boolean>;
  sources: TopicSource[];
}

export interface PackMeta {
  schemaVersion: number;
  id: string;
  version: number;
  name: LocalizedText;
  code: string;
  requires: string[];
  extends: string | null;
  overrides: boolean;
  levels: Record<Level, LevelCalibration>;
}

export interface StaticOption {
  key: string;
  text: string;
  correct: boolean;
  error?: string;
}

export interface StaticItem {
  id: string;
  type: ItemType;
  level: Level;
  cognitive?: string;
  stem: MarkupLine[];
  options?: StaticOption[];
  answer: { canonical: string; display: string };
  solution: string[];
  check: { kind: string; value: string };
  /** Pack-relative path of the bank file the item came from. */
  source: string;
}

export interface LoadedTopic extends Topic {
  packId: string;
  fullId: string;
  dir: string;
  bankItems: StaticItem[];
}

export interface LoadedPack extends PackMeta {
  layer: Layer;
  dir: string;
  topics: LoadedTopic[];
}

export interface LoadedKnowledge {
  packs: LoadedPack[];
  topics: LoadedTopic[];
  report: import("./report.js").CheckReport;
}

/** The first available text for a language, falling back to `es` then any entry. */
export function localized(text: LocalizedText, language = "es"): string {
  const direct = text[language];
  if (direct !== undefined) return direct;
  const fallback = text.es;
  if (fallback !== undefined) return fallback;
  const first = Object.values(text)[0];
  return first ?? "";
}
