import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AssetOp,
  ILLUSTRATION_TAGS,
  type IllustrationAsset,
  type IllustrationTag,
} from "./assets.js";
import type { DesignFormat, Family } from "./design-spec.js";
import { CardsmithError } from "./errors.js";
import {
  isHexColor,
  isPaletteTokenName,
  type LocalizedLabel,
  type Palette,
  type PaletteTokens,
  validatePalette,
} from "./palettes.js";
import { SIZE_PRESETS, type SizePreset } from "./sizes.js";
import { FONT_PAIR_ROLES, type FontPair, type FontPairRole } from "./typography.js";

export type LayoutKey = "square" | "portrait" | "landscape";
export type FieldType = "text" | "number" | "string[]" | "series";
export type SlotRole = FontPairRole;
export type TextAlign = "left" | "center" | "right";
export type TextVAlign = "top" | "middle" | "bottom";

/** Fractions of the content frame, in [0, 1]. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FieldSpec {
  key: string;
  type: FieldType;
  required?: boolean;
  maxChars?: number;
  overflow?: "error" | "warn";
  label?: LocalizedLabel;
}

export interface SlotCurve {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  side: "outside" | "inside";
}

export interface SlotSpec {
  key: string;
  role: SlotRole;
  box: Box;
  color?: string;
  align?: TextAlign;
  valign?: TextVAlign;
  maxLines?: number;
  maxSizePct?: number;
  size?: number;
  curve?: SlotCurve;
  lineHeightRatio?: number;
}

export interface DecorSpec {
  assetId: string;
  box: Box;
}

export type ImageFit = "cover" | "contain";
export type ImageRound = "none" | "circle";

/**
 * Named image placement for composite, dynamic and personalized templates. `key` matches the
 * `id` of the `DesignSpecImage` the layout consumes; templates that declare image slots must set
 * `supports.images = true`.
 */
export interface ImageSlotSpec {
  key: string;
  box: Box;
  fit?: ImageFit;
  round?: ImageRound;
}

export interface TemplateLayout {
  background?: string;
  decor?: DecorSpec[];
  slots: SlotSpec[];
  illustration?: { box: Box; defaultId?: string };
  /** Chart / structured content area; generators draw series, axes or structured rows inside it. */
  plot?: Box;
  imageSlots?: ImageSlotSpec[];
  qr?: { box: Box };
}

export interface TemplateSupports {
  qr: boolean;
  illustration: boolean;
  images: boolean;
}

export interface Template {
  id: string;
  version: number;
  family: Family;
  label: LocalizedLabel;
  description?: LocalizedLabel;
  layouts: Partial<Record<LayoutKey, TemplateLayout>>;
  fields: FieldSpec[];
  defaultPalette: string;
  defaultFontPair: string;
  supports: TemplateSupports;
  accentIllustrations?: string[];
}

export interface CatalogTemplateEntry {
  id: string;
  family: Family;
  label: LocalizedLabel;
  sizes: string[];
  requiredFields: string[];
  supports: TemplateSupports;
  /** Layout default illustration, when the template declares one. */
  defaultIllustration?: string;
  /** Curated accent illustrations declared by the template; may be empty. */
  accentIllustrations: string[];
}

export interface CatalogIllustrationEntry {
  id: string;
  label: LocalizedLabel;
  tags: IllustrationTag[];
}

export interface Catalog {
  templates: CatalogTemplateEntry[];
  palettes: { id: string; label: LocalizedLabel }[];
  fontPairs: { id: string; label: LocalizedLabel }[];
  illustrations: CatalogIllustrationEntry[];
  sizes: {
    id: string;
    width: number;
    height: number;
    orientation: string;
    label: LocalizedLabel;
  }[];
  formats: DesignFormat[];
}

export interface RegistryOptions {
  templatesDir: string;
  palettesDir: string;
  illustrationsDir: string;
  fontPairsFile: string;
}

export interface Registry {
  palette(id: string): Palette;
  template(id: string): Template;
  fontPair(id: string): FontPair;
  illustration(id: string): IllustrationAsset;
  size(id: string): SizePreset;
  catalog(): Catalog;
}

const LAYOUT_KEYS: readonly LayoutKey[] = ["square", "portrait", "landscape"];
const FIELD_TYPES: readonly FieldType[] = ["text", "number", "string[]", "series"];
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const FONT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ttf$/;
const WEIGHTS = [400, 600, 700];

