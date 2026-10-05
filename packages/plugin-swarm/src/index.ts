import { type CommandContext, definePlugin, type PluginAPI, type ToolResult } from "@alisio/sdk";
import { type CoordinatorOptions, SwarmCoordinator } from "./coordinator.js";
import { panelNodes } from "./panel.js";
import { resourcePaths } from "./resources.js";
import { VERSION } from "./version.js";

export { ChildSessionRunner } from "./adapters/child-session-runner.js";
export { FsBoardStore } from "./adapters/fs-board-store.js";
export { FsHandoffStore } from "./adapters/fs-handoff-store.js";
export { GitWorktreeIsolation } from "./adapters/git-worktree.js";
export { ProcessGateRunner } from "./adapters/process-gate-runner.js";
export { unavailableRunner } from "./adapters/unavailable-runner.js";
export { Forge } from "./app/forge.js";
export { ProjectRuntime } from "./app/project.js";
export { SwarmServices } from "./app/services.js";
export { SwarmCoordinator } from "./coordinator.js";
export { formatDoctor, runDoctor } from "./doctor.js";
export * from "./domain/attention.js";
export * from "./domain/envelope.js";
export * from "./domain/handoff.js";
export * from "./domain/identifiers.js";
export * from "./domain/pack.js";
export * from "./domain/pipeline.js";
export * from "./domain/task.js";
export type { AgentRunner, RunRequest, RunResult } from "./ports/agent-runner.js";
export type { BoardStore } from "./ports/board-store.js";
export type { GateReport, GateRequest, GateRunner } from "./ports/gate-runner.js";
export type { HandoffStore } from "./ports/handoff-store.js";
export type { Isolation, MergeResult } from "./ports/isolation.js";
export type { Notifier, SwarmEvent } from "./ports/notifier.js";
export { parseTaskRef } from "./refs.js";
export {
  agentForRole,
  isResourceRole,
  listShippedPacks,
  loadAgentProfile,
  loadRoleInstructions,
  loadShippedPack,
  loadToolchain,
  parseResource,
  resourcePaths,
  roleSkills,
} from "./resources.js";
export { atomicWrite } from "./storage.js";
export * from "./toolchains/profile.js";
export * from "./toolchains/thresholds.js";

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const failure = (error: unknown): ToolResult =>
  text(error instanceof Error ? error.message : String(error), true);

