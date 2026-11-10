import type { AskQuestionsRequest, ChildSessionSpec, PluginAPI } from "@alisio/sdk";

export interface FacadeHooks {
  /** Workspace of the app context: `sessions.workspace(id)` answers it for every id. */
  workspace: string;
  /** Aborted when the job is cancelled; passed to every child run that has none. */
  signal: AbortSignal;
  /** Receives `ui.status` texts (children and builds). */
  progress?: (text: string) => void;
  /** Receives the id of every child session the work creates. */
  child?: (id: string) => void;
}

/**
 * A job-scoped view of the plugin API (D3, "produce then decide"). The real coordinator runs on
 * it unchanged: `ui.interactive()` is false, so every gate parks its decision as text the app
 * shows as buttons; `askQuestions` answers every id with `undefined` for any call site that does
 * not check `interactive()` first; `ui.status` feeds the job progress instead of the chat footer;
 * child sessions are recorded (to cancel them) and run with the job's signal.
 */
export function jobApi(api: PluginAPI, hooks: FacadeHooks): PluginAPI {
  const ui: PluginAPI["ui"] = {
    status: (_key, text) => {
      if (typeof text === "string" && text.trim()) hooks.progress?.(text.trim().slice(0, 300));
    },
    panel: () => () => undefined,
    select: async () => undefined,
    askQuestions: async (request: AskQuestionsRequest) =>
      Object.fromEntries(request.questions.map((question) => [question.id, undefined])),
    open: () => false,
    interactive: () => false,
  };
  const sessions = new Proxy(api.sessions, {
    get(target, property) {
      if (property === "workspace") return () => hooks.workspace;
      if (property === "create")
        return async (spec: ChildSessionSpec) => {
          hooks.signal.throwIfAborted();
          const child = await target.create(spec);
          hooks.child?.(child.id);
          return child;
        };
      if (property === "run")
        return (id: string, prompt: string, options?: { signal?: AbortSignal }) => {
          hooks.signal.throwIfAborted();
          return target.run(id, prompt, { ...options, signal: options?.signal ?? hooks.signal });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(api, {
    get(target, property) {
      if (property === "ui") return ui;
      if (property === "sessions") return sessions;
      return Reflect.get(target, property);
    },
  });
}
