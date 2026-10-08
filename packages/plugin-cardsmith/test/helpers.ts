import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DesignSpecInput,
  type NormalizedSpec,
  normalizeSpec,
} from "../src/core/design-spec.js";
import { CardsmithError } from "../src/core/errors.js";
import {
  createRegistry,
  type FieldSpec,
  type Registry,
  type RegistryOptions,
  type Template,
} from "../src/core/registry.js";
import { defaultSizeForFamily, SIZE_PRESETS } from "../src/core/sizes.js";
import type { TextMeasurer } from "../src/core/typography.js";
import { packagePath } from "../src/resource-paths.js";

/** Deterministic measurer: width = chars * sizePx * 0.55, ascent 0.8, descent 0.2. */
export const fakeMeasurer: TextMeasurer = {
  measure(text, _font, sizePx) {
    return {
      width: text.length * sizePx * 0.55,
      ascent: sizePx * 0.8,
      descent: sizePx * 0.2,
    };
  },
};

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cardsmith-${prefix}-`));
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface FixtureRegistryOptions {
  templates?: Array<Record<string, unknown>>;
  palettes?: Array<Record<string, unknown>>;
  illustrations?: Array<Record<string, unknown>>;
  fontPairs?: Array<Record<string, unknown>>;
}

/**
 * Registry over temporary fixture directories. Unspecified resources fall back to the packaged
 * ones, so fixtures only need to declare what a test is actually exercising.
 */
export async function makeFixtureRegistry(options: FixtureRegistryOptions = {}): Promise<Registry> {
  const root = await tempDir("fixtures");
  const templatesDir = join(root, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const template of options.templates ?? []) {
    await writeJsonFile(join(templatesDir, String(template.id), "template.json"), template);
  }

  let palettesDir = packagePath("resources/palettes");
  if (options.palettes !== undefined) {
    palettesDir = join(root, "palettes");
    for (const [index, palette] of options.palettes.entries()) {
      await writeJsonFile(join(palettesDir, `palette-${index}.json`), palette);
    }
  }

  let illustrationsDir = packagePath("resources/illustrations");
  if (options.illustrations !== undefined) {
    illustrationsDir = join(root, "illustrations");
    for (const [index, illustration] of options.illustrations.entries()) {
      await writeJsonFile(join(illustrationsDir, `illustration-${index}.json`), illustration);
    }
  }

  let fontPairsFile = packagePath("resources/font-pairs.json");
  if (options.fontPairs !== undefined) {
    fontPairsFile = join(root, "font-pairs.json");
    await writeJsonFile(fontPairsFile, options.fontPairs);
  }

  const registryOptions: RegistryOptions = {
    templatesDir,
    palettesDir,
    illustrationsDir,
    fontPairsFile,
  };
  return createRegistry(registryOptions);
}

/** Capture a thrown CardsmithError, failing the test when nothing (or something else) is thrown. */
export function captureError(fn: () => unknown): CardsmithError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CardsmithError) return error;
    throw error;
  }
  throw new Error("Expected the function to throw a CardsmithError");
}

/** Async variant of {@link captureError} for rejected promises. */
export async function captureAsyncError(fn: () => Promise<unknown>): Promise<CardsmithError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof CardsmithError) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject with a CardsmithError");
}

/** Registry over the packaged resources: templates, palettes, illustrations and font pairs. */
export function packagedRegistry(): Registry {
  const options: RegistryOptions = {
    templatesDir: packagePath("resources/templates"),
    palettesDir: packagePath("resources/palettes"),
    illustrationsDir: packagePath("resources/illustrations"),
    fontPairsFile: packagePath("resources/font-pairs.json"),
  };
  return createRegistry(options);
}

/** Sample value for a template field, derived from its declared type. */
export function sampleFieldValue(field: FieldSpec): unknown {
  switch (field.type) {
    case "number":
      return 7;
    case "string[]":
      return ["Alpha | 1200"];
    case "series":
      return [1, 2, 3];
    default:
      return "Sample";
  }
}

/** Minimal content built only from the template's required fields; never hand-copied. */
export function minimalContent(template: Template): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of template.fields) {
    if (field.required === true) content[field.key] = sampleFieldValue(field);
  }
  return content;
}

/** Image ids declared by any image slot of the template, in declaration order. */
export function templateImageIds(template: Template): string[] {
  const ids = new Set<string>();
  for (const layout of Object.values(template.layouts)) {
    for (const slot of layout?.imageSlots ?? []) ids.add(slot.key);
  }
  return [...ids];
}

function defaultSizeIdFor(template: Template): string {
  const familyDefault = defaultSizeForFamily(template.family);
  const familyPreset = SIZE_PRESETS.find((preset) => preset.id === familyDefault);
  if (familyPreset !== undefined && template.layouts[familyPreset.orientation] !== undefined) {
    return familyDefault;
  }
  const fallback = SIZE_PRESETS.find(
    (preset) => template.layouts[preset.orientation] !== undefined,
  );
  if (fallback === undefined) {
    throw new Error(`Template "${template.id}" has no compatible size preset`);
  }
  return fallback.id;
}

/**
 * Hand-built normalized spec for tests that must bypass `normalizeSpec` limits, such as a
 * 400-character certificate name. Mirrors the shape `normalizeSpec` would return for the input.
 */
export function rawSpec(
  registry: Registry,
  templateId: string,
  content: Record<string, unknown>,
  overrides: Partial<NormalizedSpec> = {},
): NormalizedSpec {
  const template = registry.template(templateId);
  const spec: NormalizedSpec = {
    family: template.family,
    templateId,
    sizeId: overrides.sizeId ?? defaultSizeIdFor(template),
    paletteId: overrides.paletteId ?? template.defaultPalette,
    fontPairId: overrides.fontPairId ?? template.defaultFontPair,
    content: overrides.content ?? content,
    images: overrides.images ?? [],
    format: overrides.format ?? "png",
    locale: overrides.locale ?? "es",
  };
  if (overrides.illustrationId !== undefined) spec.illustrationId = overrides.illustrationId;
  if (overrides.qr !== undefined) spec.qr = overrides.qr;
  if (overrides.seed !== undefined) spec.seed = overrides.seed;
  if (overrides.date !== undefined) spec.date = overrides.date;
  return spec;
}

/**
 * Valid normalized spec built from a packaged template: minimal required content unless content
 * is given, and one declared image per image slot when the template supports images. Throws with
 * the normalizeSpec errors when the input is invalid (tests that expect failure call normalizeSpec
 * directly instead).
 */
export function normalizedSpecFor(
  registry: Registry,
  templateId: string,
  content?: Record<string, unknown>,
  extra: Partial<DesignSpecInput> = {},
): NormalizedSpec {
  const template = registry.template(templateId);
  const input: DesignSpecInput = {
    family: template.family,
    templateId,
    content: content ?? minimalContent(template),
    ...extra,
  };
  if (extra.images === undefined && template.supports.images) {
    input.images = templateImageIds(template).map((id) => ({ id, path: `test://${id}.png` }));
  }
  const result = normalizeSpec(input, registry);
  if (!result.ok) throw new Error(`${templateId}: ${JSON.stringify(result.errors)}`);
  return result.spec;
}
