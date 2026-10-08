import { describe, expect, it } from "vitest";
import { contrastRatio, isLargeText, type Palette, validatePalette } from "../src/core/palettes.js";
import { captureError, makeFixtureRegistry } from "./helpers.js";

/** Catalog order is deterministic: sorted by id. */
const PALETTE_IDS = [
  "alegria-botanica",
  "alisio-ocean",
  "amistad-pastel",
  "amor-calido",
  "certificado-marfil",
  "retro-calido",
];

describe("palettes", () => {
  it("loads the six shipped palettes through the registry", async () => {
    const registry = await makeFixtureRegistry();
    const catalog = registry.catalog();
    expect(catalog.palettes.map((entry) => entry.id)).toEqual(PALETTE_IDS);
    for (const id of PALETTE_IDS) {
      expect(registry.palette(id).version).toBe(1);
    }
  });

  it("validates every approved textOn pair at 4.5:1 or better", async () => {
    const registry = await makeFixtureRegistry();
    for (const id of PALETTE_IDS) {
      const palette = registry.palette(id);
      expect(() => validatePalette(palette)).not.toThrow();
      for (const [surface, textTokens] of Object.entries(palette.textOn)) {
        const surfaceColor = tokenColor(palette, surface);
        for (const textToken of textTokens) {
          const ratio = contrastRatio(surfaceColor, tokenColor(palette, textToken));
          expect(ratio, `${id}: ${textToken} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps the retro olive as an exempt decorative color", async () => {
    const registry = await makeFixtureRegistry();
    const retro = registry.palette("retro-calido");
    expect(retro.tokens.decorative).toEqual(["#8D8D35"]);
    const ratio = contrastRatio("#8D8D35", retro.tokens.background);
    expect(ratio).toBeLessThan(4.5);
    expect(() => validatePalette(retro)).not.toThrow();
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(isLargeText(23.9)).toBe(false);
    expect(isLargeText(24)).toBe(true);
  });

  it("rejects a palette whose approved pair fails contrast", () => {
    const palette: Palette = {
      id: "broken",
      version: 1,
      label: { es: "Rota", en: "Broken" },
      tokens: {
        background: "#FFFFFF",
        text: "#EEEEEE",
        primary: "#111111",
        secondary: "#222222",
        accent: "#333333",
      },
      textOn: { background: ["text"] },
    };
    const error = captureError(() => validatePalette(palette));
    expect(error.code).toBe("INVALID_SPEC");
    expect(error.details?.surface).toBe("background");
  });

  it("rejects malformed colors", () => {
    expect(captureError(() => contrastRatio("nope", "#FFFFFF")).code).toBe("INVALID_SPEC");
    expect(captureError(() => contrastRatio("#FFFFF", "#FFFFFF")).code).toBe("INVALID_SPEC");
  });
});

function tokenColor(palette: Palette, token: string): string {
  if (token === "decorative") return palette.tokens.decorative?.[0] ?? palette.tokens.accent;
  const value = (palette.tokens as Record<string, unknown>)[token];
  if (typeof value !== "string") throw new Error(`Unknown token ${token}`);
  return value;
}
