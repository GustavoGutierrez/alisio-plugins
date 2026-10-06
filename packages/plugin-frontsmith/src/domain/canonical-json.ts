/**
 * Stable JSON text: sorted keys, two-space indent, trailing newline (spec 8.1). Pure, so the same
 * object always yields the same bytes and the same hash.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value, new Set()), null, 2)}\n`;
}

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot serialise a non-finite number");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value !== "object")
    throw new TypeError(`Cannot serialise a value of type ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Cannot serialise a cyclic structure");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => normalize(item === undefined ? null : item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = normalize(child, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
