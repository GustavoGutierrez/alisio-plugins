import type { IllustrationAsset } from "./assets.js";
import { CardsmithError, type CardsmithErrorCode } from "./errors.js";
import type { Palette } from "./palettes.js";
import type { QrEcc } from "./qr.js";
import type { Template } from "./registry.js";
import type { SizePreset } from "./sizes.js";
import { defaultSizeForFamily, SIZE_PRESETS } from "./sizes.js";
import type { FontPair } from "./typography.js";

export type Family = "social" | "personalized" | "composite" | "chart" | "dynamic";
export type DesignFormat = "png" | "jpeg";
export type DesignLocale = "es" | "en";

export const FAMILIES: readonly Family[] = [
  "social",
  "personalized",
  "composite",
  "chart",
  "dynamic",
];

export interface DesignSpecImage {
  id: string;
  path: string;
  role?: string;
}

export interface DesignSpecQr {
  payload: string;
  ecc?: QrEcc;
}

export interface DesignSpecInput {
  family: Family;
  templateId: string;
  sizeId?: string;
  paletteId?: string;
  fontPairId?: string;
  content: Record<string, unknown>;
  illustrationId?: string;
  images?: DesignSpecImage[];
  qr?: DesignSpecQr;
  seed?: number;
  format?: DesignFormat;
  locale?: DesignLocale;
  date?: string;
}

export interface NormalizedSpec {
  family: Family;
  templateId: string;
  sizeId: string;
  paletteId: string;
  fontPairId: string;
  content: Record<string, unknown>;
  illustrationId?: string;
  images: DesignSpecImage[];
  qr?: DesignSpecQr;
  seed?: number;
  format: DesignFormat;
  locale: DesignLocale;
  date?: string;
}

export interface SpecError {
  code: CardsmithErrorCode;
  field?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type NormalizeResult =
  | { ok: true; spec: NormalizedSpec; warnings: string[] }
  | { ok: false; errors: SpecError[] };

/** Minimal resource surface `normalizeSpec` needs; `Registry` satisfies it structurally. */
export interface SpecResourceResolver {
  template(id: string): Template;
  palette(id: string): Palette;
  fontPair(id: string): FontPair;
  size(id: string): SizePreset;
  illustration(id: string): IllustrationAsset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorWith(
  code: CardsmithErrorCode,
  field: string,
  message: string,
  details?: Record<string, unknown>,
): SpecError {
  const error: SpecError = { code, field, message };
  if (details !== undefined) error.details = details;
  return error;
}

function fromThrown(thrown: unknown, field: string, fallback: CardsmithErrorCode): SpecError {
  if (thrown instanceof CardsmithError) {
    const error: SpecError = { code: thrown.code, field, message: thrown.message };
    if (thrown.details !== undefined) error.details = thrown.details;
    return error;
  }
  return {
    code: fallback,
    field,
    message: thrown instanceof Error ? thrown.message : String(thrown),
  };
}

function compatibleSizeIds(template: Template): string[] {
  const orientations = new Set(Object.keys(template.layouts));
  return SIZE_PRESETS.filter((preset) => orientations.has(preset.orientation)).map(
    (preset) => preset.id,
  );
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1] ?? "0");
  const month = Number(match[2] ?? "0");
  const day = Number(match[3] ?? "0");
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysPerMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysPerMonth[month - 1] ?? 0);
}

/**
 * `series` accepts the flat numeric shape (one unnamed series) and the rich chart shape
 * `{ label?: string; values: (number | null)[] }[]`. `null` marks a missing point. Mixed arrays
 * and malformed entries are rejected; semantic rules (category length, donut positivity) stay in
 * the chart generator.
 */
function isSeriesValue(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return true;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (record.label !== undefined && typeof record.label !== "string") return false;
    const values = record.values;
    return (
      Array.isArray(values) &&
      values.every((item) => item === null || (typeof item === "number" && Number.isFinite(item)))
    );
  });
}

