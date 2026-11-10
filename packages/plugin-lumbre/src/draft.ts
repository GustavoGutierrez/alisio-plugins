// The per-job draft of agent mode (0.2.0): the agent's tools read and change this overlay of the
// base revision; the project itself changes only when the person applies the reviewed proposal.
// Every change is validated with the same rules as model output (paths, managed files, the
// package allowlist, size limits).
import { LumbreError } from "./errors.js";
import type { RawOutput } from "./output.js";
import { allowedDependency, type Stack } from "./presets.js";
import { type Files, filePath, isManagedPath, LIMITS, validateFileSet } from "./safety.js";

export type TimelineKind =
  | "thinking"
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "dependency"
  | "progress"
  | "check"
  | "fix"
  | "done"
  | "error";
export interface TimelineEntry {
  at: number;
  kind: TimelineKind;
  path?: string;
  text?: string;
}
export interface DraftState {
  base: string;
  /** path -> new content, or null when deleted. */
  changes: Record<string, string | null>;
  deps: Record<string, string>;
  done: { summary: string; message: string } | null;
  timeline: TimelineEntry[];
  counts: { read: number; write: number; edit: number; delete: number; tools: number };
}
export type ToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const MAX_TIMELINE = 300;
const MAX_READ = 60_000;
const fail = (error: string): ToolResult => ({ ok: false, error });

export class Draft {
  readonly state: DraftState;
  constructor(
    readonly stack: Stack,
    readonly owned: string[],
    readonly baseFiles: Files,
    base: string,
    state?: DraftState,
    /** The project's approved extras (features widen the allowlist). */
    readonly extras: Record<string, string> = {},
  ) {
    this.state = state ?? {
      base,
      changes: {},
      deps: {},
      done: null,
      timeline: [],
      counts: { read: 0, write: 0, edit: 0, delete: 0, tools: 0 },
    };
  }

  /** The draft's current files (base with every change applied). */
  files(): Files {
    const out: Files = { ...this.baseFiles };
    for (const [path, content] of Object.entries(this.state.changes))
      if (content === null) delete out[path];
      else out[path] = content;
    return out;
  }

  note(kind: TimelineKind, extra: { path?: string; text?: string } = {}) {
    this.state.timeline.push({ at: Date.now(), kind, ...extra });
    if (this.state.timeline.length > MAX_TIMELINE)
      this.state.timeline.splice(0, this.state.timeline.length - MAX_TIMELINE);
  }

  private managed(path: string) {
    return (
      this.owned.some((o) => o.toLowerCase() === path.toLowerCase()) ||
      isManagedPath(path, this.stack.generated)
    );
  }

  /** Validates a path for a change; returns an error code or undefined. */
  private check(path: unknown): string | undefined {
    try {
      filePath(path);
    } catch {
      return "invalid_path";
    }
    if (this.managed(path as string)) return "managed_file";
    return undefined;
  }

  /** Applies a change only if the resulting file set is still valid. */
  private commit(path: string, content: string | null): string | undefined {
    const previous = Object.hasOwn(this.state.changes, path) ? this.state.changes[path] : undefined;
    const had = Object.hasOwn(this.state.changes, path);
    this.state.changes[path] = content;
    if (content !== null && Object.hasOwn(this.baseFiles, path) && this.baseFiles[path] === content)
      delete this.state.changes[path];
    try {
      validateFileSet(this.files());
      return undefined;
    } catch (error) {
      if (had) this.state.changes[path] = previous as string | null;
      else delete this.state.changes[path];
      return error instanceof LumbreError ? error.code : "invalid_input";
    }
  }

  list() {
    const files = this.files();
    const rows = [
      ...Object.keys(files).map((path) => ({
        path,
        size: Buffer.byteLength(files[path] ?? ""),
        owned: false,
        changed: Object.hasOwn(this.state.changes, path),
      })),
      ...this.owned.map((path) => ({ path, size: 0, owned: true, changed: false })),
    ];
    return rows.sort((a, b) => a.path.localeCompare(b.path));
  }

