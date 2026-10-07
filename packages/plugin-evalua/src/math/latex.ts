import type { Poly, PolyTerm } from "./poly.js";
import type { Rational } from "./rational.js";

/** A rational as LaTeX: an integer, or `\dfrac{n}{d}` with the sign outside. */
export function latexRational(value: Rational): string {
  const sign = value.n < 0n ? "-" : "";
  const numerator = value.n < 0n ? -value.n : value.n;
  const body = value.d === 1n ? `${numerator}` : `\\dfrac{${numerator}}{${value.d}}`;
  return `${sign}${body}`;
}

function latexMonomial(monomial: string): string {
  if (monomial === "") return "";
  return monomial
    .split("*")
    .map((factor) => {
      const [name, exponent] = factor.split("^");
      if (name === undefined) return "";
      return exponent === undefined || exponent === "1" ? name : `${name}^{${exponent}}`;
    })
    .join("");
}

function latexTerm(term: PolyTerm): { negative: boolean; body: string } {
  const negative = term.coefficient.sign() < 0;
  const magnitude = term.coefficient.abs();
  const variables = latexMonomial(term.monomial);
  if (variables === "") return { negative, body: latexRational(magnitude) };
  if (magnitude.isOne()) return { negative, body: variables };
  const coefficient = magnitude.isInteger() ? `${magnitude.n}` : latexRational(magnitude);
  return { negative, body: `${coefficient}${variables}` };
}

/**
 * A polynomial as LaTeX with minimal parentheses: a bare sum at the top level, or a
 * `\left(...\right)` group when it is embedded (`top: false`).
 */
export function latexPoly(value: Poly, options: { top?: boolean } = {}): string {
  if (value.isZero()) return "0";
  const terms = value.termList();
  const parts = terms.map((term, index) => {
    const { negative, body } = latexTerm(term);
    if (index === 0) return negative ? `-${body}` : body;
    return negative ? ` - ${body}` : ` + ${body}`;
  });
  const joined = parts.join("");
  return options.top === false && terms.length > 1 ? `\\left(${joined}\\right)` : joined;
}
