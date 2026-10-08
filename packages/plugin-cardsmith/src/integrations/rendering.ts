import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext } from "@alisio/sdk";
import { canonicalJson, computeCacheKey, type LruCache } from "../core/cache.js";
import type { DesignFormat, NormalizedSpec } from "../core/design-spec.js";
import { CardsmithError } from "../core/errors.js";
import { assertInputImageBudget } from "../core/limits.js";
import type { Registry } from "../core/registry.js";
import type { Scene } from "../core/scene.js";
import type { TextMeasurer } from "../core/typography.js";
import { generatorFor } from "../generators/index.js";
import {
  type ImageInput,
  loadImageInputs,
  RENDERER_VERSION,
  type RenderedImage,
  type RenderQueue,
  renderScene,
} from "../renderers/index.js";
import { packagePath } from "../resource-paths.js";
import type { DraftRecord } from "./drafts.js";
import { atomicWriteFile } from "./state.js";
import { resolveInsideWorkspace } from "./workspace.js";

export type RenderMode = "preview" | "final";

/** Preview renders shrink the logical scene so the chat image stays cheap to display. */
export const PREVIEW_SCALE = 0.35;

/** Everything `renderDraft` needs besides the draft itself. */
export interface RenderDeps {
  registry: Registry;
  measurer: TextMeasurer;
  queue: RenderQueue;
  cache: LruCache;
  workingDir: string;
}

/** Context slice used by rendering; the same fields a tool call receives. */
export type RenderContext = Pick<ToolContext, "workspace" | "signal" | "resolvePath" | "artifacts">;

export interface RenderRequest {
  mode: RenderMode;
  format?: DesignFormat;
  context: RenderContext;
}

export interface RenderResult {
  /** Working file for this revision, mode and format; preview and final never share a name. */
  file: string;
  rendered: RenderedImage;
  warnings: string[];
  cacheHit: boolean;
  scene: Scene;
}

/** `working/<id8>-r<rev>-<mode>.<ext>`; mode keeps preview bytes from ever replacing a final. */
export function workingFileName(
  draftId: string,
  revision: number,
  mode: RenderMode,
  format: DesignFormat,
): string {
  const extension = format === "jpeg" ? "jpg" : "png";
  return `${draftId.slice(0, 8)}-r${revision}-${mode}.${extension}`;
}

export function workingFilePath(
  deps: Pick<RenderDeps, "workingDir">,
  draft: Pick<DraftRecord, "id" | "revision">,
  mode: RenderMode,
  format: DesignFormat,
): string {
  return join(deps.workingDir, workingFileName(draft.id, draft.revision, mode, format));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface NoticeEntry {
  file?: unknown;
  sha256?: unknown;
}

let cachedFontHashes: Record<string, string> | undefined;

/** SHA-256 per shipped TTF, from the font NOTICE; part of every render cache key. */
export function fontHashes(): Record<string, string> {
  if (cachedFontHashes !== undefined) return cachedFontHashes;
  const file = packagePath("resources", "fonts", "NOTICE.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CardsmithError("RENDER_FAILED", "Font NOTICE could not be read", {
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const hashes: Record<string, string> = {};
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { file: noticeFile, sha256 } = entry as NoticeEntry;
      if (
        typeof noticeFile === "string" &&
        noticeFile.endsWith(".ttf") &&
        typeof sha256 === "string" &&
        sha256.length > 0
      ) {
        hashes[noticeFile] = sha256;
      }
    }
  }
  if (Object.keys(hashes).length === 0) {
    throw new CardsmithError("RENDER_FAILED", "Font NOTICE declares no font hashes", { file });
  }
  cachedFontHashes = hashes;
  return hashes;
}

/**
 * Read and bound every input image of a render. Paths are resolved with the workspace rules
 * (relative only, no traversal, symlink containment) and each file is size-checked before and
 * after reading. Returns the decoded inputs plus a content hash of the bytes, so the cache key
 * never depends on a path that could point at different bytes later.
 */
