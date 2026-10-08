import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandIllustration } from "../src/core/assets.js";
import { type DesignSpecInput, normalizeSpec } from "../src/core/design-spec.js";
import {
  createRegistry,
  type FieldSpec,
  type Registry,
  type RegistryOptions,
} from "../src/core/registry.js";
import { SIZE_PRESETS } from "../src/core/sizes.js";
import { FONT_PAIR_ROLES } from "../src/core/typography.js";
import { packagePath } from "../src/resource-paths.js";
import { captureAsyncError, makeFixtureRegistry } from "./helpers.js";

function packagedRegistry(): Registry {
  const options: RegistryOptions = {
    templatesDir: packagePath("resources/templates"),
    palettesDir: packagePath("resources/palettes"),
    illustrationsDir: packagePath("resources/illustrations"),
    fontPairsFile: packagePath("resources/font-pairs.json"),
  };
  return createRegistry(options);
}

const TEMPLATE_FAMILIES: Record<string, string> = {
  "editorial-photo": "social",
  "illustrated-greeting": "social",
  "retro-message": "social",
  "metric-summary": "social",
  "certificate-classic": "personalized",
  "badge-clean": "personalized",
  "banner-promo": "personalized",
  "photo-caption": "composite",
  watermark: "composite",
  "image-collage": "composite",
  bar: "chart",
  line: "chart",
  scatter: "chart",
  donut: "chart",
  "inventory-product": "dynamic",
  "status-card": "dynamic",
};

const TEMPLATE_SUPPORTS: Record<string, { qr: boolean; illustration: boolean; images: boolean }> = {
  "editorial-photo": { qr: false, illustration: false, images: true },
  "illustrated-greeting": { qr: false, illustration: true, images: false },
  "retro-message": { qr: false, illustration: true, images: false },
  "metric-summary": { qr: false, illustration: false, images: false },
  "certificate-classic": { qr: true, illustration: true, images: false },
  "badge-clean": { qr: true, illustration: false, images: true },
  "banner-promo": { qr: true, illustration: true, images: true },
  "photo-caption": { qr: false, illustration: false, images: true },
  watermark: { qr: false, illustration: false, images: true },
  "image-collage": { qr: false, illustration: false, images: true },
  bar: { qr: false, illustration: false, images: false },
  line: { qr: false, illustration: false, images: false },
  scatter: { qr: false, illustration: false, images: false },
  donut: { qr: false, illustration: false, images: false },
  "inventory-product": { qr: true, illustration: false, images: true },
  "status-card": { qr: true, illustration: false, images: false },
};

const TEMPLATE_REQUIRED_FIELDS: Record<string, string[]> = {
  "editorial-photo": ["title"],
  "illustrated-greeting": ["title"],
  "retro-message": ["title"],
  "metric-summary": ["metrics"],
  "certificate-classic": ["recipientName", "courseTitle"],
  "badge-clean": ["personName"],
  "banner-promo": ["headline"],
  "photo-caption": ["caption"],
  watermark: ["watermarkText"],
  "image-collage": [],
  bar: ["categories", "series"],
  line: ["categories", "series"],
  scatter: ["categories", "series"],
  donut: ["categories", "series"],
  "inventory-product": ["productName", "price"],
  "status-card": ["title", "status"],
};

const ALL_ILLUSTRATION_IDS = [
  "apple",
  "avocado",
  "balloon-cluster",
  "cactus-warm",
  "cat-face",
  "cherry",
  "cherry-blossom",
  "chick",
  "circuit-trace",
  "cloud-soft",
  "code-brackets",
  "confetti-dots",
  "corner-flourish",
  "cupcake-happy",
  "electrocardiogram",
  "flower",
  "flower-happy",
  "gear-cog",
  "gift-box",
  "heart-pair",
  "heart-single",
  "ice-cream",
  "laurel-branch",
  "leaf-sprig",
  "love-birds",
  "medal-ribbon",
  "node-graph",
  "ornament-divider",
  "party-hat",
  "rainbow-kawaii",
  "ribbon-banner",
  "seal-ring",
  "sparkle-basic",
  "sparkle-cluster",
  "star-burst",
  "strawberry",
  "sun-smile",
  "watermelon",
  "waves-retro",
];

