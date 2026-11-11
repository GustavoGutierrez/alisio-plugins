import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "read-point" | "which-point" | "quadrant" | "distance" | "fourth-vertex";

const NAMES = ["A", "B", "C", "D"];
const QUADRANTS = ["I", "II", "III", "IV"];

const pairText = (x: number, y: number): string => `(${x},${y})`;
const pairMath = (x: number, y: number): string => `$(${x},\\ ${y})$`;
const pairChoice = (x: number, y: number, error: string): OptionCandidate =>
  textChoice(pairText(x, y), error, pairMath(x, y));

export function quadrantOf(x: number, y: number): string {
  if (x > 0) return y > 0 ? "I" : "IV";
  return y > 0 ? "II" : "III";
}

/** Locating points on the plane: the first quadrant at basico, all four from intermedio (DBA 5 #7). */
export const coordinates: Family = {
  id: "coordinates",
  solve(problem: Record<string, unknown>): Rational | string {
    const points = problem.points as Array<{ x: number; y: number }>;
    const target = points[Number(problem.target)] ?? { x: 0, y: 0 };
    switch (problem.variant as Variant) {
      case "read-point":
        return pairText(target.x, target.y);
      case "which-point":
        return NAMES[Number(problem.target)] ?? "";
      case "quadrant":
        return quadrantOf(target.x, target.y);
      case "distance": {
        const [p, q] = points;
        return Rational.of(
          Math.abs((p?.x ?? 0) - (q?.x ?? 0)) + Math.abs((p?.y ?? 0) - (q?.y ?? 0)),
        );
      }
      default: {
        const [p, q, r] = points;
        return pairText(
          (p?.x ?? 0) + (r?.x ?? 0) - (q?.x ?? 0),
          (p?.y ?? 0) + (r?.y ?? 0) - (q?.y ?? 0),
        );
      }
    }
  },
  generate(context: FamilyContext): ItemDraft {
    const { rng, level } = context;
    const index = levelIndex(level);
    const max = index === 0 ? Math.min(8, Math.floor(context.calibration.coefficientRange[1])) : 6;
    const min = index === 0 ? 0 : -max;
    const variants = tier<Variant>(index, [
      ["read-point", "which-point"],
      ["read-point", "which-point", "quadrant"],
      ["read-point", "quadrant", "distance"],
      ["distance", "fourth-vertex", "read-point"],
    ]);
    const variant = rng.pick(variants);
    const value = (nonZero: boolean) => {
      let v = rng.int(min, max);
      if (nonZero && v === 0) v = index === 0 ? 1 : rng.pick([-1, 1]) * rng.int(1, max);
      return v;
    };
    const quadrantFigure = index === 0 ? 1 : 4;

    if (variant === "read-point" || variant === "which-point") {
      const x = value(true);
      let y = value(true);
      if (y === x) y = x === max ? x - 1 : x + 1;
      const taken = new Set([pairText(x, y)]);
      const others: Array<{ x: number; y: number; error: string }> = [];
      const push = (px: number, py: number, error: string) => {
        if (px < min || px > max || py < min || py > max || taken.has(pairText(px, py))) return;
        taken.add(pairText(px, py));
        others.push({ x: px, y: py, error });
      };
      push(y, x, "swapped-the-coordinates");
      if (index > 0) push(-x, y, "sign-error");
      push(x + 1, y, "off-by-one");
      push(x, y - 1, "off-by-one");
      push(x - 1, y + 1, "off-by-one");
      push(x - 1, y, "off-by-one");
      push(x, y + 1, "off-by-one");
      push(x + 1, y + 1, "off-by-one");
      const plotted = [{ x, y }, ...others.slice(0, 3)];
      const order = rng.shuffle(plotted.map((_, position) => position));
      const points = order.map((position) => plotted[position] ?? { x: 0, y: 0 });
      const target = order.indexOf(0);
      const figure: FigureSpec = {
        kind: "coordinate-grid",
        params: {
          max,
          quadrants: quadrantFigure,
          points: points.map((point, position) => ({ ...point, name: NAMES[position] ?? "" })),
        },
      };
      if (variant === "read-point") {
        return finishDraft({
          family: "coordinates",
          level,
          rng,
          calibration: context.calibration,
          stem: [
            prompt(
              context.rng,
              context.prompts,
              `¿Cuáles son las coordenadas del punto ${NAMES[target]}?`,
              "",
            ),
            { figure },
          ],
          correct: pairChoice(x, y, "none"),
          distractors: [
            pairChoice(y, x, "swapped-the-coordinates"),
            ...(index > 0
              ? [pairChoice(-x, y, "sign-error"), pairChoice(x, -y, "sign-error")]
              : []),
            pairChoice(x + 1, y, "off-by-one"),
            pairChoice(x, y + 1, "off-by-one"),
          ],
          pool: [
            "La primera coordenada se lee en el eje horizontal ($x$).",
            "La segunda coordenada se lee en el eje vertical ($y$).",
            `El punto ${NAMES[target]} está sobre $x = ${x}$.`,
            `El punto ${NAMES[target]} está a la altura $y = ${y}$.`,
            "Las coordenadas son:",
            pairMath(x, y),
          ],
          numericValues: points.flatMap((point) => [point.x, point.y]),
          problem: { variant, points, target },
          fallback: "none",
        });
      }
      return finishDraft({
        family: "coordinates",
        level,
        rng,
        calibration: context.calibration,
        stem: [
          prompt(context.rng, context.prompts, `¿Qué punto está en {expr}?`, pairMath(x, y)),
          { figure },
        ],
        correct: textChoice(NAMES[target] ?? "A", "none", `Punto ${NAMES[target]}`),
        distractors: points.flatMap((point, position) =>
          position === target
            ? []
            : [
                textChoice(
                  NAMES[position] ?? "",
                  others.find((other) => other.x === point.x && other.y === point.y)?.error ??
                    "off-by-one",
                  `Punto ${NAMES[position]}`,
                ),
              ],
        ),
        pool: [
          `Ubica $x = ${x}$ en el eje horizontal.`,
          `Sube o baja hasta $y = ${y}$.`,
          "Busca el punto que está en ese cruce.",
          "El punto es:",
          NAMES[target] ?? "",
        ],
        numericValues: [x, y],
        problem: { variant, points, target },
        fallback: "none",
      });
    }

    if (variant === "quadrant") {
      const x = value(true) || 1;
      const y = value(true) || 1;
      const answer = quadrantOf(x, y);
      return finishDraft({
        family: "coordinates",
        level,
        rng,
        calibration: context.calibration,
        stem: [
          prompt(rng, context.prompts, "¿En qué cuadrante está el punto {expr}?", pairMath(x, y)),
        ],
        correct: textChoice(answer, "none", `Cuadrante ${answer}`),
        distractors: QUADRANTS.filter((entry) => entry !== answer).map((entry) =>
          textChoice(
            entry,
            entry === quadrantOf(y, x) ? "swapped-the-coordinates" : "sign-error",
            `Cuadrante ${entry}`,
          ),
        ),
        pool: [
          "Cuadrante I: $x > 0$ y $y > 0$; II: $x < 0$ y $y > 0$.",
          "Cuadrante III: $x < 0$ y $y < 0$; IV: $x > 0$ y $y < 0$.",
          `El signo de $x$ es ${x > 0 ? "positivo" : "negativo"} y el de $y$ es ${y > 0 ? "positivo" : "negativo"}.`,
          "El cuadrante es:",
          answer,
        ],
        numericValues: [x, y],
        problem: { variant, points: [{ x, y }], target: 0 },
        fallback: "none",
      });
    }

    if (variant === "distance") {
      const x = value(false);
      const y1 = value(true);
      let y2 = value(true);
      if (y2 === y1) y2 = -y1 || 1;
      const vertical = rng.int(0, 1) === 1;
      const p = vertical ? { x, y: y1 } : { x: y1, y: x };
      const q = vertical ? { x, y: y2 } : { x: y2, y: x };
      const answer = Math.abs(y1 - y2);
      return finishDraft({
        family: "coordinates",
        level,
        rng,
        calibration: context.calibration,
        stem: [
          prompt(
            rng,
            context.prompts,
            "¿Cuántas unidades hay entre los puntos {expr}?",
            `${pairMath(p.x, p.y)} y ${pairMath(q.x, q.y)}`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Math.abs(Math.abs(y1) - Math.abs(y2)) || answer + 2, "ignored-the-signs"),
          numberChoice(
            Math.abs(y1) + Math.abs(y2) === answer ? answer + 1 : Math.abs(y1) + Math.abs(y2),
            "added-the-coordinates",
          ),
          numberChoice(Math.abs(y1 + y2) || answer + 3, "added-the-coordinates"),
        ],
        pool: [
          vertical
            ? "Los dos puntos tienen la misma $x$: están en una línea vertical."
            : "Los dos puntos tienen la misma $y$: están en una línea horizontal.",
          "La distancia es la diferencia entre las coordenadas que cambian.",
          `$|${y1} - (${y2})| = ${answer}$`,
          "La distancia es:",
          math(answer),
        ],
        numericValues: [x, y1, y2],
        problem: { variant, points: [p, q], target: 0 },
      });
    }

    // Fourth vertex of a rectangle with sides parallel to the axes: P, Q (the corner), R.
    const x1 = value(false);
    let x2 = value(false);
    if (x2 === x1) x2 = x1 === max ? x1 - 2 : x1 + 2;
    const y1 = value(false);
    let y2 = value(false);
    if (y2 === y1) y2 = y1 === max ? y1 - 2 : y1 + 2;
    const points = [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
    ];
    const figure: FigureSpec = {
      kind: "coordinate-grid",
      params: {
        max,
        quadrants: 4,
        points: points.map((point, position) => ({ ...point, name: NAMES[position] ?? "" })),
      },
    };
    return finishDraft({
      family: "coordinates",
      level,
      rng,
      calibration: context.calibration,
      stem: [
        prompt(
          rng,
          context.prompts,
          "Los puntos $A$, $B$ y $C$ son tres vértices de un rectángulo con lados paralelos a los ejes. ¿Cuáles son las coordenadas del cuarto vértice $D$?",
          "",
        ),
        { figure },
      ],
      correct: pairChoice(x1, y2, "none"),
      distractors: [
        pairChoice(y2, x1, "swapped-the-coordinates"),
        pairChoice(x2, y1, "copied-a-vertex"),
        pairChoice(-x1, y2, "sign-error"),
        pairChoice(x1, -y2, "sign-error"),
        pairChoice(x2, y2, "copied-a-vertex"),
        pairChoice(x1 + 1, y2, "off-by-one"),
        pairChoice(x1, y2 + 1, "off-by-one"),
      ],
      pool: [
        "En un rectángulo con lados paralelos a los ejes, los vértices comparten coordenadas.",
        `$D$ tiene la misma $x$ que $A$: $x = ${x1}$.`,
        `$D$ tiene la misma $y$ que $C$: $y = ${y2}$.`,
        "Las coordenadas de $D$ son:",
        pairMath(x1, y2),
      ],
      numericValues: points.flatMap((point) => [point.x, point.y]),
      problem: { variant, points, target: 0 },
      fallback: "none",
    });
  },
};
