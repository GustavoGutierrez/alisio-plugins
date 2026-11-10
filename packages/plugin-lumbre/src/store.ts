// Durable per-project storage (decision D). Each project is a folder of its own:
//   projects/<id>/meta.json             title, stack, model, head, revision list, extra packages
//   projects/<id>/revisions/<rev>.json  { path: sha256 } manifest of one revision
//   projects/<id>/blobs/<sha256>        file contents, content-addressed and shared by revisions
//   projects/<id>/<kind>.json           chat, proposal, snapshot, lock (one file per concern)
// Activation reads every meta.json once and rewrites nothing; a corrupt project is reported as
// damaged and never breaks the others. Every write goes to a temp file and is renamed into place.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LumbreError } from "./errors.js";
import { isStackId, type StackId } from "./presets.js";
import { type Files, validateFileSet } from "./safety.js";

export const MAX_REVISIONS = 40;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

export type RevisionKind = "initial" | "proposal" | "fix" | "manual" | "restore";
export interface RevisionInfo {
  id: string;
  at: number;
  summary: string;
  kind: RevisionKind;
}
export interface ProjectMeta {
  version: 1;
  id: string;
  title: string;
  stack: StackId;
  tailwind: boolean;
  model: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  head: string;
  revisions: RevisionInfo[];
  /** Approved extra packages (exact versions from the stack allowlist). */
  extras: Record<string, string>;
}
export type JsonKind = "chat" | "proposal" | "snapshot" | "lock" | "installed" | "work-manifest";

export const isId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const sha = (content: string) => createHash("sha256").update(content).digest("hex");

/** Writes through a temp file in the same folder and renames it into place (mode 0600). */
export async function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function parseMeta(raw: string, id: string): ProjectMeta {
  const m = JSON.parse(raw) as Partial<ProjectMeta>;
  const valid =
    m &&
    m.version === 1 &&
    m.id === id &&
    typeof m.title === "string" &&
    isStackId(m.stack) &&
    typeof m.tailwind === "boolean" &&
    (m.model === null || typeof m.model === "string") &&
    typeof m.archived === "boolean" &&
    isId(m.head) &&
    Array.isArray(m.revisions) &&
    m.revisions.every((r) => isId(r?.id) && typeof r.summary === "string") &&
    m.revisions.some((r) => r.id === m.head) &&
    m.extras !== null &&
    typeof m.extras === "object";
  if (!valid) throw new LumbreError("damaged_project");
  return m as ProjectMeta;
}

export class ProjectStore {
  private metas = new Map<string, ProjectMeta>();
  private damagedIds = new Set<string>();
  constructor(readonly root: string) {}

  dir(id: string) {
    if (!isId(id)) throw new LumbreError("invalid_input");
    return join(this.root, "projects", id);
  }

