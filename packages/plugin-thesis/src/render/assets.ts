import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureInside, resolveInside } from "../storage.js";
import type { Finding } from "../types.js";
import { ChartError, chartStyleFor, prepareChart, renderPreparedChart } from "./charts.js";
import type {
  FigureAsset,
  FigureAssetKind,
  ResolvedAsset,
  ResolvedMeta,
  ThesisDocument,
} from "./model.js";
import { allSections, walkBlocks } from "./walk.js";

/**
 * Format-neutral asset services (spec 10.0): every figure source is read through the thesis-root
 * path guard, validated, and materialized into the build directory under a content-addressed name.
 * Adapters then reference `asset.resolved.file`; none of them touches the workspace.
 */

export interface AssetContext {
  /** Absolute thesis root. */
  root: string;
  /** Absolute build directory. */
  buildDir: string;
  /** Absolute cache directory for expensive derived assets (charts). */
  cacheDir: string;
  /** Presentation inputs for derived assets (chart palette and fonts). */
  meta?: Pick<ResolvedMeta, "palette" | "fontProfile" | "bodyFont">;
}

export type AssetFailure = { error: string; hint?: string; code?: string };
export type AssetResolver = (
  asset: FigureAsset,
  context: AssetContext,
) => Promise<ResolvedAsset | AssetFailure>;

const limits: Record<FigureAssetKind, number> = {
  mermaid: 100 * 1024,
  svg: 5 * 1024 * 1024,
  raster: 20 * 1024 * 1024,
  chart: 1024 * 1024,
};

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

async function readGuarded(
  asset: FigureAsset,
  context: AssetContext,
): Promise<{ bytes: Buffer } | AssetFailure> {
  let absolute: string;
  try {
    absolute = resolveInside(context.root, asset.path);
    await ensureInside(context.root, absolute);
  } catch {
    return { error: `Figure path ${asset.path} is outside the thesis folder` };
  }
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { error: `Figure ${asset.path} is not a file` };
    if (info.size > limits[asset.kind]) {
      return {
        error: `Figure ${asset.path} is larger than ${Math.round(limits[asset.kind] / 1024)} KB`,
      };
    }
    return { bytes: await readFile(absolute) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `Figure file ${asset.path} does not exist` };
    }
    throw error;
  }
}

async function materialize(
  context: AssetContext,
  name: string,
  data: Uint8Array | string,
): Promise<string> {
  const relative = `figures/${name}`;
  const target = join(context.buildDir, relative);
  await mkdir(join(context.buildDir, "figures"), { recursive: true, mode: 0o700 });
  // Content-addressed names make an existing file already correct: this is the asset cache.
  try {
    await stat(target);
    return relative;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(target, data, { mode: 0o600 });
  return relative;
}

const isFailure = (value: unknown): value is AssetFailure =>
  typeof value === "object" && value !== null && "error" in value;

const mermaid: AssetResolver = async (asset, context) => {
  const read = await readGuarded(asset, context);
  if (isFailure(read)) return read;
  const text = read.bytes.toString("utf8");
  if (text.trim() === "" || text.includes("\0"))
    return { error: `Diagram ${asset.path} is empty or binary` };
  const hash = sha256(read.bytes);
  const file = await materialize(context, `${hash.slice(0, 16)}.mmd`, read.bytes);
  return { file, sha256: hash, bytes: read.bytes.length, format: "mmd", text };
};

/** Natural size of an SVG in points (96 user units per inch), when its root declares plain numbers. */
function svgSize(text: string): { widthPt: number; heightPt: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!root) return undefined;
  const read = (name: string) => {
    const match = new RegExp(`\\s${name}\\s*=\\s*["']([0-9.]+)(?:px)?["']`, "i").exec(root);
    return match ? Number(match[1]) : undefined;
  };
  const width = read("width");
  const height = read("height");
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { widthPt: Math.round(width * 75) / 100, heightPt: Math.round(height * 75) / 100 };
}

/** Why an SVG text is unsafe for embedding, or undefined when it is fine. */
function svgProblem(text: string): string | undefined {
  if (!/<svg[\s>]/.test(text)) return "not an SVG document";
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return "declares a DOCTYPE or entity";
  if (/<script|<foreignObject|javascript:/i.test(text))
    return "contains scripts or foreign content";
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const target = match[1] ?? "";
    if (!target.startsWith("#") && !/^data:image\/(?:png|jpe?g|svg\+xml);/i.test(target)) {
      return "references an external resource";
    }
  }
  return undefined;
}

