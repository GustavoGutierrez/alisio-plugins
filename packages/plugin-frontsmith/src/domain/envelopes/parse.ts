import { type IdKind, matchesId } from "../ids.js";

/** The ten child envelope kinds (spec 9.2). */
export const envelopeKinds = [
  "spec",
  "ui-contract",
  "tokens",
  "plan",
  "test-map",
  "task-result",
  "a11y-audit",
  "fidelity-review",
  "review",
  "archive",
] as const;
export type EnvelopeKind = (typeof envelopeKinds)[number];

/** Caps shared by every envelope (spec 9.1, B-03: one 4000 character cap for every string). */
export const LIMITS = { string: 4000, array: 200, depth: 8 } as const;

export interface EnvelopeError {
  /** JSON pointer into the envelope. */
  pointer: string;
  message: string;
}
export type EnvelopeResult<T> = { ok: true; value: T } | { ok: false; errors: EnvelopeError[] };

export type ParsedJson = { ok: true; value: unknown } | { ok: false; message: string };

const FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/**
 * The trimmed text is either one JSON value or exactly one fenced `json` block (spec 9.1). Prose
 * before or after the value, or a second block, is rejected.
 */
export function parseChildJson(text: string): ParsedJson {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, message: "Child output is empty" };
  let source = trimmed;
  if (trimmed.startsWith("```")) {
    const match = FENCE.exec(trimmed);
    if (!match || (match[1] ?? "").includes("```"))
      return { ok: false, message: "Child output must be one JSON value or one fenced json block" };
    source = match[1] as string;
  }
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false, message: "Child output is not a single valid JSON value" };
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Control characters except newline and tab are removed from every string (spec 9.1). NUL is the
 * exception: stripping it would silently turn `a<NUL>b` into the different path `ab`, so a NUL is
 * reported as an error instead.
 */
export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Walk a parsed value once: strip control characters, and report strings over 4000 characters,
 * arrays over 200 items and nesting deeper than 8. Returns the cleaned copy.
 */
export function sanitizeEnvelope(raw: unknown): {
  value: unknown;
  errors: EnvelopeError[];
} {
  const errors: EnvelopeError[] = [];
  const walk = (value: unknown, pointer: string, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.includes("\u0000"))
        errors.push({ pointer, message: "string contains a NUL character" });
      const clean = stripControl(value);
      if (clean.length > LIMITS.string)
        errors.push({ pointer, message: `string is longer than ${LIMITS.string} characters` });
      return clean;
    }
    if (typeof value !== "object" || value === null) return value;
    if (depth > LIMITS.depth) {
      errors.push({ pointer, message: `nesting is deeper than ${LIMITS.depth} levels` });
      return null;
    }
    if (Array.isArray(value)) {
      if (value.length > LIMITS.array)
        errors.push({ pointer, message: `array has more than ${LIMITS.array} items` });
      return value
        .slice(0, LIMITS.array + 1)
        .map((item, i) => walk(item, `${pointer}/${i}`, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value))
      out[stripControl(key)] = walk(child, `${pointer}/${key}`, depth + 1);
    return out;
  };
  return { value: walk(raw, "", 1), errors };
}

/** Workspace-relative, `/`-separated path: no `..`, leading `/`, backslash or NUL (spec 9.1). */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value.includes("\u0000") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === "" || part === ".");
}

export interface StringOptions {
  max?: number;
  optional?: boolean;
  nullable?: boolean;
  pattern?: RegExp;
  /** Allow an empty string (the default rejects it). */
  allowEmpty?: boolean;
}

/** Accumulates field errors while a validator walks an envelope. */
export class Check {
  readonly errors: EnvelopeError[] = [];