  /** Reads every project's metadata once; nothing is written. */
  async load() {
    await mkdir(join(this.root, "projects"), { recursive: true, mode: 0o700 });
    for (const entry of await readdir(join(this.root, "projects"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !isId(entry.name)) continue;
      try {
        const raw = await readFile(join(this.dir(entry.name), "meta.json"), "utf8");
        this.metas.set(entry.name, parseMeta(raw, entry.name));
      } catch {
        this.damagedIds.add(entry.name);
      }
    }
    return { projects: this.list(), damaged: this.damaged() };
  }

  list() {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  damaged() {
    return [...this.damagedIds];
  }
  get(id: string) {
    return this.metas.get(id);
  }
  require(id: unknown): ProjectMeta {
    if (!isId(id)) throw new LumbreError("invalid_input");
    if (this.damagedIds.has(id)) throw new LumbreError("damaged_project");
    const m = this.metas.get(id);
    if (!m) throw new LumbreError("not_found");
    return m;
  }

  private async saveMeta(m: ProjectMeta) {
    await writeAtomic(join(this.dir(m.id), "meta.json"), JSON.stringify(m));
    this.metas.set(m.id, m);
  }

  private async writeRevision(id: string, files: Files) {
    const checked = validateFileSet(files);
    const dir = this.dir(id);
    await mkdir(join(dir, "blobs"), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, "revisions"), { recursive: true, mode: 0o700 });
    const manifest: Record<string, string> = {};
    const existing = new Set(await readdir(join(dir, "blobs")));
    for (const [path, content] of Object.entries(checked)) {
      const hash = sha(content);
      manifest[path] = hash;
      if (!existing.has(hash)) await writeAtomic(join(dir, "blobs", hash), content);
      existing.add(hash);
    }
    const rev = randomUUID();
    await writeAtomic(join(dir, "revisions", `${rev}.json`), JSON.stringify(manifest));
    return rev;
  }

  async create(
    info: { title: string; stack: StackId; tailwind: boolean; model: string | null },
    files: Files,
  ): Promise<ProjectMeta> {
    const id = randomUUID();
    await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
    try {
      const rev = await this.writeRevision(id, files);
      const at = Date.now();
      const m: ProjectMeta = {
        version: 1,
        id,
        ...info,
        archived: false,
        createdAt: at,
        updatedAt: at,
        head: rev,
        revisions: [{ id: rev, at, summary: "Starter project", kind: "initial" }],
        extras: {},
      };
      await this.saveMeta(m);
      return m;
    } catch (error) {
      await rm(this.dir(id), { recursive: true, force: true });
      throw error;
    }
  }

  /** The file contents of one revision, each blob verified against its address. */
  async files(id: string, revision: string): Promise<Files> {
    const m = this.require(id);
    if (!m.revisions.some((r) => r.id === revision)) throw new LumbreError("not_found");
    const dir = this.dir(id);
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, "revisions", `${revision}.json`), "utf8"),
      ) as Record<string, string>;
      const files: Files = {};
      for (const [path, hash] of Object.entries(manifest)) {
        if (!SHA.test(hash)) throw new LumbreError("damaged_project");
        const content = await readFile(join(dir, "blobs", hash), "utf8");
        if (sha(content) !== hash) throw new LumbreError("damaged_project");
        files[path] = content;
      }
      return validateFileSet(files);
    } catch {
      throw new LumbreError("damaged_project");
    }
  }

  async commit(
    id: string,
    files: Files,
    info: { summary: string; kind: RevisionKind },
  ): Promise<RevisionInfo> {
    const m = this.require(id);
    const rev = await this.writeRevision(id, files);
    const entry: RevisionInfo = {
      id: rev,
      at: Date.now(),
      summary: info.summary.slice(0, 300),
      kind: info.kind,
    };
    const revisions = [...m.revisions, entry];
    const dropped = revisions.splice(0, Math.max(0, revisions.length - MAX_REVISIONS));
    await this.saveMeta({ ...m, head: rev, revisions, updatedAt: entry.at });
    if (dropped.length) await this.prune(id, dropped);
    return entry;
  }

  /** Removes dropped revision manifests and every blob no remaining revision references. */
  private async prune(id: string, dropped: RevisionInfo[]) {
    const dir = this.dir(id);
    for (const r of dropped) await rm(join(dir, "revisions", `${r.id}.json`), { force: true });
    const keep = new Set<string>();
    for (const r of this.require(id).revisions) {
      try {
        const manifest = JSON.parse(
          await readFile(join(dir, "revisions", `${r.id}.json`), "utf8"),
        ) as Record<string, string>;
        for (const hash of Object.values(manifest)) keep.add(hash);
      } catch {
        return; // Never delete blobs when a manifest cannot be read.
      }
    }
    for (const blob of await readdir(join(dir, "blobs")))
      if (SHA.test(blob) && !keep.has(blob)) await unlink(join(dir, "blobs", blob)).catch(() => {});
  }

  async update(
    id: string,
    patch: Partial<Pick<ProjectMeta, "title" | "model" | "archived" | "extras">>,
  ): Promise<ProjectMeta> {
    const m = this.require(id);
    const next = { ...m, ...patch, updatedAt: Date.now() };
    await this.saveMeta(next);
    return next;
  }

  async remove(id: string) {
    if (!isId(id)) throw new LumbreError("invalid_input");
    if (!this.metas.has(id) && !this.damagedIds.has(id)) throw new LumbreError("not_found");
    await rm(this.dir(id), { recursive: true, force: true });
    this.metas.delete(id);
    this.damagedIds.delete(id);
  }

  async readJson<T>(id: string, kind: JsonKind, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), `${kind}.json`), "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  async writeJson(id: string, kind: JsonKind, value: unknown) {
    await writeAtomic(join(this.dir(id), `${kind}.json`), JSON.stringify(value));
  }
  async deleteJson(id: string, kind: JsonKind) {
    await rm(join(this.dir(id), `${kind}.json`), { force: true });
  }
}
