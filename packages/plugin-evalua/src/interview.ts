import type { AskQuestionsResult, Question } from "@alisio/sdk";
import { type Clock, schoolYear } from "./clock.js";
import { controlPattern } from "./schemas.js";
import {
  type CatalogOption,
  type ClosingKind,
  type ExamDraft,
  type Instrument,
  type ItemType,
  itemTypes,
  type Level,
  levels,
  type NumberingScheme,
  type PendingRound,
  type RoundId,
  type TeacherProfile,
  type TopicCatalog,
} from "./types.js";
import { slugify } from "./workspace.js";

const MAX_TEXT = 200;

export const emptyCatalog: TopicCatalog = {
  suggestions: () => [],
  packs: () => [],
  resolvePack: () => undefined,
};

export interface RoundContext {
  answers: Record<string, string>;
  catalog: TopicCatalog;
  /** `init --edit`: the current profile, offered as the recommended `keep` answer. */
  current?: Partial<TeacherProfile>;
}

type Option = Question["options"][number];

const option = (
  value: string,
  label: string,
  extra: { description?: string; recommended?: boolean; placeholder?: string } = {},
): Option => ({
  value,
  label,
  ...(extra.description ? { description: extra.description } : {}),
  ...(extra.recommended ? { recommended: true } : {}),
  ...(extra.placeholder ? { textInput: { placeholder: extra.placeholder } } : {}),
});

const unanswered = (ctx: RoundContext, id: string) => ctx.answers[id] === undefined;

/** The numbering scheme answer; `letters` is the default the interview preselects. */
function numberingFrom(value: string | undefined): NumberingScheme {
  return value === "section" || value === "continuous" ? value : "letters";
}

/** The answer to a text-capable question: its free text when `enter`/`other`/`path` was chosen. */
export function answerText(answers: Record<string, string>, id: string): string | undefined {
  const value = answers[id];
  if (value === undefined) return undefined;
  return answers[`${id}:text`] ?? value;
}

