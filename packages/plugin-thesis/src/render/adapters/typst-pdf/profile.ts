import type { PresentationProfile } from "../../../styles/profile.js";
import { typstString } from "./escape.js";

/**
 * The only place where a format-neutral presentation profile becomes Typst settings (spec 10.4.1).
 * Profile data never contains Typst; this module emits a fixed-shape dictionary whose values are
 * validated lengths, numbers, booleans, alignments or escaped strings.
 */

const str = (value: string | null): string => (value === null ? "none" : typstString(value));
const list = (items: readonly string[]): string =>
  items.length === 0 ? "()" : `(${items.map(typstString).join(", ")},)`;
const pt = (value: number): string => `${value}pt`;
const flag = (value: boolean): string => (value ? "true" : "false");

const alignments = new Set(["left", "center", "right", "top", "bottom"]);
const align = (value: string): string => {
  if (!alignments.has(value)) throw new Error(`Unsupported alignment ${value}`);
  return value;
};

export function typstProfile(profile: PresentationProfile): string {
  const margins =
    profile.binding === "mirrored"
      ? `(top: ${profile.margins.top}, bottom: ${profile.margins.bottom}, inside: ${profile.margins.inside}, outside: ${profile.margins.outside})`
      : `(top: ${profile.margins.top}, bottom: ${profile.margins.bottom}, left: ${profile.margins.inside}, right: ${profile.margins.outside})`;
  const headings = profile.headings
    .map(
      (heading) =>
        `    (size: ${pt(heading.size)}, weight: ${typstString(heading.weight)}, case: ${typstString(heading.case)}, numbering: ${typstString(heading.numbering)}, align: ${align(heading.align)}, above: ${heading.spaceBefore}, below: ${heading.spaceAfter}, new-page: ${flag(heading.newPage)}, run-in: ${flag(heading.runIn)}, ends-with: ${typstString(heading.endsWith)}),`,
    )
    .join("\n");
  const pages = profile.pageNumbers;
  const front = pages.front === "none" ? "none" : pages.front === "roman" ? '"i"' : '"1"';
  const body = pages.body === "none" ? "none" : '"1"';
  const restart = !pages.continuous;
  const lines = [
    `// Generated from the presentation profile "${profile.id}". Do not edit.`,
    ...(profile.ruleIds.length > 0 ? [`// Rules: ${profile.ruleIds.join(", ")}`] : []),
    "#let profile = (",
    `  id: ${typstString(profile.id)},`,
    `  margins: ${margins},`,
    `  font: (body: ${str(profile.font.body)}, headings: ${str(profile.font.headings)}, mono: ${str(profile.font.mono)}),`,
    `  font-size: ${pt(profile.font.size)},`,
    `  line-spacing: ${profile.lineSpacing},`,
    `  paragraph: (indent: ${profile.paragraph.indent}, spacing: ${profile.paragraph.spacing}, justify: ${flag(profile.paragraph.justify)}),`,
    "  headings: (",
    headings,
    "  ),",
    `  annex-numbering: ${typstString(profile.annexNumbering)},`,
    `  toc-depth: ${profile.toc.depth},`,
    `  toc-page-label: ${flag(profile.toc.pageLabel)},`,
    `  captions: (figure: ${align(profile.captions.figurePosition)}, table: ${align(profile.captions.tablePosition)}, separator: ${typstString(profile.captions.separator)}, source-below: ${flag(profile.captions.sourceBelow)}, per-chapter: ${flag(profile.captions.numbering === "chapter")}, label-style: ${typstString(profile.captions.labelStyle)}),`,
    `  page-numbers: (front: ${front}, body: ${body}, position: ${align(pages.position)}, restart-front: ${flag(restart && pages.front !== "none")}, restart-body: ${flag(restart && pages.body !== "none")}),`,
    `  header: ${profile.header === "none" ? "none" : typstString(profile.header)},`,
    `  front-order: ${list(profile.frontMatter)},`,
    `  cover: (fields: ${list(profile.cover.fields)}, layout: ${typstString(profile.cover.layout)}),`,
    `  footnote-size: ${profile.footnotes.size},`,
    ")",
    "",
  ];
  return lines.join("\n");
}
