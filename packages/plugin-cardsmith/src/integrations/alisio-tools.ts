import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  JsonSchema,
  JsonValue,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { LruCache } from "../core/cache.js";
import { type DesignSpecInput, FAMILIES } from "../core/design-spec.js";
import { CardsmithError, type CardsmithErrorCode } from "../core/errors.js";
import { createRegistry, type Registry } from "../core/registry.js";
import type { TextMeasurer } from "../core/typography.js";
import { createTextMeasurer, RenderQueue } from "../renderers/index.js";
import { packagePath } from "../resource-paths.js";
import { artifactBlock, NO_ARTIFACT_BRIDGE_NOTICE } from "./artifacts.js";
import { DraftStore } from "./drafts.js";
import { catalog, design, exportCard, type OperationDeps, render, update } from "./operations.js";
import { type CardsmithStatePaths, resolveStateDir } from "./state.js";

/** Cache budget when the host exposes no `options.cacheBudgetBytes`. */
export const DEFAULT_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** Actionable one-liners per domain error code; appended after the error message. */
const HINTS: Record<CardsmithErrorCode, string> = {
  INVALID_SPEC: "Fix the reported fields and try again.",
  UNKNOWN_TEMPLATE: "Call card_catalog to list the available templates.",
  UNKNOWN_PALETTE: "Call card_catalog for the palette ids.",
  UNKNOWN_FONT_PAIR: "Call card_catalog for the font pair ids.",
  UNKNOWN_SIZE: "Call card_catalog for the size ids.",
  INCOMPATIBLE_SIZE: "Use one of the sizes listed for that template in card_catalog.",
  UNKNOWN_ILLUSTRATION: "Call card_catalog for the illustration ids.",
  UNKNOWN_ASSET: "Re-create the draft; the scene referenced an unknown asset.",
  TEXT_OVERFLOW: "Shorten the text or choose a more spacious template or size.",
  QR_TOO_DENSE: "Use a shorter QR payload or a larger size preset.",
  QR_INVALID: "Fix the QR payload or the error correction level.",
  LIMIT_EXCEEDED: "Reduce the size preset or the number of input images.",
  IMAGE_TOO_LARGE: "Use a smaller image (max 20 MB per file, 12 MP decoded).",
  IMAGE_DECODE_FAILED: "Check that the image is a workspace file and a valid PNG or JPEG.",
  REVISION_MISMATCH: "Call card_update again with the revision from the last result.",
  DRAFT_NOT_FOUND: "Call card_design first; drafts live in the plugin state directory.",
  EXPORT_CONFLICT: "Pass overwrite: true or export with a different name.",
  EXPORT_INVALID_PATH: 'Use a path relative to the workspace and without "..".',
  EXPORT_DELETE_FAILED: "The copy was saved; delete the working file manually if it remains.",
  PUBLISH_UNAVAILABLE: "This host does not offer an artifact store to external plugins yet.",
  RENDER_FAILED: "Try again; report the cause if it persists.",
  CACHE_WRITE_FAILED: "The cache is best-effort; try again.",
  NOT_IMPLEMENTED: "This operation is not available in this version of cardsmith.",
};

const FAMILY_SCHEMA: JsonSchema = { type: "string", enum: [...FAMILIES] };
const FORMAT_SCHEMA: JsonSchema = { type: "string", enum: ["png", "jpeg"] };
const LOCALE_SCHEMA: JsonSchema = { type: "string", enum: ["es", "en"] };

const SPEC_PROPERTIES: JsonSchema = {
  family: { ...FAMILY_SCHEMA, description: "Generator family." },
  templateId: { type: "string", minLength: 1, description: "Template id from card_catalog." },
  sizeId: { type: "string", minLength: 1, description: "Size preset id from card_catalog." },
  paletteId: { type: "string", minLength: 1, description: "Palette id from card_catalog." },
  fontPairId: { type: "string", minLength: 1, description: "Font pair id from card_catalog." },
  content: {
    type: "object",
    additionalProperties: true,
    description: "Template field values keyed by field name.",
  },
  illustrationId: { type: "string", minLength: 1, description: "Illustration id when supported." },
  images: {
    type: "array",
    description: "Workspace-relative input images for templates that declare image slots.",
    items: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Image slot id." },
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
        role: { type: "string" },
      },
      required: ["id", "path"],
      additionalProperties: false,
    },
  },
  qr: {
    type: "object",
    properties: {
      payload: { type: "string", minLength: 1 },
      ecc: { type: "string", enum: ["M", "Q"] },
    },
    required: ["payload"],
    additionalProperties: false,
  },
  seed: { type: "integer", description: "Deterministic seed for generated decoration." },
  format: { ...FORMAT_SCHEMA, description: "Output format; defaults to the draft format." },
  locale: { ...LOCALE_SCHEMA, description: "Text locale for template defaults." },
  date: { type: "string", description: "Explicit YYYY-MM-DD date to draw; never inferred." },
};