const EXPECTED_ILLUSTRATION_TAGS: Record<string, string[]> = {
  apple: ["food"],
  avocado: ["food"],
  "balloon-cluster": ["kawaii", "birthday"],
  "cactus-warm": ["love", "nature"],
  "cat-face": ["kawaii"],
  cherry: ["food"],
  "cherry-blossom": ["nature", "decoration"],
  chick: ["kawaii", "nature"],
  "circuit-trace": ["technical"],
  "cloud-soft": ["kawaii"],
  "code-brackets": ["technical"],
  "confetti-dots": ["birthday", "decoration"],
  "corner-flourish": ["formal", "decoration"],
  "cupcake-happy": ["kawaii", "birthday"],
  electrocardiogram: ["technical"],
  flower: ["nature", "decoration"],
  "flower-happy": ["kawaii", "nature"],
  "gear-cog": ["technical"],
  "gift-box": ["kawaii", "birthday"],
  "heart-pair": ["love"],
  "heart-single": ["love"],
  "ice-cream": ["food"],
  "laurel-branch": ["formal", "nature"],
  "leaf-sprig": ["formal", "nature"],
  "love-birds": ["love", "nature"],
  "medal-ribbon": ["formal"],
  "node-graph": ["technical"],
  "ornament-divider": ["formal", "decoration"],
  "party-hat": ["kawaii", "birthday"],
  "rainbow-kawaii": ["kawaii", "decoration"],
  "ribbon-banner": ["decoration"],
  "seal-ring": ["formal"],
  "sparkle-basic": ["decoration"],
  "sparkle-cluster": ["decoration"],
  "star-burst": ["decoration"],
  strawberry: ["food"],
  "sun-smile": ["kawaii"],
  watermelon: ["food"],
  "waves-retro": ["retro", "decoration"],
};

const ILLUSTRATION_TAG_VOCABULARY = [
  "kawaii",
  "birthday",
  "love",
  "formal",
  "technical",
  "decoration",
  "retro",
  "nature",
  "food",
];

const WIDE_ILLUSTRATION_IDS = new Set(["ornament-divider", "ribbon-banner", "waves-retro"]);

/** Minimal glyph-style assets that stay below the general op-count floor by design. */
const COMPACT_ILLUSTRATION_IDS = new Set([
  "sparkle-basic",
  "chick",
  "flower",
  "love-birds",
  "electrocardiogram",
]);

const ILLUSTRATION_TEMPLATE_IDS = [
  "banner-promo",
  "certificate-classic",
  "illustrated-greeting",
  "retro-message",
];

function fieldFixture(field: FieldSpec): unknown {
  switch (field.type) {
    case "number":
      return 7;
    case "string[]":
      return ["Alpha", "Beta"];
    case "series":
      return [1, 2, 3];
    default:
      return "Sample";
  }
}

function templateJson(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(packagePath("resources/templates"), id, "template.json"), "utf8"),
  ) as Record<string, unknown>;
}

interface LayoutJson {
  background?: string;
  slots: Array<{ key: string; color?: string }>;
  imageSlots?: Array<{ key: string }>;
  illustration?: { defaultId?: string };
  qr?: { box: Record<string, number> };
  plot?: Record<string, number>;
}

function layoutsOf(template: Record<string, unknown>): Record<string, LayoutJson> {
  return (template.layouts ?? {}) as Record<string, LayoutJson>;
}

