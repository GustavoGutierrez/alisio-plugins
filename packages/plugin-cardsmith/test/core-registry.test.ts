import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRegistry, type RegistryOptions } from "../src/core/registry.js";
import { packagePath } from "../src/resource-paths.js";
import {
  captureAsyncError,
  captureError,
  makeFixtureRegistry,
  tempDir,
  writeJsonFile,
} from "./helpers.js";

function fixturePalette(id: string): Record<string, unknown> {
  return {
    id,
    version: 1,
    label: { es: `Paleta ${id}`, en: `Palette ${id}` },
    tokens: {
      background: "#FFFFFF",
      text: "#000000",
      primary: "#111111",
      secondary: "#222222",
      accent: "#333333",
    },
    textOn: { background: ["text"] },
  };
}

function fixtureTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture-card",
    version: 1,
    family: "social",
    label: { es: "Tarjeta fija", en: "Fixture card" },
    layouts: {
      portrait: {
        slots: [
          { key: "title", role: "display", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, size: 72 },
        ],
      },
    },
    fields: [{ key: "title", type: "text", required: true }],
    defaultPalette: "alegria-botanica",
    defaultFontPair: "handwritten-readable",
    supports: { qr: false, illustration: false, images: false },
    ...overrides,
  };
}

function packagedOptions(templatesDir: string): RegistryOptions {
  return {
    templatesDir,
    palettesDir: packagePath("resources/palettes"),
    illustrationsDir: packagePath("resources/illustrations"),
    fontPairsFile: packagePath("resources/font-pairs.json"),
  };
}

function fixtureIllustration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture-art",
    version: 1,
    label: { es: "Arte fijo", en: "Fixture art" },
    viewBox: [0, 0, 10, 10],
    ops: [
      { kind: "rect", x: 0, y: 0, w: 10, h: 10, fill: "$primary" },
      { kind: "circle", cx: 5, cy: 5, r: 2, fill: "$accent" },
    ],
    ...overrides,
  };
}

