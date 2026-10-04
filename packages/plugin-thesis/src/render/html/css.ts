import { readFileSync } from "node:fs";
import { packagePath } from "../../package-paths.js";
import type { PresentationProfile } from "../../styles/profile.js";
import type { ResolvedMeta } from "../model.js";

/**
 * CSS Paged Media for the HTML/Chrome output (spec 10.7). `templates/html/thesis.css` carries the
 * structure; this module turns the format-neutral presentation profile into the concrete values:
 * paper, margins, fonts, heading styles, caption and page-number settings, the running header and
 * the table-of-contents page counters. Profile values are already validated lengths, numbers and
 * keywords (PRF-001); they are checked again here before entering a stylesheet.
 */

export function staticCss(): string {
  return readFileSync(packagePath("templates", "html", "thesis.css"), "utf8");
}

const lengthPattern = /^\d{1,3}(?:\.\d{1,3})?(?:cm|mm|in|pt|em)$/;
const length = (value: string): string => {
  if (!lengthPattern.test(value)) throw new Error(`Unsupported length ${value}`);
  return value;
};
const cssNumber = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`Unsupported number ${value}`);
  return String(Math.round(value * 1000) / 1000);
};

const fontStacks: Record<ResolvedMeta["fontProfile"], string[]> = {
  serif: ["Libertinus Serif", "New Computer Modern", "Times New Roman", "Liberation Serif"],
  sans: ["Liberation Sans", "Arimo", "DejaVu Sans", "Helvetica", "Arial"],
  institutional: ["Libertinus Serif", "Times New Roman", "Liberation Serif"],
};

const quoteFont = (name: string): string => `"${name.replace(/[^\p{L}\p{N} ._-]/gu, "")}"`;

/** Font-family value for body text: explicit fonts first, then the profile's stack. */
export function bodyFontFamily(
  profile: PresentationProfile,
  meta: Pick<ResolvedMeta, "fontProfile" | "bodyFont">,
  headings = false,
): string {
  const named = [headings ? profile.font.headings : null, meta.bodyFont ?? profile.font.body]
    .filter((value): value is string => Boolean(value))
    .map(quoteFont);
  const base = (fontStacks[meta.fontProfile] ?? fontStacks.serif).map(quoteFont);
  const generic = meta.fontProfile === "sans" ? "sans-serif" : "serif";
  return [...named, ...base, generic].join(", ");
}

/** Length in centimetres; `em` is relative to the body font size in points. */
function toCm(value: string, fontPt: number): number {
  const amount = Number.parseFloat(value);
  if (value.endsWith("mm")) return amount / 10;
  if (value.endsWith("cm")) return amount;
  if (value.endsWith("in")) return amount * 2.54;
  if (value.endsWith("em")) return (amount * fontPt * 2.54) / 72;
  return (amount * 2.54) / 72;
}

function pageNumberCss(
  position: "left" | "center" | "right",
  format: string | null,
  extra = "",
): string {
  if (format === null) return "";
  return `  @bottom-${position} { content: counter(page${format ? `, ${format}` : ""}); font-size: 0.85em; ${extra}}\n`;
}

