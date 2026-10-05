import type { AgentRunner, RunResult } from "../ports/agent-runner.js";

/** Placeholder until the child-session adapter lands (Phase 3): every run fails visibly. */
export const unavailableRunner: AgentRunner = {
  async run(): Promise<RunResult> {
    return {
      status: "failed",
      text: "",
      error:
        "No agent runner is configured: the child-session runner is not available in this build",
    };
  },
  cancelProject(): void {},
};
