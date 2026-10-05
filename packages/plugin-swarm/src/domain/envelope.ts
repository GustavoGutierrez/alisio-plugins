import { validateCommit } from "./identifiers.js";

/** Child output envelopes (spec 4.4). Strict: invalid output is rejected, never repaired. */
export interface Evidence {
  requirement: string;
  proof: string;
}

export type Envelope =
  | { schemaVersion: 1; kind: "handoff"; commit: string; summary: string; evidence: Evidence[] }
  | { schemaVersion: 1; kind: "needs_clarification"; question: string }
  | { schemaVersion: 1; kind: "blocked"; reason: string }
  | { schemaVersion: 1; kind: "note"; message: string };

export type EnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; reason: string };

export interface ParseOptions {
  /** The child hit its turn limit: its text is partial and must not be trusted. */
  turnsExceeded?: boolean;
}

const MAX_BYTES = 64 * 1024;
const MAX_TEXT = 2000;
const MAX_NOTE = 80;
const MAX_EVIDENCE = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fail = (reason: string): EnvelopeResult => ({ ok: false, reason });

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown key "${key}" in ${label}`);
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}: expected non-empty text`);
  if (value.length > max) throw new Error(`Invalid ${label}: longer than ${max} characters`);
  return value;
}

function unfence(raw: string): string {
  const fenced = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(raw);
  return fenced ? (fenced[1] as string).trim() : raw;
}

export function parseEnvelope(output: string, options: ParseOptions = {}): EnvelopeResult {
  if (options.turnsExceeded) return fail("The run exceeded its turn limit; output is partial");
  const raw = (output ?? "").trim();
  if (!raw) return fail("Empty output: expected one JSON envelope");
  if (Buffer.byteLength(raw) > MAX_BYTES) return fail("Output too large for an envelope");
  let value: unknown;
  try {
    value = JSON.parse(unfence(raw));
  } catch {
    return fail("Output is not a single valid JSON document");
  }
  if (!isRecord(value)) return fail("Envelope must be a JSON object");
  try {
    if (value.schemaVersion !== 1)
      throw new Error("Unsupported envelope schemaVersion (expected 1)");
    switch (value.kind) {
      case "handoff": {
        onlyKeys(value, ["schemaVersion", "kind", "commit", "summary", "evidence"], "handoff");
        const commit = validateCommit(value.commit as string);
        const summary = text(value.summary, "summary", MAX_TEXT);
        if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
          throw new Error("Invalid evidence: provide at least one requirement/proof pair");
        }
        if (value.evidence.length > MAX_EVIDENCE)
          throw new Error("Invalid evidence: too many entries");
        const evidence = value.evidence.map((item): Evidence => {
          if (!isRecord(item)) throw new Error("Invalid evidence entry: expected an object");
          onlyKeys(item, ["requirement", "proof"], "evidence entry");
          return {
            requirement: text(item.requirement, "requirement", MAX_TEXT),
            proof: text(item.proof, "proof", MAX_TEXT),
          };
        });
        return {
          ok: true,
          envelope: { schemaVersion: 1, kind: "handoff", commit, summary, evidence },
        };
      }
      case "needs_clarification": {
        onlyKeys(value, ["schemaVersion", "kind", "question"], "needs_clarification");
        return {
          ok: true,
          envelope: {
            schemaVersion: 1,
            kind: "needs_clarification",
            question: text(value.question, "question", MAX_TEXT),
          },
        };
      }
      case "blocked": {
        onlyKeys(value, ["schemaVersion", "kind", "reason"], "blocked");
        return {
          ok: true,
          envelope: {
            schemaVersion: 1,
            kind: "blocked",
            reason: text(value.reason, "reason", MAX_TEXT),
          },
        };
      }
      case "note": {
        onlyKeys(value, ["schemaVersion", "kind", "message"], "note");
        const message = text(value.message, "message", MAX_NOTE);
        if (/[\r\n]/.test(message)) throw new Error("Invalid message: a note is a single line");
        return { ok: true, envelope: { schemaVersion: 1, kind: "note", message } };
      }
      default:
        throw new Error("Unknown envelope kind");
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
