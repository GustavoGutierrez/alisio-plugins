import { MAX_FIELD_CHARS, sanitizeRemoteText } from "./text.js";

/** Read a nested value from an unknown remote object without trusting its shape. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Follow a string path through nested objects and return the first string leaf. */
export function pathText(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    const holder = record(current);
    if (!holder) return undefined;
    current = holder[key];
  }
  return text(current);
}

/** A single `Label: value` line, or undefined when the value is absent. */
export function kv(label: string, value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  const clean = sanitizeRemoteText(value, max);
  return clean === "" ? undefined : `${label}: ${clean}`;
}

export function joinLines(items: Array<string | undefined>): string {
  return items.filter((item): item is string => typeof item === "string" && item !== "").join("\n");
}

/** Split a list into the visible prefix and the count left out of the result. */
export function bounded<T>(items: T[], max: number): { shown: T[]; hidden: number } {
  return items.length <= max
    ? { shown: items, hidden: 0 }
    : { shown: items.slice(0, max), hidden: items.length - max };
}

export function moreLine(hidden: number): string | undefined {
  return hidden > 0 ? `… ${hidden} more not shown` : undefined;
}

/** One bounded paging trailer derived from a `nextPageToken`, never the raw state. */
export function pagingLine(shown: number, nextPageToken: string | undefined): string {
  return nextPageToken === undefined
    ? `Showing ${shown} result(s); no further pages.`
    : `Showing ${shown} result(s); next page token: ${sanitizeRemoteText(nextPageToken, 256)}`;
}