  read(path: unknown, offset = 0, limit = MAX_READ): ToolResult {
    if (typeof path !== "string") return fail("invalid_path");
    const files = this.files();
    if (!Object.hasOwn(files, path)) return fail("not_found");
    const content = files[path] as string;
    const start = Math.max(0, Math.floor(offset) || 0);
    const size = Math.min(MAX_READ, Math.max(1, Math.floor(limit) || MAX_READ));
    const slice = content.slice(start, start + size);
    this.state.counts.read++;
    this.note("read", { path });
    return {
      ok: true,
      path,
      content: slice,
      offset: start,
      total: content.length,
      truncated: start + slice.length < content.length,
    };
  }

  write(path: unknown, content: unknown): ToolResult {
    const bad = this.check(path);
    if (bad) return fail(bad);
    if (typeof content !== "string") return fail("invalid_input");
    if (Buffer.byteLength(content) > LIMITS.fileBytes) return fail("too_large");
    const created = !Object.hasOwn(this.files(), path as string);
    const error = this.commit(path as string, content);
    if (error) return fail(error);
    this.state.counts.write++;
    this.note("write", { path: path as string });
    return { ok: true, path, created, bytes: Buffer.byteLength(content) };
  }

  edit(path: unknown, find: unknown, replace: unknown): ToolResult {
    const bad = this.check(path);
    if (bad) return fail(bad);
    if (typeof find !== "string" || !find || typeof replace !== "string")
      return fail("invalid_input");
    const current = this.files()[path as string];
    if (current === undefined) return fail("not_found");
    const at = current.indexOf(find);
    if (at === -1) return fail("not_found");
    if (current.indexOf(find, at + 1) !== -1) return fail("not_unique");
    const next = current.slice(0, at) + replace + current.slice(at + find.length);
    if (Buffer.byteLength(next) > LIMITS.fileBytes) return fail("too_large");
    const error = this.commit(path as string, next);
    if (error) return fail(error);
    this.state.counts.edit++;
    this.note("edit", { path: path as string });
    return { ok: true, path };
  }

  remove(path: unknown): ToolResult {
    const bad = this.check(path);
    if (bad) return fail(bad);
    if (!Object.hasOwn(this.files(), path as string)) return fail("not_found");
    if (Object.hasOwn(this.baseFiles, path as string)) this.state.changes[path as string] = null;
    else delete this.state.changes[path as string];
    this.state.counts.delete++;
    this.note("delete", { path: path as string });
    return { ok: true, path };
  }

  addDependency(name: unknown, version: unknown): ToolResult {
    if (!allowedDependency(this.stack, name, version, { ...this.extras, ...this.state.deps }))
      return fail("not_allowed");
    this.state.deps[name as string] = version as string;
    this.note("dependency", { text: `${name}@${version}` });
    return { ok: true, name, version };
  }

  progress(message: unknown): ToolResult {
    if (typeof message !== "string" || !message.trim()) return fail("invalid_input");
    this.note("progress", { text: message.trim().slice(0, 200) });
    return { ok: true };
  }

  finish(summary: unknown, message: unknown): ToolResult {
    this.state.done = {
      summary: typeof summary === "string" ? summary.slice(0, 300) : "",
      message: typeof message === "string" ? message.slice(0, 20_000) : "",
    };
    this.note("done", { text: this.state.done.summary });
    return { ok: true };
  }

  /** The draft as model output, for the same validation and review as 0.1.x answers. */
  toRaw(): RawOutput {
    const files: RawOutput["files"] = [];
    const deletes: string[] = [];
    for (const [path, content] of Object.entries(this.state.changes))
      if (content === null) deletes.push(path);
      else files.push({ path, content });
    return {
      format: "blocks",
      message: this.state.done?.message ?? "",
      summary: this.state.done?.summary ?? "",
      files,
      deletes,
      dependencies: Object.entries(this.state.deps).map(([name, version]) => ({ name, version })),
      plan: null,
      design: null,
      done: !!this.state.done,
      cut: null,
      truncated: false,
    };
  }
}
