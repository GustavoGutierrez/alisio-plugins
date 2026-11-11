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

/** Safe, fixed sub-reasons of a code (never model text): why a wording draft failed. */
export const APP_ERROR_DETAILS = ["model_error", "unreadable", "rejected"] as const;
export type AppErrorDetail = (typeof APP_ERROR_DETAILS)[number];

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly detail?: AppErrorDetail,
  ) {
    super(code);
    this.name = "AppError";
  }
}

/** The safe detail of a failure, only when it is one of the fixed values. */
export function errorDetail(error: unknown): AppErrorDetail | undefined {
  return error instanceof AppError && error.detail !== undefined ? error.detail : undefined;
}

/** Maps any failure to a code: app errors keep theirs, a lock timeout is `busy`, the rest fail. */
export function errorCode(error: unknown): AppErrorCode {
  if (error instanceof AppError) return error.code;
  if (error instanceof LockTimeoutError) return "busy";
  return "operation_failed";
}
