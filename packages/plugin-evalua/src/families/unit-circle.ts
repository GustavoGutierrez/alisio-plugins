import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { piChoice, piMath, piText } from "./exact.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import {
  degreeMath,
  type Exact,
  exactChoice,
  exactMath,
  exactText,
  fnLatex,
  fnName,
  invertExact,
  normalized,
  quadrantOf,
  radianLatex,
  radianPlain,
  referenceAngle,
  type TrigFn,
  trigAt,
  trigValue,
} from "./trig.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "deg-to-rad"
  | "rad-to-deg"
  | "quadrant"
  | "unit-point"
  | "exact-value"
  | "period"
  | "graph-read"
  | "equation";

/** Every multiple of 30° or 45° in (0°, 360°) that is off the axes. */
const OFF_AXIS = [30, 45, 60, 120, 135, 150, 210, 225, 240, 300, 315, 330];
/** Every multiple of 30° or 45° up to 360°, axes included, for conversions. */
const CONVERTIBLE = [30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330, 360];
const ROMAN = ["", "I", "II", "III", "IV"];

/** Degrees as text and math, with the decimal comma for a half degree. */
const degreeText = (degrees: number): OptionCandidate["display"] =>
  `$${String(degrees).replace(".", "{,}")}^\\circ$`;

const quadrantChoice = (quadrant: number, error: string): OptionCandidate =>
  textChoice(ROMAN[quadrant] ?? "I", error, `Cuadrante ${ROMAN[quadrant] ?? "I"}`);

/** `(x, y)` with exact coordinates as canonical text and math. */
function pointChoiceExact(x: Exact, y: Exact, error: string): OptionCandidate {
  return {
    value: `(${exactText(x)},${exactText(y)})`,
    display: `$\\left(${exactMath(x).slice(1, -1)},\\ ${exactMath(y).slice(1, -1)}\\right)$`,
    error,
  };
}

const flip = (value: Exact): Exact => ({
  coefficient: value.coefficient.neg(),
  radicand: value.radicand,
});

/** The angle of quadrant `quadrant` (1-4) whose reference angle is `reference`. */
const withReference = (quadrant: number, reference: number): number =>
  [reference, 180 - reference, 180 + reference, 360 - reference][quadrant - 1] ?? reference;

/** The solutions in `[0°, 360°)` of `fn x = value` for a sine or cosine special value. */
export function solutionsOf(fn: "sin" | "cos", value: string): number[] {
  const out: number[] = [];
  for (let degrees = 0; degrees < 360; degrees += 15) {
    if (degrees % 30 !== 0 && degrees % 45 !== 0) continue;
    const exact = trigValue(fn, degrees);
    if (exact !== undefined && exactText(exact) === value) out.push(degrees);
  }
  return out;
}

/** A set of angles in radians: canonical `{1/6pi,5/6pi}`, math `$x = \frac{π}{6}$ y …`. */
function angleSetChoice(degrees: readonly number[], error: string): OptionCandidate {
  const sorted = [...new Set(degrees)].sort((a, b) => a - b);
  return textChoice(
    `{${sorted.map((d) => piText(Rational.of(d, 180))).join(",")}}`,
    error,
    sorted.map((d) => `$x = ${radianLatex(d)}$`).join(" y "),
  );
}