/** Register the swarm plugin on an API. `options` are test seams; production passes none. */
export function registerSwarm(api: PluginAPI, options: CoordinatorOptions = {}): SwarmCoordinator {
  api.resources.agents(resourcePaths.agents);
  api.resources.skills(resourcePaths.skills);
  const coordinator = new SwarmCoordinator(api, options);
  const register = (
    name: string,
    description: string,
    argumentHint: string,
    handler: (workspace: string, args: string) => Promise<string>,
  ) =>
    api.commands.register(
      name,
      async (args: string, context?: CommandContext) =>
        handler(coordinator.workspaceOf(context?.sessionId), args),
      { description, argumentHint },
    );
  register("init", "Create the swarm forge in this workspace", "", (workspace) =>
    coordinator.init(workspace),
  );
  register("doctor", "Check git, Node.js, toolchain commands and the workspace", "", (workspace) =>
    coordinator.doctor(workspace),
  );
  register(
    "pack",
    "List shipped and workspace packs, or show one",
    "list | show <name>",
    (workspace, args) => coordinator.pack(workspace, args),
  );
  register(
    "project",
    "Create, open, close and list swarm projects",
    "new <name> [--pack <pack>] [--github <owner/repo>] -- <mission> | open <name> | close <name> | list",
    (workspace, args) => coordinator.project(workspace, args),
  );
  register(
    "task",
    "Create a task card and queue it for the first role",
    "<project> new [name] -- <task text> | delete <name> | retry <name> | accept <name>",
    (workspace, args) => coordinator.task(workspace, args),
  );
  register(
    "approve",
    "Approve a task waiting at the approval gate",
    "<project>/<task>",
    (workspace, args) => coordinator.approve(workspace, args),
  );
  register(
    "reject",
    "Reject a task at the approval gate: retry, delete or accept unchanged",
    "<project>/<task> retry|delete|accept [-- comments]",
    (workspace, args) => coordinator.reject(workspace, args),
  );
  register(
    "answer",
    "Answer a clarification question from a role",
    "<project>/<task> -- <answer>",
    (workspace, args) => coordinator.answer(workspace, args),
  );
  register(
    "comment",
    "Comment on a document of a task waiting for approval, or clear the comments",
    "<project>/<task> <document> -- <comment> | <project>/<task> clear",
    (workspace, args) => coordinator.comment(workspace, args),
  );
  register(
    "chat",
    "Talk to the read-only Lieutenant of a project",
    "[project] -- <message>",
    (workspace, args) => coordinator.chat(workspace, args),
  );
  register(
    "stop",
    "Cancel a project's agents and halt its pump (the project stays open)",
    "<project>",
    (workspace, args) => coordinator.stop(workspace, args),
  );
  register(
    "run",
    "Run a project's pump in the foreground until it is idle",
    "<project> [--seconds <1-3600>]",
    (workspace, args) => coordinator.run(workspace, args),
  );
  register(
    "budget",
    "Show the swarm token budget, or raise the cap",
    "[raise <tokens>]",
    (workspace, args) => coordinator.budget(workspace, args),
  );
  register(
    "dashboard",
    "Open the local swarm follow-up dashboard: board, work queue, activity and approvals",
    "[project | project/task]",
    (workspace, args) => coordinator.dashboard(workspace, args),
  );
  register(
    "teardown",
    "Cancel every agent and stop every project (project files stay)",
    "--confirm TEARDOWN",
    (workspace, args) => coordinator.teardown(workspace, args),
  );
  register(
    "status",
    "Show projects, lanes and items that need your attention",
    "[project]",
    (workspace, args) => coordinator.statusText(workspace, args),
  );

  registerFallbacks(api, coordinator);
  api.tools.register({
    name: "swarm_status",
    description: "Show swarm projects, the task board and items that need attention.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Limit the report to one project." } },
      additionalProperties: false,
    },
    effect: "read",
    async execute(input, context) {
      try {
        const project = typeof input.project === "string" ? input.project : undefined;
        return await coordinator.statusTool(context.workspace, project);
      } catch (error) {
        return failure(error);
      }
    },
  });
  api.tools.register({
    name: "swarm_task_new",
    description: "Create a task card in an open swarm project and queue it for the first role.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Open project name." },
        text: { type: "string", description: "Task description." },
        name: { type: "string", description: "Optional task slug." },
      },
      required: ["project", "text"],
      additionalProperties: false,
    },
    effect: "write",
    async execute(input, context) {
      try {
        if (typeof input.project !== "string" || typeof input.text !== "string") {
          throw new Error("project and text are required");
        }
        const name = typeof input.name === "string" ? input.name : undefined;
        coordinator.touch(context.session);
        return text(
          await coordinator.createTask(context.workspace, input.project, input.text, name),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });
  api.tools.register({
    name: "swarm_gate_run",
    description:
      "Run one quality gate (tests-green, test-first, coverage, crap, dry, mutation, structure, acceptance) for a role of an open swarm project and return the structured report.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Open project name." },
        role: { type: "string", description: "Pack role whose working directory is checked." },
        gate: { type: "string", description: "Gate name." },
        task: {
          type: "string",
          description: "Optional task name: gates that diff against the role's base commit use it.",
        },
      },
      required: ["project", "role", "gate"],
      additionalProperties: false,
    },
    effect: "process",
    async execute(input, context) {
      try {
        if (
          typeof input.project !== "string" ||
          typeof input.role !== "string" ||
          typeof input.gate !== "string"
        ) {
          throw new Error("project, role and gate are required");
        }
        coordinator.touch(context.session);
        return text(
          await coordinator.gateRun(context.workspace, {
            project: input.project,
            role: input.role,
            gate: input.gate,
            ...(typeof input.task === "string" ? { task: input.task } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });
  api.tools.register({
    name: "swarm_doctor",
    description:
      "Check that git, Node.js, toolchain commands and the workspace are ready for a swarm.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "process",
    async execute(_input, context) {
      try {
        return text(await coordinator.doctor(context.workspace));
      } catch (error) {
        return failure(error);
      }
    },
  });
  return coordinator;
}

/**
 * Fail-open fallbacks for hosts that offer them: a `ui.panel` tree (projects, roles, tasks) and
 * the `swarm-board` data view that returns the dashboard state. Absence or failure changes nothing.
 */
function registerFallbacks(api: PluginAPI, coordinator: SwarmCoordinator): void {
  try {
    api.ui?.panel?.("swarm", {
      title: "Swarm",
      nodes: ({ sessionId }) => {
        try {
          return panelNodes(coordinator.forgeFor(api.sessions.workspace(sessionId)));
        } catch {
          return [];
        }
      },
    });
  } catch {
    // The panel is optional: the dashboard and the commands carry the same information.
  }
  try {
    api.views?.register({
      id: "swarm-board",
      description: "Swarm board, attention items and work queue as JSON.",
      handler: async (_params, context) => coordinator.services.state(context.workspace),
    });
  } catch {
    // Views are optional.
  }
}

let active: SwarmCoordinator | undefined;

const plugin = definePlugin({
  id: "swarm",
  name: "Swarm",
  description:
    "Runs a handoff-driven pipeline of specialised agents, each in its own git worktree, with durable handoffs and human gates.",
  categories: ["methodology-harness"],
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI) {
    active = registerSwarm(api);
  },
  async dispose() {
    await active?.dispose();
    active = undefined;
  },
});

export default plugin;
