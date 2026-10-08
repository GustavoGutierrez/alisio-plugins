import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { ArtifactRef } from "@alisio/sdk";
import type { LruCache } from "../core/cache.js";
import {
  type DesignFormat,
  type DesignSpecInput,
  FAMILIES,
  type Family,
  type NormalizedSpec,
} from "../core/design-spec.js";
import { CardsmithError } from "../core/errors.js";
import type { Catalog, Registry } from "../core/registry.js";
import type { TextMeasurer } from "../core/typography.js";
import type { RenderQueue } from "../renderers/index.js";
import { publishOrNull } from "./artifacts.js";
import type { DraftRecord, DraftStore } from "./drafts.js";
import { type RenderContext, type RenderMode, renderDraft, workingFilePath } from "./rendering.js";
import {
  copyIntoWorkspace,
  defaultExportName,
  moveIntoWorkspace,
  resolveInsideWorkspace,
} from "./workspace.js";

export type ExportMode = "copy" | "move";

/** Deterministic dependencies of every operation; tools build them from `PluginAPI`. */
export interface OperationDeps {
  registry: Registry;
  measurer: TextMeasurer;
  queue: RenderQueue;
  cache: LruCache;
  store: DraftStore;
  workingDir: string;
}

/** Model-facing summary plus structured fields for tests and adapters. */
export interface OperationResult<T> {
  text: string;
  data: T;
}

export interface DraftData {
  draftId: string;
  revision: number;
  spec: NormalizedSpec;
  warnings: string[];
}

export interface RenderData {
  draftId: string;
  revision: number;
  mode: RenderMode;
  format: DesignFormat;
  file: string;
  width: number;
  height: number;
  mimeType: string;
  cacheHit: boolean;
  warnings: string[];
  artifact: ArtifactRef | null;
}

export interface ExportData {
  draftId: string;
  revision: number;
  mode: ExportMode;
  format: DesignFormat;
  file: string;
  bytes: number;
  overwrite: boolean;
}

export interface CatalogInput {
  family?: string;
  templateId?: string;
}

function requireDraftId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CardsmithError("INVALID_SPEC", "draftId must be a non-empty string", {
      field: "draftId",
    });
  }
  return value;
}

function parseRenderMode(value: unknown): RenderMode {
  if (value === undefined) return "final";
  if (value !== "preview" && value !== "final") {
    throw new CardsmithError("INVALID_SPEC", 'mode must be "preview" or "final"', {
      field: "mode",
      value,
    });
  }
  return value;
}

function parseExportMode(value: unknown): ExportMode {
  if (value === undefined) return "copy";
  if (value !== "copy" && value !== "move") {
    throw new CardsmithError("INVALID_SPEC", 'mode must be "copy" or "move"', {
      field: "mode",
      value,
    });
  }
  return value;
}

