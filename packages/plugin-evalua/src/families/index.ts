import { decimalOps } from "./decimal-ops.js";
import { fractionOps } from "./fraction-ops.js";
import { fractionSimplify } from "./fraction-simplify.js";
import { gcdLcm } from "./gcd-lcm.js";
import { integerOps } from "./integer-ops.js";
import { orderOfOperations } from "./order-of-operations.js";
import { percent } from "./percent.js";
import type { Family } from "./types.js";

/** The item-family registry: pure generators with their own solver and distractor model. */
export const families: Record<string, Family> = {
  [integerOps.id]: integerOps,
  [orderOfOperations.id]: orderOfOperations,
  [gcdLcm.id]: gcdLcm,
  [fractionSimplify.id]: fractionSimplify,
  [fractionOps.id]: fractionOps,
  [decimalOps.id]: decimalOps,
  [percent.id]: percent,
};

export const familyIds: readonly string[] = Object.keys(families).sort();

export function getFamily(id: string): Family | undefined {
  return families[id];
}

export { assembleOptions, type OptionCandidate } from "./options.js";
export type { DistractorOption, Family, FamilyContext, ItemDraft } from "./types.js";
