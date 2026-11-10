import type { SqlDatabase, SqlRow } from "@alisio/sdk";
import type { Chunk } from "./chunk.js";

/** Numbered migrations (§7.1); `PRAGMA user_version` records the last one applied. */
const MIGRATIONS: string[] = [
  `CREATE TABLE notebooks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     remote_notice_ack INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE sources (
     id TEXT PRIMARY KEY,
     notebook_id TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     mime TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     chunk_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX sources_notebook ON sources(notebook_id);
   CREATE TABLE chunks (
     id INTEGER PRIMARY KEY,
     source_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     text TEXT NOT NULL,
     page INTEGER,
     char_start INTEGER NOT NULL,
     char_end INTEGER NOT NULL,
     UNIQUE (source_id, ordinal)
   );
   CREATE VIRTUAL TABLE chunks_fts USING fts5(
     text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
   );
   CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
     INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
   END;
   CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END;
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     notebook_id TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     citations_json TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX messages_notebook ON messages(notebook_id, id);
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     notebook_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL,
     progress REAL NOT NULL DEFAULT 0,
     error TEXT,
     result_json TEXT,
     source_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // 2 (0.1.1): per-notebook model choice; null means Alisio's active model.
  "ALTER TABLE notebooks ADD COLUMN model TEXT;",
  // 3 (0.1.1, O15): the generated guide, the excluded sources and per-source summaries persist.
  `ALTER TABLE notebooks ADD COLUMN guide_json TEXT;
   ALTER TABLE notebooks ADD COLUMN excluded_json TEXT;
   ALTER TABLE sources ADD COLUMN summary_json TEXT;`,
];

export interface NotebookRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  remoteNoticeAck: boolean;
  /** `<provider>/<model>` chosen for this notebook, or null for Alisio's active model. */
  model: string | null;
  guide: Record<string, unknown> | null;
  excluded: string[];
}
export type SourceStatus = "indexing" | "ready" | "ready_keyword" | "failed";
export interface SourceRow {
  id: string;
  notebookId: string;
  name: string;
  kind: string;
  mime: string;
  sha256: string;
  bytes: number;
  status: SourceStatus;
  error: string | null;
  chunkCount: number;
  createdAt: number;
  summary: Record<string, unknown> | null;
}
export interface ChunkRow {
  id: number;
  sourceId: string;
  ordinal: number;
  text: string;
  page: number | null;
  charStart: number;
  charEnd: number;
}
export interface MessageRow {
  id: number;
  notebookId: string;
  role: "user" | "assistant";
  text: string;
  meta: Record<string, unknown>;
  createdAt: number;
}
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export interface JobRow {
  id: string;
  notebookId: string;
  kind: string;
  state: JobState;
  progress: number;
  error: string | null;
  result: unknown;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

const notebook = (r: SqlRow): NotebookRow => ({
  id: r.id,
  title: r.title,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  remoteNoticeAck: Number(r.remote_notice_ack) === 1,
  model: typeof r.model === "string" && r.model ? r.model : null,
  guide: parse(r.guide_json) ?? null,
  excluded: Array.isArray(parse(r.excluded_json)) ? (parse(r.excluded_json) as string[]) : [],
});
const source = (r: SqlRow): SourceRow => ({
  id: r.id,
  notebookId: r.notebook_id,
  name: r.name,
  kind: r.kind,
  mime: r.mime,
  sha256: r.sha256,
  bytes: Number(r.bytes),
  status: r.status,
  error: r.error ?? null,
  chunkCount: Number(r.chunk_count),
  createdAt: Number(r.created_at),
  summary: parse(r.summary_json) ?? null,
});
const chunk = (r: SqlRow): ChunkRow => ({
  id: Number(r.id),
  sourceId: r.source_id,
  ordinal: Number(r.ordinal),
  text: r.text,
  page: r.page === null || r.page === undefined ? null : Number(r.page),
  charStart: Number(r.char_start),
  charEnd: Number(r.char_end),
});
const parse = (text: unknown) => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const job = (r: SqlRow): JobRow => ({
  id: r.id,
  notebookId: r.notebook_id,
  kind: r.kind,
  state: r.state,
  progress: Number(r.progress),
  error: r.error ?? null,
  result: parse(r.result_json) ?? null,
  sourceId: r.source_id ?? null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** The Notebook's own SQLite store (D10): sources, chunks + FTS5, chat and jobs. */
export class NotebookDb {
  readonly sql: SqlDatabase;
  private readonly now: () => number;

  constructor(sql: SqlDatabase, now: () => number = Date.now) {
    this.sql = sql;
    this.now = now;
    this.migrate();
    // Jobs that were running when the process stopped cannot resume.
    this.sql
      .prepare(
        "UPDATE jobs SET state = 'failed', error = 'operation_failed', updated_at = ? WHERE state IN ('queued', 'running')",
      )
      .run(this.now());
    this.sql
      .prepare(
        "UPDATE sources SET status = 'failed', error = 'operation_failed' WHERE status = 'indexing'",
      )
      .run();
  }

  private migrate() {
    const version = Number(this.sql.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    for (let v = version; v < MIGRATIONS.length; v++)
      this.sql.transaction(() => {
        this.sql.exec(MIGRATIONS[v] as string);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
  }

  close() {
    this.sql.close();
  }

  // Notebooks
  createNotebook(id: string, title: string) {
    const at = this.now();
    this.sql
      .prepare("INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, title, at, at);
  }
  notebook(id: string): NotebookRow | undefined {
    const row = this.sql.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
    return row ? notebook(row) : undefined;
  }
  notebooks(): Array<NotebookRow & { sourceCount: number }> {
    return this.sql
      .prepare(
        "SELECT n.*, (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = n.id) AS source_count FROM notebooks n ORDER BY n.updated_at DESC, n.id",
      )
      .all()
      .map((r) => ({ ...notebook(r), sourceCount: Number(r.source_count) }));
  }
  findNotebook(reference: string): NotebookRow | undefined {
    const byId = this.notebook(reference);
    if (byId) return byId;
    const row = this.sql
      .prepare(
        "SELECT * FROM notebooks WHERE title = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1",
      )
      .get(reference);
    return row ? notebook(row) : undefined;
  }
  renameNotebook(id: string, title: string) {
    this.sql
      .prepare("UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, this.now(), id);
  }
  touchNotebook(id: string) {
    this.sql.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(this.now(), id);
  }
  setModel(id: string, model: string | null) {
    this.sql.prepare("UPDATE notebooks SET model = ? WHERE id = ?").run(model, id);
  }
  ackNotice(id: string) {
    this.sql.prepare("UPDATE notebooks SET remote_notice_ack = 1 WHERE id = ?").run(id);
  }
  deleteNotebook(id: string) {
    this.sql.transaction(() => {
      this.sql
        .prepare(
          "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE notebook_id = ?)",
        )
        .run(id);
      this.sql.prepare("DELETE FROM sources WHERE notebook_id = ?").run(id);
      this.sql.prepare("DELETE FROM messages WHERE notebook_id = ?").run(id);
      this.sql.prepare("DELETE FROM jobs WHERE notebook_id = ?").run(id);
      this.sql.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
    });
  }
  countNotebooks(): number {
    return Number(this.sql.prepare("SELECT COUNT(*) AS n FROM notebooks").get()?.n ?? 0);
  }

  // Sources
  setGuide(id: string, guide: Record<string, unknown> | null) {
    this.sql
      .prepare("UPDATE notebooks SET guide_json = ? WHERE id = ?")
      .run(guide ? JSON.stringify(guide) : null, id);
  }
  setExcluded(id: string, excluded: string[]) {
    this.sql
      .prepare("UPDATE notebooks SET excluded_json = ? WHERE id = ?")
      .run(JSON.stringify(excluded), id);
  }
  setSourceSummary(id: string, summary: Record<string, unknown> | null) {
    this.sql
      .prepare("UPDATE sources SET summary_json = ? WHERE id = ?")
      .run(summary ? JSON.stringify(summary) : null, id);
  }
  insertSource(row: Omit<SourceRow, "chunkCount" | "createdAt" | "error" | "summary">) {
    this.sql
      .prepare(
        "INSERT INTO sources (id, notebook_id, name, kind, mime, sha256, bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.notebookId,
        row.name,
        row.kind,
        row.mime,
        row.sha256,
        row.bytes,
        row.status,
        this.now(),
      );
  }
  source(id: string): SourceRow | undefined {
    const row = this.sql.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    return row ? source(row) : undefined;
  }
  sources(notebookId: string): SourceRow[] {
    return this.sql
      .prepare("SELECT * FROM sources WHERE notebook_id = ? ORDER BY created_at, id")
      .all(notebookId)
      .map(source);
  }
  sourceBySha(notebookId: string, sha256: string): SourceRow | undefined {
    const row = this.sql
      .prepare("SELECT * FROM sources WHERE notebook_id = ? AND sha256 = ?")
      .get(notebookId, sha256);
    return row ? source(row) : undefined;
  }
  setSourceStatus(id: string, status: SourceStatus, error: string | null = null) {
    this.sql
      .prepare("UPDATE sources SET status = ?, error = ? WHERE id = ?")
      .run(status, error, id);
  }
  deleteSource(id: string) {
    this.sql.transaction(() => {
      this.sql.prepare("DELETE FROM chunks WHERE source_id = ?").run(id);
      this.sql.prepare("DELETE FROM sources WHERE id = ?").run(id);
    });
  }

  // Chunks (one transaction per source, D10)
  replaceChunks(sourceId: string, chunks: Chunk[]) {
    this.sql.transaction(() => {
      this.sql.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
      const insert = this.sql.prepare(
        "INSERT INTO chunks (source_id, ordinal, text, page, char_start, char_end) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const c of chunks)
        insert.run(sourceId, c.ordinal, c.text, c.page, c.charStart, c.charEnd);
      this.sql
        .prepare("UPDATE sources SET chunk_count = ? WHERE id = ?")
        .run(chunks.length, sourceId);
    });
  }
  clearChunks(sourceId: string) {
    this.replaceChunks(sourceId, []);
  }
  chunks(sourceId: string): ChunkRow[] {
    return this.sql
      .prepare("SELECT * FROM chunks WHERE source_id = ? ORDER BY ordinal")
      .all(sourceId)
      .map(chunk);
  }
  chunk(sourceId: string, ordinal: number): ChunkRow | undefined {
    const row = this.sql
      .prepare("SELECT * FROM chunks WHERE source_id = ? AND ordinal = ?")
      .get(sourceId, ordinal);
    return row ? chunk(row) : undefined;
  }
  notebookChunkCount(notebookId: string): number {
    return Number(
      this.sql
        .prepare(
          "SELECT COUNT(*) AS n FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.notebook_id = ?",
        )
        .get(notebookId)?.n ?? 0,
    );
  }
  /** BM25 ranking over the notebook's chunks, as `<sourceId>:<ordinal>` keys. */
  keywordSearch(notebookId: string, match: string, limit: number, sourceIds?: string[]): string[] {
    if (!match) return [];
    const scope = sourceIds?.length
      ? ` AND c.source_id IN (${sourceIds.map(() => "?").join(", ")})`
      : "";
    try {
      return this.sql
        .prepare(
          `SELECT c.source_id, c.ordinal FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
           JOIN sources s ON s.id = c.source_id
           WHERE chunks_fts MATCH ? AND s.notebook_id = ?${scope}
           ORDER BY bm25(chunks_fts), c.id LIMIT ?`,
        )
        .all(match, notebookId, ...(sourceIds ?? []), limit)
        .map((r) => `${r.source_id}:${Number(r.ordinal)}`);
    } catch {
      return [];
    }
  }

  // Messages
  addMessage(
    notebookId: string,
    role: "user" | "assistant",
    text: string,
    meta: Record<string, unknown> = {},
  ) {
    const result = this.sql
      .prepare(
        "INSERT INTO messages (notebook_id, role, text, citations_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(notebookId, role, text, JSON.stringify(meta), this.now());
    return Number(result.lastInsertRowid);
  }
  messages(notebookId: string, limit: number, before?: number): MessageRow[] {
    const rows = this.sql
      .prepare(
        `SELECT * FROM messages WHERE notebook_id = ?${before ? " AND id < ?" : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(before ? [notebookId, before, limit] : [notebookId, limit]));
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      notebookId: r.notebook_id,
      role: r.role,
      text: r.text,
      meta: parse(r.citations_json) ?? {},
      createdAt: Number(r.created_at),
    }));
  }
  clearMessages(notebookId: string) {
    this.sql.prepare("DELETE FROM messages WHERE notebook_id = ?").run(notebookId);
  }

  // Jobs
  insertJob(id: string, notebookId: string, kind: string, sourceId: string | null) {
    const at = this.now();
    this.sql
      .prepare(
        "INSERT INTO jobs (id, notebook_id, kind, state, source_id, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
      )
      .run(id, notebookId, kind, sourceId, at, at);
  }
  updateJob(
    id: string,
    patch: { state?: JobState; progress?: number; error?: string | null; result?: unknown },
  ) {
    const current = this.job(id);
    if (!current) return;
    this.sql
      .prepare(
        "UPDATE jobs SET state = ?, progress = ?, error = ?, result_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.state ?? current.state,
        patch.progress ?? current.progress,
        patch.error === undefined ? current.error : patch.error,
        JSON.stringify(patch.result === undefined ? current.result : patch.result),
        this.now(),
        id,
      );
  }
  job(id: string): JobRow | undefined {
    const row = this.sql.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? job(row) : undefined;
  }
  activeJobs(notebookId: string): JobRow[] {
    return this.sql
      .prepare(
        "SELECT * FROM jobs WHERE notebook_id = ? AND state IN ('queued', 'running') ORDER BY created_at",
      )
      .all(notebookId)
      .map(job);
  }
}
