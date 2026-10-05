/** Runs one agent turn for a role. v1's real adapter is an Alisio child session (Phase 3). */
export interface RunRequest {
  /** Stable key of the long-lived conversation: one per project and role, reused across prompts. */
  sessionKey: string;
  project: string;
  role: string;
  /** The pack's agent definition id (its `.agents/agents` file). */
  agent: string;
  /** Working directory of the role: its git worktree, or the main checkout for the master role. */
  workdir: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface RunResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  /** The child hit its turn limit: `text` is partial and must be rejected. */
  turnsExceeded?: boolean;
  error?: string;
  /** Tokens the run consumed, when the host reports them (feeds the swarm token budget). */
  usage?: { input: number; output: number };
}

/** One line of the plugin-recorded activity of a role (the SDK exposes no transcript API). */
export interface TailEntry {
  at: string;
  kind: "prompt" | "reply";
  text: string;
}

/** A read-only view of a role's conversation for observability (dashboard tail, work queue). */
export interface RunnerView {
  /** The host child session id, when the adapter has one. */
  sessionId?: string;
  /** A run is in flight right now. */
  live: boolean;
  /** Runs started in the last ten minutes: the activity meter of the work queue. */
  recentRuns: number;
  tail: TailEntry[];
}

export interface AgentRunner {
  run(request: RunRequest): Promise<RunResult>;
  /** Cancel every running conversation of a project (close, teardown). */
  cancelProject(project: string): void;
  /** Cancel every running conversation (teardown, dispose). */
  cancelAll?(): void;
  /** Observability only: undefined when the role has no conversation yet. */
  inspect?(sessionKey: string): RunnerView | undefined;
}
