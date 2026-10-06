import type { ToolResult, UiBlock } from "@alisio/sdk";

export interface ToolResultParts {
  /** What the model reads (the host projects the text part). */
  summary: string;
  /** The block the TUI shows: it renders only the first `ui` block. */
  primary?: UiBlock;
  /** The image the TUI shows: it renders only the first `image` part. */
  image?: { mimeType: string; data: string };
  /** Shown by the web only. */
  secondary?: UiBlock[];
  /** Further images (region crops): the web shows them after the secondary blocks. */
  moreImages?: Array<{ mimeType: string; data: string }>;
  isError?: boolean;
}

/** Content order of spec 18.1: text, primary block, primary image, secondary blocks. */
export function toolResult(parts: ToolResultParts): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text: parts.summary }];
  if (parts.primary) content.push({ type: "ui", block: parts.primary });
  if (parts.image)
    content.push({ type: "image", mimeType: parts.image.mimeType, data: parts.image.data });
  for (const block of parts.secondary ?? []) content.push({ type: "ui", block });
  for (const image of parts.moreImages ?? [])
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  return { content, ...(parts.isError ? { isError: true } : {}) };
}

export const errorResult = (message: string): ToolResult =>
  toolResult({ summary: message, isError: true });
