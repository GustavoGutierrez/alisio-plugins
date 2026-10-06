import type { SpecEnvelope } from "./envelopes/spec.js";
import { validateSpec } from "./envelopes/spec.js";

/** Largest source specification file: 128 KiB (SRC-005). */
export const SOURCE_MAX_BYTES = 131_072;
const MAX_POINTERS = 20;
const INTENT_TITLE_MAX = 200;

export type SourceFormat = "markdown" | "spec-json";
export type SourceCode =
  | "SRC-001"
  | "SRC-002"
  | "SRC-003"
  | "SRC-004"
  | "SRC-005"
  | "SRC-006"
  | "SRC-007"
  | "SRC-008";

export interface SourceProblem {
  ok: false;
  code: SourceCode;
  message: string;
}

const problem = (code: SourceCode, message: string): SourceProblem => ({
  ok: false,
  code,
  message: `${code}: ${message}`,
});

const MACHINE_DIRS = new Set([".git", ".alisio"]);

/**
 * SRC-001 to SRC-003: the path form, the location and the file type of a `--from-spec` value. One
 * leading `./` is stripped; absolute paths are refused even inside the workspace so there is one
 * rule. Symlink escapes and the file kind are checked against the file system by the adapter.
 */
export function checkSourcePath(
  raw: string,
): { ok: true; path: string; format: SourceFormat } | SourceProblem {
  const trimmed = raw.trim();
  const path = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (path === "") return problem("SRC-001", "the spec path is empty");
  if (path.includes("\u0000")) return problem("SRC-001", "the spec path contains a NUL");
  if (path.includes("\\")) return problem("SRC-001", "use forward slashes in the spec path");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return problem("SRC-001", "the spec path must be relative to the workspace");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === ".." || segment === "."))
    return problem("SRC-001", "the spec path must not contain '..', '.' or empty segments");
  if (MACHINE_DIRS.has((segments[0] as string).toLowerCase()))
    return problem("SRC-002", "specs cannot be read from .git or .alisio");
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return { ok: true, path, format: "markdown" };
  if (lower.endsWith(".json")) return { ok: true, path, format: "spec-json" };
  return problem("SRC-003", "the spec must be a .md, .markdown or .json file");
}

/** SRC-005 and SRC-006: size, UTF-8, NUL and blank checks; strips the BOM and normalizes CRLF. */
export function decodeSource(
  bytes: Uint8Array,
): { ok: true; text: string; bytes: number } | SourceProblem {
  if (bytes.byteLength < 1 || bytes.byteLength > SOURCE_MAX_BYTES)
    return problem("SRC-005", `the spec must be between 1 byte and ${SOURCE_MAX_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return problem("SRC-006", "the spec is not valid UTF-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  if (text.includes("\u0000")) return problem("SRC-006", "the spec contains a NUL character");
  text = text.replace(/\r\n?/g, "\n");
  if (text.trim() === "") return problem("SRC-006", "the spec is blank");
  return { ok: true, text, bytes: bytes.byteLength };
}

/** SRC-007: exactly one JSON value that is a valid SpecEnvelope; lists up to 20 pointers. */
export function checkSourceJson(
  text: string,
): { ok: true; spec: SpecEnvelope } | (SourceProblem & { errors: string[] }) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ...problem("SRC-007", "the file is not one JSON value (use .md to have it normalized)"),
      errors: [],
    };
  }
  const result = validateSpec(raw);
  if (result.ok) return { ok: true, spec: result.value };
  const errors = result.errors
    .slice(0, MAX_POINTERS)
    .map((e) => `${e.pointer || "(root)"}: ${e.message}`);
  return {
    ...problem("SRC-007", `the file is not a valid spec envelope: ${errors.join("; ")}`),
    errors,
  };
}

/** SRC-008: L0 has no specify phase, so it cannot take a source specification. */
export function checkSourceLevel(level: string): SourceProblem | undefined {
  return level === "L0"
    ? problem("SRC-008", "L0 has no specify phase; use L1 or higher with a source spec")
    : undefined;
}

const clip = (text: string, max: number): string => text.trim().slice(0, max).trimEnd();

/**
 * The intent of a feature created from a source file when none is given: the first level-1 heading
 * (outside code fences) or the first non-blank line of a markdown file, followed by the path; the
 * objective of a JSON envelope.
 */
export function deriveIntent(text: string, format: SourceFormat, path: string): string {
  if (format === "spec-json") {
    try {
      const objective = (JSON.parse(text) as { objective?: unknown }).objective;
      if (typeof objective === "string" && objective.trim() !== "")
        return clip(objective, INTENT_TITLE_MAX);
    } catch {
      // Falls through to the path.
    }
    return `Spec from ${path}`;
  }
  const lines = text.split("\n");
  let fenced = false;
  let heading: string | undefined;
  let first: string | undefined;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    first ??= trimmed.replace(/^#+\s*/, "");
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (match && heading === undefined) {
      heading = match[1] as string;
      break;
    }
  }
  const title = clip(heading ?? first ?? path, INTENT_TITLE_MAX);
  return `${title} (from ${path})`;
}
