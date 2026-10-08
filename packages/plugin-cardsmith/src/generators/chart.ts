import type { NormalizedSpec, SpecError } from "../core/design-spec.js";
import { composeScene } from "../core/layout.js";
import { type Palette, paletteToken } from "../core/palettes.js";
import type { Box, TemplateLayout } from "../core/registry.js";
import type { SceneOp, TextOp } from "../core/scene.js";
import type { SizePreset } from "../core/sizes.js";
import { type FitResult, fitText, type ResolvedFont, resolveRole } from "../core/typography.js";
import {
  arcPath,
  type ChartSeriesData,
  type ChartValue,
  formatTickValue,
  mapValueToY,
  niceDomain,
  type Point,
  polylinePath,
  seriesColor,
} from "./chart-primitives.js";
import { boxToPx, contentFrame, requireLayout, specError, withInjectedOps } from "./shared.js";
import type { FamilyGenerator, GeneratorContext } from "./types.js";

/** Geometry in `u` units: `u = min(canvas width, canvas height) / 100`. */
const Y_AXIS_UNITS = 10;
const X_AXIS_UNITS = 7;
const GRID_ALPHA = 0.12;
const AXIS_ALPHA = 0.35;
const TICK_TEXT_PCT = 2.2;
const LEGEND_TEXT_PCT = 2.4;
const LEGEND_SWATCH_UNITS = 1.5;
const LEGEND_ROW_UNITS = 3.2;
const LINE_STROKE_UNITS = 0.45;
const LINE_DOT_RADIUS_UNITS = 0.8;
const SCATTER_DOT_RADIUS_UNITS = 0.9;
const DONUT_THICKNESS_UNITS = 8;
const DONUT_GAP_DEG = 2;
const CENTER_TOTAL_PCT = 4;
const CENTER_UNIT_PCT = 2.4;

interface ChartContent {
  categories: string[];
  series: ChartSeriesData[];
  errors: SpecError[];
}

/**
 * Parse `content.categories` and `content.series`. `series` is either a flat number array (one
 * unnamed series, the shape `normalizeSpec` has always accepted) or an array of
 * `{ label?, values }` entries where values are finite numbers or null. Shape errors and semantic
 * rules (category length, at least one value per series, donut constraints) are reported together.
 */
function readChartContent(content: Record<string, unknown>): ChartContent {
  const errors: SpecError[] = [];
  const categoriesValue = content.categories;
  let categories: string[] = [];
  if (!Array.isArray(categoriesValue) || categoriesValue.length === 0) {
    errors.push(
      specError("content.categories", "chart templates require a non-empty categories array"),
    );
  } else if (!categoriesValue.every((entry) => typeof entry === "string")) {
    errors.push(specError("content.categories", "categories must be an array of strings"));
  } else {
    categories = categoriesValue as string[];
  }

  const seriesValue = content.series;
  const series: ChartSeriesData[] = [];
  if (!Array.isArray(seriesValue) || seriesValue.length === 0) {
    errors.push(specError("content.series", "chart templates require at least one series"));
  } else if (seriesValue.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    series.push({ values: seriesValue as number[] });
  } else {
    seriesValue.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        errors.push(
          specError("content.series", `series[${index}] must be an object with a values array`),
        );
        return;
      }
      const record = entry as Record<string, unknown>;
      if (record.label !== undefined && typeof record.label !== "string") {
        errors.push(specError("content.series", `series[${index}].label must be a string`));
      }
      const rawValues = record.values;
      if (!Array.isArray(rawValues)) {
        errors.push(specError("content.series", `series[${index}].values must be an array`));
        return;
      }
      const values: ChartValue[] = [];
      let malformed = false;
      rawValues.forEach((value, valueIndex) => {
        if (value === null) {
          values.push(null);
          return;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          values.push(value);
          return;
        }
        malformed = true;
        errors.push(
          specError(
            "content.series",
            `series[${index}].values[${valueIndex}] must be a finite number or null`,
          ),
        );
      });
      if (!malformed) {
        const parsed: ChartSeriesData = { values };
        if (typeof record.label === "string") parsed.label = record.label;
        series.push(parsed);
      }
    });
  }

  if (errors.length === 0) {
    for (const [index, entry] of series.entries()) {
      if (entry.values.length > categories.length) {
        errors.push(
          specError(
            "content.series",
            `series[${index}] has ${entry.values.length} values but there are ${categories.length} categories`,
          ),
        );
      }
      if (!entry.values.some((value) => value !== null)) {
        errors.push(
          specError("content.series", `series[${index}] has no values; every entry is null`),
        );
      }
    }
  }
  return { categories, series, errors };
}

