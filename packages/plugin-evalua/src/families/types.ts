import type { LevelCalibration } from "../knowledge/types.js";
import type { Poly } from "../math/poly.js";
import type { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import type { ItemType, Level } from "../types.js";

/** A named distractor: `value` is the canonical answer, `display` the LaTeX shown. */
export interface DistractorOption {
  key: string;
  value: string;
  display: string;
  correct: boolean;
  /** Named misconception, `"none"` for the correct option. */
  error: string;
}

export interface ItemDraft {
  family: string;
  level: Level;
  type: ItemType;
  stem: string[];
  options: DistractorOption[];
  answer: { canonical: string; display: string };
  solution: string[];
  /** Literal numbers written in the problem, for the level calibration check. */
  numericValues: number[];
  /** Solution line count, for the level calibration check. */
  stepCount: number;
  /** Structured generator input, re-solved independently to prove the answer. */
  problem: Record<string, unknown>;
}

export interface FamilyContext {
  rng: Rng;
  level: Level;
  calibration: LevelCalibration;
  params?: Record<string, unknown>;
}

/** The canonical answer of a family: a rational, a polynomial, or a canonical text (e.g. `x<2`). */
export type CanonicalAnswer = Rational | Poly | string;

export interface Family {
  id: string;
  generate(context: FamilyContext): ItemDraft;
  /** Recomputes the canonical answer from `problem`, independently of `generate`. */
  solve(problem: Record<string, unknown>): CanonicalAnswer;
}
