import { type Box, expandIllustration } from "./assets.js";
import type { NormalizedSpec } from "./design-spec.js";
import { CardsmithError } from "./errors.js";
import { type Palette, paletteToken } from "./palettes.js";
import { buildQrOp, type QrBuildOptions } from "./qr.js";
import type { LayoutKey, Registry, SlotSpec, Template } from "./registry.js";
import type { Scene, SceneOp, TextCurve, TextOp } from "./scene.js";
import type { SizePreset } from "./sizes.js";
import { fitText, type ResolvedFont, resolveRole, type TextMeasurer } from "./typography.js";

export interface ComposeDependencies {
  measurer: TextMeasurer;
}

export interface ComposeResult {
  scene: Scene;
  warnings: string[];
}

/** Base composition unit: `u = min(width, height) / 100`; base margin is 6u. */
export function baseMarginPx(width: number, height: number): number {
  return 6 * (Math.min(width, height) / 100);
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

function contentFrame(size: SizePreset): Frame {
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

function fullCanvas(size: SizePreset): Frame {
  return { x: 0, y: 0, w: size.width, h: size.height };
}

function boxPx(box: Box, frame: Frame): Box {
  return {
    x: frame.x + box.x * frame.w,
    y: frame.y + box.y * frame.h,
    w: box.w * frame.w,
    h: box.h * frame.h,
  };
}

function requireToken(value: string): string {
  if (!value.startsWith("$")) {
    throw new CardsmithError("INVALID_SPEC", `Color must be a "$token", got "${value}"`, {
      value,
    });
  }
  return value.slice(1);
}

function slotDefaultSizePx(role: SlotSpec["role"], canvasHeight: number): number {
  switch (role) {
    case "display":
      return canvasHeight * 0.09;
    case "bodyStrong":
      return canvasHeight * 0.045;
    case "body":
      return canvasHeight * 0.04;
  }
}

function slotDefaultMaxLines(role: SlotSpec["role"]): number {
  return role === "body" ? 6 : 4;
}

function slotText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join("\n");
  }
  return null;
}

function lookupAsset(registry: Registry, assetId: string, templateId: string) {
  try {
    return registry.illustration(assetId);
  } catch {
    throw new CardsmithError(
      "UNKNOWN_ASSET",
      `Template "${templateId}" references unknown asset "${assetId}"`,
      {
        templateId,
        assetId,
      },
    );
  }
}

function composeTextSlot(
  template: Template,
  slot: SlotSpec,
  spec: NormalizedSpec,
  palette: Palette,
  size: SizePreset,
  frame: Frame,
  registry: Registry,
  measurer: TextMeasurer,
  warnings: string[],
): TextOp | null {
  const value = spec.content[slot.key];
  if (value === undefined) return null;
  const text = slotText(value);
  if (text === null) {
    warnings.push(`field "${slot.key}" has no text rendering and was skipped`);
    return null;
  }

  const font: ResolvedFont = resolveRole(registry.fontPair(spec.fontPairId), slot.role);
  const color = paletteToken(palette.tokens, requireToken(slot.color ?? "$text"));
  const maxSize = Math.max(
    1,
    slot.maxSizePct !== undefined
      ? (slot.maxSizePct / 100) * size.height
      : (slot.size ?? slotDefaultSizePx(slot.role, size.height)),
  );
  const minSize = Math.max(1, Math.min(Math.round(maxSize), Math.round(maxSize * 0.25)));
  const box = boxPx(slot.box, frame);
  const fitted = fitText(
    {
      text,
      font,
      maxWidth: box.w,
      maxHeight: box.h,
      maxSize: Math.round(maxSize),
      minSize,
      maxLines: slot.maxLines ?? slotDefaultMaxLines(slot.role),
      lineHeightRatio: slot.lineHeightRatio ?? 1.25,
      breakPolicy: "word-then-char",
    },
    measurer,
  );

  if (fitted.overflow) {
    const overflow = template.fields.find((field) => field.key === slot.key)?.overflow ?? "error";
    if (overflow === "error") {
      throw new CardsmithError(
        "TEXT_OVERFLOW",
        `field "${slot.key}" does not fit its box even at ${fitted.sizePx}px`,
        {
          templateId: template.id,
          field: slot.key,
          sizePx: fitted.sizePx,
          lines: fitted.lines.length,
          box: { ...box },
        },
      );
    }
    warnings.push(
      `text overflow in field "${slot.key}" at ${fitted.sizePx}px; full text preserved`,
    );
  }

  const align = slot.align ?? "left";
  const valign = slot.valign ?? "top";
  const x = align === "left" ? box.x : align === "center" ? box.x + box.w / 2 : box.x + box.w;
  const y = valign === "top" ? box.y : valign === "middle" ? box.y + box.h / 2 : box.y + box.h;
  const op: TextOp = {
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
    maxWidth: box.w,
  };
  if (slot.curve !== undefined) {
    const curve: TextCurve = {
      cx: frame.x + slot.curve.cx * frame.w,
      cy: frame.y + slot.curve.cy * frame.h,
      radius: slot.curve.radius * Math.min(frame.w, frame.h),
      startAngle: slot.curve.startAngle,
      endAngle: slot.curve.endAngle,
      side: slot.curve.side,
    };
    op.curve = curve;
  }
  return op;
}

