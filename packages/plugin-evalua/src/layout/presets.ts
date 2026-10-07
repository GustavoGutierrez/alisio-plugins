/** The deterministic density ladder and its legibility floors (spec 11.2). */

export type HeaderStyle = "full" | "tight" | "tight2rows";

export interface DensityPreset {
  id: string;
  bodyPt: number;
  lineHeight: number;
  marginsMm: number;
  itemGapMm: number;
  /** Answer-space fraction for `practice` items, relative to the comfortable size. */
  practiceSpace: number;
  header: HeaderStyle;
}

export const densityLadder: readonly DensityPreset[] = [
  {
    id: "comfortable",
    bodyPt: 11,
    lineHeight: 1.45,
    marginsMm: 20,
    itemGapMm: 7,
    practiceSpace: 1,
    header: "full",
  },
  {
    id: "regular",
    bodyPt: 10.5,
    lineHeight: 1.35,
    marginsMm: 16,
    itemGapMm: 5,
    practiceSpace: 0.8,
    header: "full",
  },
  {
    id: "compact",
    bodyPt: 10,
    lineHeight: 1.25,
    marginsMm: 13,
    itemGapMm: 3.5,
    practiceSpace: 0.6,
    header: "tight",
  },
  {
    id: "tight",
    bodyPt: 9.5,
    lineHeight: 1.18,
    marginsMm: 11,
    itemGapMm: 2.5,
    practiceSpace: 0.45,
    header: "tight",
  },
  {
    id: "minimum",
    bodyPt: 9,
    lineHeight: 1.15,
    marginsMm: 10,
    itemGapMm: 2,
    practiceSpace: 0.35,
    header: "tight2rows",
  },
];

/** Floors the fitter never crosses (spec 11.2). */
export const legibilityFloors = {
  bodyPt: 9,
  lineHeight: 1.15,
  marginsMm: 10,
  mathScale: 0.85,
} as const;

export function presetById(id: string): DensityPreset | undefined {
  return densityLadder.find((preset) => preset.id === id);
}

export function withinFloors(preset: DensityPreset): boolean {
  return (
    preset.bodyPt >= legibilityFloors.bodyPt &&
    preset.lineHeight >= legibilityFloors.lineHeight &&
    preset.marginsMm >= legibilityFloors.marginsMm
  );
}
