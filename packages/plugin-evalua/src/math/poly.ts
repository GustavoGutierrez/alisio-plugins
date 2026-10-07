import { latexPoly } from "./latex.js";
import { Rational } from "./rational.js";

export interface PolyTerm {
  /** Canonical monomial key, e.g. `x^2*y`; empty for the constant term. */
  monomial: string;
  coefficient: Rational;
}

function monomialOf(vars: Record<string, number>): string {
  return Object.keys(vars)
    .filter((name) => (vars[name] ?? 0) > 0)
    .sort()
    .map((name) => {
      const exponent = vars[name] ?? 0;
      return exponent === 1 ? name : `${name}^${exponent}`;
    })
    .join("*");
}

function degreeOf(monomial: string): number {
  if (monomial === "") return 0;
  let total = 0;
  for (const factor of monomial.split("*")) {
    const [, exponent] = factor.split("^");
    total += exponent === undefined ? 1 : Number(exponent);
  }
  return total;
}

function multiplyMonomials(left: string, right: string): string {
  const vars: Record<string, number> = {};
  for (const monomial of [left, right]) {
    if (monomial === "") continue;
    for (const factor of monomial.split("*")) {
      const [name, exponent] = factor.split("^");
      if (name === undefined) continue;
      vars[name] = (vars[name] ?? 0) + (exponent === undefined ? 1 : Number(exponent));
    }
  }
  return monomialOf(vars);
}

class PolyParser {
  private position = 0;

  constructor(private readonly text: string) {}

  private skip(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position] ?? "")) {
      this.position += 1;
    }
  }

  private peek(): string | undefined {
    return this.text[this.position];
  }

  parse(): Poly {
    const value = this.expression();
    this.skip();
    if (this.position < this.text.length) {
      throw new Error(`Unexpected "${this.text[this.position]}" in polynomial`);
    }
    return value;
  }

  private expression(): Poly {
    let value = this.term();
    for (;;) {
      this.skip();
      const char = this.peek();
      if (char === "+") {
        this.position += 1;
        value = value.add(this.term());
      } else if (char === "-") {
        this.position += 1;
        value = value.sub(this.term());
      } else {
        return value;
      }
    }
  }

  private term(): Poly {
    let value = this.factor();
    for (;;) {
      this.skip();
      const char = this.peek();
      if (char === "*") {
        this.position += 1;
        value = value.mul(this.factor());
      } else if (char !== undefined && /[0-9A-Za-z(]/.test(char)) {
        value = value.mul(this.factor());
      } else {
        return value;
      }
    }
  }

  private factor(): Poly {
    this.skip();
    const char = this.peek();
    if (char === "-") {
      this.position += 1;
      return this.power().neg();
    }
    if (char === "+") {
      this.position += 1;
      return this.power();
    }
    return this.power();
  }

  private power(): Poly {
    const base = this.atom();
    this.skip();
    if (this.peek() === "^") {
      this.position += 1;
      this.skip();
      const start = this.position;
      while (this.position < this.text.length && /\d/.test(this.text[this.position] ?? "")) {
        this.position += 1;
      }
      if (this.position === start) throw new Error("Missing exponent in polynomial");
      return base.pow(Number(this.text.slice(start, this.position)));
    }
    return base;
  }

  private atom(): Poly {
    this.skip();
    const char = this.peek();
    if (char === "(") {
      this.position += 1;
      const value = this.expression();
      this.skip();
      if (this.peek() !== ")") throw new Error("Unbalanced parenthesis in polynomial");
      this.position += 1;
      return value;
    }
    const numberStart = this.position;
    while (this.position < this.text.length && /\d/.test(this.text[this.position] ?? "")) {
      this.position += 1;
    }
    if (this.position > numberStart) {
      let text = this.text.slice(numberStart, this.position);
      this.skip();
      if (this.peek() === "/") {
        const save = this.position;
        this.position += 1;
        this.skip();
        const denominatorStart = this.position;
        while (this.position < this.text.length && /\d/.test(this.text[this.position] ?? "")) {
          this.position += 1;
        }
        if (this.position > denominatorStart) {
          text = `${text}/${this.text.slice(denominatorStart, this.position)}`;
        } else {
          this.position = save;
        }
      }
      return Poly.constant(Rational.parse(text));
    }
    const nameStart = this.position;
    while (this.position < this.text.length && /[A-Za-z]/.test(this.text[this.position] ?? "")) {
      this.position += 1;
    }
    if (this.position === nameStart) {
      throw new Error(`Unexpected "${char ?? "end of input"}" in polynomial`);
    }
    return Poly.variable(this.text.slice(nameStart, this.position));
  }
}

export class Poly {
  static readonly zero = new Poly(new Map());
  static readonly one = new Poly(new Map([["", Rational.one]]));