describe("packaged templates", () => {
  it("lists all 16 templates with family, sizes, required fields and supports", () => {
    const registry = packagedRegistry();
    const catalog = registry.catalog();
    const expectedIds = Object.keys(TEMPLATE_FAMILIES).sort();
    expect(catalog.templates.map((entry) => entry.id)).toEqual(expectedIds);
    for (const entry of catalog.templates) {
      expect(entry.family).toBe(TEMPLATE_FAMILIES[entry.id]);
      expect(entry.requiredFields).toEqual(TEMPLATE_REQUIRED_FIELDS[entry.id]);
      expect(entry.supports).toEqual(TEMPLATE_SUPPORTS[entry.id]);
      const layouts = layoutsOf(templateJson(entry.id));
      const orientations = Object.keys(layouts);
      const expectedSizes = SIZE_PRESETS.filter((preset) =>
        orientations.includes(preset.orientation),
      ).map((preset) => preset.id);
      expect(entry.sizes).toEqual(expectedSizes);
    }
  });

  it("resolves every palette, font pair and illustration reference", () => {
    const registry = packagedRegistry();
    for (const id of Object.keys(TEMPLATE_FAMILIES)) {
      const template = registry.template(id);
      expect(() => registry.palette(template.defaultPalette)).not.toThrow();
      expect(() => registry.fontPair(template.defaultFontPair)).not.toThrow();
      const referenced = new Set<string>(template.accentIllustrations ?? []);
      let hasIllustrationBox = false;
      let hasQrBox = false;
      let hasImageSlots = false;
      for (const layout of Object.values(template.layouts)) {
        if (layout.illustration !== undefined) {
          hasIllustrationBox = true;
          if (layout.illustration.defaultId !== undefined) {
            referenced.add(layout.illustration.defaultId);
          }
        }
        if (layout.qr !== undefined) hasQrBox = true;
        if (layout.imageSlots !== undefined) hasImageSlots = true;
      }
      for (const assetId of referenced) {
        expect(() => registry.illustration(assetId)).not.toThrow();
      }
      expect(hasIllustrationBox).toBe(template.supports.illustration);
      expect(hasQrBox).toBe(template.supports.qr);
      expect(hasImageSlots).toBe(template.supports.images);
    }
  });

  it("keeps template JSON token-only and its image slot keys non-empty and unique", () => {
    for (const id of Object.keys(TEMPLATE_FAMILIES)) {
      const template = templateJson(id);
      for (const [layoutKey, layout] of Object.entries(layoutsOf(template))) {
        const where = `${id}.layouts.${layoutKey}`;
        expect(layout.background === undefined || layout.background.startsWith("$"), where).toBe(
          true,
        );
        for (const slot of layout.slots) {
          if (slot.color !== undefined) {
            expect(slot.color.startsWith("$"), `${where}.slots.${slot.key}.color`).toBe(true);
            expect(slot.color).not.toContain("#");
          }
        }
        const keys = (layout.imageSlots ?? []).map((slot) => slot.key);
        for (const key of keys) expect(key.length).toBeGreaterThan(0);
        expect(new Set(keys).size).toBe(keys.length);
      }
      expect(JSON.stringify(template.layouts)).not.toMatch(/#[0-9a-fA-F]{3,8}"/);
    }
  });

  it("normalizes a minimal spec for every template with family defaults", () => {
    const registry = packagedRegistry();
    for (const id of Object.keys(TEMPLATE_FAMILIES)) {
      const template = registry.template(id);
      const content: Record<string, unknown> = {};
      for (const field of template.fields) {
        if (field.required === true) content[field.key] = fieldFixture(field);
      }
      const input: DesignSpecInput = {
        family: template.family,
        templateId: id,
        content,
      };
      const result = normalizeSpec(input, registry);
      if (!result.ok) throw new Error(`${id}: ${JSON.stringify(result.errors)}`);
      expect(result.spec.paletteId).toBe(template.defaultPalette);
      expect(result.spec.fontPairId).toBe(template.defaultFontPair);
      const orientation = registry.size(result.spec.sizeId).orientation;
      expect(template.layouts[orientation], `${id} default size `).toBeDefined();
    }
  });

  it("adaptively defaults badge-clean to the first compatible landscape size", () => {
    const registry = packagedRegistry();
    const result = normalizeSpec(
      {
        family: "personalized",
        templateId: "badge-clean",
        content: { personName: "Ada Lovelace" },
      },
      registry,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.spec.sizeId).toBe("social-landscape");
    expect(result.warnings.join(" ")).toContain("social-landscape");
    expect(result.warnings.join(" ")).not.toContain("INCOMPATIBLE_SIZE");
  });

  it("falls back to the first compatible preset when the family default has no layout", () => {
    const registry = packagedRegistry();
    const metric = normalizeSpec(
      {
        family: "social",
        templateId: "metric-summary",
        content: { metrics: ["Users | 1200"] },
      },
      registry,
    );
    if (!metric.ok) throw new Error(JSON.stringify(metric.errors));
    expect(metric.spec.sizeId).toBe("social-square");
  });

  it("loads a landscape-only fixture without sizeId using its family default when compatible", async () => {
    const registry = await makeFixtureRegistry({
      templates: [
        {
          id: "landscape-only",
          version: 1,
          family: "social",
          label: { es: "Solo horizontal", en: "Landscape only" },
          layouts: {
            landscape: {
              slots: [
                {
                  key: "title",
                  role: "display",
                  box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
                },
              ],
            },
          },
          fields: [{ key: "title", type: "text", required: true }],
          defaultPalette: "alisio-ocean",
          defaultFontPair: "editorial",
          supports: { qr: false, illustration: false, images: false },
        },
      ],
    });
    const result = normalizeSpec(
      { family: "social", templateId: "landscape-only", content: { title: "Hi" } },
      registry,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.spec.sizeId).toBe("social-landscape");
  });

  it("is deterministic across two independent registry loads", () => {
    expect(packagedRegistry().catalog()).toEqual(packagedRegistry().catalog());
  });
});

describe("template layout extensions", () => {
  function extensionTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "extension-card",
      version: 1,
      family: "chart",
      label: { es: "Extensión", en: "Extension" },
      layouts: {
        landscape: {
          slots: [{ key: "title", role: "display", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } }],
          plot: { x: 0.1, y: 0.35, w: 0.8, h: 0.55 },
        },
        square: {
          slots: [{ key: "title", role: "display", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } }],
          imageSlots: [
            {
              key: "photo",
              box: { x: 0.1, y: 0.35, w: 0.8, h: 0.55 },
              fit: "cover",
              round: "circle",
            },
          ],
        },
      },
      fields: [{ key: "title", type: "text" }],
      defaultPalette: "alisio-ocean",
      defaultFontPair: "editorial",
      supports: { qr: false, illustration: false, images: true },
      ...overrides,
    };
  }

  it("accepts plot boxes and image slots on a template", async () => {
    const registry = await makeFixtureRegistry({ templates: [extensionTemplate()] });
    const template = registry.template("extension-card");
    expect(template.layouts.landscape?.plot).toEqual({ x: 0.1, y: 0.35, w: 0.8, h: 0.55 });
    expect(template.layouts.square?.imageSlots).toEqual([
      { key: "photo", box: { x: 0.1, y: 0.35, w: 0.8, h: 0.55 }, fit: "cover", round: "circle" },
    ]);
  });

  async function expectRejected(
    layouts: Record<string, unknown>,
    message: string,
    supports = { qr: false, illustration: false, images: true },
  ): Promise<void> {
    const template = extensionTemplate({ layouts, supports });
    const error = await captureAsyncError(() => makeFixtureRegistry({ templates: [template] }));
    expect(error.code).toBe("INVALID_SPEC");
    expect(error.message).toContain(message);
  }

  it("rejects plot boxes outside the unit square and plot unknown keys", async () => {
    await expectRejected(
      {
        landscape: {
          slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
          plot: { x: 0.5, y: 0.5, w: 0.7, h: 0.6 },
        },
      },
      "sub-rectangle",
    );
    await expectRejected(
      {
        landscape: {
          slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
          plot: { x: 0.1, y: 0.3, w: 0.8, h: 0.6, label: "chart" },
        },
      },
      'unknown key "label"',
    );
  });

  it("rejects image slots with duplicate or empty keys", async () => {
    const duplicate = {
      square: {
        slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
        imageSlots: [
          { key: "photo", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 } },
          { key: "photo", box: { x: 0.5, y: 0.3, w: 0.5, h: 0.5 } },
        ],
      },
    };
    await expectRejected(duplicate, "duplicated");
    await expectRejected(
      {
        square: {
          slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
          imageSlots: [{ key: "", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 } }],
        },
      },
      "non-empty string",
    );
  });

  it("rejects invalid fit, round and unknown image slot keys", async () => {
    const base = (slot: Record<string, unknown>) => ({
      square: {
        slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
        imageSlots: [slot],
      },
    });
    await expectRejected(
      base({ key: "photo", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 }, fit: "stretch" }),
      "cover",
    );
    await expectRejected(
      base({ key: "photo", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 }, round: "square" }),
      "none",
    );
    await expectRejected(
      base({ key: "photo", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 }, alt: "photo" }),
      'unknown key "alt"',
    );
    await expectRejected(
      base({ key: "photo", box: { x: 0.6, y: 0.3, w: 0.9, h: 0.5 } }),
      "sub-rectangle",
    );
  });

  it("rejects image slots without supports.images and empty slot lists", async () => {
    await expectRejected(
      {
        square: {
          slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
          imageSlots: [{ key: "photo", box: { x: 0, y: 0.3, w: 0.5, h: 0.5 } }],
        },
      },
      "needs supports.images",
      { qr: false, illustration: false, images: false },
    );
    await expectRejected(
      {
        square: {
          slots: [{ key: "title", role: "display", box: { x: 0, y: 0, w: 1, h: 0.2 } }],
          imageSlots: [],
        },
      },
      "must not be empty",
    );
  });
});

