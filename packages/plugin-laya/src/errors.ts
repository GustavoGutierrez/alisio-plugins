import { DecisionProviderError } from "@alisio/sdk";

export type LayaUnavailableCode =
  | "not_installed"
  | "starting"
  | "failed"
  | "backoff"
  | "overloaded"
  | "inactive"
  | "setup_running"
  | "host_unsupported";

/** Base class: every Laya error carries a stable code and a short, state-free message. */
export class LayaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The server cannot answer right now (starting, failed, backoff, not installed, inactive). */
export class LayaUnavailableError extends LayaError {
  declare readonly code: LayaUnavailableCode;
  /** True when the failure was a refused or reset connection (the caller should re-probe). */
  readonly connection: boolean;
  constructor(code: LayaUnavailableCode, message: string, options: { connection?: boolean } = {}) {
    super(code, message);
    this.connection = options.connection ?? false;
  }
}

/** The request deadline or a caller abort was reached. */
export class LayaTimeoutError extends LayaError {
  constructor(message = "decision deadline reached") {
    super("timeout", message);
  }
}

/** The server answered with something this plugin does not accept. */
export class LayaProtocolError extends LayaError {}

/** The incoming request violates a limit the core guarantees (a core bug). */
export class LayaRequestError extends LayaError {}

/** Invalid plugin configuration. */
export class LayaConfigError extends LayaError {
  constructor(message: string) {
    super("config_invalid", message);
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Convert any failure into the SDK error the core's circuit breaker keys off. Raw errors never
 * escape `decide()`, and unknown messages are never echoed (they could carry decision state).
 */
export function toProviderError(error: unknown): DecisionProviderError {
  if (error instanceof DecisionProviderError) return error;
  if (error instanceof LayaUnavailableError) {
    return new DecisionProviderError(
      error.code === "starting" ? "not_ready" : "unavailable",
      error.message,
    );
  }
  if (error instanceof LayaConfigError)
    return new DecisionProviderError("unavailable", error.message);
  if (error instanceof LayaTimeoutError) return new DecisionProviderError("timeout", error.message);
  if (error instanceof LayaProtocolError) {
    return new DecisionProviderError("invalid_response", error.message);
  }
  if (error instanceof LayaRequestError)
    return new DecisionProviderError("internal", error.message);
  if (isAbortLike(error)) return new DecisionProviderError("timeout", "decision deadline reached");
  return new DecisionProviderError("internal", "unexpected provider failure");
}
