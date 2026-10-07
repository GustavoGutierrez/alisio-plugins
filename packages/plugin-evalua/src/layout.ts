import { type DensityPreset, densityLadder } from "./layout/presets.js";

/** Deterministic page counting and preset selection (spec 11.1, 11.3, 18.1 P0.1). */

export interface PageCount {
  /** Leaf pages: `/Type /Page` not followed by `s`. Primary count. */
  leafPages: number;
  /** Maximum `/Count` in the page tree. Cross-check. */
  maxCount: number;
  agreement: boolean;
}

export function countPdfPages(bytes: Uint8Array): PageCount {
  const text = Buffer.from(bytes).toString("latin1");
  const leafPages = (text.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
  return { leafPages, maxCount, agreement: maxCount === 0 || maxCount === leafPages };
}

export interface FitInput {
  /** Preset id -> measured page count. */
  pageCounts: ReadonlyMap<string, number>;
  maxPages: "auto" | number;
  ladder?: readonly DensityPreset[];
}

export interface FitFailure {
  smallestReached: number;
  options: string[];
}

export interface FitResult {
  preset?: DensityPreset;
  pages?: number;
  failure?: FitFailure;
}

/** Chooses the most comfortable preset meeting the budget, or the failure report (spec 11.1). */
export function choosePreset(input: FitInput): FitResult {
  const ladder = input.ladder ?? densityLadder;
  const measured = ladder
    .map((preset) => ({ preset, pages: input.pageCounts.get(preset.id) }))
    .filter(
      (entry): entry is { preset: DensityPreset; pages: number } => entry.pages !== undefined,
    );
  if (measured.length === 0) {
    return { failure: { smallestReached: 0, options: ["no preset was measured"] } };
  }
  if (input.maxPages === "auto") {
    const minimum = Math.min(...measured.map((entry) => entry.pages));
    const best = measured.find((entry) => entry.pages === minimum);
    return best === undefined
      ? { failure: { smallestReached: 0, options: [] } }
      : { preset: best.preset, pages: best.pages };
  }
  const budget: number = input.maxPages;
  const within = measured.filter((entry) => entry.pages <= budget);
  const best = within[0];
  if (best !== undefined) return { preset: best.preset, pages: best.pages };
  const smallestReached = Math.min(...measured.map((entry) => entry.pages));
  return {
    failure: {
      smallestReached,
      options: [
        "use fewer items",
        `allow at least ${smallestReached} pages`,
        "switch to one column",
        "reduce the practice answer space",
      ],
    },
  };
}

export interface LayoutReport {
  schemaVersion: 1;
  preset: string;
  pages: number;
  pagesPerPreset: Record<string, number>;
  engineVersion: string;
  maxPages: "auto" | number;
}

export function buildLayoutReport(input: {
  chosen: FitResult;
  pageCounts: ReadonlyMap<string, number>;
  engineVersion: string;
  maxPages: "auto" | number;
}): LayoutReport | undefined {
  if (input.chosen.preset === undefined || input.chosen.pages === undefined) return undefined;
  return {
    schemaVersion: 1,
    preset: input.chosen.preset.id,
    pages: input.chosen.pages,
    pagesPerPreset: Object.fromEntries(input.pageCounts),
    engineVersion: input.engineVersion,
    maxPages: input.maxPages,
  };
}
