/** Labels for the rendered Markdown artifacts. Other languages fall back to English. */
export interface Labels {
  protocol: string;
  editNote: string;
  problem: string;
  researchQuestions: string;
  generalObjective: string;
  specificObjectives: string;
  deliverable: string;
  justification: string;
  relevance: string;
  novelty: string;
  feasibility: string;
  beneficiaries: string;
  scope: string;
  limitations: string;
  hypotheses: string;
  methodology: string;
  design: string;
  population: string;
  instruments: string;
  analysisPlan: string;
  reportingGuideline: string;
  ethics: string;
  ethicsNone: string;
  openQuestions: string;
  outline: string;
  outlineNote: string;
  purpose: string;
  objectives: string;
  topics: string;
  questions: string;
  evidenceNeeds: string;
  words: string;
  dependsOn: string;
  required: string;
  coverage: string;
  dossier: string;
  synthesis: string;
  claims: string;
  gaps: string;
  critical: string;
  evidence: string;
  searchCoverage: string;
  none: string;
  yes: string;
  no: string;
}

const en: Labels = {
  protocol: "Research protocol",
  editNote:
    "The front matter is the authoritative record. Change it with /thesis:revise or edit it by hand, then run /thesis:check.",
  problem: "Problem statement",
  researchQuestions: "Research questions",
  generalObjective: "General objective",
  specificObjectives: "Specific objectives",
  deliverable: "Deliverable",
  justification: "Justification",
  relevance: "Relevance",
  novelty: "Novelty",
  feasibility: "Feasibility",
  beneficiaries: "Beneficiaries",
  scope: "Scope",
  limitations: "Limitations",
  hypotheses: "Hypotheses",
  methodology: "Methodology",
  design: "Design",
  population: "Population or corpus",
  instruments: "Instruments",
  analysisPlan: "Analysis plan",
  reportingGuideline: "Reporting guideline",
  ethics: "Ethics",
  ethicsNone: "No ethics trigger was answered yes. Confirm this with your institution.",
  openQuestions: "Open questions",
  outline: "Outline",
  outlineNote:
    "Review the sections, their objectives and dependencies, then approve with /thesis:approve OUTLINE.",
  purpose: "Purpose",
  objectives: "Objectives",
  topics: "Research topics",
  questions: "Questions to answer",
  evidenceNeeds: "Evidence needed",
  words: "Target words",
  dependsOn: "Depends on",
  required: "Required section",
  coverage: "Objective coverage",
  dossier: "Research dossier",
  synthesis: "Synthesis by topic",
  claims: "Proposed claims",
  gaps: "Gaps",
  critical: "critical",
  evidence: "Evidence",
  searchCoverage: "Search coverage",
  none: "None",
  yes: "yes",
  no: "no",
};

const es: Labels = {
  protocol: "Protocolo de investigación",
  editNote:
    "El encabezado (front matter) es el registro de referencia. Cámbialo con /thesis:revise o edítalo a mano y luego ejecuta /thesis:check.",
  problem: "Planteamiento del problema",
  researchQuestions: "Preguntas de investigación",
  generalObjective: "Objetivo general",
  specificObjectives: "Objetivos específicos",
  deliverable: "Entregable",
  justification: "Justificación",
  relevance: "Relevancia",
  novelty: "Novedad",
  feasibility: "Viabilidad",
  beneficiaries: "Beneficiarios",
  scope: "Alcance",
  limitations: "Limitaciones",
  hypotheses: "Hipótesis",
  methodology: "Metodología",
  design: "Diseño",
  population: "Población o corpus",
  instruments: "Instrumentos",
  analysisPlan: "Plan de análisis",
  reportingGuideline: "Guía de reporte",
  ethics: "Ética",
  ethicsNone: "Ningún disparador ético se respondió con sí. Confírmalo con tu institución.",
  openQuestions: "Preguntas abiertas",
  outline: "Estructura",
  outlineNote:
    "Revisa las secciones, sus objetivos y dependencias, y aprueba con /thesis:approve OUTLINE.",
  purpose: "Propósito",
  objectives: "Objetivos",
  topics: "Temas de investigación",
  questions: "Preguntas por responder",
  evidenceNeeds: "Evidencia requerida",
  words: "Palabras objetivo",
  dependsOn: "Depende de",
  required: "Sección obligatoria",
  coverage: "Cobertura de objetivos",
  dossier: "Dossier de investigación",
  synthesis: "Síntesis por tema",
  claims: "Afirmaciones propuestas",
  gaps: "Vacíos",
  critical: "crítico",
  evidence: "Evidencia",
  searchCoverage: "Cobertura de búsqueda",
  none: "Ninguno",
  yes: "sí",
  no: "no",
};

export function labelsFor(language: string): Labels {
  return language.toLowerCase().startsWith("es") ? es : en;
}
