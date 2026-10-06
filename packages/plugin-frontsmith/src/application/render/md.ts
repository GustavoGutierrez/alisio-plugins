/** Small Markdown helpers shared by the artifact renderers (no HTML, no images: spec 18.1). */
export const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function mdTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

export const bullets = (items: readonly string[], empty = "- None"): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

export const section = (title: string, body: string, level = 2): string =>
  `${"#".repeat(level)} ${title}\n\n${body.trim() === "" ? "- None" : body.trim()}`;

/** Join blocks with one blank line and end the file with a newline. */
export const document = (...blocks: readonly string[]): string => `${blocks.join("\n\n")}\n`;