function directTextOp(
  text: string,
  x: number,
  y: number,
  font: ResolvedFont,
  sizePx: number,
  color: string,
  align: "left" | "center" | "right",
  valign: "top" | "middle" | "bottom",
  maxWidth: number,
): TextOp {
  return {
    op: "text",
    text,
    x,
    y,
    font,
    sizePx,
    color,
    align,
    valign,
    lineHeight: sizePx * 1.25,
    lines: [text],
    maxWidth,
  };
}

function fitLabel(
  text: string,
  font: ResolvedFont,
  maxWidth: number,
  maxSize: number,
  measurer: GeneratorContext["measurer"],
): FitResult {
  const size = Math.max(1, Math.round(maxSize));
  return fitText(
    {
      text,
      font,
      maxWidth: Math.max(1, maxWidth),
      maxHeight: size * 1.5,
      maxSize: size,
      minSize: Math.max(1, Math.round(size * 0.55)),
      maxLines: 1,
      breakPolicy: "word-then-char",
    },
    measurer,
  );
}

/** Label that shrinks to fit `maxWidth` instead of overflowing the axis or the legend. */
function fittedTextOp(
  text: string,
  x: number,
  y: number,
  font: ResolvedFont,
  maxWidth: number,
  maxSize: number,
  color: string,
  align: "left" | "center" | "right",
  valign: "top" | "middle" | "bottom",
  measurer: GeneratorContext["measurer"],
): TextOp {
  const width = Math.max(1, maxWidth);
  const fitted = fitLabel(text, font, width, maxSize, measurer);
  return {
    op: "text",
    text,
    x,
    y,
    font,
    sizePx: fitted.sizePx,
    color,
    align,
    valign,
    lineHeight: fitted.lineHeight,
    lines: fitted.lines,
    maxWidth: width,
  };
}

interface LegendEntry {
  label: string;
  color: string;
}

interface LegendPlan {
  /** Entry indexes per row (row direction wraps; column direction is one entry per row). */
  rows: number[][];
  /** Fitted label for each entry, in entry order. */
  fits: FitResult[];
  height: number;
  width: number;
}

function planLegend(
  entries: readonly LegendEntry[],
  options: {
    maxWidth: number;
    direction: "row" | "column";
    unitPx: number;
    font: ResolvedFont;
    textSize: number;
    measurer: GeneratorContext["measurer"];
  },
): LegendPlan {
  const swatch = LEGEND_SWATCH_UNITS * options.unitPx;
  const gap = options.unitPx;
  const itemGap = 2.5 * options.unitPx;
  const rowHeight = LEGEND_ROW_UNITS * options.unitPx;
  const labelMaxWidth = Math.max(1, options.maxWidth - swatch - gap);
  const fits = entries.map((entry) =>
    fitLabel(entry.label, options.font, labelMaxWidth, options.textSize, options.measurer),
  );
  const rows: number[][] = [];
  if (options.direction === "column") {
    for (let index = 0; index < entries.length; index += 1) rows.push([index]);
  } else {
    let current: number[] = [];
    let cursor = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const itemWidth = swatch + gap + (fits[index]?.width ?? 0);
      if (current.length > 0 && cursor + itemGap + itemWidth > options.maxWidth) {
        rows.push(current);
        current = [];
        cursor = 0;
      }
      cursor += (current.length > 0 ? itemGap : 0) + itemWidth;
      current.push(index);
    }
    if (current.length > 0) rows.push(current);
  }
  let width = 0;
  for (const row of rows) {
    const rowWidth = row.reduce(
      (sum, index, position) =>
        sum + (position > 0 ? itemGap : 0) + swatch + gap + (fits[index]?.width ?? 0),
      0,
    );
    width = Math.max(width, rowWidth);
  }
  return { rows, fits, height: rows.length * rowHeight, width };
}

