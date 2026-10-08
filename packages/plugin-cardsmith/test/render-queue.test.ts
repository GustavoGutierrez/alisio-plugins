import { describe, expect, it } from "vitest";
import { RenderQueue } from "../src/renderers/queue.js";
import { captureAsyncError } from "./helpers.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("RenderQueue", () => {
  it("runs at most maxConcurrency tasks and starts them in FIFO order", async () => {
    const queue = new RenderQueue(2, 8);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    let running = 0;
    let peak = 0;

    const ids = ["a", "b", "c", "d"];
    const tasks = ids.map((id) =>
      queue.run(async () => {
        started.push(id);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.set(id, resolve));
        running -= 1;
        return id;
      }),
    );

    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(2);

    gates.get("a")?.();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(1);

    gates.get("b")?.();
    await tick();
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(peak).toBe(2);

    gates.get("c")?.();
    gates.get("d")?.();
    await expect(Promise.all(tasks)).resolves.toEqual(["a", "b", "c", "d"]);
    expect(queue.active()).toBe(0);
    expect(queue.pending()).toBe(0);
  });

  it("rejects immediately with LIMIT_EXCEEDED when pending plus active reaches capacity", async () => {
    const queue = new RenderQueue(1, 2);
    const gate = deferred();
    const first = queue.run(async () => {
      await gate.promise;
      return "first";
    });
    const second = queue.run(async () => "second");
    expect(queue.active()).toBe(1);
    expect(queue.pending()).toBe(1);

    const error = await captureAsyncError(() => queue.run(async () => "third"));
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(error.details?.reason).toBe("queue_full");
    expect(error.details?.capacity).toBe(2);

    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("rejects a task aborted while it is queued with the signal reason and never starts it", async () => {
    const queue = new RenderQueue(1, 4);
    const gate = deferred();
    const running = queue.run(async () => {
      await gate.promise;
      return "running";
    });
    const controller = new AbortController();
    const reason = new Error("cancelled while queued");
    let startedQueued = false;
    const queued = queue.run(async () => {
      startedQueued = true;
      return "queued";
    }, controller.signal);

    await tick();
    expect(queue.pending()).toBe(1);
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    expect(startedQueued).toBe(false);
    expect(queue.pending()).toBe(0);

    gate.resolve();
    await expect(running).resolves.toBe("running");
  });

  it("forwards the abort reason to a running task and settles with its outcome", async () => {
    const queue = new RenderQueue(1, 4);
    const controller = new AbortController();
    const reason = new Error("stop");
    let observed: unknown;
    const task = queue.run(async (signal) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observed = signal.reason;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return "never";
    }, controller.signal);

    await tick();
    expect(queue.active()).toBe(1);
    controller.abort(reason);
    await expect(task).rejects.toBe(reason);
    expect(observed).toBe(reason);
    expect(queue.active()).toBe(0);
  });

  it("rejects an already-aborted signal without starting the task", async () => {
    const queue = new RenderQueue(1, 4);
    const controller = new AbortController();
    const reason = new Error("already aborted");
    controller.abort(reason);
    let started = false;
    const task = queue.run(async () => {
      started = true;
      return "no";
    }, controller.signal);
    await expect(task).rejects.toBe(reason);
    expect(started).toBe(false);
    expect(queue.pending()).toBe(0);
    expect(queue.active()).toBe(0);
  });

  it("falls back to an AbortError when a rejected signal has no reason", async () => {
    const queue = new RenderQueue(1, 4);
    const fakeSignal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(queue.run(async () => "no", fakeSignal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects default aborts with an AbortError", async () => {
    const queue = new RenderQueue(1, 4);
    const controller = new AbortController();
    controller.abort();
    await expect(
      queue.run(async () => {
        throw new Error("must not run");
      }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
