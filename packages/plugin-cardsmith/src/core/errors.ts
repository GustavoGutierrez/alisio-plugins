/**
 * Typed errors for the cardsmith domain. Every failure that crosses a public boundary is a
 * `CardsmithError` with a stable `code`, so tool adapters can map codes to user-facing copy
 * without parsing messages.
 */
export type CardsmithErrorCode =
  | "INVALID_SPEC"
  | "UNKNOWN_TEMPLATE"
  | "UNKNOWN_PALETTE"
  | "UNKNOWN_FONT_PAIR"
  | "UNKNOWN_SIZE"
  | "INCOMPATIBLE_SIZE"
  | "UNKNOWN_ILLUSTRATION"
  | "UNKNOWN_ASSET"
  | "TEXT_OVERFLOW"
  | "QR_TOO_DENSE"
  | "QR_INVALID"
  | "LIMIT_EXCEEDED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_DECODE_FAILED"
  | "REVISION_MISMATCH"
  | "DRAFT_NOT_FOUND"
  | "EXPORT_CONFLICT"
  | "EXPORT_INVALID_PATH"
  | "EXPORT_DELETE_FAILED"
  | "PUBLISH_UNAVAILABLE"
  | "RENDER_FAILED"
  | "CACHE_WRITE_FAILED"
  | "NOT_IMPLEMENTED";

export interface CardsmithErrorJson {
  name: "CardsmithError";
  code: CardsmithErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class CardsmithError extends Error {
  readonly code: CardsmithErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CardsmithErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CardsmithError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): CardsmithErrorJson {
    const json: CardsmithErrorJson = {
      name: "CardsmithError",
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) json.details = this.details;
    return json;
  }
}
