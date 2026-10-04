import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { csvParseRows } from "d3-dsv";
import * as vega from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile as compileVegaLite, type TopLevelSpec } from "vega-lite";
import type { ResolvedMeta } from "./model.js";
import { loadPalette, type Palette } from "./palettes.js";

/**
 * Vega-Lite to SVG (spec 10.5, 12 and 16.1 P0.4). The service is format neutral: it produces an SVG
 * from a `.vl.json` spec, the data files under `data/` and the palette/font profile. Safety rules:
 *
 * - the plugin reads the data itself (realpath containment, no schemes, no `..`) and inlines it as
 *   `data.values`; Vega never loads anything (its loader refuses every request);
 * - CSV is parsed with `csvParseRows` (no code generation); Vega runs with `ast: true` and the
 *   `vega-interpreter` expression evaluator, so no `Function`/`eval` is ever needed;
 * - any warning or error logged by Vega-Lite or Vega fails the render;
 * - specs with `image` marks, `href`/`url` fields or non-plain `data.url` are rejected, and a spec
 *   that sets colors or fonts is rejected: the plugin injects the styling.
 */

export const chartEngineTag = "vega@6.4.0+vega-lite@6.4.3+vega-interpreter@2.3.2";

export type ChartCode = "FIG-001" | "FIG-002" | "FIG-003";

export interface ChartIssue {
  code: ChartCode;
  message: string;
  hint?: string;
}

export interface ChartCheck {
  issues: ChartIssue[];
  /** The parsed spec when it is JSON. */
  spec?: Record<string, unknown>;
  /** Data file relative to `data/`, when the spec declares a valid `data.url`. */
  dataFile?: string;
}

const supportedMarks = new Set([
  "bar",
  "line",
  "point",
  "area",
  "circle",
  "square",
  "tick",
  "rect",
  "rule",
  "text",
  "arc",
  "trail",
]);
const topLevelKeys = new Set([
  "$schema",
  "title",
  "description",
  "data",
  "mark",
  "encoding",
  "transform",
  "layer",
  "width",
  "height",
]);
const styleTopLevel = new Set(["config", "background"]);
const unsupportedTransforms = new Set(["lookup"]);
const colorChannels = new Set(["color", "fill", "stroke"]);
const schemaPattern = /^https:\/\/vega\.github\.io\/schema\/vega-lite\/v[56](?:\.\d+){0,2}\.json$/;
const dataExtensions = [".csv", ".json"];

const maxDataBytes = 5 * 1024 * 1024;
const maxRows = 20_000;
const maxColumns = 60;
const minWidth = 100;
const maxWidth = 560;
const maxHeight = 600;
export const defaultChartSize = { width: 400, height: 250 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Does a key set a color or a font? (`fontSize`, `fontWeight` and `fontStyle` are fine.) */
function stylingKey(key: string): boolean {
  if (key === "scheme" || key === "background") return true;
  if (key === "font" || key.endsWith("Font")) return true;
  if (key === "color" || key === "fill" || key === "stroke") return true;
  return key.endsWith("Color");
}

/** Normalize a declared `data.url` to a path relative to `data/`; undefined when it is not plain. */
export function normalizeDataUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//")) return undefined;
  if (url.includes("\\") || url.includes("\0") || isAbsolute(url)) return undefined;
  const plain = url.startsWith("data/") ? url.slice(5) : url;
  const segments = plain.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === ""))
    return undefined;
  return plain;
}

interface WalkContext {
  issues: ChartIssue[];
  /** Number of `url` keys that are the validated top-level `data.url`. */
  allowedUrl: unknown;
}

