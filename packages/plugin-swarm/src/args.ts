/** Split command arguments at the first ` -- `: tokens before it, free text after it. */
export function splitDoubleDash(args: string): { head: string[]; tail: string } {
  const text = args.trim();
  const match = /(^|\s)--(\s|$)/.exec(text);
  if (!match) return { head: text ? text.split(/\s+/) : [], tail: "" };
  const head = text.slice(0, match.index).trim();
  return {
    head: head ? head.split(/\s+/) : [],
    tail: text.slice(match.index + match[0].length).trim(),
  };
}

export function parseFlags(
  tokens: string[],
  allowed: string[],
): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) throw new Error(`Unknown flag: ${token}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Flag ${token} needs a value`);
    flags[name] = value;
    index += 1;
  }
  return { positional, flags };
}
