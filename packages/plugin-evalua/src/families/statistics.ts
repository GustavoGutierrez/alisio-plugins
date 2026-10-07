import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled, prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Measure = "mean" | "median" | "mode" | "range";

const labels: Record<Measure, { article: string; name: string }> = {
  mean: { article: "la", name: "media" },
  median: { article: "la", name: "mediana" },
  mode: { article: "la", name: "moda" },
  range: { article: "el", name: "rango" },
};

function sorted(data: readonly number[]): number[] {
  return [...data].sort((left, right) => left - right);
}

function modeOf(data: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of data) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = data[0] ?? 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function compute(data: readonly number[], measure: Measure): Rational {
  const ordered = sorted(data);
  const count = ordered.length;
  const middle = Math.floor(count / 2);
  if (measure === "mean") {
    const total = ordered.reduce((sum, value) => sum + value, 0);
    return Rational.of(total, count);
  }
  if (measure === "median") {
    return count % 2 === 1
      ? Rational.of(ordered[middle] ?? 0)
      : Rational.of((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0), 2);
  }
  if (measure === "mode") return Rational.of(modeOf(ordered));
  return Rational.of((ordered[count - 1] ?? 0) - (ordered[0] ?? 0));
}

/** Up to `count` distinct integers in `[low, high]`, never one of `exclude`. */
function distinctValues(
  rng: Rng,
  count: number,
  low: number,
  high: number,
  exclude: ReadonlySet<number>,
): number[] {
  const values = new Set<number>();
  for (let guard = 0; guard < 200 && values.size < count; guard += 1) {
    const candidate = rng.int(low, high);
    if (!exclude.has(candidate)) values.add(candidate);
  }
  for (let candidate = low; candidate <= high && values.size < count; candidate += 1) {
    if (!exclude.has(candidate)) values.add(candidate);
  }
  return [...values].slice(0, count);
}

/** Mean, median, mode and range of a small natural-number data set (pensamiento aleatorio). */
export const statistics: Family = {
  id: "statistics",
  solve(problem: Record<string, unknown>): Rational {
    const data = (problem.data as unknown[]).map(Number);
    return compute(data, problem.measure as Measure);
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const low = Math.max(1, calibration.coefficientRange[0]);
    const high = Math.max(low + 1, Math.floor(calibration.coefficientRange[1]));
    const size = Math.min(9, Math.max(3, Math.floor(calibration.steps[1]) + 1));
    const measures: Measure[] = ["mean", "median", "mode"];
    if (calibration.steps[0] >= 3) measures.push("range");
    const measure = rng.pick(measures);
    // An odd size keeps the median a data value, with no averaging rule to argue about.
    const count = measure === "median" && size % 2 === 0 ? size - 1 : size;

    let data: number[];
    if (measure === "mode") {
      const modeValue = rng.int(low, high);
      const others = distinctValues(rng, count - 2, low, high, new Set([modeValue]));
      data = rng.shuffle([modeValue, modeValue, ...others]);
    } else {
      data = [];
      for (let index = 0; index < count; index += 1) data.push(rng.int(low, high));
      const min = Math.min(...data);
      const max = Math.max(...data);
      if (min === max) {
        const index = rng.int(0, data.length - 1);
        data[index] = min === high ? Math.max(low, min - 1) : min + 1;
      }
    }

    const answer = compute(data, measure);
    const total = data.reduce((sum, value) => sum + value, 0);
    const candidates: OptionCandidate[] = [
      {
        value: Rational.of(total).toString(),
        display: money(Rational.of(total)),
        error: "used-sum",
      },
    ];
    for (const other of ["mean", "median", "mode", "range"] as const) {
      if (other === measure) continue;
      const value = compute(data, other);
      candidates.push({
        value: value.toString(),
        display: money(value),
        error: other === "range" ? "used-range" : "confused-measure",
      });
    }
    const offUp = answer.add(Rational.one);
    candidates.push({ value: offUp.toString(), display: money(offUp), error: "off-by-one" });
    const offDown = answer.sub(Rational.one);
    if (offDown.sign() >= 0) {
      candidates.push({ value: offDown.toString(), display: money(offDown), error: "off-by-one" });
    }
    candidates.push(...perturb(answer));

    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      candidates,
    );
    const ordered = sorted(data);
    const specific: string[] =
      measure === "mean"
        ? [
            "La media es la suma dividida entre el número de datos.",
            `$${total} \\div ${data.length} = ${latexRational(answer)}$`,
          ]
        : measure === "median"
          ? [
              "La mediana es el valor central de los datos ordenados.",
              `El valor central es $${latexRational(answer)}$.`,
            ]
          : measure === "mode"
            ? [
                "La moda es el valor que más se repite.",
                `El valor que más se repite es $${latexRational(answer)}$.`,
              ]
            : [
                "El rango es la diferencia entre el mayor y el menor.",
                `$${ordered[ordered.length - 1] ?? 0} - ${ordered[0] ?? 0} = ${latexRational(answer)}$`,
              ];
    const pool = [
      "Organiza los datos de menor a mayor.",
      `Datos ordenados: $${ordered.join(", ")}$`,
      `Número de datos: $${data.length}$`,
      `Suma de los datos: $${total}$`,
      ...specific,
      "El resultado es:",
      `$${latexRational(answer)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const expr = `$${data.join(", ")}$`;
    const label = labels[measure];
    return {
      family: "statistics",
      level,
      type: "single_choice",
      stem: [prompt(rng, prompts, `Calcula ${label.article} ${label.name} de: {expr}`, expr)],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: data,
      stepCount: solution.length,
      problem: { data, measure },
    };
  },
};