function validateFieldValue(field: Template["fields"][number], value: unknown): SpecError[] {
  const fieldPath = `content.${field.key}`;
  const errors: SpecError[] = [];
  const checkMaxChars = (text: string, path: string): void => {
    if (field.maxChars !== undefined && [...text].length > field.maxChars) {
      errors.push(
        errorWith(
          "INVALID_SPEC",
          path,
          `field "${field.key}" allows at most ${field.maxChars} characters`,
          { maxChars: field.maxChars, length: [...text].length },
        ),
      );
    }
  };
  switch (field.type) {
    case "text":
      if (typeof value !== "string") {
        errors.push(errorWith("INVALID_SPEC", fieldPath, `field "${field.key}" must be a string`));
      } else {
        checkMaxChars(value, fieldPath);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(
          errorWith("INVALID_SPEC", fieldPath, `field "${field.key}" must be a finite number`),
        );
      }
      break;
    case "string[]":
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        errors.push(
          errorWith("INVALID_SPEC", fieldPath, `field "${field.key}" must be an array of strings`),
        );
      } else {
        for (const [index, entry] of value.entries()) {
          checkMaxChars(entry as string, `${fieldPath}[${index}]`);
        }
      }
      break;
    case "series":
      if (!isSeriesValue(value)) {
        errors.push(
          errorWith(
            "INVALID_SPEC",
            fieldPath,
            `field "${field.key}" must be an array of numbers or of { label?, values } entries with finite numbers or null`,
          ),
        );
      }
      break;
  }
  return errors;
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === "";
}

/**
 * Validate and normalize a design spec against the registry.
 *
 * Rules: the template must exist and match `family`; `sizeId` defaults per family and must have a
 * layout; `paletteId`/`fontPairId` default to the template defaults; `content` is validated field
 * by field (required, type, maxChars) and unknown keys are rejected; `qr`/`images` require the
 * matching `supports` flag; `seed` must be a finite integer; `date` must be `YYYY-MM-DD`;
 * `format` and `locale` default to `png`/`es`.
 */