function legendOpsFromPlan(
  plan: LegendPlan,
  entries: readonly LegendEntry[],
  x: number,
  y: number,
  options: { unitPx: number; font: ResolvedFont; color: string },
): SceneOp[] {
  const swatch = LEGEND_SWATCH_UNITS * options.unitPx;
  const gap = options.unitPx;
  const itemGap = 2.5 * options.unitPx;
  const rowHeight = LEGEND_ROW_UNITS * options.unitPx;
  const ops: SceneOp[] = [];
  plan.rows.forEach((row, rowIndex) => {
    const rowY = y + rowIndex * rowHeight;
    let cursor = x;
    for (const index of row) {
      const entry = entries[index];
      const fitted = plan.fits[index];
      if (entry === undefined || fitted === undefined) continue;
      ops.push({
        op: "rect",
        x: cursor,
        y: rowY + (rowHeight - swatch) / 2,
        w: swatch,
        h: swatch,
        fill: entry.color,
      });
      ops.push({
        op: "text",
        text: entry.label,
        x: cursor + swatch + gap,
        y: rowY + rowHeight / 2,
        font: options.font,
        sizePx: fitted.sizePx,
        color: options.color,
        align: "left",
        valign: "middle",
        lineHeight: fitted.lineHeight,
        lines: fitted.lines,
        maxWidth: Math.max(1, plan.width),
      });
      cursor += swatch + gap + fitted.width + itemGap;
    }
  });
  return ops;
}

type AxisKind = "bar" | "line" | "scatter";

