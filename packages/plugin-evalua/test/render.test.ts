import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shippedThemesDir } from "../src/knowledge/package.js";
import {
  densityLadder,
  legibilityFloors,
  presetById,
  withinFloors,
} from "../src/layout/presets.js";
import { escapeHtml, parseMarkup, tokenizeInline } from "../src/markup.js";
import { loadThemeLayers, resolveTheme } from "../src/themes.js";
import { cleanup, scratchDir } from "./helpers/harness.js";

afterEach(cleanup);

describe("themes (EVL-DOC-005)", () => {
  it("loads the classic, blue and dark themes cleanly", async () => {
    const catalogue = await loadThemeLayers([{ dir: shippedThemesDir(), layer: "shipped" }]);
    expect(catalogue.report.ok).toBe(true);
    expect(catalogue.themes.map((theme) => theme.id)).toEqual(["blue", "classic", "dark"]);
    const classic = catalogue.themes.find((theme) => theme.id === "classic");
    expect(classic?.tokens.headerStyle).toBe("plain");
    const blue = catalogue.themes.find((theme) => theme.id === "blue");
    expect(blue?.tokens.accent).toMatch(/^#/);
    const dark = catalogue.themes.find((theme) => theme.id === "dark");
    expect(dark?.tokens.headerStyle).toBe("band");
    expect(dark?.tokens.headerText).toBe("#ffffff");
  });

  it("resolves a known id and reports an unknown one", async () => {
    const { themes } = await loadThemeLayers([{ dir: shippedThemesDir(), layer: "shipped" }]);
    expect(resolveTheme(themes, "blue").theme?.id).toBe("blue");
    const unknown = resolveTheme(themes, "neon");
    expect(unknown.finding?.id).toBe("EVL-DOC-005");
    expect(unknown.finding?.severity).toBe("error");
  });

  it("lets a workspace theme override a shipped one", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "classic"), { recursive: true });
    await writeFile(
      join(dir, "classic", "theme.yaml"),
      [
        "schemaVersion: 1",
        "id: classic",
        'name: { es: "Clásico propio" }',
        "tokens:",
        '  accent: "#123456"',
      ].join("\n"),
    );
    const catalogue = await loadThemeLayers([
      { dir: shippedThemesDir(), layer: "shipped" },
      { dir, layer: "workspace" },
    ]);
    expect(catalogue.report.ok).toBe(true);
    expect(catalogue.themes.find((theme) => theme.id === "classic")?.tokens.accent).toBe("#123456");
  });

  it("rejects a theme without a Spanish name", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "broken"), { recursive: true });
    await writeFile(
      join(dir, "broken", "theme.yaml"),
      ["schemaVersion: 1", "id: broken", 'name: { en: "Broken" }', "tokens: {}"].join("\n"),
    );
    const catalogue = await loadThemeLayers([{ dir, layer: "workspace" }]);
    expect(catalogue.report.ok).toBe(false);
  });
});

describe("density ladder", () => {
  it("is the five presets of the spec, most comfortable first", () => {
    expect(densityLadder.map((preset) => preset.id)).toEqual([
      "comfortable",
      "regular",
      "compact",
      "tight",
      "minimum",
    ]);
  });

  it("never crosses a legibility floor and shrinks monotonically", () => {
    for (const preset of densityLadder) {
      expect(withinFloors(preset)).toBe(true);
      expect(preset.bodyPt).toBeGreaterThanOrEqual(legibilityFloors.bodyPt);
      expect(preset.marginsMm).toBeGreaterThanOrEqual(legibilityFloors.marginsMm);
    }
    for (let index = 1; index < densityLadder.length; index += 1) {
      const previous = densityLadder[index - 1];
      const current = densityLadder[index];
      if (!previous || !current) throw new Error("missing preset");
      expect(current.bodyPt).toBeLessThanOrEqual(previous.bodyPt);
      expect(current.practiceSpace).toBeLessThanOrEqual(previous.practiceSpace);
    }
    expect(presetById("minimum")?.header).toBe("tight2rows");
    expect(presetById("nope")).toBeUndefined();
  });
});

describe("mini markup", () => {
  it("splits text and inline math in order", () => {
    expect(tokenizeInline("Calcula $\\dfrac{3}{4}+\\dfrac{5}{6}$ con cuidado")).toEqual([
      { kind: "text", value: "Calcula " },
      { kind: "math", value: "\\dfrac{3}{4}+\\dfrac{5}{6}" },
      { kind: "text", value: " con cuidado" },
    ]);
  });

  it("parses display math and table blocks", () => {
    const blocks = parseMarkup([
      "Mira:",
      "$$x^2 - 5x + 6 = 0$$",
      { table: { head: ["a", "$b$"], rows: [["1", "$2$"]] } },
    ]);
    expect(blocks[0]).toEqual({ kind: "paragraph", inline: [{ kind: "text", value: "Mira:" }] });
    expect(blocks[1]).toEqual({ kind: "display", value: "x^2 - 5x + 6 = 0" });
    expect(blocks[2]?.kind).toBe("table");
  });

  it("escapes HTML so content cannot inject markup", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});
