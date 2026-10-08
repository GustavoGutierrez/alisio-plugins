import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../core/cache.js";
import {
  type DesignSpecInput,
  type NormalizedSpec,
  normalizeSpec,
  type SpecError,
  type SpecResourceResolver,
} from "../core/design-spec.js";
import { CardsmithError } from "../core/errors.js";
import { atomicWriteFile } from "./state.js";

/** A persisted design draft. Timestamps are bookkeeping only; they never reach the Scene. */
export interface DraftRecord {
  id: string;
  revision: number;
  spec: NormalizedSpec;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DraftCreateOptions {
  registry: SpecResourceResolver;
  /** Extra warnings from the caller, appended after the normalization warnings. */
  warnings?: string[];
}

export interface DraftUpdateOptions {
  registry: SpecResourceResolver;
}

const DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(id: unknown): CardsmithError {
  return new CardsmithError("DRAFT_NOT_FOUND", `Draft "${String(id)}" was not found`, {
    draftId: id,
  });
}

function invalidSpec(errors: SpecError[]): CardsmithError {
  return new CardsmithError(
    "INVALID_SPEC",
    `Design spec is invalid (${errors.length} error${errors.length === 1 ? "" : "s"})`,
    { errors },
  );
}

function corruptDraft(id: string): CardsmithError {
  return new CardsmithError("INVALID_SPEC", `Draft "${id}" on disk is not a valid draft file`, {
    draftId: id,
  });
}

function parseRecord(value: unknown, id: string): DraftRecord {
  if (!isRecord(value)) throw corruptDraft(id);
  const { revision, spec, warnings, createdAt, updatedAt } = value;
  if (
    value.id !== id ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    !isRecord(spec) ||
    !Array.isArray(warnings) ||
    !warnings.every((warning) => typeof warning === "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw corruptDraft(id);
  }
  return {
    id,
    revision,
    spec: spec as unknown as NormalizedSpec,
    warnings: warnings as string[],
    createdAt,
    updatedAt,
  };
}

/** Merge a patch onto a normalized spec: `content` merges per key, every other field replaces. */
function mergePatch(current: NormalizedSpec, patch: Record<string, unknown>): DesignSpecInput {
  const merged: Record<string, unknown> = { ...current };
  // A normalized spec always carries `images: []`; keeping it would make `normalizeSpec` reject
  // templates that do not support input images.
  if (Array.isArray(merged.images) && merged.images.length === 0) delete merged.images;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "content") {
      if (isRecord(value) && isRecord(current.content)) {
        const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
        merged.content = { ...current.content, ...Object.fromEntries(entries) };
      } else {
        merged.content = value;
      }
      continue;
    }
    merged[key] = value;
  }
  return merged as unknown as DesignSpecInput;
}

/**
 * Drafts under `drafts/<id>.json`: created by normalization, fetched by id and patched with a
 * compare-and-set revision. Every write is atomic and every mutation re-runs `normalizeSpec`, so
 * a persisted draft is always a valid, renderable specification.
 */
export class DraftStore {
  readonly #dir: string;

  constructor(draftsDir: string) {
    this.#dir = draftsDir;
  }

  pathFor(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  async create(input: DesignSpecInput, options: DraftCreateOptions): Promise<DraftRecord> {
    const result = normalizeSpec(input, options.registry);
    if (!result.ok) throw invalidSpec(result.errors);
    const now = new Date().toISOString();
    const record: DraftRecord = {
      id: randomUUID(),
      revision: 1,
      spec: result.spec,
      warnings: [...result.warnings, ...(options.warnings ?? [])],
      createdAt: now,
      updatedAt: now,
    };
    await this.#persist(record);
    return record;
  }

  async get(id: string): Promise<DraftRecord> {
    if (typeof id !== "string" || !DRAFT_ID_PATTERN.test(id)) throw notFound(id);
    let text: string;
    try {
      text = await readFile(this.pathFor(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(id);
      throw new CardsmithError("RENDER_FAILED", `Draft "${id}" could not be read`, {
        draftId: id,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw corruptDraft(id);
    }
    return parseRecord(parsed, id);
  }

  async update(
    id: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
    options: DraftUpdateOptions,
  ): Promise<DraftRecord> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new CardsmithError("INVALID_SPEC", "expectedRevision must be a positive integer", {
        expectedRevision,
      });
    }
    if (!isRecord(patch)) {
      throw new CardsmithError("INVALID_SPEC", "patch must be a JSON object", { patch });
    }
    const current = await this.get(id);
    if (expectedRevision !== current.revision) {
      throw new CardsmithError(
        "REVISION_MISMATCH",
        `Draft "${id}" is at revision ${current.revision}, not ${expectedRevision}`,
        { expected: expectedRevision, actual: current.revision },
      );
    }
    const result = normalizeSpec(mergePatch(current.spec, patch), options.registry);
    if (!result.ok) throw invalidSpec(result.errors);
    const record: DraftRecord = {
      id: current.id,
      revision: current.revision + 1,
      spec: result.spec,
      warnings: result.warnings,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist(record);
    return record;
  }

  async #persist(record: DraftRecord): Promise<void> {
    try {
      await atomicWriteFile(this.pathFor(record.id), canonicalJson(record), 0o600);
    } catch (error) {
      throw new CardsmithError("RENDER_FAILED", `Draft "${record.id}" could not be saved`, {
        draftId: record.id,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
