import { type ContrastKind, contrastRatio, minimumRatio } from "./contrast.js";
import { parseColor, type Rgba } from "./parse.js";

/** Required pairs are edges of a graph, never all pairs (spec 12.2). */
export interface PairEdge {
  fg: string[];
  bg: string[];
  kind: ContrastKind;
}

export interface PairGraph {
  schemaVersion: 1;
  /** Prefix that turns a role name into a custom property (`bg-canvas` -> `--color-bg-canvas`). */
  namespace: string;
  edges: PairEdge[];
}

export interface AccentFamily {
  id: string;
  light: { solid: string; on: string };
  dark: { solid: string; on: string };
}

export type Theme = "light" | "dark";
export const themes: readonly Theme[] = ["light", "dark"];

export interface PairCheck {
  theme: Theme;
  fg: string;
  bg: string;
  kind: ContrastKind;
  fgValue: string;
  bgValue: string;
  /** Unrounded. */
  ratio: number;
  minimum: number;
  status: "PASS" | "FAIL";
}

export type PairGraphValidation = { ok: true; graph: PairGraph } | { ok: false; errors: string[] };

const KINDS: readonly string[] = ["normal_text", "large_text", "non_text"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const names = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === "string" && /^[a-z][a-z0-9-]*$/.test(entry));

export function parsePairGraph(raw: unknown): PairGraphValidation {
  if (!isRecord(raw)) return { ok: false, errors: ["pair graph must be an object"] };
  const errors: string[] = [];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof raw.namespace !== "string" || !/^--[a-z][a-z0-9-]*-$/.test(raw.namespace))
    errors.push("namespace must look like --color-");
  if (!Array.isArray(raw.edges)) errors.push("edges must be an array");
  else
    raw.edges.forEach((edge: unknown, index: number) => {
      if (
        !isRecord(edge) ||
        !names(edge.fg) ||
        !names(edge.bg) ||
        typeof edge.kind !== "string" ||
        !KINDS.includes(edge.kind)
      )
        errors.push(`/edges/${index}: needs fg names, bg names and a contrast kind`);
    });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, graph: raw as unknown as PairGraph };
}

/** Every `fg`/`bg` combination of every edge, in edge order, foreground-major. */
export function expandPairGraph(
  graph: PairGraph,
): Array<{ fg: string; bg: string; kind: ContrastKind }> {
  return graph.edges.flatMap((edge) =>
    edge.fg.flatMap((fg) => edge.bg.map((bg) => ({ fg, bg, kind: edge.kind }))),
  );
}

/** Custom property name of a role. */
export const tokenName = (graph: PairGraph, role: string): string => `${graph.namespace}${role}`;

/**
 * Evaluate the default pair graph over a role table per theme, plus the solid/on pair of every
 * accent family (spec 12.2). The AA target applies; values are compared unrounded.
 */
export function evaluateRoleTable(
  graph: PairGraph,
  roles: Partial<Record<Theme, Record<string, string>>>,
  accents: readonly AccentFamily[],
): PairCheck[] {
  const checks: PairCheck[] = [];
  const push = (
    theme: Theme,
    fg: string,
    bg: string,
    kind: ContrastKind,
    fgValue: string,
    bgValue: string,
  ): void => {
    const foreground = parseColor(fgValue) as Rgba;
    const background = parseColor(bgValue) as Rgba;
    const ratio = contrastRatio(foreground, background);
    const minimum = minimumRatio(kind, "AA");
    checks.push({
      theme,
      fg,
      bg,
      kind,
      fgValue,
      bgValue,
      ratio,
      minimum,
      status: ratio >= minimum ? "PASS" : "FAIL",
    });
  };
  for (const theme of themes) {
    const table = roles[theme];
    if (!table) continue;
    for (const pair of expandPairGraph(graph)) {
      const fgValue = table[pair.fg];
      const bgValue = table[pair.bg];
      if (fgValue && bgValue && parseColor(fgValue) && parseColor(bgValue))
        push(theme, pair.fg, pair.bg, pair.kind, fgValue, bgValue);
    }
  }
  for (const theme of themes) {
    if (!roles[theme]) continue;
    for (const accent of accents)
      push(
        theme,
        `accent-${accent.id}-on`,
        `accent-${accent.id}-solid`,
        "normal_text",
        accent[theme].on,
        accent[theme].solid,
      );
  }
  return checks;
}
