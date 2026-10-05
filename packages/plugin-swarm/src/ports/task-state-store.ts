import type { TaskState } from "../domain/taskstate.js";

/** Durable per-task coordinator state: holds, approval comments, bounces and the base commit. */
export interface TaskStateStore {
  get(taskId: string): Promise<TaskState | undefined>;
  /** Read-modify-write under a single writer; creates the state when it does not exist. */
  update(taskId: string, task: string, change: (state: TaskState) => void): Promise<TaskState>;
  list(): Promise<TaskState[]>;
  remove(taskId: string): Promise<void>;
}