function walk(node: unknown, path: string[], context: WalkContext): void {
  const where = path.length === 0 ? "the spec" : path.join(".");
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      walk(item, [...path, String(index)], context);
    });
    return;
  }
  if (!isRecord(node)) return;
  const parent = path[path.length - 1];
  const insideColorChannel = path.some(
    (part, index) => part === "encoding" && colorChannels.has(path[index + 1] as string),
  );
  for (const [key, value] of Object.entries(node)) {
    const here = `${where}.${key}`;
    if (key === "href" || key === "url") {
      if (!(key === "url" && path.join(".") === "data" && value === context.allowedUrl)) {
        context.issues.push({
          code: "FIG-002",
          message: `Chart spec field ${here} is not allowed: links and external resources are rejected`,
          hint: "Remove href and url fields; the only external input is data.url under data/.",
        });
      }
      continue;
    }
    if (key === "tooltip" || key === "cursor") {
      context.issues.push({
        code: "FIG-002",
        message: `Chart spec field ${here} is not allowed: interactive features do not exist in print`,
      });
      continue;
    }
    // Channels named color/fill/stroke hold objects, not color values; only `value` and
    // `scale.range|scheme` inside them would set a color.
    const isChannel = path.length >= 1 && parent === "encoding" && colorChannels.has(key);
    if (isChannel) {
      walk(value, [...path, key], context);
      continue;
    }
    if (insideColorChannel && (key === "value" || key === "range")) {
      context.issues.push({
        code: "FIG-003",
        message: `Chart spec sets a color at ${here}; colors come from the thesis palette`,
        hint: `Remove ${key}; the palette is applied automatically.`,
      });
      continue;
    }
    if (stylingKey(key)) {
      context.issues.push({
        code: "FIG-003",
        message: `Chart spec sets a color or font at ${here}; colors and fonts come from the thesis presentation profile`,
        hint: `Remove ${key}; palette and fonts are injected automatically.`,
      });
      continue;
    }
    walk(value, [...path, key], context);
  }
}

function markIssues(mark: unknown, where: string, issues: ChartIssue[]): void {
  const type = typeof mark === "string" ? mark : isRecord(mark) ? mark.type : undefined;
  if (type === "image") {
    issues.push({
      code: "FIG-002",
      message: `Chart spec uses an image mark at ${where}; image marks load external resources`,
    });
  } else if (typeof type !== "string" || !supportedMarks.has(type)) {
    issues.push({
      code: "FIG-001",
      message: `Chart mark ${typeof type === "string" ? `"${type}"` : "(missing)"} at ${where} is not in the supported subset`,
      hint: `Supported marks: ${[...supportedMarks].join(", ")}.`,
    });
  }
}

/**
 * Validate a chart spec against the supported Vega-Lite subset (FIG-001), the forbidden fields
 * (FIG-002) and the styling ban (FIG-003). Pure: pass the files found under `data/` to also check
 * that the declared data file exists.
 */
