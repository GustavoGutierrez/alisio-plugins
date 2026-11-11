import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import {
  clockMath,
  clockText,
  finishDraft,
  levelHigh,
  levelIndex,
  math,
  numberChoice,
  textChoice,
} from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "read" | "elapsed" | "end-time";

/**
 * Times stay between 1:00 and 11:59 of one morning, so no item depends on a.m./p.m. Clock minutes
 * are notation, not operands: only the hours and the durations are calibrated numbers.
 */
const toMinutes = (hour: number, minute: number): number => hour * 60 + minute;

function fromMinutes(total: number): [number, number] {
  return [Math.floor(total / 60), total % 60];
}

/** Basico uses the quarter-hour words children learn first; later levels use exact minutes. */
function minuteStep(level: number): number {
  return [15, 5, 5, 1][level] ?? 1;
}

const QUARTER_WORDS: Record<number, string> = {
  0: "en punto",
  15: "y cuarto",
  30: "y media",
};

/** The spoken form of a quarter-hour time (`las 3 y media`), or digital time for other minutes. */
function spoken(hour: number, minute: number): string {
  if (minute === 45) return `las $${hour + 1}$ menos cuarto`;
  const words = QUARTER_WORDS[minute];
  if (words !== undefined) return `${hour === 1 ? "la" : "las"} $${hour}$ ${words}`;
  return `las ${clockMath(hour, minute)}`;
}

function timeChoice(total: number, error: string): OptionCandidate | undefined {
  const [hour, minute] = fromMinutes(total);
  if (hour < 1 || hour > 12) return undefined;
  return textChoice(clockText(hour, minute), error, clockMath(hour, minute));
}

const defined = <T>(values: ReadonlyArray<T | undefined>): T[] =>
  values.filter((value): value is T => value !== undefined);

/** Reading clocks, elapsed time and end times within one morning (DBA 2 #4-5). */
export const clockTime: Family = {
  id: "clock-time",
  solve(problem: Record<string, unknown>): Rational | string {
    const start = toMinutes(Number(problem.hour), Number(problem.minute));
    if (problem.variant === "read") return clockText(Number(problem.hour), Number(problem.minute));
    if (problem.variant === "elapsed") {
      const minutes = toMinutes(Number(problem.endHour), Number(problem.endMinute)) - start;
      return problem.unit === "hours" ? Rational.of(minutes, 60) : Rational.of(minutes);
    }
    const [hour, minute] = fromMinutes(start + Number(problem.duration));
    return clockText(hour, minute);
  },
  generate(context: FamilyContext): ItemDraft {
    const variant = context.rng.pick<Variant>(["read", "elapsed", "end-time"]);
    if (variant === "read") return read(context);
    return interval(context, variant);
  },
};