function fail(message: string, details?: Record<string, unknown>): never {
  throw new CardsmithError("INVALID_SPEC", message, details);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`, { path });
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`${path} must be a non-empty string`, { path });
  }
  return value;
}

function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`, { path });
  }
  return value;
}

function asPositiveInteger(value: unknown, path: string): number {
  const parsed = asFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${path} must be a positive integer`, { path });
  }
  return parsed;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`, { path });
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`, { path });
  return value;
}

function asLabel(value: unknown, path: string): LocalizedLabel {
  const record = asRecord(value, path);
  return {
    es: asString(record.es, `${path}.es`),
    en: asString(record.en, `${path}.en`),
  };
}

function asBox(value: unknown, path: string): Box {
  const record = asRecord(value, path);
  const box: Box = {
    x: asFiniteNumber(record.x, `${path}.x`),
    y: asFiniteNumber(record.y, `${path}.y`),
    w: asFiniteNumber(record.w, `${path}.w`),
    h: asFiniteNumber(record.h, `${path}.h`),
  };
  const tolerance = 1e-6;
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.w <= 0 ||
    box.h <= 0 ||
    box.x + box.w > 1 + tolerance ||
    box.y + box.h > 1 + tolerance
  ) {
    fail(`${path} must be a sub-rectangle of the unit square`, { path, box });
  }
  return box;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path} has unknown key "${key}"`, { path, key });
  }
}

function asColorToken(value: unknown, path: string): string {
  const token = asString(value, path);
  if (!token.startsWith("$") || !isPaletteTokenName(token.slice(1))) {
    fail(`${path} must be a palette token such as "$text"`, { path, token });
  }
  return token;
}

function asHexColor(value: unknown, path: string): string {
  const color = asString(value, path);
  if (!isHexColor(color)) fail(`${path} must be a #rrggbb color`, { path, color });
  return color;
}

interface LoadedMaps {
  palettes: Map<string, Palette>;
  fontPairs: Map<string, FontPair>;
  illustrations: Map<string, IllustrationAsset>;
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`Resource file could not be read: ${file}`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`Resource file is not valid JSON: ${file}`, { file });
  }
}

