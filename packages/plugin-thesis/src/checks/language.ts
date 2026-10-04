import { proseOf, wordsOf } from "../render/text.js";
import { allSections } from "../render/walk.js";
import type { Finding } from "../types.js";
import { documentOf } from "./document.js";
import type { LoadedProject } from "./project.js";

/**
 * LNG-001 (G7): each section is written in the language it should be (spec 9.2). The language of a
 * text is the one whose function words are most frequent among English, Spanish, Portuguese and
 * French; it is a heuristic, so the finding is a warning and short texts are not judged.
 */

const stopWords: Record<string, ReadonlySet<string>> = {
  en: new Set(
    "the of and to in is that it for as with was on are by this be or from at an which have has not but they their its been were also than these can more such into other between during may would should only each both our we".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las de del y en que es un una por con para se su sus al lo como más pero sí este esta estos estas fue son ser ha han entre sobre también muy sin hasta desde cuando donde porque le les o u e nuestro nuestra".split(
      " ",
    ),
  ),
  pt: new Set(
    "o a os as de do da dos das e em que é um uma por com para se seu sua seus suas ao como mais mas não este esta estes estas foi são ser tem têm entre sobre também muito sem até desde quando onde porque lhe ou nos nas pelo pela pelos pelas".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les de des du et en que qui est un une pour par avec dans sur au aux ce cette ces son sa ses ne pas plus mais ou où comme été sont être a ont entre aussi très sans jusqu depuis quand parce lui leur leurs nous vous".split(
      " ",
    ),
  ),
};

export const supportedLanguageCodes = Object.keys(stopWords);

/** Words below this count are too few to judge. */
const minWords = 30;
/** The expected language must score at least this share of the best language's ratio. */
const tolerance = 0.6;

export interface LanguageGuess {
  /** Stop-word ratio per language. */
  ratios: Record<string, number>;
  best: string;
  words: number;
}

export function guessLanguage(text: string): LanguageGuess {
  const words = wordsOf(text.toLowerCase());
  const ratios: Record<string, number> = {};
  for (const [code, set] of Object.entries(stopWords)) {
    ratios[code] =
      words.length === 0 ? 0 : words.filter((word) => set.has(word)).length / words.length;
  }
  const best = Object.keys(ratios).sort(
    (a, b) => (ratios[b] as number) - (ratios[a] as number),
  )[0] as string;
  return { ratios, best, words: words.length };
}

const primary = (tag: string | null | undefined): string =>
  (tag ?? "").split("-")[0]?.toLowerCase() ?? "";

/** True when `text` looks like it is not written in `expected` (a code among en, es, pt, fr). */
export function looksForeign(text: string, expected: string): LanguageGuess | undefined {
  if (!(expected in stopWords)) return undefined;
  const guess = guessLanguage(text);
  if (guess.words < minWords || guess.best === expected) return undefined;
  const best = guess.ratios[guess.best] as number;
  return (guess.ratios[expected] as number) < best * tolerance ? guess : undefined;
}

export function checkLanguage(project: LoadedProject): Finding[] {
  const assembled = documentOf(project);
  const brief = project.brief?.brief;
  if (!assembled || !brief) return [];
  const main = primary(brief.language);
  const findings: Finding[] = [];
  for (const section of allSections(assembled.document)) {
    let expected = main;
    if (section.role === "abstract") expected = primary(section.lang) || main;
    else if (section.role === "abstract-secondary")
      expected = primary(section.lang) || primary(brief.secondaryAbstractLanguage) || "en";
    const text = proseOf(section.blocks)
      .filter((paragraph) => !paragraph.heading)
      .map((paragraph) => paragraph.text)
      .join(" ");
    const guess = looksForeign(text, expected);
    if (!guess) continue;
    findings.push({
      code: "LNG-001",
      gate: "G7",
      severity: "warning",
      file: section.path,
      ...(section.section ? { section: section.section } : {}),
      message: `The text looks ${guess.best} but should be ${expected} (${section.role === "body" || section.role === "annex" ? "thesis language" : `${section.role} language`}; function-word ratio ${(guess.ratios[guess.best] as number).toFixed(2)} vs ${((guess.ratios[expected] as number) ?? 0).toFixed(2)})`,
      hint: "Rewrite the section in the declared language, or declare the abstract's language in its front matter (lang:).",
    });
  }
  return findings;
}
