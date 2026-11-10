import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CollectionInfo,
  SemanticHealth,
  SemanticMetadata,
  VectorMatch,
  VectorRecord,
  VectorStoreProvider,
} from "@alisio/sdk";
import { SemanticPluginError } from "../errors.js";

type Lance = typeof import("@lancedb/lancedb");
type Connection = Awaited<ReturnType<Lance["connect"]>>;
type Table = Awaited<ReturnType<Connection["openTable"]>>;

interface SidecarEntry {
  table: string;
  modelId: string;
  dimensions: number;
  indexed?: boolean;
}
interface Sidecar {
  version: 1;
  collections: Record<string, SidecarEntry>;
}

export interface LanceStoreOptions {
  /** Database directory (`<state>/lance`). */
  dir: string;
  /** Row count from which an IVF-PQ index is built once (flat search is exact below it). */
  indexThreshold?: number;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Host rule for record ids (spec 029 D9). The charset excludes quotes, so a validated id list is a
// safe SQL literal for `delete`.
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME_MAX = 200;
const DELETE_BATCH = 500;
/**
 * Write queue per database directory. Process-wide on purpose: two activations of the plugin (two
 * open workspaces) share one `collections.json`. It holds no data, only pending writes.
 */
const QUEUES = new Map<string, Promise<unknown>>();

function invalid(): never {
  throw new SemanticPluginError("invalid_input");
}

function checkMetadata(metadata: SemanticMetadata | undefined) {
  if (metadata === undefined) return;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid();
  for (const [key, value] of Object.entries(metadata)) {
    if (!KEY.test(key)) invalid();
    const type = typeof value;
    if (type !== "string" && type !== "boolean" && !(type === "number" && Number.isFinite(value)))
      invalid();
  }
}

function checkName(name: string) {
  if (typeof name !== "string" || name.length === 0 || name.length > NAME_MAX) invalid();
}

/**
 * `VectorStoreProvider` on LanceDB (`semantic.lance`). Collection names arrive namespaced by the host
 * (`<plugin>/<collection>`), so each maps to a hashed table name recorded in `collections.json`
 * (written atomically). Tables use the cosine metric and `score = 1 - distance` (D8). Metadata is a
 * JSON column; equality filters are applied to decoded rows, so filter values never become SQL.
 */
export class LanceStore implements VectorStoreProvider {
  readonly id = "semantic.lance";
  readonly name = "LanceDB (local)";
  private readonly dir: string;
  private readonly indexThreshold: number;
  private connection: Promise<Connection> | undefined;

  constructor(options: LanceStoreOptions) {
    this.dir = options.dir;
    this.indexThreshold = options.indexThreshold ?? 50_000;
  }

  async ensureCollection(
    name: string,
    spec: { modelId: string; dimensions: number },
    signal: AbortSignal,
  ): Promise<CollectionInfo> {
    checkName(name);
    if (!Number.isInteger(spec.dimensions) || spec.dimensions < 1 || spec.dimensions > 4096)
      invalid();
    signal.throwIfAborted();
    return this.serial(async () => {
      const sidecar = await this.readSidecar();
      if (!sidecar.collections[name]) {
        sidecar.collections[name] = {
          table: `c_${createHash("sha256").update(name).digest("hex").slice(0, 32)}`,
          modelId: spec.modelId,
          dimensions: spec.dimensions,
        };
        await this.writeSidecar(sidecar);
      }
      return this.info(name, sidecar.collections[name] as SidecarEntry);
    });
  }

  async getCollection(name: string, signal: AbortSignal): Promise<CollectionInfo | null> {
    signal.throwIfAborted();
    const entry = (await this.readSidecar()).collections[name];
    return entry ? this.info(name, entry) : null;
  }

  async listCollections(prefix: string, signal: AbortSignal): Promise<CollectionInfo[]> {
    signal.throwIfAborted();
    const sidecar = await this.readSidecar();
    const names = Object.keys(sidecar.collections)
      .filter((name) => name.startsWith(prefix))
      .sort();
    return Promise.all(
      names.map((name) => this.info(name, sidecar.collections[name] as SidecarEntry)),
    );
  }

  async dropCollection(name: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.serial(async () => {
      const sidecar = await this.readSidecar();
      const entry = sidecar.collections[name];
      if (!entry) return;
      const db = await this.connect();
      if ((await db.tableNames()).includes(entry.table)) await db.dropTable(entry.table);
      delete sidecar.collections[name];
      await this.writeSidecar(sidecar);
    });
  }