describe("registry", () => {
  it("loads the packaged palettes, font pairs and illustration with no templates", async () => {
    const registry = await makeFixtureRegistry();
    const catalog = registry.catalog();
    expect(catalog.templates).toEqual([]);
    expect(catalog.palettes).toHaveLength(6);
    expect(catalog.fontPairs).toHaveLength(6);
    expect(catalog.sizes).toHaveLength(9);
    expect(catalog.formats).toEqual(["png", "jpeg"]);
    expect(registry.illustration("sparkle-basic").viewBox).toEqual([0, 0, 100, 100]);
    expect(registry.fontPair("handwritten-readable").roles.display.alias).toBe(
      "CardsmithPatrickHand400",
    );
  });

  it("throws typed errors for unknown lookups", async () => {
    const registry = await makeFixtureRegistry();
    expect(captureError(() => registry.palette("nope")).code).toBe("UNKNOWN_PALETTE");
    expect(captureError(() => registry.template("nope")).code).toBe("UNKNOWN_TEMPLATE");
    expect(captureError(() => registry.fontPair("nope")).code).toBe("UNKNOWN_FONT_PAIR");
    expect(captureError(() => registry.illustration("nope")).code).toBe("UNKNOWN_ILLUSTRATION");
    expect(captureError(() => registry.size("nope")).code).toBe("UNKNOWN_SIZE");
  });

  it("rejects duplicate palette ids", async () => {
    const error = await captureAsyncError(() =>
      makeFixtureRegistry({ palettes: [fixturePalette("dup"), fixturePalette("dup")] }),
    );
    expect(error.code).toBe("INVALID_SPEC");
    expect(error.message).toContain("Duplicate");
  });

  it("rejects duplicate font pair ids", async () => {
    const pairs = JSON.parse(
      await readFile(packagePath("resources/font-pairs.json"), "utf8"),
    ) as unknown[];
    const pair = pairs[0] as Record<string, unknown>;
    const error = await captureAsyncError(() => makeFixtureRegistry({ fontPairs: [pair, pair] }));
    expect(error.code).toBe("INVALID_SPEC");
  });

  it("registers fixture templates and exposes a compact catalog entry", async () => {
    const registry = await makeFixtureRegistry({ templates: [fixtureTemplate()] });
    expect(registry.template("fixture-card").id).toBe("fixture-card");
    const catalog = registry.catalog();
    expect(catalog.templates).toHaveLength(1);
    const entry = catalog.templates[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "accentIllustrations",
      "family",
      "id",
      "label",
      "requiredFields",
      "sizes",
      "supports",
    ]);
    expect(entry?.accentIllustrations).toEqual([]);
    expect(entry?.defaultIllustration).toBeUndefined();
    expect(entry?.requiredFields).toEqual(["title"]);
    expect(entry?.sizes).toEqual([
      "social-portrait",
      "social-tall",
      "story-vertical",
      "certificate-a4-portrait",
    ]);
    expect(entry?.sizes).not.toContain("social-square");
  });

  it("parses illustration labels and tags into the catalog", async () => {
    const registry = await makeFixtureRegistry({
      illustrations: [fixtureIllustration({ tags: ["kawaii", "birthday"] })],
    });
    expect(registry.illustration("fixture-art").tags).toEqual(["kawaii", "birthday"]);
    expect(registry.catalog().illustrations).toEqual([
      {
        id: "fixture-art",
        label: { es: "Arte fijo", en: "Fixture art" },
        tags: ["kawaii", "birthday"],
      },
    ]);
  });

  it("tolerates illustrations without tags and projects an empty tag list", async () => {
    const registry = await makeFixtureRegistry({ illustrations: [fixtureIllustration()] });
    expect(registry.illustration("fixture-art").tags).toBeUndefined();
    expect(registry.catalog().illustrations).toEqual([
      {
        id: "fixture-art",
        label: { es: "Arte fijo", en: "Fixture art" },
        tags: [],
      },
    ]);
  });

  it("rejects unknown or repeated illustration tags", async () => {
    const unknown = await captureAsyncError(() =>
      makeFixtureRegistry({ illustrations: [fixtureIllustration({ tags: ["cute"] })] }),
    );
    expect(unknown.code).toBe("INVALID_SPEC");
    expect(unknown.message).toContain("unknown tag");
    const repeated = await captureAsyncError(() =>
      makeFixtureRegistry({ illustrations: [fixtureIllustration({ tags: ["love", "love"] })] }),
    );
    expect(repeated.code).toBe("INVALID_SPEC");
    expect(repeated.message).toContain("must not repeat");
    const wrongType = await captureAsyncError(() =>
      makeFixtureRegistry({ illustrations: [fixtureIllustration({ tags: "kawaii" })] }),
    );
    expect(wrongType.code).toBe("INVALID_SPEC");
    expect(wrongType.message).toContain("must be an array");
  });

  it("projects a layout illustration default into the catalog entry", async () => {
    const registry = await makeFixtureRegistry({
      templates: [
        fixtureTemplate({
          layouts: {
            portrait: {
              slots: [{ key: "title", role: "display", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } }],
              illustration: {
                box: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
                defaultId: "fixture-art",
              },
            },
          },
          supports: { qr: false, illustration: true, images: false },
          accentIllustrations: ["fixture-art"],
        }),
      ],
      illustrations: [fixtureIllustration({ tags: ["decoration"] })],
    });
    const entry = registry.catalog().templates[0];
    expect(entry?.defaultIllustration).toBe("fixture-art");
    expect(entry?.accentIllustrations).toEqual(["fixture-art"]);
  });

  it("rejects templates with broken cross references", async () => {
    const error = await captureAsyncError(() =>
      makeFixtureRegistry({ templates: [fixtureTemplate({ defaultPalette: "nope" })] }),
    );
    expect(error.code).toBe("INVALID_SPEC");
    expect(error.message).toContain("defaultPalette");
  });

  it("rejects a template whose id does not match its directory", async () => {
    const root = await tempDir("mismatch");
    const templatesDir = join(root, "templates");
    await writeJsonFile(join(templatesDir, "other-dir", "template.json"), fixtureTemplate());
    const error = captureError(() => createRegistry(packagedOptions(templatesDir)));
    expect(error.code).toBe("INVALID_SPEC");
  });

  it("tolerates a missing templates directory", async () => {
    const root = await tempDir("missing-templates");
    const registry = createRegistry(packagedOptions(join(root, "does-not-exist")));
    expect(registry.catalog().templates).toEqual([]);
    expect(registry.catalog().palettes).toHaveLength(6);
  });

  it("returns independent catalog copies", async () => {
    const registry = await makeFixtureRegistry();
    const first = registry.catalog();
    first.palettes.pop();
    expect(registry.catalog().palettes).toHaveLength(6);
  });
});
