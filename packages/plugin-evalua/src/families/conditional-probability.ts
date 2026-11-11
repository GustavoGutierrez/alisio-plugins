import type { FigureSpec } from "../figures/index.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "table"
  | "table-joint"
  | "formula"
  | "without-replacement"
  | "independence"
  | "bayes";

/**
 * Two-way table contexts: the row groups (A, not A) and column groups (B, not B). `a` / `b` describe
 * a chosen person (indicative); `aAsked` / `bAsked` follow "la probabilidad de que" (subjunctive).
 */
const TABLES = [
  {
    intro:
      "En un colegio se preguntó a los estudiantes de décimo y undécimo si practican algún deporte.",
    rows: ["Décimo", "Undécimo"],
    columns: ["Practica deporte", "No practica"],
    a: "es de décimo",
    b: "practica deporte",
    aAsked: "sea de décimo",
    bAsked: "practique deporte",
  },
  {
    intro:
      "Una encuesta registró si los clientes de una tienda pagaron con tarjeta o en efectivo, según el día.",
    rows: ["Entre semana", "Fin de semana"],
    columns: ["Tarjeta", "Efectivo"],
    a: "compró entre semana",
    b: "pagó con tarjeta",
    aAsked: "haya comprado entre semana",
    bAsked: "haya pagado con tarjeta",
  },
  {
    intro:
      "Se clasificó a los asistentes a un concierto según si llegaron en bus y si compraron la boleta en línea.",
    rows: ["Llegó en bus", "No llegó en bus"],
    columns: ["Boleta en línea", "Boleta en taquilla"],
    a: "llegó en bus",
    b: "compró la boleta en línea",
    aAsked: "haya llegado en bus",
    bAsked: "haya comprado la boleta en línea",
  },
];

const fraction = (value: Rational): string => latexRational(value);

