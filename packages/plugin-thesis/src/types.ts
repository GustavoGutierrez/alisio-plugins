import type { Question } from "@alisio/sdk";

/** Identifier patterns from spec section 4.1. */
export const idPatterns = {
  section: /^SEC-\d{2}(\.\d{2}){0,2}$/,
  objective: /^OBJ-(G|\d{2})$/,
  evidence: /^EVD-\d{5}$/,
  claim: /^CLM-\d{4}$/,
  finding: /^FND-\d{4}$/,
  figure: /^fig-[a-z0-9-]{1,48}$/,
  table: /^tbl-[a-z0-9-]{1,48}$/,
  equation: /^eq-[a-z0-9-]{1,48}$/,
  citationKey: /^[a-z][a-z0-9]{1,30}\d{4}[a-z]?$/,
} as const;

export type SectionId = string;

export const roles = [
  "thesis-coordinator",
  "thesis-methodologist",
  "thesis-librarian",
  "thesis-evidence-auditor",
  "thesis-architect",
  "thesis-writer",
  "thesis-editor",
  "thesis-reviewer",
] as const;
export type ResourceRole = (typeof roles)[number];

export const gates = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"] as const;
export type Gate = (typeof gates)[number];

export interface Finding {
  code: string;
  gate: Gate;
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  /** Outline section the finding belongs to, when it has one. */
  section?: string;
  message: string;
  hint?: string;
}

export interface CheckReport {
  at: string;
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  findings: Finding[];
}

export const phases = [
  "intake",
  "design",
  "outline",
  "sections",
  "review",
  "final",
  "submitted",
] as const;
export type Phase = (typeof phases)[number];

export const gateNames = ["A", "B", "OUTLINE", "C"] as const;
export type HumanGateName = (typeof gateNames)[number];
export interface HumanGate {
  status: "pending" | "approved";
  at?: string;
  notes?: string;
}

export const sectionStatuses = [
  "planned",
  "researching",
  "research_review",
  "research_approved",
  "drafting",
  "draft_review",
  "approved",
  "revising",
] as const;
export type SectionStatus = (typeof sectionStatuses)[number];
export interface SectionState {
  status: SectionStatus;
  updatedAt?: string;
  /** Evidence ids of CONTEXTUAL_ONLY records the user explicitly approved for this section (spec 8.4). */
  contextualApprovals?: string[];
  /** When the research dossier was last written. */
  dossierAt?: string;
  /** Copied from the approved outline so progress can be planned from state alone. */
  title?: string;
  dependsOn?: SectionId[];
  /** When the section was last drafted (or revised) and its chapter file, relative to the root. */
  draftAt?: string;
  chapter?: string;
  /** File role of the section (abstract, ai-declaration, ...); absent for ordinary body sections. */
  role?: string;
}

/** Sections with no research phase: they are written from the thesis itself, not from sources. */
export const frontSectionRoles: readonly string[] = [
  "abstract",
  "abstract-secondary",
  "dedication",
  "acknowledgments",
  "ai-declaration",
];
/** Written last: an abstract summarizes sections that must be approved first. */
export const summarySectionRoles: readonly string[] = ["abstract", "abstract-secondary"];

/** One interview round that is waiting for answers (headless continuation). */
export interface PendingQuestions {
  round: number;
  createdAt: string;
  questions: Question[];
}

export interface IntakeState {
  /** Option values and `<id>:text` free-text answers collected so far. */
  answers: Record<string, string>;
  completedRounds: number[];
  /** Conversation language detected when the interview started (BCP-47). */
  languageHint?: string;
}

export interface ThesisState {
  schemaVersion: 1;
  root: string;
  phase: Phase;
  humanGates: Record<HumanGateName, HumanGate>;
  sections: Record<SectionId, SectionState>;
  intake: IntakeState;
  pendingQuestions?: PendingQuestions;
  /** When research/protocol.md and outline/outline.json were last drafted. */
  protocolAt?: string;
  outlineAt?: string;
  counters: { evidence: number; claim: number; finding: number };
  /** Resolutions of triggered ethics requirements, by requirement id (spec 11.4, ETH-001). */
  ethicsResolutions?: Record<string, { text: string; at: string }>;
  /** Workspace citation styles the user approved through `/thesis:style new`. */
  styles?: Record<string, { approvedAt: string }>;
  /** The last independent review (spec 7.5). */
  lastReview?: {
    at: string;
    scope: string;
    sections: SectionId[];
    findings: number;
    /** Open critical or major findings, kept in step with reviews/. */
    blocking?: number;
  };
  /** The PDF/A build made by `/thesis:finalize` (FIN-001). */
  finalBuild?: { at: string; pdf: string; sha256: string };
  submittedAt?: string;
  lastCheck?: { at: string; errors: number; warnings: number };
  lastBuild?: {
    at: string;
    engine: "typst-cli" | "typst-node" | "chrome";
    pdf: string;
    ms: number;
  };
}

export const workTypes = [
  "undergraduate_thesis",
  "degree_project",
  "monograph",
  "master_thesis",
  "doctoral_dissertation",
] as const;
export type WorkType = (typeof workTypes)[number];

export const approaches = [
  "quantitative",
  "qualitative",
  "mixed",
  "design_science",
  "theoretical",
  "systematic_review",
] as const;
export type Approach = (typeof approaches)[number];

