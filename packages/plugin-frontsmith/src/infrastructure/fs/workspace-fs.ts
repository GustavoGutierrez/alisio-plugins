import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Git } from "../../application/ports/git.js";
import {
  type FileListing,
  type ListOptions,
  MAX_ANALYSIS_BYTES,
  MAX_ANALYSIS_FILES,
  type ModuleResolver,
  type ReadResult,
  type WorkspaceFs,
} from "../../application/ports/workspace-fs.js";
import { resolveContained } from "./storage.js";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".alisio", "coverage"]);

export interface WorkspaceFsOptions {
  git?: Git;
  maxFiles?: number;
  maxBytes?: number;
}

const underRoots = (path: string, roots: readonly string[]): boolean =>
  roots.length === 0 ||
  roots.some(
    (root) => root === "." || path === root || path.startsWith(`${root.replace(/\/$/, "")}/`),
  );

export class NodeWorkspaceFs implements WorkspaceFs {
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(
    readonly root: string,
    private readonly options: WorkspaceFsOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? MAX_ANALYSIS_FILES;
    this.maxBytes = options.maxBytes ?? MAX_ANALYSIS_BYTES;
  }

  async listFiles(options: ListOptions = {}): Promise<FileListing> {
    const roots = options.roots ?? [];
    const git = this.options.git;
    let all: string[];
    if (git && (await git.isRepo(this.root))) {
      const tracked = (await git.listFiles(this.root)).filter(
        (path) =>
          underRoots(path, roots) && !path.split("/").some((part) => SKIPPED_DIRS.has(part)),
      );
      all = [];
      for (let index = 0; index < tracked.length; index += 64) {
        const batch = tracked.slice(index, index + 64);
        const present = await Promise.all(
          batch.map((path) =>
            lstat(join(this.root, path)).then(
              () => true,
              () => false,
            ),
          ),
        );
        batch.forEach((path, i) => {
          if (present[i]) all.push(path);
        });
      }
    } else all = await this.walk(roots);
    all.sort();
    const truncated = all.length > this.maxFiles;
    return { files: truncated ? all.slice(0, this.maxFiles) : all, truncated };
  }

  private async walk(roots: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    const start = roots.length === 0 ? [""] : [...roots];
    const visit = async (relative: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(join(this.root, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length > this.maxFiles) return;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await visit(child);
        } else if (entry.isFile()) out.push(child);
      }
    };
    for (const root of start)
      await visit(root.replace(/\/$/, "") === "." ? "" : root.replace(/\/$/, ""));
    return out;
  }

  async read(path: string): Promise<ReadResult> {
    const absolute = await resolveContained(this.root, path);
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    if (size > this.maxBytes) return { kind: "too-large", size };
    return { kind: "text", text: await readFile(absolute, "utf8"), size };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(await resolveContained(this.root, path));
      return true;
    } catch {
      return false;
    }
  }
}

/** `require.resolve` from the workspace: finds installed packages without executing them. */
export class NodeModuleResolver implements ModuleResolver {
  resolvable(workspaceRoot: string, name: string): boolean {
    const require = createRequire(join(workspaceRoot, "noop.js"));
    for (const request of [`${name}/package.json`, name]) {
      try {
        require.resolve(request);
        return true;
      } catch (error) {
        // `exports` maps may hide package.json; ERR_PACKAGE_PATH_NOT_EXPORTED still proves presence.
        if ((error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return true;
      }
    }
    return false;
  }
}