function read({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
  const step = minuteStep(levelIndex(level));
  const hour = rng.int(1, 11);
  const minute = rng.int(0, 60 / step - 1) * step;
  const total = toMinutes(hour, minute);
  const figure: FigureSpec = { kind: "clock", params: { hour, minute } };
  const swappedHour = minute === 0 ? 12 : Math.floor(minute / 5) || 12;
  const distractors = defined([
    textChoice(
      clockText(swappedHour, (hour * 5) % 60),
      "swapped-hands",
      clockMath(swappedHour, (hour * 5) % 60),
    ),
    timeChoice(minute >= 30 ? total + 60 : total - 60, "hour-hand-rounding"),
    minute % 5 === 0 && minute !== 0
      ? timeChoice(toMinutes(hour, minute / 5), "read-minute-numeral")
      : undefined,
    timeChoice(toMinutes(hour, (minute + 30) % 60), "misread-minute-hand"),
    timeChoice(total + 60, "hour-slip"),
    timeChoice(toMinutes(hour, (minute + 15) % 60), "misread-minute-hand"),
    timeChoice(total + 5, "misread-minute-hand"),
    timeChoice(total - 5, "misread-minute-hand"),
  ]);
  const correct = textChoice(clockText(hour, minute), "none", clockMath(hour, minute));
  return finishDraft({
    family: "clock-time",
    level,
    rng,
    calibration,
    stem: [prompt(rng, prompts, "¿Qué hora marca el reloj?", ""), { figure }],
    correct,
    distractors,
    pool: [
      "La manecilla corta marca las horas y la larga los minutos.",
      `La manecilla corta ya pasó el $${hour}$: son las $${hour}$ y algo.`,
      "Cada número del reloj equivale a $5$ minutos para la manecilla larga.",
      `La manecilla larga marca $${minute}$ minutos.`,
      "La hora es:",
      clockMath(hour, minute),
    ],
    numericValues: [],
    problem: { variant: "read", hour, minute },
    fallback: "none",
  });
}

function interval(
  { rng, level, calibration, prompts }: FamilyContext,
  variant: "elapsed" | "end-time",
): ItemDraft {
  const index = levelIndex(level);
  const step = minuteStep(index);
  // Basico counts whole hours; later levels count minutes, up to the level's number range.
  const wholeHours = index === 0;
  const maxDuration = wholeHours ? 180 : Math.min(levelHigh(calibration, 300, 30), 300);
  const duration = wholeHours
    ? rng.int(1, 3) * 60
    : rng.int(Math.max(1, Math.ceil(10 / step)), Math.floor(maxDuration / step)) * step;
  const latestStart = toMinutes(11, 59) - duration;
  const startSlots = Math.floor((latestStart - 60) / step);
  const start = 60 + rng.int(0, Math.max(0, startSlots)) * step;
  const [hour, minute] = fromMinutes(start);
  const end = start + duration;
  const [endHour, endMinute] = fromMinutes(end);
  const when = (h: number, m: number) => (index === 0 ? spoken(h, m) : `las ${clockMath(h, m)}`);
  const activity = rng.pick(["La clase de música", "El partido", "La película", "La excursión"]);
  const hoursText = `$${duration / 60}$ ${duration === 60 ? "hora" : "horas"}`;
  const lasting = wholeHours ? hoursText : `$${duration}$ minutos`;

  if (variant === "elapsed") {
    const unit = wholeHours ? "hours" : "minutes";
    const answer = wholeHours ? duration / 60 : duration;
    const decimal = endHour * 100 + endMinute - (hour * 100 + minute);
    const scale = wholeHours ? 1 : 60;
    const instruction = prompt(
      rng,
      prompts,
      `${activity} empieza a ${when(hour, minute)} y termina a ${when(endHour, endMinute)}. ¿Cuántos ${wholeHours ? "horas" : "minutos"} dura?`,
      "",
    );
    return finishDraft({
      family: "clock-time",
      level,
      rng,
      calibration,
      stem: [instruction],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(answer + scale, "hour-slip"),
        numberChoice(Math.abs(answer - scale) || answer + 2 * scale, "hour-slip"),
        numberChoice(
          wholeHours ? duration : decimal,
          wholeHours ? "answered-in-minutes" : "subtracted-as-decimal",
        ),
        numberChoice(
          wholeHours ? endHour + hour : Math.abs(endMinute - minute) || answer + 5,
          wholeHours ? "added-the-hours" : "ignored-the-hours",
        ),
      ],
      pool: [
        `Hora de inicio: ${when(hour, minute)}; hora final: ${when(endHour, endMinute)}.`,
        "Cuenta las horas completas y luego los minutos que faltan.",
        "Una hora tiene $60$ minutos.",
        `De ${when(hour, minute)} a ${when(endHour, endMinute)} pasan ${lasting}.`,
        "La duración es:",
        math(answer),
      ],
      numericValues: [hour, endHour],
      problem: { variant, hour, minute, endHour, endMinute, unit },
    });
  }

  const instruction = prompt(
    rng,
    prompts,
    `${activity} empieza a ${when(hour, minute)} y dura ${lasting}. ¿A qué hora termina?`,
    "",
  );
  const noCarry = toMinutes(hour + Math.floor(duration / 60), (minute + (duration % 60)) % 60);
  return finishDraft({
    family: "clock-time",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: textChoice(clockText(endHour, endMinute), "none", clockMath(endHour, endMinute)),
    distractors: defined([
      noCarry === end ? undefined : timeChoice(noCarry, "forgot-to-carry-the-hour"),
      timeChoice(end + 60, "hour-slip"),
      timeChoice(end - 60, "hour-slip"),
      timeChoice(start - duration, "subtracted-instead"),
      timeChoice(end + 30, "misread-minute-hand"),
      timeChoice(end - 30, "misread-minute-hand"),
      timeChoice(end + 5, "misread-minute-hand"),
      timeChoice(end - 5, "misread-minute-hand"),
    ]),
    pool: [
      `Empieza a ${when(hour, minute)}.`,
      `Suma la duración: ${lasting}.`,
      "Si los minutos llegan a $60$, se convierten en una hora más.",
      `$${clockText(hour, minute).replace(":", "{:}")} + ${duration}\\ \\text{min}$`,
      "Termina a las:",
      clockMath(endHour, endMinute),
    ],
    numericValues: wholeHours ? [hour, duration / 60] : [hour, duration],
    problem: { variant, hour, minute, duration },
    fallback: "none",
  });
}
