/**
 * Allowlist-first redaction for opt-in content capture.
 *
 * The default posture is metadata-only: no prompt, completion, tool argument or
 * tool result text is ever captured unless the operator turns a specific capture
 * flag on. When capture is enabled this module is the only door content passes
 * through.
 *
 * WHY ALLOWLIST, NOT DENYLIST. A pure denylist fails the moment a new credential
 * format appears. Here the safe character set is explicitly allowed and
 * everything outside it is neutralized; on top of that, a stack of
 * credential-shape rules removes bearer headers, tokens, private keys and
 * absolute machine paths. Unknown secret-named object keys are dropped entirely
 * rather than passed through. In `strict` mode long high-entropy runs are also
 * removed. This is defense in depth, not a guarantee: never capture more than
 * you are willing to leak.
 */

export type RedactionMode = "strict" | "standard";

export interface RedactionOptions {
  mode: RedactionMode;
  /** Hard per-field cap after redaction. Defaults to 2000 characters. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 2_000;
const MARKER = "[redacted]";

/** Object keys whose values must never be captured, regardless of content. */
const FORBIDDEN_KEY =
  /^(?:authorization|proxy[-_]?authorization|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|credentials|bearer|cookie|set[-_]?cookie|x[-_]?api[-_]?key)$/i;

interface Rule {
  pattern: RegExp;
  replacement: string;
  strictOnly?: boolean;
}

/**
 * Credential-shape rules. Order matters: whole PEM blocks and authorization
 * headers are removed before the narrower token rules run.
 */
const RULES: Rule[] = [
  {
    // A PEM block, including the body, so the key material never survives.
    pattern: /-{5}BEGIN[^-]{0,40}PRIVATE KEY-{5}[\s\S]*?-{5}END[^-]{0,40}PRIVATE KEY-{5}/g,
    replacement: MARKER,
  },
  {
    pattern: /-{5}BEGIN[^-]{0,40}PRIVATE KEY-{5}/g,
    replacement: MARKER,
  },
  {
    // Authorization / proxy-authorization values, whatever scheme follows. The
    // whole line remainder is removed so a scheme token can never survive.
    pattern: /\b(?:authorization|proxy-authorization)\b\s*[:=][^"\n]*/gi,
    replacement: `authorization: ${MARKER}`,
  },
  {
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: `bearer ${MARKER}`,
  },
  {
    // Common provider token prefixes.
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|AKIA|ASIA|npm|dop_v1|pypi|hf)[_-][A-Za-z0-9_-]{12,}/g,
    replacement: MARKER,
  },
  {
    // JSON Web Tokens.
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replacement: MARKER,
  },
  {
    // key=value / key: value secret assignments.
    pattern:
      /(?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    replacement: `${MARKER}`,
  },
  {
    // Environment-style secret assignments, e.g. a token name set to a value.
    pattern:
      /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/g,
    replacement: `${MARKER}`,
  },
  {
    // Absolute personal home paths.
    pattern: /(?<![A-Za-z0-9._-])\/(?:home|Users)\/[^\s"'`,;:)\]}]+/g,
    replacement: "<path>",
  },
  {
    pattern: /(?<![A-Za-z0-9._-])\/root\/[^\s"'`,;:)\]}]*/g,
    replacement: "<path>",
  },
  {
    pattern: /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\s"'`,;:)\]}]+/g,
    replacement: "<path>",
  },
  {
    // strict: long base64-ish or hex runs that no human sentence contains.
    pattern: /[A-Za-z0-9+/]{48,}={0,2}/g,
    replacement: MARKER,
    strictOnly: true,
  },
  {
    pattern: /\b[a-f0-9]{48,}\b/gi,
    replacement: MARKER,
    strictOnly: true,
  },
];

/** True when an object key names a secret and its value must be dropped. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY.test(key);
}

/** Neutralize characters outside the allowlisted printable set, keeping \n and \t. */
function allowlistCharacters(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" || character === "\t" || character === "\r" ? character : " ",
  );
}

/** Redact a single string. Always bounded; never throws. */
export function redactText(text: string, options: RedactionOptions): string {
  const max = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (typeof text !== "string") return "";
  let value = allowlistCharacters(text);
  for (const rule of RULES) {
    if (rule.strictOnly && options.mode !== "strict") continue;
    value = value.replace(rule.pattern, rule.replacement);
  }
  if (value.length > max) value = value.slice(0, max);
  return value;
}

const MAX_DEPTH = 6;
const MAX_ENTRIES = 200;

/**
 * Redact a structured value: strings are redacted, secret-named keys are
 * dropped, depth and breadth are bounded. Cycles and exotic values collapse to
 * a safe placeholder instead of throwing.
 */
export function redactValue(value: unknown, options: RedactionOptions, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return typeof value === "bigint" ? value.toString() : value;
  if (depth >= MAX_DEPTH) return MARKER;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, options, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_ENTRIES) break;
      count += 1;
      if (isForbiddenKey(key)) {
        out[key] = MARKER;
        continue;
      }
      out[key] = redactValue(item, options, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Redact a value and serialize it as a bounded JSON string. */
export function redactJson(value: unknown, options: RedactionOptions): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactValue(value, options));
  } catch {
    serialized = MARKER;
  }
  if (typeof serialized !== "string") serialized = MARKER;
  return redactText(serialized, options);
}
