import { CardsmithError } from "./errors.js";
import type { LocalizedLabel } from "./palettes.js";

export type SizeOrientation = "square" | "portrait" | "landscape";

export interface SizePrintInfo {
  ppi: number;
  widthMm: number;
  heightMm: number;
}

export interface SizeSafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SizePreset {
  id: string;
  width: number;
  height: number;
  orientation: SizeOrientation;
  label: LocalizedLabel;
  print?: SizePrintInfo;
  safeArea?: SizeSafeArea;
}

/** Physical millimeters at 300 ppi, rounded to 0.1 mm for metadata. */
function pxToMm(px: number): number {
  return Math.round((px * 254) / 300) / 10;
}

function printInfo(width: number, height: number): SizePrintInfo {
  return { ppi: 300, widthMm: pxToMm(width), heightMm: pxToMm(height) };
}

/** Design presets, not platform guarantees; reviewed independently from templates. */
export const SIZE_PRESETS: readonly SizePreset[] = [
  {
    id: "social-square",
    width: 1080,
    height: 1080,
    orientation: "square",
    label: { es: "Publicación cuadrada", en: "Square post" },
  },
  {
    id: "social-portrait",
    width: 1080,
    height: 1350,
    orientation: "portrait",
    label: { es: "Tarjeta vertical", en: "Portrait card" },
  },
  {
    id: "social-tall",
    width: 1080,
    height: 1440,
    orientation: "portrait",
    label: { es: "Vertical alternativa", en: "Tall portrait" },
  },
  {
    id: "story-vertical",
    width: 1080,
    height: 1920,
    orientation: "portrait",
    label: { es: "Historia o estado", en: "Story or status" },
    safeArea: { top: 250, bottom: 250, left: 80, right: 80 },
  },
  {
    id: "social-landscape",
    width: 1200,
    height: 630,
    orientation: "landscape",
    label: { es: "Banner de enlace", en: "Link banner" },
  },
  {
    id: "video-landscape",
    width: 1920,
    height: 1080,
    orientation: "landscape",
    label: { es: "Banner horizontal", en: "Wide banner" },
  },
  {
    id: "certificate-a4-landscape",
    width: 3508,
    height: 2480,
    orientation: "landscape",
    label: { es: "Certificado A4 horizontal", en: "A4 certificate landscape" },
    print: printInfo(3508, 2480),
  },
  {
    id: "certificate-a4-portrait",
    width: 2480,
    height: 3508,
    orientation: "portrait",
    label: { es: "Certificado A4 vertical", en: "A4 certificate portrait" },
    print: printInfo(2480, 3508),
  },
  {
    id: "badge-landscape",
    width: 1011,
    height: 638,
    orientation: "landscape",
    label: { es: "Credencial 85.6 × 54 mm", en: "Badge 85.6 × 54 mm" },
    print: printInfo(1011, 638),
  },
];

export function size(id: string): SizePreset {
  const preset = SIZE_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    throw new CardsmithError("UNKNOWN_SIZE", `Unknown size preset "${id}"`, { sizeId: id });
  }
  return preset;
}

export function sizeOrientation(sizeId: string): SizeOrientation {
  return size(sizeId).orientation;
}

export function sizesForOrientation(orientation: SizeOrientation): SizePreset[] {
  return SIZE_PRESETS.filter((preset) => preset.orientation === orientation);
}

/** Family-level default used when a design spec omits `sizeId`. */
export function defaultSizeForFamily(family: string): string {
  switch (family) {
    case "social":
      return "social-portrait";
    case "personalized":
      return "certificate-a4-portrait";
    case "composite":
    case "chart":
      return "social-square";
    case "dynamic":
      return "social-portrait";
    default:
      throw new CardsmithError("INVALID_SPEC", `Unknown family "${family}"`, { family });
  }
}