  async upsert(name: string, records: VectorRecord[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.serial(async () => {
      const entry = await this.entry(name);
      for (const record of records) {
        if (!ID.test(record.id)) invalid();
        if (!(record.vector instanceof Float32Array) || record.vector.length !== entry.dimensions)
          invalid();
        for (const x of record.vector) if (!Number.isFinite(x)) invalid();
        if (record.text !== undefined && typeof record.text !== "string") invalid();
        checkMetadata(record.metadata);
      }
      if (records.length === 0) return;
      const rows = records.map((r) => ({
        id: r.id,
        vector: Array.from(r.vector),
        text: r.text ?? "",
        has_text: r.text !== undefined,
        metadata: JSON.stringify(r.metadata ?? {}),
      }));
      const db = await this.connect();
      const table = await this.table(entry);
      if (!table) await db.createTable(entry.table, rows);
      else
        await table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(rows);
      signal.throwIfAborted();
      if (!entry.indexed) {
        const current = (await this.table(entry)) as Table;
        if ((await current.countRows()) >= this.indexThreshold) {
          const { Index } = await import("@lancedb/lancedb");
          await current.createIndex("vector", {
            config: Index.ivfPq({ distanceType: "cosine" }),
          });
          const sidecar = await this.readSidecar();
          const stored = sidecar.collections[name];
          if (stored) {
            stored.indexed = true;
            await this.writeSidecar(sidecar);
          }
        }
      }
    });
  }

  async delete(name: string, ids: string[], signal: AbortSignal): Promise<void> {
    for (const id of ids) if (typeof id !== "string" || !ID.test(id)) invalid();
    signal.throwIfAborted();
    await this.serial(async () => {
      const table = await this.table(await this.entry(name));
      if (!table) return;
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const list = ids
          .slice(i, i + DELETE_BATCH)
          .map((id) => `'${id}'`)
          .join(", ");
        await table.delete(`id IN (${list})`);
      }
    });
  }

  async query(
    name: string,
    vector: Float32Array,
    options: { topK: number; filter?: SemanticMetadata; signal: AbortSignal },
  ): Promise<VectorMatch[]> {
    const filter = options.filter;
    if (filter) {
      checkMetadata(filter);
      if (Object.keys(filter).length > 16) invalid();
    }
    const topK = Math.max(1, Math.min(100, Math.floor(options.topK)));
    options.signal.throwIfAborted();
    const sidecar = await this.readSidecar();
    const entry = sidecar.collections[name];
    if (!entry) return [];
    const table = await this.table(entry);
    if (!table) return [];
    // A filter is applied after decoding metadata, so it searches every row (exact, flat).
    let search = table
      .vectorSearch(Array.from(vector))
      .distanceType("cosine")
      .select(["id", "text", "has_text", "metadata", "_distance"])
      .limit(filter ? Math.max(topK, await table.countRows()) : topK);
    if (filter) search = search.bypassVectorIndex();
    const rows = (await search.toArray()) as Array<{
      id: string;
      text: string;
      has_text: boolean;
      metadata: string;
      _distance: number;
    }>;
    options.signal.throwIfAborted();
    const matches: VectorMatch[] = [];
    for (const row of rows) {
      let metadata: SemanticMetadata = {};
      try {
        metadata = JSON.parse(row.metadata) as SemanticMetadata;
      } catch {
        metadata = {};
      }
      if (filter && !Object.entries(filter).every(([k, value]) => metadata[k] === value)) continue;
      const score = Math.max(-1, Math.min(1, 1 - Number(row._distance)));
      matches.push({
        id: row.id,
        score,
        ...(row.has_text ? { text: row.text } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async health(): Promise<SemanticHealth> {
    try {
      await (await this.connect()).tableNames();
      return { status: "ready" };
    } catch {
      this.connection = undefined;
      return { status: "unavailable", detail: "the vector database cannot be opened" };
    }
  }

  /** Writes are serialized per database directory, across every store instance in the process. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = QUEUES.get(this.dir) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => {});
    QUEUES.set(this.dir, tail);
    void tail.then(() => {
      if (QUEUES.get(this.dir) === tail) QUEUES.delete(this.dir);
    });
    return run;
  }

  private async entry(name: string) {
    const entry = (await this.readSidecar()).collections[name];
    if (!entry) throw new SemanticPluginError("not_found");
    return entry;
  }

  private async info(name: string, entry: SidecarEntry): Promise<CollectionInfo> {
    const table = await this.table(entry);
    return {
      name,
      modelId: entry.modelId,
      dimensions: entry.dimensions,
      count: table ? await table.countRows() : 0,
    };
  }

  private async table(entry: SidecarEntry): Promise<Table | undefined> {
    const db = await this.connect();
    if (!(await db.tableNames()).includes(entry.table)) return undefined;
    return db.openTable(entry.table);
  }

  private connect() {
    if (!this.connection) {
      this.connection = (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const lancedb = await import("@lancedb/lancedb");
        return lancedb.connect(this.dir);
      })();
      this.connection.catch(() => {
        this.connection = undefined;
      });
    }
    return this.connection;
  }

  /** Always read from disk: another activation (another open workspace) may have written it. */
  private readSidecar(): Promise<Sidecar> {
    return readFile(join(this.dir, "collections.json"), "utf8").then(
      (text) => {
        const parsed = JSON.parse(text) as Sidecar;
        return parsed?.version === 1 && parsed.collections
          ? parsed
          : { version: 1, collections: {} };
      },
      () => ({ version: 1, collections: {} }) as Sidecar,
    );
  }

  private async writeSidecar(sidecar: Sidecar) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, "collections.json");
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(sidecar), { mode: 0o600 });
    await rename(temp, target);
  }
}
