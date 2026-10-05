import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateTaskId } from "../domain/identifiers.js";
import { emptyTaskState, type TaskState, validateTaskState } from "../domain/taskstate.js";
import type { TaskStateStore } from "../ports/task-state-store.js";
import { atomicWrite, Mutex, readText } from "../storage.js";

/** `<project>/.alisio/swarm/state/<taskId>.json`: schema-versioned, atomic, one writer at a time. */
export class FsTaskStateStore implements TaskStateStore {
  private readonly root: string;
  private readonly mutex = new Mutex();

  constructor(projectRoot: string) {
    this.root = join(projectRoot, ".alisio", "swarm", "state");
  }

  private file(taskId: string): string {
    return join(this.root, `${validateTaskId(taskId)}.json`);
  }

  private async read(taskId: string): Promise<TaskState | undefined> {
    const raw = await readText(this.file(taskId));
    if (raw === undefined) return undefined;
    try {
      return validateTaskState(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Task state is corrupt (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  get(taskId: string): Promise<TaskState | undefined> {
    return this.read(taskId);
  }

  update(taskId: string, task: string, change: (state: TaskState) => void): Promise<TaskState> {
    return this.mutex.run(async () => {
      const state = (await this.read(taskId)) ?? emptyTaskState(taskId, task);
      change(state);
      const valid = validateTaskState(state);
      await atomicWrite(this.file(taskId), `${JSON.stringify(valid, null, 2)}\n`);
      return valid;
    });
  }

  /** Valid states only: a corrupt file is skipped here and reported by `get`. */
  async list(): Promise<TaskState[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.root)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const out: TaskState[] = [];
    for (const name of names) {
      try {
        const state = await this.read(name.slice(0, -".json".length));
        if (state) out.push(state);
      } catch {
        // A corrupt file must not hide the others.
      }
    }
    return out;
  }

  remove(taskId: string): Promise<void> {
    return this.mutex.run(() => rm(this.file(taskId), { force: true }));
  }
}