function countOf(answers: Record<string, string>): number | undefined {
  const raw = answerText(answers, "count");
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** A free-text-only question: type it, or (first run) stop and decide later. */
function typed(
  id: string,
  header: string,
  question: string,
  placeholder: string,
  keep?: string,
): Question {
  return {
    id,
    header,
    question,
    options: keep
      ? [
          option("keep", `Conservar el valor actual: ${keep}`, { recommended: true }),
          option("enter", "Escribir un valor nuevo", { placeholder }),
        ]
      : [
          option("enter", "Escríbelo aquí", { recommended: true, placeholder }),
          option("stop", "Detener por ahora", {
            description: "Pausa la entrevista; no se guarda nada.",
          }),
        ],
  };
}

function profileQuestions(ctx: RoundContext): Question[] {
  const current = ctx.current;
  const questions: Question[] = [];
  if (unanswered(ctx, "language")) {
    const keep = current?.language
      ? [
          option("keep", `Conservar el idioma actual: ${current.language}`, {
            recommended: true,
          }),
        ]
      : [];
    questions.push({
      id: "language",
      header: "Idioma",
      question: "¿En qué idioma quieres el examen y las preguntas?",
      options: [
        ...keep,
        option("es", "Español", { recommended: keep.length === 0 }),
        option("en", "English"),
        option("other", "Otro idioma", { placeholder: "Código de idioma, por ejemplo pt" }),
      ],
    });
  }
  if (unanswered(ctx, "institution")) {
    questions.push(
      typed(
        "institution",
        "Institución",
        "¿Cuál es el nombre de la institución educativa?",
        "Nombre de la institución",
        current?.institution,
      ),
    );
  }
  if (unanswered(ctx, "teacher_name")) {
    questions.push(
      typed(
        "teacher_name",
        "Docente",
        "¿Cuál es el nombre del docente?",
        "Nombre completo",
        current?.teacherName,
      ),
    );
  }
  if (unanswered(ctx, "logo")) {
    const keep = current?.logo
      ? [option("keep", `Conservar el logo actual (${current.logo})`, { recommended: true })]
      : [];
    questions.push({
      id: "logo",
      header: "Logo",
      question:
        "¿Quieres el logo de la institución en los exámenes? (PNG, JPEG o WebP, hasta 2 MB)",
      options: [
        ...keep,
        option("none", "Sin logo", { recommended: keep.length === 0 }),
        option("path", "Indicar la ruta de un archivo", { placeholder: "Ruta de la imagen" }),
      ],
    });
  }
  return questions;
}

function topicQuestion(ctx: RoundContext): Question {
  const grade = ctx.answers.grade === "other" ? ctx.answers["grade:text"] : gradeLabel(ctx.answers);
  const suggestions = ctx.catalog.suggestions(grade).slice(0, 3);
  const options = suggestions.map((entry, index) =>
    option(entry.value, entry.label, { recommended: index === 0 }),
  );
  if (options.length === 0) {
    return typed(
      "topic",
      "Tema",
      "¿De qué trata el examen?",
      "Por ejemplo: fracciones, ecuaciones lineales",
      undefined,
    );
  }
  options.push(option("enter", "Otro tema", { placeholder: "Describe el tema" }));
  return { id: "topic", header: "Tema", question: "¿De qué trata el examen?", options };
}

function topicValue(answers: Record<string, string>): string | undefined {
  const topic = answers.topic;
  if (topic === undefined) return undefined;
  return topic === "enter" ? answers["topic:text"] : topic;
}

function round1(ctx: RoundContext): Question[] {
  const questions: Question[] = [];
  if (unanswered(ctx, "topic")) questions.push(topicQuestion(ctx));
  if (unanswered(ctx, "grade")) {
    questions.push({
      id: "grade",
      header: "Grado",
      question: "¿Para qué grado es el examen?",
      options: [
        option("sexto", "Sexto"),
        option("septimo", "Séptimo", { recommended: true }),
        option("octavo", "Octavo"),
        option("other", "Otro grado", { placeholder: "Por ejemplo: Noveno" }),
      ],
    });
  }
  if (unanswered(ctx, "level")) {
    questions.push({
      id: "level",
      header: "Nivel",
      question: "¿Qué nivel?",
      options: [
        option("basico", "Básico", {
          recommended: true,
          description: "Directo, rutinario, un solo concepto.",
        }),
        option("intermedio", "Intermedio", {
          description: "Rutinario con 2 a 3 pasos, conceptos combinados.",
        }),
        option("avanzado", "Avanzado", { description: "Varios pasos, modelado y justificación." }),
        option("genio", "Genio", {
          description: "No rutinario, tipo olimpiada, mucho razonamiento.",
        }),
      ],
    });
  }
  const packs = ctx.catalog.packs();
  const topic = topicValue(ctx.answers);
  const resolved = topic !== undefined && ctx.catalog.resolvePack(topic) !== undefined;
  if (unanswered(ctx, "kind") && packs.length > 1 && !resolved) {
    questions.push({
      id: "kind",
      header: "Base de conocimiento",
      question: "¿De qué base de conocimiento debe tomar el examen?",
      options: [
        ...packs
          .slice(0, 2)
          .map((pack, index) => option(pack.value, pack.label, { recommended: index === 0 })),
        option("mixed", "Temas mixtos"),
      ],
    });
  }
  return questions;
}

function round2(ctx: RoundContext): Question[] {
  const questions: Question[] = [];
  if (unanswered(ctx, "types")) {
    questions.push({
      id: "types",
      header: "Tipos de ítems",
      question: "¿Qué tipos de ítems debe incluir el examen?",
      multiSelect: true,
      options: [
        option("single_choice", "Selección única", { recommended: true }),
        option("multiple_choice", "Selección múltiple"),
        option("open", "Abiertas"),
        option("practice", "Ejercicio de práctica", {
          description: "Resolver con todo el procedimiento.",
        }),
      ],
    });
  }
  if (unanswered(ctx, "count")) {
    questions.push({
      id: "count",
      header: "Preguntas",
      question: "¿Cuántas preguntas?",
      options: [
        option("10", "10", { recommended: true }),
        option("15", "15"),
        option("20", "20"),
        option("other", "Otra cantidad", { placeholder: "Número de preguntas (1 a 100)" }),
      ],
    });
  }
  if (unanswered(ctx, "distribution") && countOf(ctx.answers) !== 1) {
    questions.push({
      id: "distribution",
      header: "Distribución",
      question: "¿El mismo examen para todos o sorteos aleatorios de un banco?",
      options: [
        option("same", "Las mismas preguntas en el mismo orden", { recommended: true }),
        option("bank", "Banco con sorteos aleatorios por examen"),
      ],
    });
  }
  if (unanswered(ctx, "columns")) {
    questions.push({
      id: "columns",
      header: "Columnas",
      question: "¿Cuántas columnas de preguntas?",
      options: [option("1", "Una", { recommended: true }), option("2", "Dos")],
    });
  }
  return questions;
}

/** Default bank size is 3 x count; never below count + 5. */
export function bankSizes(count: number): { standard: number; double: number | undefined } {
  const min = count + 5;
  const double = 2 * count;
  return { standard: Math.max(3 * count, min), double: double >= min ? double : undefined };
}

function round2b(ctx: RoundContext): Question[] {
  const count = countOf(ctx.answers) ?? 10;
  const sizes = bankSizes(count);
  const questions: Question[] = [];
  if (unanswered(ctx, "bank_size")) {
    questions.push({
      id: "bank_size",
      header: "Tamaño del banco",
      question: "¿Cuántos ítems debe tener el banco?",
      options: [
        option("default", `${sizes.standard} ítems (3 veces la longitud del examen)`, {
          recommended: true,
        }),
        ...(sizes.double !== undefined && sizes.double !== sizes.standard
          ? [option("double", `${sizes.double} ítems (2 veces la longitud del examen)`)]
          : []),
        option("other", "Otro tamaño", {
          placeholder: `Número de ítems (al menos ${count + 5})`,
        }),
      ],
    });
  }
  if (unanswered(ctx, "variants")) {
    questions.push({
      id: "variants",
      header: "Variantes",
      question: "¿Cuántas variantes (A, B, ...) se deben sortear?",
      options: [
        option("2", "2 variantes", { recommended: true }),
        option("3", "3 variantes"),
        option("other", "Otra cantidad", { placeholder: "Número de variantes (1 a 8)" }),
      ],
    });
  }
  return questions;
}

function round3(ctx: RoundContext): Question[] {
  const questions: Question[] = [];
  if (unanswered(ctx, "pages")) {
    questions.push({
      id: "pages",
      header: "Páginas",
      question: "¿Límite de páginas?",
      options: [
        option("auto", "Las mínimas legibles", { recommended: true }),
        option("1", "1 página"),
        option("2", "2 páginas"),
        option("other", "Otra cantidad", { placeholder: "Máximo de páginas (1 a 20)" }),
      ],
    });
  }
  if (unanswered(ctx, "time")) {
    questions.push({
      id: "time",
      header: "Tiempo",
      question: "¿Tiempo e instrumento?",
      options: [
        option("120-pencil", "2 horas, lápiz", { recommended: true }),
        option("90-pencil", "90 minutos, lápiz"),
        option("60-pen", "1 hora, bolígrafo"),
        option("other", "Otra opción", {
          placeholder:
            "Minutos, lápiz o bolígrafo, calculadora sí o no (por ejemplo: 90 bolígrafo calculadora)",
        }),
      ],
    });
  }
  if (unanswered(ctx, "closing")) {
    questions.push({
      id: "closing",
      header: "Cierre",
      question: "¿Texto de cierre después de la última pregunta?",
      options: [
        option("none", "Ninguno", { recommended: true }),
        option("quote", "Una frase célebre"),
        option("bible", "Un versículo bíblico"),
      ],
    });
  }
  if (unanswered(ctx, "numbering")) {
    questions.push({
      id: "numbering",
      header: "Numeración",
      question: "¿Cómo se numeran las secciones y las preguntas?",
      options: [
        option("letters", "Secciones 1. y preguntas a, b, c", { recommended: true }),
        option("section", "Secciones 1. y preguntas 1.1, 1.2, 1.3"),
        option("continuous", "Preguntas 1, 2, 3… de corrido, secciones sin número"),
      ],
    });
  }
  return questions;
}

/** The questions still needed for a round, in order; at most four. */
export function buildRound(round: RoundId, ctx: RoundContext): Question[] {
  const build = {
    profile: profileQuestions,
    "1": round1,
    "2": round2,
    "2b": round2b,
    "3": round3,
  }[round];
  return build(ctx).slice(0, 4);
}

export interface SequenceInput {
  profileMissing: boolean;
  answers: Record<string, string>;
  completed: readonly RoundId[];
}

/** The next exam-interview round, or undefined when the interview is complete. */
export function nextRound({
  profileMissing,
  answers,
  completed,
}: SequenceInput): RoundId | undefined {
  if (profileMissing && !completed.includes("profile")) return "profile";
  if (!completed.includes("1")) return "1";
  if (!completed.includes("2")) return "2";
  const count = countOf(answers);
  if (answers.distribution === "bank" && count !== 1 && !completed.includes("2b")) return "2b";
  if (!completed.includes("3")) return "3";
  return undefined;
}

// ---- answers --------------------------------------------------------------------------------

export interface AcceptResult {
  accepted: Record<string, string>;
  errors: string[];
}

const intIn = (text: string, min: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max
    ? undefined
    : `must be a whole number from ${min} to ${max}`;
};

const textValidators: Record<string, (text: string) => string | undefined> = {
  count: (text) => intIn(text, 1, 100),
  bank_size: (text) => intIn(text, 1, 400),
  variants: (text) => intIn(text, 1, 8),
  pages: (text) => intIn(text, 1, 20),
  time: (text) =>
    parseTimeAnswer(text)
      ? undefined
      : "use minutes (5 to 480) plus optional pencil/pen and calculator",
};

/** Validate answers against the questions they were asked for; never throws. */
export function acceptAnswers(
  questions: readonly Question[],
  input: Record<string, string>,
): AcceptResult {
  const accepted: Record<string, string> = {};
  const errors: string[] = [];
  const known = new Set(questions.map((question) => question.id));
  for (const key of Object.keys(input)) {
    const id = key.endsWith(":text") ? key.slice(0, -5) : key;
    if (!known.has(id)) errors.push(`Unknown question id: ${id}`);
  }
  for (const question of questions) {
    let value = input[question.id];
    let text = input[`${question.id}:text`];
    if (value === undefined) {
      if (text !== undefined) errors.push(`${question.id}:text was given without ${question.id}`);
      continue;
    }
    value = value.trim();
    if (question.multiSelect) {
      const parts = [
        ...new Set(
          value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ];
      const allowed = question.options.map((entry) => entry.value);
      const bad = parts.filter((part) => !allowed.includes(part));
      if (bad.length > 0) {
        errors.push(
          `${question.id}: "${bad.join(", ")}" is not allowed. Allowed values: ${allowed.join(", ")}`,
        );
      } else if (parts.length > 0) {
        accepted[question.id] = allowed.filter((entry) => parts.includes(entry)).join(",");
      }
      continue;
    }
    if (value === "") continue;
    const values = question.options.map((entry) => entry.value);
    const textOption = question.options.find((entry) => entry.textInput);
    if (!values.includes(value)) {
      if (textOption && text === undefined) {
        text = value;
        value = textOption.value;
      } else {
        errors.push(
          `${question.id}: "${value}" is not allowed. Allowed values: ${values.join(", ")}`,
        );
        continue;
      }
    }
    if (value === "stop") continue;
    const chosen = question.options.find((entry) => entry.value === value);
    if (text !== undefined) {
      if (!chosen?.textInput) {
        errors.push(`${question.id}: option "${value}" does not take free text`);
        continue;
      }
      text = text.trim();
      if (text.length < 1 || text.length > MAX_TEXT || controlPattern.test(text)) {
        errors.push(`${question.id}: free text must be 1 to ${MAX_TEXT} printable characters`);
        continue;
      }
      const problem = textValidators[question.id]?.(text);
      if (problem) {
        errors.push(`${question.id}: ${problem}`);
        continue;
      }
    } else if (chosen?.textInput) {
      errors.push(`${question.id}: option "${value}" needs free text (${question.id}:text=...)`);
      continue;
    }
    accepted[question.id] = value;
    if (text !== undefined) accepted[`${question.id}:text`] = text;
  }
  return { accepted, errors };
}

/** First value of each answer; multi-select arrays join with commas. */
export function flattenAnswers(
  result: AskQuestionsResult,
  questions: readonly Question[],
): Record<string, string> {
  const multi = new Set(
    questions.filter((question) => question.multiSelect).map((question) => question.id),
  );
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? (multi.has(key) ? value.join(",") : value[0]) : value;
    if (typeof text === "string" && text !== "") flat[key] = text;
  }
  return flat;
}

/**
 * Parse `id=value` pairs (values run to the next `id=` token; `id:text=` carries free text) or a
 * JSON object. Returns undefined when the text contains no known id, so callers can treat it as
 * a plain description.
 */
export function parseAnswerText(
  text: string,
  ids: readonly string[],
): Record<string, string> | undefined {
  const source = text.trim().replace(/^--\s*/, "");
  if (!source) return undefined;
  if (source.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error("Answers look like JSON but could not be parsed");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("JSON answers must be an object of id to value");
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error(`JSON answer for ${key} must be a string`);
      flat[key] = value;
    }
    return flat;
  }
  const names = ids
    .flatMap((id) => [id, `${id}:text`])
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return undefined;
  const token = new RegExp(`(?:^|\\s)(${names.join("|")})=`, "g");
  const marks = [...source.matchAll(token)];
  const first = marks[0];
  if (!first || source.slice(0, first.index).trim()) return undefined;
  const flat: Record<string, string> = {};
  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? source.length;
    flat[mark[1] as string] = source.slice(start, end).trim();
  });
  return flat;
}