  private constructor(private readonly terms: Map<string, Rational>) {}

  private static fromTerms(terms: Map<string, Rational>): Poly {
    const cleaned = new Map<string, Rational>();
    for (const [monomial, coefficient] of terms) {
      if (!coefficient.isZero()) cleaned.set(monomial, coefficient);
    }
    return new Poly(cleaned);
  }

  static constant(value: Rational): Poly {
    return value.isZero() ? Poly.zero : new Poly(new Map([["", value]]));
  }

  static variable(name: string): Poly {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(`Invalid variable name in polynomial: ${name}`);
    }
    return new Poly(new Map([[name, Rational.one]]));
  }

  static parse(text: string): Poly {
    return new PolyParser(text).parse();
  }

  add(other: Poly): Poly {
    const merged = new Map(this.terms);
    for (const [monomial, coefficient] of other.terms) {
      const current = merged.get(monomial);
      merged.set(monomial, current === undefined ? coefficient : current.add(coefficient));
    }
    return Poly.fromTerms(merged);
  }

  sub(other: Poly): Poly {
    return this.add(other.neg());
  }

  mul(other: Poly): Poly {
    const product = new Map<string, Rational>();
    for (const [leftMonomial, leftCoefficient] of this.terms) {
      for (const [rightMonomial, rightCoefficient] of other.terms) {
        const monomial = multiplyMonomials(leftMonomial, rightMonomial);
        const current = product.get(monomial);
        const coefficient = leftCoefficient.mul(rightCoefficient);
        product.set(monomial, current === undefined ? coefficient : current.add(coefficient));
      }
    }
    return Poly.fromTerms(product);
  }

  scalar(value: Rational): Poly {
    return this.mul(Poly.constant(value));
  }

  neg(): Poly {
    return this.scalar(Rational.of(-1));
  }

  pow(exponent: number): Poly {
    if (!Number.isInteger(exponent) || exponent < 0) {
      throw new Error("Polynomial power must be a non-negative integer");
    }
    let result = Poly.one;
    let base: Poly = this;
    let remaining = exponent;
    while (remaining > 0) {
      if (remaining % 2 === 1) result = result.mul(base);
      remaining = Math.floor(remaining / 2);
      if (remaining > 0) base = base.mul(base);
    }
    return result;
  }

  evaluate(values: Record<string, Rational>): Rational {
    let total = Rational.zero;
    for (const [monomial, coefficient] of this.terms) {
      let term = coefficient;
      if (monomial !== "") {
        for (const factor of monomial.split("*")) {
          const [name, exponent] = factor.split("^");
          if (name === undefined) continue;
          const value = values[name];
          if (value === undefined) throw new Error(`Missing value for variable "${name}"`);
          term = term.mul(value.pow(exponent === undefined ? 1 : Number(exponent)));
        }
      }
      total = total.add(term);
    }
    return total;
  }

  equals(other: Poly): boolean {
    if (this.terms.size !== other.terms.size) return false;
    for (const [monomial, coefficient] of this.terms) {
      const otherCoefficient = other.terms.get(monomial);
      if (otherCoefficient === undefined || !coefficient.equals(otherCoefficient)) return false;
    }
    return true;
  }

  isZero(): boolean {
    return this.terms.size === 0;
  }

  degree(): number {
    let highest = -1;
    for (const monomial of this.terms.keys()) {
      highest = Math.max(highest, degreeOf(monomial));
    }
    return highest;
  }

  termCount(): number {
    return this.terms.size;
  }

  /** Terms in canonical order: descending total degree, then monomial ascending. */
  termList(): PolyTerm[] {
    return [...this.terms.entries()]
      .map(([monomial, coefficient]) => ({ monomial, coefficient }))
      .sort(
        (a, b) =>
          degreeOf(b.monomial) - degreeOf(a.monomial) || a.monomial.localeCompare(b.monomial),
      );
  }

  toString(): string {
    if (this.isZero()) return "0";
    let out = "";
    this.termList().forEach((term, index) => {
      const negative = term.coefficient.sign() < 0;
      const magnitude = term.coefficient.abs();
      if (index === 0) out += negative ? "-" : "";
      else out += negative ? " - " : " + ";
      if (term.monomial === "") {
        out += magnitude.toString();
      } else if (magnitude.equals(Rational.one)) {
        out += term.monomial;
      } else {
        out += `${magnitude.toString()}*${term.monomial}`;
      }
    });
    return out;
  }

  toLatex(options: { top?: boolean } = {}): string {
    return latexPoly(this, options);
  }
}

export function variable(name: string): Poly {
  return Poly.variable(name);
}

export function polyFromRational(value: Rational): Poly {
  return Poly.constant(value);
}
