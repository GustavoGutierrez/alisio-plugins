import { latexPoly } from "../math/latex.js";
import type { Rng } from "../math/rng.js";
import { assembleOptions } from "./options.js";
import { polyOfX, polyValue, pooled } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function factorX(root: number): string {
  if (root === 0) return "x";
  return `\\left(x ${root < 0 ? "-" : "+"} ${Math.abs(root)}\\right)`;
}

/**
 * Every unordered pair of distinct, non-zero, non-opposite integer roots whose trinomial
 * coefficients (sum and product) stay inside the level's coefficient range. Roots reach
 * `bound` = the range's upper end clamped to 5..9, so each level offers dozens of distinct
 * trinomials (38 at the narrowest shipped range) instead of the 12 a fixed bound of 3 gave.
 */
export function factoringRootPairs(range: readonly [number, number]): Array<[number, number]> {
  const [low, high] = range;
  const bound = Math.max(5, Math.min(9, high));
  const pairs: Array<[number, number]> = [];
  for (let p = -bound; p <= bound; p += 1) {
    for (let q = p + 1; q <= bound; q += 1) {
      if (p === 0 || q === 0 || p + q === 0) continue;
      const b = p + q;
      const c = p * q;
      if (b < low || b > high || c < low || c > high) continue;
      pairs.push([p, q]);
    }
  }
  return pairs;
}

function rootPair(rng: Rng, range: readonly [number, number]): [number, number] {
  const pairs = factoringRootPairs(range);
  // A range too narrow for any valid pair still yields a well-formed item; verifyDraft rejects it.
  const [p, q] = pairs.length > 0 ? rng.pick(pairs) : ([1, 2] as [number, number]);
  return rng.int(0, 1) === 0 ? [p, q] : [q, p];
}

export const factoring: Family = {
  id: "factoring",
  solve(problem: Record<string, unknown>) {
    const p = Number(problem.p);
    const q = Number(problem.q);
    return polyOfX([p * q, p + q, 1]);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const [p, q] = rootPair(rng, calibration.coefficientRange);
    const b = p + q;
    const c = p * q;
    const answer = polyOfX([c, b, 1]);
    const pool = [
      `Busca dos números que multiplicados den ${c} y sumados den ${b}.`,
      `Entre las parejas de factores de ${c}, elige los signos que dan el producto.`,
      `$${p} \\cdot ${q} = ${c}$`,
      `$${p} + ${q} = ${b}$`,
      `Entonces los factores son $${factorX(p)}$ y $${factorX(q)}$.`,
      `Desarrolla para comprobar: $${latexPoly(answer)}$.`,
      "El término del medio es la suma y el término constante es el producto.",
      `$${factorX(p)}${factorX(q)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const wrongRoots = (r1: number, r2: number) => polyOfX([r1 * r2, r1 + r2, 1]);
    const options = assembleOptions(
      rng,
      { value: polyValue(answer), display: `$${factorX(p)}${factorX(q)}$`, error: "none" },
      [
        {
          value: polyValue(wrongRoots(p, p)),
          display: `$${factorX(p)}${factorX(p)}$`,
          error: "repeated-root",
        },
        {
          value: polyValue(wrongRoots(p, -q)),
          display: `$${factorX(p)}${factorX(-q)}$`,
          error: "sign-error",
        },
        {
          value: polyValue(wrongRoots(p + 1, q)),
          display: `$${factorX(p + 1)}${factorX(q)}$`,
          error: "wrong-sum",
        },
      ],
    );
    return {
      family: "factoring",
      level,
      type: "single_choice",
      stem: [`Factoriza el trinomio: $${latexPoly(answer)}$`],
      options,
      answer: { canonical: polyValue(answer), display: `$${factorX(p)}${factorX(q)}$` },
      solution,
      numericValues: [b, c],
      stepCount: solution.length,
      problem: { p, q },
    };
  },
};