describe("packaged illustrations", () => {
  it("loads all 39 illustrations and expands them with every palette", () => {
    const registry = packagedRegistry();
    const palettes = registry.catalog().palettes.map((entry) => registry.palette(entry.id));
    expect(palettes).toHaveLength(6);
    expect(ALL_ILLUSTRATION_IDS).toHaveLength(39);
    for (const id of ALL_ILLUSTRATION_IDS) {
      const asset = registry.illustration(id);
      // Imported sources may declare a non-zero viewBox origin (strawberry: 0 -12.5 1049 1049);
      // the schema and expandIllustration handle any finite origin.
      expect(Number.isFinite(asset.viewBox[0])).toBe(true);
      expect(Number.isFinite(asset.viewBox[1])).toBe(true);
      expect(asset.viewBox[2]).toBeGreaterThan(0);
      expect(asset.viewBox[3]).toBeGreaterThan(0);
      if (WIDE_ILLUSTRATION_IDS.has(id)) {
        expect(asset.viewBox[2]).toBeGreaterThan(asset.viewBox[3]);
      } else {
        // The electrocardiogram source declares 441.344 x 441.343; treat sub-0.01 rounding as square.
        expect(Math.abs(asset.viewBox[2] - asset.viewBox[3])).toBeLessThan(0.01);
      }
      if (COMPACT_ILLUSTRATION_IDS.has(id)) {
        expect(asset.ops.length, `${id} op count`).toBeGreaterThanOrEqual(2);
        expect(asset.ops.length, `${id} op count`).toBeLessThanOrEqual(5);
      } else {
        expect(asset.ops.length, `${id} op count`).toBeGreaterThanOrEqual(6);
        expect(asset.ops.length, `${id} op count`).toBeLessThanOrEqual(22);
      }
      expect(asset.label?.es.length, `${id} label.es`).toBeGreaterThan(0);
      expect(asset.label?.en.length, `${id} label.en`).toBeGreaterThan(0);
      expect(asset.tags, `${id} tags`).toEqual(EXPECTED_ILLUSTRATION_TAGS[id]);
      for (const tag of asset.tags ?? []) {
        expect(ILLUSTRATION_TAG_VOCABULARY, `${id} tag "${tag}"`).toContain(tag);
      }
      for (const palette of palettes) {
        const ops = expandIllustration(asset, { x: 0, y: 0, w: 240, h: 240 }, palette);
        expect(ops.length).toBe(asset.ops.length);
        for (const op of ops) {
          if (op.op === "path" || op.op === "rect") {
            for (const color of [op.fill, op.stroke]) {
              if (color !== undefined) {
                expect(color.startsWith("$"), `${id} left an unresolved token`).toBe(false);
                expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
              }
            }
          }
        }
      }
    }
    expect(registry.illustration("sparkle-basic").ops).toHaveLength(5);
  });

  it("lists every illustration with label and tags in the catalog", () => {
    const registry = packagedRegistry();
    const catalog = registry.catalog();
    expect(catalog.illustrations.map((entry) => entry.id)).toEqual(ALL_ILLUSTRATION_IDS);
    for (const entry of catalog.illustrations) {
      expect(entry.label.es.length, `${entry.id} label.es`).toBeGreaterThan(0);
      expect(entry.label.en.length, `${entry.id} label.en`).toBeGreaterThan(0);
      expect(entry.tags, `${entry.id} tags`).toEqual(EXPECTED_ILLUSTRATION_TAGS[entry.id]);
      expect(new Set(entry.tags).size).toBe(entry.tags.length);
    }
    for (const template of catalog.templates) {
      expect(Array.isArray(template.accentIllustrations), template.id).toBe(true);
      if (template.defaultIllustration !== undefined) {
        expect(() => registry.illustration(template.defaultIllustration as string)).not.toThrow();
      }
    }
  });

  it("projects each illustration default and resolves every accent reference", () => {
    const registry = packagedRegistry();
    const catalog = registry.catalog();
    const byId = new Map(catalog.templates.map((entry) => [entry.id, entry]));
    expect(byId.get("illustrated-greeting")?.defaultIllustration).toBe("flower-happy");
    expect(byId.get("retro-message")?.defaultIllustration).toBe("sun-smile");
    expect(byId.get("certificate-classic")?.defaultIllustration).toBe("seal-ring");
    expect(byId.get("banner-promo")?.defaultIllustration).toBe("ribbon-banner");
    for (const template of catalog.templates) {
      for (const assetId of template.accentIllustrations) {
        expect(
          () => registry.illustration(assetId),
          `${template.id} accent illustration ${assetId}`,
        ).not.toThrow();
      }
    }
  });

  it("accepts every illustration id from every illustration-supporting template", () => {
    const registry = packagedRegistry();
    const supporting = registry
      .catalog()
      .templates.filter((template) => template.supports.illustration);
    expect(supporting.map((entry) => entry.id)).toEqual(ILLUSTRATION_TEMPLATE_IDS);
    for (const template of supporting) {
      const content: Record<string, unknown> = {};
      for (const field of registry.template(template.id).fields) {
        if (field.required === true) content[field.key] = fieldFixture(field);
      }
      for (const illustrationId of ALL_ILLUSTRATION_IDS) {
        const result = normalizeSpec(
          {
            family: template.family,
            templateId: template.id,
            content,
            illustrationId,
          },
          registry,
        );
        if (!result.ok) {
          throw new Error(`${template.id}/${illustrationId}: ${JSON.stringify(result.errors)}`);
        }
        expect(result.spec.illustrationId, `${template.id}/${illustrationId}`).toBe(illustrationId);
      }
    }
  });

  it("resolves the decorative token with alisio-ocean fallback to accent", () => {
    const registry = packagedRegistry();
    const palette = registry.palette("alisio-ocean");
    expect(palette.tokens.decorative).toBeUndefined();
    const ops = expandIllustration(
      registry.illustration("sparkle-basic"),
      { x: 0, y: 0, w: 100, h: 100 },
      palette,
    );
    const rect = ops.find((op) => op.op === "rect");
    expect(rect).toBeDefined();
    if (rect?.op === "rect") expect(rect.fill).toBe(palette.tokens.accent);
  });
});

