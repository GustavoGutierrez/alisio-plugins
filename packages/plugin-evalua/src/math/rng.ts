import { createHash } from "node:crypto";

/** A deterministic, seeded random source (xoshiro128**). */
export interface Rng {
  nextUint32(): number;
  nextFloat(): number;
  /** An integer in `[min, max]`, inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

const TWO_32 = 2 ** 32;

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** Four 32-bit words derived from any parts with SHA-256 (never all zero). */
export function deriveSeed(...parts: readonly (string | number)[]): Uint32Array {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  const words = new Uint32Array(4);
  for (let index = 0; index < 4; index += 1) {
    words[index] = digest.readUInt32LE(index * 4);
  }
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    words[0] = 1;
  }
  return words;
}

/** Seed for an item slot: exam id + variant + role (spec AD-5). */
export function examSeed(examId: string, variant: string, role: string): Uint32Array {
  return deriveSeed(examId, variant, role);
}

export function createRng(seed: string | readonly number[] | Uint32Array): Rng {
  let state: Uint32Array;
  if (typeof seed === "string") {
    state = deriveSeed(seed);
  } else {
    if (seed.length !== 4) throw new Error("A numeric random seed needs exactly four 32-bit words");
    state = Uint32Array.from(seed.map((word) => word >>> 0));
    if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) state[0] = 1;
  }
  let s0 = state[0] ?? 1;
  let s1 = state[1] ?? 0;
  let s2 = state[2] ?? 0;
  let s3 = state[3] ?? 0;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl32(s3, 11);
    return result;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Invalid integer range: ${min}..${max}`);
    }
    const range = max - min + 1;
    if (range > TWO_32) throw new Error(`Integer range too wide: ${min}..${max}`);
    const limit = TWO_32 - (TWO_32 % range);
    let value = nextUint32();
    while (value >= limit) value = nextUint32();
    return min + (value % range);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("Cannot pick from an empty list");
    const chosen = items[int(0, items.length - 1)];
    if (chosen === undefined) throw new Error("Cannot pick from an empty list");
    return chosen;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = int(0, index);
      const current = copy[index];
      const other = copy[swap];
      if (current === undefined || other === undefined) continue;
      copy[index] = other;
      copy[swap] = current;
    }
    return copy;
  };

  return {
    nextUint32,
    nextFloat: () => nextUint32() / TWO_32,
    int,
    pick,
    shuffle,
  };
}
