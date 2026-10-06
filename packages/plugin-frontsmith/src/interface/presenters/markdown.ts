/** Portable Markdown subset for command output (spec 18.1): no HTML, no images. */
export const MAX_MARKDOWN = 12_000;

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

export const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

/** Cap long output; the note says where the full report lives. */
export function capOutput(text: string, note: string, max = MAX_MARKDOWN): string {
  if (text.length <= max) return text;
  const suffix = `\n\n... output truncated. ${note}`;
  return `${text.slice(0, max - suffix.length)}${suffix}`;
}
