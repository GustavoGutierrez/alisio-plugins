import type { FigureSpec } from "../figures/index.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { pointChoice, pointMath, pointText, surdChoice, surdMath, surdText } from "./exact.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "circle-center"
  | "circle-radius"
  | "circle-equation"
  | "general-center"
  | "general-radius"
  | "through-point"
  | "parabola-focus"
  | "parabola-directrix"
  | "parabola-graph";

/** `(x - h)` written with the sign a student reads: `(x - 3)`, `(x + 2)`, `x`. */
function shifted(variable: string, value: number): string {
  if (value === 0) return variable;
  return `(${variable} ${value > 0 ? "-" : "+"} ${Math.abs(value)})`;
}

/** `(x - h)^2 + (y - k)^2 = rr` as LaTeX. */
const circleLatex = (h: number, k: number, rr: number): string =>
  `${shifted("x", h)}^2 + ${shifted("y", k)}^2 = ${rr}`;

/** Canonical text of a circle equation: centre and squared radius. */
const circleText = (h: number, k: number, rr: number): string => `circle(${h},${k},${rr})`;

const circleChoice = (h: number, k: number, rr: number, error: string): OptionCandidate =>
  textChoice(circleText(h, k, rr), error, `$${circleLatex(h, k, rr)}$`);

/** `x² + y² + Dx + Ey + F = 0` as LaTeX, zero terms dropped. */
function generalLatex(d: number, e: number, f: number): string {
  const term = (coefficient: number, name: string) =>
    coefficient === 0
      ? ""
      : ` ${coefficient < 0 ? "-" : "+"} ${Math.abs(coefficient) === 1 && name !== "" ? "" : Math.abs(coefficient)}${name}`;
  return `x^2 + y^2${term(d, "x")}${term(e, "y")}${term(f, "")} = 0`;
}

/** A parabola `x² = c·y` or `y² = c·x` (vertex at the origin), `c = 4p`. */
interface Parabola {
  axis: "vertical" | "horizontal";
  c: number;
}

const parabolaLatex = ({ axis, c }: Parabola): string =>
  axis === "vertical" ? `x^2 = ${c}y` : `y^2 = ${c}x`;

/** The focus of a vertex-at-origin parabola: `(0, p)` or `(p, 0)` with `p = c / 4`. */
function focusOf({ axis, c }: Parabola): [Rational, Rational] {
  const p = Rational.of(c, 4);
  return axis === "vertical" ? [Rational.zero, p] : [p, Rational.zero];
}

const directrixText = ({ axis, c }: Parabola): string =>
  `${axis === "vertical" ? "y" : "x"}=${Rational.of(-c, 4).toString()}`;

const lineChoice = (name: "x" | "y", value: Rational, error: string): OptionCandidate =>
  textChoice(`${name}=${value.toString()}`, error, `$${name} = ${latexRational(value)}$`);

/** A centre off the axes and off the diagonals, so every sign or swap mistake is a new point. */
function centre(rng: Rng, high: number): [number, number] {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const h = rng.int(-high, high);
    const k = rng.int(-high, high);
    if (h !== 0 && k !== 0 && Math.abs(h) !== Math.abs(k)) return [h, k];
  }
  return [2, -3];
}

