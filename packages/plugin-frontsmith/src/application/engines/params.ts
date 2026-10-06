import { compileGlob } from "../../domain/glob.js";

/**
 * Collects problems while reading engine params. Every engine declares its allowed keys so a typo
 * in a pack fails at load (PCK-006) instead of silently doing nothing.
 */
export class ParamReader {
  readonly errors: string[] = [];

  constructor(
    readonly params: Record<string, unknown>,
    allowed: readonly string[],
  ) {
    for (const key of Object.keys(params))
      if (key !== "excludeFiles" && !allowed.includes(key))
        this.errors.push(`unknown param "${key}"`);
    const exclude = params.excludeFiles;
    if (exclude !== undefined) this.globs("excludeFiles");
  }

  has(key: string): boolean {
    return this.params[key] !== undefined;
  }

  regex(key: string, required = false): RegExp | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) this.errors.push(`${key}: required`);
      return undefined;
    }
    if (typeof value !== "string") {
      this.errors.push(`${key}: must be a regular expression string`);
      return undefined;
    }
    try {
      return new RegExp(value, "u");
    } catch {
      this.errors.push(`${key}: invalid regex "${value}"`);
      return undefined;
    }
  }

  string(key: string, required = false): string | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) this.errors.push(`${key}: required`);
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      this.errors.push(`${key}: must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  bool(key: string): boolean | undefined {
    const value = this.params[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.errors.push(`${key}: must be a boolean`);
      return undefined;
    }
    return value;
  }

  number(key: string, min = 0, required = false): number | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) this.errors.push(`${key}: required`);
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      this.errors.push(`${key}: must be a number >= ${min}`);
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(key: string, options: readonly T[], required = false): T | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) this.errors.push(`${key}: required (${options.join("|")})`);
      return undefined;
    }
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      this.errors.push(`${key}: must be one of ${options.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  strings(key: string, required = false): string[] | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) this.errors.push(`${key}: required`);
      return undefined;
    }
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      this.errors.push(`${key}: must be an array of non-empty strings`);
      return undefined;
    }
    return value as string[];
  }

  globs(key: string, required = false): string[] | undefined {
    const list = this.strings(key, required);
    if (!list) return undefined;
    for (const glob of list) {
      try {
        compileGlob(glob);
      } catch {
        this.errors.push(`${key}: invalid glob "${glob}"`);
      }
    }
    return list;
  }

  regexList(key: string): RegExp[] | undefined {
    const list = this.strings(key);
    if (!list) return undefined;
    const out: RegExp[] = [];
    for (const source of list) {
      try {
        out.push(new RegExp(source, "u"));
      } catch {
        this.errors.push(`${key}: invalid regex "${source}"`);
      }
    }
    return out;
  }

  object(key: string): Record<string, unknown> | undefined {
    const value = this.params[key];
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.errors.push(`${key}: must be an object`);
      return undefined;
    }
    return value as Record<string, unknown>;
  }
}

/** Params of the common pre-filter every engine accepts. */
export const COMMON_PARAMS = ["excludeFiles"] as const;
