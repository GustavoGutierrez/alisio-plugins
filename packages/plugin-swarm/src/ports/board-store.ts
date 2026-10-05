import type { Board } from "../domain/task.js";

export interface BoardStore {
  /** `undefined` when no board was ever written. Throws when the file is corrupt. */
  read(): Promise<Board | undefined>;
  write(board: Board): Promise<void>;
}