function axisChartOps(
  kind: AxisKind,
  spec: NormalizedSpec,
  content: ChartContent,
  plot: Box,
  size: SizePreset,
  palette: Palette,
  ctx: GeneratorContext,
): SceneOp[] {
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  for (const entry of content.series) {
    for (const value of entry.values) {
      if (value === null) continue;
      dataMin = Math.min(dataMin, value);
      dataMax = Math.max(dataMax, value);
    }
  }
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [];

  const unitPx = Math.min(size.width, size.height) / 100;
  const pair = ctx.registry.fontPair(spec.fontPairId);
  const bodyFont = resolveRole(pair, "body");
  const textColor = paletteToken(palette.tokens, "text");
  const tickSize = Math.max(1, size.height * (TICK_TEXT_PCT / 100));
  const legendSize = Math.max(1, size.height * (LEGEND_TEXT_PCT / 100));
  const ops: SceneOp[] = [];

  const left = Math.min(plot.x + Y_AXIS_UNITS * unitPx, plot.x + plot.w * 0.4);
  const right = plot.x + plot.w;
  const bottom = Math.max(plot.y + plot.h * 0.5, plot.y + plot.h - X_AXIS_UNITS * unitPx);

  // Legend above the plot: at least two series, or a single labeled series.
  const entries: LegendEntry[] = content.series.map((entry, index) => ({
    label: entry.label !== undefined && entry.label !== "" ? entry.label : `Series ${index + 1}`,
    color: seriesColor(palette, index),
  }));
  const needsLegend =
    content.series.length >= 2 || content.series.some((entry) => (entry.label ?? "") !== "");
  let seriesTop = plot.y;
  if (needsLegend) {
    const legendY = plot.y + 0.8 * unitPx;
    const plan = planLegend(entries, {
      maxWidth: right - left,
      direction: "row",
      unitPx,
      font: bodyFont,
      textSize: legendSize,
      measurer: ctx.measurer,
    });
    ops.push(
      ...legendOpsFromPlan(plan, entries, left, legendY, {
        unitPx,
        font: bodyFont,
        color: textColor,
      }),
    );
    seriesTop = legendY + plan.height + 0.8 * unitPx;
  }

  const domain = niceDomain(dataMin, dataMax, { includeZero: kind === "bar" });
  const categoryCount = content.categories.length;
  const slotWidth = (right - left) / Math.max(1, categoryCount);
  // Points keep a dot-radius inset so the extreme dots never cross the plot box.
  const pointInset = kind === "bar" ? 0 : Math.max(1, SCATTER_DOT_RADIUS_UNITS * unitPx);
  const seriesLeft = left + pointInset;
  const seriesRight = right - pointInset;
  const categoryX = (index: number): number =>
    categoryCount <= 1
      ? (seriesLeft + seriesRight) / 2
      : seriesLeft + (index / (categoryCount - 1)) * (seriesRight - seriesLeft);

  // Subtle gridlines plus right-aligned y tick labels.
  for (const tick of domain.ticks) {
    const y = mapValueToY(tick, domain, seriesTop, bottom);
    ops.push({
      op: "rect",
      x: left,
      y,
      w: Math.max(1, right - left),
      h: Math.max(1, 0.1 * unitPx),
      fill: textColor,
      alpha: GRID_ALPHA,
    });
    ops.push(
      fittedTextOp(
        formatTickValue(tick),
        left - unitPx,
        y,
        bodyFont,
        Y_AXIS_UNITS * unitPx - 1.5 * unitPx,
        tickSize,
        textColor,
        "right",
        "middle",
        ctx.measurer,
      ),
    );
  }

  // Baseline: the zero line for bars (the magnitude axis always includes zero); the domain
  // minimum for line and scatter.
  const baselineY =
    kind === "bar" ? mapValueToY(0, domain, seriesTop, bottom) : Math.max(seriesTop, bottom);
  ops.push({
    op: "rect",
    x: left,
    y: baselineY,
    w: Math.max(1, right - left),
    h: Math.max(1, 0.15 * unitPx),
    fill: textColor,
    alpha: AXIS_ALPHA,
  });

  // Category tick labels: centered under each bar group or point.
  for (let index = 0; index < categoryCount; index += 1) {
    const x = kind === "bar" ? left + (index + 0.5) * slotWidth : categoryX(index);
    ops.push(
      fittedTextOp(
        content.categories[index] ?? "",
        x,
        bottom + 1.2 * unitPx,
        bodyFont,
        slotWidth * 0.96,
        tickSize,
        textColor,
        "center",
        "top",
        ctx.measurer,
      ),
    );
  }

  // Unit in the y-axis corner; the template slot remains the readable unit above the plot.
  const unitText = typeof spec.content.unit === "string" ? spec.content.unit.trim() : "";
  if (unitText !== "") {
    ops.push(
      fittedTextOp(
        unitText,
        left - unitPx,
        Math.max(plot.y, seriesTop - 0.6 * unitPx),
        bodyFont,
        Y_AXIS_UNITS * unitPx * 1.4,
        tickSize,
        textColor,
        "right",
        "bottom",
        ctx.measurer,
      ),
    );
  }

  if (kind === "bar") {
    const zeroY = mapValueToY(0, domain, seriesTop, bottom);
    const seriesCount = Math.max(1, content.series.length);
    const groupInset = slotWidth * 0.15;
    const barWidth = (slotWidth * 0.7) / seriesCount;
    content.series.forEach((entry, seriesIndex) => {
      const color = seriesColor(palette, seriesIndex);
      entry.values.forEach((value, categoryIndex) => {
        if (value === null) return;
        const valueY = mapValueToY(value, domain, seriesTop, bottom);
        const height = Math.abs(valueY - zeroY);
        if (!(height > 0)) return;
        ops.push({
          op: "rect",
          x: left + categoryIndex * slotWidth + groupInset + seriesIndex * barWidth,
          y: Math.min(valueY, zeroY),
          w: barWidth,
          h: height,
          fill: color,
        });
      });
    });
  }

  if (kind === "line") {
    const radius = Math.max(1, LINE_DOT_RADIUS_UNITS * unitPx);
    content.series.forEach((entry, seriesIndex) => {
      const color = seriesColor(palette, seriesIndex);
      // Nulls break the polyline into independent segments; every non-null value keeps its dot.
      const segments: Point[][] = [];
      const dots: Point[] = [];
      let segment: Point[] = [];
      entry.values.forEach((value, categoryIndex) => {
        if (value === null) {
          if (segment.length > 0) segments.push(segment);
          segment = [];
          return;
        }
        const point = {
          x: categoryX(categoryIndex),
          y: mapValueToY(value, domain, seriesTop, bottom),
        };
        segment.push(point);
        dots.push(point);
      });
      if (segment.length > 0) segments.push(segment);
      for (const points of segments) {
        if (points.length < 2) continue;
        ops.push({
          op: "path",
          d: polylinePath(points),
          stroke: color,
          strokeWidth: Math.max(1, LINE_STROKE_UNITS * unitPx),
        });
      }
      for (const point of dots) {
        ops.push({
          op: "rect",
          x: point.x - radius,
          y: point.y - radius,
          w: radius * 2,
          h: radius * 2,
          radius,
          fill: color,
        });
      }
    });
  }

  if (kind === "scatter") {
    const radius = Math.max(1, SCATTER_DOT_RADIUS_UNITS * unitPx);
    content.series.forEach((entry, seriesIndex) => {
      const color = seriesColor(palette, seriesIndex);
      entry.values.forEach((value, categoryIndex) => {
        if (value === null) return;
        const point = {
          x: categoryX(categoryIndex),
          y: mapValueToY(value, domain, seriesTop, bottom),
        };
        ops.push({
          op: "rect",
          x: point.x - radius,
          y: point.y - radius,
          w: radius * 2,
          h: radius * 2,
          radius,
          fill: color,
        });
      });
    });
  }

  return ops;
}

