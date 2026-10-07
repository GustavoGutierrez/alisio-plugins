import { readFile } from "node:fs/promises";

/** Resource paths are relative to the built entry, so they resolve from `dist/` and `src/` alike. */
export const resourcePaths = {
  agents: "../.agents/agents",
  skills: "../.agents/skills",
} as const;

export const agentNames = [
  "evl-coordinator",
  "evl-assessment-designer",
  "evl-item-author",
  "evl-math-reviewer",
  "evl-language-reviewer",
] as const;

export const skillNames = [
  "evl-intake",
  "evl-knowledge-base",
  "evl-blueprint",
  "evl-item-writing",
  "evl-math-review",
  "evl-language-review",
  "evl-layout",
  "evl-closing-text",
] as const;

/** Skills each role loads; the same files are registered resources and child instructions. */
export const roleSkills: Record<string, string[]> = {
  "evl-coordinator": ["evl-intake", "evl-blueprint", "evl-closing-text"],
  "evl-assessment-designer": ["evl-blueprint", "evl-knowledge-base"],
  "evl-item-author": ["evl-item-writing", "evl-knowledge-base"],
  "evl-math-reviewer": ["evl-math-review", "evl-item-writing"],
  "evl-language-reviewer": ["evl-language-review", "evl-item-writing"],
};

/** Reads the instructions for a role. Accepts the bare role (`coordinator`) or the full name. */
export async function loadRoleInstructions(role: string): Promise<string> {
  const name = role.startsWith("evl-") ? role : `evl-${role}`;
  return readFile(new URL(`../.agents/agents/${name}.md`, import.meta.url), "utf8");
}