export function checkChartSpec(
  text: string,
  options: { dataFiles?: ReadonlySet<string> } = {},
): ChartCheck {
  const issues: ChartIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      issues: [
        {
          code: "FIG-001",
          message: `Chart spec is not valid JSON: ${(error as Error).message.split("\n")[0]}`,
        },
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      issues: [{ code: "FIG-001", message: "Chart spec must be a JSON object (a Vega-Lite spec)" }],
    };
  }
  const spec = parsed;

  for (const key of Object.keys(spec)) {
    if (styleTopLevel.has(key)) {
      issues.push({
        code: "FIG-003",
        message: `Chart spec sets "${key}"; styling comes from the thesis presentation profile`,
        hint: `Remove ${key}.`,
      });
    } else if (!topLevelKeys.has(key)) {
      issues.push({
        code: "FIG-001",
        message: `Chart spec key "${key}" is not in the supported subset`,
        hint: `Supported keys: ${[...topLevelKeys].join(", ")}.`,
      });
    }
  }
  if (
    spec.$schema !== undefined &&
    !(typeof spec.$schema === "string" && schemaPattern.test(spec.$schema))
  ) {
    issues.push({
      code: "FIG-001",
      message: "$schema must be a Vega-Lite v5 or v6 schema URL (it is never fetched)",
    });
  }
  for (const dimension of ["width", "height"] as const) {
    const value = spec[dimension];
    if (value === undefined) continue;
    const limit = dimension === "width" ? maxWidth : maxHeight;
    if (
      typeof value !== "number" ||
      !(value >= (dimension === "width" ? minWidth : 60) && value <= limit)
    ) {
      issues.push({
        code: "FIG-001",
        message: `Chart ${dimension} must be a number of pixels up to ${limit}`,
      });
    }
  }

  // Structure: a single view (mark + encoding) or a flat layer of views.
  const hasMark = spec.mark !== undefined;
  const hasLayer = spec.layer !== undefined;
  if (hasMark === hasLayer) {
    issues.push({
      code: "FIG-001",
      message: hasMark
        ? "Chart spec must have either mark or layer, not both"
        : "Chart spec needs a mark (or a layer of marks)",
    });
  }
  if (hasMark) markIssues(spec.mark, "mark", issues);
  if (hasLayer) {
    if (!Array.isArray(spec.layer) || spec.layer.length === 0 || spec.layer.length > 8) {
      issues.push({ code: "FIG-001", message: "layer must be a list of 1 to 8 views" });
    } else {
      spec.layer.forEach((view, index) => {
        if (!isRecord(view)) {
          issues.push({ code: "FIG-001", message: `layer[${index}] must be an object` });
          return;
        }
        markIssues(view.mark, `layer[${index}].mark`, issues);
        if (view.data !== undefined) {
          issues.push({
            code: "FIG-001",
            message: `layer[${index}] declares its own data; declare data once at the top`,
          });
        }
      });
    }
  }

  if (Array.isArray(spec.transform)) {
    for (const [index, transform] of spec.transform.entries()) {
      if (
        isRecord(transform) &&
        Object.keys(transform).some((key) => unsupportedTransforms.has(key))
      ) {
        issues.push({
          code: "FIG-001",
          message: `transform[${index}] uses lookup, which needs a second data source and is not supported`,
        });
      }
    }
  }

  // Data: a plain url under data/, or inline values.
  let dataFile: string | undefined;
  const data = spec.data;
  let allowedUrl: unknown;
  if (data === undefined) {
    issues.push({ code: "FIG-001", message: "Chart spec needs data (data.url or data.values)" });
  } else if (!isRecord(data)) {
    issues.push({ code: "FIG-001", message: "data must be an object with url or values" });
  } else {
    for (const key of Object.keys(data)) {
      if (!["url", "values", "format"].includes(key)) {
        issues.push({
          code: "FIG-001",
          message: `data.${key} is not supported; use data.url (a file under data/) or data.values`,
        });
      }
    }
    if (isRecord(data.format)) {
      const keys = Object.keys(data.format);
      if (
        keys.some((key) => key !== "type") ||
        !["csv", "json"].includes(String(data.format.type))
      ) {
        issues.push({
          code: "FIG-001",
          message: "data.format may only be {type: csv} or {type: json}",
        });
      }
    } else if (data.format !== undefined) {
      issues.push({ code: "FIG-001", message: "data.format must be an object" });
    }
    if (data.url !== undefined) {
      const plain = normalizeDataUrl(data.url);
      allowedUrl = data.url;
      if (plain === undefined) {
        issues.push({
          code: "FIG-002",
          message:
            "data.url must be a plain relative path under thesis/data/ (no scheme, no .., no absolute path)",
          hint: 'Example: "data.url": "errors.csv".',
        });
      } else if (!dataExtensions.some((extension) => plain.toLowerCase().endsWith(extension))) {
        issues.push({
          code: "FIG-001",
          message: `data.url must point to a .csv or .json file (got ${plain})`,
        });
      } else {
        dataFile = plain;
        if (options.dataFiles && !options.dataFiles.has(plain)) {
          issues.push({
            code: "FIG-001",
            message: `Data file data/${plain} does not exist`,
            hint: "Put the file under thesis/data/.",
          });
        }
      }
      if (data.values !== undefined) {
        issues.push({ code: "FIG-001", message: "data cannot have both url and values" });
      }
    } else if (data.values !== undefined) {
      if (
        !Array.isArray(data.values) ||
        data.values.length > maxRows ||
        !data.values.every(isRecord)
      ) {
        issues.push({
          code: "FIG-001",
          message: `data.values must be a list of up to ${maxRows} objects`,
        });
      }
    } else {
      issues.push({ code: "FIG-001", message: "data needs url or values" });
    }
  }

  walk(spec, [], { issues, allowedUrl });
  // De-duplicate identical findings (the walker and the structure checks can both see a field).
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.code}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { issues: unique, spec, ...(dataFile === undefined ? {} : { dataFile }) };
}

