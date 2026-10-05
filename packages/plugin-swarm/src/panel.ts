import type { PanelNode } from "@alisio/sdk";
import type { Forge } from "./app/forge.js";
import type { ProjectRuntime } from "./app/project.js";
import { roleIds } from "./domain/pack.js";
import type { TaskStatus } from "./domain/task.js";

const COLORS: Record<TaskStatus, string> = {
  queued: "gray",
  working: "blue",
  waiting_approval: "yellow",
  rejected: "red",
  merging: "cyan",
  clarifying: "yellow",
  blocked: "red",
  done: "green",
};

const projectNodes = (runtime: ProjectRuntime): PanelNode[] => {
  const projectId = `project:${runtime.name}`;
  const nodes: PanelNode[] = [
    {
      id: projectId,
      label: runtime.name,
      color: "green",
      status: "running",
      detail: `${runtime.pack.name}: ${roleIds(runtime.pack).join(" > ")}`,
    },
  ];
  const active = runtime.activeRoles();
  const tasks = runtime.board().tasks;
  for (const role of roleIds(runtime.pack)) {
    const roleId = `${projectId}:role:${role}`;
    const live = active.has(role);
    nodes.push({
      id: roleId,
      parentId: projectId,
      label: role,
      color: live ? "green" : "gray",
      status: live ? "live" : "idle",
    });
    for (const card of tasks.filter(
      (candidate) => candidate.lane === role && candidate.status !== "done",
    )) {
      nodes.push({
        id: `${projectId}:task:${card.name}`,
        parentId: roleId,
        label: card.name,
        color: COLORS[card.status],
        status: card.status,
        detail: `audits ${card.auditCount}`,
      });
    }
  }
  return nodes;
};

/** The `ui.panel` tree (projects, roles, tasks) of the running projects. Synchronous by contract. */
export function panelNodes(forge: Forge): PanelNode[] {
  return forge.runningRuntimes().flatMap(projectNodes);
}
