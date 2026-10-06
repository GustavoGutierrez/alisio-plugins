import type { ContrastKind } from "./contrast.js";
import type { Theme } from "./pairs.js";
import type { PaletteProfile, PaletteResult } from "./palette.js";

/** Required pair as stored under `$extensions.frontsmith.requiredPairs` of a tokens file. */
export interface RequiredPair {
  fg: string;
  bg: string;
  kind: ContrastKind;
  states?: string[];
}

export interface ParsedTokensFile {
  /** token -> theme -> value */
  values: Record<string, Record<string, string>>;
  /** Present only when the file lists its required pairs. */
  pairs?: RequiredPair[];
}

export type TokensFileValidation =
  | ({ ok: true } & ParsedTokensFile)
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const KINDS: readonly string[] = ["normal_text", "large_text", "non_text"];
const TOKEN = /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Parse the project's "DTCG-shaped" `tokens.json` (not DTCG-conformant): every entry is
 * `{ "$type": "color", "$value": "#fff" | { "light": "#fff", "dark": "#000" } }`; a plain string
 * value belongs to the light theme. Required pairs live in `$extensions.frontsmith.requiredPairs`.
 * TODO(owner): spec 9.2 does not say where a tokens file stores its required pairs; this is the
 * DTCG-sanctioned extension slot.
 */
export function parseTokensFile(raw: unknown): TokensFileValidation {
  if (!isRecord(raw)) return { ok: false, errors: ["tokens file must be an object"] };
  const errors: string[] = [];
  const values: Record<string, Record<string, string>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (!TOKEN.test(key)) {
      errors.push(`${key}: token names are lowercase kebab-case custom properties`);
      continue;
    }
    if (!isRecord(entry) || entry.$type !== "color") {
      errors.push(`${key}: expected { "$type": "color", "$value": ... }`);
      continue;
    }
    const value = entry.$value;
    if (typeof value === "string") values[key] = { light: value };
    else if (
      isRecord(value) &&
      Object.keys(value).length > 0 &&
      Object.values(value).every((v) => typeof v === "string")
    )
      values[key] = value as Record<string, string>;
    else errors.push(`${key}: $value must be a colour string or a theme -> colour object`);
  }
  let pairs: RequiredPair[] | undefined;
  const extension = isRecord(raw.$extensions) ? raw.$extensions.frontsmith : undefined;
  if (isRecord(extension) && extension.requiredPairs !== undefined) {
    if (!Array.isArray(extension.requiredPairs)) errors.push("requiredPairs must be an array");
    else {
      pairs = [];
      extension.requiredPairs.forEach((pair: unknown, index: number) => {
        if (
          !isRecord(pair) ||
          typeof pair.fg !== "string" ||
          typeof pair.bg !== "string" ||
          typeof pair.kind !== "string" ||
          !KINDS.includes(pair.kind)
        )
          errors.push(`requiredPairs/${index}: needs fg, bg and a contrast kind`);
        else
          pairs?.push({
            fg: pair.fg,
            bg: pair.bg,
            kind: pair.kind as ContrastKind,
            ...(Array.isArray(pair.states) ? { states: pair.states.map(String) } : {}),
          });
      });
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, values, ...(pairs ? { pairs } : {}) };
}

/** The `tokens.json` document for a solved palette, with its hashes and required pairs. */
export function buildTokensJson(
  result: Extract<PaletteResult, { ok: true }>,
  profile: PaletteProfile,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const role of profile.roles) {
    const value: Partial<Record<Theme, string>> = {};
    for (const theme of result.themes) value[theme.theme] = theme.tokens[role] as string;
    out[profile.tokenNames[role] as string] = { $type: "color", $value: value };
  }
  out.$extensions = {
    frontsmith: {
      family: result.family,
      profile: result.profile,
      catalogVersion: result.catalogVersion,
      inputsSha256: result.inputsSha256,
      outputSha256: result.outputSha256,
      requiredPairs: profile.pairs.map((pair) => ({
        fg: profile.tokenNames[pair.fg],
        bg: profile.tokenNames[pair.bg],
        kind: pair.kind,
      })),
    },
  };
  return out;
}
