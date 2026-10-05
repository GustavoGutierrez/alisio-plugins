import type { PluginAPI, ToolResult, UiBlock } from "@alisio/sdk";
import { ChildSessionRunner } from "./adapters/child-session-runner.js";
import { GitWorktreeIsolation } from "./adapters/git-worktree.js";
import { ProcessGateRunner } from "./adapters/process-gate-runner.js";
import { DEFAULT_PACK, type Forge } from "./app/forge.js";
import { type RejectAction, rejectActions } from "./app/operator.js";
import { SwarmServices, TEARDOWN_CONFIRMATION } from "./app/services.js";
import { parseFlags, splitDoubleDash } from "./args.js";
import { openInBrowser } from "./dashboard/open.js";
import { type DashboardHandle, startDashboard } from "./dashboard/server.js";
import { type DoctorDeps, defaultDoctorDeps, formatDoctor, runDoctor } from "./doctor.js";
import { validateProjectName } from "./domain/identifiers.js";
import { type Pack, roleIds } from "./domain/pack.js";
import { parseOptions } from "./options.js";
import type { AgentRunner } from "./ports/agent-runner.js";
import type { Clock } from "./ports/clock.js";
import type { GateReport, GateRunner } from "./ports/gate-runner.js";
import type { Isolation } from "./ports/isolation.js";
import type { Notifier } from "./ports/notifier.js";
import { parseTaskRef, type TaskRef } from "./refs.js";
import { loadToolchain } from "./resources.js";
import { renderStatus } from "./status.js";

/** Test seams. Production passes none: child sessions, git worktrees and process gates are the defaults. */
export interface CoordinatorOptions {
  runner?: AgentRunner;
  isolation?: Isolation;
  clock?: Clock;
  notifier?: Notifier;
  autoStart?: boolean;
  cloneUrl?: (repo: string) => string;
  doctor?: Partial<Pick<DoctorDeps, "nodeVersion" | "exec" | "writable">>;
  /** A gate runner, or `null` to run packs ungated (tests). Default: the node-ts process runner. */
  gates?: GateRunner | null;
  /** Opens the dashboard URL in a browser (best effort). Default: the platform opener. */
  openBrowser?: (url: string) => void | Promise<void>;
}

const usage = {
  pack: "Usage: /swarm:pack list | show <name>",
  project:
    "Usage: /swarm:project new <name> [--pack <pack>] [--github <owner/repo>] -- <mission> | open <name> | close <name> | list",
  task: "Usage: /swarm:task <project> new [name] -- <task text> | delete <name> | retry <name> | accept <name>",
  approve: "Usage: /swarm:approve <project>/<task>",
  reject: "Usage: /swarm:reject <project>/<task> retry|delete|accept [-- comments]",
  answer: "Usage: /swarm:answer <project>/<task> -- <answer text>",
  comment:
    "Usage: /swarm:comment <project>/<task> <document> -- <comment text> | <project>/<task> clear",
  chat: "Usage: /swarm:chat [project] -- <message>",
  stop: "Usage: /swarm:stop <project>",
  run: "Usage: /swarm:run <project> [--seconds <1-3600>]",
  budget: "Usage: /swarm:budget | /swarm:budget raise <tokens>",
  dashboard: "Usage: /swarm:dashboard [project | project/task]",
  teardown: `Usage: /swarm:teardown --confirm ${TEARDOWN_CONFIRMATION}`,
};

const describePack = (pack: Pack): string =>
  [
    `${pack.name}: ${pack.description}`,
    `Toolchain: ${pack.toolchain}`,
    `Pipeline: ${roleIds(pack).join(" → ")}`,
    ...pack.roles.map(
      (role) => `  - ${role.id} (${role.isolation}, receive ${role.receive}, ${role.propagation})`,
    ),
    pack.approval ? `Approval gate after: ${pack.approval.after}` : "Approval gate: none",
    `Thresholds: coverage >= ${pack.thresholds.coverage}%, complexity <= ${pack.thresholds.complexity}, CRAP <= ${pack.thresholds.crap}, mutation >= ${pack.thresholds.mutation}%`,
    ...Object.entries(pack.gates).map(([role, gates]) => `Gates for ${role}: ${gates.join(", ")}`),
  ].join("\n");

/**
 * The command front end. It parses arguments and renders text; every decision goes through
 * `services`, the same facade the dashboard calls (AD-10).
 */