/**
 * Deterministic compose interpreter: `(template, layout, spec, palette, resources)` in, scene out.
 * Op order is background, decor, illustration, QR, text; the QR is drawn after illustration so it
 * is never covered. Content zones (text, illustration, QR) honor the size safe area; decor and
 * background are full-bleed. No clock, no randomness: a seed does not alter the scene in WU2.
 */
export function composeScene(
  template: Template,
  layoutKey: LayoutKey,
  spec: NormalizedSpec,
  palette: Palette,
  registry: Registry,
  deps: ComposeDependencies,
): ComposeResult {
  const layout = template.layouts[layoutKey];
  if (layout === undefined) {
    throw new CardsmithError(
      "INVALID_SPEC",
      `template "${template.id}" has no "${layoutKey}" layout`,
      { templateId: template.id, layoutKey },
    );
  }
  const size = registry.size(spec.sizeId);
  const frame = contentFrame(size);
  const warnings: string[] = [];
  const ops: SceneOp[] = [];

  const background = paletteToken(palette.tokens, requireToken(layout.background ?? "$background"));
  const scene: Scene = { width: size.width, height: size.height, background, ops };

  for (const decor of layout.decor ?? []) {
    const asset = lookupAsset(registry, decor.assetId, template.id);
    ops.push(...expandIllustration(asset, boxPx(decor.box, fullCanvas(size)), palette));
  }

  const illustrationId = spec.illustrationId ?? layout.illustration?.defaultId;
  if (illustrationId !== undefined) {
    if (layout.illustration === undefined) {
      warnings.push(
        `illustration "${illustrationId}" has no slot in template "${template.id}" layout "${layoutKey}" and was skipped`,
      );
    } else {
      const asset = lookupAsset(registry, illustrationId, template.id);
      ops.push(...expandIllustration(asset, boxPx(layout.illustration.box, frame), palette));
    }
  }

  if (spec.qr !== undefined) {
    if (layout.qr === undefined) {
      warnings.push(
        `qr has no slot in template "${template.id}" layout "${layoutKey}" and was skipped`,
      );
    } else {
      const qrBox = boxPx(layout.qr.box, frame);
      const options: QrBuildOptions = { palette };
      if (spec.qr.ecc !== undefined) options.ecc = spec.qr.ecc;
      const op = buildQrOp(spec.qr.payload, Math.min(qrBox.w, qrBox.h), options);
      ops.push({
        ...op,
        x: Math.round(qrBox.x + (qrBox.w - op.boxSize) / 2),
        y: Math.round(qrBox.y + (qrBox.h - op.boxSize) / 2),
      });
    }
  }

  for (const slot of layout.slots) {
    const op = composeTextSlot(
      template,
      slot,
      spec,
      palette,
      size,
      frame,
      registry,
      deps.measurer,
      warnings,
    );
    if (op !== null) ops.push(op);
  }

  return { scene, warnings };
}