/** Circles and parabolas: centre, radius, equations, focus and directrix (DBA 10 #5). */
export const conics: Family = {
  id: "conics",
  solve(problem: Record<string, unknown>): Rational | string {
    const h = Number(problem.h);
    const k = Number(problem.k);
    const rr = Number(problem.rr);
    const parabola: Parabola = {
      axis: problem.axis === "horizontal" ? "horizontal" : "vertical",
      c: Number(problem.c),
    };
    switch (problem.variant as Variant) {
      case "circle-center":
        return pointText(h, k);
      case "circle-radius":
        return surdText(Rational.one, rr);
      case "circle-equation":
        return circleText(h, k, rr);
      case "general-center": {
        // x² + y² + Dx + Ey + F = 0 has centre (-D/2, -E/2).
        const d = Number(problem.d);
        const e = Number(problem.e);
        return pointText(Rational.of(-d, 2), Rational.of(-e, 2));
      }
      case "general-radius": {
        const d = Number(problem.d);
        const e = Number(problem.e);
        const f = Number(problem.f);
        // r² = (D/2)² + (E/2)² - F, an integer because D and E are even.
        return surdText(Rational.one, (d / 2) ** 2 + (e / 2) ** 2 - f);
      }
      case "through-point": {
        const dx = Number(problem.px) - h;
        const dy = Number(problem.py) - k;
        return surdText(Rational.one, dx * dx + dy * dy);
      }
      case "parabola-focus": {
        const [x, y] = focusOf(parabola);
        return pointText(x, y);
      }
      case "parabola-directrix":
        return directrixText(parabola);
      default:
        return `parabola(${parabola.axis},${parabola.c})`;
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["circle-center", "circle-radius", "circle-equation"],
        ["circle-equation", "general-center", "parabola-focus", "circle-radius"],
        ["general-center", "general-radius", "parabola-directrix", "parabola-focus"],
        ["general-radius", "through-point", "parabola-graph", "parabola-directrix"],
      ]),
    );
    const family = "conics";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const high = Math.min(6, Math.max(3, Math.floor(calibration.coefficientRange[1] / 2)));
    const [h, k] = centre(rng, Math.min(high, 5));

    if (variant.startsWith("parabola")) {
      const axis = rng.pick(["vertical", "horizontal"] as const);
      const sign = rng.pick([1, -1]);
      // The drawn parabola keeps p within 2 so the whole curve fits the grid.
      const sizes =
        variant === "parabola-graph"
          ? [2, 4, 6, 8]
          : index <= 1
            ? [4, 8, 12]
            : [2, 4, 6, 8, 12, 16];
      const c = sign * rng.pick(sizes);
      const parabola: Parabola = { axis, c };
      const [fx, fy] = focusOf(parabola);
      const p = Rational.of(c, 4);
      const name = axis === "vertical" ? "y" : "x";
      const other = axis === "vertical" ? "x" : "y";
      const problem = { variant, axis, c, h: 0, k: 0, rr: 0 };
      const pool = [
        `La parábola $${axis === "vertical" ? "x^2 = 4py" : "y^2 = 4px"}$ tiene vértice en el origen.`,
        `Su foco es $${axis === "vertical" ? "(0,\\ p)" : "(p,\\ 0)"}$ y su directriz $${name} = -p$.`,
        `Aquí $4p = ${c}$, así que $p = ${latexRational(p)}$.`,
        p.sign() > 0
          ? `La parábola abre hacia ${axis === "vertical" ? "arriba" : "la derecha"}.`
          : `La parábola abre hacia ${axis === "vertical" ? "abajo" : "la izquierda"}.`,
      ];
      if (variant === "parabola-graph") {
        // The figure draws the parabola, its focus and directrix; the student writes the equation.
        const options = (axisOf: "vertical" | "horizontal", value: number, error: string) =>
          textChoice(
            `parabola(${axisOf},${value})`,
            error,
            `$${parabolaLatex({ axis: axisOf, c: value })}$`,
          );
        const figure: FigureSpec = {
          kind: "conic",
          params: { shape: "parabola", h: 0, k: 0, p: p.toNumber(), axis },
        };
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              "La gráfica muestra una parábola con vértice en el origen, su foco $F$ y su directriz (recta discontinua). ¿Cuál es su ecuación?",
            ),
            { figure },
          ],
          correct: options(axis, c, "none"),
          distractors: [
            options(axis, -c, "wrong-opening-direction"),
            options(axis === "vertical" ? "horizontal" : "vertical", c, "swapped-the-axis"),
            options(axis, p.isInteger() ? Number(p.n) : 2 * c, "used-p-instead-of-4p"),
            options(axis, 2 * c, "used-2p-instead-of-4p"),
          ],
          pool: [
            "Lee las coordenadas del foco en la cuadrícula.",
            `$F = ${pointMath(fx, fy).slice(1, -1)}$, así que $p = ${latexRational(p)}$.`,
            `El eje de simetría es el eje ${axis === "vertical" ? "$y$" : "$x$"}.`,
            `$4p = ${c}$`,
            "La ecuación es:",
            `$${parabolaLatex(parabola)}$`,
          ],
          numericValues: [c],
          problem,
          fallback: "none",
        });
      }
      if (variant === "parabola-focus") {
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [ask(`¿Cuál es el foco de la parábola $${parabolaLatex(parabola)}$?`)],
          correct: pointChoice(fx, fy, "none"),
          distractors: [
            axis === "vertical"
              ? pointChoice(0, c, "forgot-to-divide-by-4")
              : pointChoice(c, 0, "forgot-to-divide-by-4"),
            pointChoice(fx.neg(), fy.neg(), "gave-the-directrix-side"),
            pointChoice(fy, fx, "swapped-the-coordinates"),
            axis === "vertical"
              ? pointChoice(0, Rational.of(c, 2), "divided-by-2")
              : pointChoice(Rational.of(c, 2), 0, "divided-by-2"),
          ],
          pool: [...pool, "El foco es:", pointMath(fx, fy)],
          numericValues: [c],
          problem,
          fallback: "none",
        });
      }
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es la directriz de la parábola $${parabolaLatex(parabola)}$?`)],
        correct: lineChoice(name, p.neg(), "none"),
        distractors: [
          lineChoice(name, p, "gave-the-focus-coordinate"),
          lineChoice(name, Rational.of(-c), "forgot-to-divide-by-4"),
          lineChoice(other, p.neg(), "swapped-the-axis"),
          lineChoice(name, Rational.of(-c, 2), "divided-by-2"),
        ],
        pool: [...pool, "La directriz es:", `$${name} = ${latexRational(p.neg())}$`],
        numericValues: [c],
        problem,
        fallback: "none",
      });
    }

    if (variant === "general-center" || variant === "general-radius") {
      // Centre (h, k) and r² chosen first, then expanded: D = -2h, E = -2k, F = h² + k² - r².
      const radical = variant === "general-radius" && index >= 3 && rng.int(0, 1) === 0;
      const limit = calibration.coefficientRange[1];
      // Redraw until D, E and F fit the level range; (1, -2) with r = 2 always fits.
      let [x0, y0, rr] = [1, -2, 4];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const [ch, ck] = centre(rng, 5);
        const r = rng.int(2, 6);
        let squared = radical ? r * r + rng.int(1, 2 * r) : r * r;
        if (radical && Number.isInteger(Math.sqrt(squared))) squared += 1;
        if (
          Math.abs(ch * ch + ck * ck - squared) <= limit &&
          2 * Math.max(Math.abs(ch), Math.abs(ck)) <= limit
        ) {
          [x0, y0, rr] = [ch, ck, squared];
          break;
        }
      }
      const [h, k] = [x0, y0];
      const d = -2 * h;
      const e = -2 * k;
      const f = h * h + k * k - rr;
      const equation = generalLatex(d, e, f);
      const pool = [
        "Agrupa los términos en $x$ y en $y$ y completa cuadrados.",
        `$\\left(x^2 ${d < 0 ? "-" : "+"} ${Math.abs(d)}x\\right) + \\left(y^2 ${e < 0 ? "-" : "+"} ${Math.abs(e)}y\\right) = ${-f}$`,
        `Suma $${h * h}$ y $${k * k}$ a ambos lados.`,
        `$${circleLatex(h, k, rr)}$`,
      ];
      if (variant === "general-center") {
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [ask(`¿Cuál es el centro de la circunferencia $${equation}$?`)],
          correct: pointChoice(h, k, "none"),
          distractors: [
            pointChoice(-h, -k, "kept-the-signs-of-d-and-e"),
            pointChoice(d, e, "forgot-to-halve"),
            pointChoice(-d, -e, "forgot-to-halve"),
            pointChoice(k, h, "swapped-the-coordinates"),
          ],
          pool: [...pool, "El centro es:", pointMath(h, k)],
          numericValues: [d, e, f],
          problem: { variant, d, e, f, h, k, rr },
          fallback: "none",
        });
      }
      const radiusChoices: OptionCandidate[] = [
        numberChoice(rr, "forgot-the-square-root"),
        surdChoice(Math.abs(f), "used-the-constant-term"),
        surdChoice(h * h + k * k + rr, "added-the-squares-twice"),
        numberChoice(Math.abs(h) + Math.abs(k), "added-the-centre-coordinates"),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es el radio de la circunferencia $${equation}$?`)],
        correct: surdChoice(rr, "none"),
        distractors: radiusChoices,
        pool: [...pool, `$r = \\sqrt{${rr}}$`, "El radio es:", surdMath(Rational.one, rr)],
        numericValues: [d, e, f],
        problem: { variant, d, e, f, h, k, rr },
        fallback: "none",
      });
    }

    if (variant === "through-point") {
      // A point on the circle a whole step away from the centre, so r² = dx² + dy².
      const dx = rng.pick([1, 2, 3, 4, -1, -2, -3]);
      const dy = rng.pick([1, 2, 3, -1, -2, -4]);
      const px = h + dx;
      const py = k + dy;
      const rr = dx * dx + dy * dy;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Una circunferencia tiene centro $C${pointMath(h, k).slice(1, -1)}$ y pasa por $P${pointMath(px, py).slice(1, -1)}$. ¿Cuál es su radio?`,
          ),
        ],
        correct: surdChoice(rr, "none"),
        distractors: [
          numberChoice(rr, "forgot-the-square-root"),
          numberChoice(Math.abs(dx) + Math.abs(dy), "added-the-differences"),
          surdChoice((px + h) ** 2 + (py + k) ** 2, "added-the-coordinates"),
          surdChoice(Math.abs(dx * dx - dy * dy) || 2, "subtracted-the-squares"),
          numberChoice(Math.max(Math.abs(dx), Math.abs(dy)), "used-the-larger-difference"),
          surdChoice(2 * rr, "doubled-the-squares"),
        ],
        pool: [
          "El radio es la distancia del centro a cualquier punto de la circunferencia.",
          "$r = \\sqrt{(x_P - h)^2 + (y_P - k)^2}$",
          `$r = \\sqrt{(${dx})^2 + (${dy})^2} = \\sqrt{${rr}}$`,
          "Simplifica la raíz si es posible.",
          "El radio es:",
          surdMath(Rational.one, rr),
        ],
        numericValues: [h, k, px, py],
        problem: { variant, h, k, px, py, rr },
        fallback: "none",
      });
    }

    // circle-center, circle-radius, circle-equation: the standard form (x - h)² + (y - k)² = r².
    // r² is written in the equation, so it stays inside the level's coefficient range.
    const r = rng.int(
      2,
      Math.max(2, Math.min(6, Math.floor(Math.sqrt(calibration.coefficientRange[1])))),
    );
    const rr = r * r;
    if (variant === "circle-equation") {
      const figure: FigureSpec = { kind: "conic", params: { shape: "circle", h, k, r } };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(`La circunferencia tiene centro $C$ y radio $r = ${r}$. ¿Cuál es su ecuación?`),
          { figure },
        ],
        correct: circleChoice(h, k, rr, "none"),
        distractors: [
          circleChoice(-h, -k, rr, "flipped-the-centre-signs"),
          circleChoice(h, k, r, "forgot-to-square-the-radius"),
          circleChoice(-h, -k, r, "flipped-signs-and-forgot-the-square"),
          circleChoice(k, h, rr, "swapped-the-coordinates"),
        ],
        pool: [
          "La ecuación de la circunferencia de centro $(h, k)$ y radio $r$ es $(x - h)^2 + (y - k)^2 = r^2$.",
          `En la cuadrícula, $C = ${pointMath(h, k).slice(1, -1)}$.`,
          `$r^2 = ${r}^2 = ${rr}$`,
          "Reemplaza $h$, $k$ y $r^2$ con cuidado con los signos.",
          "La ecuación es:",
          `$${circleLatex(h, k, rr)}$`,
        ],
        numericValues: [r],
        problem: { variant, h, k, rr },
        fallback: "none",
      });
    }
    const equation = circleLatex(h, k, rr);
    if (variant === "circle-center") {
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es el centro de la circunferencia $${equation}$?`)],
        correct: pointChoice(h, k, "none"),
        distractors: [
          pointChoice(-h, -k, "kept-the-signs-in-the-equation"),
          pointChoice(-h, k, "flipped-one-sign"),
          pointChoice(k, h, "swapped-the-coordinates"),
          pointChoice(h, -k, "flipped-one-sign"),
        ],
        pool: [
          "Compara con $(x - h)^2 + (y - k)^2 = r^2$.",
          `$${shifted("x", h)}$ indica $h = ${h}$.`,
          `$${shifted("y", k)}$ indica $k = ${k}$.`,
          "El centro es:",
          pointMath(h, k),
        ],
        numericValues: [h, k, rr],
        problem: { variant, h, k, rr },
        fallback: "none",
      });
    }
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(`¿Cuál es el radio de la circunferencia $${equation}$?`)],
      correct: numberChoice(r, "none"),
      distractors: [
        numberChoice(rr, "forgot-the-square-root"),
        numberChoice(Rational.of(rr, 2), "halved-instead-of-root"),
        numberChoice(2 * r, "gave-the-diameter"),
      ],
      pool: [
        "Compara con $(x - h)^2 + (y - k)^2 = r^2$.",
        `$r^2 = ${rr}$`,
        `$r = \\sqrt{${rr}}$`,
        "El radio es:",
        math(r),
      ],
      numericValues: [h, k, rr],
      problem: { variant, h, k, rr },
      fallback: "natural",
    });
  },
};
