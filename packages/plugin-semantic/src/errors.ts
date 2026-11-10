/** Error codes the plugin returns (§8). Never carry inputs, paths or stacks. */
export const ERROR_CODES = [
  "invalid_input",
  "not_found",
  "limit_exceeded",
  "unsupported_format",
  "invalid_encoding",
  "no_text",
  "path_outside_workspace",
  "file_too_large",
  "zip_invalid",
  "engine_unavailable",
  "model_missing",
  "model_corrupt",
  "unknown_model",
  "model_mismatch",
  "download_failed",
  "cancelled",
  "answer_failed",
  "operation_failed",
] as const;
export type SemanticPluginErrorCode = (typeof ERROR_CODES)[number];

export class SemanticPluginError extends Error {
  readonly code: SemanticPluginErrorCode;
  constructor(code: SemanticPluginErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SemanticPluginError";
    this.code = code;
  }
}

/** True for an abort raised by an `AbortSignal` (DOMException or a plain AbortError). */
export function isAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    ((error as { name?: unknown }).name === "AbortError" ||
      (error as { name?: unknown }).name === "TimeoutError")
  );
}

/**
 * Maps any error to a plugin code. The host's `SemanticError` is matched by `name`/`code`, not
 * `instanceof`, because the host and the plugin may load different copies of the SDK.
 */
export function errorCode(error: unknown): SemanticPluginErrorCode {
  if (error instanceof SemanticPluginError) return error.code;
  if (isAbort(error)) return "cancelled";
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "SemanticError"
  ) {
    const code = (error as { code?: unknown }).code;
    if (code === "model_mismatch" || code === "dimension_mismatch") return "model_mismatch";
    if (code === "invalid_request") return "invalid_input";
    return "engine_unavailable";
  }
  return "operation_failed";
}
