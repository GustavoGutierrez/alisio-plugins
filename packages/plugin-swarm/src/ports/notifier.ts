import type { AttentionItem } from "../domain/attention.js";

export type ActivityKind = "handoff" | "merge" | "gate" | "bounce" | "approval";

export type SwarmEvent =
  | {
      type: "activity";
      project: string;
      at: string;
      kind: ActivityKind;
      role: string;
      task: string;
      message: string;
    }
  | { type: "attention"; item: AttentionItem }
  | { type: "task-done"; project: string; task: string }
  | { type: "error"; project: string; message: string };

/** Fire-and-forget notification sink (dashboard chime, status line). Must never throw into callers. */
export interface Notifier {
  notify(event: SwarmEvent): void;
}

export const silentNotifier: Notifier = { notify: () => undefined };
