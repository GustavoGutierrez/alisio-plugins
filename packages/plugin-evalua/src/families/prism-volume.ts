import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "count-cubes" | "volume" | "missing-edge" | "litres";

interface Box {
  length: number;
  width: number;
  height: number;
}

const volume = (box: Box): number => box.length * box.width * box.height;
const surface = (box: Box): number =>
  2 * (box.length * box.width + box.length * box.height + box.width * box.height);
/** The cubes a careless count sees: the three visible faces, shared edges counted once. */
const visible = (box: Box): number => {
  const { length: l, width: w, height: h } = box;
  return l * w + l * h + w * h - l - w - h + 1;
};

/** Volume of rectangular prisms: unit cubes, edge lengths, a missing edge, litres (DBA 4 #5, 5 #4). */
export const prismVolume: Family = {
  id: "prism-volume",
  solve(problem: Record<string, unknown>): Rational {
    const box = problem as unknown as Box & { variant: Variant; given?: number };
    if (box.variant === "missing-edge")
      return Rational.of(Number(box.given) / (box.length * box.width));
    return Rational.of(volume(box));
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variants = tier<Variant>(index, [
      ["count-cubes"],
      ["count-cubes", "volume"],
      ["volume", "missing-edge", "count-cubes"],
      ["volume", "missing-edge", "litres"],
    ]);
    const variant = rng.pick(variants);
    const cubes = variant === "count-cubes";
    const high = cubes
      ? Math.min(6, levelHigh(calibration, index === 0 ? 4 : 6))
      : levelHigh(calibration, [6, 10, 20, 30][index] ?? 10);
    const box: Box = {
      length: rng.int(2, high),
      width: rng.int(cubes ? 1 : 2, high),
      height: rng.int(cubes ? 1 : 2, high),
    };
    if (variant === "missing-edge") {
      // The given volume is written in the stem, so it has to fit the level's number range too.
      const cap = Math.floor(calibration.coefficientRange[1]);
      box.length = Math.min(box.length, 10);
      box.width = Math.min(box.width, 10);
      box.height = rng.int(
        2,
        Math.max(2, Math.min(high, Math.floor(cap / (box.length * box.width)))),
      );
    }
    const answerVolume = volume(box);
    const unit = variant === "litres" ? "dm" : rng.pick(["cm", "m"]);
    const cubed = `${unit === "cm" ? "centímetros" : unit === "m" ? "metros" : "decímetros"} cúbicos`;
    const base = box.length * box.width;

    if (variant === "missing-edge") {
      const figure: FigureSpec = {
        kind: "prism",
        params: { length: box.length, width: box.width, unit },
      };
      const ask = `El volumen de la caja es $${answerVolume}$ ${cubed}. Mide $${box.length}$ de largo y $${box.width}$ de ancho. ¿Cuánto mide de alto?`;
      return finishDraft({
        family: "prism-volume",
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, ask, ""), { figure }],
        correct: numberChoice(box.height, "none"),
        distractors: [
          numberChoice(Math.abs(answerVolume - base) || box.height + 2, "subtracted-the-base"),
          numberChoice(
            Math.abs(answerVolume - box.length - box.width) || box.height + 3,
            "subtracted-the-edges",
          ),
          numberChoice(answerVolume / box.length, "divided-by-one-edge"),
        ],
        pool: [
          "El volumen es largo por ancho por alto.",
          `Área de la base: $${box.length} \\times ${box.width} = ${base}$`,
          `$${base} \\times h = ${answerVolume}$`,
          `$h = ${answerVolume} \\div ${base} = ${box.height}$`,
          "La caja mide de alto:",
          math(box.height),
        ],
        numericValues: [answerVolume, box.length, box.width],
        problem: {
          variant,
          length: box.length,
          width: box.width,
          height: box.height,
          given: answerVolume,
        },
      });
    }

    const figure: FigureSpec = cubes
      ? { kind: "cube-stack", params: { ...box } }
      : { kind: "prism", params: { ...box, unit } };
    const ask = cubes
      ? "El prisma está formado por cubos iguales, sin huecos. ¿Cuántos cubos tiene en total?"
      : variant === "litres"
        ? `Un tanque tiene forma de prisma y mide por dentro lo que indica la figura. ¿Cuántos litros caben? ($1$ decímetro cúbico $= 1$ litro)`
        : `¿Cuál es el volumen del prisma en ${cubed}?`;
    return finishDraft({
      family: "prism-volume",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, ask, ""), { figure }],
      correct: numberChoice(answerVolume, "none"),
      distractors: [
        numberChoice(box.length + box.width + box.height, "added-the-edges"),
        numberChoice(base, "counted-one-layer"),
        cubes
          ? numberChoice(visible(box), "counted-only-visible-cubes")
          : numberChoice(surface(box), "computed-the-surface"),
        numberChoice(answerVolume + base, "one-layer-too-many"),
      ],
      pool: [
        cubes
          ? "Cuenta los cubos de una capa: largo por ancho."
          : "El volumen de un prisma es largo por ancho por alto.",
        `Una capa tiene $${box.length} \\times ${box.width} = ${base}$ cubos.`,
        `Hay $${box.height}$ ${box.height === 1 ? "capa" : "capas"}.`,
        `$${base} \\times ${box.height} = ${answerVolume}$`,
        variant === "litres"
          ? "Caben (en litros):"
          : cubes
            ? "El total de cubos es:"
            : `El volumen es (en ${cubed}):`,
        math(answerVolume),
      ],
      numericValues: cubes ? [] : [box.length, box.width, box.height],
      problem: { variant, ...box },
    });
  },
};