/**
 * Donut ring: arc paths stroked with a butt cap, starting at -90° with a ~2° gap between slices.
 * Only the first series is drawn (one slice per category; zero and null slices are skipped) and
 * the legend placement follows the orientation: right of the ring in landscape, below it
 * otherwise.
 */
function donutOps(
  spec: NormalizedSpec,
  content: ChartContent,
  plot: Box,
  size: SizePreset,
  palette: Palette,
  ctx: GeneratorContext,
): SceneOp[] {
  const values = content.series[0]?.values ?? [];
  const slices = content.categories
    .map((label, index) => ({
      label,
      color: seriesColor(palette, index),
      value: values[index] ?? null,
    }))
    .filter(
      (slice): slice is { label: string; color: string; value: number } =>
        slice.value !== null && slice.value > 0,
    );
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (slices.length === 0 || !(total > 0)) return [];

  const unitPx = Math.min(size.width, size.height) / 100;
  const pair = ctx.registry.fontPair(spec.fontPairId);
  const bodyFont = resolveRole(pair, "body");
  const strongFont = resolveRole(pair, "bodyStrong");
  const textColor = paletteToken(palette.tokens, "text");
  const legendSize = Math.max(1, size.height * (LEGEND_TEXT_PCT / 100));
  const totalSize = Math.max(1, size.height * (CENTER_TOTAL_PCT / 100));
  const centerUnitSize = Math.max(1, size.height * (CENTER_UNIT_PCT / 100));
  const unitText = typeof spec.content.unit === "string" ? spec.content.unit.trim() : "";
  const entries: LegendEntry[] = slices.map((slice) => ({
    label: slice.label,
    color: slice.color,
  }));

  const ringOps: SceneOp[] = [];
  const legendColumn = plot.w * 0.38;
  let centerX = plot.x + plot.w / 2;
  let centerY = plot.y + plot.h / 2;
  let diameter: number;
  let legendPlan: LegendPlan;
  let legendX: number;
  let legendY: number;

  if (size.orientation === "landscape") {
    diameter = Math.max(0, Math.min(plot.h, plot.w - legendColumn - 2 * unitPx));
    centerX = plot.x + diameter / 2;
    legendPlan = planLegend(entries, {
      maxWidth: Math.max(1, legendColumn),
      direction: "column",
      unitPx,
      font: bodyFont,
      textSize: legendSize,
      measurer: ctx.measurer,
    });
    legendX = plot.x + diameter + 2 * unitPx;
    legendY = plot.y + 0.5 * unitPx;
  } else {
    legendPlan = planLegend(entries, {
      maxWidth: Math.max(1, plot.w),
      direction: "row",
      unitPx,
      font: bodyFont,
      textSize: legendSize,
      measurer: ctx.measurer,
    });
    const ringHeight = Math.max(0, plot.h - legendPlan.height - 1.5 * unitPx);
    diameter = Math.min(plot.w, ringHeight);
    centerY = plot.y + ringHeight / 2;
    legendX = plot.x;
    legendY = plot.y + ringHeight + 0.5 * unitPx;
  }

  const thickness = Math.min(DONUT_THICKNESS_UNITS * unitPx, diameter * 0.35);
  const radius = (diameter - thickness) / 2;
  if (radius > 0) {
    let cursor = -90;
    for (const slice of slices) {
      const sweep = (slice.value / total) * 360;
      const gap = Math.min(DONUT_GAP_DEG, sweep * 0.4);
      const start = cursor + gap / 2;
      const end = cursor + sweep - gap / 2;
      if (end > start + 0.05) {
        ringOps.push({
          op: "path",
          d: arcPath(centerX, centerY, radius, start, end),
          stroke: slice.color,
          strokeWidth: thickness,
        });
      }
      cursor += sweep;
    }
  }

  // Center: total (bodyStrong) with the unit directly underneath.
  ringOps.push(
    directTextOp(
      formatTickValue(total),
      centerX,
      unitText === "" ? centerY : centerY - totalSize * 0.35,
      strongFont,
      totalSize,
      textColor,
      "center",
      "middle",
      Math.max(1, diameter),
    ),
  );
  if (unitText !== "") {
    ringOps.push(
      directTextOp(
        unitText,
        centerX,
        centerY + totalSize * 0.65,
        bodyFont,
        centerUnitSize,
        textColor,
        "center",
        "middle",
        Math.max(1, diameter),
      ),
    );
  }

  return [
    ...ringOps,
    ...legendOpsFromPlan(legendPlan, entries, legendX, legendY, {
      unitPx,
      font: bodyFont,
      color: textColor,
    }),
  ];
}

