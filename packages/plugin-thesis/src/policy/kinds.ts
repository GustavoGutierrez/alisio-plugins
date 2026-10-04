/** Closed `requirement.kind` vocabulary (spec section 16.2). Format-neutral by design. */
export const requirementKinds = [
  "institutional_authority",
  "paper",
  "page_margins",
  "font",
  "line_spacing",
  "text_alignment",
  "pagination",
  "front_matter_order",
  "required_section",
  "heading_format",
  "caption_position",
  "citation_style",
  "reference_format",
  "length_limit",
  "ethics_trigger",
  "risk_classification",
  "consent_requirement",
  "data_protection",
  "quotation_rule",
  "attribution_rule",
  "integrity_rule",
  "ai_declaration",
  "source_quality",
  "evidence_minimum",
  "reporting_guideline",
  "objective_verbs",
  "official_domain_allowlist",
  // Needed by the resolver for the selected presentation (spec section 11.3).
  "presentation_standard",
] as const;

const extensionKind = /^x-[a-z][a-z0-9-]{1,40}$/;

export function isExtensionKind(kind: string): boolean {
  return extensionKind.test(kind);
}

export function isKnownKind(kind: string): boolean {
  return (requirementKinds as readonly string[]).includes(kind) || isExtensionKind(kind);
}

/** `appliesWhen` keys (spec section 16.2). */
export const appliesWhenKeys = [
  "country",
  "language",
  "workType",
  "approach",
  "studyDesign",
  "domain",
  "presentationStandard",
  "citationStyle",
  "ethicsTrigger",
  "aiUse",
] as const;

/** Kinds that have a single resolved value; same-precedence disagreements are PCK-003. */
export const exclusiveKinds = new Set<string>([
  "citation_style",
  "presentation_standard",
  "ai_declaration",
  "paper",
  "page_margins",
  "font",
  "line_spacing",
  "text_alignment",
  "pagination",
  "front_matter_order",
  "heading_format",
  "caption_position",
]);
