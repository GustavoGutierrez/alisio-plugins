/**
 * In-house glob matcher (spec 10.3): `**`, `*`, `?`, `{a,b}` (nestable) and `[abc]` classes over
 * POSIX relative paths. No negation: exclusions are separate arrays.
 */
export class GlobError extends Error {
  constructor(pattern: string, reason: string) {
    super(`Invalid glob "${pattern}": ${reason}`);
    this.name = "GlobError";
  }
}

const escapeLiteral = (char: string): string => char.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

function translate(pattern: string): string {
  let out = "";
  let braceDepth = 0;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slashBefore = index === 0 || pattern[index - 1] === "/";
        let end = index + 2;
        while (pattern[end] === "*") end += 1;
        if (slashBefore && pattern[end] === "/") {
          out += "(?:[^/]+/)*";
          index = end + 1;
        } else if (slashBefore && end === pattern.length) {
          out += ".+";
          index = end;
        } else {
          out += "[^/]*";
          index = end;
        }
      } else {
        out += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      index += 1;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) throw new GlobError(pattern, "unterminated character class");
      const body = pattern.slice(index + 1, close);
      if (body.startsWith("!") || body.startsWith("^"))
        throw new GlobError(pattern, "negated character classes are not supported");
      out += `[${body.replace(/[\\\]^]/g, "\\$&")}]`;
      index = close + 1;
    } else if (char === "{") {
      braceDepth += 1;
      out += "(?:";
      index += 1;
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      out += ")";
      index += 1;
    } else if (char === "," && braceDepth > 0) {
      out += "|";
      index += 1;
    } else {
      out += escapeLiteral(char);
      index += 1;
    }
  }
  if (braceDepth !== 0) throw new GlobError(pattern, "unbalanced braces");
  return out;
}

/** Compile once; the returned predicate accepts POSIX relative paths only. */
export function compileGlob(pattern: string): (path: string) => boolean {
  if (pattern.length === 0) throw new GlobError(pattern, "empty pattern");
  if (pattern.startsWith("!")) throw new GlobError(pattern, "negation is not supported");
  if (pattern.includes("\\")) throw new GlobError(pattern, "backslashes are not allowed");
  if (pattern.startsWith("/")) throw new GlobError(pattern, "patterns must be relative");
  const regex = new RegExp(`^${translate(pattern)}$`, "u");
  return (path) => !path.includes("\\") && !path.startsWith("/") && regex.test(path);
}

export const matchGlob = (pattern: string, path: string): boolean => compileGlob(pattern)(path);

export const matchAny = (patterns: readonly string[], path: string): boolean =>
  patterns.some((pattern) => matchGlob(pattern, path));
