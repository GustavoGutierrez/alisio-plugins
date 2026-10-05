import type { ChildRunResult, ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import type {
  AgentRunner,
  RunnerView,
  RunRequest,
  RunResult,
  TailEntry,
} from "../ports/agent-runner.js";
import { type AgentProfile, isResourceRole, loadAgentProfile } from "../resources.js";

/** The slice of `api.sessions` the runner uses. It is only called once a run starts, never in `setup()`. */
export type SessionsPort = Pick<PluginAPI["sessions"], "create" | "run" | "cancel">;

export interface ChildSessionRunnerDeps {
  sessions: SessionsPort;
  /** The parent session children hang from: the session that issued the latest swarm command. */
  parentSession: () => string | undefined;
  /** `pluginOverrides.swarm.options.roles` (AD-12): the model per role. */
  roleOptions: () => Record<string, { model?: string }>;
  /** Test seam; production loads the agent file and its skills. */
  loadProfile?: (agent: string) => Promise<AgentProfile>;
}

interface Entry {
  id: string;
  project: string;
  workdir: string;
  controllers: Set<AbortController>;
  tail: TailEntry[];
  /** Start times (ms) of recent runs, pruned to the meter window. */
  starts: number[];
}

const MAX_TAIL = 40;
const MAX_TAIL_TEXT = 2000;
const METER_WINDOW_MS = 10 * 60 * 1000;

async function defaultProfile(agent: string): Promise<AgentProfile> {
  if (!isResourceRole(agent)) throw new Error(`Unknown agent: ${agent}`);
  return loadAgentProfile(agent);
}

const failed = (error: string): RunResult => ({ status: "failed", text: "", error });

/**
 * `AgentRunner` over Alisio child sessions (AD-2). One long-lived child per `project/role` key,
 * created lazily with the role's worktree as workspace, so an audit or an answer resumes the same
 * conversation. Agents cannot call plugin tools: everything they say comes back as the final text.
 */
export class ChildSessionRunner implements AgentRunner {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: ChildSessionRunnerDeps) {}

  private spec(request: RunRequest, profile: AgentProfile, parentId: string): ChildSessionSpec {
    const model = this.deps.roleOptions()[request.role]?.model;
    return {
      parentId,
      title: request.sessionKey,
      agent: profile.name,
      instructions: profile.instructions,
      tools: { allow: profile.tools, deny: profile.disallowedTools },
      ...(model ? { model } : {}),
      readOnly: profile.readOnly,
      permission: profile.permission,
      workspace: request.workdir,
      maxTurns: profile.maxTurns,
      timeoutMs: profile.timeoutMs,
      maxOutputTokens: profile.maxOutputTokens,
    };
  }

  private async session(request: RunRequest, profile: AgentProfile): Promise<Entry> {
    const existing = this.entries.get(request.sessionKey);
    if (existing && existing.workdir === request.workdir) return existing;
    const parent = this.deps.parentSession();
    if (!parent) {
      throw new Error("No parent session is available: run a /swarm command from a session first");
    }
    const info = await this.deps.sessions.create(this.spec(request, profile, parent));
    const entry: Entry = {
      id: info.id,
      project: request.project,
      workdir: request.workdir,
      controllers: new Set(),
      tail: [],
      starts: [],
    };
    this.entries.set(request.sessionKey, entry);
    return entry;
  }

  async run(request: RunRequest): Promise<RunResult> {
    let entry: Entry;
    try {
      const profile = await (this.deps.loadProfile ?? defaultProfile)(request.agent);
      entry = await this.session(request, profile);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    const record = (kind: TailEntry["kind"], text: string): void => {
      const clipped = text.length > MAX_TAIL_TEXT ? `${text.slice(0, MAX_TAIL_TEXT)}…` : text;
      entry.tail.push({ at: new Date().toISOString(), kind, text: clipped });
      if (entry.tail.length > MAX_TAIL) entry.tail.splice(0, entry.tail.length - MAX_TAIL);
    };
    entry.starts.push(Date.now());
    record("prompt", request.prompt);
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (request.signal?.aborted) controller.abort();
    request.signal?.addEventListener("abort", forward, { once: true });
    entry.controllers.add(controller);
    try {
      const result = await this.deps.sessions.run(entry.id, request.prompt, {
        signal: controller.signal,
      });
      record("reply", result.text);
      return this.map(result);
    } catch (error) {
      if (controller.signal.aborted) return { status: "cancelled", text: "" };
      return failed(error instanceof Error ? error.message : String(error));
    } finally {
      entry.controllers.delete(controller);
      request.signal?.removeEventListener("abort", forward);
    }
  }

  inspect(sessionKey: string): RunnerView | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) return undefined;
    const since = Date.now() - METER_WINDOW_MS;
    entry.starts = entry.starts.filter((start) => start >= since);
    return {
      sessionId: entry.id,
      live: entry.controllers.size > 0,
      recentRuns: entry.starts.length,
      tail: entry.tail.map((line) => ({ ...line })),
    };
  }

  private map(result: ChildRunResult): RunResult {
    const usage = { input: result.usage.input, output: result.usage.output };
    if (result.status === "completed") {
      return {
        status: "completed",
        text: result.text,
        usage,
        ...(result.turnsExceeded ? { turnsExceeded: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }
    if (result.status === "cancelled" || result.status === "interrupted") {
      return { status: "cancelled", text: result.text, usage };
    }
    return {
      status: "failed",
      text: result.text,
      usage,
      error: result.error ?? `The child session ended as ${result.status}`,
    };
  }

  private cancelEntry(key: string, entry: Entry): void {
    for (const controller of entry.controllers) controller.abort();
    try {
      this.deps.sessions.cancel(entry.id);
    } catch {
      // The session may already be gone: cancelling is best effort.
    }
    this.entries.delete(key);
  }

  cancelProject(project: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.project === project) this.cancelEntry(key, entry);
    }
  }

  /** Teardown and dispose: cancel every session this runner created. */
  cancelAll(): void {
    for (const [key, entry] of [...this.entries]) this.cancelEntry(key, entry);
  }
}