function chartOpsFor(
  spec: NormalizedSpec,
  content: ChartContent,
  layout: TemplateLayout,
  ctx: GeneratorContext,
  size: SizePreset,
  palette: Palette,
): { ops: SceneOp[]; warnings: string[] } {
  const warnings: string[] = [];
  if (layout.plot === undefined) {
    warnings.push(
      `chart template "${spec.templateId}" layout "${size.orientation}" has no plot box; chart skipped`,
    );
    return { ops: [], warnings };
  }
  if (content.errors.length > 0) {
    warnings.push(
      `chart content is invalid (${content.errors[0]?.message ?? "unknown error"}); chart skipped`,
    );
    return { ops: [], warnings };
  }
  const plot = boxToPx(layout.plot, contentFrame(size));
  switch (spec.templateId) {
    case "bar":
      return { ops: axisChartOps("bar", spec, content, plot, size, palette, ctx), warnings };
    case "line":
      return { ops: axisChartOps("line", spec, content, plot, size, palette, ctx), warnings };
    case "scatter":
      return { ops: axisChartOps("scatter", spec, content, plot, size, palette, ctx), warnings };
    case "donut":
      return { ops: donutOps(spec, content, plot, size, palette, ctx), warnings };
    default:
      return { ops: [], warnings };
  }
}

export const chartGenerator: FamilyGenerator = {
  family: "chart",

  validate(spec) {
    const content = readChartContent(spec.content);
    const errors: SpecError[] = [...content.errors];
    if (errors.length > 0) return errors;

    if (spec.templateId === "donut") {
      for (const [seriesIndex, entry] of content.series.entries()) {
        entry.values.forEach((value, valueIndex) => {
          if (value !== null && value < 0) {
            errors.push(
              specError(
                "content.series",
                `donut requires non-negative values; series[${seriesIndex}].values[${valueIndex}] is ${value}`,
              ),
            );
          }
        });
      }
      const total = (content.series[0]?.values ?? []).reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      if (!(total > 0)) {
        errors.push(
          specError(
            "content.series",
            "donut requires a positive total; the first series sums to zero",
          ),
        );
      }
    }
    return errors;
  },

  compose(spec, ctx) {
    const template = ctx.registry.template(spec.templateId);
    const size = ctx.registry.size(spec.sizeId);
    const layoutKey = size.orientation;
    const layout = requireLayout(template, layoutKey);
    const palette = ctx.registry.palette(spec.paletteId);
    // The chart templates only declare title/unit/source slots, so `categories` and `series`
    // never reach `composeScene`: no filtering is needed and no slot warning is raised.
    const composed = composeScene(template, layoutKey, spec, palette, ctx.registry, {
      measurer: ctx.measurer,
    });
    const content = readChartContent(spec.content);
    const result = chartOpsFor(spec, content, layout, ctx, size, palette);
    return {
      scene: withInjectedOps(composed.scene, result.ops),
      warnings: [...composed.warnings, ...result.warnings],
    };
  },
};
