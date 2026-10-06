import type { StackProfile } from "../../domain/stack/profile.js";
import { bullets, document, section } from "./md.js";

export interface ContextInput {
  stack: StackProfile;
  commands: Array<{ name: string; argv: string[]; source: string }>;
  inventory: { components: number; hooks: number; stores: number; tokens: number };
  docs: string[];
  architecturePresent: boolean;
  unknowns: string[];
}

/** `context.md`: the repository context the later phases read instead of re-discovering it. */
export function renderContextMd(input: ContextInput, feature: string): string {
  const { stack } = input;
  return document(
    `# Repository Context: ${feature}`,
    section(
      "Stack",
      bullets([
        `Framework: ${stack.framework}${stack.frameworkVersion ? ` ${stack.frameworkVersion}` : ""}${stack.meta !== "none" ? ` (${stack.meta})` : ""}`,
        `Language: ${stack.typescript ? "TypeScript" : "JavaScript"}`,
        `Package manager: ${stack.packageManager}${stack.monorepo ? " (monorepo)" : ""}`,
        `Styling: ${stack.styling.join(", ") || "none detected"}`,
        `State: ${stack.state.join(", ") || "none detected"}`,
        `Tests: ${stack.tests.join(", ") || "none detected"}`,
        `Source roots: ${stack.sourceRoots.join(", ") || "none detected"}`,
      ]),
    ),
    section(
      "Validation commands",
      bullets(
        input.commands.map((c) => `${c.name}: \`${c.argv.join(" ")}\` (${c.source})`),
        "- None found",
      ),
    ),
    section(
      "Existing building blocks",
      bullets([
        `${input.inventory.components} components, ${input.inventory.hooks} hooks, ${input.inventory.stores} stores, ${input.inventory.tokens} design tokens`,
        `Architecture configuration: ${input.architecturePresent ? "present" : "absent"}`,
      ]),
    ),
    section("Documents found", bullets(input.docs)),
    section("Unknowns", bullets(input.unknowns)),
  );
}
