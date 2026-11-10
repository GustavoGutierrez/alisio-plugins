import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { AvailableProviderModel, CompletionRequest, ToolSemantic } from "@alisio/sdk";
import { errorCode, SemanticPluginError } from "../errors.js";
import { buildPrompt, type ChatTurn, NOT_FOUND, type Passage, parseCitations } from "./answer.js";
import { chunkSegments, type Segment } from "./chunk.js";
import type { NotebookDb, SourceRow } from "./db.js";
import { extractBytes, extractPdfPages, formatOf } from "./extract.js";
import { JobRunner } from "./jobs.js";
import { ftsQuery, RETRIEVE_EACH, RETRIEVE_KEEP, reciprocalRankFusion } from "./retrieve.js";
import { listDirectory, MAX_FILE_BYTES, readInside, resolveInside } from "./workspace.js";

export const LIMITS = {
  sourcesPerNotebook: 50,
  charsPerSource: 2_000_000,
  chunksPerNotebook: 20_000,
  questionChars: 4000,
  titleChars: 200,
  fileBytes: MAX_FILE_BYTES,
  historyMessages: 50,
  indexBatch: 64,
} as const;

export interface ActionContext {
  sessionId: string;
  workspace: string;
  signal: AbortSignal;
  idempotencyKey?: string;
}

export interface ServiceDeps {
  db: NotebookDb;
  /** The consumer side of `api.semantic` (absent on an older host). */
  semantic: () => ToolSemantic | undefined;
  complete: (request: CompletionRequest) => Promise<string>;
  /** `api.models` (credential-free list of the user's configured models). */
  models?: {
    list(signal?: AbortSignal): Promise<AvailableProviderModel[]>;
    resolve(reference: string, signal?: AbortSignal): Promise<unknown>;
  };
  /** Model a new child of this session would use: Alisio's active model. */
  activeModel?: (sessionId: string) => string | undefined;
}

const ID = /^[a-z2-7]{12}$/;
const READS = new Set([
  "models.list",
  "notebooks.list",
  "notebooks.get",
  "workspace.list",
  "sources.read",
  "sources.passage",
  "chat.history",
  "jobs.get",
]);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** 12 lowercase base32 characters (D16). */
export function newId(): string {
  const bytes = randomBytes(12);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % 32];
  return id;
}
export const collectionOf = (notebookId: string) => `nb-${notebookId}`;
const vectorId = (sourceId: string, ordinal: number) => `${sourceId}:${ordinal}`;

const invalid = (): never => {
  throw new SemanticPluginError("invalid_input");
};
type Input = Record<string, unknown>;
function text(input: Input, key: string, max: number, optional = false): string {
  const value = input[key];
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > max) return invalid();
  return value;
}
function id(input: Input, key: string): string {
  const value = input[key];
  return typeof value === "string" && ID.test(value) ? value : invalid();
}
function ids(input: Input, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.sourcesPerNotebook) return invalid();
  return value.map((v) => (typeof v === "string" && ID.test(v) ? v : invalid()));
}
const localeOf = (input: Input): "en" | "es" => (input.locale === "es" ? "es" : "en");

const GUIDE_INSTRUCTION = `Task: write a short overview of these sources for someone who has not read them (one paragraph, with [n] citations), then exactly three questions the sources can answer.
Format:
Summary: <overview>
Q: <question 1>
Q: <question 2>
Q: <question 3>`;
const SUMMARY_INSTRUCTION =
  "Task: summarize this source in one short paragraph of plain words, citing passages as [n].";

