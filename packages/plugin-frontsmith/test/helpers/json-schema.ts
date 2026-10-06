/**
 * A minimal JSON Schema (2020-12 subset) validator used only by tests, so the shipped schema can be
 * compared with the hand-written validators without adding a runtime dependency.
 * Supported: type, enum, const, properties, required, additionalProperties (false or schema),
 * items, minItems, maxItems, minLength, maxLength, minimum, maximum, pattern, propertyNames,
 * oneOf, $ref to
 * `#/$defs/<name>`.
 */
type Schema = Record<string, unknown>;

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const typeMatches = (expected: string, value: unknown): boolean => {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
};

export function validateAgainstSchema(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const defs = (root.$defs ?? {}) as Record<string, Schema>;
  const visit = (schema: Schema, current: unknown, pointer: string): void => {
    if (typeof schema.$ref === "string") {
      const target = defs[schema.$ref.replace("#/$defs/", "")];
      if (!target) throw new Error(`Unresolved $ref ${schema.$ref}`);
      visit(target, current, pointer);
      return;
    }
    if (Array.isArray(schema.oneOf)) {
      const passing = (schema.oneOf as Schema[]).filter((option) => {
        const nested: string[] = [];
        const before = errors.length;
        visit(option, current, pointer);
        nested.push(...errors.splice(before));
        return nested.length === 0;
      });
      if (passing.length !== 1) errors.push(`${pointer}: must match exactly one alternative`);
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type)
        ? (schema.type as string[])
        : [schema.type as string];
      if (!types.some((expected) => typeMatches(expected, current))) {
        errors.push(`${pointer}: expected ${types.join("|")}`);
        return;
      }
    }
    if ("const" in schema && current !== schema.const) errors.push(`${pointer}: const mismatch`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(current))
      errors.push(`${pointer}: not in enum`);
    if (typeof current === "string") {
      if (typeof schema.minLength === "number" && current.length < schema.minLength)
        errors.push(`${pointer}: too short`);
      if (typeof schema.maxLength === "number" && current.length > schema.maxLength)
        errors.push(`${pointer}: too long`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(current))
        errors.push(`${pointer}: pattern mismatch`);
    }
    if (typeof current === "number") {
      if (typeof schema.minimum === "number" && current < schema.minimum)
        errors.push(`${pointer}: below minimum`);
      if (typeof schema.maximum === "number" && current > schema.maximum)
        errors.push(`${pointer}: above maximum`);
    }
    if (Array.isArray(current)) {
      if (typeof schema.minItems === "number" && current.length < schema.minItems)
        errors.push(`${pointer}: too few items`);
      if (typeof schema.maxItems === "number" && current.length > schema.maxItems)
        errors.push(`${pointer}: too many items`);
      if (schema.items && typeof schema.items === "object")
        current.forEach((item, index) => {
          visit(schema.items as Schema, item, `${pointer}/${index}`);
        });
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[])
        if (!(key in record)) errors.push(`${pointer}/${key}: required`);
      for (const [key, child] of Object.entries(record)) {
        if (schema.propertyNames) visit(schema.propertyNames as Schema, key, `${pointer}/${key}`);
        const declared = properties[key];
        if (declared) visit(declared, child, `${pointer}/${key}`);
        else if (schema.additionalProperties === false)
          errors.push(`${pointer}/${key}: additional property`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
          visit(schema.additionalProperties as Schema, child, `${pointer}/${key}`);
      }
    }
  };
  visit(root, value, "");
  return errors;
}
