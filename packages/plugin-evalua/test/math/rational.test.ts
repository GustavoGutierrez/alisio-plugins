import { describe, expect, it } from "vitest";
import { Rational } from "../../src/math/rational.js";

const r = (n: number, d = 1) => Rational.of(n, d);

describe("Rational construction and canonical form", () => {
  it("reduces to lowest terms with a positive denominator", () => {
    expect(r(4, -6).toString()).toBe("-2/3");
    expect(r(-4, -6).toString()).toBe("2/3");
    expect(r(6, 3).toString()).toBe("2");
    expect(Rational.zero.toString()).toBe("0");
    expect(Rational.one.toString()).toBe("1");
  });

  it("parses integers, fractions and signs", () => {
    expect(Rational.parse("19/12").toString()).toBe("19/12");
    expect(Rational.parse("-3").toString()).toBe("-3");
    expect(Rational.parse("4/-6").toString()).toBe("-2/3");
    expect(Rational.parse("  5 ").toString()).toBe("5");
  });

  it("rejects malformed text and a zero denominator", () => {
    expect(() => Rational.parse("1.5")).toThrow(/rational/i);
    expect(() => Rational.parse("2/0")).toThrow(/denominator/i);
    expect(() => Rational.parse("x")).toThrow(/rational/i);
    expect(() => r(1.5)).toThrow(/integer/i);
  });
});

describe("Rational arithmetic", () => {
  it("adds, subtracts, multiplies and divides exactly", () => {
    expect(r(3, 4).add(r(5, 6)).toString()).toBe("19/12");
    expect(r(1, 2).sub(r(1, 3)).toString()).toBe("1/6");
    expect(r(2, 3).mul(r(9, 4)).toString()).toBe("3/2");
    expect(r(2, 3).div(r(4, 9)).toString()).toBe("3/2");
    expect(r(3).neg().toString()).toBe("-3");
    expect(r(-7, 2).abs().toString()).toBe("7/2");
    expect(r(0).inv).toBeTypeOf("function");
  });

  it("throws on division by zero", () => {
    expect(() => r(1).div(Rational.zero)).toThrow(/zero/i);
  });

  it("is immutable: operations return new values", () => {
    const a = r(1, 2);
    const b = a.add(r(1, 2));
    expect(a.toString()).toBe("1/2");
    expect(b.toString()).toBe("1");
  });

  it("obeys additive and multiplicative inverses", () => {
    for (const value of [r(3, 7), r(-5, 2), r(0), r(11)]) {
      expect(value.add(value.neg()).isZero()).toBe(true);
      if (!value.isZero()) expect(value.mul(value.inv()).toString()).toBe("1");
    }
  });
});

describe("Rational comparison and predicates", () => {
  it("compares by value", () => {
    expect(r(1, 2).compare(r(2, 4))).toBe(0);
    expect(r(1, 3).compare(r(1, 2))).toBe(-1);
    expect(r(3, 2).compare(r(1))).toBe(1);
    expect(r(1, 2).equals(r(2, 4))).toBe(true);
    expect(r(1, 2).equals(r(1, 3))).toBe(false);
  });

  it("reports zeros and integers", () => {
    expect(r(0).isZero()).toBe(true);
    expect(r(0, 5).isZero()).toBe(true);
    expect(r(4, 2).isInteger()).toBe(true);
    expect(r(1, 2).isInteger()).toBe(false);
    expect(r(4, 2).toBigInt()).toBe(2n);
    expect(() => r(1, 2).toBigInt()).toThrow(/integer/i);
    expect(r(-3).sign()).toBe(-1);
    expect(r(0).sign()).toBe(0);
    expect(r(5, 2).sign()).toBe(1);
  });

  it("computes exact square roots only for perfect squares", () => {
    expect(r(9, 4).sqrtExact()?.toString()).toBe("3/2");
    expect(r(2).sqrtExact()).toBeUndefined();
    expect(r(-4).sqrtExact()).toBeUndefined();
  });
});
