/** The architecture presets shipped under `presets/architecture/` (spec 14.1). */
export const presetIds = ["feature-sliced", "hexagonal", "layered", "atomic"] as const;
export type PresetId = (typeof presetIds)[number];

export const isPresetId = (value: unknown): value is PresetId =>
  typeof value === "string" && (presetIds as readonly string[]).includes(value);

/**
 * The preset the project layout suggests (spec 14.1): `src/entities` and `src/shared` mean
 * feature-sliced, `src/domain` and `src/application` hexagonal, `components/atoms` atomic,
 * anything else layered.
 */
export function recommendPreset(paths: readonly string[]): PresetId {
  const has = (directory: string): boolean =>
    paths.some((path) => path.startsWith(`${directory}/`) || path.includes(`/${directory}/`));
  if (has("src/entities") && has("src/shared")) return "feature-sliced";
  if (has("src/domain") && has("src/application")) return "hexagonal";
  if (has("components/atoms")) return "atomic";
  return "layered";
}