/** Conditional probability from tables, the formula, draws and independence (DBA 11 #10). */
export const conditionalProbability: Family = {
  id: "conditional-probability",
  solve(problem: Record<string, unknown>): Rational | string {
    const cells = (problem.cells as unknown[] | undefined)?.map(Number) ?? [];
    const [ab = 0, anb = 0, nab = 0, nanb = 0] = cells;
    switch (problem.variant as Variant) {
      case "table":
        // P(A | B) or P(B | A): the shared cell over the given group's total.
        return problem.given === "B" ? Rational.of(ab, ab + nab) : Rational.of(ab, ab + anb);
      case "table-joint":
        return Rational.of(ab, ab + anb + nab + nanb);
      case "formula":
        return Rational.parse(String(problem.joint)).div(Rational.parse(String(problem.pb)));
      case "without-replacement": {
        const red = Number(problem.red);
        const total = Number(problem.total);
        return Rational.of(red - 1, total - 1);
      }
      case "independence": {
        const pa = Rational.parse(String(problem.pa));
        const pb = Rational.parse(String(problem.pb));
        const joint = Rational.parse(String(problem.joint));
        return pa.mul(pb).equals(joint) ? "yes" : "no";
      }
      default: {
        // P(A | D) = P(A) P(D | A) / [P(A) P(D | A) + P(B) P(D | B)].
        const share = Rational.of(Number(problem.share), 100);
        const da = Rational.of(Number(problem.da), 100);
        const db = Rational.of(Number(problem.db), 100);
        const fromA = share.mul(da);
        return fromA.div(fromA.add(Rational.one.sub(share).mul(db)));
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["table", "table-joint"],
        ["table", "formula", "without-replacement"],
        ["table", "independence", "without-replacement", "formula"],
        ["bayes", "independence", "table", "formula"],
      ]),
    );
    const family = "conditional-probability";
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (variant === "table" || variant === "table-joint") {
      const context = rng.pick(TABLES);
      const high = Math.min(40, Math.max(12, calibration.coefficientRange[1]));
      const cells = Array.from({ length: 4 }, () => rng.int(3, high));
      // Different off-diagonal cells keep P(A | B) and P(B | A) apart.
      if (cells[1] === cells[2]) cells[2] = (cells[2] ?? 3) + (cells[2] === high ? -1 : 1);
      const [ab = 1, anb = 1, nab = 1, nanb = 1] = cells;
      const total = ab + anb + nab + nanb;
      const table = {
        table: {
          head: ["", context.columns[0] ?? "", context.columns[1] ?? "", "Total"],
          rows: [
            [context.rows[0] ?? "", `$${ab}$`, `$${anb}$`, `$${ab + anb}$`],
            [context.rows[1] ?? "", `$${nab}$`, `$${nanb}$`, `$${nab + nanb}$`],
            ["Total", `$${ab + nab}$`, `$${anb + nanb}$`, `$${total}$`],
          ],
        },
      };
      if (variant === "table-joint") {
        const answer = Rational.of(ab, total);
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              `${context.intro} Si se elige una persona al azar, ¿cuál es la probabilidad de que ${context.aAsked} y ${context.bAsked}?`,
            ),
            table,
          ],
          correct: numberChoice(answer, "none"),
          distractors: [
            numberChoice(Rational.of(ab, ab + nab), "conditioned-on-the-column"),
            numberChoice(Rational.of(ab, ab + anb), "conditioned-on-the-row"),
            numberChoice(Rational.of(ab + anb + nab, total), "computed-the-union"),
            numberChoice(Rational.of(ab + anb, total), "gave-a-marginal"),
          ],
          pool: [
            "Busca la celda donde se cumplen las dos condiciones.",
            `Casos favorables: $${ab}$.`,
            `Total de personas: $${total}$.`,
            `$P = \\dfrac{${ab}}{${total}}$`,
            "La probabilidad es:",
            math(answer),
          ],
          numericValues: [ab, anb, nab, nanb],
          problem: { variant, cells },
          fallback: "none",
        });
      }
      const given = rng.pick(["A", "B"] as const);
      const answer = given === "B" ? Rational.of(ab, ab + nab) : Rational.of(ab, ab + anb);
      const [condition, event] =
        given === "B" ? [context.b, context.aAsked] : [context.a, context.bAsked];
      const groupTotal = given === "B" ? ab + nab : ab + anb;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `${context.intro} Se elige al azar una persona que ${condition}. ¿Cuál es la probabilidad de que ${event}?`,
          ),
          table,
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(ab, total), "used-the-grand-total"),
          numberChoice(
            given === "B" ? Rational.of(ab, ab + anb) : Rational.of(ab, ab + nab),
            "reversed-the-condition",
          ),
          numberChoice(
            given === "B" ? Rational.of(ab + anb, total) : Rational.of(ab + nab, total),
            "ignored-the-condition",
          ),
          numberChoice(Rational.of(given === "B" ? nab : anb, groupTotal), "took-the-other-cell"),
          numberChoice(Rational.of(groupTotal, total), "gave-the-probability-of-the-condition"),
          numberChoice(Rational.of(ab, total - ab), "divided-by-the-rest"),
          numberChoice(Rational.of(given === "B" ? anb : nab, total), "took-the-wrong-cell"),
          numberChoice(Rational.of(nanb, total), "took-the-wrong-cell"),
        ],
        pool: [
          "La condición reduce el espacio muestral al grupo dado.",
          `Personas que ${condition}: $${groupTotal}$.`,
          `Casos favorables dentro de ese grupo: $${ab}$.`,
          `$P = \\dfrac{${ab}}{${groupTotal}}$`,
          "La probabilidad condicional es:",
          math(answer),
        ],
        numericValues: [ab, anb, nab, nanb],
        problem: { variant, cells, given },
        fallback: "none",
      });
    }

    if (variant === "formula") {
      // P(B) and P(A ∩ B) in tenths or hundredths, with P(A ∩ B) < P(B).
      // Hundredths only where the level range admits the counts written in them.
      const denominator = rng.pick(
        calibration.coefficientRange[1] >= 100 ? [10, 20, 100] : [10, 20],
      );
      const pbCount = rng.int(Math.ceil(denominator / 5), Math.floor((denominator * 4) / 5));
      const jointCount = rng.int(1, pbCount - 1);
      const pb = Rational.of(pbCount, denominator);
      const joint = Rational.of(jointCount, denominator);
      const answer = joint.div(pb);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Si $P(B) = ${fraction(pb)}$ y $P(A \\cap B) = ${fraction(joint)}$, ¿cuánto vale $P(A \\mid B)$?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(joint.mul(pb), "multiplied-instead-of-dividing"),
          numberChoice(pb.div(joint), "inverted-the-quotient"),
          numberChoice(pb.sub(joint), "subtracted-the-probabilities"),
          numberChoice(joint, "gave-the-joint-probability"),
        ],
        pool: [
          "Definición: $P(A \\mid B) = \\dfrac{P(A \\cap B)}{P(B)}$.",
          `$P(A \\mid B) = \\dfrac{${fraction(joint)}}{${fraction(pb)}}$`,
          "Divide y simplifica.",
          "La probabilidad condicional es:",
          math(answer),
        ],
        numericValues: [pbCount, jointCount],
        problem: { variant, pb: pb.toString(), joint: joint.toString() },
        fallback: "none",
      });
    }

    if (variant === "without-replacement") {
      const red = rng.int(3, 9);
      const blue = rng.int(2, 9);
      const total = red + blue;
      const answer = Rational.of(red - 1, total - 1);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Una caja tiene $${red}$ fichas rojas y $${blue}$ azules. Se sacan dos fichas sin reemplazo. Si la primera fue roja, ¿cuál es la probabilidad de que la segunda también sea roja?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(red, total), "put-the-first-back"),
          numberChoice(Rational.of(red - 1, total), "kept-the-total"),
          numberChoice(
            Rational.of(red * (red - 1), total * (total - 1)),
            "gave-the-joint-probability",
          ),
          numberChoice(Rational.of(red, total - 1), "kept-the-red-count"),
        ],
        pool: [
          "Saber que la primera fue roja cambia la caja.",
          `Quedan $${total - 1}$ fichas, de ellas $${red - 1}$ rojas.`,
          `$P(R_2 \\mid R_1) = \\dfrac{${red - 1}}{${total - 1}}$`,
          "La probabilidad es:",
          math(answer),
        ],
        numericValues: [red, blue],
        problem: { variant, red, total },
        fallback: "none",
      });
    }

    if (variant === "independence") {
      const pa = Rational.of(rng.int(1, 9), 10);
      const pb = Rational.of(rng.int(1, 4), 5);
      const independent = rng.int(0, 1) === 0;
      const product = pa.mul(pb);
      const shift = Rational.of(1, 50);
      const joint = independent
        ? product
        : product.compare(shift) > 0 && rng.int(0, 1) === 0
          ? product.sub(shift)
          : product.add(shift);
      const p = (value: Rational) => fraction(value);
      const statements = {
        yes: `Sí, porque $P(A) \\cdot P(B) = ${p(product)} = P(A \\cap B)$.`,
        no: `No, porque $P(A) \\cdot P(B) = ${p(product)} \\neq P(A \\cap B)$.`,
        sum: `Sí, porque $P(A) + P(B) \\le 1$.`,
        disjoint: `No, porque $P(A \\cap B) \\neq 0$.`,
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Se sabe que $P(A) = ${p(pa)}$, $P(B) = ${p(pb)}$ y $P(A \\cap B) = ${p(joint)}$. ¿Son $A$ y $B$ eventos independientes?`,
          ),
        ],
        correct: textChoice(
          independent ? "yes" : "no",
          "none",
          independent ? statements.yes : statements.no,
        ),
        distractors: [
          textChoice(
            independent ? "no" : "yes",
            "wrong-verdict",
            independent ? statements.no : statements.yes,
          ),
          textChoice("sum", "added-the-probabilities", statements.sum),
          textChoice("disjoint", "confused-independent-with-disjoint", statements.disjoint),
        ],
        pool: [
          "$A$ y $B$ son independientes si $P(A \\cap B) = P(A) \\cdot P(B)$.",
          `$P(A) \\cdot P(B) = ${p(pa)} \\cdot ${p(pb)} = ${p(product)}$`,
          `$P(A \\cap B) = ${p(joint)}$`,
          independent ? "Los dos valores son iguales." : "Los dos valores son distintos.",
          "La respuesta es:",
          independent ? "Sí, son independientes." : "No son independientes.",
        ],
        numericValues: [],
        problem: { variant, pa: pa.toString(), pb: pb.toString(), joint: joint.toString() },
        fallback: "none",
      });
    }

    // bayes: two machines A and B make a share of the parts; each has its own defect rate.
    const share = rng.pick([20, 30, 40, 60, 70]);
    const da = rng.pick([2, 3, 4, 5, 6]);
    let db = rng.pick([1, 2, 3, 4, 5, 8]);
    if (db === da) db = da + 1;
    const pShare = Rational.of(share, 100);
    const pDa = Rational.of(da, 100);
    const pDb = Rational.of(db, 100);
    const fromA = pShare.mul(pDa);
    const fromB = Rational.one.sub(pShare).mul(pDb);
    const totalDefect = fromA.add(fromB);
    const answer = fromA.div(totalDefect);
    const tree: FigureSpec = {
      kind: "tree-diagram",
      label: "Diagrama de árbol de las máquinas y las piezas defectuosas",
      params: {
        stages: [
          ["A", "B"],
          ["D", "N"],
        ],
        edgeLabels: [
          `${share}/100`,
          `${100 - share}/100`,
          `${da}/100`,
          `${100 - da}/100`,
          `${db}/100`,
          `${100 - db}/100`,
        ],
        leafLabels: true,
      },
    };
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `La máquina $A$ fabrica el $${share}\\%$ de las piezas de una fábrica y la máquina $B$ el resto. El $${da}\\%$ de las piezas de $A$ y el $${db}\\%$ de las de $B$ salen defectuosas ($D$). Se elige una pieza al azar y es defectuosa. ¿Cuál es la probabilidad de que la haya fabricado $A$?`,
        ),
        { figure: tree },
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(fromA, "gave-the-joint-probability"),
        numberChoice(pDa, "gave-p-of-d-given-a"),
        numberChoice(pShare, "ignored-the-evidence"),
        numberChoice(totalDefect, "gave-the-total-probability"),
      ],
      pool: [
        "Usa el teorema de Bayes: $P(A \\mid D) = \\dfrac{P(A)\\,P(D \\mid A)}{P(D)}$.",
        `$P(A)\\,P(D \\mid A) = ${fraction(pShare)} \\cdot ${fraction(pDa)} = ${fraction(fromA)}$`,
        `$P(B)\\,P(D \\mid B) = ${fraction(Rational.one.sub(pShare))} \\cdot ${fraction(pDb)} = ${fraction(fromB)}$`,
        `Probabilidad total: $P(D) = ${fraction(totalDefect)}$.`,
        `$P(A \\mid D) = \\dfrac{${fraction(fromA)}}{${fraction(totalDefect)}}$`,
        "La probabilidad es:",
        math(answer),
      ],
      numericValues: [share, da, db],
      problem: { variant, share, da, db },
      fallback: "none",
    });
  },
};
