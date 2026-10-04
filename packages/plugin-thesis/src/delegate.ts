import type { ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import { loadRoleInstructions } from "./resources.js";
import { parseChildJson, type Validated } from "./schemas.js";
import type { ResourceRole } from "./types.js";

const readTools = ["read_file", "list_files", "search_text"];
const delegationTools = ["task", "delegate", "subagent", "sessions_create"];

/** Host web tools the librarian may use when they exist; their absence is never an error. */
export const librarianTools = [
  "thesis_scholar_search",
  "thesis_scholar_resolve",
  "web_search",
  "web_fetch",
  "brave_web_search",
  "brave_llm_context",
  "brave_summarizer",
];

type Profile = Pick<
  ChildSessionSpec,
  "agent" | "readOnly" | "permission" | "tools" | "maxTurns" | "timeoutMs" | "maxOutputTokens"
>;

const profile = (
  agent: string,
  maxTurns: number,
  allow: string[],
  timeoutMs = 180_000,
  maxOutputTokens = 6000,
): Profile => ({
  agent,
  readOnly: true,
  permission: { write: "deny", process: "deny" },
  tools: { allow, deny: delegationTools },
  maxTurns,
  timeoutMs,
  maxOutputTokens,
});

/** Spec 5.3: read-only children, 8 to 20 turns, 180 s (librarian 300 s), 6000 output tokens. */
export const childProfiles = {
  "thesis-methodologist": profile("Thesis Methodologist", 12, readTools),
  "thesis-architect": profile("Thesis Architect", 12, readTools),
  "thesis-librarian": profile("Thesis Librarian", 20, [...readTools, ...librarianTools], 300_000),
  "thesis-evidence-auditor": profile("Thesis Evidence Auditor", 14, [
    ...readTools,
    "thesis_scholar_resolve",
  ]),
  // The writer returns whole sections: a larger output budget (spec 5.3).
  "thesis-writer": profile("Thesis Writer", 16, readTools, 180_000, 12_000),
  // The editor may fetch an institutional guide by URL when the host offers a web tool.
  "thesis-editor": profile("Thesis Editor", 14, [...readTools, "web_fetch"], 180_000, 12_000),
  // The reviewer sees the built artifacts and the deterministic check report only.
  "thesis-reviewer": profile("Thesis Reviewer", 16, [...readTools, "thesis_check"]),
} as const satisfies Partial<Record<ResourceRole, Profile>>;
export type DelegatedRole = keyof typeof childProfiles;

/** A child was asked twice and still returned an envelope that fails validation. */
export class ChildRejectedError extends Error {
  constructor(
    readonly role: string,
    readonly errors: string[],
  ) {
    super(`${role} returned an invalid envelope: ${errors.join("; ")}`);
    this.name = "ChildRejectedError";
  }
}

export class Delegator {
  constructor(private readonly api: PluginAPI) {}

  private async once(
    role: DelegatedRole,
    parentId: string,
    workspace: string,
    title: string,
    prompt: string,
  ): Promise<string> {
    const instructions = await loadRoleInstructions(role);
    const child = await this.api.sessions.create({
      parentId,
      workspace,
      title,
      instructions,
      ...childProfiles[role],
    });
    this.api.ui.status("phase", `${role}: running`, title);
    try {
      const result = await this.api.sessions.run(child.id, prompt);
      if (result.turnsExceeded)
        throw new Error(`${role} exceeded its turn limit; partial output rejected`);
      if (result.status !== "completed")
        throw new Error(result.error || `${role} child ended with ${result.status}`);
      return result.text;
    } finally {
      this.api.ui.status("phase", undefined);
    }
  }

  /**
   * Run a child and validate its envelope. A malformed or invalid reply is retried once with the
   * validation errors in the prompt; a second failure throws ChildRejectedError.
   */
  async run<T>(
    role: DelegatedRole,
    parentId: string,
    workspace: string,
    title: string,
    prompt: string,
    validate: (value: unknown) => Validated<T>,
  ): Promise<T> {
    let errors: string[] = [];
    for (const attempt of [1, 2]) {
      const sent =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous reply was rejected:\n${errors.map((error) => `- ${error}`).join("\n")}\nReturn the complete corrected JSON object only.`;
      const reply = await this.once(role, parentId, workspace, title, sent);
      let parsed: unknown;
      try {
        parsed = parseChildJson(reply);
      } catch (error) {
        errors = [(error as Error).message];
        continue;
      }
      const checked = validate(parsed);
      if (checked.value !== undefined) return checked.value;
      errors = checked.errors.slice(0, 20);
    }
    throw new ChildRejectedError(role, errors);
  }
}
