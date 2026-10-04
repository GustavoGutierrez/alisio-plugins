import { flattenOutline, type OutlineDocument, type OutlineNode } from "./outline.js";
import type { SectionRole } from "./render/model.js";
import type { Brief } from "./types.js";

/**
 * How an outline section becomes a chapter file: its role, whether it carries a heading and where
 * the file lives. The 4a convention is `chapters/NN-<slug>.md` with `section: SEC-xx` in the front
 * matter; annexes live under `chapters/annexes/`.
 */

export interface SectionPlan {
  id: string;
  node: OutlineNode;
  role: SectionRole;
  /** Language of an abstract, BCP-47 primary subtag. */
  lang?: string;
  /** The title is printed by the template (abstracts and similar) or by a heading in the file. */
  heading: boolean;
  /** Heading level of the section title (1 to 4). */
  level: number;
  /** The bibliography is generated from the library; no chapter file exists. */
  generated: boolean;
  /** Chapter file, relative to the thesis root. */
  path: string;
}

const generatedKeys = new Set(["referencias", "bibliografia", "references", "bibliography"]);
const annexKeys = new Set(["anexos", "annexes", "apendices"]);

export const slugOf = (key: string): string =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "section";

const depthOf = (id: string): number => id.slice(4).split(".").length;

/** `SEC-03` -> `03`, `SEC-03.02` -> `0302`: files sort parents before children. */
const prefixOf = (id: string): string => id.slice(4).replace(/\./g, "");

const primary = (language: string): string => language.split("-")[0]?.toLowerCase() ?? "en";

/** Plan every section of an outline. */
export function planSections(
  outline: OutlineDocument,
  brief: Pick<Brief, "language" | "secondaryAbstractLanguage">,
): Map<string, SectionPlan> {
  const plans = new Map<string, SectionPlan>();
  const visit = (nodes: readonly OutlineNode[], inAnnex: boolean, depth: number) => {
    for (const node of nodes) {
      const required = node.requiredKey;
      const annex = inAnnex || (required !== undefined && annexKeys.has(required));
      let role: SectionRole = annex ? "annex" : "body";
      let lang: string | undefined;
      let heading = true;
      if (required === "resumen" || required === "abstract") {
        const main = primary(brief.language);
        if (required === "resumen" || main === "en") {
          role = "abstract";
          lang = required === "resumen" ? main : "en";
        } else {
          role = "abstract-secondary";
          lang = primary(brief.secondaryAbstractLanguage ?? "en");
        }
        heading = false;
      } else if (required === "dedicatoria") [role, heading] = ["dedication", false];
      else if (required === "agradecimientos") [role, heading] = ["acknowledgments", false];
      else if (required === "ai_declaration") [role, heading] = ["ai-declaration", false];
      const generated = required !== undefined && generatedKeys.has(required);
      const level = Math.min(depth, 4);
      const directory = role === "annex" ? "chapters/annexes" : "chapters";
      plans.set(node.id, {
        id: node.id,
        node,
        role,
        ...(lang ? { lang } : {}),
        heading,
        level,
        generated,
        path: `${directory}/${prefixOf(node.id)}-${slugOf(node.key)}.md`,
      });
      visit(node.children, annex, depth + 1);
    }
  };
  visit(outline.sections, false, 1);
  return plans;
}

export { depthOf };
export const allNodes = (outline: OutlineDocument): OutlineNode[] =>
  flattenOutline(outline.sections);