export class SwarmCoordinator {
  readonly services: SwarmServices;
  private readonly options;
  private parent: string | undefined;
  private readonly dashboards = new Map<string, DashboardHandle>();

  constructor(
    private readonly api: PluginAPI,
    private readonly seams: CoordinatorOptions = {},
  ) {
    this.options = parseOptions(api.options);
    const gates =
      seams.gates === null ? undefined : (seams.gates ?? new ProcessGateRunner({ loadToolchain }));
    this.services = new SwarmServices({
      isolation: seams.isolation ?? new GitWorktreeIsolation(),
      runner: seams.runner ?? this.childRunner(),
      maxConcurrent: this.options.maxConcurrent,
      ...(this.options.tokenBudget !== undefined ? { tokenBudget: this.options.tokenBudget } : {}),
      ...(gates ? { gates } : {}),
      ...(seams.clock ? { clock: seams.clock } : {}),
      ...(seams.notifier ? { notifier: seams.notifier } : {}),
      ...(seams.autoStart !== undefined ? { autoStart: seams.autoStart } : {}),
      ...(seams.cloneUrl ? { cloneUrl: seams.cloneUrl } : {}),
      ui: {
        interactive: () => this.api.ui?.interactive?.() === true,
        askQuestions: (request) => this.api.ui.askQuestions(request),
      },
    });
  }

  /**
   * Child sessions hang from the session that last issued a swarm command. `api.sessions` is read
   * lazily: nothing touches it during `setup()` (it is only usable after startup).
   */
  private childRunner(): AgentRunner {
    const api = this.api;
    return new ChildSessionRunner({
      sessions: {
        create: (spec) => api.sessions.create(spec),
        run: (id, prompt, options) => api.sessions.run(id, prompt, options),
        cancel: (id) => api.sessions.cancel(id),
      },
      parentSession: () => this.parent,
      roleOptions: () => this.options.roles,
    });
  }

  forgeFor(workspace: string): Forge {
    return this.services.forgeFor(workspace);
  }

  /** Remember the session that issued a command or tool call: it parents the child sessions. */
  touch(sessionId: string | undefined): void {
    if (sessionId) this.parent = sessionId;
  }

  workspaceOf(sessionId: string | undefined): string {
    if (!sessionId) throw new Error("No session is available to resolve the workspace");
    this.touch(sessionId);
    return this.api.sessions.workspace(sessionId);
  }

  async init(workspace: string): Promise<string> {
    const { created } = await this.forgeFor(workspace).init();
    return created
      ? "Swarm forge initialised under .alisio/swarm. Run /swarm:doctor to check your tools, then /swarm:project new <name> -- <mission>."
      : "The swarm forge is already initialised.";
  }

  async doctor(workspace: string): Promise<string> {
    const forge = this.forgeFor(workspace);
    const report = await runDoctor({
      nodeVersion: this.seams.doctor?.nodeVersion ?? process.versions.node,
      workspace,
      toolchain: await loadToolchain("node-ts"),
      initialised: await forge.isInitialised(),
      exec: this.seams.doctor?.exec ?? defaultDoctorDeps.exec,
      writable: this.seams.doctor?.writable ?? defaultDoctorDeps.writable,
    });
    return formatDoctor(report);
  }

  async pack(workspace: string, args: string): Promise<string> {
    const forge = this.forgeFor(workspace);
    const { head } = splitDoubleDash(args);
    const [action, name] = head;
    if (action === "list" && head.length === 1) {
      const packs = await forge.listPacks();
      const invalid = await forge.invalidPacks();
      return [
        ...packs.map((p) => `${p.name} (${p.source}): ${p.roles.join(" → ")} — ${p.description}`),
        ...invalid.map((p) => `Ignored invalid pack ${p.file}: ${p.error}`),
      ].join("\n");
    }
    if (action === "show" && name && head.length === 2)
      return describePack(await forge.loadPack(name));
    throw new Error(usage.pack);
  }

