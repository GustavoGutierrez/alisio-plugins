import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { triplesUpTo } from "./pythagorean.js";
import { gcdOf, prompt } from "./shared.js";
import {
  degreeChoice,
  degreeMath,
  type Exact,
  exactChoice,
  exactMath,
  exactNumber,
  exactSquare,
  exactText,
  fnLatex,
  fnName,
  invertExact,
  scaleExact,
  type TrigFn,
  trigAt,
} from "./trig.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "ratio-from-sides"
  | "tan-from-legs"
  | "special-value"
  | "missing-side"
  | "find-angle"
  | "complementary"
  | "elevation"
  | "squares";

/** Which side a missing-side problem gives and which one it asks. */
type Given = "hyp-opp" | "hyp-adj" | "adj-opp" | "opp-hyp";

const SPECIAL = [30, 45, 60] as const;
const FNS: readonly TrigFn[] = ["sin", "cos", "tan"];

/** `sen θ`, `cos θ`, `tan θ` as LaTeX for an angle given in LaTeX. */
const call = (fn: TrigFn, angle: string): string => `${fnLatex(fn)} ${angle}`;

/** The three sides seen from the marked angle, from the legs (horizontal, vertical) and the vertex. */
function sidesFrom(horizontal: number, vertical: number, at: "A" | "B", hyp: number) {
  // At A (bottom right) the opposite side is the vertical leg; at B (top) it is the horizontal one.
  return at === "A"
    ? { opp: vertical, adj: horizontal, hyp }
    : { opp: horizontal, adj: vertical, hyp };
}

function ratio(fn: TrigFn, sides: { opp: number; adj: number; hyp: number }): Rational {
  if (fn === "sin") return Rational.of(sides.opp, sides.hyp);
  if (fn === "cos") return Rational.of(sides.adj, sides.hyp);
  return Rational.of(sides.opp, sides.adj);
}

/** The side a missing-side problem asks, exactly, from the given length and the angle at A. */
function missingSide(given: Given, length: number, degrees: number): Exact {
  const sin = trigAt("sin", degrees);
  const cos = trigAt("cos", degrees);
  const tan = trigAt("tan", degrees);
  switch (given) {
    case "hyp-opp":
      return scaleExact(sin, length);
    case "hyp-adj":
      return scaleExact(cos, length);
    case "adj-opp":
      return scaleExact(tan, length);
    default:
      return scaleExact(invertExact(sin), length);
  }
}

