import { flattenOutline, parseOutline } from "../outline.js";
import { countWords, proseOf, wordsOf } from "../render/text.js";
import { allSections } from "../render/walk.js";
import type { Finding } from "../types.js";
import { documentOf } from "./document.js";
import type { LoadedProject } from "./project.js";

/** WRT checks (G7, spec 9.2): word count, abstract limit, long sentences, repeated openings. */

const targetTolerance = 0.25;
export const longSentenceWords = 45;
const maxSentenceFindings = 5;

const sentencePattern = /(?<=[.!?…])\s+(?=[\p{Lu}\d¿¡"“(])/u;

export function sentencesOf(text: string): string[] {
  return text.split(sentencePattern).filter((sentence) => sentence.trim().length > 0);
}

export function checkWriting(project: LoadedProject): Finding[] {
  const assembled = documentOf(project);
  if (!assembled) return [];
  const findings: Finding[] = [];
  const targets = new Map<string, number>();
  if (project.outlineText !== undefined) {
    const outline = parseOutline(project.outlineText).outline;
    for (const node of flattenOutline(outline?.sections ?? []))
      targets.set(node.id, node.targetWords);
  }
  const limit = project.profile?.rules.find(
    (rule) => rule.kind === "length_limit" && rule.values.section === "abstract",
  );
  const maxAbstract =
    typeof limit?.values.maxWords === "number" ? limit.values.maxWords : undefined;
  const limitSeverity = limit?.values.severity === "error" ? "error" : "warning";

  for (const section of allSections(assembled.document)) {
    const prose = proseOf(section.blocks);
    const body = prose.filter((paragraph) => !paragraph.heading);
    const base = {
      file: section.path,
      ...(section.section ? { section: section.section } : {}),
    };
    const words = body.reduce((sum, paragraph) => sum + countWords(paragraph.text), 0);

    // WRT-001: the word count of a chapter against its outline target.
    const target = section.section ? targets.get(section.section) : undefined;
    if (section.role === "body" && target !== undefined && target > 0 && words > 0) {
      const low = Math.floor(target * (1 - targetTolerance));
      const high = Math.ceil(target * (1 + targetTolerance));
      if (words < low || words > high)
        findings.push({
          code: "WRT-001",
          gate: "G7",
          severity: "warning",
          ...base,
          message: `${words} words against a target of ${target} (allowed ${low} to ${high})`,
          hint: "Adjust the section, or change targetWords in the outline when the target was wrong.",
        });
    }

    // WRT-002: abstract word limit from the policy.
    if (
      (section.role === "abstract" || section.role === "abstract-secondary") &&
      maxAbstract !== undefined &&
      words > maxAbstract
    )
      findings.push({
        code: "WRT-002",
        gate: "G7",
        severity: limitSeverity,
        ...base,
        message: `The abstract has ${words} words; the policy limit is ${maxAbstract}`,
        hint: `Rule ${limit?.ruleId}; see /thesis:pack explain ${limit?.ruleId}.`,
      });

    // WRT-003: very long sentences.
    let long = 0;
    let longTotal = 0;
    for (const paragraph of body) {
      for (const sentence of sentencesOf(paragraph.text)) {
        const count = wordsOf(sentence).length;
        if (count <= longSentenceWords) continue;
        longTotal += 1;
        if (long >= maxSentenceFindings) continue;
        long += 1;
        findings.push({
          code: "WRT-003",
          gate: "G7",
          severity: "warning",
          ...base,
          ...(paragraph.line === undefined ? {} : { line: paragraph.line }),
          message: `A sentence has ${count} words (more than ${longSentenceWords}): "${sentence.slice(0, 60).trim()}..."`,
          hint: "Split it into two sentences.",
        });
      }
    }
    if (longTotal > long)
      findings.push({
        code: "WRT-003",
        gate: "G7",
        severity: "info",
        ...base,
        message: `${longTotal - long} more long sentence(s) not listed`,
      });

    // WRT-004: paragraphs that open with the same three words.
    const openings = new Map<string, number>();
    for (const paragraph of body) {
      const opening = wordsOf(paragraph.text.toLowerCase()).slice(0, 3);
      if (opening.length < 3) continue;
      const key = opening.join(" ");
      openings.set(key, (openings.get(key) ?? 0) + 1);
    }
    for (const [opening, count] of openings)
      if (count >= 2)
        findings.push({
          code: "WRT-004",
          gate: "G7",
          severity: "warning",
          ...base,
          message: `${count} paragraphs open with "${opening}"`,
          hint: "Vary how paragraphs begin; each should open with its own topic sentence.",
        });
  }
  return findings;
}
