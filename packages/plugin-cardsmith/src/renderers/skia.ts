import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { CardsmithError } from "../core/errors.js";
import { assertRenderBudget, QR_MIN_MODULE_PX, QR_QUIET_ZONE_MODULES } from "../core/limits.js";
import type {
  ImageOp,
  PathOp,
  QrOp,
  RectOp,
  Scene,
  SceneOp,
  TextCurve,
  TextOp,
} from "../core/scene.js";
import type { ResolvedFont } from "../core/typography.js";
import type { CanvasImage } from "./image-input.js";
import { parsePath, toBezierPath } from "./svg-path.js";

export const RENDERER_VERSION = "1.0.0";

export interface RenderOptions {
  format: "png" | "jpeg";
  jpegQuality?: number;
  scale?: number;
  images?: Map<string, CanvasImage>;
  signal?: AbortSignal;
}

export interface RenderedImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  scale: number;
}

interface DrawContext {
  images: Map<string, CanvasImage> | undefined;
  signal: AbortSignal | undefined;
  /** Logical scene dimensions; the default pivot when a group rotates without `rotateX/Y`. */
  sceneWidth: number;
  sceneHeight: number;
}

/**
 * Resolve a path inside the package from this module. `resource-paths.ts` assumes a module exactly
 * one level below the package root; this module sits in `src/renderers` (and `dist/renderers`),
 * so the same relative walk keeps working in the source tree, the build and a packed tarball.
 */
function packageResource(...segments: string[]): string {
  return fileURLToPath(new URL(`../../${segments.join("/")}`, import.meta.url));
}

interface FontRoleRecord {
  alias?: unknown;
  file?: unknown;
}

