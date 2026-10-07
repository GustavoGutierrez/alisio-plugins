import { Poly } from "../math/poly.js";
import { Rational } from "../math/rational.js";
import type { StaticItem } from "./types.js";

/**
 * Evaluates a static bank item's own `check` against its stored answer. Returns `undefined`
 * when the check passes, or a human-readable reason when it fails (spec EVL-KB-007).
 */
export function evaluateItemCheck(item: StaticItem): string | undefined {
  const { kind, value } = item.check;
  if (kind === "rational-equal" || kind === "numeric-equal") {
    try {
      const actual = Rational.parse(item.answer.canonical);
      const expected = Rational.parse(value);
      return actual.equals(expected)
        ? undefined
        : `stored answer "${item.answer.canonical}" does not equal the declared value "${value}"`;
    } catch (error) {
      return error instanceof Error ? error.message : "check failed";
    }
  }
  if (kind === "poly-equal" || kind === "equivalent-polynomials") {
    try {
      const actual = Poly.parse(item.answer.canonical);
      const expected = Poly.parse(value);
      return actual.equals(expected)
        ? undefined
        : `stored answer "${item.answer.canonical}" is not equivalent to "${value}"`;
    } catch (error) {
      return error instanceof Error ? error.message : "check failed";
    }
  }
  return `unknown check kind "${kind}"`;
}
