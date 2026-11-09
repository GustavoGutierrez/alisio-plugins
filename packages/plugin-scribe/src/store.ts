import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Document, identifier, type Job, ScribeError } from "./types.js";

export interface DocumentSummary {
  id: string;
  title: string;
  discipline: string;
  language: Document["language"];
  archived: boolean;
  updatedAt: string;
  assets: number;
  proposals: number;
  hasPdf: boolean;
}

/** Called with the file name (never the full path) of a stored document that cannot be read. */
export type CorruptHandler = (file: string, error: unknown) => void;

const reportCorrupt: CorruptHandler = (file, error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `Skipping unreadable Scribe document ${file}: ${reason}`,
    "ScribeStoreWarning",
  );
};

function isDocument(value: unknown): value is Document {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<Document>;
  return (
    typeof d.id === "string" &&
    typeof d.title === "string" &&
    typeof d.updatedAt === "string" &&
    Array.isArray(d.revisions) &&
    Array.isArray(d.assets) &&
    Array.isArray(d.proposals)
  );
}

export class Store {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly root: string,
    private readonly onCorrupt: CorruptHandler = reportCorrupt,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  /** Write `data` to `name` inside the store through a temporary file and an atomic rename. */
  async atomicWrite(name: string, data: string | Uint8Array) {
    await this.init();
    const temp = join(this.root, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, join(this.root, name));
    } finally {
      await rm(temp, { force: true });
    }
  }
  async get(id: string): Promise<Document> {
    identifier(id);
    try {
      return JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")) as Document;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new ScribeError("not_found", undefined, 404);
      throw e;
    }
  }
  async put(document: Document) {
    identifier(document.id);
    document.updatedAt = new Date().toISOString();
    await this.atomicWrite(`${document.id}.json`, JSON.stringify(document));
  }
  /** Summaries of every readable document. Unreadable files are reported and skipped. */
  async list(): Promise<DocumentSummary[]> {
    await this.init();
    const names = (await readdir(this.root)).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n));
    const docs: Document[] = [];
    for (const name of names) {
      try {
        const value: unknown = await this.get(name.slice(0, -5));
        if (!isDocument(value)) throw new Error("invalid document shape");
        docs.push(value);
      } catch (error) {
        // A document deleted between readdir and read is not corruption.
        if (error instanceof ScribeError && error.code === "not_found") continue;
        this.onCorrupt(name, error);
      }
    }
    return docs
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((d) => ({
        id: d.id,
        title: d.title,
        discipline: d.discipline,
        language: d.language,
        archived: d.archived,
        updatedAt: d.updatedAt,
        assets: d.assets.length,
        proposals: d.proposals.length,
        hasPdf: Boolean(d.pdf),
      }));
  }
  async saveJob(job: Job) {
    identifier(job.id);
    await this.atomicWrite(`job-${job.id}.json`, JSON.stringify(job));
  }
  async jobs(): Promise<Job[]> {
    await this.init();
    const names = (await readdir(this.root)).filter((n) => /^job-[a-f0-9-]{36}\.json$/.test(n));
    return Promise.all(
      names.map(async (n) => JSON.parse(await readFile(join(this.root, n), "utf8")) as Job),
    );
  }
  async recover() {
    for (const job of await this.jobs())
      if (job.status === "running") {
        job.status = "interrupted";
        job.message = "interrupted";
        await this.saveJob(job);
      }
  }
}