describe("packaged fonts", () => {
  it("ships six pairs and references every shipped TTF from a role", () => {
    const registry = packagedRegistry();
    const pairs = registry.catalog().fontPairs;
    expect(pairs.map((entry) => entry.id)).toEqual([
      "classic-serif",
      "editorial",
      "handwritten-elegant",
      "handwritten-note",
      "handwritten-readable",
      "playful",
    ]);
    const referenced = new Set<string>();
    for (const entry of pairs) {
      const pair = registry.fontPair(entry.id);
      for (const role of FONT_PAIR_ROLES) {
        const roleEntry = pair.roles[role];
        expect(roleEntry).toBeDefined();
        expect(existsSync(packagePath("resources/fonts", roleEntry.file))).toBe(true);
        referenced.add(roleEntry.file);
      }
    }
    const shipped = readdirSync(packagePath("resources/fonts")).filter((file) =>
      file.endsWith(".ttf"),
    );
    expect(shipped).toHaveLength(9);
    for (const file of shipped) {
      expect(referenced.has(file), `${file} is not referenced by any role`).toBe(true);
    }
    expect(referenced.size).toBe(shipped.length);
    const note = registry.fontPair("handwritten-note");
    expect(note.roles.display).toMatchObject({
      family: "Caveat",
      file: "Caveat-Bold.ttf",
      weight: 700,
      alias: "CardsmithCaveat700",
    });
    expect(note.roles.body).toMatchObject({
      family: "Caveat",
      file: "Caveat-Regular.ttf",
      weight: 400,
      alias: "CardsmithCaveat400",
    });
  });
});
