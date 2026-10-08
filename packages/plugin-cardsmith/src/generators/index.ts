import type { Family } from "../core/design-spec.js";
import { chartGenerator } from "./chart.js";
import { compositeGenerator } from "./composite.js";
import { dynamicGenerator } from "./dynamic.js";
import { personalizedGenerator } from "./personalized.js";
import { socialGenerator } from "./social.js";
import type { FamilyGenerator } from "./types.js";

const GENERATORS: Record<Family, FamilyGenerator> = {
  social: socialGenerator,
  personalized: personalizedGenerator,
  composite: compositeGenerator,
  chart: chartGenerator,
  dynamic: dynamicGenerator,
};

/** Every family ships a generator as of WU6. */
export const GENERATOR_FAMILIES: Family[] = [
  "social",
  "personalized",
  "composite",
  "chart",
  "dynamic",
];

/** Generator for a family; every `Family` is implemented. */
export function generatorFor(family: Family): FamilyGenerator {
  return GENERATORS[family];
}

export type { FamilyGenerator, GeneratorContext } from "./types.js";