function parseFormat(value: unknown): DesignFormat | undefined {
  if (value === undefined) return undefined;
  if (value !== "png" && value !== "jpeg") {
    throw new CardsmithError("INVALID_SPEC", 'format must be "png" or "jpeg"', {
      field: "format",
      value,
    });
  }
  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function toDraftData(draft: DraftRecord): DraftData {
  return {
    draftId: draft.id,
    revision: draft.revision,
    spec: draft.spec,
    warnings: draft.warnings,
  };
}

function draftText(draft: DraftRecord, verb: string, deps: OperationDeps): string {
  const { spec } = draft;
  const preset = deps.registry.size(spec.sizeId);
  let text = `draft ${draft.id} revision ${draft.revision}: ${verb} ${spec.family}/${spec.templateId} at ${spec.sizeId} ${preset.width}x${preset.height}, palette ${spec.paletteId}, format ${spec.format}.`;
  if (draft.warnings.length > 0) {
    text += ` Warnings: ${draft.warnings.join("; ")}.`;
  }
  return text;
}

function supportsText(supports: { qr: boolean; illustration: boolean; images: boolean }): string {
  const flags: string[] = [];
  if (supports.qr) flags.push("qr");
  if (supports.illustration) flags.push("illustration");
  if (supports.images) flags.push("images");
  return flags.length > 0 ? flags.join(", ") : "text only";
}

/**
 * Compact catalog: ids, short English labels, compatible sizes, required fields and feature
 * flags. Layout internals, palette tokens and font files never reach the model this way.
 */
export function catalog(
  input: CatalogInput,
  deps: Pick<OperationDeps, "registry">,
): OperationResult<Catalog> {
  const full = deps.registry.catalog();
  let templates = full.templates;
  if (input.family !== undefined) {
    if (!(FAMILIES as readonly string[]).includes(input.family)) {
      throw new CardsmithError("INVALID_SPEC", `Unknown family "${input.family}"`, {
        field: "family",
        value: input.family,
      });
    }
    templates = templates.filter((template) => template.family === (input.family as Family));
  }
  if (input.templateId !== undefined) {
    deps.registry.template(input.templateId);
    templates = templates.filter((template) => template.id === input.templateId);
  }
  const data: Catalog = {
    templates,
    palettes: full.palettes,
    fontPairs: full.fontPairs,
    illustrations: full.illustrations,
    sizes: full.sizes,
    formats: full.formats,
  };
  const lines: string[] = [`Cardsmith catalog (${data.templates.length} templates):`];
  for (const template of data.templates) {
    let line = `- ${template.id} [${template.family}] "${template.label.en}" sizes: ${template.sizes.join(", ")}; required: ${template.requiredFields.join(", ") || "none"}; supports: ${supportsText(template.supports)}`;
    if (template.defaultIllustration !== undefined) {
      line += `; default illustration: ${template.defaultIllustration}`;
    }
    lines.push(line);
  }
  lines.push(`illustrations (${data.illustrations.length}):`);
  for (const illustration of data.illustrations) {
    lines.push(`- ${illustration.id} [${illustration.tags.join(", ")}] "${illustration.label.en}"`);
  }
  lines.push(`palettes: ${data.palettes.map((palette) => palette.id).join(", ")}`);
  lines.push(`fontPairs: ${data.fontPairs.map((pair) => pair.id).join(", ")}`);
  lines.push(`sizes: ${data.sizes.map((size) => size.id).join(", ")}`);
  lines.push(`formats: ${data.formats.join(", ")}`);
  return { text: lines.join("\n"), data };
}

/** Create a draft from a raw spec; invalid input throws `INVALID_SPEC` with structured errors. */
export async function design(
  input: DesignSpecInput,
  deps: OperationDeps,
): Promise<OperationResult<DraftData>> {
  const draft = await deps.store.create(input, { registry: deps.registry });
  return { text: draftText(draft, "created", deps), data: toDraftData(draft) };
}

/** Compare-and-set patch; a stale revision throws `REVISION_MISMATCH` with `{ expected, actual }`. */
export async function update(
  draftId: string,
  expectedRevision: number,
  patch: Record<string, unknown>,
  deps: OperationDeps,
): Promise<OperationResult<DraftData>> {
  const id = requireDraftId(draftId);
  const draft = await deps.store.update(id, expectedRevision, patch, {
    registry: deps.registry,
  });
  return { text: draftText(draft, "updated", deps), data: toDraftData(draft) };
}

/**
 * Render a draft and, for final renders only, publish through the host artifact bridge when the
 * context carries one. Returns the working file, dimensions, cache status and artifact reference;
 * the tool adapter decides how to project the bytes into the `ToolResult`.
 */
export async function render(
  draftId: string,
  request: { mode?: string; format?: string },
  deps: OperationDeps,
  context: RenderContext,
): Promise<OperationResult<RenderData>> {
  const id = requireDraftId(draftId);
  const mode = parseRenderMode(request.mode);
  const format = parseFormat(request.format);
  const draft = await deps.store.get(id);
  const rendered = await renderDraft(
    deps,
    draft,
    format === undefined ? { mode, context } : { mode, format, context },
  );
  const effectiveFormat = format ?? draft.spec.format;
  let artifact: ArtifactRef | null = null;
  if (mode === "final") {
    artifact = await publishOrNull(context, {
      sourceFile: rendered.file,
      title: deps.registry.template(draft.spec.templateId).label.en,
    });
  }
  let text = `draft ${draft.id} revision ${draft.revision}: rendered ${mode} ${rendered.rendered.width}x${rendered.rendered.height} ${effectiveFormat}${rendered.cacheHit ? " (cache hit)" : ""}.`;
  if (artifact !== null) text += ` artifact ${artifact.id}.`;
  return {
    text,
    data: {
      draftId: draft.id,
      revision: draft.revision,
      mode,
      format: effectiveFormat,
      file: rendered.file,
      width: rendered.rendered.width,
      height: rendered.rendered.height,
      mimeType: rendered.rendered.mimeType,
      cacheHit: rendered.cacheHit,
      warnings: rendered.warnings,
      artifact,
    },
  };
}

/**
 * Save the final working file into the workspace. Reuses the working file of the same revision
 * and format when it exists; otherwise renders the final first (normally a cache hit). `copy`
 * keeps the working file; `move` removes it only after the destination hash is verified.
 */
export async function exportCard(
  draftId: string,
  request: { path?: string; mode?: string; overwrite?: boolean; format?: string },
  deps: OperationDeps,
  context: RenderContext,
): Promise<OperationResult<ExportData>> {
  const id = requireDraftId(draftId);
  const draft = await deps.store.get(id);
  const mode = parseExportMode(request.mode);
  const format = parseFormat(request.format) ?? draft.spec.format;
  const overwrite = request.overwrite === true;
  const target = request.path ?? defaultExportName(draft.id, format);
  const destAbs =
    context.resolvePath === undefined
      ? await resolveInsideWorkspace(context.workspace, target)
      : await resolveInsideWorkspace(context.workspace, target, {
          resolvePath: context.resolvePath,
        });

  let file = workingFilePath(deps, draft, "final", format);
  if (!(await fileExists(file))) {
    const rendered = await renderDraft(deps, draft, { mode: "final", format, context });
    file = rendered.file;
  }
  const copied =
    mode === "move"
      ? await moveIntoWorkspace(file, destAbs, { overwrite })
      : await copyIntoWorkspace(file, destAbs, { overwrite });

  const preset = deps.registry.size(draft.spec.sizeId);
  const display = relative(context.workspace, destAbs) || basename(destAbs);
  const text = `draft ${draft.id} revision ${draft.revision}: ${mode === "move" ? "moved" : "saved"} ${basename(copied.path)} (${preset.width}x${preset.height} ${format}, ${copied.bytes} bytes) to ${display}.`;
  return {
    text,
    data: {
      draftId: draft.id,
      revision: draft.revision,
      mode,
      format,
      file: copied.path,
      bytes: copied.bytes,
      overwrite,
    },
  };
}