/** The Notebook app's actions, testable without a host (§7.7). */
export class NotebookService {
  readonly db: NotebookDb;
  private readonly deps: ServiceDeps;
  private readonly jobs: JobRunner;
  private readonly idempotent = new Map<string, unknown>();

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.jobs = new JobRunner(deps.db);
  }

  busy() {
    return this.jobs.busy();
  }

  dispose() {
    this.jobs.dispose();
  }

  idle() {
    return this.jobs.idle();
  }

  private semantic(): ToolSemantic | undefined {
    const semantic = this.deps.semantic();
    try {
      return semantic?.available() ? semantic : undefined;
    } catch {
      return undefined;
    }
  }

  async invoke(action: string, input: Input, ctx: ActionContext): Promise<unknown> {
    ctx.signal.throwIfAborted();
    // Only mutations are deduplicated: a read must always see the current state.
    const key =
      ctx.idempotencyKey && !READS.has(action) ? `${action}\0${ctx.idempotencyKey}` : undefined;
    if (key && this.idempotent.has(key)) return this.idempotent.get(key);
    const value = await this.dispatch(action, input ?? {}, ctx);
    if (key) {
      this.idempotent.set(key, value);
      if (this.idempotent.size > 500)
        this.idempotent.delete(this.idempotent.keys().next().value as string);
    }
    return value;
  }

  private notebook(notebookId: string) {
    const row = this.db.notebook(notebookId);
    if (!row) throw new SemanticPluginError("not_found");
    return row;
  }

  private source(sourceId: string) {
    const row = this.db.source(sourceId);
    if (!row) throw new SemanticPluginError("not_found");
    return row;
  }

  private async dispatch(action: string, input: Input, ctx: ActionContext): Promise<unknown> {
    switch (action) {
      case "notebooks.list":
        return this.db.notebooks();
      case "notebooks.get": {
        const row = this.notebook(id(input, "id"));
        const sources = this.db.sources(row.id);
        const current = this.sourceSet(row.id);
        const guide = row.guide
          ? { ...row.guide, outdated: (row.guide.sources as string | undefined) !== current }
          : null;
        return { ...row, guide, sources };
      }
      case "notebooks.setScope": {
        const row = this.notebook(id(input, "id"));
        const known = new Set(this.db.sources(row.id).map((s) => s.id));
        const excluded = (ids(input, "excluded") ?? []).filter((x) => known.has(x));
        this.db.setExcluded(row.id, [...new Set(excluded)]);
        return { ok: true, excluded };
      }
      case "notebooks.create": {
        const title = text(input, "title", LIMITS.titleChars).trim() || "Untitled";
        const notebookId = newId();
        this.db.createNotebook(notebookId, title);
        return { id: notebookId };
      }
      case "notebooks.rename": {
        const row = this.notebook(id(input, "id"));
        this.db.renameNotebook(row.id, text(input, "title", LIMITS.titleChars).trim() || row.title);
        return { ok: true };
      }
      case "notebooks.delete": {
        const row = this.notebook(id(input, "id"));
        for (const job of this.db.activeJobs(row.id)) this.jobs.cancel(job.id);
        await this.semantic()
          ?.drop(collectionOf(row.id), { signal: ctx.signal })
          .catch(() => {});
        this.db.deleteNotebook(row.id);
        return { ok: true };
      }
      case "models.list":
        return this.modelList(ctx);
      case "notebooks.setModel": {
        const row = this.notebook(id(input, "id"));
        const model = input.model;
        if (model === null || model === "") {
          this.db.setModel(row.id, null);
          return { ok: true, model: null };
        }
        if (typeof model !== "string" || model.length > 300) invalid();
        if (!this.deps.models) throw new SemanticPluginError("no_model");
        try {
          await this.deps.models.resolve(model as string, ctx.signal);
        } catch {
          throw new SemanticPluginError("not_found");
        }
        this.db.setModel(row.id, model as string);
        return { ok: true, model };
      }
      case "notice.ack":
        this.db.ackNotice(this.notebook(id(input, "notebookId")).id);
        return { ok: true };
      case "sources.upload":
        return this.upload(input);
      case "sources.addFromWorkspace":
        return this.addFromWorkspace(input, ctx);
      case "workspace.list":
        return listDirectory(ctx.workspace, text(input, "dir", 1024, true));
      case "sources.read": {
        const path = text(input, "path", 1024);
        await resolveInside(ctx.workspace, path);
        if (formatOf(path) !== "pdf") throw new SemanticPluginError("unsupported_format");
        return { base64: (await readInside(ctx.workspace, path)).toString("base64") };
      }
      case "sources.delete": {
        const source = this.source(id(input, "sourceId"));
        await this.removeVectors(source).catch(() => {});
        this.db.deleteSource(source.id);
        const owner = this.db.notebook(source.notebookId);
        if (owner?.excluded.includes(source.id))
          this.db.setExcluded(
            owner.id,
            owner.excluded.filter((x) => x !== source.id),
          );
        return { ok: true };
      }
      case "sources.passage": {
        const source = this.source(id(input, "sourceId"));
        const ordinal = input.ordinal;
        if (!Number.isInteger(ordinal) || (ordinal as number) < 0) invalid();
        const chunk = this.db.chunk(source.id, ordinal as number);
        if (!chunk) throw new SemanticPluginError("not_found");
        return {
          sourceId: source.id,
          sourceName: source.name,
          ordinal: chunk.ordinal,
          text: chunk.text,
          page: chunk.page,
          ...this.pageLabel(source, chunk.page),
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        };
      }
      case "chat.ask":
        return this.ask(input, ctx);
      case "chat.history": {
        const row = this.notebook(id(input, "notebookId"));
        const before = input.before;
        if (before !== undefined && !Number.isInteger(before)) invalid();
        return this.db
          .messages(row.id, LIMITS.historyMessages, before as number | undefined)
          .map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            createdAt: m.createdAt,
            citations: m.meta.citations ?? [],
            grounded: m.meta.grounded ?? true,
            keywordOnly: m.meta.keywordOnly ?? false,
            notFound: m.meta.notFound ?? false,
            modelFallback: m.meta.modelFallback ?? false,
          }));
      }
      case "chat.clear":
        this.db.clearMessages(this.notebook(id(input, "notebookId")).id);
        return { ok: true };
      case "notebook.guide":
        return this.guide(input, ctx);
      case "sources.summary":
        return this.summary(input, ctx);
      case "index.rebuild":
        return this.rebuild(input);
      case "jobs.get": {
        const jobId = text(input, "jobId", 80);
        const job = this.db.job(jobId);
        if (!job) throw new SemanticPluginError("not_found");
        return {
          id: job.id,
          kind: job.kind,
          state: job.state,
          progress: job.progress,
          error: job.error,
          result: job.result,
        };
      }
      case "jobs.cancel": {
        const jobId = text(input, "jobId", 80);
        if (!this.db.job(jobId)) throw new SemanticPluginError("not_found");
        return { cancelled: this.jobs.cancel(jobId) };
      }
      default:
        throw new SemanticPluginError("not_found");
    }
  }

  /** How the frame labels `page`: a PDF page, a slide, or a sheet with its name (O10). */
  private pageLabel(source: SourceRow, page: number | null) {
    if (page === null) return { pageKind: null };
    if (source.kind === "pptx") return { pageKind: "slide" };
    if (source.kind !== "xlsx") return { pageKind: "page" };
    // Each sheet's text starts with "Sheet: <name>", so its first chunk carries the name.
    const first = this.db.chunks(source.id).find((c) => c.page === page);
    return {
      pageKind: "sheet",
      pageName: /^Sheet: (.*)$/m.exec(first?.text ?? "")?.[1] ?? String(page),
    };
  }

  // ---- Sources -------------------------------------------------------------------------------

  private checkSourceLimit(notebookId: string) {
    if (this.db.sources(notebookId).length >= LIMITS.sourcesPerNotebook)
      throw new SemanticPluginError("limit_exceeded");
  }

  private upload(input: Input) {
    const notebook = this.notebook(id(input, "notebookId"));
    const name = basename(text(input, "name", 255).replaceAll("\\", "/")).trim();
    if (!name) invalid();
    let bytes: Buffer;
    let segments: (() => Promise<Segment[]>) | undefined;
    let kind: string;
    let mime: string;
    if (Array.isArray(input.pages)) {
      const pages = input.pages as unknown[];
      if (pages.length > 5000 || !pages.every((p) => typeof p === "string")) invalid();
      if (formatOf(name) !== "pdf") invalid();
      const strings = pages as string[];
      bytes = Buffer.from(strings.join("\f"));
      if (bytes.length > LIMITS.fileBytes * 2) throw new SemanticPluginError("file_too_large");
      kind = "pdf";
      mime = "application/pdf";
      segments = async () => extractPdfPages(strings);
    } else {
      const raw = input.base64;
      if (typeof raw === "string" && raw.length > Math.ceil(LIMITS.fileBytes / 3) * 4 + 4)
        throw new SemanticPluginError("file_too_large");
      const base64 = text(input, "base64", 36_000_000);
      bytes = Buffer.from(base64, "base64");
      if (bytes.length > LIMITS.fileBytes) throw new SemanticPluginError("file_too_large");
      const format = formatOf(name);
      if (!format || format === "pdf") throw new SemanticPluginError("unsupported_format");
      kind = format;
      mime = text(input, "mime", 120, true) || "application/octet-stream";
      segments = () => extractBytes(name, bytes);
    }
    return this.addSource(notebook.id, name, kind, mime, bytes, segments);
  }

  private async addFromWorkspace(input: Input, ctx: ActionContext) {
    const notebook = this.notebook(id(input, "notebookId"));
    const path = text(input, "path", 1024);
    const format = formatOf(path);
    // Workspace PDFs go through the frame (sources.read + PDF.js + sources.upload with pages).
    if (!format || format === "pdf") {
      await resolveInside(ctx.workspace, path);
      throw new SemanticPluginError("unsupported_format");
    }
    const bytes = await readInside(ctx.workspace, path);
    const name = basename(path.replaceAll("\\", "/"));
    return this.addSource(notebook.id, name, format, "application/octet-stream", bytes, () =>
      extractBytes(name, bytes),
    );
  }

  private addSource(
    notebookId: string,
    name: string,
    kind: string,
    mime: string,
    bytes: Buffer,
    segments: () => Promise<Segment[]>,
  ) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.sourceBySha(notebookId, sha256);
    if (existing && existing.status !== "failed")
      return { sourceId: existing.id, jobId: null, duplicate: true };
    if (existing) this.db.deleteSource(existing.id);
    this.checkSourceLimit(notebookId);
    const sourceId = newId();
    this.db.insertSource({
      id: sourceId,
      notebookId,
      name,
      kind,
      mime,
      sha256,
      bytes: bytes.length,
      status: "indexing",
    });
    this.db.touchNotebook(notebookId);
    const jobId = this.jobs.start(
      notebookId,
      "index",
      sourceId,
      async ({ signal, progress }) => {
        const extracted = await segments();
        const characters = extracted.reduce((sum, s) => sum + s.text.length, 0);
        if (characters > LIMITS.charsPerSource) throw new SemanticPluginError("limit_exceeded");
        const { chunks } = chunkSegments(extracted);
        if (chunks.length === 0) throw new SemanticPluginError("no_text");
        if (this.db.notebookChunkCount(notebookId) + chunks.length > LIMITS.chunksPerNotebook)
          throw new SemanticPluginError("limit_exceeded");
        signal.throwIfAborted();
        this.db.replaceChunks(sourceId, chunks);
        progress(0.2);
        return this.indexSource(this.source(sourceId), signal, progress);
      },
      {
        onCancel: async () => {
          const source = this.db.source(sourceId);
          if (!source) return;
          await this.removeVectors(source).catch(() => {});
          this.db.clearChunks(sourceId);
          this.db.setSourceStatus(sourceId, "failed", "cancelled");
        },
        onFail: (code) => {
          if (!this.db.source(sourceId)) return;
          this.db.clearChunks(sourceId);
          this.db.setSourceStatus(sourceId, "failed", code);
        },
      },
    );
    return { sourceId, jobId };
  }

  /** Embeds a source's stored chunks (D10: text lives in SQLite, `keepText: false`). */
  private async indexSource(source: SourceRow, signal: AbortSignal, progress: (n: number) => void) {
    const semantic = this.semantic();
    if (!semantic) {
      this.db.setSourceStatus(source.id, "ready_keyword");
      return { sourceId: source.id, status: "ready_keyword" };
    }
    const chunks = this.db.chunks(source.id);
    try {
      for (let i = 0; i < chunks.length; i += LIMITS.indexBatch) {
        signal.throwIfAborted();
        await semantic.index(
          collectionOf(source.notebookId),
          chunks.slice(i, i + LIMITS.indexBatch).map((c) => ({
            id: vectorId(source.id, c.ordinal),
            text: c.text,
            metadata: { source: source.id, ordinal: c.ordinal },
            keepText: false,
          })),
          { signal },
        );
        progress(0.2 + (0.8 * Math.min(chunks.length, i + LIMITS.indexBatch)) / chunks.length);
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "cancelled" || signal.aborted) throw error;
      // The keyword index is complete; vectors are missing (engine down or model changed).
      this.db.setSourceStatus(
        source.id,
        "ready_keyword",
        code === "model_mismatch" ? "model_mismatch" : "engine_unavailable",
      );
      return { sourceId: source.id, status: "ready_keyword" };
    }
    this.db.setSourceStatus(source.id, "ready");
    return { sourceId: source.id, status: "ready" };
  }

  private async removeVectors(source: SourceRow) {
    const semantic = this.semantic();
    if (!semantic) return;
    const ids = this.db.chunks(source.id).map((c) => vectorId(source.id, c.ordinal));
    for (let i = 0; i < ids.length; i += 500)
      await semantic.remove(collectionOf(source.notebookId), ids.slice(i, i + 500));
  }

  private rebuild(input: Input) {
    const notebook = this.notebook(id(input, "notebookId"));
    if (!this.semantic()) throw new SemanticPluginError("engine_unavailable");
    const jobId = this.jobs.start(notebook.id, "rebuild", null, async ({ signal, progress }) => {
      const semantic = this.semantic();
      if (!semantic) throw new SemanticPluginError("engine_unavailable");
      await semantic.drop(collectionOf(notebook.id), { signal });
      const sources = this.db.sources(notebook.id).filter((s) => s.chunkCount > 0);
      let done = 0;
      for (const source of sources) {
        const result = await this.indexSource(source, signal, () => {});
        if (result.status !== "ready") throw new SemanticPluginError("engine_unavailable");
        progress(++done / Math.max(1, sources.length));
      }
      return { sources: sources.length };
    });
    return { jobId };
  }

  // ---- Retrieval and answers -----------------------------------------------------------------

  /** Hybrid retrieval (D9): vector + FTS5, RRF, top 8; keyword-only when vectors are unavailable. */
  async retrieve(
    notebookId: string,
    query: string,
    options: { sourceIds?: string[] | undefined; signal: AbortSignal; keep?: number },
  ): Promise<{ passages: Passage[]; keywordOnly: boolean }> {
    const scope = options.sourceIds?.length ? new Set(options.sourceIds) : undefined;
    let vector: string[] = [];
    let keywordOnly = true;
    const semantic = this.semantic();
    if (semantic) {
      const single = scope?.size === 1 ? [...scope][0] : undefined;
      const matches = await semantic.trySearch(collectionOf(notebookId), query.slice(0, 32_000), {
        topK: scope && !single ? 100 : RETRIEVE_EACH,
        ...(single ? { filter: { source: single } } : {}),
        signal: options.signal,
      });
      if (matches) {
        keywordOnly = false;
        vector = matches
          .map((m) => m.id)
          .filter((key) => !scope || scope.has(key.split(":")[0] as string))
          .slice(0, RETRIEVE_EACH);
      }
    }
    const keyword = this.db.keywordSearch(
      notebookId,
      ftsQuery(query),
      RETRIEVE_EACH,
      options.sourceIds,
    );
    const fused = reciprocalRankFusion([vector, keyword], { top: options.keep ?? RETRIEVE_KEEP });
    const names = new Map(this.db.sources(notebookId).map((s) => [s.id, s.name]));
    const passages: Passage[] = [];
    for (const key of fused) {
      const [sourceId, ordinal] = key.split(":");
      const chunk = sourceId ? this.db.chunk(sourceId, Number(ordinal)) : undefined;
      if (!chunk || !names.has(chunk.sourceId)) continue;
      passages.push({
        n: passages.length + 1,
        sourceId: chunk.sourceId,
        sourceName: names.get(chunk.sourceId) as string,
        ordinal: chunk.ordinal,
        page: chunk.page,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        text: chunk.text,
      });
    }
    return { passages, keywordOnly };
  }

  /** Configured models (credential-free) and Alisio's active one; empty when none is connected. */
  private async modelList(ctx: ActionContext) {
    const active = (() => {
      try {
        return this.deps.activeModel?.(ctx.sessionId) || null;
      } catch {
        return null;
      }
    })();
    if (!this.deps.models) return { models: [], active, available: true };
    let list: AvailableProviderModel[] = [];
    try {
      list = await this.deps.models.list(ctx.signal);
    } catch {
      list = [];
    }
    const models = list.slice(0, 1000).map((m) => ({
      reference: m.reference,
      name: m.model?.name || m.model?.id || m.reference,
      provider: m.providerName || m.provider,
    }));
    return { models, active, available: models.length > 0 };
  }

  /** Identity of the indexed sources a guide was built from: a new or removed source outdates it. */
  private sourceSet(notebookId: string) {
    return this.db
      .sources(notebookId)
      .filter((s) => s.chunkCount > 0)
      .map((s) => s.id)
      .sort()
      .join(",");
  }

  /** The model that actually answers: the notebook's choice, else Alisio's active model. */
  private modelName(model: string | undefined, ctx: ActionContext) {
    if (model) return model;
    try {
      return this.deps.activeModel?.(ctx.sessionId) ?? null;
    } catch {
      return null;
    }
  }

  /** WHEN no model is configured, asking is refused before any job starts (O12). */
  private async requireModel(ctx: ActionContext) {
    if (!this.deps.models) return;
    const { available } = await this.modelList(ctx);
    if (!available) throw new SemanticPluginError("no_model");
  }

  /**
   * The notebook's chosen model, resolved before each call. A model that no longer exists falls
   * back to Alisio's active model (the choice is cleared) and the answer says so.
   */
  private async modelFor(notebookId: string, signal: AbortSignal) {
    const chosen = this.db.notebook(notebookId)?.model;
    if (!chosen || !this.deps.models) return { model: undefined, fallback: false };
    try {
      await this.deps.models.resolve(chosen, signal);
      return { model: chosen, fallback: false };
    } catch {
      if (signal.aborted) throw new SemanticPluginError("cancelled");
      this.db.setModel(notebookId, null);
      return { model: undefined, fallback: true };
    }
  }

  private async ask(input: Input, ctx: ActionContext) {
    const notebook = this.notebook(id(input, "notebookId"));
    const question = text(input, "question", LIMITS.questionChars).trim();
    if (!question) invalid();
    const sourceIds = ids(input, "sourceIds");
    const locale = localeOf(input);
    await this.requireModel(ctx);
    const jobId = this.jobs.start(notebook.id, "ask", null, async ({ signal, progress }) => {
      const history: ChatTurn[] = this.db
        .messages(notebook.id, 6)
        .map((m) => ({ role: m.role, text: m.text }));
      const { passages, keywordOnly } = await this.retrieve(notebook.id, question, {
        sourceIds,
        signal,
      });
      progress(0.3);
      this.db.addMessage(notebook.id, "user", question);
      if (passages.length === 0) {
        const messageId = this.db.addMessage(notebook.id, "assistant", NOT_FOUND[locale], {
          citations: [],
          grounded: false,
          keywordOnly,
          notFound: true,
        });
        return { messageId, keywordOnly, grounded: false, notFound: true };
      }
      const prompt = buildPrompt(question, passages, history, locale);
      const { model, fallback } = await this.modelFor(notebook.id, signal);
      let answer: string;
      try {
        answer = await this.deps.complete({
          ...prompt,
          maxTokens: 1500,
          sessionId: ctx.sessionId,
          ...(model ? { model } : {}),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SemanticPluginError("answer_failed");
      }
      const parsed = parseCitations(answer, passages);
      const messageId = this.db.addMessage(notebook.id, "assistant", parsed.text, {
        citations: parsed.citations,
        grounded: parsed.grounded,
        keywordOnly,
        ...(fallback ? { modelFallback: true } : {}),
      });
      this.db.touchNotebook(notebook.id);
      return { messageId, keywordOnly, grounded: parsed.grounded, modelFallback: fallback };
    });
    return { jobId };
  }

  /** Round-robin first passages of each source: an overview needs breadth, not one query. */
  private overviewPassages(sources: SourceRow[], keep: number): Passage[] {
    const lists = sources.map((s) =>
      this.db
        .chunks(s.id)
        .slice(0, keep)
        .map((c) => ({ s, c })),
    );
    const picked: Passage[] = [];
    for (let round = 0; picked.length < keep; round++) {
      let any = false;
      for (const list of lists) {
        const item = list[round];
        if (!item || picked.length >= keep) continue;
        any = true;
        picked.push({
          n: picked.length + 1,
          sourceId: item.s.id,
          sourceName: item.s.name,
          ordinal: item.c.ordinal,
          page: item.c.page,
          charStart: item.c.charStart,
          charEnd: item.c.charEnd,
          text: item.c.text,
        });
      }
      if (!any) break;
    }
    return picked;
  }

  private async completeWith(
    passages: Passage[],
    instruction: string,
    ctx: ActionContext,
    signal: AbortSignal,
    locale: "en" | "es",
    notebookId: string,
  ) {
    const prompt = buildPrompt("", passages, [], locale, instruction);
    const { model } = await this.modelFor(notebookId, signal);
    try {
      const answer = await this.deps.complete({
        ...prompt,
        maxTokens: 1500,
        sessionId: ctx.sessionId,
        ...(model ? { model } : {}),
        signal,
      });
      return { answer, model: this.modelName(model, ctx) };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SemanticPluginError("answer_failed");
    }
  }

  private async guide(input: Input, ctx: ActionContext) {
    const notebook = this.notebook(id(input, "notebookId"));
    const locale = localeOf(input);
    await this.requireModel(ctx);
    const jobId = this.jobs.start(notebook.id, "guide", null, async ({ signal }) => {
      const passages = this.overviewPassages(
        this.db.sources(notebook.id).filter((s) => s.chunkCount > 0),
        RETRIEVE_KEEP,
      );
      if (passages.length === 0)
        return { summary: NOT_FOUND[locale], questions: [], citations: [], grounded: false };
      const built = this.sourceSet(notebook.id);
      const { answer, model } = await this.completeWith(
        passages,
        GUIDE_INSTRUCTION,
        ctx,
        signal,
        locale,
        notebook.id,
      );
      const questions = [...answer.matchAll(/^\s*Q:\s*(.+)$/gm)]
        .map((m) => (m[1] as string).trim())
        .slice(0, 3);
      const summaryText = answer
        .replace(/^\s*Q:.*$/gm, "")
        .replace(/^\s*Summary:\s*/im, "")
        .trim();
      const parsed = parseCitations(summaryText, passages);
      const guide = {
        summary: parsed.text,
        questions,
        citations: parsed.citations,
        grounded: parsed.grounded,
        model,
        createdAt: Date.now(),
        sources: built,
      };
      // Persisted (O15): shown again on re-entry and after restarts; never regenerated by itself.
      this.db.setGuide(notebook.id, guide);
      return { ...guide, outdated: false };
    });
    return { jobId };
  }

  private async summary(input: Input, ctx: ActionContext) {
    const source = this.source(id(input, "sourceId"));
    const locale = localeOf(input);
    await this.requireModel(ctx);
    const jobId = this.jobs.start(source.notebookId, "summary", source.id, async ({ signal }) => {
      const passages = this.overviewPassages([source], RETRIEVE_KEEP);
      if (passages.length === 0) throw new SemanticPluginError("no_text");
      const { answer, model } = await this.completeWith(
        passages,
        SUMMARY_INSTRUCTION,
        ctx,
        signal,
        locale,
        source.notebookId,
      );
      const parsed = parseCitations(answer, passages);
      const summary = {
        summary: parsed.text,
        citations: parsed.citations,
        grounded: parsed.grounded,
        model,
        createdAt: Date.now(),
      };
      this.db.setSourceSummary(source.id, summary);
      return { sourceId: source.id, ...summary };
    });
    return { jobId };
  }
}