  async project(workspace: string, args: string): Promise<string> {
    const forge = this.forgeFor(workspace);
    const { head, tail } = splitDoubleDash(args);
    const [action, ...rest] = head;
    if (action === "list" && rest.length === 0) {
      const projects = await forge.listProjects();
      if (projects.length === 0) return "No projects yet.";
      return projects
        .map(
          (p) =>
            `${p.name} — ${p.pack} — ${p.running ? "running" : p.open ? "open (not running)" : "closed"}`,
        )
        .join("\n");
    }
    if (action === "new") {
      const { positional, flags } = parseFlags(rest, ["pack", "github"]);
      if (positional.length !== 1) throw new Error(usage.project);
      if (!tail) throw new Error("A project needs a mission: add `-- <mission>`");
      const runtime = await forge.newProject({
        name: positional[0] as string,
        pack: flags.pack ?? DEFAULT_PACK,
        mission: tail,
        ...(flags.github ? { github: flags.github } : {}),
      });
      return [
        `Project ${runtime.name} created and open (${runtime.pack.name}: ${roleIds(runtime.pack).join(" → ")}).`,
        `Create a task with /swarm:task ${runtime.name} new -- <task text>.`,
      ].join("\n");
    }
    if ((action === "open" || action === "close") && rest.length === 1) {
      const name = rest[0] as string;
      if (action === "open") {
        const runtime = await this.services.openProject(workspace, name);
        return `Project ${name} is open (${runtime.pack.name}).`;
      }
      await this.services.closeProject(workspace, name);
      return `Project ${name} closed. Project files were left untouched.`;
    }
    throw new Error(usage.project);
  }

  async createTask(
    workspace: string,
    project: string,
    text: string,
    name?: string,
  ): Promise<string> {
    const card = await this.services.createTask(workspace, project, text, name);
    return `Task ${card.name} queued for ${card.lane} in ${project}.`;
  }

  async task(workspace: string, args: string): Promise<string> {
    const { head, tail } = splitDoubleDash(args);
    const [project, action, name] = head;
    if (!project || !action) throw new Error(usage.task);
    if (action === "new" && head.length <= 3)
      return this.createTask(workspace, project, tail, name);
    if (
      (action === "delete" || action === "retry" || action === "accept") &&
      name &&
      head.length === 3
    ) {
      validateProjectName(project);
      if (action === "delete") {
        await this.services.deleteTask(workspace, project, name);
        return `Task ${name} deleted and archived; its card, handoffs and state are gone.`;
      }
      if (action === "retry") {
        await this.services.retryTask(workspace, project, name);
        return `Task ${name} queued for retry with a fresh allowance.`;
      }
      await this.services.acceptTask(workspace, project, name);
      return `Task ${name} accepted as it is.`;
    }
    throw new Error(usage.task);
  }

  // ---- decisions: the same services the dashboard calls ----

  private ref(head: string[], message: string): TaskRef {
    if (head.length === 0) throw new Error(message);
    return parseTaskRef(head[0]);
  }

  async approve(workspace: string, args: string): Promise<string> {
    const { head } = splitDoubleDash(args);
    let ref: TaskRef;
    if (head.length === 0) {
      const waiting = (await this.services.attention(workspace)).filter(
        (i) => i.kind === "approval",
      );
      const listing = waiting.map((i) => `${i.project}/${i.task}`);
      if (waiting.length === 0) throw new Error("No approval is waiting");
      // Approving is a decision: without an explicit reference only an interactive choice may make it.
      const answer =
        waiting.length <= 4
          ? await this.services.ask({
              questions: [
                {
                  id: "task",
                  header: "Approve",
                  question: "Which task do you approve?",
                  options: [
                    ...listing.map((value) => ({ value, label: value })),
                    ...(listing.length === 1
                      ? [{ value: "cancel", label: "Cancel", description: "Approve nothing" }]
                      : []),
                  ],
                },
              ],
            })
          : undefined;
      const picked = answer?.task;
      if (typeof picked !== "string" || picked === "cancel") {
        throw new Error(`${usage.approve}\nWaiting: ${listing.join(", ")}`);
      }
      ref = parseTaskRef(picked);
    } else {
      ref = this.ref(head, usage.approve);
      if (head.length > 1) throw new Error(usage.approve);
    }
    await this.services.approve(workspace, ref.project, ref.task);
    const card = (await this.services.runtimeOf(workspace, ref.project)).cardByName(ref.task);
    return `Task ${ref.task} approved; it continues in ${card.lane}.`;
  }

