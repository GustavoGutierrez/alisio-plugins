import type { Tier } from "../models/grammar.js";

/** Spec 5.4: the role -> agent map and the skills each agent loads. */
export const RESOURCE_PREFIX = "fs-";
export const roles = [
  "coordinator",
  "specifier",
  "ui-contractor",
  "tokensmith",
  "architect",
  "test-engineer",
  "implementer",
  "data-engineer",
  "a11y-auditor",
  "fidelity-reviewer",
  "reviewer",
  "archivist",
] as const;
export type FsRole = (typeof roles)[number];

export const agentName = (role: FsRole): `fs-${FsRole}` => `${RESOURCE_PREFIX}${role}`;

export const agentNames: readonly string[] = roles.map(agentName);

export const isRole = (value: unknown): value is FsRole =>
  typeof value === "string" && (roles as readonly string[]).includes(value);

/** `architect` or `fs-architect` -> the role; anything else is `undefined`. */
export function roleOf(roleOrAgent: string): FsRole | undefined {
  const bare = roleOrAgent.startsWith(RESOURCE_PREFIX)
    ? roleOrAgent.slice(RESOURCE_PREFIX.length)
    : roleOrAgent;
  return isRole(bare) ? bare : undefined;
}

export const roleSkills: Record<FsRole, string[]> = {
  coordinator: ["fs-coordinate"],
  specifier: ["fs-specify", "fs-evidence-protocol"],
  "ui-contractor": ["fs-ui-contract", "fs-design-direction", "fs-evidence-protocol"],
  tokensmith: ["fs-tokens"],
  architect: ["fs-architecture", "fs-component-design", "fs-task-contracts"],
  "test-engineer": ["fs-test-design", "fs-evidence-protocol"],
  implementer: ["fs-implement-ui", "fs-component-design", "fs-evidence-protocol"],
  "data-engineer": ["fs-data-layer", "fs-evidence-protocol"],
  "a11y-auditor": ["fs-a11y-audit"],
  "fidelity-reviewer": ["fs-fidelity-review", "fs-design-direction"],
  reviewer: ["fs-review"],
  archivist: ["fs-retrospective"],
};

/** The sixteen shipped skills (spec 6), in the order of the spec table. */
export const skillNames: readonly string[] = [
  "fs-coordinate",
  "fs-evidence-protocol",
  "fs-specify",
  "fs-ui-contract",
  "fs-design-direction",
  "fs-tokens",
  "fs-architecture",
  "fs-component-design",
  "fs-task-contracts",
  "fs-implement-ui",
  "fs-data-layer",
  "fs-test-design",
  "fs-a11y-audit",
  "fs-fidelity-review",
  "fs-review",
  "fs-retrospective",
];

/** Everything a runner needs to start a child session for one agent. */
export interface AgentProfile {
  name: string;
  role: FsRole;
  /** Agent body plus every loaded skill body: the same files registered with the host. */
  instructions: string;
  tools: string[];
  disallowedTools: string[];
  mode: "primary" | "subagent";
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  readOnly: boolean;
  permission: { write: "allow" | "deny" | "ask"; process: "allow" | "deny" | "ask" };
  tier: Tier;
}

/**
 * Which envelope each role returns (spec 5.3). The coordinator is primary and answers in plain
 * text; the test engineer returns a test map in design mode and a task result in build mode.
 */
export const roleEnvelope: Record<FsRole, string[]> = {
  coordinator: [],
  specifier: ["spec"],
  "ui-contractor": ["ui-contract"],
  tokensmith: ["tokens"],
  architect: ["plan"],
  "test-engineer": ["test-map", "task-result"],
  implementer: ["task-result"],
  "data-engineer": ["task-result"],
  "a11y-auditor": ["a11y-audit"],
  "fidelity-reviewer": ["fidelity-review"],
  reviewer: ["review"],
  archivist: ["archive"],
};
