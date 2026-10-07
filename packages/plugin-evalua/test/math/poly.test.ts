import { describe, expect, it } from "vitest";
import { Poly } from "../../src/math/poly.js";
import { Rational } from "../../src/math/rational.js";

const r = (n: number, d = 1) => Rational.of(n, d);

describe("Poly parsing and canonical form", () => {
  it("parses sums, products and powers", () => {
    expect(Poly.parse("x^2 - 2x + 1").equals(Poly.parse("x^2 - 2*x + 1"))).toBe(true);
    expect(Poly.parse("x^2 - 2x + 1").equals(Poly.parse("(x - 1)^2"))).toBe(true);
    expect(Poly.parse("2(x + 1)").equals(Poly.parse("2x + 2"))).toBe(true);
    expect(Poly.parse("(x + 1)(x - 1)").equals(Poly.parse("x^2 - 1"))).toBe(true);
    expect(
      Poly.parse("3/2*x*y").equals(
        Poly.constant(r(3, 2)).mul(Poly.variable("x")).mul(Poly.variable("y")),
      ),
    ).toBe(true);
  });

  it("combines like terms and drops zeros", () => {
    expect(Poly.parse("x + x").equals(Poly.parse("2x"))).toBe(true);
    expect(Poly.parse("x - x").isZero()).toBe(true);
    expect(Poly.parse("0").isZero()).toBe(true);
    expect(Poly.zero.isZero()).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(() => Poly.parse("x +")).toThrow(/polynomial/i);
    expect(() => Poly.parse("2x^")).toThrow(/polynomial/i);
    expect(() => Poly.parse("(x + 1")).toThrow(/polynomial/i);
  });
});

describe("Poly arithmetic", () => {
  it("adds, subtracts, multiplies and scales", () => {
    const x = Poly.variable("x");
    expect(x.add(Poly.one).equals(Poly.parse("x + 1"))).toBe(true);
    expect(x.sub(Poly.one).equals(Poly.parse("x - 1"))).toBe(true);
    expect(x.mul(x).equals(Poly.parse("x^2"))).toBe(true);
    expect(x.scalar(r(1, 2)).equals(Poly.parse("1/2*x"))).toBe(true);
    expect(x.neg().equals(Poly.parse("-x"))).toBe(true);
  });

  it("raises to a non-negative power", () => {
    const x = Poly.variable("x");
    expect(x.pow(0).equals(Poly.one)).toBe(true);
    expect(x.pow(3).equals(Poly.parse("x^3"))).toBe(true);
    expect(() => x.pow(-1)).toThrow(/power/i);
  });

  it("reports degree and term count", () => {
    expect(Poly.zero.degree()).toBe(-1);
    expect(Poly.one.degree()).toBe(0);
    expect(Poly.parse("x^2*y + x").degree()).toBe(3);
    expect(Poly.parse("x^2*y + x").termCount()).toBe(2);
  });
});

describe("Poly evaluation", () => {
  it("evaluates by substitution with exact rationals", () => {
    const value = Poly.parse("x^2 - 2x + 1").evaluate({ x: r(3) });
    expect(value.toString()).toBe("4");
    expect(
      Poly.parse("x*y + 1")
        .evaluate({ x: r(1, 2), y: r(4) })
        .toString(),
    ).toBe("3");
  });

  it("throws when a variable is missing", () => {
    expect(() => Poly.parse("x + 1").evaluate({ y: r(1) })).toThrow(/x/);
  });
});
