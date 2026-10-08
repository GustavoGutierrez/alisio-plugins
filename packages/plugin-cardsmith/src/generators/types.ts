import type { Family, NormalizedSpec, SpecError } from "../core/design-spec.js";
import type { Registry } from "../core/registry.js";
import type { Scene } from "../core/scene.js";
import type { TextMeasurer } from "../core/typography.js";

/** Resources a family generator needs; the renderer provides the real text measurer. */
export interface GeneratorContext {
  registry: Registry;
  measurer: TextMeasurer;
}

/**
 * Family generator contract: `validate` reports family-specific spec errors and `compose` turns a
 * normalized spec plus the registry into a renderable scene. `composeScene` remains the generic
 * template interpreter; generators only add the semantics their family needs (image placement,
 * structured rows, frames, seeded decoration).
 */
export interface FamilyGenerator {
  readonly family: Family;
  validate(spec: NormalizedSpec, ctx: GeneratorContext): SpecError[];
  compose(spec: NormalizedSpec, ctx: GeneratorContext): { scene: Scene; warnings: string[] };
}
