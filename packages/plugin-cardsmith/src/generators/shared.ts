import { type Box, formatPathNumber } from "../core/assets.js";
import type { DesignSpecImage, NormalizedSpec, SpecError } from "../core/design-spec.js";
import { CardsmithError } from "../core/errors.js";
import type { ImageSlotSpec, LayoutKey, Template, TemplateLayout } from "../core/registry.js";
import type { ImageOp, Scene, SceneOp } from "../core/scene.js";
import type { SizePreset } from "../core/sizes.js";

/** One parsed row of a `metrics` string array: `Label | Value` (value may be empty). */
export interface MetricRow {
  label: string;
  value: string;
}

/** SpecError factory shared by the family validators. */
export function specError(field: string, message: string): SpecError {
  return { code: "INVALID_SPEC", field, message };
}

/** True when a content value is renderable text: non-blank string or finite number. */
export function hasNonEmptyText(content: Record<string, unknown>, key: string): boolean {
  const value = content[key];
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

/**
 * Return a NEW scene with `ops` inserted immediately BEFORE the first text op.
 *
 * Text is the topmost layer: the renderer draws ops in order and `composeScene` emits every text
 * op last. Generators inject their own graphics (images, scrims, frames, dots, structured rows)
 * through this helper and never rebuild the base scene. When the scene has no text op the
 * injected ops are appended at the end.
 */
export function withInjectedOps(scene: Scene, ops: SceneOp[]): Scene {
  const nextOps = [...scene.ops];
  const firstText = nextOps.findIndex((op) => op.op === "text");
  nextOps.splice(firstText === -1 ? nextOps.length : firstText, 0, ...ops);
  return { ...scene, ops: nextOps };
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence: seeded decoration stays
 * reproducible across composes and renders.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ids of the images carried by the spec, in declaration order. */
export function requiredImageIds(spec: NormalizedSpec): string[] {
  return spec.images.map((image) => image.id);
}

/** Ids from `ids` that the spec does not provide, in the given order. */
export function missingImages(spec: NormalizedSpec, ids: readonly string[]): string[] {
  const present = new Set(requiredImageIds(spec));
  return ids.filter((id) => !present.has(id));
}

/** Content frame honoring the size safe area; mirrors `composeScene` box semantics. */
export function contentFrame(size: SizePreset): Box {
  const safe = size.safeArea;
  if (safe === undefined) {
    return { x: 0, y: 0, w: size.width, h: size.height };
  }
  return {
    x: safe.left,
    y: safe.top,
    w: size.width - safe.left - safe.right,
    h: size.height - safe.top - safe.bottom,
  };
}

/** Pixel box of a unit-square box inside a frame. */
export function boxToPx(box: Box, frame: Box): Box {
  return {
    x: frame.x + box.x * frame.w,
    y: frame.y + box.y * frame.h,
    w: box.w * frame.w,
    h: box.h * frame.h,
  };
}

/**
 * True for a `{ x: 0, y: 0, w: 1, h: 1 }` box: a FULL-BLEED image spans the whole canvas,
 * bypassing the story safe area that ordinary content boxes honor.
 */
export function isFullBleedBox(box: Box): boolean {
  return box.x === 0 && box.y === 0 && box.w === 1 && box.h === 1;
}

/**
 * Pixel box of an image slot. Ordinary boxes are fractions of the content frame (the size safe
 * area applies, like every other content box); a `{ 0, 0, 1, 1 }` box is FULL-BLEED and spans the
 * whole canvas. WU6 uses the full-bleed case (`photo-caption`/`watermark`); the editorial-photo
 * slots are not full-bleed, so the safe-area rule is the one exercised in this unit.
 */
export function imageSlotBox(slot: ImageSlotSpec, size: SizePreset): Box {
  const frame = isFullBleedBox(slot.box)
    ? { x: 0, y: 0, w: size.width, h: size.height }
    : contentFrame(size);
  return boxToPx(slot.box, frame);
}

/**
 * Scene image ops for every layout image slot with a matching `spec.images` entry. The template
 * owns placement (`box`, `fit`, `round`); the spec only supplies ids and paths. Missing optional
 * images are skipped silently: templates mark what they support, not what they require.
 */
export function imageOpsForLayout(
  layout: TemplateLayout,
  spec: NormalizedSpec,
  size: SizePreset,
): ImageOp[] {
  const byId = new Map<string, DesignSpecImage>(spec.images.map((image) => [image.id, image]));
  const ops: ImageOp[] = [];
  for (const slot of layout.imageSlots ?? []) {
    const image = byId.get(slot.key);
    if (image === undefined) continue;
    const box = imageSlotBox(slot, size);
    const op: ImageOp = { op: "image", ref: image.id, x: box.x, y: box.y, w: box.w, h: box.h };
    if (slot.fit !== undefined) op.fit = slot.fit;
    if (slot.round !== undefined) op.round = slot.round;
    ops.push(op);
  }
  return ops;
}

/** Layout for a size orientation; throws the same INVALID_SPEC `composeScene` would. */
export function requireLayout(template: Template, layoutKey: LayoutKey): TemplateLayout {
  const layout = template.layouts[layoutKey];
  if (layout === undefined) {
    throw new CardsmithError(
      "INVALID_SPEC",
      `template "${template.id}" has no "${layoutKey}" layout`,
      { templateId: template.id, layoutKey },
    );
  }
  return layout;
}

/**
 * Parse metric rows: one row per non-empty line, split on the FIRST `|`. Both parts are trimmed;
 * a line without `|` keeps its full text as the label and an empty value. Empty lines are skipped.
 */
export function parseMetricRows(metrics: readonly string[]): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const line of metrics) {
    if (typeof line !== "string") continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("|");
    if (separator === -1) {
      rows.push({ label: trimmed, value: "" });
      continue;
    }
    rows.push({
      label: trimmed.slice(0, separator).trim(),
      value: trimmed.slice(separator + 1).trim(),
    });
  }
  return rows;
}

/**
 * SVG path data for a rounded rectangle, formatted deterministically like asset paths
 * (`formatPathNumber`). Used for stroked frames, which `RectOp` cannot express.
 */
export function roundedRectPathData(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): string {
  const r = Math.min(Math.max(0, radius), w / 2, h / 2);
  const right = x + w;
  const bottom = y + h;
  if (r === 0) {
    return [
      `M ${formatPathNumber(x)} ${formatPathNumber(y)}`,
      `H ${formatPathNumber(right)}`,
      `V ${formatPathNumber(bottom)}`,
      `H ${formatPathNumber(x)}`,
      "Z",
    ].join(" ");
  }
  return [
    `M ${formatPathNumber(x + r)} ${formatPathNumber(y)}`,
    `H ${formatPathNumber(right - r)}`,
    `A ${formatPathNumber(r)} ${formatPathNumber(r)} 0 0 1 ${formatPathNumber(right)} ${formatPathNumber(y + r)}`,
    `V ${formatPathNumber(bottom - r)}`,
    `A ${formatPathNumber(r)} ${formatPathNumber(r)} 0 0 1 ${formatPathNumber(right - r)} ${formatPathNumber(bottom)}`,
    `H ${formatPathNumber(x + r)}`,
    `A ${formatPathNumber(r)} ${formatPathNumber(r)} 0 0 1 ${formatPathNumber(x)} ${formatPathNumber(bottom - r)}`,
    `V ${formatPathNumber(y + r)}`,
    `A ${formatPathNumber(r)} ${formatPathNumber(r)} 0 0 1 ${formatPathNumber(x + r)} ${formatPathNumber(y)}`,
    "Z",
  ].join(" ");
}
