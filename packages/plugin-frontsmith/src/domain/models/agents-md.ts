import { parseModelValue, type Tier } from "./grammar.js";
import type { ModelDiagnostic } from "./layers.js";

export interface AgentsMdResult {
  /** A `frontsmith-models` block exists. */
  present: boolean;
  tiers: Partial<Record<Tier, string>>;
  agents: Record<string, string>;
  diagnostics: ModelDiagnostic[];
  /** SHA-256 of the block text; part of the protected set (spec 16.5). */
  blockSha256?: string;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;
const LINE = /^(tier\.(reasoning|standard|fast)|agent\.[a-z][a-z0-9-]{2,40})\s*=\s*(\S+)$/;

interface Block {
  line: number;
  lines: string[];
  closed: boolean;
}

/**
 * Parse the first fenced block with info string `frontsmith-models` (spec 16.5). A pure string
 * function: it never executes anything. Fences inside another fenced block are examples, not
 * directives.
 */
export function parseAgentsMd(
  text: string,
  options: { knownAgents: readonly string[]; sha256?: (text: string) => string },
): AgentsMdResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let open: { char: string; length: number; block?: Block } | undefined;
  lines.forEach((line, index) => {
    if (open) {
      const close = new RegExp(
        `^ {0,3}(${open.char === "`" ? "`" : "~"}{${open.length},})[ \\t]*$`,
      ).exec(line);
      if (close) {
        if (open.block) open.block.closed = true;
        open = undefined;
      } else open.block?.lines.push(line);
      return;
    }
    const opener = OPEN.exec(line);
    if (!opener) return;
    const fence = opener[1] as string;
    const info = opener[2] as string;
    if (fence.startsWith("`") && info.includes("`")) return;
    const block: Block | undefined =
      info === "frontsmith-models" ? { line: index + 1, lines: [], closed: false } : undefined;
    if (block) blocks.push(block);
    open = { char: fence[0] as string, length: fence.length, ...(block ? { block } : {}) };
  });

  const diagnostics: ModelDiagnostic[] = [];
  const add = (code: ModelDiagnostic["code"], line: number, message: string): void => {
    diagnostics.push({ code, layer: "agents-md", line, message });
  };
  const result: AgentsMdResult = { present: blocks.length > 0, tiers: {}, agents: {}, diagnostics };
  const [block] = blocks;
  if (!block) return result;
  if (blocks.length > 1) {
    add(
      "FSM-002",
      (blocks[1] as Block).line,
      "more than one frontsmith-models block; keep exactly one",
    );
    return result;
  }
  if (options.sha256) result.blockSha256 = options.sha256(block.lines.join("\n"));
  if (!block.closed) add("FSM-001", block.line, "the frontsmith-models block is never closed");
  const seen = new Set<string>();
  block.lines.forEach((raw, offset) => {
    const lineNumber = block.line + 1 + offset;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const match = LINE.exec(line);
    if (!match) {
      add("FSM-001", lineNumber, `not a directive: ${JSON.stringify(line.slice(0, 80))}`);
      return;
    }
    const key = match[1] as string;
    const value = match[3] as string;
    if (seen.has(key)) {
      add("FSM-003", lineNumber, `${key} is set twice`);
      return;
    }
    seen.add(key);
    const isTierKey = key.startsWith("tier.");
    const name = key.slice(key.indexOf(".") + 1);
    if (!isTierKey && !options.knownAgents.includes(name)) {
      add("FSM-004", lineNumber, `unknown agent ${name}`);
      return;
    }
    const parsed = parseModelValue(value, { tierRef: !isTierKey });
    if (!parsed.ok) {
      add(parsed.code, lineNumber, parsed.message);
      return;
    }
    if (isTierKey) result.tiers[name as Tier] = value;
    else result.agents[name] = value;
  });
  return result;
}
