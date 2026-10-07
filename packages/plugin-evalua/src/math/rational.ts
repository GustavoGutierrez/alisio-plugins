/** Exact rational arithmetic over `bigint`, always reduced with a positive denominator. */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("Cannot take the square root of a negative integer");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

function toBigInt(value: bigint | number, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new Error(`${field} must be an integer`);
}

export class Rational {
  static readonly zero = new Rational(0n, 1n);
  static readonly one = new Rational(1n, 1n);

  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new Error("A rational cannot have a zero denominator");
    const sign = d < 0n ? -1n : 1n;
    const numerator = n * sign;
    const denominator = d * sign;
    const divisor = gcd(numerator, denominator);
    this.n = numerator / divisor;
    this.d = denominator / divisor;
  }

  static of(n: bigint | number, d: bigint | number = 1n): Rational {
    return new Rational(toBigInt(n, "The numerator"), toBigInt(d, "The denominator"));
  }

  static from(value: Rational | bigint | number): Rational {
    return value instanceof Rational ? value : Rational.of(value);
  }

  private static readonly pattern = /^([+-]?\d+)(?:\/([+-]?\d+))?$/;

  static parse(text: string): Rational {
    const match = Rational.pattern.exec(text.trim());
    if (!match) throw new Error(`Not a rational number: ${text}`);
    const numerator = match[1];
    if (numerator === undefined) throw new Error(`Not a rational number: ${text}`);
    const denominator = match[2];
    return new Rational(BigInt(numerator), denominator === undefined ? 1n : BigInt(denominator));
  }

  add(other: Rational): Rational {
    return new Rational(this.n * other.d + other.n * this.d, this.d * other.d);
  }

  sub(other: Rational): Rational {
    return new Rational(this.n * other.d - other.n * this.d, this.d * other.d);
  }

  mul(other: Rational): Rational {
    return new Rational(this.n * other.n, this.d * other.d);
  }

  div(other: Rational): Rational {
    if (other.isZero()) throw new Error("Division by zero");
    return new Rational(this.n * other.d, this.d * other.n);
  }

  neg(): Rational {
    return new Rational(-this.n, this.d);
  }

  abs(): Rational {
    return this.n < 0n ? this.neg() : this;
  }

  inv(): Rational {
    if (this.isZero()) throw new Error("Cannot invert zero");
    return new Rational(this.d, this.n);
  }

  pow(exponent: number): Rational {
    if (!Number.isInteger(exponent) || exponent < 0) {
      throw new Error("Rational power must be a non-negative integer");
    }
    let result = Rational.one;
    let base: Rational = this;
    let remaining = exponent;
    while (remaining > 0) {
      if (remaining % 2 === 1) result = result.mul(base);
      remaining = Math.floor(remaining / 2);
      if (remaining > 0) base = base.mul(base);
    }
    return result;
  }

  compare(other: Rational): -1 | 0 | 1 {
    const left = this.n * other.d;
    const right = other.n * this.d;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  equals(other: Rational): boolean {
    return this.n === other.n && this.d === other.d;
  }

  isZero(): boolean {
    return this.n === 0n;
  }

  isInteger(): boolean {
    return this.d === 1n;
  }

  isOne(): boolean {
    return this.n === 1n && this.d === 1n;
  }

  sign(): -1 | 0 | 1 {
    if (this.n < 0n) return -1;
    if (this.n > 0n) return 1;
    return 0;
  }

  toBigInt(): bigint {
    if (!this.isInteger()) throw new Error(`${this.toString()} is not an integer`);
    return this.n;
  }

  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  /** The exact square root when numerator and denominator are perfect squares. */
  sqrtExact(): Rational | undefined {
    if (this.n < 0n) return undefined;
    const rootN = isqrt(this.n);
    const rootD = isqrt(this.d);
    if (rootN * rootN !== this.n || rootD * rootD !== this.d) return undefined;
    return new Rational(rootN, rootD);
  }

  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
}
