import { labelsFor } from "./labels.js";
import type { OutlineDraft, OutlineNodeDraft } from "./schemas.js";
import { idPatterns } from "./types.js";

export interface OutlineNode {
  id: string;
  key: string;
  title: string;
  requiredKey?: string;
  purpose: string;
  objectives: string[];
  researchTopics: string[];
  questionsToAnswer: string[];
  evidenceNeeds: string[];
  targetWords: number;
  dependsOn: string[];
  children: OutlineNode[];
}

export interface OutlineDocument {
  schemaVersion: 1;
  language: string;
  generatedAt: string;
  sections: OutlineNode[];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Section ids are allocated by code in document order: SEC-01, SEC-01.01, SEC-01.01.01. */
export function buildOutline(
  draft: OutlineDraft,
  meta: { language: string; now: Date },
): OutlineDocument {
  const ids = new Map<string, string>();
  const assign = (nodes: readonly OutlineNodeDraft[], prefix: string) => {
    nodes.forEach((node, index) => {
      const id = prefix ? `${prefix}.${pad(index + 1)}` : `SEC-${pad(index + 1)}`;
      ids.set(node.key, id);
      assign(node.children, id);
    });
  };
  assign(draft.sections, "");
  const convert = (node: OutlineNodeDraft): OutlineNode => ({
    id: ids.get(node.key) as string,
    key: node.key,
    title: node.title,
    ...(node.requiredKey ? { requiredKey: node.requiredKey } : {}),
    purpose: node.purpose,
    objectives: node.objectives,
    researchTopics: node.researchTopics,
    questionsToAnswer: node.questionsToAnswer,
    evidenceNeeds: node.evidenceNeeds,
    targetWords: node.targetWords,
    dependsOn: node.dependsOn.map((key) => ids.get(key) as string),
    children: node.children.map(convert),
  });
  return {
    schemaVersion: 1,
    language: meta.language,
    generatedAt: meta.now.toISOString(),
    sections: draft.sections.map(convert),
  };
}

/** Pre-order (document order) listing. */
export function flattenOutline(sections: readonly OutlineNode[]): OutlineNode[] {
  return sections.flatMap((node) => [node, ...flattenOutline(node.children)]);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ParsedOutline {
  outline?: OutlineDocument;
  /** Shape problems (check OUT-001). */
  errors: string[];
}

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Parse `outline.json`; every shape problem is reported rather than thrown. */
export function parseOutline(source: string): ParsedOutline {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { errors: ["outline.json is not valid JSON"] };
  }
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.sections)) {
    return { errors: ["outline.json must be an object with schemaVersion 1 and a sections list"] };
  }
  const errors: string[] = [];
  const read = (entry: unknown, path: string, depth: number): OutlineNode | undefined => {
    if (!isObject(entry)) {
      errors.push(`${path} must be an object`);
      return undefined;
    }
    const problems = errors.length;
    for (const key of ["id", "key", "title", "purpose"] as const) {
      if (typeof entry[key] !== "string" || !entry[key])
        errors.push(`${path}.${key} must be a non-empty string`);
    }
    for (const key of [
      "objectives",
      "researchTopics",
      "questionsToAnswer",
      "evidenceNeeds",
      "dependsOn",
    ] as const) {
      if (!stringList(entry[key])) errors.push(`${path}.${key} must be a list of strings`);
    }
    if (!Number.isInteger(entry.targetWords)) errors.push(`${path}.targetWords must be an integer`);
    if (entry.requiredKey !== undefined && typeof entry.requiredKey !== "string") {
      errors.push(`${path}.requiredKey must be a string`);
    }
    const children: OutlineNode[] = [];
    if (!Array.isArray(entry.children)) errors.push(`${path}.children must be a list`);
    else if (depth >= 3 && entry.children.length > 0)
      errors.push(`${path} nests deeper than three levels`);
    else {
      entry.children.forEach((child, index) => {
        const node = read(child, `${path}.children[${index}]`, depth + 1);
        if (node) children.push(node);
      });
    }
    return errors.length === problems
      ? ({ ...(entry as unknown as OutlineNode), children } as OutlineNode)
      : undefined;
  };
  const sections: OutlineNode[] = [];
  value.sections.forEach((entry, index) => {
    const node = read(entry, `sections[${index}]`, 1);
    if (node) sections.push(node);
  });
  if (errors.length > 0) return { errors };
  return {
    errors,
    outline: {
      schemaVersion: 1,
      language: typeof value.language === "string" ? value.language : "en",
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
      sections,
    },
  };
}

export function isSectionId(value: string): boolean {
  return idPatterns.section.test(value);
}

export interface OutlineRenderContext {
  /** Specific objectives (and the general one) with their text, for the coverage matrix. */
  objectives: { id: string; text: string }[];
}

export function renderOutlineMarkdown(
  outline: OutlineDocument,
  context: OutlineRenderContext,
): string {
  const l = labelsFor(outline.language);
  const lines: string[] = [`# ${l.outline}`, "", `> ${l.outlineNote}`, ""];
  const render = (node: OutlineNode, depth: number) => {
    const hashes = "#".repeat(Math.min(depth + 1, 6));
    lines.push(
      `${hashes} ${node.id} ${node.title}${node.requiredKey ? ` (${l.required}: ${node.requiredKey})` : ""}`,
      "",
    );
    lines.push(`- ${l.purpose}: ${node.purpose}`);
    lines.push(`- ${l.objectives}: ${node.objectives.join(", ") || l.none}`);
    lines.push(`- ${l.topics}: ${node.researchTopics.join("; ")}`);
    if (node.questionsToAnswer.length)
      lines.push(`- ${l.questions}: ${node.questionsToAnswer.join("; ")}`);
    lines.push(`- ${l.evidenceNeeds}: ${node.evidenceNeeds.join(", ") || l.none}`);
    lines.push(`- ${l.words}: ${node.targetWords}`);
    if (node.dependsOn.length) lines.push(`- ${l.dependsOn}: ${node.dependsOn.join(", ")}`);
    lines.push("");
    for (const child of node.children) render(child, depth + 1);
  };
  for (const node of outline.sections) render(node, 1);
  const all = flattenOutline(outline.sections);
  lines.push(`## ${l.coverage}`, "");
  for (const objective of context.objectives) {
    const covering = all
      .filter((node) => node.objectives.includes(objective.id))
      .map((node) => node.id);
    lines.push(`- ${objective.id} ${objective.text}: ${covering.join(", ") || l.none}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
