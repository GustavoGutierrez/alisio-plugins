import { join } from "node:path";
import { type Board, validateBoard } from "../domain/task.js";
import type { BoardStore } from "../ports/board-store.js";
import { atomicWrite, Mutex, readText } from "../storage.js";

/** `<project>/.alisio/swarm/board/tasks.json`: schema-versioned, atomic, one writer at a time. */
export class FsBoardStore implements BoardStore {
  private readonly file: string;
  private readonly mutex = new Mutex();

  constructor(projectRoot: string) {
    this.file = join(projectRoot, ".alisio", "swarm", "board", "tasks.json");
  }

  async read(): Promise<Board | undefined> {
    const raw = await readText(this.file);
    if (raw === undefined) return undefined;
    try {
      return validateBoard(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Board file is corrupt (${error instanceof Error ? error.message : String(error)}); rebuild it from the handoff files`,
      );
    }
  }

  async write(board: Board): Promise<void> {
    const valid = validateBoard(board);
    await this.mutex.run(() => atomicWrite(this.file, `${JSON.stringify(valid, null, 2)}\n`));
  }
}
