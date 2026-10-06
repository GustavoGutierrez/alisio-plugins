import type { ChildRunResult, ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import type { AgentRunner, RunRequest, RunResult } from "../../application/ports/agent-runner.js";

/** The slice of `api.sessions` the runner uses. Only called once a run starts, never in `setup()`. */
export type SessionsPort = Pick<PluginAPI["sessions"], "create" | "run" | "cancel">;

export interface ChildSessionRunnerDeps {
  sessions: SessionsPort;
}

/** The `ChildSessionSpec` of one run: profile, model and workspace applied (spec 5.2, 16.1). */
export function childSpec(request: RunRequest): ChildSessionSpec {
  const { profile } = request;
  return {
    parentId: request.parentSession,
    title: request.title,
    agent: profile.name,
    instructions: profile.instructions,
    tools: { allow: profile.tools, deny: profile.disallowedTools },
    // `inherit` means no selector at all: the child uses the parent's model.
    ...(request.model ? { model: request.model } : {}),
    readOnly: profile.readOnly,
    permission: profile.permission,
    workspace: request.workspace,
    maxTurns: profile.maxTurns,
    timeoutMs: profile.timeoutMs,
    maxOutputTokens: profile.maxOutputTokens,
  };
}

function map(result: ChildRunResult): RunResult {
  const usage = { input: result.usage.input, output: result.usage.output };
  if (result.status === "completed")
    return {
      status: "completed",
      text: result.text,
      sessionId: result.id,
      usage,
      ...(result.turnsExceeded ? { turnsExceeded: true } : {}),
    };
  if (result.status === "cancelled" || result.status === "interrupted")
    return { status: "cancelled", text: result.text, sessionId: result.id, usage };
  return {
    status: "failed",
    text: result.text,
    sessionId: result.id,
    usage,
    error: result.error ?? `The child session ended as ${result.status}`,
  };
}

/**
 * `AgentRunner` over Alisio child sessions. A fresh child per run unless `reuseSession` names the
 * one to continue (bounces). Children cannot call plugin tools: everything they say is the final
 * text, which the caller validates as an envelope.
 */
export class ChildSessionRunner implements AgentRunner {
  private readonly live = new Set<string>();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly deps: ChildSessionRunnerDeps) {}

  async run(request: RunRequest): Promise<RunResult> {
    let sessionId = request.reuseSession;
    if (!sessionId) {
      try {
        sessionId = (await this.deps.sessions.create(childSpec(request))).id;
      } catch (error) {
        return {
          status: "failed",
          text: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (request.signal?.aborted) controller.abort();
    request.signal?.addEventListener("abort", forward, { once: true });
    this.controllers.add(controller);
    this.live.add(sessionId);
    try {
      const result = await this.deps.sessions.run(sessionId, request.prompt, {
        signal: controller.signal,
      });
      return map(result);
    } catch (error) {
      if (controller.signal.aborted) return { status: "cancelled", text: "", sessionId };
      return {
        status: "failed",
        text: "",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.controllers.delete(controller);
      this.live.delete(sessionId);
      request.signal?.removeEventListener("abort", forward);
    }
  }

  cancelAll(): void {
    for (const controller of this.controllers) controller.abort();
    for (const id of this.live) {
      try {
        this.deps.sessions.cancel(id);
      } catch {
        // The session may already be gone: cancelling is best effort.
      }
    }
  }
}
