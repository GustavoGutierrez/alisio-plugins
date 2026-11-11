/**
 * Grade matching for free text: the chat's "other grade" answer is typed by the teacher, so
 * "primero", "Primero", "1", "1º" and "grado 1" must all find the topics tagged "Primero".
 */

const ORDINALS = [
  "primero",
  "segundo",
  "tercero",
  "cuarto",
  "quinto",
  "sexto",
  "septimo",
  "octavo",
  "noveno",
  "decimo",
  "undecimo",
];

const ALIASES: Record<string, string> = { primer: "primero", tercer: "tercero", once: "undecimo" };

/** A comparable key for a grade name: accents and case folded, numerals mapped to ordinals. */
export function gradeKey(text: string): string {
  const folded = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\bgrados?\b/g, "")
    .replace(/[º°.]/g, "")
    .trim();
  const numeral = /^(\d{1,2})(ro|do|to|vo|no|mo)?$/.exec(folded);
  if (numeral !== null) return ORDINALS[Number(numeral[1]) - 1] ?? folded;
  return ALIASES[folded] ?? folded;
}

/** True when a topic's grade list contains the asked grade, compared by `gradeKey`. */
export function gradeMatches(grades: readonly string[], asked: string): boolean {
  const key = gradeKey(asked);
  return key !== "" && grades.some((grade) => gradeKey(grade) === key);
}
