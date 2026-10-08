import { CardsmithError } from "../core/errors.js";
import { RENDER_CONCURRENCY, RENDER_QUEUE_CAPACITY } from "../core/limits.js";

interface QueueEntry {
  task: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  state: "queued" | "running" | "settled";
  detach: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason !== undefined ? reason : new DOMException("Aborted", "AbortError");
}

/**
 * Bounded FIFO render queue. At most `maxConcurrency` tasks run at once and tasks start in call
 * order. `capacity` counts running plus pending tasks: once `pending + active` reaches it, `run`
 * rejects immediately with `LIMIT_EXCEEDED` instead of growing an unbounded backlog.
 *
 * Cancellation: aborting while a task is queued removes it and rejects its promise with the
 * signal reason (or an `AbortError` when the reason is missing); aborting while it is running
 * forwards the same reason through an internal signal the task receives.
 */
export class RenderQueue {
  readonly #maxConcurrency: number;
  readonly #capacity: number;
  readonly #queue: QueueEntry[] = [];
  #active = 0;

  constructor(
    maxConcurrency: number = RENDER_CONCURRENCY,
    capacity: number = RENDER_QUEUE_CAPACITY,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new CardsmithError("INVALID_SPEC", "maxConcurrency must be a positive integer", {
        maxConcurrency,
      });
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new CardsmithError("INVALID_SPEC", "capacity must be a positive integer", { capacity });
    }
    this.#maxConcurrency = maxConcurrency;
    this.#capacity = capacity;
  }

  /** Tasks waiting for a slot. */
  pending(): number {
    return this.#queue.length;
  }

  /** Tasks currently running. */
  active(): number {
    return this.#active;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#queue.length + this.#active >= this.#capacity) {
      return Promise.reject(
        new CardsmithError("LIMIT_EXCEEDED", "Render queue is full", {
          reason: "queue_full",
          capacity: this.#capacity,
          pending: this.#queue.length,
          active: this.#active,
        }),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const entry: QueueEntry = {
        task,
        controller,
        resolve: (value) => resolve(value as T),
        reject,
        state: "queued",
        detach: () => {},
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (entry.state === "queued") {
            const index = this.#queue.indexOf(entry);
            if (index !== -1) this.#queue.splice(index, 1);
            entry.state = "settled";
            entry.detach();
            entry.reject(abortReason(signal));
          } else if (entry.state === "running") {
            entry.detach();
            if (!controller.signal.aborted) controller.abort(abortReason(signal));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.#queue.push(entry);
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (entry === undefined) break;
      if (entry.state !== "queued") continue;
      entry.state = "running";
      this.#active += 1;
      void this.#execute(entry);
    }
  }

  async #execute(entry: QueueEntry): Promise<void> {
    try {
      const value = await entry.task(entry.controller.signal);
      entry.state = "settled";
      entry.detach();
      entry.resolve(value);
    } catch (error) {
      entry.state = "settled";
      entry.detach();
      entry.reject(error);
    } finally {
      this.#active -= 1;
      this.#pump();
    }
  }
}