function listDirectory(dir: string, options: { required: boolean }): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    fail(`Resource directory could not be read: ${dir}`, {
      dir,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function addUnique<T>(map: Map<string, T>, id: string, value: T, kind: string): void {
  if (map.has(id)) fail(`Duplicate ${kind} id "${id}"`, { kind, id });
  map.set(id, value);
}

function parsePalette(value: unknown, file: string): Palette {
  const record = asRecord(value, file);
  const id = asString(record.id, `${file}: id`);
  const version = asFiniteNumber(record.version, `${file}: version`);
  if (version !== 1) fail(`${file}: version must be 1`, { file, version });
  const label = asLabel(record.label, `${file}: label`);

  const tokenRecord = asRecord(record.tokens, `${file}: tokens`);
  const tokens: PaletteTokens = {
    background: asHexColor(tokenRecord.background, `${file}: tokens.background`),
    text: asHexColor(tokenRecord.text, `${file}: tokens.text`),
    primary: asHexColor(tokenRecord.primary, `${file}: tokens.primary`),
    secondary: asHexColor(tokenRecord.secondary, `${file}: tokens.secondary`),
    accent: asHexColor(tokenRecord.accent, `${file}: tokens.accent`),
  };
  if (tokenRecord.decorative !== undefined) {
    tokens.decorative = asArray(tokenRecord.decorative, `${file}: tokens.decorative`).map(
      (color, index) => asHexColor(color, `${file}: tokens.decorative[${index}]`),
    );
  }

  const textOnRecord = asRecord(record.textOn, `${file}: textOn`);
  const textOn: Record<string, string[]> = {};
  for (const [surface, list] of Object.entries(textOnRecord)) {
    if (!isPaletteTokenName(surface)) {
      fail(`${file}: textOn has unknown surface "${surface}"`, { file, surface });
    }
    const textTokens = asArray(list, `${file}: textOn.${surface}`).map((token, index) => {
      const name = asString(token, `${file}: textOn.${surface}[${index}]`);
      if (!isPaletteTokenName(name)) {
        fail(`${file}: textOn.${surface} has unknown token "${name}"`, {
          file,
          surface,
          token: name,
        });
      }
      return name;
    });
    textOn[surface] = textTokens;
  }

  const palette: Palette = { id, version: 1, label, tokens, textOn };
  if (record.colorblindNote !== undefined) {
    palette.colorblindNote = asLabel(record.colorblindNote, `${file}: colorblindNote`);
  }
  validatePalette(palette);
  return palette;
}

function parseFontPair(value: unknown, file: string, index: number): FontPair {
  const path = `${file}: pairs[${index}]`;
  const record = asRecord(value, path);
  const id = asString(record.id, `${path}.id`);
  const version = asFiniteNumber(record.version, `${path}.version`);
  if (version !== 1) fail(`${path}.version must be 1`, { path, version });
  const label = asLabel(record.label, `${path}.label`);

  const familiesRecord = asRecord(record.families, `${path}.families`);
  const familyNames = Object.keys(familiesRecord);
  if (familyNames.length === 0 || familyNames.length > 2) {
    fail(`${path}.families must declare one or two families`, { path });
  }
  const families: FontPair["families"] = {};
  let weightCount = 0;
  for (const familyName of familyNames) {
    const familyRecord = asRecord(familiesRecord[familyName], `${path}.families.${familyName}`);
    const filesRecord = asRecord(familyRecord.files, `${path}.families.${familyName}.files`);
    const files: Record<string, string> = {};
    for (const [weight, fileValue] of Object.entries(filesRecord)) {
      const weightNumber = Number(weight);
      if (!WEIGHTS.includes(weightNumber)) {
        fail(`${path}.families.${familyName} has unsupported weight ${weight}`, { path, weight });
      }
      const file = asString(fileValue, `${path}.families.${familyName}.files.${weight}`);
      if (!FONT_FILE_PATTERN.test(file)) {
        fail(`${path}.families.${familyName} references invalid font file "${file}"`, {
          path,
          file,
        });
      }
      files[weight] = file;
      weightCount += 1;
    }
    if (Object.keys(files).length === 0) {
      fail(`${path}.families.${familyName} declares no font files`, { path });
    }
    families[familyName] = { files };
  }
  if (weightCount > 3) {
    fail(`${path} declares ${weightCount} weights; at most 3 are allowed`, { path, weightCount });
  }

  const rolesRecord = asRecord(record.roles, `${path}.roles`);
  const roles = {} as Record<FontPairRole, FontPair["roles"][FontPairRole]>;
  for (const role of FONT_PAIR_ROLES) {
    const roleRecord = asRecord(rolesRecord[role], `${path}.roles.${role}`);
    const family = asString(roleRecord.family, `${path}.roles.${role}.family`);
    const file = asString(roleRecord.file, `${path}.roles.${role}.file`);
    const weight = asFiniteNumber(roleRecord.weight, `${path}.roles.${role}.weight`);
    const alias = asString(roleRecord.alias, `${path}.roles.${role}.alias`);
    const familyEntry = families[family];
    if (familyEntry === undefined) {
      fail(`${path}.roles.${role} uses undeclared family "${family}"`, { path, family });
    }
    const expectedFile = familyEntry.files[String(weight)];
    if (expectedFile === undefined || expectedFile !== file) {
      fail(`${path}.roles.${role} does not match families["${family}"]["${weight}"]`, { path });
    }
    const expectedAlias = `Cardsmith${family.replace(/[^A-Za-z0-9]/g, "")}${weight}`;
    if (alias !== expectedAlias) {
      fail(`${path}.roles.${role}.alias must be "${expectedAlias}"`, { path, alias });
    }
    roles[role] = { family, file, weight, alias };
  }
  for (const [familyName, familyEntry] of Object.entries(families)) {
    for (const [weight, file] of Object.entries(familyEntry.files)) {
      const used = FONT_PAIR_ROLES.some((role) => {
        const entry = roles[role];
        return (
          entry.family === familyName && String(entry.weight) === weight && entry.file === file
        );
      });
      if (!used) {
        fail(`${path}.families.${familyName}["${weight}"] is not used by any role`, { path });
      }
    }
  }

  return {
    id,
    version: 1,
    label,
    families,
    roles,
    cssFontAlias: asString(record.cssFontAlias, `${path}.cssFontAlias`),
  };
}

function parseAssetColor(value: unknown, path: string): string {
  const color = asString(value, path);
  if (color.startsWith("$")) {
    if (!isPaletteTokenName(color.slice(1))) {
      fail(`${path} has unknown palette token "${color}"`, { path, color });
    }
    return color;
  }
  if (!isHexColor(color)) fail(`${path} must be a palette token or #rrggbb color`, { path, color });
  return color;
}

function parseAssetOp(value: unknown, path: string): AssetOp {
  const record = asRecord(value, path);
  const kind = asString(record.kind, `${path}.kind`);
  switch (kind) {
    case "path": {
      const op: AssetOp = {
        kind: "path",
        d: asString(record.d, `${path}.d`),
      };
      if (record.fill !== undefined) op.fill = parseAssetColor(record.fill, `${path}.fill`);
      if (record.stroke !== undefined) op.stroke = parseAssetColor(record.stroke, `${path}.stroke`);
      if (record.strokeWidth !== undefined) {
        op.strokeWidth = asFiniteNumber(record.strokeWidth, `${path}.strokeWidth`);
        if (op.strokeWidth <= 0) fail(`${path}.strokeWidth must be positive`, { path });
      }
      return op;
    }
    case "rect": {
      const op: AssetOp = {
        kind: "rect",
        x: asFiniteNumber(record.x, `${path}.x`),
        y: asFiniteNumber(record.y, `${path}.y`),
        w: asFiniteNumber(record.w, `${path}.w`),
        h: asFiniteNumber(record.h, `${path}.h`),
      };
      if (record.fill !== undefined) op.fill = parseAssetColor(record.fill, `${path}.fill`);
      if (record.radius !== undefined) {
        op.radius = asFiniteNumber(record.radius, `${path}.radius`);
        if (op.radius < 0) fail(`${path}.radius must not be negative`, { path });
      }
      return op;
    }
    case "circle": {
      const op: AssetOp = {
        kind: "circle",
        cx: asFiniteNumber(record.cx, `${path}.cx`),
        cy: asFiniteNumber(record.cy, `${path}.cy`),
        r: asFiniteNumber(record.r, `${path}.r`),
      };
      if (op.r <= 0) fail(`${path}.r must be positive`, { path });
      if (record.fill !== undefined) op.fill = parseAssetColor(record.fill, `${path}.fill`);
      if (record.stroke !== undefined) op.stroke = parseAssetColor(record.stroke, `${path}.stroke`);
      if (record.strokeWidth !== undefined) {
        op.strokeWidth = asFiniteNumber(record.strokeWidth, `${path}.strokeWidth`);
      }
      return op;
    }
    case "ellipse": {
      const op: AssetOp = {
        kind: "ellipse",
        cx: asFiniteNumber(record.cx, `${path}.cx`),
        cy: asFiniteNumber(record.cy, `${path}.cy`),
        rx: asFiniteNumber(record.rx, `${path}.rx`),
        ry: asFiniteNumber(record.ry, `${path}.ry`),
      };
      if (op.rx <= 0 || op.ry <= 0) fail(`${path} radii must be positive`, { path });
      if (record.fill !== undefined) op.fill = parseAssetColor(record.fill, `${path}.fill`);
      if (record.stroke !== undefined) op.stroke = parseAssetColor(record.stroke, `${path}.stroke`);
      if (record.strokeWidth !== undefined) {
        op.strokeWidth = asFiniteNumber(record.strokeWidth, `${path}.strokeWidth`);
      }
      return op;
    }
    default:
      fail(`${path}.kind must be path, rect, circle or ellipse`, { path, kind });
  }
}

function parseIllustration(value: unknown, file: string): IllustrationAsset {
  const record = asRecord(value, file);
  const id = asString(record.id, `${file}: id`);
  const version = asFiniteNumber(record.version, `${file}: version`);
  if (version !== 1) fail(`${file}: version must be 1`, { file, version });
  const rawViewBox = asArray(record.viewBox, `${file}: viewBox`);
  if (rawViewBox.length !== 4) fail(`${file}: viewBox must have 4 numbers`, { file });
  const viewBox = rawViewBox.map((entry, index) =>
    asFiniteNumber(entry, `${file}: viewBox[${index}]`),
  ) as [number, number, number, number];
  const [, , viewWidth, viewHeight] = viewBox;
  if (viewWidth <= 0 || viewHeight <= 0) fail(`${file}: viewBox size must be positive`, { file });
  const ops = asArray(record.ops, `${file}: ops`).map((op, index) =>
    parseAssetOp(op, `${file}: ops[${index}]`),
  );
  const asset: IllustrationAsset = { id, version: 1, viewBox, ops };
  if (record.label !== undefined) asset.label = asLabel(record.label, `${file}: label`);
  if (record.tags !== undefined) {
    const tags = asArray(record.tags, `${file}: tags`).map((entry, index) => {
      const tag = asString(entry, `${file}: tags[${index}]`);
      if (!(ILLUSTRATION_TAGS as readonly string[]).includes(tag)) {
        fail(`${file}: unknown tag "${tag}"`, { file, tag });
      }
      return tag as IllustrationTag;
    });
    if (new Set(tags).size !== tags.length) {
      fail(`${file}: tags must not repeat`, { file });
    }
    asset.tags = tags;
  }
  return asset;
}

function parseField(value: unknown, path: string): FieldSpec {
  const record = asRecord(value, path);
  const key = asString(record.key, `${path}.key`);
  if (!FIELD_KEY_PATTERN.test(key)) fail(`${path}.key must be a simple identifier`, { path, key });
  const type = asString(record.type, `${path}.type`);
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    fail(`${path}.type must be one of ${FIELD_TYPES.join(", ")}`, { path, type });
  }
  const field: FieldSpec = { key, type: type as FieldType };
  if (record.required !== undefined)
    field.required = asBoolean(record.required, `${path}.required`);
  if (record.maxChars !== undefined) {
    field.maxChars = asPositiveInteger(record.maxChars, `${path}.maxChars`);
  }
  if (record.overflow !== undefined) {
    const overflow = asString(record.overflow, `${path}.overflow`);
    if (overflow !== "error" && overflow !== "warn") {
      fail(`${path}.overflow must be "error" or "warn"`, { path });
    }
    field.overflow = overflow;
  }
  if (record.label !== undefined) field.label = asLabel(record.label, `${path}.label`);
  return field;
}

function parseSlot(value: unknown, path: string, fieldKeys: Set<string>): SlotSpec {
  const record = asRecord(value, path);
  const key = asString(record.key, `${path}.key`);
  if (!fieldKeys.has(key)) fail(`${path}.key "${key}" is not a template field`, { path, key });
  const role = asString(record.role, `${path}.role`);
  if (!(FONT_PAIR_ROLES as readonly string[]).includes(role)) {
    fail(`${path}.role must be one of ${FONT_PAIR_ROLES.join(", ")}`, { path, role });
  }
  const slot: SlotSpec = {
    key,
    role: role as SlotRole,
    box: asBox(record.box, `${path}.box`),
  };
  if (record.color !== undefined) slot.color = asColorToken(record.color, `${path}.color`);
  if (record.align !== undefined) {
    const align = asString(record.align, `${path}.align`);
    if (align !== "left" && align !== "center" && align !== "right") {
      fail(`${path}.align must be left, center or right`, { path });
    }
    slot.align = align;
  }
  if (record.valign !== undefined) {
    const valign = asString(record.valign, `${path}.valign`);
    if (valign !== "top" && valign !== "middle" && valign !== "bottom") {
      fail(`${path}.valign must be top, middle or bottom`, { path });
    }
    slot.valign = valign;
  }
  if (record.maxLines !== undefined) {
    slot.maxLines = asPositiveInteger(record.maxLines, `${path}.maxLines`);
  }
  if (record.maxSizePct !== undefined) {
    const pct = asFiniteNumber(record.maxSizePct, `${path}.maxSizePct`);
    if (pct <= 0) fail(`${path}.maxSizePct must be positive`, { path });
    slot.maxSizePct = pct;
  }
  if (record.size !== undefined) {
    const size = asFiniteNumber(record.size, `${path}.size`);
    if (size <= 0) fail(`${path}.size must be positive`, { path });
    slot.size = size;
  }
  if (record.lineHeightRatio !== undefined) {
    const ratio = asFiniteNumber(record.lineHeightRatio, `${path}.lineHeightRatio`);
    if (ratio <= 0) fail(`${path}.lineHeightRatio must be positive`, { path });
    slot.lineHeightRatio = ratio;
  }
  if (record.curve !== undefined) {
    const curveRecord = asRecord(record.curve, `${path}.curve`);
    const side = asString(curveRecord.side, `${path}.curve.side`);
    if (side !== "outside" && side !== "inside") {
      fail(`${path}.curve.side must be outside or inside`, { path });
    }
    const radius = asFiniteNumber(curveRecord.radius, `${path}.curve.radius`);
    if (radius <= 0) fail(`${path}.curve.radius must be positive`, { path });
    slot.curve = {
      cx: asFiniteNumber(curveRecord.cx, `${path}.curve.cx`),
      cy: asFiniteNumber(curveRecord.cy, `${path}.curve.cy`),
      radius,
      startAngle: asFiniteNumber(curveRecord.startAngle, `${path}.curve.startAngle`),
      endAngle: asFiniteNumber(curveRecord.endAngle, `${path}.curve.endAngle`),
      side,
    };
  }
  return slot;
}

function parseLayout(
  value: unknown,
  path: string,
  fieldKeys: Set<string>,
  illustrations: Map<string, IllustrationAsset>,
  supports: TemplateSupports,
): TemplateLayout {
  const record = asRecord(value, path);
  const layout: TemplateLayout = {
    slots: asArray(record.slots, `${path}.slots`).map((slot, index) =>
      parseSlot(slot, `${path}.slots[${index}]`, fieldKeys),
    ),
  };
  if (record.background !== undefined) {
    layout.background = asColorToken(record.background, `${path}.background`);
  }
  if (record.decor !== undefined) {
    layout.decor = asArray(record.decor, `${path}.decor`).map((entry, index) => {
      const decor = asRecord(entry, `${path}.decor[${index}]`);
      const assetId = asString(decor.assetId, `${path}.decor[${index}].assetId`);
      if (!illustrations.has(assetId)) {
        fail(`${path}.decor[${index}] references unknown asset "${assetId}"`, { path, assetId });
      }
      return { assetId, box: asBox(decor.box, `${path}.decor[${index}].box`) };
    });
  }
  if (record.illustration !== undefined) {
    const illustration = asRecord(record.illustration, `${path}.illustration`);
    const slot: { box: Box; defaultId?: string } = {
      box: asBox(illustration.box, `${path}.illustration.box`),
    };
    if (illustration.defaultId !== undefined) {
      const defaultId = asString(illustration.defaultId, `${path}.illustration.defaultId`);
      if (!illustrations.has(defaultId)) {
        fail(`${path}.illustration references unknown asset "${defaultId}"`, { path, defaultId });
      }
      slot.defaultId = defaultId;
    }
    if (!supports.illustration) {
      fail(`${path}.illustration needs supports.illustration = true`, { path });
    }
    layout.illustration = slot;
  }
  if (record.plot !== undefined) {
    const plot = asRecord(record.plot, `${path}.plot`);
    rejectUnknownKeys(plot, ["x", "y", "w", "h"], `${path}.plot`);
    layout.plot = asBox(plot, `${path}.plot`);
  }
  if (record.imageSlots !== undefined) {
    if (!supports.images) {
      fail(`${path}.imageSlots needs supports.images = true`, { path });
    }
    const rawSlots = asArray(record.imageSlots, `${path}.imageSlots`);
    if (rawSlots.length === 0) fail(`${path}.imageSlots must not be empty`, { path });
    const usedKeys = new Set<string>();
    layout.imageSlots = rawSlots.map((entry, index) => {
      const slotPath = `${path}.imageSlots[${index}]`;
      const recordSlot = asRecord(entry, slotPath);
      rejectUnknownKeys(recordSlot, ["key", "box", "fit", "round"], slotPath);
      const key = asString(recordSlot.key, `${slotPath}.key`);
      if (usedKeys.has(key)) fail(`${slotPath}.key "${key}" is duplicated`, { slotPath, key });
      usedKeys.add(key);
      const imageSlot: ImageSlotSpec = { key, box: asBox(recordSlot.box, `${slotPath}.box`) };
      if (recordSlot.fit !== undefined) {
        const fit = asString(recordSlot.fit, `${slotPath}.fit`);
        if (fit !== "cover" && fit !== "contain") {
          fail(`${slotPath}.fit must be "cover" or "contain"`, { slotPath, fit });
        }
        imageSlot.fit = fit;
      }
      if (recordSlot.round !== undefined) {
        const round = asString(recordSlot.round, `${slotPath}.round`);
        if (round !== "none" && round !== "circle") {
          fail(`${slotPath}.round must be "none" or "circle"`, { slotPath, round });
        }
        imageSlot.round = round;
      }
      return imageSlot;
    });
  }
  if (record.qr !== undefined) {
    if (!supports.qr) fail(`${path}.qr needs supports.qr = true`, { path });
    const qr = asRecord(record.qr, `${path}.qr`);
    layout.qr = { box: asBox(qr.box, `${path}.qr.box`) };
  }
  return layout;
}

function parseTemplate(value: unknown, file: string, maps: LoadedMaps): Template {
  const record = asRecord(value, file);
  const id = asString(record.id, `${file}: id`);
  const version = asFiniteNumber(record.version, `${file}: version`);
  if (version !== 1) fail(`${file}: version must be 1`, { file, version });
  const family = asString(record.family, `${file}: family`);
  const label = asLabel(record.label, `${file}: label`);

  const supportsRecord = asRecord(record.supports, `${file}: supports`);
  const supports: TemplateSupports = {
    qr: asBoolean(supportsRecord.qr, `${file}: supports.qr`),
    illustration: asBoolean(supportsRecord.illustration, `${file}: supports.illustration`),
    images: asBoolean(supportsRecord.images, `${file}: supports.images`),
  };

  const fields = asArray(record.fields, `${file}: fields`).map((field, index) =>
    parseField(field, `${file}: fields[${index}]`),
  );
  if (fields.length === 0) fail(`${file}: fields must not be empty`, { file });
  const fieldKeys = new Set<string>();
  for (const field of fields) {
    if (fieldKeys.has(field.key)) fail(`${file}: duplicate field "${field.key}"`, { file });
    fieldKeys.add(field.key);
  }

  const layoutsRecord = asRecord(record.layouts, `${file}: layouts`);
  const layouts: Partial<Record<LayoutKey, TemplateLayout>> = {};
  let layoutCount = 0;
  for (const [layoutKey, layoutValue] of Object.entries(layoutsRecord)) {
    if (!(LAYOUT_KEYS as readonly string[]).includes(layoutKey)) {
      fail(`${file}: unknown layout "${layoutKey}"`, { file, layoutKey });
    }
    layouts[layoutKey as LayoutKey] = parseLayout(
      layoutValue,
      `${file}: layouts.${layoutKey}`,
      fieldKeys,
      maps.illustrations,
      supports,
    );
    layoutCount += 1;
  }
  if (layoutCount === 0) fail(`${file}: at least one layout is required`, { file });

  const defaultPalette = asString(record.defaultPalette, `${file}: defaultPalette`);
  if (!maps.palettes.has(defaultPalette)) {
    fail(`${file}: unknown defaultPalette "${defaultPalette}"`, { file, defaultPalette });
  }
  const defaultFontPair = asString(record.defaultFontPair, `${file}: defaultFontPair`);
  if (!maps.fontPairs.has(defaultFontPair)) {
    fail(`${file}: unknown defaultFontPair "${defaultFontPair}"`, { file, defaultFontPair });
  }

  const template: Template = {
    id,
    version: 1,
    family: family as Family,
    label,
    layouts,
    fields,
    defaultPalette,
    defaultFontPair,
    supports,
  };
  if (record.description !== undefined) {
    template.description = asLabel(record.description, `${file}: description`);
  }
  if (record.accentIllustrations !== undefined) {
    template.accentIllustrations = asArray(
      record.accentIllustrations,
      `${file}: accentIllustrations`,
    ).map((entry, index) => {
      const assetId = asString(entry, `${file}: accentIllustrations[${index}]`);
      if (!maps.illustrations.has(assetId)) {
        fail(`${file}: unknown accent illustration "${assetId}"`, { file, assetId });
      }
      return assetId;
    });
  }
  return template;
}

function compatibleSizeIds(template: Template): string[] {
  const orientations = new Set(Object.keys(template.layouts));
  return SIZE_PRESETS.filter((preset) => orientations.has(preset.orientation)).map(
    (preset) => preset.id,
  );
}

/** First layout illustration default, in `LAYOUT_KEYS` order, for the catalog projection. */
function defaultIllustrationId(template: Template): string | undefined {
  for (const layoutKey of LAYOUT_KEYS) {
    const defaultId = template.layouts[layoutKey]?.illustration?.defaultId;
    if (defaultId !== undefined) return defaultId;
  }
  return undefined;
}

/**
 * Load and validate every resource with plain domain validators. Templates are optional and read
 * from `<templatesDir>/<id>/template.json`; palettes and illustrations from `*.json` files;
 * font pairs from a single JSON file. Duplicate ids and broken cross-references fail the load.
 */
export function createRegistry(options: RegistryOptions): Registry {
  const palettes = new Map<string, Palette>();
  for (const entry of listDirectory(options.palettesDir, { required: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(options.palettesDir, entry.name);
    const palette = parsePalette(readJsonFile(file), file);
    addUnique(palettes, palette.id, palette, "palette");
  }

  const fontPairs = new Map<string, FontPair>();
  const fontPairsValue = readJsonFile(options.fontPairsFile);
  asArray(fontPairsValue, options.fontPairsFile).forEach((entry, index) => {
    const pair = parseFontPair(entry, options.fontPairsFile, index);
    addUnique(fontPairs, pair.id, pair, "font pair");
  });
  const cssAliases = new Set<string>();
  for (const pair of fontPairs.values()) {
    if (cssAliases.has(pair.cssFontAlias)) {
      fail(`Duplicate cssFontAlias "${pair.cssFontAlias}"`, { cssFontAlias: pair.cssFontAlias });
    }
    cssAliases.add(pair.cssFontAlias);
  }

  const illustrations = new Map<string, IllustrationAsset>();
  for (const entry of listDirectory(options.illustrationsDir, { required: false })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(options.illustrationsDir, entry.name);
    const illustration = parseIllustration(readJsonFile(file), file);
    addUnique(illustrations, illustration.id, illustration, "illustration");
  }

  const maps: LoadedMaps = { palettes, fontPairs, illustrations };
  const templates = new Map<string, Template>();
  for (const entry of listDirectory(options.templatesDir, { required: false })) {
    if (!entry.isDirectory()) continue;
    const file = join(options.templatesDir, entry.name, "template.json");
    const template = parseTemplate(readJsonFile(file), file, maps);
    if (template.id !== entry.name) {
      fail(`Template id "${template.id}" must match its directory "${entry.name}"`, { file });
    }
    addUnique(templates, template.id, template, "template");
  }

  const catalog: Catalog = {
    templates: [...templates.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((template) => {
        const entry: CatalogTemplateEntry = {
          id: template.id,
          family: template.family,
          label: template.label,
          sizes: compatibleSizeIds(template),
          requiredFields: template.fields
            .filter((field) => field.required)
            .map((field) => field.key),
          supports: { ...template.supports },
          accentIllustrations: [...(template.accentIllustrations ?? [])],
        };
        const defaultIllustration = defaultIllustrationId(template);
        if (defaultIllustration !== undefined) entry.defaultIllustration = defaultIllustration;
        return entry;
      }),
    palettes: [...palettes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((palette) => ({ id: palette.id, label: palette.label })),
    fontPairs: [...fontPairs.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((pair) => ({ id: pair.id, label: pair.label })),
    illustrations: [...illustrations.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((asset) => ({
        id: asset.id,
        label: asset.label ?? { es: asset.id, en: asset.id },
        tags: [...(asset.tags ?? [])],
      })),
    sizes: SIZE_PRESETS.map((preset) => ({
      id: preset.id,
      width: preset.width,
      height: preset.height,
      orientation: preset.orientation,
      label: preset.label,
    })),
    formats: ["png", "jpeg"],
  };

  return {
    palette(id: string): Palette {
      const palette = palettes.get(id);
      if (palette === undefined) {
        throw new CardsmithError("UNKNOWN_PALETTE", `Unknown palette "${id}"`, { paletteId: id });
      }
      return palette;
    },
    template(id: string): Template {
      const template = templates.get(id);
      if (template === undefined) {
        throw new CardsmithError("UNKNOWN_TEMPLATE", `Unknown template "${id}"`, {
          templateId: id,
        });
      }
      return template;
    },
    fontPair(id: string): FontPair {
      const pair = fontPairs.get(id);
      if (pair === undefined) {
        throw new CardsmithError("UNKNOWN_FONT_PAIR", `Unknown font pair "${id}"`, {
          fontPairId: id,
        });
      }
      return pair;
    },
    illustration(id: string): IllustrationAsset {
      const illustration = illustrations.get(id);
      if (illustration === undefined) {
        throw new CardsmithError("UNKNOWN_ILLUSTRATION", `Unknown illustration "${id}"`, {
          illustrationId: id,
        });
      }
      return illustration;
    },
    size(id: string): SizePreset {
      const preset = SIZE_PRESETS.find((candidate) => candidate.id === id);
      if (preset === undefined) {
        throw new CardsmithError("UNKNOWN_SIZE", `Unknown size preset "${id}"`, { sizeId: id });
      }
      return preset;
    },
    catalog(): Catalog {
      return structuredClone(catalog);
    },
  };
}
