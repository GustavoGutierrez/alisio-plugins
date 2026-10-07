import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { gcdOf, lcmOf, money, perturb, positiveValue, primeFactors } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Mode = "gcd" | "lcm";

function factorText(value: number): string {
  const factors = primeFactors(value);
  if (factors.length === 0) return "1";
  const counts = new Map<number, number>();
  for (const factor of factors) counts.set(factor, (counts.get(factor) ?? 0) + 1);
  return [...counts.entries()]
    .map(([prime, exponent]) => (exponent === 1 ? `${prime}` : `${prime}^{${exponent}}`))
    .join(" \\cdot ");
}

function counts(value: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const factor of primeFactors(value)) map.set(factor, (map.get(factor) ?? 0) + 1);
  return map;
}

function pool(a: number, b: number, mode: Mode, result: number): string[] {
  const left = counts(a);
  const right = counts(b);
  const shared = [...left.keys()].filter((prime) => right.has(prime));
  const common = shared
    .map((prime) => `${prime}^{${Math.min(left.get(prime) ?? 0, right.get(prime) ?? 0)}}`)
    .join(" \\cdot ");
  const united = [...new Set([...left.keys(), ...right.keys()])]
    .sort((x, y) => x - y)
    .map((prime) => `${prime}^{${Math.max(left.get(prime) ?? 0, right.get(prime) ?? 0)}}`)
    .join(" \\cdot ");
  const details =
    mode === "gcd"
      ? [
          `Primos comunes: $${common === "" ? "1" : common}$`,
          "Toma el menor exponente de cada primo común.",
          "Multiplica los primos comunes.",
          `Comprueba: $${a} \\div ${result}$ y $${b} \\div ${result}$ son enteros.`,
          "$\\gcd$ es el máximo común divisor.",
        ]
      : [
          `Toma cada primo con su mayor exponente: $${united}$`,
          "Multiplícalos todos.",
          `Comprueba: ${result} es múltiplo de ${a} y de ${b}.`,
          "$\\mathrm{lcm}$ es el mínimo común múltiplo.",
        ];
  return [
    `$${a} = ${factorText(a)}$`,
    `$${b} = ${factorText(b)}$`,
    ...details,
    mode === "gcd" ? `$\\gcd(${a}, ${b}) = ${result}$` : `$\\mathrm{lcm}(${a}, ${b}) = ${result}$`,
  ];
}

export const gcdLcm: Family = {
  id: "gcd-lcm",
  solve(problem: Record<string, unknown>): Rational {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const result = problem.mode === "lcm" ? lcmOf(a, b) : gcdOf(a, b);
    return Rational.of(result);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const mode: Mode = rng.int(0, 1) === 0 ? "gcd" : "lcm";
    const a = positiveValue(rng, calibration.coefficientRange);
    let b = positiveValue(rng, calibration.coefficientRange);
    if (b === a) b = a === 1 ? 2 : a - 1;
    const result = mode === "lcm" ? lcmOf(a, b) : gcdOf(a, b);
    const lines = pool(a, b, mode, result);
    const target = rng.int(Math.max(1, calibration.steps[0]), Math.max(1, calibration.steps[1]));
    const solution = lines.slice(-Math.min(target, lines.length));
    const answer = Rational.of(result);
    const other = Rational.of(mode === "lcm" ? gcdOf(a, b) : lcmOf(a, b));
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: other.toString(), display: money(other), error: "gcd-lcm-confusion" },
        {
          value: Rational.of(a * b).toString(),
          display: money(Rational.of(a * b)),
          error: "used-the-product",
        },
        {
          value: Rational.of(a + b).toString(),
          display: money(Rational.of(a + b)),
          error: "added-instead",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "gcd-lcm",
      level,
      type: "single_choice",
      stem: [
        `Halla el ${mode === "lcm" ? "mínimo común múltiplo" : "máximo común divisor"} de $${a}$ y $${b}$.`,
      ],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a, b],
      stepCount: solution.length,
      problem: { a, b, mode },
    };
  },
};
