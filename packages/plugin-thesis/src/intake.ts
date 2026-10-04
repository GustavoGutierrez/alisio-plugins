import type { AskQuestionsResult, Question } from "@alisio/sdk";
import {
  applyBriefDefaults,
  isValidLanguageTag,
  loadBrief,
  primaryLanguage,
  stringifyBrief,
} from "./brief.js";
import {
  approaches,
  type Brief,
  type IntakeState,
  type PendingQuestions,
  paletteNames,
  type ThesisState,
  type WorkType,
} from "./types.js";

export const defaultRounds = [1, 2, 3] as const;
export const presentationRound = 4;
/** Extra presentation questions asked only when the ICONTEC profile is selected (spec 10.3). */
export const icontecRound = 5;

export const roundTitles: Record<number, string> = {
  1: "language and frame",
  2: "institution and style",
  3: "research intent",
  4: "presentation",
  5: "ICONTEC presentation",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is rejected
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const maxText = 600;

interface Spec {
  id: string;
  round: number;
  build(context: BuildContext): Question;
  /** Option values whose free text is mandatory. */
  textRequired?: readonly string[];
  /** Returns an error message when the text is not acceptable for the option. */
  validateText?(option: string, text: string): string | undefined;
}

interface BuildContext {
  hint: string;
  answers: Record<string, string>;
}

const option = (
  value: string,
  label: string,
  description?: string,
  extra: { recommended?: boolean; placeholder?: string } = {},
) => ({
  value,
  label,
  ...(description ? { description } : {}),
  ...(extra.recommended ? { recommended: true } : {}),
  ...(extra.placeholder ? { textInput: { placeholder: extra.placeholder } } : {}),
});

function countryFromContext({ hint, answers }: BuildContext): string | undefined {
  const answered = answers.country;
  if (answered === "CO") return "CO";
  if (answered === "other") return answers["country:text"]?.toUpperCase();
  const region = hint.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined;
}

/** Language chosen so far, falling back to the conversation hint. */
function chosenLanguage(context: BuildContext): string {
  const value = context.answers.language;
  if (value === "es" || value === "en") return value;
  if (value === "other") return context.answers["language:text"] ?? context.hint;
  return context.hint;
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const specs: Spec[] = [
  {
    id: "language",
    round: 1,
    textRequired: ["other"],
    validateText: (_, text) =>
      isValidLanguageTag(text)
        ? undefined
        : "language text must be a BCP-47 tag such as pt-BR or fr-CA",
    build: ({ hint }) => ({
      id: "language",
      header: "Language",
      question: "In which language will the thesis be written?",
      options: [
        option(
          "conversation",
          `Conversation language (${hint})`,
          "Use the language of this conversation.",
          { recommended: true },
        ),
        option("es", "Spanish", "Written in Spanish; the region follows the country you pick."),
        option("en", "English", "Written in English."),
        option("other", "Other language", "Type a BCP-47 tag such as pt-BR or fr-CA.", {
          placeholder: "BCP-47 tag, for example pt-BR",
        }),
      ],
    }),
  },
  {
    id: "workType",
    round: 1,
    build: () => ({
      id: "workType",
      header: "Work type",
      question: "What kind of work is it?",
      options: [
        option(
          "undergraduate_thesis",
          "Undergraduate thesis / degree project",
          "Final project for a bachelor's degree.",
          { recommended: true },
        ),
        option("master_thesis", "Master's thesis", "Final research work for a master's degree."),
        option(
          "doctoral_dissertation",
          "Doctoral dissertation",
          "Original research for a doctorate.",
        ),
        option("monograph", "Monograph", "A focused, single-topic study."),
      ],
    }),
  },
  {
    id: "country",
    round: 1,
    textRequired: ["other"],
    validateText: (_, text) =>
      /^[A-Za-z]{2}$/.test(text)
        ? undefined
        : "country text must be an ISO 3166-1 alpha-2 code such as MX",
    build: (context) => {
      const language = chosenLanguage(context);
      const colombia =
        primaryLanguage(language) === "es" && (countryFromContext(context) ?? "CO") === "CO";
      return {
        id: "country",
        header: "Country",
        question: "In which country will it be submitted?",
        options: [
          option("CO", "Colombia", "Loads the Colombian policy pack when it is available.", {
            recommended: colombia,
          }),
          option("other", "Other country", "Type an ISO 3166-1 alpha-2 code such as MX.", {
            placeholder: "ISO country code, for example MX",
          }),
        ],
      };
    },
  },
  {
    id: "secondaryAbstract",
    round: 1,
    textRequired: ["other"],
    validateText: (_, text) =>
      isValidLanguageTag(text)
        ? undefined
        : "secondaryAbstract text must be a BCP-47 tag such as pt-BR",
    build: (context) => {
      const english = primaryLanguage(chosenLanguage(context)) === "en";
      return {
        id: "secondaryAbstract",
        header: "Second abstract",
        question: "Does it need an abstract in a second language?",
        options: [
          option("en", "Yes, English", "Add an English abstract.", { recommended: !english }),
          option("none", "No", "A single-language abstract is enough.", { recommended: english }),
          option("other", "Yes, another language", "Type a BCP-47 tag such as pt-BR.", {
            placeholder: "BCP-47 tag, for example pt-BR",
          }),
        ],
      };
    },
  },
  {
    id: "institution",
    round: 2,
    textRequired: ["enter"],
    validateText: (_, text) =>
      parseInstitution(text) ? undefined : "institution text needs at least the university name",
    build: () => ({
      id: "institution",
      header: "Institution",
      question: "University, faculty and program",
      options: [
        option(
          "enter",
          "Enter them",
          "Format: University; Faculty; Program; City (only the university is required).",
          {
            recommended: true,
            placeholder: "University; Faculty; Program; City",
          },
        ),
        option("undecided", "Not decided yet", "Skip for now; you can edit thesis.yaml later."),
      ],
    }),
  },
  {
    id: "citationStyle",
    round: 2,
    build: () => ({
      id: "citationStyle",
      header: "Citation style",
      question: "Which citation style does your program require?",
      options: [
        option(
          "auto",
          "Let the policy decide",
          "Institution rules decide; otherwise APA 7 is used and flagged for you to confirm.",
          { recommended: true },
        ),
        option("apa-7", "APA 7", "Author-date citations."),
        option("ieee", "IEEE", "Numbered citations, common in engineering."),
        option(
          "icontec-ntc1486-2022",
          "ICONTEC NTC 1486:2022",
          "Colombian standard; never selected automatically.",
        ),
      ],
    }),
  },
  {
    id: "domain",
    round: 2,
    validateText: (value, text) =>
      value === "social_sciences" && !domainFromText(text)
        ? "domain text must contain letters or digits to derive a domain id"
        : undefined,
    build: () => ({
      id: "domain",
      header: "Domain",
      question: "Primary research domain",
      options: [
        option("detected", "Detected from the topic", "Decide the domain later from your topic.", {
          recommended: true,
        }),
        option(
          "computer_science",
          "Engineering / Computer science",
          "Technical and computing research.",
        ),
        option("health_sciences", "Health sciences", "Health and clinical research."),
        option(
          "social_sciences",
          "Social sciences / Education",
          "Optionally type a more precise domain.",
          { placeholder: "Optional: a more precise domain" },
        ),
      ],
    }),
  },
  {
    id: "approach",
    round: 2,
    validateText: (value, text) =>
      value === "mixed" && !(approaches as readonly string[]).includes(text)
        ? `approach text must be one of: ${approaches.join(", ")}`
        : undefined,
    build: ({ answers }) => ({
      id: "approach",
      header: "Approach",
      question: "Research approach",
      options: [
        option(
          "recommended",
          "Recommended from the domain",
          `Uses ${recommendedApproach(answers)} for your domain.`,
          { recommended: true },
        ),
        option("quantitative", "Quantitative", "Numerical data and statistical analysis."),
        option("qualitative", "Qualitative", "Interpretive analysis of non-numerical data."),
        option(
          "mixed",
          "Mixed",
          "Both. Optionally type design_science, theoretical or systematic_review instead.",
          { placeholder: "Optional: design_science, theoretical or systematic_review" },
        ),
      ],
    }),
  },
  {
    id: "title",
    round: 3,
    textRequired: ["enter"],
    build: () => ({
      id: "title",
      header: "Title",
      question: "Working title",
      options: [
        option("enter", "Enter it", "Type your working title.", { placeholder: "Working title" }),
        option(
          "propose",
          "Propose three titles from my topic",
          "The methodologist suggests three titles after design starts.",
          { recommended: true },
        ),
      ],
    }),
  },
  {
    id: "topic",
    round: 3,
    textRequired: ["enter"],
    build: () => ({
      id: "topic",
      header: "Topic",
      question: "Topic and problem in a few sentences",
      options: [
        option("enter", "Enter it", "Describe the topic and the problem.", {
          recommended: true,
          placeholder: "Topic and problem",
        }),
        option("later", "Decide later", "You must provide it before the design phase completes."),
      ],
    }),
  },
  {
    id: "objective",
    round: 3,
    textRequired: ["enter"],
    build: () => ({
      id: "objective",
      header: "General objective",
      question: "General objective",
      options: [
        option("enter", "Enter it", "Type your general objective.", {
          placeholder: "General objective",
        }),
        option(
          "draft",
          "Draft it with the methodologist",
          "The methodologist drafts it from your topic.",
          { recommended: true },
        ),
      ],
    }),
  },
  {
    id: "justification",
    round: 3,
    textRequired: ["enter"],
    build: () => ({
      id: "justification",
      header: "Justification",
      question: "Justification",
      options: [
        option("enter", "Enter it", "Type your justification.", { placeholder: "Justification" }),
        option(
          "draft",
          "Draft it with the methodologist",
          "The methodologist drafts it from your topic.",
          { recommended: true },
        ),
      ],
    }),
  },
  {
    id: "paper",
    round: 4,
    build: ({ answers }) => {
      const letter = defaultPaper(answers) === "letter";
      return {
        id: "paper",
        header: "Paper",
        question: "Paper size",
        options: [
          option("letter", "Letter", "US Letter; usual in Colombia and the United States.", {
            recommended: letter,
          }),
          option("a4", "A4", "ISO A4.", { recommended: !letter }),
        ],
      };
    },
  },
  {
    id: "palette",
    round: 4,
    build: () => ({
      id: "palette",
      header: "Palette",
      question: "Chart palette",
      options: [
        option("okabe-ito", "Okabe-Ito", "Color-blind safe default.", { recommended: true }),
        option("tol-bright", "Paul Tol Bright", "Color-blind safe, vivid."),
        option("tol-muted", "Paul Tol Muted", "Best for many categories."),
        option(
          "tol-high-contrast",
          "Grayscale-safe high contrast",
          "Survives black-and-white print; at most three series.",
        ),
      ],
    }),
  },
  {
    id: "fontProfile",
    round: 4,
    build: () => ({
      id: "fontProfile",
      header: "Typeface",
      question: "Typeface",
      options: [
        option("serif", "Serif", "Classic body text.", { recommended: true }),
        option("sans", "Sans", "Modern body text."),
        option("institutional", "Institutional", "Fonts provided in thesis/fonts/."),
      ],
    }),
  },
  {
    id: "aiDeclaration",
    round: 4,
    build: () => ({
      id: "aiDeclaration",
      header: "AI declaration",
      question: "AI-use declaration",
      options: [
        option(
          "auto",
          "Follow the policy",
          "Include the declaration when the policy requires it.",
          { recommended: true },
        ),
        option("always", "Always include", "Include the declaration regardless of policy."),
        option("never", "Never include", "Rejected at build time if the policy requires one."),
      ],
    }),
  },
  {
    id: "icontecFont",
    round: 5,
    textRequired: ["other"],
    validateText: (_option, text) =>
      /^[A-Za-z0-9][A-Za-z0-9 .-]{0,59}$/.test(text)
        ? undefined
        : "use a font family name (letters, digits, spaces)",
    build: () => ({
      id: "icontecFont",
      header: "ICONTEC font",
      question:
        "Which body font does your program require? The 2022 guides disagree, so there is no default.",
      options: [
        option("arial", "Arial", "Recommended by one 2022 guide (Pascual Bravo)."),
        option("times", "Times New Roman", "Used by another 2022 guide (EAFIT)."),
        option("other", "Another font", "Enter the family name.", {
          placeholder: "Font family",
        }),
      ],
    }),
  },
  {
    id: "icontecSpacing",
    round: 5,
    build: () => ({
      id: "icontecSpacing",
      header: "ICONTEC spacing",
      question:
        "Which body line spacing does your program require? The 2022 guides disagree, so there is no default.",
      options: [
        option("1", "Single (1.0)", "Single line spacing."),
        option("1.5", "One and a half (1.5)", "One-and-a-half line spacing."),
      ],
    }),
  },
];

const specById = new Map(specs.map((spec) => [spec.id, spec]));

function recommendedApproach(answers: Record<string, string>): string {
  const domain = answers.domain;
  if (domain === "computer_science") return "design_science";
  if (domain === "health_sciences") return "quantitative";
  return "mixed";
}

function defaultPaper(answers: Record<string, string>): "letter" | "a4" {
  const country = answers.country === "CO" ? "CO" : (answers["country:text"] ?? "").toUpperCase();
  return country === "CO" || country === "US" ? "letter" : "a4";
}

function domainFromText(text: string): string | undefined {
  const value = slug(text);
  return /^[a-z][a-z0-9_]{1,40}$/.test(value) ? value : undefined;
}

export function parseInstitution(
  text: string,
):
  | { name: string; faculty: string | null; program: string | null; city: string | null }
  | undefined {
  const parts = (text.includes(";") ? text.split(";") : text.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  const [name, faculty, program, city] = parts;
  if (!name || parts.length > 4) return undefined;
  return { name, faculty: faculty ?? null, program: program ?? null, city: city ?? null };
}

/** Whether an answer for this question is already known. */
function isAnswered(answers: Record<string, string>, id: string): boolean {
  return answers[id] !== undefined;
}

/** Questions of one round that are still unanswered (skips answered ones). */
export function buildRound(
  round: number,
  answers: Record<string, string>,
  hint: string,
): Question[] {
  return specs
    .filter((spec) => spec.round === round && !isAnswered(answers, spec.id))
    .map((spec) => spec.build({ hint, answers }));
}

export function roundIds(round: number): string[] {
  return specs.filter((spec) => spec.round === round).map((spec) => spec.id);
}

export interface AcceptResult {
  accepted: Record<string, string>;
  errors: string[];
}

/**
 * Validate raw answers against the option domain of the given questions. Free text travels under
 * `<id>:text`. For questions that offer an `other` option, an unknown value is read as that
 * option's text, so `language=pt-BR` works.
 */
export function acceptAnswers(
  questions: readonly Question[],
  input: Record<string, string>,
  hint: string,
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
    const spec = specById.get(question.id);
    const values = question.options.map((entry) => entry.value);
    if (!values.includes(value)) {
      const upper = value.toUpperCase();
      if (question.id === "country" && values.includes(upper)) {
        value = upper;
      } else if (values.includes("other") && text === undefined) {
        text = value;
        value = "other";
      } else {
        errors.push(
          `${question.id}: "${value}" is not allowed. Allowed values: ${values.join(", ")}`,
        );
        continue;
      }
    }
    const chosen = question.options.find((entry) => entry.value === value);
    if (text !== undefined) {
      if (!chosen?.textInput) {
        errors.push(`${question.id}: option "${value}" does not take free text`);
        continue;
      }
      if (text.length > maxText || controlPattern.test(text) || !text.trim()) {
        errors.push(`${question.id}: free text must be 1 to ${maxText} printable characters`);
        continue;
      }
      text = text.trim();
    } else if (spec?.textRequired?.includes(value)) {
      errors.push(`${question.id}: option "${value}" needs free text (${question.id}:text=...)`);
      continue;
    }
    if (text !== undefined) {
      const problem = spec?.validateText?.(value, text);
      if (problem) {
        errors.push(`${question.id}: ${problem}`);
        continue;
      }
    }
    if (question.id === "language" && value === "conversation") {
      accepted.language = "other";
      accepted["language:text"] = hint;
      continue;
    }
    accepted[question.id] = value;
    if (text !== undefined) accepted[`${question.id}:text`] = text;
  }
  return { accepted, errors };
}

/** Convert an `api.ui.askQuestions` result into the flat string map used for validation. */
export function flattenAnswers(result: AskQuestionsResult): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(result)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first !== "") flat[key] = first;
  }
  return flat;
}

