/** Value grammar shared by every model layer (spec 16.4). */
export const tierNames = ["reasoning", "standard", "fast"] as const;
export type Tier = (typeof tierNames)[number];

export const isTier = (value: unknown): value is Tier =>
  typeof value === "string" && (tierNames as readonly string[]).includes(value);

const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)*$/;

export type ModelValue =
  | { kind: "inherit" }
  | { kind: "tier"; tier: Tier }
  | { kind: "model"; selector: string };

export type ValueParse =
  | { ok: true; value: ModelValue }
  | { ok: false; code: "FSM-005" | "FSM-006"; message: string };

/**
 * `inherit`, `@reasoning|@standard|@fast` (agent values only) or a model selector of 1 to 200
 * characters. A tier cannot point to a tier (`FSM-005`); anything else malformed is `FSM-006`.
 */
export function parseModelValue(text: string, options: { tierRef: boolean }): ValueParse {
  if (text === "inherit") return { ok: true, value: { kind: "inherit" } };
  if (text.startsWith("@") && isTier(text.slice(1))) {
    if (!options.tierRef)
      return { ok: false, code: "FSM-005", message: `a tier cannot point to a tier (${text})` };
    return { ok: true, value: { kind: "tier", tier: text.slice(1) as Tier } };
  }
  if (text.length >= 1 && text.length <= 200 && SELECTOR.test(text))
    return { ok: true, value: { kind: "model", selector: text } };
  return {
    ok: false,
    code: "FSM-006",
    message: `${JSON.stringify(text.slice(0, 80))} is not inherit, @reasoning, @standard, @fast or a model selector`,
  };
}