const svg: AssetResolver = async (asset, context) => {
  const read = await readGuarded(asset, context);
  if (isFailure(read)) return read;
  const text = read.bytes.toString("utf8");
  const problem = svgProblem(text);
  if (problem === "not an SVG document") return { error: `${asset.path} is not an SVG document` };
  if (problem === "declares a DOCTYPE or entity")
    return {
      error: `${asset.path} declares a DOCTYPE or entity`,
      hint: "Remove the DTD from the SVG.",
    };
  if (problem === "contains scripts or foreign content")
    return { error: `${asset.path} contains scripts or foreign content` };
  if (problem)
    return {
      error: `${asset.path} references an external resource`,
      hint: "Embed images as data URIs.",
    };
  const hash = sha256(read.bytes);
  const file = await materialize(context, `${hash.slice(0, 16)}.svg`, read.bytes);
  const size = svgSize(text);
  return { file, sha256: hash, bytes: read.bytes.length, format: "svg", ...(size ? { size } : {}) };
};

const raster: AssetResolver = async (asset, context) => {
  const read = await readGuarded(asset, context);
  if (isFailure(read)) return read;
  const { bytes } = read;
  const png =
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpg) return { error: `${asset.path} is not a PNG or JPEG image` };
  const format = png ? "png" : "jpg";
  const hash = sha256(bytes);
  const file = await materialize(context, `${hash.slice(0, 16)}.${format}`, bytes);
  return { file, sha256: hash, bytes: bytes.length, format };
};

/** Vega-Lite chart: validated, rendered to SVG with the palette/font profile and cached by hash. */
const chart: AssetResolver = async (asset, context) => {
  const read = await readGuarded(asset, context);
  if (isFailure(read)) return { ...read, code: "FIG-001" };
  const style = chartStyleFor(
    context.meta ?? { palette: "okabe-ito", fontProfile: "serif", bodyFont: null },
  );
  try {
    const input = {
      specText: read.bytes.toString("utf8"),
      dataDir: join(context.root, "data"),
      style,
    };
    const { spec, key } = await prepareChart(input);
    const cached = join(context.cacheDir, "charts", `${key}.svg`);
    let svg: string | undefined;
    try {
      svg = await readFile(cached, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (svg === undefined) {
      svg = await renderPreparedChart(spec);
      await mkdir(join(context.cacheDir, "charts"), { recursive: true, mode: 0o700 });
      await writeFile(cached, svg, { mode: 0o600 });
    }
    const unsafe = svgProblem(svg);
    if (unsafe)
      return { error: `Chart ${asset.path} produced an unsafe SVG: ${unsafe}`, code: "FIG-002" };
    const hash = sha256(svg);
    const file = await materialize(context, `${hash.slice(0, 16)}.svg`, svg);
    const size = svgSize(svg);
    return {
      file,
      sha256: hash,
      bytes: Buffer.byteLength(svg),
      format: "svg",
      ...(size ? { size } : {}),
    };
  } catch (error) {
    if (error instanceof ChartError) {
      return {
        error: `${asset.path}: ${error.message}`,
        ...(error.hint ? { hint: error.hint } : {}),
        code: error.code,
      };
    }
    throw error;
  }
};

export const defaultAssetResolvers: Record<FigureAssetKind, AssetResolver> = {
  mermaid,
  svg,
  raster,
  chart,
};

/** Resolve every figure asset of a document in place; returns BLD-002 findings for failures. */
export async function resolveAssets(
  doc: ThesisDocument,
  context: AssetContext,
  resolvers: Record<FigureAssetKind, AssetResolver> = defaultAssetResolvers,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const done = new Map<string, ResolvedAsset | AssetFailure>();
  for (const section of allSections(doc)) {
    const figures: { asset: FigureAsset; line: number | undefined }[] = [];
    walkBlocks(section.blocks, (block) => {
      if (block.kind === "figure") figures.push({ asset: block.asset, line: block.line });
    });
    for (const { asset, line } of figures) {
      const key = `${asset.kind}:${asset.path}`;
      let result = done.get(key);
      if (!result) {
        result = await resolvers[asset.kind](asset, context);
        done.set(key, result);
      }
      if (isFailure(result)) {
        findings.push({
          code: result.code ?? "BLD-002",
          gate: "G8",
          severity: "error",
          file: section.path,
          ...(line === undefined ? {} : { line }),
          message: result.error,
          ...(result.hint ? { hint: result.hint } : {}),
        });
      } else asset.resolved = result;
    }
  }
  return findings;
}
