/** Identifier patterns shared by state, envelopes, rule packs and commands (spec 9.1). */

const FEATURE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PACK = /^[a-z][a-z0-9-]{1,40}$/;
const SHIPPED_RULE = /^FS-[A-Z0-9]{2,6}-[A-Z0-9]{2,5}$/;
const WORKSPACE_RULE = /^[A-Z][A-Z0-9]{1,7}-[A-Z0-9]{2,6}-[A-Z0-9]{2,5}$/;

export const idPatterns = {
  requirement: /^R-\d{2,3}$/,
  acceptance: /^AC-\d{2,3}$/,
  state: /^ST-[a-z][a-z0-9-]{1,30}$/,
  question: /^Q-\d{2}$/,
  task: /^T-\d{3}$/,
  adr: /^ADR-\d{3}$/,
  element: /^[a-z][a-z0-9-]{1,47}$/,
  case: /^[a-z][a-z0-9-]{1,47}$/,
  fidelityRule: /^(GEO|REL|TYPE|COL|CNT|AST|OVF|VIS|FOC)-[A-Z0-9-]{1,24}$/,
  pattern: /^PAT-[A-Z0-9-]{2,30}$/,
  candidate: /^CAND-\d{3}$/,
} as const;

export type IdKind = keyof typeof idPatterns;

export const isFeatureId = (value: unknown): value is string =>
  typeof value === "string" && FEATURE.test(value);

export const isPackId = (value: unknown): value is string =>
  typeof value === "string" && PACK.test(value);

export const isShippedRuleId = (value: unknown): value is string =>
  typeof value === "string" && SHIPPED_RULE.test(value);

/** Workspace rule ids never use the reserved `FS-` namespace. */
export const isWorkspaceRuleId = (value: unknown): value is string =>
  typeof value === "string" && !value.startsWith("FS-") && WORKSPACE_RULE.test(value);

export const matchesId = (kind: IdKind, value: unknown): value is string =>
  typeof value === "string" && idPatterns[kind].test(value);