const DESIGN_SCHEMA: JsonSchema = {
  type: "object",
  properties: SPEC_PROPERTIES,
  required: ["family", "templateId", "content"],
  additionalProperties: false,
};

const UPDATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    draftId: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
    patch: {
      type: "object",
      properties: SPEC_PROPERTIES,
      additionalProperties: false,
    },
  },
  required: ["draftId", "expectedRevision", "patch"],
  additionalProperties: false,
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function formatError(error: CardsmithError): string {
  const lines = [`${error.code}: ${error.message}`];
  const details = error.details;
  const errors = details?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry !== "object" || entry === null) continue;
      const { field, message } = entry as { field?: unknown; message?: unknown };
      const text = typeof message === "string" ? message : JSON.stringify(entry);
      lines.push(
        typeof field === "string" && field.length > 0 ? `- ${field}: ${text}` : `- ${text}`,
      );
    }
  }
  const suggestion = details?.suggestion;
  if (typeof suggestion === "string" && suggestion.length > 0) {
    lines.push(`Suggested name: ${basename(suggestion)}`);
  }
  lines.push(HINTS[error.code]);
  return lines.join("\n");
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof CardsmithError) return textResult(formatError(error), true);
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`cardsmith failed: ${message}`, true);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CardsmithError("INVALID_SPEC", `${field} must be a non-empty string`, { field });
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CardsmithError("INVALID_SPEC", "expectedRevision must be a positive integer", {
      field: "expectedRevision",
      value,
    });
  }
  return value;
}

function requirePatch(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CardsmithError("INVALID_SPEC", "patch must be a JSON object", { field: "patch" });
  }
  return value as Record<string, unknown>;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CardsmithError("INVALID_SPEC", `${field} must be one of ${allowed.join(", ")}`, {
      field,
      value,
    });
  }
  return value as T;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CardsmithError("INVALID_SPEC", `${field} must be a boolean`, { field, value });
  }
  return value;
}

interface ToolRuntime {
  registry(): Registry;
  measurer(): TextMeasurer;
  queue(): RenderQueue;
  depsFor(context: ToolContext): Promise<OperationDeps>;
}

function cacheBudget(options: Readonly<Record<string, JsonValue>> | undefined): number {
  const value = options?.cacheBudgetBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_CACHE_BUDGET_BYTES;
}

function createRuntime(api: PluginAPI): ToolRuntime {
  let registryInstance: Registry | undefined;
  let measurerInstance: TextMeasurer | undefined;
  let queueInstance: RenderQueue | undefined;
  const states = new Map<string, Promise<CardsmithStatePaths>>();

  const runtimeRegistry = (): Registry => {
    registryInstance ??= createRegistry({
      templatesDir: packagePath("resources", "templates"),
      palettesDir: packagePath("resources", "palettes"),
      illustrationsDir: packagePath("resources", "illustrations"),
      fontPairsFile: packagePath("resources", "font-pairs.json"),
    });
    return registryInstance;
  };
  const runtimeMeasurer = (): TextMeasurer => {
    measurerInstance ??= createTextMeasurer();
    return measurerInstance;
  };
  const runtimeQueue = (): RenderQueue => {
    queueInstance ??= new RenderQueue();
    return queueInstance;
  };
  const statePaths = (workspace: string): Promise<CardsmithStatePaths> => {
    let promise = states.get(workspace);
    if (promise === undefined) {
      promise =
        api.paths === undefined
          ? resolveStateDir({ workspace })
          : resolveStateDir({ apiPaths: api.paths, workspace });
      states.set(workspace, promise);
    }
    return promise;
  };

  return {
    registry: runtimeRegistry,
    measurer: runtimeMeasurer,
    queue: runtimeQueue,
    async depsFor(context: ToolContext): Promise<OperationDeps> {
      const paths = await statePaths(context.workspace);
      return {
        registry: runtimeRegistry(),
        measurer: runtimeMeasurer(),
        queue: runtimeQueue(),
        cache: new LruCache(paths.cacheDir, cacheBudget(api.options)),
        store: new DraftStore(paths.draftsDir),
        workingDir: paths.workingDir,
      };
    },
  };
}

/**
 * Register the five cardsmith tools on the host API and return one disposer. Tools are thin
 * adapters: they validate the call shape, build dependencies from `api.paths` and the call
 * workspace, run the deterministic operation and project the result (text, image, artifact block).
 */
