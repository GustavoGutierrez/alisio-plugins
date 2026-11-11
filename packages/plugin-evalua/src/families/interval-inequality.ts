import type { FigureSpec } from "../figures/index.js";
import {
  allEnds,
  complement,
  intervalChoice,
  intervalFigure,
  intervalLatex,
  intervalText,
  type Span,
  span,
} from "./intervals.js";
import { finishDraft, levelIndex, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { linearText, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "to-interval"
  | "read-interval"
  | "double"
  | "compound"
  | "abs-less"
  | "abs-greater"
  | "abs-linear";
type Relation = "<" | "<=" | ">" | ">=";

const latexRelation = (relation: Relation): string =>
  relation === "<=" ? "\\le" : relation === ">=" ? "\\ge" : relation;

const closed = (relation: Relation): boolean => relation === "<=" || relation === ">=";

/** The ray `x relation a`. */
const ray = (relation: Relation, a: number): Span =>
  relation === "<" || relation === "<="
    ? span(null, a, false, closed(relation))
    : span(a, null, closed(relation), false);

/** Every finite end moved by `by`, the brackets kept: a misread tick. */
const shifted = (parts: readonly Span[], by: number): Span[] =>
  parts.map((part) =>
    span(
      part.from === null ? null : part.from + by,
      part.to === null ? null : part.to + by,
      part.fromClosed,
      part.toClosed,
    ),
  );

/** `|x - c|` written with the sign a student reads. */
const absInner = (a: number, c: number): string => linearText(a, -a * c);

/** The solution set of `|a x - a c| rel a w`: a band (less) or two rays (greater). */
function absSolution(c: number, w: number, relation: Relation): Span[] {
  const band = span(c - w, c + w, closed(relation), closed(relation));
  if (relation === "<" || relation === "<=") return [band];
  return complement(span(c - w, c + w, !closed(relation), !closed(relation)));
}

/** Interval notation, double and compound inequalities and absolute-value inequalities (10th). */
export const intervalInequality: Family = {
  id: "interval-inequality",
  solve(problem: Record<string, unknown>): string {
    const relation = problem.relation as Relation;
    const a = Number(problem.a);
    const b = Number(problem.b);
    switch (problem.variant as Variant) {
      case "to-interval":
        return intervalText([ray(relation, a)]);
      case "read-interval":
        return intervalText(
          (problem.parts as Span[]).map((part) =>
            span(part.from, part.to, part.fromClosed, part.toClosed),
          ),
        );
      case "double":
        return intervalText([span(a, b, closed(relation), closed(problem.relation2 as Relation))]);
      case "compound": {
        // low rel1 m x + n rel2 high, with m > 0: (low - n) / m and (high - n) / m.
        const m = Number(problem.m);
        const n = Number(problem.n);
        return intervalText([
          span((a - n) / m, (b - n) / m, closed(relation), closed(problem.relation2 as Relation)),
        ]);
      }
      default:
        return intervalText(absSolution(Number(problem.c), Number(problem.w), relation));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["to-interval", "read-interval"],
        ["double", "read-interval", "compound", "to-interval"],
        ["abs-less", "abs-greater", "compound"],
        ["abs-linear", "abs-greater", "abs-less"],
      ]),
    );
    const family = "interval-inequality";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const high = Math.min(9, Math.max(4, calibration.coefficientRange[1]));
    const relation = rng.pick(["<", "<=", ">", ">="] as const);

    if (variant === "to-interval") {
      const a = rng.int(-high, high);
      const answer = [ray(relation, a)];
      const reversed: Relation =
        relation === "<" ? ">" : relation === "<=" ? ">=" : relation === ">" ? "<" : "<=";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Escribe en notación de intervalo el conjunto de los $x$ con $x ${latexRelation(relation)} ${a}$.`,
          ),
        ],
        correct: intervalChoice(answer, "none"),
        distractors: [
          intervalChoice([ray(reversed, a)], "reversed-the-direction"),
          intervalChoice(
            allEnds(answer, !closed(relation)),
            closed(relation) ? "excluded-the-endpoint" : "included-the-endpoint",
          ),
          intervalChoice(
            allEnds([ray(reversed, a)], !closed(relation)),
            "reversed-and-wrong-bracket",
          ),
          intervalChoice([ray(relation, -a === a ? a + 1 : -a)], "sign-error"),
        ],
        pool: [
          `$x ${latexRelation(relation)} ${a}$ ${relation.startsWith("<") ? "va hacia la izquierda" : "va hacia la derecha"} en la recta.`,
          closed(relation)
            ? `El extremo $${a}$ se incluye: corchete.`
            : `El extremo $${a}$ no se incluye: paréntesis.`,
          "Del lado infinito siempre va paréntesis.",
          "El intervalo es:",
          `$${intervalLatex(answer)}$`,
        ],
        numericValues: [a],
        problem: { variant, relation, a, b: 0 },
        fallback: "none",
      });
    }

    if (variant === "read-interval") {
      const width = rng.int(2, 6);
      const left = rng.int(-high, high - width);
      const kind = rng.pick(["band", "left-ray", "right-ray"] as const);
      const fromClosed = rng.int(0, 1) === 0;
      const toClosed = rng.int(0, 1) === 0;
      const answer: Span[] =
        kind === "band"
          ? [span(left, left + width, fromClosed, toClosed)]
          : kind === "left-ray"
            ? [span(null, left, false, toClosed)]
            : [span(left, null, fromClosed, false)];
      const [part] = answer;
      const flipped = answer.map((entry) =>
        span(entry.from, entry.to, !entry.fromClosed, !entry.toClosed),
      );
      const figure: FigureSpec = { kind: "number-line", params: intervalFigure(answer) };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            "¿Qué intervalo está representado en la recta numérica? (Punto relleno: incluido; punto hueco: excluido.)",
          ),
          { figure },
        ],
        correct: intervalChoice(answer, "none"),
        distractors: [
          intervalChoice(flipped, "swapped-open-and-closed"),
          intervalChoice(allEnds(answer, true), "closed-every-end"),
          intervalChoice(allEnds(answer, false), "opened-every-end"),
          intervalChoice(part === undefined ? answer : complement(part), "gave-the-complement"),
          intervalChoice(shifted(answer, 1), "misread-the-endpoint"),
          intervalChoice(shifted(answer, -1), "misread-the-endpoint"),
        ],
        pool: [
          "Lee los extremos de la parte sombreada.",
          "Un punto relleno se escribe con corchete; uno hueco, con paréntesis.",
          "Una flecha indica que el intervalo sigue hasta el infinito.",
          "El intervalo es:",
          `$${intervalLatex(answer)}$`,
        ],
        numericValues: [left, left + width],
        problem: { variant, relation: "<", a: 0, b: 0, parts: answer },
        fallback: "none",
      });
    }

    if (variant === "double" || variant === "compound") {
      const relation2 = rng.pick(["<", "<="] as const);
      const relation1 = rng.pick(["<", "<="] as const);
      const limit = calibration.coefficientRange[1];
      const m = variant === "compound" ? rng.int(2, 4) : 1;
      const n = variant === "compound" ? rng.int(-6, 6) : 0;
      // Both written bounds m·x + n stay inside the level range.
      const reach = Math.max(1, Math.floor((limit - Math.abs(n)) / m));
      const widthX = rng.int(2, Math.min(6, 2 * reach));
      const lowX = rng.int(-reach, reach - widthX);
      const highX = lowX + widthX;
      const low = m * lowX + n;
      const top = m * highX + n;
      const answer = [span(lowX, highX, closed(relation1), closed(relation2))];
      const middle = variant === "compound" ? linearText(m, n) : "x";
      const distractors: OptionCandidate[] = [
        intervalChoice(
          [span(lowX, highX, closed(relation2), closed(relation1))],
          "swapped-the-brackets",
        ),
        intervalChoice(complement(answer[0] ?? span(0, 1)), "gave-the-complement"),
        intervalChoice(allEnds(answer, !closed(relation1)), "wrong-brackets"),
        intervalChoice(
          [span(lowX, highX, !closed(relation1), closed(relation2))],
          "wrong-bracket-on-one-end",
        ),
        intervalChoice(
          [span(lowX, highX, closed(relation1), !closed(relation2))],
          "wrong-bracket-on-one-end",
        ),
      ];
      if (variant === "compound") {
        distractors.unshift(
          intervalChoice(
            [span(low - n, top - n, closed(relation1), closed(relation2))],
            "forgot-to-divide",
          ),
        );
        distractors.unshift(
          intervalChoice(
            [span(low / m - n, top / m - n, closed(relation1), closed(relation2))].filter(
              (part) => Number.isInteger(part.from) && Number.isInteger(part.to),
            ),
            "divided-before-subtracting",
          ),
        );
      }
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Escribe en notación de intervalo la solución de $${low} ${latexRelation(relation1)} ${middle} ${latexRelation(relation2)} ${top}$.`,
          ),
        ],
        correct: intervalChoice(answer, "none"),
        distractors: distractors.filter((choice) => choice.value !== ""),
        pool: [
          variant === "compound"
            ? `Resta $${n}$ en las tres partes: $${low - n} ${latexRelation(relation1)} ${m}x ${latexRelation(relation2)} ${top - n}$.`
            : "La variable está entre dos números.",
          variant === "compound"
            ? `Divide entre $${m}$ (positivo, no cambia el sentido): $${lowX} ${latexRelation(relation1)} x ${latexRelation(relation2)} ${highX}$.`
            : "Cada extremo conserva su propio signo de desigualdad.",
          "$\\le$ se escribe con corchete y $<$ con paréntesis.",
          "El intervalo es:",
          `$${intervalLatex(answer)}$`,
        ],
        numericValues: variant === "compound" ? [low, m, n, top] : [low, top],
        problem:
          variant === "compound"
            ? { variant, relation: relation1, relation2, a: low, b: top, m, n }
            : { variant, relation: relation1, relation2, a: low, b: top },
        fallback: "none",
      });
    }

    // abs-less, abs-greater, abs-linear: |a x - a c| rel a w.
    const absRelation: Relation =
      variant === "abs-less"
        ? rng.pick(["<", "<="] as const)
        : variant === "abs-greater"
          ? rng.pick([">", ">="] as const)
          : relation;
    const a = variant === "abs-linear" ? rng.pick([2, 3]) : 1;
    const c = rng.int(-5, 5);
    const w = rng.int(1, 6);
    const answer = absSolution(c, w, absRelation);
    const less = absRelation === "<" || absRelation === "<=";
    const other: Relation = less
      ? absRelation === "<"
        ? ">"
        : ">="
      : absRelation === ">"
        ? "<"
        : "<=";
    const distractors: OptionCandidate[] = [
      intervalChoice(
        absSolution(c, w, other),
        less ? "used-the-union-for-less-than" : "used-the-band-for-greater-than",
      ),
      intervalChoice(absSolution(-c, w, absRelation), "sign-error-in-the-centre"),
      intervalChoice(allEnds(answer, !closed(absRelation)), "wrong-brackets"),
    ];
    if (a > 1)
      distractors.unshift(
        intervalChoice(absSolution(c, a * w, absRelation), "forgot-to-divide-by-the-coefficient"),
      );
    else
      distractors.push(
        intervalChoice(
          less
            ? [span(null, c + w, false, closed(absRelation))]
            : [span(c + w, null, closed(absRelation), false)],
          "dropped-the-negative-case",
        ),
      );
    if (c === 0) distractors.push(intervalChoice(absSolution(c, w + 1, absRelation), "off-by-one"));
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `Resuelve $\\left|${absInner(a, c)}\\right| ${latexRelation(absRelation)} ${a * w}$ y escribe la solución en notación de intervalo.`,
        ),
      ],
      correct: intervalChoice(answer, "none"),
      distractors,
      pool: [
        less
          ? `$|u| ${latexRelation(absRelation)} r$ equivale a $-r ${latexRelation(absRelation === "<" ? "<" : "<=")} u ${latexRelation(absRelation === "<" ? "<" : "<=")} r$.`
          : `$|u| ${latexRelation(absRelation)} r$ equivale a $u ${latexRelation(absRelation === ">" ? "<" : "<=")} -r$ o $u ${latexRelation(absRelation)} r$.`,
        `$${-a * w} \\ \\text{y}\\ ${a * w}$ son los límites para $${absInner(a, c)}$.`,
        a > 1 ? `Suma $${a * c}$ y divide entre $${a}$.` : `Suma $${c}$ en cada parte.`,
        `Los extremos son $${c - w}$ y $${c + w}$.`,
        "La solución es:",
        `$${intervalLatex(answer)}$`,
      ],
      numericValues: [a, a * c, a * w],
      problem: { variant, relation: absRelation, a: 0, b: 0, c, w },
      fallback: "none",
    });
  },
};
