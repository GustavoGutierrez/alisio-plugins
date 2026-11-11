/** The canonical report document. Rendered HTML is always derived from it, never stored. */
export type Language = "es" | "en";
export type ReportType =
  | "executive"
  | "financial"
  | "technical"
  | "marketing"
  | "research"
  | "operations"
  | "infographic"
  | "custom";
export type Creativity = "strict" | "balanced" | "bold";
export type PageSize = "A4" | "Letter";
export type Span = 1 | 2 | 3;

export const REPORT_TYPES: readonly ReportType[] = [
  "executive",
  "financial",
  "technical",
  "marketing",
  "research",
  "operations",
  "infographic",
  "custom",
];
export const CREATIVITY: readonly Creativity[] = ["strict", "balanced", "bold"];

export interface Palette {
  id: string;
  name: string;
  background: string;
  paper: string;
  ink: string;
  muted: string;
  accent: string;
  secondary: string;
  tertiary: string;
}

export type ChartType = "bars" | "line" | "donut";
export type Block =
  | { id: string; type: "lead" | "paragraph" | "quote"; title?: string; text: string; span?: Span }
  | {
      id: string;
      type: "kpi";
      label: string;
      value: string;
      change?: string;
      note?: string;
      span?: Span;
    }
  | {
      id: string;
      type: ChartType;
      title: string;
      labels: string[];
      values: number[];
      unit?: string;
      note?: string;
      span?: Span;
      height?: number;
    }
  | {
      id: string;
      type: "table";
      title: string;
      columns: string[];
      rows: (string | number)[][];
      span?: Span;
    }
  | {
      id: string;
      type: "timeline";
      title: string;
      steps: { title: string; body?: string }[];
      span?: Span;
    }
  | {
      id: string;
      type: "callout";
      title: string;
      text: string;
      tone?: "info" | "positive" | "warning";
      span?: Span;
    };
export type BlockType = Block["type"];

export interface Source {
  id: string;
  name: string;
  kind: "text" | "csv" | "url" | "file";
  mime?: string;
  text: string;
  url?: string;
  importedAt: string;
}

/** Result of fitting a single-page report to its sheet (see `fit.ts`). */
export interface PageFit {
  /** Zoom applied to the document when printing, in (0, 1]. */
  scale: number;
  /** Measured content size, in CSS pixels, at the printable width. */
  width: number;
  height: number;
  /** The page size the measurement was made for. */
  pageSize: PageSize;
  /** The report revision the measurement belongs to; a newer revision needs a new measurement. */
  revision: number;
  columns: Span;
}

export interface Report {
  id: string;
  name: string;
  type: ReportType;
  language: Language;
  model: string;
  creativity: Creativity;
  goal: string;
  context: string;
  audience: string;
  palette: Palette;
  pageSize: PageSize;
  mode: "multipage" | "singlepage";
  columns: Span;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  title: string;
  subtitle: string;
  eyebrow: string;
  summary: string;
  blocks: Block[];
  revision: number;
  history: { revision: number; summary: string; at: string }[];
  fit?: PageFit;
}

export const PALETTES: readonly Palette[] = [
  {
    id: "midnight",
    name: "Midnight editorial",
    background: "#E8EEF6",
    paper: "#FFFFFF",
    ink: "#101E35",
    muted: "#586980",
    accent: "#3D59D7",
    secondary: "#16A9B7",
    tertiary: "#A75DE6",
  },
  {
    id: "terracotta",
    name: "Warm editorial",
    background: "#F7F0E8",
    paper: "#FFFEFC",
    ink: "#302820",
    muted: "#786C60",
    accent: "#B95136",
    secondary: "#D3A345",
    tertiary: "#467F73",
  },
  {
    id: "forest",
    name: "Botanical",
    background: "#E9F2EC",
    paper: "#FFFFFF",
    ink: "#143527",
    muted: "#566F63",
    accent: "#217D59",
    secondary: "#9AAB4B",
    tertiary: "#4B81A5",
  },
  {
    id: "mono",
    name: "Monochrome",
    background: "#ECECEC",
    paper: "#FFFFFF",
    ink: "#151515",
    muted: "#686868",
    accent: "#303030",
    secondary: "#757575",
    tertiary: "#AAAAAA",
  },
  {
    id: "azure",
    name: "Coastal",
    background: "#E8F5F8",
    paper: "#FFFFFF",
    ink: "#08253B",
    muted: "#576D79",
    accent: "#0075C9",
    secondary: "#13A3A0",
    tertiary: "#F49D51",
  },
  {
    id: "plum",
    name: "Creative plum",
    background: "#F5EDF6",
    paper: "#FFFFFF",
    ink: "#24172D",
    muted: "#75677B",
    accent: "#803DA6",
    secondary: "#D54B85",
    tertiary: "#E2A43B",
  },
];

const DEFAULTS = {
  es: {
    name: "Nuevo informe",
    audience: "Dirección",
    subtitle: "Informe preparado para revisión",
    eyebrow: "INFORME PROFESIONAL",
    summary: "Agrega fuentes y genera un análisis para completar el documento.",
  },
  en: {
    name: "New report",
    audience: "Leadership",
    subtitle: "Report ready for review",
    eyebrow: "PROFESSIONAL REPORT",
    summary: "Add sources and generate analysis to complete the report.",
  },
} as const;

export interface NewReportInput {
  name?: unknown;
  type?: unknown;
  language?: unknown;
  model?: unknown;
  creativity?: unknown;
  goal?: unknown;
  context?: unknown;
  audience?: unknown;
  paletteId?: unknown;
}

const str = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** A fresh report from untrusted input: every field is checked and clipped. */
export function initialReport(input: NewReportInput = {}, now = new Date()): Report {
  const at = now.toISOString();
  const language: Language = input.language === "en" ? "en" : "es";
  const text = DEFAULTS[language];
  const name = str(input.name, 120) || text.name;
  const palette = PALETTES.find((p) => p.id === input.paletteId) ?? (PALETTES[0] as Palette);
  return {
    id: crypto.randomUUID(),
    name,
    type: REPORT_TYPES.includes(input.type as ReportType)
      ? (input.type as ReportType)
      : "executive",
    language,
    model: str(input.model, 256),
    creativity: CREATIVITY.includes(input.creativity as Creativity)
      ? (input.creativity as Creativity)
      : "balanced",
    goal: str(input.goal, 3000),
    context: str(input.context, 7000),
    audience: str(input.audience, 200) || text.audience,
    palette: { ...palette },
    pageSize: "A4",
    mode: "multipage",
    columns: 2,
    createdAt: at,
    updatedAt: at,
    sources: [],
    title: name,
    subtitle: text.subtitle,
    eyebrow: text.eyebrow,
    summary: text.summary,
    blocks: [],
    revision: 1,
    history: [{ revision: 1, summary: "Created", at }],
  };
}