/** Radians, the unit circle and the sine and cosine functions (10th, EBC 10-11). */
export const unitCircle: Family = {
  id: "unit-circle",
  solve(problem: Record<string, unknown>): Rational | string {
    const degrees = Number(problem.degrees);
    const fn = problem.fn as TrigFn;
    switch (problem.variant as Variant) {
      case "deg-to-rad":
        return piText(Rational.of(degrees, 180));
      case "rad-to-deg":
        return Rational.parse(String(problem.coefficient)).mul(Rational.of(180));
      case "quadrant":
        return ROMAN[quadrantOf(degrees)] ?? "";
      case "unit-point":
        return `(${exactText(trigAt("cos", degrees))},${exactText(trigAt("sin", degrees))})`;
      case "exact-value":
        return exactText(trigAt(fn, degrees));
      case "period":
        return piText(Rational.of(2, Number(problem.k)));
      case "graph-read":
        return Rational.of(
          Number(problem.ask === "amplitude" ? problem.amplitude : problem.period),
        );
      default: {
        const solutions = solutionsOf(problem.fn as "sin" | "cos", String(problem.value));
        return `{${solutions.map((d) => piText(Rational.of(d, 180))).join(",")}}`;
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["deg-to-rad", "rad-to-deg"],
        ["deg-to-rad", "rad-to-deg", "quadrant", "unit-point"],
        ["unit-point", "exact-value", "quadrant", "period"],
        ["exact-value", "graph-read", "equation", "period"],
      ]),
    );
    const family = "unit-circle";
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (variant === "deg-to-rad") {
      const degrees = rng.pick(CONVERTIBLE);
      const answer = Rational.of(degrees, 180);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Expresa $${degrees}^\\circ$ en radianes.`)],
        correct: piChoice(answer, "none"),
        distractors: [
          piChoice(Rational.of(180, degrees), "inverted-the-conversion"),
          piChoice(Rational.of(degrees, 360), "used-360-for-pi"),
          piChoice(Rational.of(degrees, 90), "used-90-for-pi"),
          piChoice(Rational.of(degrees, 60), "used-60-for-pi"),
        ],
        pool: [
          "Recuerda la equivalencia: $180^\\circ = \\pi$ radianes.",
          `Multiplica por $\\dfrac{\\pi}{180^\\circ}$: $${degrees} \\cdot \\dfrac{\\pi}{180}$.`,
          `Simplifica la fracción $\\dfrac{${degrees}}{180}$.`,
          "La medida en radianes es:",
          piMath(answer),
        ],
        numericValues: [],
        problem: { variant, degrees },
        fallback: "none",
      });
    }

    if (variant === "rad-to-deg") {
      const degrees = rng.pick(CONVERTIBLE);
      const coefficient = Rational.of(degrees, 180);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Expresa $${radianLatex(degrees)}$ radianes en grados.`)],
        correct: textChoice(String(degrees), "none", degreeMath(degrees)),
        distractors: [
          textChoice(String(degrees * 2), "used-360-for-pi", degreeText(degrees * 2)),
          textChoice(String(degrees / 2), "used-90-for-pi", degreeText(degrees / 2)),
          textChoice(String(degrees + 180), "added-180", degreeText(degrees + 180)),
          textChoice(
            String(Math.abs(180 - degrees) || 90),
            "gave-the-supplement",
            degreeText(Math.abs(180 - degrees) || 90),
          ),
          textChoice(
            coefficient.toString().replace("/", ":"),
            "forgot-to-replace-pi",
            `$${math(coefficient).slice(1, -1)}^\\circ$`,
          ),
        ],
        pool: [
          "Recuerda la equivalencia: $\\pi$ radianes $= 180^\\circ$.",
          `Reemplaza $\\pi$ por $180^\\circ$: $${math(coefficient).slice(1, -1)} \\cdot 180^\\circ$.`,
          "Simplifica el producto.",
          "La medida en grados es:",
          degreeMath(degrees),
        ],
        numericValues: [],
        problem: { variant, coefficient: coefficient.toString() },
        fallback: "none",
      });
    }

    if (variant === "quadrant") {
      const degrees = rng.pick(OFF_AXIS);
      const turns = index >= 2 ? rng.pick([0, 0, 1, -1]) : 0;
      const shown = degrees + 360 * turns;
      const radians = rng.int(0, 1) === 0;
      const quadrant = quadrantOf(degrees);
      const written = radians ? `${radianLatex(shown)}` : `${shown}^\\circ`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿En qué cuadrante termina un ángulo de $${written}$ en posición normal?`)],
        correct: quadrantChoice(quadrant, "none"),
        distractors: [
          quadrantChoice(5 - quadrant, "measured-clockwise"),
          quadrantChoice((quadrant % 4) + 1, "off-by-one-quadrant"),
          quadrantChoice(((quadrant + 2) % 4) + 1, "off-by-one-quadrant"),
          quadrantChoice(((quadrant + 1) % 4) + 1, "opposite-quadrant"),
        ],
        pool: [
          "Un ángulo en posición normal se mide desde el semieje $x$ positivo, en sentido antihorario.",
          turns !== 0
            ? `Suma o resta $360^\\circ$ hasta quedar entre $0^\\circ$ y $360^\\circ$: $${degrees}^\\circ$.`
            : `El ángulo equivale a $${degrees}^\\circ$.`,
          "Cada cuadrante abarca $90^\\circ$: I hasta $90^\\circ$, II hasta $180^\\circ$, III hasta $270^\\circ$ y IV hasta $360^\\circ$.",
          "El ángulo termina en el cuadrante:",
          ROMAN[quadrant] ?? "",
        ],
        numericValues: [],
        problem: { variant, degrees: shown },
        fallback: "none",
      });
    }

    if (variant === "unit-point" || variant === "exact-value") {
      const degrees = rng.pick(OFF_AXIS);
      const radians = index >= 2 || rng.int(0, 1) === 0;
      const written = radians ? radianLatex(degrees) : `${degrees}^\\circ`;
      const reference = referenceAngle(degrees);
      const cos = trigAt("cos", degrees);
      const sin = trigAt("sin", degrees);
      const figure: FigureSpec = {
        kind: "unit-circle",
        params: {
          angle: degrees,
          angleLabel: radians ? radianPlain(degrees) : `${degrees}°`,
          point: "P",
          projections: true,
        },
      };
      if (variant === "unit-point") {
        const refCos = trigAt("cos", reference);
        const refSin = trigAt("sin", reference);
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              `El lado terminal del ángulo $${written}$ corta la circunferencia unitaria en $P$. ¿Cuáles son las coordenadas exactas de $P$?`,
            ),
            { figure },
          ],
          correct: pointChoiceExact(cos, sin, "none"),
          distractors: [
            pointChoiceExact(sin, cos, "swapped-sine-and-cosine"),
            pointChoiceExact(refCos, refSin, "ignored-the-quadrant-signs"),
            pointChoiceExact(flip(cos), flip(sin), "used-the-opposite-quadrant"),
            pointChoiceExact(flip(cos), sin, "mirrored-the-wrong-axis"),
            pointChoiceExact(cos, flip(sin), "mirrored-the-wrong-axis"),
          ],
          pool: [
            "En la circunferencia unitaria, $P = (\\cos\\theta, \\operatorname{sen}\\theta)$.",
            `El ángulo de referencia es $${reference}^\\circ$.`,
            `En el cuadrante ${ROMAN[quadrantOf(degrees)]}, el coseno es ${cos.coefficient.sign() > 0 ? "positivo" : "negativo"} y el seno ${sin.coefficient.sign() > 0 ? "positivo" : "negativo"}.`,
            `$\\cos ${written} = ${exactMath(cos).slice(1, -1)}$, $\\operatorname{sen} ${written} = ${exactMath(sin).slice(1, -1)}$`,
            "Las coordenadas de $P$ son:",
            pointChoiceExact(cos, sin, "none").display,
          ],
          numericValues: [],
          problem: { variant, degrees },
          fallback: "none",
        });
      }
      const fn = rng.pick(["sin", "cos", "tan"] as const);
      const value = trigAt(fn, degrees);
      const refValue = trigAt(fn, reference);
      const cofunction: TrigFn = fn === "sin" ? "cos" : fn === "cos" ? "sin" : "tan";
      const coValue =
        fn === "tan" ? trigAt("tan", normalized(90 - reference)) : trigAt(cofunction, degrees);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(`Halla el valor exacto de $${fnLatex(fn)}\\left(${written}\\right)$.`),
          { figure },
        ],
        correct: exactChoice(value, "none"),
        distractors: [
          exactChoice(flip(value), "wrong-quadrant-sign"),
          exactChoice(
            coValue,
            fn === "tan" ? "used-the-complementary-angle" : "swapped-sine-and-cosine",
          ),
          exactChoice(fn === "tan" ? flip(coValue) : flip(coValue), "swapped-and-wrong-sign"),
          exactChoice(
            refValue.coefficient.sign() === value.coefficient.sign() ? flip(refValue) : refValue,
            "ignored-the-quadrant-signs",
          ),
          exactChoice(invertExact(value), "inverted-the-ratio"),
          ...[30, 45, 60]
            .filter((entry) => entry !== reference)
            .map((entry) =>
              exactChoice(
                trigAt(fn, withReference(quadrantOf(degrees), entry)),
                "confused-the-special-angles",
              ),
            ),
          ...(["sin", "cos", "tan"] as const)
            .filter((entry) => entry !== fn)
            .map((entry) => exactChoice(trigAt(entry, degrees), "used-the-wrong-function")),
        ],
        pool: [
          `El ángulo termina en el cuadrante ${ROMAN[quadrantOf(degrees)]}.`,
          `Su ángulo de referencia es $${reference}^\\circ$.`,
          `$${fnLatex(fn)} ${reference}^\\circ = ${exactMath(refValue).slice(1, -1)}$`,
          `En ese cuadrante la ${fnName(fn)} es ${value.coefficient.sign() > 0 ? "positiva" : "negativa"}.`,
          "El valor exacto es:",
          exactMath(value),
        ],
        numericValues: [],
        problem: { variant, fn, degrees },
        fallback: "none",
      });
    }

    if (variant === "period") {
      const k = rng.int(2, 6);
      const amplitude = rng.int(2, 6);
      const fn = rng.pick(["sin", "cos"] as const);
      const answer = Rational.of(2, k);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es el período de $f(x) = ${amplitude}${fnLatex(fn)}(${k}x)$?`)],
        correct: piChoice(answer, "none"),
        distractors: [
          piChoice(Rational.of(1, k), "used-pi-instead-of-2pi"),
          piChoice(Rational.of(2 * k), "multiplied-by-k"),
          numberChoice(amplitude, "gave-the-amplitude"),
          piChoice(Rational.of(2 * amplitude, k), "multiplied-by-the-amplitude"),
        ],
        pool: [
          `La función $${fnLatex(fn)} x$ tiene período $2\\pi$.`,
          `En $a\\,${fnLatex(fn)}(kx)$ el período es $\\dfrac{2\\pi}{k}$; la amplitud $a$ no lo cambia.`,
          `Aquí $k = ${k}$: $\\dfrac{2\\pi}{${k}}$.`,
          "El período es:",
          piMath(answer),
        ],
        numericValues: [amplitude, k],
        problem: { variant, k },
        fallback: "none",
      });
    }

    if (variant === "graph-read") {
      const amplitude = rng.int(1, 4);
      // Periods of 4 or more leave numbered ticks between the zero crossings.
      const period = rng.pick([4, 6, 8]);
      // The sine passes the y axis at 0, so no crest covers the y-axis tick labels.
      const fn = "sin" as const;
      const askAmplitude = rng.int(0, 1) === 0;
      const answer = askAmplitude ? amplitude : period;
      const figure: FigureSpec = {
        kind: "function-plot",
        label: "Gráfica de una función sinusoidal",
        params: {
          xMin: -period,
          xMax: period,
          yMin: -amplitude - 1,
          yMax: amplitude + 1,
          xStep: period >= 6 ? 2 : 1,
          curves: [{ type: "sinusoid", fn, amplitude, period, shift: 0 }],
          points: [],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `La gráfica muestra $y = a\\,${fnLatex(fn)}(bx)$ con $a > 0$. ¿Cuál es ${askAmplitude ? "su amplitud $a$" : "su período"}?`,
          ),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors: askAmplitude
          ? [
              numberChoice(2 * amplitude, "gave-the-peak-to-trough-height"),
              numberChoice(period, "gave-the-period"),
              numberChoice(amplitude + 1, "read-the-window-edge"),
            ]
          : [
              numberChoice(period / 2, "gave-half-a-period"),
              numberChoice(2 * period, "counted-two-periods"),
              numberChoice(amplitude === period ? amplitude + 1 : amplitude, "gave-the-amplitude"),
            ],
        pool: [
          askAmplitude
            ? "La amplitud es la distancia del eje de la onda a un máximo."
            : "El período es la longitud horizontal de un ciclo completo.",
          askAmplitude
            ? `El valor máximo es $${amplitude}$ y el mínimo $${-amplitude}$.`
            : `Mide entre dos ${fn === "sin" ? "cortes ascendentes con el eje $x$" : "máximos consecutivos"}.`,
          askAmplitude
            ? `$a = \\dfrac{${amplitude} - (${-amplitude})}{2}$`
            : `Un ciclo completo mide $${period}$ unidades.`,
          "La respuesta es:",
          math(answer),
        ],
        numericValues: [amplitude, period],
        problem: { variant, ask: askAmplitude ? "amplitude" : "period", amplitude, period },
        fallback: "natural",
      });
    }

    // equation: fn x = value on [0, 2π), two solutions.
    const fn = rng.pick(["sin", "cos"] as const);
    const degrees = rng.pick(OFF_AXIS);
    const value = trigAt(fn, degrees);
    const valueText = exactText(value);
    const solutions = solutionsOf(fn, valueText);
    const reference = referenceAngle(degrees);
    const other = fn === "sin" ? "cos" : "sin";
    const wrongFunction = solutionsOf(other, valueText);
    const opposite = solutionsOf(fn, exactText(flip(value)));
    const coRef = 90 - reference;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `Resuelve $${fnLatex(fn)} x = ${exactMath(value).slice(1, -1)}$ para $0 \\le x < 2\\pi$.`,
        ),
      ],
      correct: angleSetChoice(solutions, "none"),
      distractors: [
        angleSetChoice([reference], "gave-only-the-reference-angle"),
        angleSetChoice(wrongFunction, "used-the-other-function"),
        angleSetChoice(opposite, "ignored-the-sign"),
        angleSetChoice([coRef, 180 - coRef], "confused-the-special-angles"),
      ],
      pool: [
        `El ángulo de referencia con $${fnLatex(fn)} x = ${exactMath({ coefficient: value.coefficient.abs(), radicand: value.radicand }).slice(1, -1)}$ es $${radianLatex(reference)}$.`,
        `La ${fnName(fn)} es ${value.coefficient.sign() > 0 ? "positiva" : "negativa"} en los cuadrantes ${fn === "sin" ? (value.coefficient.sign() > 0 ? "I y II" : "III y IV") : value.coefficient.sign() > 0 ? "I y IV" : "II y III"}.`,
        "Ubica el ángulo de referencia en cada uno de esos cuadrantes.",
        "Las soluciones en $[0, 2\\pi)$ son:",
        angleSetChoice(solutions, "none").display,
      ],
      numericValues: [],
      problem: { variant, fn, value: valueText },
      fallback: "none",
    });
  },
};