// -----------------------------------------------------------------------------------------------
// Style
// -----------------------------------------------------------------------------------------------

export interface ChartStyle {
  palette: Palette;
  /** CSS font-family list used inside the SVG. */
  fontFamily: string;
}

const fontLists: Record<ResolvedMeta["fontProfile"], string> = {
  serif: "Libertinus Serif, New Computer Modern, serif",
  sans: "Liberation Sans, Arimo, DejaVu Sans, sans-serif",
  institutional: "Libertinus Serif, serif",
};

export function chartStyleFor(
  meta: Pick<ResolvedMeta, "palette" | "fontProfile" | "bodyFont">,
): ChartStyle {
  const stack = fontLists[meta.fontProfile] ?? fontLists.serif;
  return {
    palette: loadPalette(meta.palette),
    fontFamily: meta.bodyFont ? `${meta.bodyFont}, ${stack}` : stack,
  };
}

/** Typst and SVG viewers place 96 user units on one inch, so 1 pt = 4/3 user units. */
const px = (points: number) => Math.round(points * (96 / 72) * 100) / 100;

/** The Vega-Lite `config` injected into every chart (spec 10.5). */
export function chartConfig(style: ChartStyle): Record<string, unknown> {
  const { palette, fontFamily } = style;
  const category = palette.colors.filter((color) => !palette.excludeForLines.includes(color));
  const ink = "#1A1A1A";
  const stroke = px(0.75);
  const text = { font: fontFamily, fontSize: px(9) };
  return {
    background: "#FFFFFF",
    font: fontFamily,
    padding: 6,
    view: { stroke: null },
    mark: { color: category[Math.min(5, category.length - 1)] ?? "#0072B2" },
    axis: {
      labelFont: fontFamily,
      titleFont: fontFamily,
      labelFontSize: px(9),
      titleFontSize: px(9),
      titleFontWeight: "normal",
      labelColor: ink,
      titleColor: ink,
      domainColor: ink,
      tickColor: ink,
      domainWidth: stroke,
      tickWidth: stroke,
      gridWidth: stroke,
      grid: false,
    },
    axisX: { labelAngle: 0, labelOverlap: "parity" },
    axisY: { grid: true, gridColor: "#D9D9D9" },
    legend: {
      labelFont: fontFamily,
      titleFont: fontFamily,
      labelFontSize: px(9),
      titleFontSize: px(9),
      titleFontWeight: "normal",
      labelColor: ink,
      titleColor: ink,
    },
    title: { font: fontFamily, fontSize: px(10), fontWeight: "bold", color: ink },
    text,
    line: { strokeWidth: px(1.1), point: true },
    point: { filled: true, size: 36 },
    range: {
      category,
      ordinal: palette.colors,
      ramp: palette.colors,
      heatmap: palette.colors,
    },
  };
}

// -----------------------------------------------------------------------------------------------
// Data
// -----------------------------------------------------------------------------------------------

