export type RuntimeRead =
  | { state: "absent" }
  | { state: "invalid"; message: string }
  | { state: "ok"; value: unknown };

/** Layer 1: `.alisio/frontsmith/models.runtime.json`, workspace-local and not versioned. */
export interface ModelsRuntimeStore {
  read(root: string): Promise<RuntimeRead>;
  write(
    root: string,
    value: { tiers: Record<string, string>; agents: Record<string, string> },
  ): Promise<void>;
  /** Delete the file; `true` when it existed. */
  remove(root: string): Promise<boolean>;
}