export const shippedCitationStyles = ["apa-7", "ieee", "icontec-ntc1486-2022"] as const;
export const shippedPresentationStandards = [
  "apa-7",
  "ieee",
  "icontec-ntc1486-2022",
  "generic",
] as const;
export const paletteNames = [
  "okabe-ito",
  "tol-bright",
  "tol-muted",
  "tol-high-contrast",
  "viridis",
  "cividis",
] as const;

export interface Brief {
  schemaVersion: 1;
  language: string;
  secondaryAbstractLanguage: string | null;
  searchLanguages: string[];
  workType: WorkType;
  title: string | null;
  subtitle: string | null;
  authors: { name: string; id: string | null }[];
  advisors: { name: string; role: string }[];
  institution: {
    name: string | null;
    faculty: string | null;
    program: string | null;
    city: string | null;
    country: string;
  };
  year: number;
  domain: { primary: string; secondary: string[] };
  approach: Approach;
  studyDesign: string | null;
  citationStyle: string;
  presentation: {
    standard: string;
    paper: "letter" | "a4";
    fontProfile: "serif" | "sans" | "institutional";
    palette: string;
    diagramTheme: "neutral" | "grayscale";
    /** Body font family chosen in the interview (for example ICONTEC's Arial or Times New Roman). */
    bodyFont?: string;
    /** Body line spacing multiple chosen in the interview (1 or 1.5). */
    lineSpacing?: number;
  };
  targets: { pages: number | null; words: number | null };
  aiUse: { assisted: boolean; declaration: "auto" | "always" | "never" };
  policy: { packs: "auto" | string[] };
}

/** Study designs that route reporting guidelines. Superset of the spec list plus the pack drafts. */
export const studyDesigns = [
  "rct",
  "observational",
  "qualitative_interview",
  "systematic_review",
  "scoping_review",
  "case_study",
  "experiment",
  "survey",
  "health_economic_evaluation",
  "diagnostic_accuracy",
  "prediction_model",
  "quality_improvement",
  "other",
] as const;

export const evidenceTypes = [
  "journal_article",
  "book",
  "chapter",
  "conference_paper",
  "thesis",
  "report",
  "standard",
  "law",
  "dataset",
  "web_page",
  "preprint",
] as const;
export type EvidenceType = (typeof evidenceTypes)[number];

export const evidenceStatuses = [
  "VERIFIED_PRIMARY",
  "VERIFIED_PEER_REVIEWED",
  "VERIFIED_AUTHORITATIVE_GREY",
  "CONTEXTUAL_ONLY",
  "UNVERIFIED",
  "REJECTED",
] as const;
export type EvidenceStatus = (typeof evidenceStatuses)[number];
export const citableStatuses: readonly EvidenceStatus[] = [
  "VERIFIED_PRIMARY",
  "VERIFIED_PEER_REVIEWED",
  "VERIFIED_AUTHORITATIVE_GREY",
];

export const permittedUses = ["background", "argument", "method", "results_comparison"] as const;
export type PermittedUse = (typeof permittedUses)[number];

export type EvidenceId = string;

/** Spec section 8.3. */
export interface EvidenceRecord {
  id: EvidenceId;
  citeKey: string;
  type: EvidenceType;
  title: string;
  authors: { family: string; given?: string; orcid?: string }[];
  year: number;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  /** City of publication, printed by styles that need it (for example ICONTEC). */
  placeOfPublication?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  language?: string;
  retrievedAt: string;
  verification: {
    method: "crossref" | "openalex" | "arxiv" | "official_domain" | "user_supplied";
    metadataMatch: number;
    retracted: boolean;
    checkedAt: string;
  };
  status: EvidenceStatus;
  appraisal: {
    relevance: "high" | "medium" | "low";
    evidenceType: string;
    limitations: string[];
    supports: string[];
    location?: string;
  };
  permittedUse: PermittedUse[];
  sections: SectionId[];
}

export const claimKinds = ["background", "argument", "result", "conclusion"] as const;
export type ClaimKind = (typeof claimKinds)[number];

/** Spec 8.5. Ids are allocated by code; `anchor` is the `<!-- claim:anchor -->` id in the chapter. */
export interface ClaimRecord {
  id: string;
  section: SectionId;
  anchor: string;
  text: string;
  kind: ClaimKind;
  evidence: EvidenceId[];
  /** Ids of the claims a conclusion rests on. */
  results?: string[];
  objectives: string[];
}

export type FindingSeverity = "critical" | "major" | "minor";
export const reviewCategories = [
  "source",
  "concept",
  "method",
  "statistics",
  "argument",
  "wording",
  "format",
] as const;
export type ReviewCategory = (typeof reviewCategories)[number];
export const reviewRoutes = [
  "evidence-auditor",
  "methodologist",
  "writer",
  "architect",
  "editor",
  "build",
] as const;
export type ReviewRoute = (typeof reviewRoutes)[number];
/** Spec 7.5 routing table (source notes section 23). */
export const routeOfCategory: Record<ReviewCategory, ReviewRoute> = {
  source: "evidence-auditor",
  concept: "methodologist",
  method: "methodologist",
  statistics: "writer",
  argument: "architect",
  wording: "editor",
  format: "build",
};

/** A reviewer finding stored as `reviews/FND-xxxx.json`. */
export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  category: ReviewCategory;
  target: SectionId;
  evidence: string;
  description: string;
  routeTo: ReviewRoute;
  status: "open" | "resolved" | "dismissed" | "superseded";
  createdAt: string;
  resolvedAt?: string;
  notes?: string;
}
