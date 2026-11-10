/** Error codes Lumbre returns to the frame. They never carry inputs, paths, logs or stacks. */
export const ERROR_CODES = [
  "invalid_input",
  "invalid_path",
  "not_found",
  "conflict",
  "too_large",
  "managed_file",
  "project_busy",
  "too_many_jobs",
  "too_many_servers",
  "storage_failed",
  "damaged_project",
  "no_model",
  "context_limit",
  "agent_failed",
  "invalid_output",
  "install_failed",
  "build_failed",
  "server_failed",
  "server_timeout",
  "server_stopped",
  "node_too_old",
  "browser_unavailable",
  "export_exists",
  "cancelled",
  "unavailable",
  "operation_failed",
] as const;
export type LumbreErrorCode = (typeof ERROR_CODES)[number];

export class LumbreError extends Error {
  readonly code: LumbreErrorCode;
  constructor(code: LumbreErrorCode) {
    super(code);
    this.name = "LumbreError";
    this.code = code;
  }
}

/** True for an abort or timeout raised through an `AbortSignal`. */
export function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Any error as a frame-safe code. */
export function errorCode(error: unknown): LumbreErrorCode {
  if (error instanceof LumbreError) return error.code;
  if (isAbort(error)) return "cancelled";
  return "operation_failed";
}