function collectFontRoles(): Map<string, string> {
  const path = packageResource("resources", "font-pairs.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CardsmithError("RENDER_FAILED", "Font pair resource could not be read", {
      file: path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const roles = new Map<string, string>();
  if (Array.isArray(parsed)) {
    for (const pair of parsed) {
      if (typeof pair !== "object" || pair === null) continue;
      const pairRoles = (pair as { roles?: unknown }).roles;
      if (typeof pairRoles !== "object" || pairRoles === null) continue;
      for (const role of Object.values(pairRoles as Record<string, unknown>)) {
        if (typeof role !== "object" || role === null) continue;
        const { alias, file } = role as FontRoleRecord;
        if (typeof alias === "string" && alias !== "" && typeof file === "string" && file !== "") {
          if (!roles.has(alias)) roles.set(alias, file);
        }
      }
    }
  }
  if (roles.size === 0) {
    throw new CardsmithError("RENDER_FAILED", "Font pair resource declares no font roles", {
      file: path,
    });
  }
  return roles;
}

let fontsRegistered = false;

/**
 * Register every TTF referenced by a `font-pairs.json` role under its alias. Idempotent: once a
 * registration pass succeeds it is skipped, and aliases already known to Skia are left alone.
 * Missing files or failed registrations throw `RENDER_FAILED` with `{ file, alias }` details.
 */
export function registerFonts(): void {
  if (fontsRegistered) return;
  const roles = collectFontRoles();
  const directory = packageResource("resources", "fonts");
  for (const alias of [...roles.keys()].sort()) {
    if (GlobalFonts.has(alias)) continue;
    const file = roles.get(alias) ?? "";
    const path = join(directory, file);
    let registered: ReturnType<typeof GlobalFonts.registerFromPath>;
    try {
      registered = GlobalFonts.registerFromPath(path, alias);
    } catch (error) {
      throw new CardsmithError(
        "RENDER_FAILED",
        `Font "${file}" could not be registered as "${alias}"`,
        { file, alias, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (registered === null) {
      throw new CardsmithError(
        "RENDER_FAILED",
        `Font "${file}" could not be registered as "${alias}"`,
        { file, alias },
      );
    }
  }
  fontsRegistered = true;
}

function abortFailure(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason !== undefined ? reason : new DOMException("Aborted", "AbortError");
}

function fontString(font: ResolvedFont, sizePx: number): string {
  return `${font.weight} ${sizePx}px "${font.alias}"`;
}

function clampAlpha(alpha: number | undefined): number {
  if (alpha === undefined || !Number.isFinite(alpha)) return 1;
  return Math.min(1, Math.max(0, alpha));
}

function hasRoundRect(ctx: SKRSContext2D): boolean {
  return typeof (ctx as { roundRect?: unknown }).roundRect === "function";
}

/** Rounded rectangle fallback built from arcs, used when `roundRect` is unavailable. */
function roundedRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawRect(ctx: SKRSContext2D, op: RectOp): void {
  if (op.fill === undefined) return;
  if (!(op.w > 0) || !(op.h > 0)) return;
  ctx.fillStyle = op.fill;
  ctx.beginPath();
  const requested = op.radius ?? 0;
  const radius = Number.isFinite(requested)
    ? Math.min(Math.max(0, requested), Math.min(op.w, op.h) / 2)
    : 0;
  if (radius > 0) {
    if (hasRoundRect(ctx)) ctx.roundRect(op.x, op.y, op.w, op.h, radius);
    else roundedRectPath(ctx, op.x, op.y, op.w, op.h, radius);
  } else {
    ctx.rect(op.x, op.y, op.w, op.h);
  }
  ctx.fill();
}

function drawPath(ctx: SKRSContext2D, op: PathOp): void {
  const subpaths = toBezierPath(parsePath(op.d));
  ctx.beginPath();
  for (const subpath of subpaths) {
    ctx.moveTo(subpath.x, subpath.y);
    for (const segment of subpath.segments) {
      ctx.bezierCurveTo(
        segment.cp1x,
        segment.cp1y,
        segment.cp2x,
        segment.cp2y,
        segment.x,
        segment.y,
      );
    }
    if (subpath.closed) ctx.closePath();
  }
  if (op.fill !== undefined) {
    ctx.fillStyle = op.fill;
    ctx.fill();
  }
  if (op.stroke !== undefined) {
    ctx.strokeStyle = op.stroke;
    ctx.lineWidth = op.strokeWidth ?? 1;
    ctx.stroke();
  }
}

function drawImageOp(
  ctx: SKRSContext2D,
  op: ImageOp,
  images: Map<string, CanvasImage> | undefined,
): void {
  const image = images?.get(op.ref);
  if (image === undefined) {
    throw new CardsmithError("UNKNOWN_ASSET", `Unknown image ref "${op.ref}"`, { ref: op.ref });
  }
  if (!(op.w > 0) || !(op.h > 0)) return;
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new CardsmithError("RENDER_FAILED", `Image "${op.ref}" has empty dimensions`, {
      ref: op.ref,
      width: sourceWidth,
      height: sourceHeight,
    });
  }
  if (op.round === "circle") {
    ctx.beginPath();
    ctx.ellipse(op.x + op.w / 2, op.y + op.h / 2, op.w / 2, op.h / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  }
  const fit = op.fit ?? "cover";
  if (fit === "stretch") {
    ctx.drawImage(image, op.x, op.y, op.w, op.h);
    return;
  }
  if (fit === "contain") {
    const scale = Math.min(op.w / sourceWidth, op.h / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    ctx.drawImage(image, op.x + (op.w - width) / 2, op.y + (op.h - height) / 2, width, height);
    return;
  }
  const scale = Math.max(op.w / sourceWidth, op.h / sourceHeight);
  const cropWidth = op.w / scale;
  const cropHeight = op.h / scale;
  ctx.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    op.x,
    op.y,
    op.w,
    op.h,
  );
}

function drawText(ctx: SKRSContext2D, op: TextOp): void {
  if (op.curve !== undefined) {
    drawCurvedText(ctx, op, op.curve);
    return;
  }
  if (op.lines.length === 0) return;
  ctx.font = fontString(op.font, op.sizePx);
  ctx.fillStyle = op.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = op.align ?? "left";
  const lineHeight = op.lineHeight;
  const blockHeight = op.lines.length * lineHeight;
  const top =
    op.valign === "middle"
      ? op.y - blockHeight / 2
      : op.valign === "bottom"
        ? op.y - blockHeight
        : op.y;
  for (let index = 0; index < op.lines.length; index += 1) {
    ctx.fillText(op.lines[index] ?? "", op.x, top + index * lineHeight + lineHeight / 2);
  }
}

/**
 * Curved text draws the graphemes of `text` along the arc instead of the fitted `lines`; callers
 * reserve it for short phrases. Angles are degrees with 0 at 3 o'clock growing clockwise; the
 * arc sweep follows the sign of `endAngle - startAngle`. Outside text sits on the outside of the
 * radius, inside text flips so glyphs extend toward the center.
 */
function drawCurvedText(ctx: SKRSContext2D, op: TextOp, curve: TextCurve): void {
  if (!(op.sizePx > 0) || !(curve.radius > 0)) return;
  const graphemes = Array.from(op.text);
  if (graphemes.length === 0) return;
  const span = ((curve.endAngle - curve.startAngle) * Math.PI) / 180;
  if (span === 0) return;
  ctx.font = fontString(op.font, op.sizePx);
  ctx.fillStyle = op.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const widths = graphemes.map((grapheme) => ctx.measureText(grapheme).width);
  let total = 0;
  for (const width of widths) total += width;
  if (!(total > 0)) return;
  const direction = span > 0 ? 1 : -1;
  const anglePerPx = span / total;
  const baseRotation = curve.side === "inside" ? -Math.PI / 2 : Math.PI / 2;
  let angle = (curve.startAngle * Math.PI) / 180;
  for (let index = 0; index < graphemes.length; index += 1) {
    const width = widths[index] ?? 0;
    const centerAngle = angle + direction * (width / 2) * anglePerPx;
    const x = curve.cx + curve.radius * Math.cos(centerAngle);
    const y = curve.cy + curve.radius * Math.sin(centerAngle);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(centerAngle + baseRotation);
    ctx.fillText(graphemes[index] ?? "", 0, 0);
    ctx.restore();
    angle += direction * width * anglePerPx;
  }
}

function drawQr(ctx: SKRSContext2D, op: QrOp): void {
  const moduleCount = op.matrix.length;
  const totalModules = moduleCount + 2 * QR_QUIET_ZONE_MODULES;
  const modulePx = Math.floor(op.boxSize / totalModules);
  if (modulePx < QR_MIN_MODULE_PX) {
    throw new CardsmithError(
      "QR_TOO_DENSE",
      `QR needs ${totalModules} modules but the box only allows ${modulePx}px per module`,
      { boxSize: op.boxSize, moduleCount, modulePx, minModulePx: QR_MIN_MODULE_PX },
    );
  }
  ctx.fillStyle = op.light;
  ctx.fillRect(op.x, op.y, op.boxSize, op.boxSize);
  ctx.fillStyle = op.dark;
  for (let row = 0; row < moduleCount; row += 1) {
    const modules = op.matrix[row];
    if (modules === undefined) continue;
    for (let column = 0; column < moduleCount; column += 1) {
      if (modules[column] !== true) continue;
      ctx.fillRect(
        op.x + (column + QR_QUIET_ZONE_MODULES) * modulePx,
        op.y + (row + QR_QUIET_ZONE_MODULES) * modulePx,
        modulePx,
        modulePx,
      );
    }
  }
}

function drawOp(ctx: SKRSContext2D, op: SceneOp, context: DrawContext): void {
  ctx.save();
  const alpha = "alpha" in op ? op.alpha : undefined;
  if (alpha !== undefined) ctx.globalAlpha = clampAlpha(alpha);
  switch (op.op) {
    case "rect":
      drawRect(ctx, op);
      break;
    case "path":
      drawPath(ctx, op);
      break;
    case "image":
      drawImageOp(ctx, op, context.images);
      break;
    case "text":
      drawText(ctx, op);
      break;
    case "qr":
      drawQr(ctx, op);
      break;
    case "group": {
      ctx.translate(op.translateX ?? 0, op.translateY ?? 0);
      if (op.rotateDeg !== undefined && Number.isFinite(op.rotateDeg) && op.rotateDeg % 360 !== 0) {
        const pivotX = op.rotateX ?? context.sceneWidth / 2;
        const pivotY = op.rotateY ?? context.sceneHeight / 2;
        ctx.translate(pivotX, pivotY);
        ctx.rotate((op.rotateDeg * Math.PI) / 180);
        ctx.translate(-pivotX, -pivotY);
      }
      for (const child of op.children) {
        if (context.signal?.aborted === true) throw abortFailure(context.signal);
        drawOp(ctx, child, context);
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Render a scene to PNG or JPEG bytes with Skia. The scene dimensions are checked against the
 * render budget before any canvas is allocated. `scale` defaults to 1 and may only shrink
 * (preview): logical dimensions become `round(width * scale) x round(height * scale)` and the
 * context is scaled so ops keep their logical coordinates. Output carries no timestamps.
 */
export async function renderScene(scene: Scene, options: RenderOptions): Promise<RenderedImage> {
  registerFonts();
  assertRenderBudget(scene.width, scene.height);
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new CardsmithError("INVALID_SPEC", "Render scale must be within (0, 1]", { scale });
  }
  const quality = options.jpegQuality ?? 90;
  if (options.format === "jpeg" && (!Number.isFinite(quality) || quality <= 0 || quality > 100)) {
    throw new CardsmithError("INVALID_SPEC", "JPEG quality must be within (0, 100]", {
      jpegQuality: options.jpegQuality,
    });
  }

  const width = Math.max(1, Math.round(scene.width * scale));
  const height = Math.max(1, Math.round(scene.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale);

  const context: DrawContext = {
    images: options.images,
    signal: options.signal,
    sceneWidth: scene.width,
    sceneHeight: scene.height,
  };
  for (const op of scene.ops) {
    if (context.signal?.aborted === true) throw abortFailure(context.signal);
    drawOp(ctx, op, context);
  }
  if (context.signal?.aborted === true) throw abortFailure(context.signal);

  if (options.format === "jpeg") {
    const buffer = canvas.toBuffer("image/jpeg", quality);
    return { bytes: new Uint8Array(buffer), mimeType: "image/jpeg", width, height, scale };
  }
  const buffer = canvas.toBuffer("image/png");
  return { bytes: new Uint8Array(buffer), mimeType: "image/png", width, height, scale };
}
