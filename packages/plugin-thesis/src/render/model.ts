import type { ResolvedCitationStyle } from "../styles/discovery.js";
import type { PresentationProfile } from "../styles/profile.js";
import type { EvidenceRecord, Finding } from "../types.js";

/**
 * Renderer-neutral document model (spec 10.0). Markdown is parsed into this once per build; every
 * output adapter (Typst PDF today, DOCX or HTML later) consumes only these types. Nothing here may
 * mention a concrete output format.
 */

export type Label = string;
export type LabelKind = "fig" | "tbl" | "eq" | "sec";

// ---------------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------------

export interface Text {
  kind: "text";
  text: string;
}
export interface Emph {
  kind: "emph";
  children: Inline[];
}
export interface Strong {
  kind: "strong";
  children: Inline[];
}
export interface Code {
  kind: "code";
  text: string;
}
export interface MathInline {
  kind: "math";
  latex: string;
}
export interface CitationItem {
  key: string;
  /** Page or section locator, for example `p. 17`. */
  locator?: string;
}
export interface Citation {
  kind: "citation";
  items: CitationItem[];
  /** `@key` in running text (author as part of the sentence) rather than `[@key]`. */
  narrative: boolean;
}
export interface CrossRef {
  kind: "crossref";
  label: Label;
  refKind: LabelKind;
}
export interface Link {
  kind: "link";
  href: string;
  children: Inline[];
}
export interface FootnoteRef {
  kind: "footnote";
  id: string;
}
export interface LineBreak {
  kind: "break";
}
export type Inline =
  | Text
  | Emph
  | Strong
  | Code
  | MathInline
  | Citation
  | CrossRef
  | Link
  | FootnoteRef
  | LineBreak;

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

interface BlockBase {
  /** 1-based source line of the block, for findings. */
  line?: number;
}
export interface Paragraph extends BlockBase {
  kind: "paragraph";
  children: Inline[];
  /** Claim anchor id from `<!-- claim:id -->`; consumed by the claim checks, never rendered. */
  claim?: string;
}
export interface Heading extends BlockBase {
  kind: "heading";
  level: 1 | 2 | 3 | 4;
  children: Inline[];
  label?: Label;
}
export interface List extends BlockBase {
  kind: "list";
  ordered: boolean;
  items: Block[][];
}
export interface TableBlock extends BlockBase {
  kind: "table";
  align: ("left" | "center" | "right" | null)[];
  header: Inline[][];
  rows: Inline[][][];
  caption?: Inline[];
  source?: Inline[];
  label?: Label;
}
export interface Figure extends BlockBase {
  kind: "figure";
  asset: FigureAsset;
  caption: Inline[];
  /** The "Source: ..." sentence split from the caption, when present. */
  source?: Inline[];
  label?: Label;
  /** CSS-like width such as `80%` (validated by the dialect). */
  width?: string;
}
export interface Equation extends BlockBase {
  kind: "equation";
  latex: string;
  label?: Label;
}
export interface Quote extends BlockBase {
  kind: "quote";
  children: Block[];
}
export interface CodeBlock extends BlockBase {
  kind: "codeblock";
  lang?: string;
  text: string;
}
export type Block = Paragraph | Heading | List | TableBlock | Figure | Equation | Quote | CodeBlock;

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

/**
 * Figure sources. `chart` is the extension point for Vega-Lite specs: 4a reports it as unsupported,
 * a later release registers an asset resolver that produces an `svg` from it.
 */
export type FigureAssetKind = "mermaid" | "svg" | "raster" | "chart";

export interface FigureAsset {
  kind: FigureAssetKind;
  /** Thesis-root-relative source path, `/`-separated. */
  path: string;
  /** Filled by the asset service before rendering. */
  resolved?: ResolvedAsset;
}

export interface ResolvedAsset {
  /** Path of the materialized copy, relative to the build directory. */
  file: string;
  sha256: string;
  bytes: number;
  /** `png`/`jpg` for raster assets. */
  format?: "png" | "jpg" | "svg" | "mmd";
  /** Natural size of a vector image in points, when known. */
  size?: { widthPt: number; heightPt: number };
  /** Diagram source text for Mermaid assets, for formats that embed it. */
  text?: string;
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

export type SectionRole =
  | "body"
  | "annex"
  | "abstract"
  | "abstract-secondary"
  | "dedication"
  | "acknowledgments"
  | "ai-declaration";

export interface Section {
  /** Thesis-root-relative source file. */
  path: string;
  role: SectionRole;
  /** Outline section (`SEC-xx`) this file belongs to, when it declares one. */
  section?: string;
  /** Language of an abstract, BCP-47. */
  lang?: string;
  keywords?: string[];
  blocks: Block[];
}

export type I18nStrings = Record<string, string>;

export interface ResolvedMeta {
  language: string;
  /** Primary subtag, for example `es`. */
  languageCode: string;
  region?: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  advisors: { name: string; role: string }[];
  institution: {
    name: string | null;
    faculty: string | null;
    program: string | null;
    city: string | null;
    country: string;
  };
  year: number;
  workType: string;
  secondaryAbstractLanguage: string | null;
  paper: "letter" | "a4";
  fontProfile: "serif" | "sans" | "institutional";
  /** Explicit body font family (interview or institution rule), when one was chosen. */
  bodyFont: string | null;
  /** Chart palette name (`templates/palettes.json`). */
  palette: string;
  diagramTheme: "neutral" | "grayscale";
  /** Explicit body line spacing multiple, when one was chosen. */
  lineSpacing: number | null;
  presentationStandard: string;
  citationStyle: string;
  aiDeclarationRequired: boolean;
  /** Rule ids behind the resolved presentation, for traceability comments. */
  ruleIds: string[];
}

/** Theme for diagrams, derived from the palette (spec 10.5); adapters map it to their engine. */
export interface DiagramTheme {
  /** The user's choice. */
  name: "neutral" | "grayscale";
  /** Mermaid theme variables (`primaryColor`, `lineColor`, ...). */
  variables: Record<string, string>;
  background: string;
  /** Font families in order of preference, without generic keywords. */
  fonts: string[];
}

export interface ThesisDocument {
  meta: ResolvedMeta;
  /** Resolved presentation profile (format-neutral); each adapter maps it to its own settings. */
  presentation: PresentationProfile;
  diagramTheme: DiagramTheme;
  /** Abstracts, dedication, acknowledgments and the AI declaration, in file order. */
  frontMatter: Section[];
  body: Section[];
  annexes: Section[];
  footnotes: Record<string, Block[]>;
  /** Labeled figures by label. */
  figures: Map<Label, FigureAsset>;
  bibliography: {
    entries: EvidenceRecord[];
    styleId: string;
    /** The selected citation style: shipped or workspace CSL text with its metadata. */
    csl: ResolvedCitationStyle;
    /** BibTeX text generated from the library, written to the build directory by the build. */
    bibtex: string;
  };
  strings: I18nStrings;
}

export type BuildScope = "full" | "approved" | "section";

/** Parse result with the findings the dialect produced (HYG-001). */
export interface ParsedChapter {
  section: Section;
  footnotes: Record<string, Block[]>;
  findings: Finding[];
}

export const refKinds: readonly LabelKind[] = ["fig", "tbl", "eq", "sec"];
