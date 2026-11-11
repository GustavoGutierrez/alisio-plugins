/**
 * The `bekko` `DecisionProvider`. It never waits for the model: when it is not loaded the call
 * fails fast with `not_ready` / `unavailable` so the host uses its fallback without counting a
 * failure, and every error is mapped to a `DecisionProviderError` code.
 */
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionProviderResult,
  type DecisionRequest,
} from "@alisio/sdk";
import { BekkoRequestError, BekkoResponseError, decode, encode } from "./codec.js";
import type { BekkoRuntime } from "./runtime.js";

export const PROVIDER_ID = "bekko";

export function toProviderError(error: unknown): DecisionProviderError {
  if (error instanceof DecisionProviderError) return error;
  if (error instanceof BekkoResponseError) {
    return new DecisionProviderError("invalid_response", error.message);
  }
  if (error instanceof BekkoRequestError)
    return new DecisionProviderError("internal", error.message);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new DecisionProviderError("timeout", "decision deadline reached");
  }
  return new DecisionProviderError("internal", "unexpected Bekko failure");
}

export function createBekkoProvider(runtime: BekkoRuntime): DecisionProvider {
  return {
    id: PROVIDER_ID,
    name: "Bekko",
    capabilities: { select: true, boolean: true, ordinal: true },
    async health() {
      const { state, detail } = runtime.snapshot();
      if (state === "ready") return { status: "ready" };
      if (state === "loading" || state === "stopped") {
        return { status: "starting", ...(detail ? { detail } : {}) };
      }
      return { status: "unavailable", detail: detail || state };
    },
    async decide(
      request: DecisionRequest,
      context: { signal: AbortSignal; timeoutMs: number },
    ): Promise<DecisionProviderResult> {
      try {
        context.signal.throwIfAborted();
        const engine = runtime.current();
        if (!engine) {
          const { state } = runtime.snapshot();
          if (state === "failed" || state === "inactive") {
            throw new DecisionProviderError("unavailable", `Bekko is ${state}`);
          }
          runtime.ensureStarted();
          throw new DecisionProviderError("not_ready", "Bekko is loading");
        }
        const encoded = encode(request);
        // ONNX inference cannot be interrupted: the deadline only stops waiting for it, so a
        // late result is never reported as a success.
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)]);
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const prediction = await Promise.race([
            engine.decide(encoded.state, encoded.questions),
            aborted,
          ]);
          return decode(encoded, prediction.answers, prediction.truncated);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        throw toProviderError(error);
      }
    },
    activate() {
      runtime.activate();
    },
    async deactivate() {
      await runtime.deactivate();
    },
  };
}
