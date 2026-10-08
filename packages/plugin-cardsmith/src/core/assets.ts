import { CardsmithError } from "./errors.js";
import { isHexColor, isPaletteTokenName, type Palette, paletteToken } from "./palettes.js";
import type { PathOp, RectOp, SceneOp } from "./scene.js";

export interface AssetPathOp {
  kind: "path";
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface AssetRectOp {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  radius?: number;
}

export interface AssetCircleOp {
  kind: "circle";
  cx: number;
  cy: number;
  r: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface AssetEllipseOp {
  kind: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Asset drawing primitives. Colors are palette tokens (`$text`, `$decorative`, ...) or hex
 * literals; no external SVG is accepted.
 */
export type AssetOp = AssetPathOp | AssetRectOp | AssetCircleOp | AssetEllipseOp;

/**
 * Fixed discovery vocabulary for illustrations. Tags are lowercase short tokens used by the
 * catalog to group assets; new tags require a deliberate vocabulary change, not free text.
 */
export const ILLUSTRATION_TAGS = [
  "kawaii",
  "birthday",
  "love",
  "formal",
  "technical",
  "decoration",
  "retro",
  "nature",
  "food",
] as const;

export type IllustrationTag = (typeof ILLUSTRATION_TAGS)[number];

export interface IllustrationAsset {
  id: string;
  version: number;
  label?: { es: string; en: string };
  tags?: IllustrationTag[];
  viewBox: [number, number, number, number];
  ops: AssetOp[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolve an asset color: `$token` through the palette, hex literals untouched. */
export function resolveAssetColor(value: string | undefined, palette: Palette): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("$")) {
    const name = value.slice(1);
    if (!isPaletteTokenName(name)) {
      throw new CardsmithError("UNKNOWN_ASSET", `Unknown palette token "${value}"`, {
        token: value,
      });
    }
    return paletteToken(palette.tokens, name);
  }
  if (!isHexColor(value)) {
    throw new CardsmithError(
      "UNKNOWN_ASSET",
      `Asset color "${value}" is neither a palette token nor a #rrggbb color`,
      { color: value },
    );
  }
  return value;
}

/**
 * Expand an illustration into scene ops: uniform "contain" scaling from its viewBox into the
 * target box, centered, with palette tokens resolved. Circles and ellipses become two-arc paths
 * so fill and stroke both survive the conversion.
 */
export function expandIllustration(
  asset: IllustrationAsset,
  box: Box,
  palette: Palette,
): SceneOp[] {
  const [viewX, viewY, viewW, viewH] = asset.viewBox;
  if (!(viewW > 0) || !(viewH > 0)) {
    throw new CardsmithError("INVALID_SPEC", `Asset "${asset.id}" has an empty viewBox`, {
      assetId: asset.id,
      viewBox: asset.viewBox,
    });
  }
  if (!(box.w > 0) || !(box.h > 0) || !Number.isFinite(box.x) || !Number.isFinite(box.y)) {
    throw new CardsmithError("INVALID_SPEC", "Illustration target box is invalid", { box });
  }
  const scale = Math.min(box.w / viewW, box.h / viewH);
  const translateX = box.x + (box.w - viewW * scale) / 2 - viewX * scale;
  const translateY = box.y + (box.h - viewH * scale) / 2 - viewY * scale;

  const ops: SceneOp[] = [];
  for (const op of asset.ops) {
    switch (op.kind) {
      case "path": {
        const sceneOp: PathOp = {
          op: "path",
          d: transformPathData(op.d, scale, translateX, translateY),
        };
        assignFill(sceneOp, op.fill, palette);
        assignStroke(sceneOp, op.stroke, palette);
        if (op.strokeWidth !== undefined) sceneOp.strokeWidth = op.strokeWidth * scale;
        ops.push(sceneOp);
        break;
      }
      case "rect": {
        const sceneOp: RectOp = {
          op: "rect",
          x: op.x * scale + translateX,
          y: op.y * scale + translateY,
          w: op.w * scale,
          h: op.h * scale,
        };
        assignFill(sceneOp, op.fill, palette);
        if (op.radius !== undefined) sceneOp.radius = op.radius * scale;
        ops.push(sceneOp);
        break;
      }
      case "circle": {
        const cx = op.cx * scale + translateX;
        const cy = op.cy * scale + translateY;
        const r = op.r * scale;
        const sceneOp: PathOp = {
          op: "path",
          d: ellipsePath(cx, cy, r, r),
        };
        assignFill(sceneOp, op.fill, palette);
        assignStroke(sceneOp, op.stroke, palette);
        if (op.strokeWidth !== undefined) sceneOp.strokeWidth = op.strokeWidth * scale;
        ops.push(sceneOp);
        break;
      }
      case "ellipse": {
        const cx = op.cx * scale + translateX;
        const cy = op.cy * scale + translateY;
        const rx = op.rx * scale;
        const ry = op.ry * scale;
        const sceneOp: PathOp = {
          op: "path",
          d: ellipsePath(cx, cy, rx, ry),
        };
        assignFill(sceneOp, op.fill, palette);
        assignStroke(sceneOp, op.stroke, palette);
        if (op.strokeWidth !== undefined) sceneOp.strokeWidth = op.strokeWidth * scale;
        ops.push(sceneOp);
        break;
      }
    }
  }
  return ops;
}

function assignFill(target: PathOp | RectOp, value: string | undefined, palette: Palette): void {
  const color = resolveAssetColor(value, palette);
  if (color !== undefined) target.fill = color;
}

function assignStroke(target: PathOp, value: string | undefined, palette: Palette): void {
  const color = resolveAssetColor(value, palette);
  if (color !== undefined) target.stroke = color;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const startX = formatPathNumber(cx - rx);
  const endX = formatPathNumber(cx + rx);
  const y = formatPathNumber(cy);
  const radiusX = formatPathNumber(rx);
  const radiusY = formatPathNumber(ry);
  return `M ${startX} ${y} A ${radiusX} ${radiusY} 0 1 0 ${endX} ${y} A ${radiusX} ${radiusY} 0 1 0 ${startX} ${y} Z`;
}

const PATH_PARAM_COUNTS: Record<string, number> = {
  M: 2,
  m: 2,
  L: 2,
  l: 2,
  H: 1,
  h: 1,
  V: 1,
  v: 1,
  C: 6,
  c: 6,
  S: 4,
  s: 4,
  Q: 4,
  q: 4,
  T: 2,
  t: 2,
  A: 7,
  a: 7,
  Z: 0,
  z: 0,
};

interface PathToken {
  command: string | null;
  value: number;
}

/** Deterministic SVG path number formatting: at most 3 decimals, no exponent, no `-0`. */
export function formatPathNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CardsmithError("INVALID_SPEC", `Path coordinate is not finite: ${value}`);
  }
  const rounded = Math.round(value * 1000) / 1000;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const text = String(normalized);
  if (!text.includes("e")) return text;
  return normalized.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * Scale and translate SVG path data. Absolute commands move their coordinates; relative commands
 * scale their deltas. Uniform scale leaves x-axis rotation untouched. Unsupported syntax is
 * rejected instead of guessed.
 */
export function transformPathData(
  d: string,
  scale: number,
  translateX: number,
  translateY: number,
): string {
  if (typeof d !== "string" || d.trim() === "") {
    throw new CardsmithError("INVALID_SPEC", "Path data must be a non-empty string");
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new CardsmithError("INVALID_SPEC", `Path scale must be positive: ${scale}`);
  }
  const tokens = tokenizePath(d);
  const output: string[] = [];
  let command: string | null = null;
  let values: number[] = [];

  const flush = (): void => {
    if (command === null) {
      if (values.length > 0) {
        throw new CardsmithError("INVALID_SPEC", "Path data has numbers before a command", { d });
      }
      return;
    }
    const expected = PATH_PARAM_COUNTS[command] ?? -1;
    if (values.length === 0) {
      if (expected === 0) output.push(command);
      return;
    }
    if (values.length !== expected) {
      throw new CardsmithError(
        "INVALID_SPEC",
        `Path command "${command}" expected ${expected} parameters, got ${values.length}`,
        { command, d },
      );
    }
    emitCommand(command, values, scale, translateX, translateY, output);
    values = [];
  };

  for (const token of tokens) {
    if (token.command !== null) {
      flush();
      command = token.command;
      values = [];
      continue;
    }
    if (command === null) {
      throw new CardsmithError("INVALID_SPEC", "Path data has numbers before a command", { d });
    }
    values.push(token.value);
    const expected = PATH_PARAM_COUNTS[command] ?? -1;
    if (expected === 0) {
      throw new CardsmithError(
        "INVALID_SPEC",
        `Path command "${command}" does not take parameters`,
        { command, d },
      );
    }
    if (values.length === expected) {
      flush();
      if (command === "M") command = "L";
      else if (command === "m") command = "l";
    }
  }
  flush();
  return output.join(" ");
}

function tokenizePath(d: string): PathToken[] {
  const tokens: PathToken[] = [];
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let lastIndex = 0;
  let match = pattern.exec(d);
  while (match !== null) {
    if (!/^[\s,]*$/.test(d.slice(lastIndex, match.index))) {
      throw new CardsmithError("INVALID_SPEC", `Path data has invalid syntax near "${match[0]}"`, {
        d,
      });
    }
    lastIndex = pattern.lastIndex;
    const command = match[1];
    const number = match[2];
    if (command !== undefined) {
      tokens.push({ command, value: 0 });
    } else if (number !== undefined) {
      tokens.push({ command: null, value: Number(number) });
    }
    match = pattern.exec(d);
  }
  if (!/^[\s,]*$/.test(d.slice(lastIndex))) {
    throw new CardsmithError("INVALID_SPEC", "Path data has trailing invalid syntax", { d });
  }
  return tokens;
}

function emitCommand(
  command: string,
  values: number[],
  scale: number,
  translateX: number,
  translateY: number,
  output: string[],
): void {
  const scaled = (value: number): string => formatPathNumber(value * scale);
  const moved = (value: number, axis: "x" | "y"): string =>
    formatPathNumber(value * scale + (axis === "x" ? translateX : translateY));
  const number = (value: number): string => formatPathNumber(value);
  const flag = (value: number): string => {
    if (value !== 0 && value !== 1) {
      throw new CardsmithError("INVALID_SPEC", `Arc flag must be 0 or 1, got ${value}`);
    }
    return String(value);
  };
  const value = (index: number): number => values[index] ?? 0;

  switch (command) {
    case "L":
      output.push(command, moved(value(0), "x"), moved(value(1), "y"));
      break;
    case "l":
      output.push(command, scaled(value(0)), scaled(value(1)));
      break;
    case "H":
      output.push(command, moved(value(0), "x"));
      break;
    case "h":
      output.push(command, scaled(value(0)));
      break;
    case "V":
      output.push(command, moved(value(0), "y"));
      break;
    case "v":
      output.push(command, scaled(value(0)));
      break;
    case "C":
      output.push(
        command,
        moved(value(0), "x"),
        moved(value(1), "y"),
        moved(value(2), "x"),
        moved(value(3), "y"),
        moved(value(4), "x"),
        moved(value(5), "y"),
      );
      break;
    case "c":
      output.push(
        command,
        scaled(value(0)),
        scaled(value(1)),
        scaled(value(2)),
        scaled(value(3)),
        scaled(value(4)),
        scaled(value(5)),
      );
      break;
    case "S":
      output.push(
        command,
        moved(value(0), "x"),
        moved(value(1), "y"),
        moved(value(2), "x"),
        moved(value(3), "y"),
      );
      break;
    case "s":
      output.push(command, scaled(value(0)), scaled(value(1)), scaled(value(2)), scaled(value(3)));
      break;
    case "Q":
      output.push(
        command,
        moved(value(0), "x"),
        moved(value(1), "y"),
        moved(value(2), "x"),
        moved(value(3), "y"),
      );
      break;
    case "q":
      output.push(command, scaled(value(0)), scaled(value(1)), scaled(value(2)), scaled(value(3)));
      break;
    case "T":
      output.push(command, moved(value(0), "x"), moved(value(1), "y"));
      break;
    case "t":
      output.push(command, scaled(value(0)), scaled(value(1)));
      break;
    case "A":
      output.push(
        command,
        scaled(value(0)),
        scaled(value(1)),
        number(value(2)),
        flag(value(3)),
        flag(value(4)),
        moved(value(5), "x"),
        moved(value(6), "y"),
      );
      break;
    case "a":
      output.push(
        command,
        scaled(value(0)),
        scaled(value(1)),
        number(value(2)),
        flag(value(3)),
        flag(value(4)),
        scaled(value(5)),
        scaled(value(6)),
      );
      break;
    case "M":
      output.push(command, moved(value(0), "x"), moved(value(1), "y"));
      break;
    case "m":
      output.push(command, scaled(value(0)), scaled(value(1)));
      break;
    case "Z":
    case "z":
      output.push(command);
      break;
    default:
      throw new CardsmithError("INVALID_SPEC", `Unsupported path command "${command}"`);
  }
}
