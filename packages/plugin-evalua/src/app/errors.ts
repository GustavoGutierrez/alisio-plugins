import { LockTimeoutError } from "../lock.js";

/** Error codes an app action returns (app spec §7); never the input, a path or a stack. */
export const APP_ERROR_CODES = [
  "invalid_input",
  "state_changed",
  "busy",
  "phase_mismatch",
  "not_found",
  "no_model",
  "model_failed",
  "file_too_large",
  "bad_image",
  "operation_failed",
  "cancelled",
] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export class AppError extends Error {
  constructor(readonly code: AppErrorCode) {
    super(code);
    this.name = "AppError";
  }
}

/** Maps any failure to a code: app errors keep theirs, a lock timeout is `busy`, the rest fail. */
export function errorCode(error: unknown): AppErrorCode {
  if (error instanceof AppError) return error.code;
  if (error instanceof LockTimeoutError) return "busy";
  return "operation_failed";
}
