import type { FunctionMetric } from "../toolchains/thresholds.js";

/** Output parsers for the node-ts toolchain. Garbage input throws: it is never guessed at. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unparseable ${label} output: expected JSON`);
  }
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const IGNORED_DIR = /(^|\/)(node_modules|dist|build|coverage|reports|\.worktrees|\.alisio)\//;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

export const isSourceFile = (path: string): boolean =>
  SOURCE_FILE.test(path) && !path.endsWith(".d.ts") && !isTestFile(path) && !IGNORED_DIR.test(path);

/** Make an absolute path (as tools print it) relative to the working directory. */
export function relativeTo(root: string, path: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

export interface CoverageSummary {
  /** Overall line coverage in percent. */
  coverage: number;
  /** Line coverage per file as a fraction from 0 to 1, keyed by path relative to the root. */
  files: Map<string, number>;
}

export function parseIstanbulSummary(text: string, root: string): CoverageSummary {
  const data = json(text, "coverage summary");
  const total = isRecord(data) && isRecord(data.total) ? data.total : undefined;
  const lines = total && isRecord(total.lines) ? total.lines : undefined;
  const pct = lines?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error("The coverage summary has no total line coverage");
  }
  const files = new Map<string, number>();
  for (const [file, entry] of Object.entries(data as Record<string, unknown>)) {
    if (file === "total" || !isRecord(entry) || !isRecord(entry.lines)) continue;
    const filePct = entry.lines.pct;
    if (typeof filePct === "number" && Number.isFinite(filePct)) {
      files.set(relativeTo(root, file), Math.min(1, Math.max(0, filePct / 100)));
    }
  }
  return { coverage: pct, files };
}

export interface ComplexityEntry {
  file: string;
  name: string;
  complexity: number;
}

export function parseEslintComplexity(text: string, root: string): ComplexityEntry[] {
  const data = json(text, "ESLint");
  if (!Array.isArray(data)) throw new Error("ESLint output is not an array of file results");
  const out: ComplexityEntry[] = [];
  for (const file of data) {
    if (!isRecord(file) || typeof file.filePath !== "string" || !Array.isArray(file.messages)) {
      continue;
    }
    const path = relativeTo(root, file.filePath);
    if (!isSourceFile(path)) continue;
    for (const message of file.messages) {
      if (!isRecord(message) || message.ruleId !== "complexity") continue;
      const match = /^(.*?) has a complexity of (\d+)/.exec(String(message.message));
      if (!match) continue;
      const named = /'([^']+)'/.exec(match[1] as string);
      out.push({
        file: path,
        name: named?.[1] ?? `anonymous:${String(message.line ?? 0)}`,
        complexity: Number(match[2]),
      });
    }
  }
  return out;
}

export interface MutationSummary {
  /** Percent, or `undefined` when no mutant was in scope. */
  score: number | undefined;
  detected: number;
  undetected: number;
  survivors: string[];
}

const MAX_SURVIVORS = 20;

/**
 * Stryker-style mutation report (mutation-testing-elements). Killed and timed-out mutants are
 * detected; survived and uncovered ones are not; the rest are ignored. `changed` makes the score
 * differential: only those files count.
 */
export function parseStrykerReport(text: string, changed?: string[]): MutationSummary {
  const data = json(text, "mutation report");
  if (!isRecord(data) || !isRecord(data.files)) {
    throw new Error("The mutation report has no files section");
  }
  let detected = 0;
  let undetected = 0;
  const survivors: string[] = [];
  for (const [file, entry] of Object.entries(data.files)) {
    if (changed && !changed.includes(file)) continue;
    if (!isRecord(entry) || !Array.isArray(entry.mutants)) continue;
    for (const mutant of entry.mutants) {
      if (!isRecord(mutant)) continue;
      if (mutant.status === "Killed" || mutant.status === "Timeout") detected += 1;
      else if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
        undetected += 1;
        if (survivors.length < MAX_SURVIVORS) {
          const start =
            isRecord(mutant.location) && isRecord(mutant.location.start)
              ? mutant.location.start
              : {};
          survivors.push(
            `${file}:${String(start.line ?? "?")} ${String(mutant.mutatorName ?? "mutant")} ${String(mutant.status).toLowerCase()}`,
          );
        }
      }
    }
  }
  const total = detected + undetected;
  return {
    score: total === 0 ? undefined : (detected / total) * 100,
    detected,
    undetected,
    survivors,
  };
}

/** Join complexity entries with per-file coverage into the metrics CRAP is computed from. */
export function toFunctionMetrics(
  entries: ComplexityEntry[],
  coverage: Map<string, number>,
): FunctionMetric[] {
  return entries.map((entry) => ({
    file: entry.file,
    name: entry.name,
    complexity: Math.max(1, entry.complexity),
    coverage: coverage.get(entry.file) ?? 0,
  }));
}
