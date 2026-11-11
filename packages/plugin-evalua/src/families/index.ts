import { absoluteValue } from "./absolute-value.js";
import { addSubtract } from "./add-subtract.js";
import { angleMeasure } from "./angle-measure.js";
import { boxPlot } from "./box-plot.js";
import { circleMeasure } from "./circle-measure.js";
import { clockTime } from "./clock-time.js";
import { combinatorics } from "./combinatorics.js";
import { compoundProbability } from "./compound-probability.js";
import { conditionalProbability } from "./conditional-probability.js";
import { conics } from "./conics.js";
import { coordinates } from "./coordinates.js";
import { counting } from "./counting.js";
import { dataGraph } from "./data-graph.js";
import { decimalOps } from "./decimal-ops.js";
import { derivatives } from "./derivatives.js";
import { dispersion } from "./dispersion.js";
import { division } from "./division.js";
import { expLog } from "./exp-log.js";
import { expressionEvaluate } from "./expression-evaluate.js";
import { factoring } from "./factoring.js";
import { fractionDecimalPercent } from "./fraction-decimal-percent.js";
import { fractionOps } from "./fraction-ops.js";
import { fractionPart } from "./fraction-part.js";
import { fractionSimplify } from "./fraction-simplify.js";
import { functionProperties } from "./function-properties.js";
import { gcdLcm } from "./gcd-lcm.js";
import { geometry } from "./geometry.js";
import { integerOps } from "./integer-ops.js";
import { intervalInequality } from "./interval-inequality.js";
import { likeTerms } from "./like-terms.js";
import { linearEquation } from "./linear-equation.js";
import { linearFunction } from "./linear-function.js";
import { linearInequality } from "./linear-inequality.js";
import { linearSystem2x2 } from "./linear-system-2x2.js";
import { mapScale } from "./map-scale.js";
import { measurement } from "./measurement.js";
import { missingNumber } from "./missing-number.js";
import { mixedNumbers } from "./mixed-numbers.js";
import { moneyProblems } from "./money.js";
import { multiples } from "./multiples.js";
import { multiplication } from "./multiplication.js";
import { numberPattern } from "./number-pattern.js";
import { numberSets } from "./number-sets.js";
import { orderOfOperations } from "./order-of-operations.js";
import { percent } from "./percent.js";
import { perimeterArea } from "./perimeter-area.js";
import { placeValue } from "./place-value.js";
import { polynomialOps } from "./polynomial-ops.js";
import { powersRoots } from "./powers-roots.js";
import { primeFactorization } from "./prime-factorization.js";
import { prismVolume } from "./prism-volume.js";
import { proportion } from "./proportion.js";
import { pythagorean } from "./pythagorean.js";
import { quadraticEquation } from "./quadratic-equation.js";
import { quadraticFunction } from "./quadratic-function.js";
import { rateLimits } from "./rate-limits.js";
import { rationalCompare } from "./rational-compare.js";
import { rationalExpression } from "./rational-expression.js";
import { roundSolids } from "./round-solids.js";
import { scientificNotation } from "./scientific-notation.js";
import { sequences } from "./sequences.js";
import { similarityThales } from "./similarity-thales.js";
import { simpleProbability } from "./simple-probability.js";
import { specialProducts } from "./special-products.js";
import { statistics } from "./statistics.js";
import { triangleAngles } from "./triangle-angles.js";
import { trigRatios } from "./trig-ratios.js";
import type { Family } from "./types.js";
import { unitCircle } from "./unit-circle.js";
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
  [geometry.id]: geometry,
  [addSubtract.id]: addSubtract,
  [multiplication.id]: multiplication,
  [division.id]: division,
  [measurement.id]: measurement,
  [statistics.id]: statistics,
  [angleMeasure.id]: angleMeasure,
  [clockTime.id]: clockTime,
  [coordinates.id]: coordinates,
  [dataGraph.id]: dataGraph,
  [fractionDecimalPercent.id]: fractionDecimalPercent,
  [fractionPart.id]: fractionPart,
  [missingNumber.id]: missingNumber,
  [moneyProblems.id]: moneyProblems,
  [multiples.id]: multiples,
  [numberPattern.id]: numberPattern,
  [perimeterArea.id]: perimeterArea,
  [placeValue.id]: placeValue,
  [prismVolume.id]: prismVolume,
  [simpleProbability.id]: simpleProbability,
  [absoluteValue.id]: absoluteValue,
  [boxPlot.id]: boxPlot,
  [circleMeasure.id]: circleMeasure,
  [compoundProbability.id]: compoundProbability,
  [counting.id]: counting,
  [expLog.id]: expLog,
  [mapScale.id]: mapScale,
  [numberSets.id]: numberSets,
  [pythagorean.id]: pythagorean,
  [quadraticFunction.id]: quadraticFunction,
  [roundSolids.id]: roundSolids,
  [scientificNotation.id]: scientificNotation,
  [sequences.id]: sequences,
  [similarityThales.id]: similarityThales,
  [triangleAngles.id]: triangleAngles,
  [trigRatios.id]: trigRatios,
  [unitCircle.id]: unitCircle,
  [conics.id]: conics,
  [dispersion.id]: dispersion,
  [combinatorics.id]: combinatorics,
  [conditionalProbability.id]: conditionalProbability,
  [rateLimits.id]: rateLimits,
  [derivatives.id]: derivatives,
  [intervalInequality.id]: intervalInequality,
  [functionProperties.id]: functionProperties,
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
