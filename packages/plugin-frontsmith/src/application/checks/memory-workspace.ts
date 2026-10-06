import type { FileListing, ReadResult, WorkspaceFs } from "../ports/workspace-fs.js";

/** An in-memory workspace: rule fixtures and tests run against it without touching the disk. */
export class MemoryWorkspace implements WorkspaceFs {
  readonly root = "/w/app";
  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly maxBytes = 1024 * 1024,
  ) {}

  async listFiles(options: { roots?: readonly string[] } = {}): Promise<FileListing> {
    const roots = options.roots ?? [];
    const files = Object.keys(this.files)
      .filter(
        (path) =>
          roots.length === 0 || roots.some((root) => path === root || path.startsWith(`${root}/`)),
      )
      .sort();
    return { files, truncated: false };
  }

  async read(path: string): Promise<ReadResult> {
    const text = this.files[path];
    if (text === undefined) return { kind: "missing" };
    const size = new TextEncoder().encode(text).length;
    return size > this.maxBytes ? { kind: "too-large", size } : { kind: "text", text, size };
  }

  async exists(path: string): Promise<boolean> {
    return this.files[path] !== undefined;
  }
}