export function generateCss(
  profile: PresentationProfile,
  meta: Pick<ResolvedMeta, "paper" | "fontProfile" | "bodyFont" | "lineSpacing">,
): string {
  const m = {
    top: length(profile.margins.top),
    bottom: length(profile.margins.bottom),
    inside: length(profile.margins.inside),
    outside: length(profile.margins.outside),
  };
  const paper = meta.paper === "a4" ? "A4" : "letter";
  const spacing = meta.lineSpacing ?? profile.lineSpacing;
  const lines: string[] = [`/* Generated from the presentation profile "${profile.id}". */`];

  lines.push(`@page { size: ${paper}; margin: ${m.top} ${m.outside} ${m.bottom} ${m.inside}; }`);
  if (profile.binding === "mirrored") {
    lines.push(
      `@page :left { margin: ${m.top} ${m.inside} ${m.bottom} ${m.outside}; }`,
      `@page :right { margin: ${m.top} ${m.outside} ${m.bottom} ${m.inside}; }`,
    );
  }

  const pages = profile.pageNumbers;
  const position = pages.position;
  const frontFormat = pages.front === "none" ? null : pages.front === "roman" ? "lower-roman" : "";
  const bodyFormat = pages.body === "none" ? null : "";
  lines.push(`@page cover { @bottom-center { content: none; } }`);
  lines.push(`@page front {\n${pageNumberCss(position, frontFormat)}}`);
  const header =
    profile.header === "none"
      ? ""
      : "  @top-right { content: string(chapter-title); font-size: 0.85em; font-style: italic; border-bottom: 0.4pt solid currentColor; padding-bottom: 0.3em; }\n";
  lines.push(`@page body {\n${pageNumberCss(position, bodyFormat)}${header}}`);

  const restart = !pages.continuous;
  lines.push(
    `.front { ${restart && pages.front !== "none" ? "counter-reset: page 1;" : ""} }`,
    `.body { ${restart && pages.body !== "none" ? "counter-reset: page 1;" : ""} }`,
  );

  const body = bodyFontFamily(profile, meta);
  const headingFont = bodyFontFamily(profile, meta, true);
  const mono = profile.font.mono
    ? `${quoteFont(profile.font.mono)}, "DejaVu Sans Mono", "Liberation Mono", monospace`
    : `"DejaVu Sans Mono", "Liberation Mono", monospace`;
  lines.push(
    `html { font-family: ${body}; font-size: ${cssNumber(profile.font.size)}pt; line-height: ${cssNumber(1.2 * spacing)}; ${profile.paragraph.justify ? "text-align: justify; hyphens: auto;" : "text-align: left;"} text-align-last: left; }`,
    `p { margin: 0 0 ${length(profile.paragraph.spacing)}; text-indent: ${length(profile.paragraph.indent)}; orphans: 2; widows: 2; }`,
    `p.np, .runin-p, li > p, figure p, blockquote p { text-indent: 0; }`,
    `code, pre { font-family: ${mono}; }`,
    `.fn { font-size: ${cssNumber(profile.footnotes.size)}pt; line-height: 1.25; }`,
    `@page { @footnote { border-top: 0.4pt solid currentColor; padding-top: 0.4em; margin-top: 0.8em; } }`,
  );

  // Cover: groups spaced in proportion to the text block height (no flex: Paged.js cannot split it).
  const heightCm =
    (meta.paper === "a4" ? 29.7 : 27.94) -
    toCm(m.top, profile.font.size) -
    toCm(m.bottom, profile.font.size);
  const gap = Math.max(1, Math.round(heightCm * 0.12 * 10) / 10);
  lines.push(
    `.cover { padding-top: ${Math.round(heightCm * 0.06 * 10) / 10}cm; }`,
    `.cv-gap { margin-top: ${gap}cm; }`,
  );

  profile.headings.forEach((heading, index) => {
    const level = index + 1;
    const selectors = [`h${level}`, `.runin.h${level}`];
    lines.push(
      `${selectors.join(", ")} { font-family: ${headingFont}; font-size: ${cssNumber(heading.size)}pt; font-weight: ${heading.weight === "bold" ? "bold" : "normal"}; ${heading.case === "upper" ? "text-transform: uppercase;" : heading.case === "lower" ? "text-transform: lowercase;" : ""} text-align: ${heading.align}; text-align-last: ${heading.align}; hyphens: manual; }`,
    );
    if (!heading.runIn || level === 1) {
      lines.push(
        `h${level} { margin-top: ${length(heading.spaceBefore)}; margin-bottom: ${length(heading.spaceAfter)}; }`,
        ...(heading.newPage && level === 1 ? ["h1.chapter { break-before: page; }"] : []),
      );
    }
  });
  const first = profile.headings[0];
  lines.push(
    `h1.front-title { text-align: ${first?.align ?? "left"}; text-align-last: ${first?.align ?? "left"}; text-transform: ${first?.case === "upper" ? "uppercase" : "none"}; }`,
    // The running header takes the chapter title only; the number stays out of it.
    `h1.chapter .htext { string-set: chapter-title content(text); }`,
  );
  lines.push(`.front-part { break-before: page; }`);

  // Table of contents and folios: the runtime writes the printed page labels (`data-page`,
  // `data-folio`) after pagination, because it knows the area and numbering format of every page.
  lines.push(
    `.toc-list a::after { content: attr(data-page); }`,
    `.pagedjs_margin-content[data-folio]::after { content: attr(data-folio) !important; }`,
  );
  return `${lines.join("\n")}\n`;
}
