import type { AgentProfile } from "../../domain/agents/roster.js";

/** One run of one child session (spec 5, 16). */
export interface RunRequest {
  profile: AgentProfile;
  /** The session children hang from: the session that issued the command or tool call. */
  parentSession: string;
  /** Short label shown by UIs, for example `T-003 implementer`. */
  title: string;
  prompt: string;
  /** Workspace root of the child. */
  workspace: string;
  /** Resolved model selector; `null` inherits the parent session's model. */
  model: string | null;
  /** Continue this child (bounces re-use the same session, spec 7.3). */
  reuseSession?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  sessionId?: string;
  usage?: { input: number; output: number };
  error?: string;
  /** The child hit its turn limit: the text is partial and an envelope from it is rejected. */
  turnsExceeded?: boolean;
}

/** Runs children; the only port through which the coordinator touches `api.sessions`. */
export interface AgentRunner {
  run(request: RunRequest): Promise<RunResult>;
  /** Abort every running child of this runner (stop command, dispose). */
  cancelAll(): void;
}

/** A runner that refuses every run: the CLI has no agents (spec 10.7 `NullAgentRunner`). */
export const nullAgentRunner: AgentRunner = {
  async run() {
    return { status: "failed", text: "", error: "requires Alisio session" };
  },
  cancelAll() {},
};