  async reject(workspace: string, args: string): Promise<string> {
    const { head, tail } = splitDoubleDash(args);
    const ref = this.ref(head, usage.reject);
    let action = head[1];
    if (head.length > 2) throw new Error(usage.reject);
    if (action === undefined) {
      const answer = await this.services.ask({
        questions: [
          {
            id: "action",
            header: "Reject",
            question: `What should happen to ${ref.project}/${ref.task}?`,
            options: [
              {
                value: "retry",
                label: "Retry",
                description: "Restore the base and re-run with your comments",
              },
              { value: "delete", label: "Delete", description: "Archive the task and remove it" },
              {
                value: "accept",
                label: "Accept unchanged",
                description: "Release the work as it is",
              },
            ],
          },
        ],
      });
      action = typeof answer?.action === "string" ? answer.action : undefined;
    }
    if (!action || !(rejectActions as readonly string[]).includes(action))
      throw new Error(usage.reject);
    await this.services.reject(workspace, ref.project, ref.task, action as RejectAction, tail);
    return {
      retry: `Task ${ref.task} rejected: retry queued; the rejected work is kept under refs/swarm/rejected/${ref.task}.`,
      delete: `Task ${ref.task} rejected and deleted; it was archived.`,
      accept: `Task ${ref.task} accepted unchanged and released.`,
    }[action as RejectAction];
  }

  async answer(workspace: string, args: string): Promise<string> {
    const { head, tail } = splitDoubleDash(args);
    const ref = this.ref(head, usage.answer);
    if (head.length > 1 || !tail) throw new Error(usage.answer);
    await this.services.answer(workspace, ref.project, ref.task, tail);
    return `Your answer was delivered to ${ref.task}; the role continues.`;
  }

  async comment(workspace: string, args: string): Promise<string> {
    const { head, tail } = splitDoubleDash(args);
    const ref = this.ref(head, usage.comment);
    if (head.length === 2 && head[1] === "clear" && !tail) {
      await this.services.clearComments(workspace, ref.project, ref.task);
      return `Comments on ${ref.task} cleared.`;
    }
    if (head.length !== 2 || !tail) throw new Error(usage.comment);
    await this.services.addComment(workspace, ref.project, ref.task, head[1] as string, tail);
    return `Comment on ${head[1]} recorded; approving is disabled until the comments are cleared or the task is rejected.`;
  }

  async chat(workspace: string, args: string): Promise<string> {
    const { head, tail } = splitDoubleDash(args);
    if (!tail || head.length > 1) throw new Error(usage.chat);
    let project = head[0];
    if (project === undefined) {
      const open = await this.services.openProjects(workspace);
      if (open.length !== 1) {
        throw new Error(
          `Name the project: /swarm:chat <project> -- <message>${open.length > 0 ? ` (open: ${open.join(", ")})` : ""}`,
        );
      }
      project = open[0] as string;
    }
    return this.services.chat(workspace, project, tail);
  }

  async stop(workspace: string, args: string): Promise<string> {
    const { head } = splitDoubleDash(args);
    if (head.length !== 1) throw new Error(usage.stop);
    const project = validateProjectName(head[0] as string);
    await this.services.stopProject(workspace, project);
    return `Project ${project} stopped: agents cancelled and the pump halted. Run /swarm:project open ${project} to start it again.`;
  }

  async run(workspace: string, args: string): Promise<string> {
    const { head } = splitDoubleDash(args);
    const { positional, flags } = parseFlags(head, ["seconds"]);
    if (positional.length !== 1) throw new Error(usage.run);
    const seconds = flags.seconds === undefined ? 60 : Number(flags.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new Error("The --seconds value must be an integer from 1 to 3600");
    }
    const project = validateProjectName(positional[0] as string);
    const { finished } = await this.services.runProject(workspace, project, seconds);
    const board = (await this.services.runtimeOf(workspace, project)).board();
    const counts = new Map<string, number>();
    for (const card of board.tasks) counts.set(card.status, (counts.get(card.status) ?? 0) + 1);
    const summary =
      [...counts].map(([status, count]) => `${status}: ${count}`).join(", ") || "no tasks";
    return finished
      ? `${project} is idle. ${summary}.`
      : `Stopped waiting after ${seconds} seconds; work continues in the background. ${summary}.`;
  }