/**
 * Parse `/thesis:answer` text: a JSON object, or `id=value` pairs separated by whitespace or
 * newlines (values run until the next `id=` token). `id:text=...` carries free text.
 */
export function parseAnswerText(text: string, ids: readonly string[]): Record<string, string> {
  const source = text.trim().replace(/^--\s*/, "");
  if (!source) throw new Error("No answers were given");
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
  const token = new RegExp(`(?:^|\\s)(${names.join("|")})=`, "g");
  const marks = [...source.matchAll(token)];
  if (marks.length === 0) {
    throw new Error(`Expected id=value pairs for: ${ids.join(", ")}`);
  }
  const first = marks[0] as RegExpMatchArray;
  if (source.slice(0, first.index).trim()) {
    throw new Error(
      `Unrecognized text before the first answer: ${source.slice(0, first.index).trim().slice(0, 40)}`,
    );
  }
  const flat: Record<string, string> = {};
  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? source.length;
    flat[mark[1] as string] = source.slice(start, end).trim();
  });
  return flat;
}

export function renderPending(pending: PendingQuestions): string {
  const lines = [
    pending.round === presentationRound
      ? "Thesis presentation settings (round 4)"
      : `Thesis interview, round ${pending.round} of ${defaultRounds.length}: ${roundTitles[pending.round] ?? ""}`,
    "Answer with /thesis:answer using id=value pairs (separated by spaces or new lines), or one JSON object.",
    "Free text goes in <id>:text=... for options marked (text).",
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
      return `${question.id}=${pick?.value}${pick?.textInput && pick.value === "enter" ? ` ${question.id}:text=...` : ""}`;
    })
    .join(" ");
  lines.push("", `Example: /thesis:answer ${example}`);
  return lines.join("\n");
}

