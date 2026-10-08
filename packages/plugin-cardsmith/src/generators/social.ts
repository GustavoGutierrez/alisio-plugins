import type { NormalizedSpec, SpecError } from "../core/design-spec.js";
import { composeScene } from "../core/layout.js";
import { type Palette, paletteToken } from "../core/palettes.js";
import type { Box, TemplateLayout } from "../core/registry.js";
import type { RectOp, SceneOp, TextOp } from "../core/scene.js";
import type { SizePreset } from "../core/sizes.js";
import { fitText, type ResolvedFont, resolveRole, type TextMeasurer } from "../core/typography.js";
import {
  boxToPx,
  contentFrame,
  imageOpsForLayout,
  type MetricRow,
  missingImages,
  mulberry32,
  parseMetricRows,
  requiredImageIds,
  requireLayout,
  specError,
  withInjectedOps,
} from "./shared.js";
import type { FamilyGenerator, GeneratorContext } from "./types.js";

const CONFETTI_COLORS = ["accent", "primary", "secondary"] as const;

function metricRowsOf(spec: NormalizedSpec): MetricRow[] {
  const value = spec.content.metrics;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return [];
  return parseMetricRows(value as string[]);
}

/** Copy of the spec without `metrics`: the generator draws the parsed rows, not the raw block. */
function withoutMetricContent(spec: NormalizedSpec): NormalizedSpec {
  const content = { ...spec.content };
  delete content.metrics;
  return { ...spec, content };
}

/**
 * Background wash behind the text zone. The editorial layouts separate photo and text, so the
 * scrim follows the union of the layout text boxes and stays readable in any palette.
 */
function textScrim(layout: TemplateLayout, size: SizePreset, palette: Palette): RectOp | null {
  if (layout.slots.length === 0) return null;
  const frame = contentFrame(size);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const slot of layout.slots) {
    const box = boxToPx(slot.box, frame);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return {
    op: "rect",
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    fill: paletteToken(palette.tokens, "background"),
    alpha: 0.3,
  };
}

/** Six to ten seeded decorative dots inside the top 40% band; deterministic for a seed. */
function confettiOps(seed: number, size: SizePreset, palette: Palette): RectOp[] {
  const random = mulberry32(seed);
  const count = 6 + Math.floor(random() * 5);
  const unit = Math.min(size.width, size.height) / 100;
  const ops: RectOp[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = (0.03 + random() * 0.92) * size.width;
    const y = (0.03 + random() * 0.34) * size.height;
    const diameter = (1 + random()) * unit;
    const pick = Math.min(
      CONFETTI_COLORS.length - 1,
      Math.floor(random() * CONFETTI_COLORS.length),
    );
    ops.push({
      op: "rect",
      x,
      y,
      w: diameter,
      h: diameter,
      radius: diameter / 2,
      fill: paletteToken(palette.tokens, CONFETTI_COLORS[pick] ?? "accent"),
    });
  }
  return ops;
}

interface MetricTextOptions {
  text: string;
  font: ResolvedFont;
  color: string;
  align: "left" | "right";
  x: number;
  y: number;
  maxWidth: number;
  maxHeight: number;
  maxSize: number;
  measurer: TextMeasurer;
  warnings: string[];
  field: "label" | "value";
}

/** One metric line, fitted to its column. Overflow is a warning: text is never truncated. */
function metricText(options: MetricTextOptions): TextOp {
  const fitted = fitText(
    {
      text: options.text,
      font: options.font,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      maxSize: options.maxSize,
      minSize: Math.max(1, Math.round(options.maxSize * 0.25)),
      maxLines: 1,
      breakPolicy: "word-then-char",
    },
    options.measurer,
  );
  if (fitted.overflow) {
    options.warnings.push(
      `metric ${options.field} "${options.text}" overflows its column; full text preserved`,
    );
  }
  return {
    op: "text",
    text: options.text,
    x: options.x,
    y: options.y,
    font: options.font,
    sizePx: fitted.sizePx,
    color: options.color,
    align: options.align,
    valign: "middle",
    lineHeight: fitted.lineHeight,
    lines: fitted.lines,
    maxWidth: options.maxWidth,
  };
}

interface MetricOpsResult {
  ops: SceneOp[];
  warnings: string[];
}

/**
 * Structured metric rows inside the layout `plot` box: label left (`body`, `$text`), value right
 * (`bodyStrong`, `$primary`) and one thin `$secondary` divider between rows. The raw `metrics`
 * block never reaches `composeScene`, so rows render once and values never double-draw.
 */