/** Resolve `data.url` under the data directory, following symlinks and refusing escapes. */
export async function resolveDataFile(dataDir: string, relative: string): Promise<string> {
  const plain = normalizeDataUrl(relative);
  if (plain === undefined) throw new ChartError("FIG-002", `Data path is not plain: ${relative}`);
  let root: string;
  try {
    root = await realpath(resolve(dataDir));
  } catch {
    throw new ChartError("FIG-001", "The thesis has no data/ folder");
  }
  let real: string;
  try {
    real = await realpath(resolve(root, plain));
  } catch {
    throw new ChartError("FIG-001", `Data file data/${plain} does not exist`);
  }
  if (!real.startsWith(`${root}${sep}`)) {
    throw new ChartError("FIG-002", `Data file data/${plain} resolves outside the data folder`);
  }
  return real;
}

const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** CSV to records. Columns whose every value is a plain number become numbers. */
export function csvToValues(text: string): Record<string, unknown>[] {
  const rows = csvParseRows(text.replace(/^﻿/, ""));
  const [header, ...body] = rows;
  if (!header || header.length === 0) throw new ChartError("FIG-001", "The CSV file is empty");
  if (header.length > maxColumns)
    throw new ChartError("FIG-001", `The CSV file has more than ${maxColumns} columns`);
  if (body.length > maxRows)
    throw new ChartError("FIG-001", `The CSV file has more than ${maxRows} rows`);
  const names = header.map((name) => name.trim());
  if (names.some((name) => name === "") || new Set(names).size !== names.length) {
    throw new ChartError("FIG-001", "CSV column names must be non-empty and unique");
  }
  const numeric = names.map(
    (_, column) =>
      body.every((row) => {
        const cell = (row[column] ?? "").trim();
        return cell === "" || numberPattern.test(cell);
      }) && body.some((row) => (row[column] ?? "").trim() !== ""),
  );
  return body
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) =>
      Object.fromEntries(
        names.map((name, column) => {
          const cell = (row[column] ?? "").trim();
          return [name, numeric[column] ? (cell === "" ? null : Number(cell)) : cell];
        }),
      ),
    );
}

export class ChartError extends Error {
  constructor(
    readonly code: ChartCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------------------------

/** A Vega logger that records warnings and errors; the render fails when any were logged. */
function recordingLogger(problems: string[]): vega.LoggerInterface {
  let level = vega.Warn as number;
  const logger = {
    level(value?: number) {
      if (value === undefined) return level;
      level = value;
      return logger;
    },
    error(...args: unknown[]) {
      problems.push(args.map(String).join(" "));
      return logger;
    },
    warn(...args: unknown[]) {
      problems.push(`warning: ${args.map(String).join(" ")}`);
      return logger;
    },
    info() {
      return logger;
    },
    debug() {
      return logger;
    },
  };
  return logger as unknown as vega.LoggerInterface;
}

/** A loader that refuses everything: data is inlined before compiling, so Vega never fetches. */
const denyAllLoader = {
  async sanitize(uri: string) {
    throw new Error(`blocked external resource ${uri}`);
  },
  async load(uri: string) {
    throw new Error(`blocked external resource ${uri}`);
  },
  async file(path: string) {
    throw new Error(`blocked external resource ${path}`);
  },
  async http(url: string) {
    throw new Error(`blocked external resource ${url}`);
  },
};

export interface ChartInput {
  /** Raw text of the `.vl.json` file. */
  specText: string;
  /** Absolute `data/` directory of the thesis. */
  dataDir: string;
  style: ChartStyle;
}

export interface ChartResult {
  svg: string;
  /** SHA-256 over spec, data and config: the cache key. */
  key: string;
}

/** The inputs of a chart in canonical form, and the cache key derived from them. */
export async function prepareChart(input: ChartInput): Promise<{
  spec: Record<string, unknown>;
  key: string;
}> {
  const checked = checkChartSpec(input.specText);
  const first = checked.issues[0];
  if (first || !checked.spec) {
    throw new ChartError(
      first?.code ?? "FIG-001",
      first?.message ?? "Invalid chart spec",
      first?.hint,
    );
  }
  const spec = structuredClone(checked.spec);
  let dataText = "";
  if (checked.dataFile !== undefined) {
    const file = await resolveDataFile(input.dataDir, checked.dataFile);
    const info = await stat(file);
    if (!info.isFile() || info.size > maxDataBytes) {
      throw new ChartError(
        "FIG-001",
        `Data file data/${checked.dataFile} is not a file or exceeds 5 MB`,
      );
    }
    dataText = await readFile(file, "utf8");
    let values: Record<string, unknown>[];
    if (checked.dataFile.toLowerCase().endsWith(".csv")) values = csvToValues(dataText);
    else {
      let json: unknown;
      try {
        json = JSON.parse(dataText);
      } catch {
        throw new ChartError("FIG-001", `Data file data/${checked.dataFile} is not valid JSON`);
      }
      if (!Array.isArray(json) || json.length > maxRows || !json.every(isRecord)) {
        throw new ChartError(
          "FIG-001",
          `Data file data/${checked.dataFile} must be a JSON list of up to ${maxRows} objects`,
        );
      }
      values = json as Record<string, unknown>[];
    }
    spec.data = { values };
  }
  spec.config = chartConfig(input.style);
  spec.width ??= defaultChartSize.width;
  spec.height ??= defaultChartSize.height;
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        engine: chartEngineTag,
        spec: checked.spec,
        data: dataText,
        config: spec.config,
      }),
    )
    .digest("hex");
  return { spec, key };
}

