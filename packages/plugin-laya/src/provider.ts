/**
 * The Laya `DecisionProvider`. It depends only on three seams — the pure codec, a `LayaTransport`
 * and a `RuntimeStatus` source — so a remote provider can reuse the shape and swap the runtime.
 */
import type { DecisionProvider, DecisionProviderResult, DecisionRequest } from "@alisio/sdk";
import { LayaUnavailableError, toProviderError } from "./errors.js";
import { decodeResponse, encodeRequest } from "./protocol/codec.js";
import type { LayaTransport } from "./transport/http.js";

export type RuntimeState =
  | "inactive"
  | "not_installed"
  | "setup_running"
  | "config_invalid"
  | "stopped"
  | "starting"
  | "warming"
  | "ready"
  | "failed"
  | "backoff";

export interface RuntimeSnapshot {
  state: RuntimeState;
  detail?: string;
}

/** What the provider needs from whatever manages the server. Never blocks. */
export interface RuntimeStatus {
  snapshot(): RuntimeSnapshot;
  /** Single-flight background start; returns immediately. */
  ensureStarted(): void;
  /** The transport when the server is ready, otherwise `null`. */
  transport(): LayaTransport | null;
  /** A connection to the server failed: re-probe it. */
  noteConnectionFailure(): void;
  /** Observed latency, for `/laya:status`. */
  recordLatency(elapsedMs: number, questions: number): void;
}

export interface LayaProviderOptions {
  runtime: RuntimeStatus;
  /** Checkpoint pinned per request when a single one is configured. */
  model?: string | (() => string | undefined);
  /** Called when the core makes this provider the active one. Never throws. */
  onActivate?: () => void | Promise<void>;
  /** Called when the core stops using this provider. Never throws. */
  onDeactivate?: () => void | Promise<void>;
  maxInFlight?: number;
  healthBudgetMs?: number;
  now?: () => number;
}

const HEALTH_CACHE_MS = 5000;

export function createLayaProvider(options: LayaProviderOptions): DecisionProvider {
  const { runtime } = options;
  const maxInFlight = options.maxInFlight ?? 4;
  const healthBudgetMs = options.healthBudgetMs ?? 2000;
  const now = options.now ?? Date.now;
  let inFlight = 0;
  let cached: { at: number; ready: boolean } | null = null;

  function rejectUnlessReady(): LayaTransport {
    const { state, detail } = runtime.snapshot();
    switch (state) {
      case "ready": {
        const transport = runtime.transport();
        if (transport) return transport;
        throw new LayaUnavailableError("failed", "the local server is not reachable");
      }
      case "starting":
      case "warming":
        throw new LayaUnavailableError("starting", "the local server is starting");
      case "stopped":
        runtime.ensureStarted();
        throw new LayaUnavailableError("starting", "the local server is starting");
      case "not_installed":
        throw new LayaUnavailableError("not_installed", "not installed: run /laya:setup");
      case "setup_running":
        throw new LayaUnavailableError("setup_running", "setup in progress");
      case "inactive":
        throw new LayaUnavailableError("inactive", "provider not active");
      case "backoff":
        throw new LayaUnavailableError("backoff", detail ?? "waiting to restart the local server");
      default:
        throw new LayaUnavailableError("failed", detail ?? "the local server is unavailable");
    }
  }

  async function decide(
    request: DecisionRequest,
    context: { signal: AbortSignal; timeoutMs: number },
  ): Promise<DecisionProviderResult> {
    try {
      const model = typeof options.model === "function" ? options.model() : options.model;
      const { wire, plan } = encodeRequest(request, model ? { model } : {});
      const transport = rejectUnlessReady();
      if (inFlight >= maxInFlight) {
        throw new LayaUnavailableError("overloaded", "too many decisions in flight");
      }
      inFlight++;
      const started = now();
      try {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)]);
        const body = await transport.infer(wire, { signal });
        const result = decodeResponse(body, plan);
        runtime.recordLatency(now() - started, plan.entries.length);
        return result;
      } finally {
        inFlight--;
      }
    } catch (error) {
      if (error instanceof LayaUnavailableError && error.connection)
        runtime.noteConnectionFailure();
      throw toProviderError(error);
    }
  }

  async function health(signal?: AbortSignal) {
    const { state, detail } = runtime.snapshot();
    switch (state) {
      case "config_invalid":
        return { status: "unavailable" as const, detail: detail ?? "invalid configuration" };
      case "not_installed":
        return { status: "unavailable" as const, detail: "not installed: run /laya:setup" };
      case "setup_running":
        return { status: "unavailable" as const, detail: "setup in progress" };
      case "inactive":
        return { status: "unavailable" as const, detail: "provider not active" };
      case "starting":
      case "warming":
        return { status: "starting" as const };
      case "stopped":
        return { status: "unavailable" as const, detail: "server not started" };
      case "failed":
      case "backoff":
        return { status: "unavailable" as const, detail: detail ?? state };
      case "ready":
        break;
    }
    const transport = runtime.transport();
    if (!transport) return { status: "unavailable" as const, detail: "server not reachable" };
    if (!cached || now() - cached.at > HEALTH_CACHE_MS) {
      const guard = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(healthBudgetMs),
      ]);
      const result = await transport.probe(guard);
      cached = { at: now(), ready: result === "up" };
    }
    return cached.ready
      ? { status: "ready" as const }
      : { status: "unavailable" as const, detail: "server not responding" };
  }

  return {
    id: "laya",
    name: "Laya",
    capabilities: { select: true, boolean: true, ordinal: true },
    health,
    decide,
    async activate() {
      try {
        await options.onActivate?.();
      } catch {
        /* activation is never fatal */
      }
    },
    async deactivate() {
      try {
        await options.onDeactivate?.();
      } catch {
        /* deactivation is never fatal */
      }
    },
  };
}