export function normalizeSpec(
  input: DesignSpecInput,
  registry: SpecResourceResolver,
): NormalizeResult {
  const raw: unknown = input;
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [{ code: "INVALID_SPEC", message: "Design spec must be a JSON object" }],
    };
  }

  const errors: SpecError[] = [];
  const warnings: string[] = [];

  const family = raw.family;
  if (typeof family !== "string" || !(FAMILIES as readonly string[]).includes(family)) {
    errors.push(
      errorWith("INVALID_SPEC", "family", `family must be one of ${FAMILIES.join(", ")}`),
    );
  }
  const templateId = raw.templateId;
  if (typeof templateId !== "string" || templateId.length === 0) {
    errors.push(errorWith("INVALID_SPEC", "templateId", "templateId must be a non-empty string"));
  }
  if (errors.length > 0) return { ok: false, errors };

  let template: Template;
  try {
    template = registry.template(templateId as string);
  } catch (thrown) {
    return { ok: false, errors: [fromThrown(thrown, "templateId", "UNKNOWN_TEMPLATE")] };
  }

  if (family !== template.family) {
    errors.push(
      errorWith(
        "INVALID_SPEC",
        "family",
        `template "${template.id}" belongs to family "${template.family}", not "${String(family)}"`,
      ),
    );
  }

  let sizeId = raw.sizeId;
  if (sizeId === undefined) {
    const familyDefault = defaultSizeForFamily(template.family);
    const familyPreset = SIZE_PRESETS.find((preset) => preset.id === familyDefault);
    if (familyPreset !== undefined && template.layouts[familyPreset.orientation] !== undefined) {
      sizeId = familyDefault;
      warnings.push(`sizeId defaulted to "${sizeId}" for family "${template.family}"`);
    } else {
      const fallback = compatibleSizeIds(template)[0];
      if (fallback === undefined) {
        errors.push(
          errorWith(
            "INCOMPATIBLE_SIZE",
            "sizeId",
            `template "${template.id}" has no compatible size preset`,
            { alternatives: [] },
          ),
        );
      } else {
        sizeId = fallback;
        warnings.push(
          `sizeId defaulted to "${sizeId}"; family default "${familyDefault}" has no compatible layout`,
        );
      }
    }
  } else if (typeof sizeId !== "string" || sizeId.length === 0) {
    errors.push(errorWith("INVALID_SPEC", "sizeId", "sizeId must be a non-empty string"));
    sizeId = undefined;
  }
  if (typeof sizeId === "string") {
    try {
      const preset = registry.size(sizeId);
      if (template.layouts[preset.orientation] === undefined) {
        const alternatives = compatibleSizeIds(template);
        errors.push(
          errorWith(
            "INCOMPATIBLE_SIZE",
            "sizeId",
            `template "${template.id}" has no ${preset.orientation} layout; compatible sizes: ${alternatives.join(", ")}`,
            { alternatives },
          ),
        );
      }
    } catch (thrown) {
      errors.push(fromThrown(thrown, "sizeId", "UNKNOWN_SIZE"));
    }
  }

  let paletteId = raw.paletteId;
  if (paletteId === undefined) {
    paletteId = template.defaultPalette;
    warnings.push(`paletteId defaulted to "${paletteId}"`);
  }
  if (typeof paletteId !== "string" || paletteId.length === 0) {
    errors.push(errorWith("INVALID_SPEC", "paletteId", "paletteId must be a non-empty string"));
  } else {
    try {
      registry.palette(paletteId);
    } catch (thrown) {
      errors.push(fromThrown(thrown, "paletteId", "UNKNOWN_PALETTE"));
    }
  }

  let fontPairId = raw.fontPairId;
  if (fontPairId === undefined) {
    fontPairId = template.defaultFontPair;
    warnings.push(`fontPairId defaulted to "${fontPairId}"`);
  }
  if (typeof fontPairId !== "string" || fontPairId.length === 0) {
    errors.push(errorWith("INVALID_SPEC", "fontPairId", "fontPairId must be a non-empty string"));
  } else {
    try {
      registry.fontPair(fontPairId);
    } catch (thrown) {
      errors.push(fromThrown(thrown, "fontPairId", "UNKNOWN_FONT_PAIR"));
    }
  }

  const contentRecord = raw.content;
  const content: Record<string, unknown> = {};
  if (!isRecord(contentRecord)) {
    errors.push(errorWith("INVALID_SPEC", "content", "content must be a JSON object"));
  } else {
    const fields = new Map(template.fields.map((field) => [field.key, field]));
    for (const [key, value] of Object.entries(contentRecord)) {
      const field = fields.get(key);
      if (field === undefined) {
        errors.push(
          errorWith(
            "INVALID_SPEC",
            `content.${key}`,
            `unknown field "${key}" for template "${template.id}"`,
          ),
        );
        continue;
      }
      const fieldErrors = validateFieldValue(field, value);
      errors.push(...fieldErrors);
      if (fieldErrors.length === 0) content[key] = value;
    }
    for (const field of template.fields) {
      if (field.required === true && isMissingValue(contentRecord[field.key])) {
        errors.push(
          errorWith(
            "INVALID_SPEC",
            `content.${field.key}`,
            `required field "${field.key}" is missing`,
          ),
        );
      }
    }
  }

  let illustrationId: string | undefined;
  if (raw.illustrationId !== undefined) {
    if (typeof raw.illustrationId !== "string" || raw.illustrationId.length === 0) {
      errors.push(
        errorWith("INVALID_SPEC", "illustrationId", "illustrationId must be a non-empty string"),
      );
    } else {
      illustrationId = raw.illustrationId;
      if (!template.supports.illustration) {
        errors.push(
          errorWith(
            "INVALID_SPEC",
            "illustrationId",
            `template "${template.id}" does not support illustrations`,
          ),
        );
      } else {
        try {
          registry.illustration(illustrationId);
        } catch (thrown) {
          errors.push(fromThrown(thrown, "illustrationId", "UNKNOWN_ILLUSTRATION"));
        }
      }
    }
  }

  const images: DesignSpecImage[] = [];
  if (raw.images !== undefined) {
    if (!template.supports.images) {
      errors.push(
        errorWith(
          "INVALID_SPEC",
          "images",
          `template "${template.id}" does not support input images`,
        ),
      );
    }
    if (!Array.isArray(raw.images)) {
      errors.push(errorWith("INVALID_SPEC", "images", "images must be an array"));
    } else {
      const seenIds = new Set<string>();
      raw.images.forEach((entry, index) => {
        const path = `images[${index}]`;
        if (!isRecord(entry)) {
          errors.push(errorWith("INVALID_SPEC", path, `${path} must be an object`));
          return;
        }
        const id = entry.id;
        const file = entry.path;
        if (typeof id !== "string" || id.length === 0) {
          errors.push(
            errorWith("INVALID_SPEC", `${path}.id`, `${path}.id must be a non-empty string`),
          );
        } else if (seenIds.has(id)) {
          errors.push(errorWith("INVALID_SPEC", `${path}.id`, `duplicate image id "${id}"`));
        } else {
          seenIds.add(id);
        }
        if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
          errors.push(
            errorWith("INVALID_SPEC", `${path}.path`, `${path}.path must be a non-empty string`),
          );
        }
        if (entry.role !== undefined && typeof entry.role !== "string") {
          errors.push(errorWith("INVALID_SPEC", `${path}.role`, `${path}.role must be a string`));
        }
        if (
          typeof id === "string" &&
          id.length > 0 &&
          typeof file === "string" &&
          file.length > 0
        ) {
          const image: DesignSpecImage = { id, path: file };
          if (typeof entry.role === "string") image.role = entry.role;
          images.push(image);
        }
      });
    }
  }

  let qr: DesignSpecQr | undefined;
  if (raw.qr !== undefined) {
    if (!template.supports.qr) {
      errors.push(
        errorWith("INVALID_SPEC", "qr", `template "${template.id}" does not support QR codes`),
      );
    }
    if (!isRecord(raw.qr)) {
      errors.push(errorWith("INVALID_SPEC", "qr", "qr must be an object"));
    } else {
      const payload = raw.qr.payload;
      if (typeof payload !== "string" || payload.length === 0) {
        errors.push(
          errorWith("INVALID_SPEC", "qr.payload", "qr.payload must be a non-empty string"),
        );
      }
      let ecc: QrEcc | undefined;
      if (raw.qr.ecc !== undefined) {
        if (raw.qr.ecc !== "M" && raw.qr.ecc !== "Q") {
          errors.push(errorWith("INVALID_SPEC", "qr.ecc", 'qr.ecc must be "M" or "Q"'));
        } else {
          ecc = raw.qr.ecc;
        }
      }
      if (typeof payload === "string" && payload.length > 0) {
        qr = { payload };
        if (ecc !== undefined) qr.ecc = ecc;
      }
    }
  }

  let seed: number | undefined;
  if (raw.seed !== undefined) {
    if (typeof raw.seed !== "number" || !Number.isInteger(raw.seed) || !Number.isFinite(raw.seed)) {
      errors.push(errorWith("INVALID_SPEC", "seed", "seed must be a finite integer"));
    } else {
      seed = raw.seed;
    }
  }

  let date: string | undefined;
  if (raw.date !== undefined) {
    if (typeof raw.date !== "string" || !isCalendarDate(raw.date)) {
      errors.push(errorWith("INVALID_SPEC", "date", "date must be a valid YYYY-MM-DD date"));
    } else {
      date = raw.date;
    }
  }

  const format = raw.format ?? "png";
  if (format !== "png" && format !== "jpeg") {
    errors.push(errorWith("INVALID_SPEC", "format", 'format must be "png" or "jpeg"'));
  }
  const locale = raw.locale ?? "es";
  if (locale !== "es" && locale !== "en") {
    errors.push(errorWith("INVALID_SPEC", "locale", 'locale must be "es" or "en"'));
  }

  if (errors.length > 0) return { ok: false, errors };

  const spec: NormalizedSpec = {
    family: family as Family,
    templateId: templateId as string,
    sizeId: sizeId as string,
    paletteId: paletteId as string,
    fontPairId: fontPairId as string,
    content,
    images,
    format: format as DesignFormat,
    locale: locale as DesignLocale,
  };
  if (illustrationId !== undefined) spec.illustrationId = illustrationId;
  if (qr !== undefined) spec.qr = qr;
  if (seed !== undefined) spec.seed = seed;
  if (date !== undefined) spec.date = date;
  return { ok: true, spec, warnings };
}