export function renderPending(pending: PendingRound, command: string): string {
  const lines = [
    `Entrevista de Evalúa, ronda ${pending.round}`,
    `Responde con ${command} usando pares id=valor (separados por espacios), o un objeto JSON.`,
    "El texto libre va en <id>:text=... para las opciones marcadas (text); varias opciones se separan con comas.",
    "",
  ];
  pending.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.id}: ${question.question}`);
    for (const entry of question.options) {
      const flags = [entry.recommended ? "recommended" : "", entry.textInput ? "text" : ""].filter(
        Boolean,
      );
      lines.push(
        `   - ${entry.value}: ${entry.label}${flags.length ? ` (${flags.join(", ")})` : ""}${entry.description ? ` - ${entry.description}` : ""}`,
      );
    }
  });
  const example = pending.questions
    .map((question) => {
      const pick = question.options.find((entry) => entry.recommended) ?? question.options[0];
      return `${question.id}=${pick?.value}${pick?.textInput ? ` ${question.id}:text=...` : ""}`;
    })
    .join(" ");
  lines.push("", `Example: ${command} ${example}`);
  return lines.join("\n");
}

// ---- derived values -------------------------------------------------------------------------

export function parseTimeAnswer(
  raw: string,
): { durationMinutes: number; instrument: Instrument; calculator: boolean } | undefined {
  const text = raw.trim().toLowerCase();
  const minutes = /\d+/.exec(text);
  if (!minutes) return undefined;
  const durationMinutes = Number(minutes[0]);
  if (durationMinutes < 5 || durationMinutes > 480) return undefined;
  const instrument: Instrument = /\b(pen|bol[ií]grafo|esfero|lapicero)\b/.test(text)
    ? "pen"
    : /(pencil|l[aá]piz)/.test(text)
      ? "pencil"
      : "any";
  const negated = /\b(sin|no)[ -]?(calculator|calculadora)\b/.test(text);
  const calculator = !negated && /(calculator|calculadora)/.test(text);
  return { durationMinutes, instrument, calculator };
}

const typeWeights: Record<ItemType, number> = {
  single_choice: 2,
  multiple_choice: 1,
  practice: 2,
  open: 1,
};
const tieOrder: ItemType[] = ["single_choice", "practice", "multiple_choice", "open"];

/** Proportional split by type weight (largest remainder); the counts always sum to `count`. */
export function splitItemTypes(
  count: number,
  chosen: readonly ItemType[],
): Record<ItemType, number> {
  const result = Object.fromEntries(itemTypes.map((type) => [type, 0])) as Record<ItemType, number>;
  const active = tieOrder.filter((type) => chosen.includes(type));
  if (active.length === 0) return { ...result, single_choice: count };
  const total = active.reduce((sum, type) => sum + typeWeights[type], 0);
  const raw = active.map((type) => ({ type, exact: (count * typeWeights[type]) / total }));
  for (const entry of raw) result[entry.type] = Math.floor(entry.exact);
  let left = count - raw.reduce((sum, entry) => sum + Math.floor(entry.exact), 0);
  const byRemainder = [...raw].sort(
    (a, b) =>
      b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) ||
      typeWeights[b.type] - typeWeights[a.type],
  );
  for (const entry of byRemainder) {
    if (left <= 0) break;
    result[entry.type] += 1;
    left -= 1;
  }
  return result;
}

const gradeLabels: Record<string, string> = {
  sexto: "Sexto",
  septimo: "Séptimo",
  octavo: "Octavo",
};

export function gradeLabel(answers: Record<string, string>): string | undefined {
  const grade = answers.grade;
  if (grade === undefined) return undefined;
  return grade === "other" ? answers["grade:text"] : (gradeLabels[grade] ?? grade);
}

const upper = (text: string) => text.toLocaleUpperCase("es");

/** Build the exam spec draft from interview answers (spec 5.2, 7.4); held in state until Gate A. */
export function buildDraft(
  answers: Record<string, string>,
  profile: TeacherProfile,
  clock: Clock,
  catalog: TopicCatalog,
): ExamDraft {
  const grade = gradeLabel(answers) ?? "";
  const topicRaw = topicValue(answers) ?? "";
  const known: CatalogOption | undefined = catalog
    .suggestions(grade)
    .find((entry) => entry.value === answers.topic);
  const isFree = answers.topic === "enter";
  const topicTitle = isFree ? topicRaw : (known?.label ?? topicRaw);
  const kind = answers.kind;
  // A description typed as free text is resolved to a knowledge-base topic when it is unambiguous.
  const resolvedFull = isFree ? catalog.resolveTopic?.(topicRaw) : undefined;
  const topicId = isFree ? resolvedFull : topicRaw;
  const pack = topicId !== undefined ? catalog.resolvePack(topicId) : undefined;
  const packs = kind && kind !== "mixed" ? [kind] : pack ? [pack] : [];
  const types = (answers.types ?? "single_choice").split(",") as ItemType[];
  const count = countOf(answers) ?? 10;
  const distribution = answers.distribution === "bank" && count > 1 ? "bank" : "same";
  const time = parseTimeAnswer(answerText(answers, "time") ?? "120-pencil") ?? {
    durationMinutes: 120,
    instrument: "pencil" as Instrument,
    calculator: false,
  };
  const pages = answerText(answers, "pages") ?? "auto";
  const level = (levels as readonly string[]).includes(answers.level ?? "")
    ? (answers.level as Level)
    : "basico";
  const closing = (
    ["quote", "bible"].includes(answers.closing ?? "") ? answers.closing : "none"
  ) as ClosingKind;
  let bank: ExamDraft["bank"];
  if (distribution === "bank") {
    const sizes = bankSizes(count);
    const sizeAnswer = answers.bank_size;
    const size =
      sizeAnswer === "double" && sizes.double !== undefined
        ? sizes.double
        : sizeAnswer === "other"
          ? Math.max(Number(answers["bank_size:text"]), count + 5)
          : sizes.standard;
    const variants = Number(answerText(answers, "variants") ?? 2);
    bank = { size, variants: Number.isInteger(variants) && variants > 0 ? variants : 2 };
  }
  return {
    schemaVersion: 1,
    title: `EVALUACIÓN DE ${upper(profile.subject)} - GRADO ${upper(grade)}`,
    theme: upper(topicTitle),
    grade,
    level,
    packs,
    topics: topicId !== undefined ? [topicId] : [],
    topicText: isFree && topicId === undefined ? topicRaw : null,
    itemTypes: splitItemTypes(count, types),
    questionCount: count,
    distribution,
    ...(bank ? { bank } : {}),
    columns: answers.columns === "2" ? 2 : 1,
    numbering: numberingFrom(answers.numbering),
    maxPages: pages === "auto" ? "auto" : Number(pages),
    durationMinutes: time.durationMinutes,
    instrument: time.instrument,
    calculator: time.calculator,
    introOverride: null,
    closing: { kind: closing, pinned: null },
    schoolYear: schoolYear(clock),
    slug: slugify(topicTitle, grade),
    status: "draft",
    createdAt: clock.now().toISOString(),
  };
}
