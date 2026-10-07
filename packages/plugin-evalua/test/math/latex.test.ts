import { describe, expect, it } from "vitest";
import { latexPoly, latexRational } from "../../src/math/latex.js";
import { Poly } from "../../src/math/poly.js";
import { Rational } from "../../src/math/rational.js";

const r = (n: number, d = 1) => Rational.of(n, d);

describe("latexRational", () => {
  it("renders integers, fractions and signs without ambiguity", () => {
    expect(latexRational(r(3))).toBe("3");
    expect(latexRational(r(-3))).toBe("-3");
    expect(latexRational(r(0))).toBe("0");
    expect(latexRational(r(19, 12))).toBe("\\dfrac{19}{12}");
    expect(latexRational(r(-19, 12))).toBe("-\\dfrac{19}{12}");
    expect(latexRational(Rational.parse("4/-6"))).toBe("-\\dfrac{2}{3}");
  });
});

describe("latexPoly", () => {
  it("orders terms by degree and uses minimal parentheses", () => {
    expect(latexPoly(Poly.parse("1 - 2x + x^2"))).toBe("x^{2} - 2x + 1");
    expect(latexPoly(Poly.parse("-x^2 - 1"))).toBe("-x^{2} - 1");
    expect(latexPoly(Poly.parse("x + 1"), { top: false })).toBe("\\left(x + 1\\right)");
    expect(latexPoly(Poly.parse("x + 1"))).toBe("x + 1");
  });

  it("renders coefficients and monomials without ambiguous signs", () => {
    expect(latexPoly(Poly.parse("3/2*x"))).toBe("\\dfrac{3}{2}x");
    expect(latexPoly(Poly.parse("-x"))).toBe("-x");
    expect(latexPoly(Poly.parse("2*x*y"))).toBe("2xy");
    expect(latexPoly(Poly.parse("x^3*y"))).toBe("x^{3}y");
    expect(latexPoly(Poly.parse("x - 3"))).toBe("x - 3");
    expect(latexPoly(Poly.zero)).toBe("0");
  });
});
