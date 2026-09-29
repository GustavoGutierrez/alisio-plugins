export type Source = "openalex" | "crossref" | "arxiv";
export type Identifier =
  | { kind: "doi"; value: string }
  | { kind: "arxiv"; value: string; version?: string }
  | { kind: "openalex"; value: string };
const currentYear = () => new Date().getUTCFullYear() + 1;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid input");
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error("invalid input");
};
const text = (v: unknown, min: number, max: number) => {
  if (typeof v !== "string") throw new Error("invalid input");
  const s = v.trim();
  if (s.length < min || s.length > max) throw new Error("invalid input");
  return s;
};
const limit = (v: unknown) =>
  v === undefined
    ? 5
    : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10
      ? (v as number)
      : (() => {
          throw new Error("invalid input");
        })();
const year = (v: unknown) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1600 || (v as number) > currentYear())
    throw new Error("invalid input");
  return v as number;
};
export function searchInput(input: unknown, sourceRequired = false) {
  const v = object(input);
  keys(
    v,
    sourceRequired
      ? ["query", "limit", "source", "fromYear", "toYear"]
      : ["query", "limit", "fromYear", "toYear"],
  );
  const fromYear = year(v.fromYear),
    toYear = year(v.toYear);
  if (fromYear && toYear && fromYear > toYear) throw new Error("invalid input");
  const source = sourceRequired
    ? v.source === "openalex" || v.source === "crossref" || v.source === "arxiv"
      ? v.source
      : (() => {
          throw new Error("invalid input");
        })()
    : ("openalex" as Source);
  return { query: text(v.query, 1, 512), limit: limit(v.limit), source, fromYear, toYear };
}
export function identifier(raw: unknown): Identifier {
  const s = text(raw, 1, 2048);
  let value = decodeURIComponent(s).trim();
  value = value.replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (/^10\.\d{4,9}\/[\w.()/:;+-]+$/i.test(value))
    return { kind: "doi", value: value.toLowerCase() };
  const ar = value.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v\d+)?$/i);
  if (ar)
    return {
      kind: "arxiv",
      value: (ar[1] ?? "").toLowerCase(),
      ...(ar[2] ? { version: ar[2].slice(1) } : {}),
    };
  const oa = value.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (oa) return { kind: "openalex", value: (oa[1] ?? "").toUpperCase() };
  throw new Error("invalid input");
}
export function readInput(input: unknown) {
  const v = object(input);
  keys(v, ["identifier"]);
  return identifier(v.identifier);
}
