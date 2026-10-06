import { type EnvelopeResult, openEnvelope } from "./parse.js";

export const tokenLayers = ["primitive", "semantic", "component"] as const;
export const pairKinds = ["normal_text", "large_text", "non_text"] as const;
export const tokenStatuses = ["existing", "new"] as const;
export const strategies = ["catalog", "none"] as const;
const TOKEN = /^--[a-z][a-z0-9-]{1,79}$/;
const HEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export interface TokensEnvelope {
  schemaVersion: 1;
  kind: "tokens";
  namespace: string;
  roles: Array<{
    token: string;
    layer: (typeof tokenLayers)[number];
    category: string;
    purpose: string;
    status: (typeof tokenStatuses)[number];
  }>;
  requiredPairs: Array<{
    fg: string;
    bg: string;
    kind: (typeof pairKinds)[number];
    states: string[];
  }>;
  themes: Array<"light" | "dark">;
  generation: {
    strategy: (typeof strategies)[number];
    family: string | undefined;
    locked: Record<string, string>;
  };
  rationale: string;
}

/** The tokensmith never writes colour values for new roles: `locked` holds existing brand values only. */
export function validateTokens(raw: unknown): EnvelopeResult<TokensEnvelope> {
  const { check, root } = openEnvelope(raw, "tokens", [
    "namespace",
    "roles",
    "requiredPairs",
    "themes",
    "generation",
    "rationale",
  ]);
  if (!root) return check.result(undefined as never);
  const roles = check.array(root, "roles", "", (item, at) => {
    const role = check.object(item, at, ["token", "layer", "category", "purpose", "status"]);
    if (!role) return undefined;
    return {
      token: check.string(role, "token", at, { pattern: TOKEN }) ?? "",
      layer: check.enum(role, "layer", at, tokenLayers) ?? "semantic",
      category: check.string(role, "category", at, { max: 40 }) ?? "",
      purpose: check.string(role, "purpose", at) ?? "",
      status: check.enum(role, "status", at, tokenStatuses) ?? "new",
    };
  });
  const requiredPairs = check.array(root, "requiredPairs", "", (item, at) => {
    const pair = check.object(item, at, ["fg", "bg", "kind", "states"]);
    if (!pair) return undefined;
    return {
      fg: check.string(pair, "fg", at, { pattern: TOKEN }) ?? "",
      bg: check.string(pair, "bg", at, { pattern: TOKEN }) ?? "",
      kind: check.enum(pair, "kind", at, pairKinds) ?? "normal_text",
      states: check.strings(pair, "states", at, { optional: true }),
    };
  });
  const themes = check.array(
    root,
    "themes",
    "",
    (item, at) => {
      if (item === "light" || item === "dark") return item;
      check.fail(at, "must be light or dark");
      return undefined;
    },
    { min: 1 },
  );
  const generationRaw = check.object(root.generation, "/generation", [
    "strategy",
    "family",
    "locked",
  ]);
  const locked: Record<string, string> = {};
  let strategy: (typeof strategies)[number] = "none";
  let family: string | undefined;
  if (generationRaw) {
    strategy = check.enum(generationRaw, "strategy", "/generation", strategies) ?? "none";
    family = check.string(generationRaw, "family", "/generation", {
      optional: true,
      pattern: /^[a-z][a-z0-9-]{1,30}$/,
    });
    if (strategy === "catalog" && family === undefined)
      check.fail("/generation/family", "is required for the catalog strategy");
    const lockedRaw = generationRaw.locked;
    if (lockedRaw !== undefined) {
      const holder =
        typeof lockedRaw === "object" && lockedRaw !== null && !Array.isArray(lockedRaw)
          ? (lockedRaw as Record<string, unknown>)
          : undefined;
      if (!holder) check.fail("/generation/locked", "must be an object");
      else
        for (const [token, value] of Object.entries(holder)) {
          if (!TOKEN.test(token)) check.fail(`/generation/locked/${token}`, "invalid token name");
          else if (typeof value !== "string" || !HEX.test(value))
            check.fail(`/generation/locked/${token}`, "must be a #RRGGBB or #RRGGBBAA colour");
          else locked[token] = value;
        }
    }
  }
  return check.result({
    schemaVersion: 1,
    kind: "tokens",
    namespace: check.string(root, "namespace", "", { allowEmpty: true, max: 24 }) ?? "",
    roles,
    requiredPairs,
    themes,
    generation: { strategy, family, locked },
    rationale: check.string(root, "rationale", "") ?? "",
  });
}
