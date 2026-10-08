import { type DesignSpecInput, FAMILIES, type Family, normalizeSpec } from "./core/design-spec.js";
import { CardsmithError } from "./core/errors.js";
import { type Catalog, createRegistry, type Registry } from "./core/registry.js";
import type { TextMeasurer } from "./core/typography.js";
import { generatorFor } from "./generators/index.js";
import { createTextMeasurer, loadImageInputs, renderScene } from "./renderers/index.js";
import { packagePath } from "./resource-paths.js";

/**
 * Standalone renderer entry (`@alisio/plugin-cardsmith/renderer`).
 *
 * Renders one validated design spec to image bytes with the packaged templates, palettes,
 * illustrations and fonts. It needs no Alisio runtime, no plugin setup and no SDK: the host
 * application keeps authentication, data access and endpoint policy on its side and calls here
 * only to draw pixels.
 */

export interface RenderCardOptions {
  /** In-memory images for the spec's image slots; the spec itself carries ids only. */
  imageData?: { id: string; data: Uint8Array }[];
  /** Output format; defaults to `spec.format` (`"png"` when the spec omits it). */
  format?: "png" | "jpeg";
  /** JPEG quality within (0, 100]; ignored for PNG. Defaults to 90. */
  jpegQuality?: number;
  /** Raster scale within (0, 1]; 1 (default) renders at the full preset size. */
  scale?: number;
}

export interface RenderedCard {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  scale: number;
  warnings: string[];
}

export interface CardCatalogFilters {
  family?: Family;
  templateId?: string;
}

let registryInstance: Registry | undefined;
let measurerInstance: TextMeasurer | undefined;

/** Lazily load the packaged resources once per process. */
function runtimeRegistry(): Registry {
  registryInstance ??= createRegistry({
    templatesDir: packagePath("resources", "templates"),
    palettesDir: packagePath("resources", "palettes"),
    illustrationsDir: packagePath("resources", "illustrations"),
    fontPairsFile: packagePath("resources", "font-pairs.json"),
  });
  return registryInstance;
}

function runtimeMeasurer(): TextMeasurer {
  measurerInstance ??= createTextMeasurer();
  return measurerInstance;
}

/**
 * Compact catalog of templates, palettes, font pairs, sizes and formats, optionally narrowed to
 * one family or template. Unknown ids fail with the same typed errors as the chat tools.
 */
export function cardCatalog(filters: CardCatalogFilters = {}): Catalog {
  const registry = runtimeRegistry();
  const full = registry.catalog();
  const { family, templateId } = filters;
  if (family !== undefined && !(FAMILIES as readonly string[]).includes(family)) {
    throw new CardsmithError("INVALID_SPEC", `Unknown family "${String(family)}"`, {
      field: "family",
      value: family,
    });
  }
  if (templateId !== undefined) registry.template(templateId);
  const templates = full.templates.filter(
    (entry) =>
      (family === undefined || entry.family === family) &&
      (templateId === undefined || entry.id === templateId),
  );
  return { ...full, templates };
}

/**
 * Render one design spec to bytes. The spec is validated against the packaged registry, the
 * family generator validates and composes the scene, input images are decoded and bounded, and
 * Skia rasterizes without timestamps so equal input yields equal bytes in a fixed environment.
 *
 * Validation failures throw `CardsmithError("INVALID_SPEC")` with the structured `errors` array
 * in `details`; every other typed failure (budgets, decoding, QR density) propagates unchanged.
 * `warnings` lists the normalization defaults report plus the generator composition warnings.
 */
export async function renderCard(
  input: DesignSpecInput,
  options: RenderCardOptions = {},
): Promise<RenderedCard> {
  const registry = runtimeRegistry();
  const normalized = normalizeSpec(input, registry);
  if (!normalized.ok) {
    const count = normalized.errors.length;
    throw new CardsmithError(
      "INVALID_SPEC",
      `Design spec is invalid (${count} error${count === 1 ? "" : "s"})`,
      { errors: normalized.errors },
    );
  }
  const spec = normalized.spec;
  const context = { registry, measurer: runtimeMeasurer() };
  const generator = generatorFor(spec.family);
  const validation = generator.validate(spec, context);
  if (validation.length > 0) {
    const count = validation.length;
    throw new CardsmithError(
      "INVALID_SPEC",
      `The ${spec.family} generator rejected the draft (${count} error${count === 1 ? "" : "s"})`,
      { errors: validation },
    );
  }
  const { scene, warnings } = generator.compose(spec, context);
  const images = await loadImageInputs(options.imageData ?? []);
  const rendered = await renderScene(scene, {
    format: options.format ?? spec.format,
    ...(options.jpegQuality !== undefined ? { jpegQuality: options.jpegQuality } : {}),
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    images,
  });
  return {
    bytes: rendered.bytes,
    mimeType: rendered.mimeType,
    width: rendered.width,
    height: rendered.height,
    scale: rendered.scale,
    warnings: [...normalized.warnings, ...warnings],
  };
}

export type { DesignSpecInput, Family } from "./core/design-spec.js";
export type { Catalog } from "./core/registry.js";
export {
  type CardEndpoint,
  type CardEndpointRequest,
  type CardEndpointResult,
  createCardRequestHandler,
  DEFAULT_CARD_CACHE_CONTROL,
} from "./integrations/http-renderer.js";
export { RENDERER_VERSION } from "./renderers/index.js";
