import { qrcodegen } from "../vendor/nayuki/qrcodegen.js";
import { CardsmithError } from "./errors.js";
import { QR_MIN_MODULE_PX, QR_QUIET_ZONE_MODULES } from "./limits.js";
import { contrastRatio, type Palette } from "./palettes.js";
import type { QrOp } from "./scene.js";

export type QrEcc = "M" | "Q";

export interface QrBuildOptions {
  /** Error correction level; M by default, Q configurable. */
  ecc?: QrEcc;
  /**
   * Optional palette. The QR always keeps a light `#ffffff` background; the dark ink is the
   * palette `text` token only when it reaches 7:1 against white, otherwise `#111111`.
   */
  palette?: Palette;
}

const DEFAULT_DARK = "#111111";
const LIGHT = "#ffffff";
const QR_INK_MIN_CONTRAST = 7;

/** Maximum payload accepted by the vendored encoder (version 40, byte mode, ECC low). */
const MAX_PAYLOAD_BYTES = 2953;

function validatePayload(payload: string): number {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new CardsmithError("QR_INVALID", "QR payload must be a non-empty string");
  }
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new CardsmithError(
      "QR_INVALID",
      `QR payload of ${bytes} UTF-8 bytes exceeds the ${MAX_PAYLOAD_BYTES} byte limit`,
      { bytes, maxBytes: MAX_PAYLOAD_BYTES },
    );
  }
  return bytes;
}

/** Encode a payload into the raw module matrix (true = dark). ECC M by default, Q configurable. */
export function encodeQrMatrix(payload: string, ecc: QrEcc = "M"): boolean[][] {
  validatePayload(payload);
  const level = ecc === "Q" ? qrcodegen.QrCode.Ecc.QUARTILE : qrcodegen.QrCode.Ecc.MEDIUM;
  let code: qrcodegen.QrCode;
  try {
    code = qrcodegen.QrCode.encodeText(payload, level);
  } catch (error) {
    throw new CardsmithError("QR_INVALID", "QR payload cannot be encoded", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const matrix: boolean[][] = [];
  for (let row = 0; row < code.size; row += 1) {
    const modules: boolean[] = [];
    for (let column = 0; column < code.size; column += 1) {
      modules.push(code.getModule(column, row));
    }
    matrix.push(modules);
  }
  return matrix;
}

function qrColors(palette: Palette | undefined): { dark: string; light: string } {
  if (palette === undefined) return { dark: DEFAULT_DARK, light: LIGHT };
  const candidate = palette.tokens.text;
  const dark = contrastRatio(candidate, LIGHT) >= QR_INK_MIN_CONTRAST ? candidate : DEFAULT_DARK;
  return { dark, light: LIGHT };
}

/**
 * Build a QR scene op. `boxPx` is the outer box, quiet zone included; the module size is the
 * integer floor of `boxPx / (modules + 2 * QR_QUIET_ZONE_MODULES)` and the returned op is
 * integer-aligned with `boxSize = (modules + 8) * modulePx`, anchored at (0, 0) so the caller
 * can place it. Below {@link QR_MIN_MODULE_PX} it throws QR_TOO_DENSE instead of shrinking.
 */
export function buildQrOp(payload: string, boxPx: number, options: QrBuildOptions = {}): QrOp {
  validatePayload(payload);
  if (!Number.isFinite(boxPx) || boxPx <= 0) {
    throw new CardsmithError("INVALID_SPEC", "QR box must be a positive number of pixels", {
      boxPx,
    });
  }
  const matrix = encodeQrMatrix(payload, options.ecc ?? "M");
  const moduleCount = matrix.length;
  const totalModules = moduleCount + 2 * QR_QUIET_ZONE_MODULES;
  const modulePx = Math.floor(boxPx / totalModules);
  if (modulePx < QR_MIN_MODULE_PX) {
    throw new CardsmithError(
      "QR_TOO_DENSE",
      `QR needs ${totalModules} modules but the box only allows ${modulePx}px per module`,
      {
        boxPx,
        moduleCount,
        modulePx,
        minModulePx: QR_MIN_MODULE_PX,
      },
    );
  }
  const { dark, light } = qrColors(options.palette);
  return {
    op: "qr",
    matrix,
    x: 0,
    y: 0,
    boxSize: totalModules * modulePx,
    dark,
    light,
  };
}