export function registerCardsmithTools(api: PluginAPI): () => void {
  const runtime = createRuntime(api);

  const definitions: ToolDefinition[] = [
    {
      name: "card_catalog",
      description:
        "List Cardsmith templates (ids, compatible sizes, required fields) plus palette, font pair, size and format ids. Read-only and token-light; call it before card_design.",
      inputSchema: {
        type: "object",
        properties: {
          family: { ...FAMILY_SCHEMA, description: "Restrict the listing to one family." },
          templateId: { type: "string", minLength: 1, description: "Show one template only." },
        },
        additionalProperties: false,
      },
      effect: "read",
      execute: async (input) => {
        try {
          const family = optionalString(input.family, "family");
          const templateId = optionalString(input.templateId, "templateId");
          const result = catalog(
            {
              ...(family !== undefined ? { family } : {}),
              ...(templateId !== undefined ? { templateId } : {}),
            },
            { registry: runtime.registry() },
          );
          return textResult(result.text);
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "card_design",
      description:
        "Create a persisted Cardsmith draft from a design spec. Returns a compact draftId and revision; no pixels are rendered yet. Use card_render to see the image.",
      inputSchema: DESIGN_SCHEMA,
      effect: "write",
      execute: async (input, context) => {
        try {
          const deps = await runtime.depsFor(context);
          const result = await design(input as unknown as DesignSpecInput, deps);
          return textResult(result.text);
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "card_update",
      description:
        "Patch a draft with the revision you last saw (compare-and-set). content merges per key; other fields replace. Deterministic: no model call and no rendering.",
      inputSchema: UPDATE_SCHEMA,
      effect: "write",
      execute: async (input, context) => {
        try {
          const draftId = requireString(input.draftId, "draftId");
          const expectedRevision = requireRevision(input.expectedRevision);
          const patch = requirePatch(input.patch);
          const deps = await runtime.depsFor(context);
          const result = await update(draftId, expectedRevision, patch, deps);
          return textResult(result.text);
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "card_render",
      description:
        "Render a draft to an image. mode=preview returns a small draft-quality image; mode=final renders the exportable image and publishes an artifact when the host supports it.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", minLength: 1 },
          mode: {
            type: "string",
            enum: ["preview", "final"],
            description: "Preview is smaller and never replaces the final working file.",
          },
          format: { ...FORMAT_SCHEMA, description: "Override the draft format for this render." },
        },
        required: ["draftId"],
        additionalProperties: false,
      },
      effect: "write",
      execute: async (input, context) => {
        try {
          const draftId = requireString(input.draftId, "draftId");
          const mode = optionalEnum(input.mode, ["preview", "final"] as const, "mode");
          const format = optionalEnum(input.format, ["png", "jpeg"] as const, "format");
          const deps = await runtime.depsFor(context);
          const result = await render(
            draftId,
            {
              ...(mode !== undefined ? { mode } : {}),
              ...(format !== undefined ? { format } : {}),
            },
            deps,
            context,
          );
          const bytes = await readFile(result.data.file);
          let text = result.text;
          if (result.data.artifact === null && result.data.mode === "final") {
            text += `\n${NO_ARTIFACT_BRIDGE_NOTICE}`;
          }
          const content: ToolResult["content"] = [
            { type: "text", text },
            {
              type: "image",
              mimeType: result.data.mimeType,
              data: Buffer.from(bytes).toString("base64"),
            },
          ];
          if (result.data.artifact !== null) {
            content.push({ type: "ui", block: artifactBlock(result.data.artifact) });
          }
          return { content };
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "card_export",
      description:
        "Save the final image of a draft into the workspace. Default name is card-<id>.png; mode=copy keeps the working file, mode=move removes it only after a verified copy.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", minLength: 1 },
          path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative destination; directories are created as needed.",
          },
          mode: {
            type: "string",
            enum: ["copy", "move"],
            description: "copy keeps the working file; move deletes it after hash verification.",
          },
          overwrite: { type: "boolean", description: "Replace an existing destination file." },
          format: { ...FORMAT_SCHEMA, description: "Override the draft format for this export." },
        },
        required: ["draftId"],
        additionalProperties: false,
      },
      effect: "write",
      execute: async (input, context) => {
        try {
          const draftId = requireString(input.draftId, "draftId");
          const path = optionalString(input.path, "path");
          const mode = optionalEnum(input.mode, ["copy", "move"] as const, "mode");
          const overwrite = optionalBoolean(input.overwrite, "overwrite");
          const format = optionalEnum(input.format, ["png", "jpeg"] as const, "format");
          const deps = await runtime.depsFor(context);
          const result = await exportCard(
            draftId,
            {
              ...(path !== undefined ? { path } : {}),
              ...(mode !== undefined ? { mode } : {}),
              ...(overwrite !== undefined ? { overwrite } : {}),
              ...(format !== undefined ? { format } : {}),
            },
            deps,
            context,
          );
          return textResult(result.text);
        } catch (error) {
          return errorResult(error);
        }
      },
    },
  ];

  const disposers = definitions.map((definition) => api.tools.register(definition));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