function metricRowOps(
  rows: readonly MetricRow[],
  plotBox: Box | undefined,
  spec: NormalizedSpec,
  ctx: GeneratorContext,
  size: SizePreset,
  palette: Palette,
): MetricOpsResult {
  if (rows.length === 0) return { ops: [], warnings: [] };
  if (plotBox === undefined) {
    return {
      ops: [],
      warnings: [
        `metric-summary layout "${size.orientation}" has no plot box; metric rows skipped`,
      ],
    };
  }
  const plot = boxToPx(plotBox, contentFrame(size));
  const pair = ctx.registry.fontPair(spec.fontPairId);
  const labelFont = resolveRole(pair, "body");
  const valueFont = resolveRole(pair, "bodyStrong");
  const labelColor = paletteToken(palette.tokens, "text");
  const valueColor = paletteToken(palette.tokens, "primary");
  const dividerColor = paletteToken(palette.tokens, "secondary");
  const rowHeight = plot.h / rows.length;
  const labelMaxSize = Math.max(1, Math.round(Math.min(size.height * 0.04, rowHeight * 0.55)));
  const valueMaxSize = Math.max(1, Math.round(Math.min(size.height * 0.045, rowHeight * 0.6)));
  const unit = Math.min(size.width, size.height) / 100;
  const dividerHeight = Math.max(1, unit * 0.1);
  const labelWidth = plot.w * 0.68;
  const valueWidth = plot.w * 0.28;
  const ops: SceneOp[] = [];
  const warnings: string[] = [];

  rows.forEach((row, index) => {
    const rowTop = plot.y + index * rowHeight;
    const centerY = rowTop + rowHeight / 2;
    if (row.label !== "") {
      ops.push(
        metricText({
          text: row.label,
          font: labelFont,
          color: labelColor,
          align: "left",
          x: plot.x,
          y: centerY,
          maxWidth: labelWidth,
          maxHeight: rowHeight * 0.8,
          maxSize: labelMaxSize,
          measurer: ctx.measurer,
          warnings,
          field: "label",
        }),
      );
    }
    if (row.value !== "") {
      ops.push(
        metricText({
          text: row.value,
          font: valueFont,
          color: valueColor,
          align: "right",
          x: plot.x + plot.w,
          y: centerY,
          maxWidth: valueWidth,
          maxHeight: rowHeight * 0.8,
          maxSize: valueMaxSize,
          measurer: ctx.measurer,
          warnings,
          field: "value",
        }),
      );
    }
    if (index < rows.length - 1) {
      ops.push({
        op: "rect",
        x: plot.x,
        y: rowTop + rowHeight - dividerHeight / 2,
        w: plot.w,
        h: dividerHeight,
        fill: dividerColor,
        alpha: 0.35,
      });
    }
  });
  return { ops, warnings };
}

export const socialGenerator: FamilyGenerator = {
  family: "social",

  validate(spec, ctx) {
    const errors: SpecError[] = [];
    const template = ctx.registry.template(spec.templateId);

    if (spec.templateId === "editorial-photo") {
      const photoCount = requiredImageIds(spec).filter((id) => id === "photo").length;
      if (missingImages(spec, ["photo"]).length > 0 || photoCount > 1) {
        errors.push(
          specError("images", 'editorial-photo requires exactly one image with the id "photo"'),
        );
      }
    }

    if (spec.templateId === "metric-summary") {
      const rows = metricRowsOf(spec);
      const hasRow = rows.some((row) => row.label !== "" || row.value !== "");
      if (!hasRow) {
        errors.push(
          specError(
            "content.metrics",
            'metric-summary requires at least one non-empty "Label | Value" metric row',
          ),
        );
      }
    }

    // Defensive only: normalizeSpec already rejects QR on templates without support.
    if (spec.qr !== undefined && !template.supports.qr) {
      errors.push(specError("qr", `template "${template.id}" does not support QR codes`));
    }
    return errors;
  },

  compose(spec, ctx) {
    const template = ctx.registry.template(spec.templateId);
    const size = ctx.registry.size(spec.sizeId);
    const layoutKey = size.orientation;
    const layout = requireLayout(template, layoutKey);
    const palette = ctx.registry.palette(spec.paletteId);
    // metric-summary: the generator owns row rendering, so the joined block is stripped before
    // composeScene. composeTextSlot skips content keys that are undefined, so no slot op is made.
    const baseSpec = spec.templateId === "metric-summary" ? withoutMetricContent(spec) : spec;
    const composed = composeScene(template, layoutKey, baseSpec, palette, ctx.registry, {
      measurer: ctx.measurer,
    });
    const injected: SceneOp[] = [];
    const extraWarnings: string[] = [];

    if (spec.templateId === "editorial-photo") {
      injected.push(...imageOpsForLayout(layout, spec, size));
      const scrim = textScrim(layout, size, palette);
      if (scrim !== null) injected.push(scrim);
    } else if (spec.templateId === "retro-message") {
      if (spec.seed !== undefined) injected.push(...confettiOps(spec.seed, size, palette));
    } else if (spec.templateId === "metric-summary") {
      const result = metricRowOps(metricRowsOf(spec), layout.plot, spec, ctx, size, palette);
      injected.push(...result.ops);
      extraWarnings.push(...result.warnings);
    }

    return {
      scene: withInjectedOps(composed.scene, injected),
      warnings: [...composed.warnings, ...extraWarnings],
    };
  },
};
