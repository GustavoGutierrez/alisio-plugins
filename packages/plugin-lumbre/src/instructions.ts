// Child-session instructions, built from the packaged agent and skill files (the same files the
// catalog registers). The design skill shapes plan and build passes (not fixes); the React/Next.js
// rules and the Next.js 16 file conventions are added only for the stacks they apply to.
import { readFile } from "node:fs/promises";
import type { StackId } from "./presets.js";

export type InstructionMode = "build" | "fix" | "agent" | "plan" | "agentFix";

const BASE: Record<InstructionMode, string[]> = {
  build: ["agents/lmb-builder.md", "skills/lmb-web/SKILL.md", "skills/lmb-design/SKILL.md"],
  fix: ["agents/lmb-builder.md", "skills/lmb-fix/SKILL.md"],
  agent: ["agents/lmb-agent.md", "skills/lmb-web/SKILL.md", "skills/lmb-design/SKILL.md"],
  plan: ["agents/lmb-agent.md", "skills/lmb-design/SKILL.md"],
  agentFix: ["agents/lmb-agent.md", "skills/lmb-fix/SKILL.md"],
};
const REACT = "skills/lmb-react-next/references/react-rules.md";
const TAILWIND = [
  "skills/lmb-tailwind/SKILL.md",
  "skills/lmb-tailwind/references/tailwind-v4.md",
  "skills/lmb-tailwind/references/components.md",
];
const NEXT = "skills/lmb-react-next/references/next-file-conventions.md";

/** The files (relative to `.agents/`) that make up one mode's instructions for a stack. */
export function instructionFiles(
  mode: InstructionMode,
  stack: StackId,
  tailwind = stack !== "vanilla",
): string[] {
  const files = [...BASE[mode]];
  // Tailwind guidance for every Tailwind stack, in build passes (plans and fixes do not style).
  if (tailwind && (mode === "build" || mode === "agent")) files.push(...TAILWIND);
  if (stack !== "react" && stack !== "next") return files;
  files.push("skills/lmb-react-next/SKILL.md");
  // Plans decide routes, not code style: the Next.js conventions only.
  if (mode !== "plan") files.push(REACT);
  if (stack === "next") files.push(NEXT);
  return files;
}

const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const readAgentsFile = (path: string) =>
  readFile(new URL(`../.agents/${path}`, import.meta.url), "utf8");

/** The instruction text: each file without its frontmatter, separated by rules. */
export async function composeInstructions(
  mode: InstructionMode,
  stack: StackId,
  tailwind = stack !== "vanilla",
  read: (path: string) => Promise<string> = readAgentsFile,
): Promise<string> {
  const parts = await Promise.all(
    instructionFiles(mode, stack, tailwind).map(async (f) => stripFrontmatter(await read(f))),
  );
  return parts.join("\n\n---\n\n");
}