  async budget(workspace: string, args: string): Promise<string> {
    const { head } = splitDoubleDash(args);
    const status = this.services.budget(workspace);
    if (head.length === 0) {
      if (status.limit === undefined)
        return `No token budget is configured. ${status.total} tokens used.`;
      return `Token budget: ${status.total} of ${status.limit} tokens used${status.exceeded ? " (reached: no new agent runs start until you raise it)" : ""}.`;
    }
    if (head[0] !== "raise" || head.length !== 2) throw new Error(usage.budget);
    const extra = Number(head[1]);
    if (!Number.isInteger(extra) || extra <= 0)
      throw new Error(`${usage.budget} (a positive whole number)`);
    if (status.limit === undefined) {
      throw new Error(
        "No token budget is configured; set pluginOverrides.swarm.options.tokenBudget first",
      );
    }
    const raised = await this.services.raiseBudget(workspace, extra);
    return `Token budget raised to ${raised.limit}; ${raised.total} used.`;
  }

  async teardown(_workspace: string, args: string): Promise<string> {
    const { head } = splitDoubleDash(args);
    const { positional, flags } = parseFlags(head, ["confirm"]);
    if (positional.length > 0) throw new Error(usage.teardown);
    let confirm = flags.confirm;
    if (confirm === undefined) {
      const answer = await this.services.ask({
        questions: [
          {
            id: "confirm",
            header: "Teardown",
            question:
              "Cancel every agent, stop every project and the dashboard? Project files stay.",
            options: [
              { value: TEARDOWN_CONFIRMATION, label: "Teardown", description: "Stop everything" },
              { value: "cancel", label: "Cancel", description: "Keep the swarm running" },
            ],
          },
        ],
      });
      if (answer?.confirm === "cancel") return "Teardown cancelled; nothing was stopped.";
      confirm = typeof answer?.confirm === "string" ? answer.confirm : undefined;
    }
    await this.services.teardown(confirm);
    return "Teardown complete: agents cancelled, projects stopped, pidfile removed. Project files were left untouched.";
  }

  /**
   * Start the local dashboard (once per workspace) and return its link. The link carries the
   * per-run token; the browser exchanges it for a cookie. Opening a browser is best effort.
   */
  async dashboard(workspace: string, args: string): Promise<string> {
    const target = args.trim();
    let hash = "";
    if (target) {
      if (/[/:]/.test(target)) {
        const ref = parseTaskRef(target);
        hash = `#${ref.project}/${ref.task}`;
      } else {
        hash = `#${validateProjectName(target)}`;
      }
    }
    const running = this.dashboards.get(workspace);
    if (running) {
      return `The swarm dashboard is already running: ${running.url}${hash}`;
    }
    const handle = await startDashboard({
      services: this.services,
      workspace,
      onClosed: () => this.dashboards.delete(workspace),
    });
    this.dashboards.set(workspace, handle);
    let opened = true;
    try {
      await (this.seams.openBrowser ?? openInBrowser)(`${handle.url}${hash}`);
    } catch {
      opened = false;
    }
    return [
      `Swarm dashboard: ${handle.url}${hash}`,
      opened
        ? "It was opened in your browser."
        : "Open the link in your browser (it could not be opened automatically).",
      "The link carries a private token that only works with this run: do not share it. It stops on /swarm:teardown or when the host exits.",
    ].join("\n");
  }

  /** The text of a gate report for the `swarm_gate_run` tool. */
  formatGate(report: GateReport): string {
    const state = report.passed ? "passed" : "failed";
    const lines = [`${report.gate}: ${state}`];
    if (report.skipped) lines.push(`Skipped: ${report.skipped}`);
    if (report.error) lines.push(`Could not run: ${report.error}`);
    if (report.timedOut) lines.push("The gate timed out.");
    for (const finding of report.findings) lines.push(`- ${finding}`);
    return lines.join("\n");
  }

  async gateRun(
    workspace: string,
    input: { project: string; role: string; gate: string; task?: string },
  ): Promise<string> {
    return this.formatGate(await this.services.gateRun(workspace, input));
  }

  async status(workspace: string, args: string) {
    const project = args.trim() || undefined;
    if (project !== undefined) validateProjectName(project);
    return renderStatus(await this.forgeFor(workspace).snapshot(project));
  }

  async statusText(workspace: string, args: string): Promise<string> {
    return (await this.status(workspace, args)).text;
  }

  async statusTool(workspace: string, project?: string): Promise<ToolResult> {
    const { text, blocks } = await this.status(workspace, project ?? "");
    return {
      content: [
        { type: "text", text },
        ...blocks.map((block: UiBlock) => ({ type: "ui" as const, block })),
      ],
    };
  }

  /** Stop everything: dispose is capped by the host, so this only cancels, halts and cleans up. */
  async dispose(): Promise<void> {
    await this.services.shutdown();
  }
}