/** Right-triangle trigonometry: ratios, exact special values, sides, angles (10th, EBC 10-11). */
export const trigRatios: Family = {
  id: "trig-ratios",
  solve(problem: Record<string, unknown>): Rational | string {
    const fn = problem.fn as TrigFn;
    const degrees = Number(problem.degrees);
    switch (problem.variant as Variant) {
      case "ratio-from-sides":
      case "tan-from-legs":
        return ratio(fn, {
          opp: Number(problem.opp),
          adj: Number(problem.adj),
          hyp: Number(problem.hyp),
        });
      case "special-value":
        return exactText(trigAt(fn, degrees));
      case "missing-side":
      case "elevation":
        return exactText(missingSide(problem.given as Given, Number(problem.length), degrees));
      case "find-angle": {
        // The special angle whose ratio is first / second, both read back from their exact text.
        const quotient = surdNumber(String(problem.first)) / surdNumber(String(problem.second));
        const found = SPECIAL.find((d) => Math.abs(exactNumber(trigAt(fn, d)) - quotient) < 1e-9);
        return Rational.of(found ?? 0);
      }
      case "complementary": {
        const [a, b, c] = [Number(problem.opp), Number(problem.adj), Number(problem.hyp)];
        return ratio(fn, { opp: a, adj: b, hyp: c });
      }
      default: {
        const first = exactSquare(trigAt(problem.fn as TrigFn, Number(problem.degrees)));
        const second = exactSquare(trigAt(problem.fn2 as TrigFn, Number(problem.degrees2)));
        return problem.op === "-" ? first.sub(second) : first.add(second);
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["ratio-from-sides", "tan-from-legs", "special-value"],
        ["ratio-from-sides", "missing-side", "special-value", "tan-from-legs"],
        ["missing-side", "find-angle", "complementary", "ratio-from-sides"],
        ["elevation", "squares", "complementary", "find-angle", "missing-side"],
      ]),
    );
    const family = "trig-ratios";
    const limit = levelHigh(calibration, 60, 5);
    const unit = rng.pick(["cm", "m"]);
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const at = rng.pick(["A", "B"] as const);

    if (variant === "ratio-from-sides" || variant === "complementary") {
      const triples = triplesUpTo(Math.max(5, limit));
      const picked = rng.pick(
        triples.length > 0 ? triples : [[3, 4, 5] as [number, number, number]],
      );
      // A given sine is written reduced, so the complementary variant works on a primitive triple.
      const g = variant === "complementary" ? gcdOf(picked[0], picked[1]) : 1;
      const [p, q, r] = [picked[0] / g, picked[1] / g, picked[2] / g];
      const [horizontal, vertical] = rng.int(0, 1) === 0 ? [p, q] : [q, p];
      const sides = sidesFrom(horizontal, vertical, at, r);
      const fn = rng.pick(variant === "complementary" ? (["cos", "tan"] as const) : FNS);
      const answer = ratio(fn, sides);
      const others = FNS.filter((entry) => entry !== fn).map((entry) => ratio(entry, sides));
      const distractors: OptionCandidate[] = [
        numberChoice(others[0] ?? Rational.one, "used-the-wrong-ratio"),
        numberChoice(answer.inv(), "inverted-the-ratio"),
        numberChoice(others[1] ?? Rational.one, "used-the-wrong-ratio"),
        numberChoice(Rational.of(sides.adj, sides.opp), "swapped-opposite-and-adjacent"),
      ];
      if (variant === "complementary") {
        // Only sen θ is given; the student finds the third side with Pythagoras first.
        const given = Rational.of(sides.opp, sides.hyp);
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              `El ángulo $\\theta$ es agudo y $${call("sin", "\\theta")} = \\dfrac{${sides.opp}}{${sides.hyp}}$. ¿Cuánto vale $${call(fn, "\\theta")}$?`,
            ),
          ],
          correct: numberChoice(answer, "none"),
          distractors: [
            numberChoice(Rational.one.sub(given), "subtracted-from-one"),
            ...distractors,
          ],
          pool: [
            "Dibuja un triángulo rectángulo con el ángulo $\\theta$.",
            `Cateto opuesto $${sides.opp}$ e hipotenusa $${sides.hyp}$.`,
            `Por Pitágoras, el cateto adyacente es $\\sqrt{${sides.hyp}^2 - ${sides.opp}^2} = ${sides.adj}$.`,
            fn === "cos"
              ? `$${call("cos", "\\theta")} = \\dfrac{\\text{adyacente}}{\\text{hipotenusa}}$`
              : `$${call("tan", "\\theta")} = \\dfrac{\\text{opuesto}}{\\text{adyacente}}$`,
            `El valor de la ${fnName(fn)} es:`,
            math(answer),
          ],
          numericValues: [sides.opp, sides.hyp],
          problem: { variant, fn, opp: sides.opp, adj: sides.adj, hyp: sides.hyp },
          fallback: "none",
        });
      }
      const figure: FigureSpec = {
        kind: "triangle",
        params: {
          legs: [horizontal, vertical],
          sideLabels: [`${horizontal} ${unit}`, `${vertical} ${unit}`, `${r} ${unit}`],
          angleAt: at,
          angleLabel: "θ",
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(`En el triángulo rectángulo, ¿cuánto vale $${call(fn, "\\theta")}$?`),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors,
        pool: [
          "Identifica los lados respecto al ángulo $\\theta$.",
          `Opuesto: $${sides.opp}$. Adyacente: $${sides.adj}$. Hipotenusa: $${sides.hyp}$.`,
          fn === "sin"
            ? "$\\operatorname{sen}\\theta = \\dfrac{\\text{opuesto}}{\\text{hipotenusa}}$"
            : fn === "cos"
              ? "$\\cos\\theta = \\dfrac{\\text{adyacente}}{\\text{hipotenusa}}$"
              : "$\\tan\\theta = \\dfrac{\\text{opuesto}}{\\text{adyacente}}$",
          "Simplifica la fracción.",
          `El valor de la ${fnName(fn)} es:`,
          math(answer),
        ],
        numericValues: [horizontal, vertical, r],
        problem: { variant, fn, opp: sides.opp, adj: sides.adj, hyp: sides.hyp },
        fallback: "none",
      });
    }

    if (variant === "tan-from-legs") {
      const high = Math.min(limit, 12);
      const horizontal = rng.int(1, high);
      let vertical = rng.int(1, high);
      if (vertical === horizontal) vertical = horizontal === high ? 1 : horizontal + 1;
      const sides = sidesFrom(horizontal, vertical, at, 0);
      const answer = Rational.of(sides.opp, sides.adj);
      const figure: FigureSpec = {
        kind: "triangle",
        params: {
          legs: [horizontal, vertical],
          sideLabels: [`${horizontal} ${unit}`, `${vertical} ${unit}`, ""],
          angleAt: at,
          angleLabel: "θ",
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("Con los catetos del triángulo, halla $\\tan\\theta$."), { figure }],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(answer.inv(), "swapped-opposite-and-adjacent"),
          numberChoice(Rational.of(sides.opp, sides.opp + sides.adj), "added-the-legs"),
          numberChoice(Rational.of(sides.adj, sides.opp + sides.adj), "added-the-legs"),
        ],
        pool: [
          "La tangente solo necesita los dos catetos.",
          `Cateto opuesto a $\\theta$: $${sides.opp}$.`,
          `Cateto adyacente a $\\theta$: $${sides.adj}$.`,
          `$\\tan\\theta = \\dfrac{${sides.opp}}{${sides.adj}}$`,
          "La tangente es:",
          math(answer),
        ],
        numericValues: [horizontal, vertical],
        problem: { variant, fn: "tan", opp: sides.opp, adj: sides.adj, hyp: 0 },
        fallback: "none",
      });
    }

    if (variant === "special-value") {
      const fn = rng.pick(FNS);
      const degrees = rng.pick(SPECIAL);
      const value = trigAt(fn, degrees);
      const cofunction: TrigFn = fn === "sin" ? "cos" : fn === "cos" ? "sin" : "tan";
      const candidates: OptionCandidate[] = [
        exactChoice(
          trigAt(cofunction, fn === "tan" ? 90 - degrees : degrees),
          fn === "tan" ? "used-the-complementary-angle" : "swapped-sine-and-cosine",
        ),
        exactChoice(invertExact(value), "inverted-the-ratio"),
        ...FNS.filter((entry) => entry !== fn).map((entry) =>
          exactChoice(trigAt(entry, degrees), "used-the-wrong-function"),
        ),
        ...SPECIAL.filter((entry) => entry !== degrees).map((entry) =>
          exactChoice(trigAt(fn, entry), "confused-the-special-angles"),
        ),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es el valor exacto de $${call(fn, `${degrees}^\\circ`)}$?`)],
        correct: exactChoice(value, "none"),
        distractors: candidates,
        pool: [
          degrees === 45
            ? "Usa el triángulo rectángulo isósceles de catetos $1$ e hipotenusa $\\sqrt{2}$."
            : "Usa la mitad de un triángulo equilátero de lado $2$: catetos $1$ y $\\sqrt{3}$.",
          `Ubica el ángulo de $${degrees}^\\circ$ y sus lados opuesto y adyacente.`,
          `Aplica la definición de la ${fnName(fn)}.`,
          "Racionaliza si queda una raíz en el denominador.",
          "El valor exacto es:",
          exactMath(value),
        ],
        numericValues: [],
        problem: { variant, fn, degrees },
        fallback: "none",
      });
    }

    if (variant === "find-angle") {
      // Two sides of a special triangle, written exactly: k·(1, √3, 2) or k·(1, 1, √2).
      const degrees = rng.pick(SPECIAL);
      const k = rng.int(2, Math.min(9, limit));
      const hyp: Exact = { coefficient: Rational.of(2 * k), radicand: 1 };
      const opp = scaleExact(trigAt("sin", degrees), 2 * k);
      const adj = scaleExact(trigAt("cos", degrees), 2 * k);
      const pair = rng.pick(["opp-hyp", "adj-hyp", "opp-adj"] as const);
      const [first, second] =
        pair === "opp-hyp" ? [opp, hyp] : pair === "adj-hyp" ? [adj, hyp] : [opp, adj];
      const fn: TrigFn = pair === "opp-hyp" ? "sin" : pair === "adj-hyp" ? "cos" : "tan";
      const shown = (value: Exact) => exactMath(value).slice(1, -1);
      const firstName = pair === "adj-hyp" ? "el cateto adyacente" : "el cateto opuesto";
      const secondName = pair === "opp-adj" ? "el cateto adyacente" : "la hipotenusa";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `En un triángulo rectángulo, ${firstName} al ángulo agudo $\\alpha$ mide $${shown(first)}$ ${unit} y ${secondName} mide $${shown(second)}$ ${unit}. ¿Cuánto mide $\\alpha$?`,
          ),
        ],
        correct: degreeChoice(degrees, "none"),
        distractors: [
          degreeChoice(90 - degrees, "gave-the-other-acute-angle"),
          ...SPECIAL.filter((entry) => entry !== degrees).map((entry) =>
            degreeChoice(entry, "confused-the-special-values"),
          ),
          degreeChoice(90, "gave-the-right-angle"),
        ],
        pool: [
          `La razón entre ${firstName} y ${secondName} es la ${fnName(fn)}.`,
          `$${call(fn, "\\alpha")} = \\dfrac{${shown(first)}}{${shown(second)}}$`,
          `$${call(fn, "\\alpha")} = ${shown(trigAt(fn, degrees))}$`,
          "Ese es el valor de un ángulo notable.",
          "El ángulo es:",
          degreeMath(degrees),
        ],
        numericValues: [k],
        problem: { variant, fn, first: exactText(first), second: exactText(second) },
        fallback: "none",
      });
    }

    if (variant === "squares") {
      const fn = rng.pick(FNS);
      const fn2 = rng.pick(FNS.filter((entry) => entry !== "tan" || fn !== "tan"));
      const degrees = rng.pick(SPECIAL);
      const swap = (entry: TrigFn): TrigFn =>
        entry === "sin" ? "cos" : entry === "cos" ? "sin" : "tan";
      // Two different terms that are not an identity pair (sen²α + cos²α would give 1 for free).
      let degrees2 = rng.pick(SPECIAL);
      if (degrees2 === degrees && (fn2 === fn || fn2 === swap(fn))) {
        degrees2 = SPECIAL[(SPECIAL.indexOf(degrees) + 1) % SPECIAL.length] ?? 30;
      }
      const op = rng.pick(["+", "-"] as const);
      const first = exactSquare(trigAt(fn, degrees));
      const second = exactSquare(trigAt(fn2, degrees2));
      const answer = op === "+" ? first.add(second) : first.sub(second);
      const swapped = exactSquare(trigAt(swap(fn), degrees));
      const swapped2 = exactSquare(trigAt(swap(fn2), degrees2));
      const term = (entry: TrigFn, d: number) => `${fnLatex(entry)}^2 ${d}^\\circ`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(`Calcula el valor exacto de $${term(fn, degrees)} ${op} ${term(fn2, degrees2)}$.`),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(
            op === "+" ? first.sub(second) : first.add(second),
            "used-the-wrong-operation",
          ),
          numberChoice(
            op === "+" ? swapped.add(swapped2) : swapped.sub(swapped2),
            "swapped-sine-and-cosine",
          ),
          numberChoice(
            op === "+" ? Rational.one : Rational.zero,
            "misused-the-pythagorean-identity",
          ),
        ],
        pool: [
          "Escribe el valor exacto de cada razón.",
          `$${call(fn, `${degrees}^\\circ`)} = ${exactMath(trigAt(fn, degrees)).slice(1, -1)}$`,
          `$${call(fn2, `${degrees2}^\\circ`)} = ${exactMath(trigAt(fn2, degrees2)).slice(1, -1)}$`,
          `Al elevar al cuadrado: $${math(first).slice(1, -1)}$ y $${math(second).slice(1, -1)}$.`,
          `Opera: $${math(first).slice(1, -1)} ${op} ${math(second).slice(1, -1)}$.`,
          "El valor exacto es:",
          math(answer),
        ],
        numericValues: [],
        problem: { variant, fn, degrees, fn2, degrees2, op },
        fallback: "any",
      });
    }

    // missing-side and elevation: one side and a special angle at A give another side exactly.
    const degrees = rng.pick(SPECIAL);
    const given: Given =
      variant === "elevation"
        ? rng.pick(["adj-opp", "hyp-opp"] as const)
        : rng.pick(["hyp-opp", "hyp-adj", "adj-opp", "opp-hyp"] as const);
    const length = rng.int(2, Math.min(limit, 40));
    const answer = missingSide(given, length, degrees);
    const sin = trigAt("sin", degrees);
    const cos = trigAt("cos", degrees);
    const tan = trigAt("tan", degrees);
    const wrong: Record<Given, Exact[]> = {
      "hyp-opp": [
        scaleExact(cos, length),
        scaleExact(invertExact(sin), length),
        scaleExact(tan, length),
      ],
      "hyp-adj": [
        scaleExact(sin, length),
        scaleExact(invertExact(cos), length),
        scaleExact(tan, length),
      ],
      "adj-opp": [
        scaleExact(invertExact(tan), length),
        scaleExact(sin, length),
        scaleExact(cos, length),
      ],
      "opp-hyp": [
        scaleExact(sin, length),
        scaleExact(invertExact(cos), length),
        scaleExact(tan, length),
      ],
    };
    const errors =
      given === "opp-hyp"
        ? ["multiplied-instead-of-dividing", "used-the-wrong-function", "used-the-wrong-function"]
        : ["used-the-wrong-function", "divided-instead-of-multiplying", "used-the-wrong-function"];
    const distractors: OptionCandidate[] = wrong[given].map((value, position) =>
      exactChoice(value, errors[position] ?? "used-the-wrong-function"),
    );
    if (answer.radicand > 1) {
      distractors.push(numberChoice(answer.coefficient, "dropped-the-square-root"));
    }
    distractors.push(
      exactChoice(scaleExact(invertExact(sin), length), "used-the-hypotenuse-ratio"),
      numberChoice(Rational.of(length, 2), "halved-the-side"),
      numberChoice(Rational.of(2 * length), "doubled-the-side"),
    );
    // Drawn legs from the hypotenuse; the given side carries its length, the asked one `x`.
    const hypotenuse =
      given === "hyp-opp" || given === "hyp-adj"
        ? length
        : given === "adj-opp"
          ? length / exactNumber(cos)
          : exactNumber(answer);
    const legs = [hypotenuse * exactNumber(cos), hypotenuse * exactNumber(sin)];
    const labelsFor: Record<Given, [string, string, string]> = {
      "hyp-opp": ["", "x", `${length} ${unit}`],
      "hyp-adj": ["x", "", `${length} ${unit}`],
      "adj-opp": [`${length} ${unit}`, "x", ""],
      "opp-hyp": ["", `${length} ${unit}`, "x"],
    };
    const fnUsed: TrigFn = given === "hyp-adj" ? "cos" : given === "adj-opp" ? "tan" : "sin";
    const figure: FigureSpec = {
      kind: "triangle",
      ...(variant === "elevation"
        ? {
            label:
              given === "adj-opp"
                ? "Ángulo de elevación desde el suelo"
                : "Rampa apoyada en el suelo",
          }
        : {}),
      params: { legs, sideLabels: labelsFor[given], angleAt: "A", angleLabel: `${degrees}°` },
    };
    const question =
      variant === "elevation"
        ? given === "adj-opp"
          ? `Desde un punto del suelo a $${length}$ ${unit} de la base de un edificio, se ve la azotea con un ángulo de elevación de $${degrees}^\\circ$. ¿Cuál es la altura $x$ del edificio, en forma exacta?`
          : `Una rampa de $${length}$ ${unit} de largo forma un ángulo de $${degrees}^\\circ$ con el suelo. ¿A qué altura $x$ llega, en forma exacta?`
        : `En el triángulo rectángulo, halla el lado $x$ en forma exacta.`;
    const relation =
      given === "opp-hyp"
        ? `$\\operatorname{sen} ${degrees}^\\circ = \\dfrac{${length}}{x}$, así que $x = \\dfrac{${length}}{\\operatorname{sen} ${degrees}^\\circ}$.`
        : `$${call(fnUsed, `${degrees}^\\circ`)} = \\dfrac{x}{${length}}$, así que $x = ${length} \\cdot ${call(fnUsed, `${degrees}^\\circ`)}$.`;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(question), { figure }],
      correct: exactChoice(answer, "none"),
      distractors,
      pool: [
        `Ubica el ángulo de $${degrees}^\\circ$ y los lados que relaciona.`,
        `La razón que une esos lados es la ${fnName(fnUsed)}.`,
        relation,
        `$${call(fnUsed, `${degrees}^\\circ`)} = ${exactMath(trigAt(fnUsed, degrees)).slice(1, -1)}$`,
        "Simplifica y racionaliza si hace falta.",
        `La medida exacta (en ${unit}):`,
        exactMath(answer),
      ],
      numericValues: [length],
      problem: { variant, given, length, degrees },
      fallback: "none",
    });
  },
};

/** Exposed for tests: the side `x` of a missing-side problem, as canonical text. */
export const missingSideText = (given: Given, length: number, degrees: number): string =>
  exactText(missingSide(given, length, degrees));

/** The number a canonical surd text stands for (`1/2sqrt3` is 0.866…). */
export function surdNumber(text: string): number {
  const [coefficient = "0", radicand = "1"] = text.split("sqrt");
  return (
    Rational.parse(coefficient === "" ? "1" : coefficient).toNumber() * Math.sqrt(Number(radicand))
  );
}
