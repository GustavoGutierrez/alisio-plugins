/**
 * Injectable time seams. Tests pass a fixed clock and a recording sleep so no
 * test ever waits on a wall clock or reaches the network.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Sleep that rejects immediately when the supplied signal aborts. */
export const systemSleep: Sleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
