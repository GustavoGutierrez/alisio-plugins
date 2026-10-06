/** Minimal JSONC reader: comments and trailing commas (tsconfig style). */
export class JsoncError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (offset ${offset})`);
    this.name = "JsoncError";
  }
}

/** Replace comments with whitespace and drop trailing commas, keeping string contents intact. */
export function stripJsonc(input: string): string {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) throw new JsoncError("Unterminated block comment", index);
      out += text.slice(index, end + 2).replace(/[^\n]/g, " ");
      index = end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(input: string): unknown {
  const stripped = stripJsonc(input);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const match = /position (\d+)/.exec(error instanceof Error ? error.message : "");
    throw new JsoncError(
      error instanceof Error ? error.message : "Invalid JSON",
      match ? Number(match[1]) : 0,
    );
  }
}