/** Render a prepared spec to SVG with the interpreter, the deny-all loader and a fatal logger. */
export async function renderPreparedChart(spec: Record<string, unknown>): Promise<string> {
  const problems: string[] = [];
  let vgSpec: vega.Spec;
  try {
    vgSpec = compileVegaLite(spec as unknown as TopLevelSpec, {
      logger: recordingLogger(problems),
    }).spec as unknown as vega.Spec;
  } catch (error) {
    throw new ChartError(
      "FIG-001",
      `Vega-Lite could not compile the chart: ${(error as Error).message}`,
    );
  }
  if (problems.length > 0) {
    throw new ChartError(
      "FIG-001",
      `Vega-Lite reported problems: ${problems.slice(0, 3).join("; ")}`,
    );
  }
  const options = {
    expr: expressionInterpreter,
    loader: denyAllLoader,
    renderer: "none",
    logger: recordingLogger(problems),
  };
  let view: vega.View | undefined;
  try {
    view = new vega.View(vega.parse(vgSpec, undefined, { ast: true }), options as never);
    const svg = await view.toSVG();
    if (problems.length > 0) {
      throw new ChartError("FIG-001", `Vega reported problems: ${problems.slice(0, 3).join("; ")}`);
    }
    return svg;
  } catch (error) {
    if (error instanceof ChartError) throw error;
    throw new ChartError("FIG-001", `The chart could not be rendered: ${(error as Error).message}`);
  } finally {
    view?.finalize();
  }
}

/** Cache directory for rendered chart SVGs. */
export const chartCacheDir = (cacheDir: string): string => join(cacheDir, "charts");

/** Render a chart, reading and writing the SHA-256 keyed cache when a cache directory is given. */
export async function renderChart(input: ChartInput, cacheDir?: string): Promise<ChartResult> {
  const { spec, key } = await prepareChart(input);
  const cached = cacheDir ? join(chartCacheDir(cacheDir), `${key}.svg`) : undefined;
  if (cached) {
    try {
      return { svg: await readFile(cached, "utf8"), key };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const svg = await renderPreparedChart(spec);
  if (cached && cacheDir) {
    await mkdir(chartCacheDir(cacheDir), { recursive: true, mode: 0o700 });
    await writeFile(cached, svg, { mode: 0o600 });
  }
  return { svg, key };
}
