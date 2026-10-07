import { describe, expect, it } from "vitest";
import { createRng, deriveSeed, examSeed } from "../../src/math/rng.js";

describe("deriveSeed", () => {
  it("returns four 32-bit words and is stable", () => {
    const a = deriveSeed("e01", "A", "generator");
    const b = deriveSeed("e01", "A", "generator");
    expect(a).toHaveLength(4);
    expect([...a]).toEqual([...b]);
    for (const word of a) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThan(2 ** 32);
    }
  });

  it("changes with any part, including the separator", () => {
    expect([...deriveSeed("ab", "c")]).not.toEqual([...deriveSeed("a", "bc")]);
    expect([...examSeed("e01", "A", "generator")]).not.toEqual([
      ...examSeed("e01", "B", "generator"),
    ]);
    expect([...deriveSeed("x")]).not.toEqual([...deriveSeed("y")]);
  });
});

describe("createRng (xoshiro128**)", () => {
  it("is deterministic for the same seed and different for another", () => {
    const first = createRng("same");
    const second = createRng("same");
    const third = createRng("other");
    const a = Array.from({ length: 5 }, () => first.nextUint32());
    const b = Array.from({ length: 5 }, () => second.nextUint32());
    const c = Array.from({ length: 5 }, () => third.nextUint32());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const value of a) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });

  it("keeps int inside the inclusive range and deterministic", () => {
    const rng = createRng("range");
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(-3, 3);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }
    expect(seen.size).toBe(7);
    expect(() => rng.int(5, 1)).toThrow();
  });

  it("picks an element and shuffles as a permutation", () => {
    const rng = createRng("pick");
    const items = ["a", "b", "c", "d"];
    expect(items).toContain(rng.pick(items));
    const shuffled = rng.shuffle(items);
    expect(shuffled).toHaveLength(items.length);
    expect([...shuffled].sort()).toEqual([...items].sort());
    expect(items).toEqual(["a", "b", "c", "d"]);
    const repeat = createRng("pick").shuffle(items);
    expect(repeat).toEqual(createRng("pick").shuffle(items));
    expect(() => rng.pick([])).toThrow();
  });

  it("produces floats in [0, 1)", () => {
    const rng = createRng("float");
    for (let i = 0; i < 100; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("accepts an explicit four-word seed", () => {
    const rng = createRng([1, 2, 3, 4]);
    expect(rng.nextUint32()).toBeTypeOf("number");
    expect(() => createRng([1, 2, 3])).toThrow();
  });
});
