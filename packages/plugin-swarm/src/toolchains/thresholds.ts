import type { Thresholds } from "../domain/pack.js";

export interface FunctionMetric {
  file: string;
  name: string;
  /** Cyclomatic complexity, at least 1. */
  complexity: number;
  /** Line/branch coverage as a fraction from 0 to 1. */
  coverage: number;
}

export interface Measurements {
  /** Overall coverage in percent. */
  coverage?: number;
  /** Mutation score in percent on changed code. */
  mutation?: number;
  functions?: FunctionMetric[];
}

export interface ThresholdFailure {
  gate: "coverage" | "complexity" | "crap" | "mutation";
  message: string;
}

export interface ThresholdResult {
  passed: boolean;
  failures: ThresholdFailure[];
}

/** The published CRAP formula: `CC^2 * (1 - coverage)^3 + CC`. */
export function crap(complexity: number, coverage: number): number {
  if (!Number.isFinite(complexity) || complexity < 1) {
    throw new Error("Invalid complexity: expected a number of at least 1");
  }
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
    throw new Error("Invalid coverage: expected a fraction from 0 to 1");
  }
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

const round = (value: number): string => (Math.round(value * 100) / 100).toString();

/** Compare measurements with pack thresholds (inclusive boundaries). Unmeasured metrics are skipped. */
export function evaluateThresholds(
  thresholds: Thresholds,
  measured: Measurements,
): ThresholdResult {
  const failures: ThresholdFailure[] = [];
  if (measured.coverage !== undefined && measured.coverage < thresholds.coverage) {
    failures.push({
      gate: "coverage",
      message: `Coverage ${round(measured.coverage)}% is below ${thresholds.coverage}%`,
    });
  }
  if (measured.mutation !== undefined && measured.mutation < thresholds.mutation) {
    failures.push({
      gate: "mutation",
      message: `Mutation score ${round(measured.mutation)}% is below ${thresholds.mutation}%`,
    });
  }
  for (const fn of measured.functions ?? []) {
    const where = `${fn.file}#${fn.name}`;
    if (fn.complexity > thresholds.complexity) {
      failures.push({
        gate: "complexity",
        message: `${where} has complexity ${fn.complexity} (limit ${thresholds.complexity})`,
      });
    }
    const score = crap(fn.complexity, fn.coverage);
    if (score > thresholds.crap) {
      failures.push({
        gate: "crap",
        message: `${where} has CRAP ${round(score)} (limit ${thresholds.crap})`,
      });
    }
  }
  return { passed: failures.length === 0, failures };
}
