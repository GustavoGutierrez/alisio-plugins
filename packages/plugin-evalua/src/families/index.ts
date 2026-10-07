import { decimalOps } from "./decimal-ops.js";
import { expressionEvaluate } from "./expression-evaluate.js";
import { factoring } from "./factoring.js";
import { fractionOps } from "./fraction-ops.js";
import { fractionSimplify } from "./fraction-simplify.js";
import { gcdLcm } from "./gcd-lcm.js";
import { integerOps } from "./integer-ops.js";
import { likeTerms } from "./like-terms.js";
import { linearEquation } from "./linear-equation.js";
import { linearFunction } from "./linear-function.js";
import { linearInequality } from "./linear-inequality.js";
import { linearSystem2x2 } from "./linear-system-2x2.js";
import { mixedNumbers } from "./mixed-numbers.js";
import { orderOfOperations } from "./order-of-operations.js";
import { percent } from "./percent.js";
import { polynomialOps } from "./polynomial-ops.js";
import { powersRoots } from "./powers-roots.js";
import { primeFactorization } from "./prime-factorization.js";
import { proportion } from "./proportion.js";
import { quadraticEquation } from "./quadratic-equation.js";
import { rationalCompare } from "./rational-compare.js";
import { rationalExpression } from "./rational-expression.js";
import { specialProducts } from "./special-products.js";
import type { Family } from "./types.js";
import { wordProblemLinear } from "./word-problem-linear.js";

/** The item-family registry: pure generators with their own solver and distractor model. */
export const families: Record<string, Family> = {
  [integerOps.id]: integerOps,
  [orderOfOperations.id]: orderOfOperations,
  [gcdLcm.id]: gcdLcm,
  [primeFactorization.id]: primeFactorization,
  [fractionSimplify.id]: fractionSimplify,
  [fractionOps.id]: fractionOps,
  [mixedNumbers.id]: mixedNumbers,
  [decimalOps.id]: decimalOps,
  [rationalCompare.id]: rationalCompare,
  [percent.id]: percent,
  [proportion.id]: proportion,
  [powersRoots.id]: powersRoots,
  [expressionEvaluate.id]: expressionEvaluate,
  [likeTerms.id]: likeTerms,
  [polynomialOps.id]: polynomialOps,
  [specialProducts.id]: specialProducts,
  [factoring.id]: factoring,
  [linearEquation.id]: linearEquation,
  [linearInequality.id]: linearInequality,
  [linearSystem2x2.id]: linearSystem2x2,
  [rationalExpression.id]: rationalExpression,
  [quadraticEquation.id]: quadraticEquation,
  [linearFunction.id]: linearFunction,
  [wordProblemLinear.id]: wordProblemLinear,
};

export const familyIds: readonly string[] = Object.keys(families).sort();

export function getFamily(id: string): Family | undefined {
  return families[id];
}

export { assembleOptions, type OptionCandidate } from "./options.js";
export type {
  CanonicalAnswer,
  DistractorOption,
  Family,
  FamilyContext,
  ItemDraft,
} from "./types.js";
