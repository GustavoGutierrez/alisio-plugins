import { describe, expect, it } from "vitest";
import { Rational } from "../../src/math/rational.js";
import { solveLinear, solveQuadratic } from "../../src/math/solvers.js";

const r = (n: number, d = 1) => Rational.of(n, d);

describe("solveLinear", () => {
  it("solves a x + b = 0 over the rationals", () => {
    expect(solveLinear(r(2), r(-4))).toEqual({ kind: "one", root: r(2) });
    expect(solveLinear(r(3, 4), r(-1, 2))).toEqual({ kind: "one", root: r(2, 3) });
    expect(solveLinear(r(-5), r(10))).toEqual({ kind: "one", root: r(2) });
  });

  it("classifies degenerate equations", () => {
    expect(solveLinear(Rational.zero, Rational.zero)).toEqual({ kind: "infinite" });
    expect(solveLinear(Rational.zero, r(3))).toEqual({ kind: "none" });
  });

  it("verifies by substitution", () => {
    for (const [a, b] of [
      [r(7), r(-3)],
      [r(1, 2), r(5)],
      [r(-4, 3), r(2, 5)],
    ] as const) {
      const solution = solveLinear(a, b);
      if (solution.kind !== "one") throw new Error("expected one root");
      expect(a.mul(solution.root).add(b).isZero()).toBe(true);
    }
  });
});

describe("solveQuadratic", () => {
  it("finds two rational roots in ascending order", () => {
    expect(solveQuadratic(r(1), r(-3), r(2))).toEqual({ kind: "two", roots: [r(1), r(2)] });
    expect(solveQuadratic(r(2), r(1), r(-1))).toEqual({ kind: "two", roots: [r(-1), r(1, 2)] });
  });

  it("finds the single double root", () => {
    expect(solveQuadratic(r(1), r(-2), r(1))).toEqual({ kind: "one", root: r(1) });
  });

  it("classifies an irrational and a negative discriminant", () => {
    const irrational = solveQuadratic(r(1), Rational.zero, r(-2));
    expect(irrational).toEqual({ kind: "irrational", discriminant: r(8) });
    expect(solveQuadratic(r(1), Rational.zero, r(1))).toEqual({ kind: "none" });
  });

  it("verifies rational roots by substitution", () => {
    const a = r(3);
    const b = r(-5);
    const c = r(-2);
    const solution = solveQuadratic(a, b, c);
    if (solution.kind !== "two") throw new Error("expected two roots");
    for (const root of solution.roots) {
      const value = a.mul(root.pow(2)).add(b.mul(root)).add(c);
      expect(value.isZero()).toBe(true);
    }
  });

  it("requires a non-zero leading coefficient", () => {
    expect(() => solveQuadratic(Rational.zero, r(1), r(1))).toThrow(/leading/i);
  });
});
