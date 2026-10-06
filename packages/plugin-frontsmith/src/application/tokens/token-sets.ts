import { type ContrastKind, evaluateContrast } from "../../domain/color/contrast.js";
import { expandPairGraph, type PairGraph } from "../../domain/color/pairs.js";
import { parseColor } from "../../domain/color/parse.js";
import type { RequiredPair } from "../../domain/color/tokens-file.js";
import type { TokensData } from "../../domain/rules/unit.js";
import type { FileAnalysis } from "../ports/file-analyzer.js";

/** Evaluated pair for tables; the ratio is unrounded. */
export interface PairRow {
  source: string;
  theme: string;
  fg: string;
  bg: string;
  kind: ContrastKind;
  ratio: number | null;
  minimum: number;
  status: "PASS" | "FAIL" | "REVIEW";
}

const THEME_SELECTOR = /\[data-theme\s*=\s*["']?([\w-]+)["']?\]/;
const DARK_QUERY = /prefers-color-scheme\s*:\s*dark/;
const ROOT_SELECTOR = /^(?::root|html|:host)$/;

/** Theme a rule block defines, or `undefined` when the block is not a theme root. */
function themeOf(
  selectors: readonly string[],
  atRules: ReadonlyArray<{ name: string; prelude: string }>,
): string | undefined {
  for (const selector of selectors) {
    const named = THEME_SELECTOR.exec(selector)?.[1];
    if (named) return named;
  }
  if (!selectors.some((selector) => ROOT_SELECTOR.test(selector.trim()))) return undefined;
  return atRules.some((rule) => rule.name === "media" && DARK_QUERY.test(rule.prelude))
    ? "dark"
    : "light";
}

const VAR = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/;

/**
 * Colour tokens of CSS token files, per theme, with `var()` chains resolved (at most five hops,
 * falling back to the light theme). Values that do not resolve to a supported colour format are
 * dropped and reported, never guessed.
 */
export function tokensFromStyles(
  analyses: readonly FileAnalysis[],
  graph: PairGraph,
): { data: TokensData | undefined; notEvaluated: string[] } {
  const raw = new Map<string, Map<string, string>>();
  let firstPath: string | undefined;
  for (const analysis of analyses)
    for (const piece of analysis.styles)
      for (const rule of piece.scan.rules) {
        const theme = themeOf(rule.selectors, rule.atRules);
        if (!theme) continue;
        for (const declaration of rule.declarations) {
          if (!declaration.isCustomProperty) continue;
          firstPath ??= analysis.path;
          const map = raw.get(theme) ?? new Map<string, string>();
          map.set(declaration.property, declaration.value.trim());
          raw.set(theme, map);
        }
      }
  const resolve = (name: string, theme: string, depth = 0): string | undefined => {
    const value =
      raw.get(theme)?.get(name) ?? (theme === "light" ? undefined : raw.get("light")?.get(name));
    if (value === undefined || depth > 5) return undefined;
    const reference = VAR.exec(value);
    if (reference) {
      return (
        resolve(reference[1] as string, theme, depth + 1) ??
        (reference[2] !== undefined ? reference[2].trim() : undefined)
      );
    }
    return value;
  };
  const values: Record<string, Record<string, string>> = {};
  // A themed block inherits whatever it does not override from the light (root) declarations.
  for (const [theme, map] of raw)
    for (const name of new Set([
      ...map.keys(),
      ...(theme === "light" ? [] : (raw.get("light")?.keys() ?? [])),
    ])) {
      const resolved = resolve(name, theme);
      if (resolved !== undefined && parseColor(resolved)) {
        values[name] ??= {};
        (values[name] as Record<string, string>)[theme] = resolved;
      }
    }
  if (!firstPath) return { data: undefined, notEvaluated: [] };
  const pairs: RequiredPair[] = [];
  const notEvaluated: string[] = [];
  for (const edge of expandPairGraph(graph)) {
    const fg = `${graph.namespace}${edge.fg}`;
    const bg = `${graph.namespace}${edge.bg}`;
    const shared = Object.keys(values[fg] ?? {}).filter(
      (theme) => values[bg]?.[theme] !== undefined,
    );
    if (shared.length > 0) pairs.push({ fg, bg, kind: edge.kind });
    else {
      const missing = [fg, bg].filter((name) => !values[name]);
      notEvaluated.push(
        `${fg} on ${bg}: ${missing.length > 0 ? `${missing.join(" and ")} has no supported colour value` : "the tokens share no theme"}`,
      );
    }
  }
  return { data: { path: firstPath, values, pairs }, notEvaluated };
}

/** Pairs of a tokens file, or the default graph restricted to tokens the file defines. */
export function withDefaultPairs(
  path: string,
  values: Record<string, Record<string, string>>,
  pairs: RequiredPair[] | undefined,
  graph: PairGraph,
): { data: TokensData; notEvaluated: string[] } {
  if (pairs) return { data: { path, values, pairs }, notEvaluated: [] };
  const defaults: RequiredPair[] = [];
  const notEvaluated: string[] = [];
  for (const edge of expandPairGraph(graph)) {
    const fg = `${graph.namespace}${edge.fg}`;
    const bg = `${graph.namespace}${edge.bg}`;
    if (values[fg] && values[bg]) defaults.push({ fg, bg, kind: edge.kind });
    else notEvaluated.push(`${fg} on ${bg}: a token is not defined`);
  }
  return { data: { path, values, pairs: defaults }, notEvaluated };
}

/** Rows for the pair table: the same contrast math as the rule engine, with the ratios kept. */
export function pairRows(
  data: TokensData,
  source: string,
  target: "AA" | "AAA",
  margin = 0,
): PairRow[] {
  const rows: PairRow[] = [];
  for (const pair of data.pairs) {
    const foreground = data.values[pair.fg];
    const background = data.values[pair.bg];
    if (!foreground || !background) continue;
    for (const theme of Object.keys(foreground).sort()) {
      const bgValue = background[theme];
      if (bgValue === undefined) continue;
      const result = evaluateContrast({
        fg: foreground[theme] as string,
        bg: bgValue,
        kind: pair.kind,
        target,
        margin,
      });
      rows.push({
        source,
        theme,
        fg: pair.fg,
        bg: pair.bg,
        kind: pair.kind,
        ratio: result.ratio,
        minimum: result.minimum,
        status: result.status,
      });
    }
  }
  return rows;
}
