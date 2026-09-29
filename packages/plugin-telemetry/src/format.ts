/**
 * Bounded, privacy-preserving result framing shared by every telemetry tool.
 *
 * No tool ever returns a raw event dump. Each result carries a bounds envelope
 * (`returned`, `total`, `truncated`, and a refinement `hint`) so an agent can
 * tell whether it is looking at everything or a slice. Every string that leaves
 * this module passes through redaction and looks-like-a-path neutralization, so
 * a hostile tool name or model string cannot smuggle a credential or an absolute
 * machine path into a result.
 */
import { redactText } from "./redact.js";

export interface BoundsWindow {
  from: string;
  to: string;
  windowMinutes: number;
}

export interface BoundsEnvelope<T> {
  window: BoundsWindow;
  returned: number;
  total: number;
  truncated: boolean;
  hint: string;
  data: T;
}

/** A stable error payload. Shape is part of the tool contract. */
export interface TelemetryError {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

const LOOKS_LIKE_PATH = /(?<!\S)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g;

/** Redact and bound a display string. Never returns an absolute machine path. */
export function sanitizeField(value: unknown, max = 200): string {
  const text =
    typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const redacted = redactText(text, { mode: "standard", maxLength: max });
  return redacted.replace(LOOKS_LIKE_PATH, "<path>").replace(/\s+/g, " ").trim();
}

export function hintFor(returned: number, total: number, _limit: number): string {
  if (total > returned)
    return `Showing ${returned} of ${total}. Raise limit (max 100) or narrow the window with windowMinutes.`;
  if (total === 0)
    return "No telemetry recorded in this window; run an agent session or widen windowMinutes.";
  return `Complete for the selected window (${returned} of ${total}).`;
}

export function boundsEnvelope<T>(options: {
  window: BoundsWindow;
  data: T;
  returned: number;
  total: number;
  limit: number;
  hint?: string;
}): BoundsEnvelope<T> {
  const truncated = options.total > options.returned;
  return {
    window: options.window,
    returned: options.returned,
    total: options.total,
    truncated,
    hint: options.hint ?? hintFor(options.returned, options.total, options.limit),
    data: options.data,
  };
}

export function stableError(code: string, message: string, hint?: string): TelemetryError {
  return { error: hint === undefined ? { code, message } : { code, message, hint } };
}

/** Serialize a tool payload to bounded JSON text. */
export function toolJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(
      stableError("serialization_failed", "Telemetry result could not be serialized."),
    );
  }
}
