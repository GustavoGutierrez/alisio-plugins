import type { DiagramTheme, ResolvedMeta } from "./model.js";
import { accentColor, loadPalette, tint } from "./palettes.js";

const fontLists: Record<ResolvedMeta["fontProfile"], string[]> = {
  serif: ["Libertinus Serif", "New Computer Modern"],
  sans: ["Liberation Sans", "Arimo", "DejaVu Sans"],
  institutional: ["Libertinus Serif"],
};

/**
 * Diagram theme generated from the palette (spec 10.5). `neutral` tints nodes with the palette's
 * accent color on a white page; `grayscale` uses only grays, safe for black-and-white printing.
 */
export function diagramThemeFor(
  meta: Pick<ResolvedMeta, "palette" | "diagramTheme" | "fontProfile" | "bodyFont">,
): DiagramTheme {
  const base = fontLists[meta.fontProfile] ?? fontLists.serif;
  const fonts = meta.bodyFont ? [meta.bodyFont, ...base] : base;
  const ink = "#1A1A1A";
  const palette = loadPalette(meta.palette);
  const accent = meta.diagramTheme === "grayscale" ? "#4D4D4D" : accentColor(palette);
  const variables: Record<string, string> =
    meta.diagramTheme === "grayscale"
      ? {
          primaryColor: "#F2F2F2",
          primaryBorderColor: "#4D4D4D",
          primaryTextColor: ink,
          secondaryColor: "#E0E0E0",
          tertiaryColor: "#FFFFFF",
          lineColor: "#4D4D4D",
          textColor: ink,
          mainBkg: "#F2F2F2",
          nodeBorder: "#4D4D4D",
          clusterBkg: "#FAFAFA",
          clusterBorder: "#8C8C8C",
          edgeLabelBackground: "#FFFFFF",
          titleColor: ink,
        }
      : {
          primaryColor: tint(accent, 0.88),
          primaryBorderColor: accent,
          primaryTextColor: ink,
          secondaryColor: tint(accent, 0.94),
          tertiaryColor: "#FFFFFF",
          lineColor: "#4D4D4D",
          textColor: ink,
          mainBkg: tint(accent, 0.88),
          nodeBorder: accent,
          clusterBkg: "#FAFAFA",
          clusterBorder: "#8C8C8C",
          edgeLabelBackground: "#FFFFFF",
          titleColor: ink,
        };
  return { name: meta.diagramTheme, variables, background: "#FFFFFF", fonts };
}