/** Seed answers from the raw fields of a thesis.yaml that already exists. */
export function seedAnswersFromRaw(raw: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {};
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (typeof raw.language === "string") {
    answers.language = "other";
    answers["language:text"] = raw.language;
  }
  if (typeof raw.workType === "string") answers.workType = raw.workType;
  const institution = record(raw.institution);
  if (typeof institution.country === "string") {
    answers.country = institution.country === "CO" ? "CO" : "other";
    if (institution.country !== "CO") answers["country:text"] = institution.country;
  }
  if (raw.secondaryAbstractLanguage !== undefined) {
    if (raw.secondaryAbstractLanguage === null) answers.secondaryAbstract = "none";
    else if (typeof raw.secondaryAbstractLanguage === "string") {
      answers.secondaryAbstract = "other";
      answers["secondaryAbstract:text"] = raw.secondaryAbstractLanguage;
    }
  }
  if (typeof institution.name === "string" && institution.name) {
    answers.institution = "enter";
    answers["institution:text"] = [
      institution.name,
      institution.faculty,
      institution.program,
      institution.city,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join("; ");
  }
  if (typeof raw.citationStyle === "string") {
    answers.citationStyle = ["auto", "apa-7", "ieee", "icontec-ntc1486-2022"].includes(
      raw.citationStyle,
    )
      ? raw.citationStyle
      : "auto";
  }
  const domain = record(raw.domain);
  if (typeof domain.primary === "string" && domain.primary !== "undetermined") {
    answers.domain = "social_sciences";
    answers["domain:text"] = domain.primary;
  }
  if (typeof raw.approach === "string") {
    answers.approach =
      raw.approach === "quantitative" || raw.approach === "qualitative" ? raw.approach : "mixed";
    if (answers.approach === "mixed" && raw.approach !== "mixed")
      answers["approach:text"] = raw.approach;
  }
  if (typeof raw.title === "string" && raw.title) {
    answers.title = "enter";
    answers["title:text"] = raw.title;
  }
  const presentation = record(raw.presentation);
  for (const key of ["paper", "fontProfile", "palette"] as const) {
    if (typeof presentation[key] === "string") answers[key] = presentation[key] as string;
  }
  if (answers.palette && !(paletteNames as readonly string[]).includes(answers.palette))
    delete answers.palette;
  if (answers.palette === "viridis" || answers.palette === "cividis") delete answers.palette;
  if (typeof presentation.bodyFont === "string") {
    if (presentation.bodyFont === "Arial") answers.icontecFont = "arial";
    else if (presentation.bodyFont === "Times New Roman") answers.icontecFont = "times";
    else {
      answers.icontecFont = "other";
      answers["icontecFont:text"] = presentation.bodyFont;
    }
  }
  if (presentation.lineSpacing === 1 || presentation.lineSpacing === 1.5)
    answers.icontecSpacing = String(presentation.lineSpacing);
  const aiUse = record(raw.aiUse);
  if (typeof aiUse.declaration === "string") answers.aiDeclaration = aiUse.declaration;
  return answers;
}

function resolvedLanguage(
  answers: Record<string, string>,
  country: string | undefined,
  hint: string,
): string | undefined {
  const value = answers.language;
  if (value === "en") return "en";
  if (value === "es") return country && /^[A-Z]{2}$/.test(country) ? `es-${country}` : "es";
  if (value === "other") return answers["language:text"] ?? hint;
  return undefined;
}

export function intakeCountry(answers: Record<string, string>): string | undefined {
  if (answers.country === "CO") return "CO";
  if (answers.country === "other") return answers["country:text"]?.toUpperCase();
  return undefined;
}

export interface BriefBuildResult {
  text?: string;
  brief?: Brief;
  errors: string[];
}

/**
 * Overlay answered questions on an existing raw brief (or nothing) and produce the full
 * thesis.yaml. Fields no answer touches keep the user's values.
 */
export function buildBriefText(
  answers: Record<string, string>,
  existing: Record<string, unknown> | undefined,
  options: { hint: string; year: number },
): BriefBuildResult {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  const nested = (key: string): Record<string, unknown> => {
    const current = merged[key];
    const copy =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    merged[key] = copy;
    return copy;
  };
  merged.schemaVersion = 1;
  const institution = nested("institution");
  const country = intakeCountry(answers);
  if (country) institution.country = country;
  const language = resolvedLanguage(
    answers,
    country ?? (institution.country as string | undefined),
    options.hint,
  );
  if (language) merged.language = language;
  if (answers.workType) merged.workType = answers.workType as WorkType;
  switch (answers.secondaryAbstract) {
    case "en":
      merged.secondaryAbstractLanguage =
        primaryLanguage(String(merged.language ?? "")) === "en" ? null : "en";
      break;
    case "none":
      merged.secondaryAbstractLanguage = null;
      break;
    case "other":
      merged.secondaryAbstractLanguage = answers["secondaryAbstract:text"];
      break;
  }
  if (answers.institution === "enter" && answers["institution:text"]) {
    const parsed = parseInstitution(answers["institution:text"]);
    if (parsed) Object.assign(institution, parsed);
  }
  if (answers.citationStyle) merged.citationStyle = answers.citationStyle;
  if (answers.domain) {
    const domain = nested("domain");
    if (answers.domain === "detected") domain.primary = "undetermined";
    else if (answers.domain === "social_sciences" && answers["domain:text"]) {
      domain.primary = domainFromText(answers["domain:text"]) ?? "social_sciences";
    } else domain.primary = answers.domain;
    domain.secondary ??= [];
  }
  if (answers.approach) {
    const text = answers["approach:text"];
    if (answers.approach === "recommended") merged.approach = recommendedApproach(answers);
    else if (answers.approach === "mixed" && text) merged.approach = text;
    else merged.approach = answers.approach;
  }
  if (answers.title === "enter" && answers["title:text"]) merged.title = answers["title:text"];
  const presentation = nested("presentation");
  if (answers.paper) presentation.paper = answers.paper;
  else presentation.paper ??= defaultPaper(answers);
  if (answers.palette) presentation.palette = answers.palette;
  if (answers.fontProfile) presentation.fontProfile = answers.fontProfile;
  if (answers.icontecFont === "arial") presentation.bodyFont = "Arial";
  else if (answers.icontecFont === "times") presentation.bodyFont = "Times New Roman";
  else if (answers.icontecFont === "other" && answers["icontecFont:text"])
    presentation.bodyFont = answers["icontecFont:text"];
  if (answers.icontecSpacing) presentation.lineSpacing = Number(answers.icontecSpacing);
  if (answers.aiDeclaration) nested("aiUse").declaration = answers.aiDeclaration;
  merged.year ??= options.year;

  // Re-validate through the same loader the checks use, so a bad pre-existing file is not rewritten.
  const probe = loadBrief(JSON.stringify(merged));
  const errors = probe.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path || "thesis.yaml"}: ${issue.message}`);
  if (!probe.brief) return { errors };
  const brief = applyBriefDefaults(probe.brief);
  return { text: stringifyBrief(brief), brief, errors: [] };
}

/** The free-text research intent collected in round 3, for the methodologist. */
export function intakeIntent(answers: Record<string, string>): Record<string, string | null> {
  const pick = (id: string, enter: string): string | null =>
    answers[id] === enter ? (answers[`${id}:text`] ?? null) : null;
  return {
    title: pick("title", "enter"),
    topic: pick("topic", "enter"),
    objective: pick("objective", "enter"),
    justification: pick("justification", "enter"),
  };
}

export function hintFromEnvironment(env: NodeJS.ProcessEnv): string {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const match = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2}))?/.exec(raw);
  if (!match || match[1] === "C" || raw === "C" || raw === "POSIX") return "en";
  const tag = match[2] ? `${match[1]}-${match[2].toUpperCase()}` : (match[1] as string);
  return isValidLanguageTag(tag) ? tag : "en";
}

export function isRoundComplete(
  state: ThesisState | { intake: IntakeState },
  round: number,
): boolean {
  return state.intake.completedRounds.includes(round);
}