  fail(pointer: string, message: string): void {
    this.errors.push({ pointer, message });
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  /** An object whose keys are all in `allowed`; unknown keys are errors. */
  object(
    value: unknown,
    pointer: string,
    allowed: readonly string[],
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      this.fail(pointer, "must be an object");
      return undefined;
    }
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) this.fail(`${pointer}/${key}`, "unknown key");
    return value;
  }

  string(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    options: StringOptions = {},
  ): string | undefined {
    const value = source[key];
    const at = `${pointer}/${key}`;
    if (value === undefined) {
      if (!options.optional) this.fail(at, "is required");
      return undefined;
    }
    if (value === null) {
      if (!options.nullable) this.fail(at, "must be a string");
      return undefined;
    }
    if (typeof value !== "string") {
      this.fail(at, "must be a string");
      return undefined;
    }
    if (value.length === 0 && !options.allowEmpty) this.fail(at, "must not be empty");
    if (value.length > (options.max ?? LIMITS.string))
      this.fail(at, `must be at most ${options.max ?? LIMITS.string} characters`);
    if (options.pattern && !options.pattern.test(value))
      this.fail(at, `does not match ${options.pattern.source}`);
    return value;
  }

  id(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    kind: IdKind,
  ): string | undefined {
    const value = source[key];
    if (!matchesId(kind, value)) {
      this.fail(`${pointer}/${key}`, `must be a valid ${kind} id`);
      return undefined;
    }
    return value;
  }

  enum<T extends string>(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    values: readonly T[],
    optional = false,
  ): T | undefined {
    const value = source[key];
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail(`${pointer}/${key}`, `must be one of ${values.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  bool(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    optional = false,
  ): boolean | undefined {
    const value = source[key];
    if (value === undefined && optional) return undefined;
    if (typeof value !== "boolean") {
      this.fail(`${pointer}/${key}`, "must be a boolean");
      return undefined;
    }
    return value;
  }

  number(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    options: { integer?: boolean; min?: number; max?: number; optional?: boolean } = {},
  ): number | undefined {
    const value = source[key];
    if (value === undefined && options.optional) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(`${pointer}/${key}`, "must be a finite number");
      return undefined;
    }
    if (options.integer && !Number.isInteger(value))
      this.fail(`${pointer}/${key}`, "must be an integer");
    if (options.min !== undefined && value < options.min)
      this.fail(`${pointer}/${key}`, `must be at least ${options.min}`);
    if (options.max !== undefined && value > options.max)
      this.fail(`${pointer}/${key}`, `must be at most ${options.max}`);
    return value;
  }

  path(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    options: { optional?: boolean; nullable?: boolean } = {},
  ): string | undefined {
    const value = source[key];
    if (value === undefined && options.optional) return undefined;
    if (value === null && options.nullable) return undefined;
    if (!isSafeRelativePath(value)) {
      this.fail(`${pointer}/${key}`, "must be a workspace-relative path without '..'");
      return undefined;
    }
    return value;
  }

  /** An array of at most 200 items; each item goes through `each`. */
  array<T>(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    each: (item: unknown, at: string) => T | undefined,
    options: { optional?: boolean; min?: number } = {},
  ): T[] {
    const value = source[key];
    const at = `${pointer}/${key}`;
    if (value === undefined && options.optional) return [];
    if (!Array.isArray(value)) {
      this.fail(at, "must be an array");
      return [];
    }
    if (value.length > LIMITS.array) this.fail(at, `must have at most ${LIMITS.array} items`);
    if (options.min !== undefined && value.length < options.min)
      this.fail(at, `must have at least ${options.min} items`);
    const out: T[] = [];
    value.forEach((item, index) => {
      const parsed = each(item, `${at}/${index}`);
      if (parsed !== undefined) out.push(parsed);
    });
    return out;
  }

  strings(
    source: Record<string, unknown>,
    key: string,
    pointer: string,
    options: { optional?: boolean; pattern?: RegExp; path?: boolean } = {},
  ): string[] {
    return this.array(
      source,
      key,
      pointer,
      (item, at) => {
        if (typeof item !== "string" || item.length === 0 || item.length > LIMITS.string) {
          this.fail(at, "must be a non-empty string");
          return undefined;
        }
        if (options.pattern && !options.pattern.test(item)) {
          this.fail(at, `does not match ${options.pattern.source}`);
          return undefined;
        }
        if (options.path && !isSafeRelativePath(item)) {
          this.fail(at, "must be a workspace-relative path without '..'");
          return undefined;
        }
        return item;
      },
      options.optional ? { optional: true } : {},
    );
  }

  /** Every `id` in `items` is unique; duplicates are errors (code never renumbers silently). */
  unique(items: ReadonlyArray<{ id: string }>, pointer: string): void {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) this.fail(`${pointer}/${index}/id`, `duplicate id ${item.id}`);
      seen.add(item.id);
    });
  }

  result<T>(value: T): EnvelopeResult<T> {
    return this.ok ? { ok: true, value } : { ok: false, errors: this.errors };
  }
}

/** Common opening of every validator: sanitize, check caps, open the root object. */
export function openEnvelope(
  raw: unknown,
  kind: EnvelopeKind,
  allowed: readonly string[],
): { check: Check; root: Record<string, unknown> | undefined } {
  const check = new Check();
  const cleaned = sanitizeEnvelope(raw);
  check.errors.push(...cleaned.errors);
  const root = check.object(cleaned.value, "", ["schemaVersion", "kind", ...allowed]);
  if (root) {
    if (root.schemaVersion !== 1) check.fail("/schemaVersion", "must be 1");
    if (root.kind !== kind) check.fail("/kind", `must be ${kind}`);
  }
  return { check, root };
}

/** A string -> nothing optional `questions` item shared by the spec and ui-contract envelopes. */
export interface OpenQuestion {
  id: string;
  question: string;
  blocking: boolean;
  options: string[];
  recommendation: string;
}

export function readQuestions(
  check: Check,
  root: Record<string, unknown>,
  key: string,
): OpenQuestion[] {
  const questions = check.array(root, key, "", (item, at) => {
    const q = check.object(item, at, ["id", "question", "blocking", "options", "recommendation"]);
    if (!q) return undefined;
    return {
      id: check.id(q, "id", at, "question") ?? "",
      question: check.string(q, "question", at) ?? "",
      blocking: check.bool(q, "blocking", at) ?? false,
      options: check.strings(q, "options", at, { optional: true }),
      recommendation:
        check.string(q, "recommendation", at, { optional: true, allowEmpty: true }) ?? "",
    };
  });
  check.unique(questions, `/${key}`);
  return questions;
}