async function readSpecImages(
  spec: NormalizedSpec,
  context: RenderContext,
): Promise<{ inputs: ImageInput[]; imagesHash: string }> {
  const inputs: ImageInput[] = [];
  const digests: Record<string, string> = {};
  for (const image of spec.images) {
    const file =
      context.resolvePath === undefined
        ? await resolveInsideWorkspace(context.workspace, image.path)
        : await resolveInsideWorkspace(context.workspace, image.path, {
            resolvePath: context.resolvePath,
          });
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch (error) {
      throw new CardsmithError(
        "IMAGE_DECODE_FAILED",
        `Input image "${image.id}" could not be read`,
        {
          id: image.id,
          path: image.path,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!info.isFile()) {
      throw new CardsmithError(
        "IMAGE_DECODE_FAILED",
        `Input image "${image.id}" is not a regular file`,
        { id: image.id, path: image.path },
      );
    }
    assertInputImageBudget(info.size);
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (error) {
      throw new CardsmithError(
        "IMAGE_DECODE_FAILED",
        `Input image "${image.id}" could not be read`,
        {
          id: image.id,
          path: image.path,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    assertInputImageBudget(data.byteLength);
    inputs.push({ id: image.id, data: new Uint8Array(data) });
    digests[image.id] = createHash("sha256").update(data).digest("hex");
  }
  const imagesHash = createHash("sha256").update(canonicalJson(digests)).digest("hex");
  return { inputs, imagesHash };
}

/**
 * Turn a draft into a working image.
 *
 * Order: resolve and bound input images, validate and compose the scene, compute the cache key
 * (spec + versions + font hashes + palette + size + locale + format + image content + mode), then
 * either reuse the cached bytes (rewriting the working file when it is missing) or render once
 * inside the bounded queue and persist the working file atomically. Preview and final are
 * distinct keys and distinct files; a preview never replaces the final image.
 */
export async function renderDraft(
  deps: RenderDeps,
  draft: DraftRecord,
  request: RenderRequest,
): Promise<RenderResult> {
  const spec = draft.spec;
  const format = request.format ?? spec.format;
  const scale = request.mode === "preview" ? PREVIEW_SCALE : 1;

  const { inputs, imagesHash } = await readSpecImages(spec, request.context);
  const images = await loadImageInputs(inputs);

  const generator = generatorFor(spec.family);
  const generatorContext = { registry: deps.registry, measurer: deps.measurer };
  const validation = generator.validate(spec, generatorContext);
  if (validation.length > 0) {
    throw new CardsmithError(
      "INVALID_SPEC",
      `The ${spec.family} generator rejected the draft (${validation.length} error${validation.length === 1 ? "" : "s"})`,
      { errors: validation },
    );
  }
  const { scene, warnings } = generator.compose(spec, generatorContext);

  const template = deps.registry.template(spec.templateId);
  const palette = deps.registry.palette(spec.paletteId);
  const cacheKey = computeCacheKey({
    specJson: canonicalJson(spec),
    templateVersion: template.version,
    rendererVersion: RENDERER_VERSION,
    fontHashes: fontHashes(),
    paletteVersion: palette.version,
    sizeId: spec.sizeId,
    locale: spec.locale,
    format,
    imagesHash,
    mode: request.mode,
  });
  const file = workingFilePath(deps, draft, request.mode, format);

  let bytes = await deps.cache.get(cacheKey);
  const cacheHit = bytes !== null;
  if (bytes === null) {
    const rendered = await deps.queue.run(
      (signal) => renderScene(scene, { format, scale, images, signal }),
      request.context.signal,
    );
    bytes = rendered.bytes;
    await atomicWriteFile(file, bytes, 0o600);
    try {
      await deps.cache.put(cacheKey, bytes);
    } catch {
      // The cache is best-effort; a full or unwritable cache never fails a good render.
    }
  } else if (!(await fileExists(file))) {
    await atomicWriteFile(file, bytes, 0o600);
  }

  const rendered: RenderedImage = {
    bytes,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    width: Math.max(1, Math.round(scene.width * scale)),
    height: Math.max(1, Math.round(scene.height * scale)),
    scale,
  };
  return { file, rendered, warnings, cacheHit, scene };
}
