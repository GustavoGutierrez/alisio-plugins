import { type ArchiveEnvelope, validateArchive } from "./archive.js";
import { type AuditEnvelope, validateAudit } from "./audit.js";
import {
  type FidelityReviewContext,
  type FidelityReviewEnvelope,
  validateFidelityReview,
} from "./fidelity-review.js";
import type { EnvelopeKind, EnvelopeResult } from "./parse.js";
import { type PlanEnvelope, validatePlan } from "./plan.js";
import { type ReviewEnvelope, validateReview } from "./review.js";
import { type SpecEnvelope, validateSpec } from "./spec.js";
import { type TaskResultEnvelope, validateTaskResult } from "./task-result.js";
import { type TestMapEnvelope, validateTestMap } from "./test-map.js";
import { type TokensEnvelope, validateTokens } from "./tokens.js";
import { type UiContractEnvelope, validateUiContract } from "./ui-contract.js";

export interface EnvelopeByKind {
  spec: SpecEnvelope;
  "ui-contract": UiContractEnvelope;
  tokens: TokensEnvelope;
  plan: PlanEnvelope;
  "test-map": TestMapEnvelope;
  "task-result": TaskResultEnvelope;
  "a11y-audit": AuditEnvelope;
  "fidelity-review": FidelityReviewEnvelope;
  review: ReviewEnvelope;
  archive: ArchiveEnvelope;
}

export interface ValidationContext {
  fidelityReview?: FidelityReviewContext;
}

/** One validator per envelope kind; the closed set of spec 9.2. */
export function validateEnvelope<K extends EnvelopeKind>(
  kind: K,
  raw: unknown,
  context: ValidationContext = {},
): EnvelopeResult<EnvelopeByKind[K]> {
  const result = ((): EnvelopeResult<EnvelopeByKind[EnvelopeKind]> => {
    switch (kind) {
      case "spec":
        return validateSpec(raw);
      case "ui-contract":
        return validateUiContract(raw);
      case "tokens":
        return validateTokens(raw);
      case "plan":
        return validatePlan(raw);
      case "test-map":
        return validateTestMap(raw);
      case "task-result":
        return validateTaskResult(raw);
      case "a11y-audit":
        return validateAudit(raw);
      case "fidelity-review":
        return validateFidelityReview(raw, context.fidelityReview);
      case "review":
        return validateReview(raw);
      case "archive":
        return validateArchive(raw);
      default:
        return { ok: false, errors: [{ pointer: "", message: `unknown envelope kind ${kind}` }] };
    }
  })();
  return result as EnvelopeResult<EnvelopeByKind[K]>;
}
