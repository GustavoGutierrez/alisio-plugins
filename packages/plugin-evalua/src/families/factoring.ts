import { latexPoly } from "../math/latex.js";
import { assembleOptions } from "./options.js";
import { polyOfX, polyValue, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function factorX(root: number): string {
  if (root === 0) return "x";
  return `\\left(x ${root < 0 ? "-" : "+"} ${Math.abs(root)}\\right)`;
}

export const factoring: Family = {
  id: "factoring",
  solve(problem: Record<string, unknown>) {
    const p = Number(problem.p);
    const q = Number(problem.q);
    return polyOfX([p * q, p + q, 1]);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const bound = Math.max(1, Math.min(3, Math.floor(max / 2)));
    const bounded: [number, number] = [-bound, bound];
    const p = rangeValue(rng, bounded);
    let q = rangeValue(rng, bounded);
    let guard = 0;
    while ((q === p || p + q === 0 || p * q === 0) && guard < 10) {
      q = rangeValue(rng, bounded);
      guard += 1;
    }
    if (q === p) q = p === 1 ? 2 : p - 1;
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
