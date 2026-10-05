import type { UiBlock } from "@alisio/sdk";
import type { AttentionItem } from "./domain/attention.js";
import { type Pack, roleIds } from "./domain/pack.js";
import type { Board } from "./domain/task.js";

export interface ProjectSnapshot {
  name: string;
  open: boolean;
  running: boolean;
  pack: Pack | undefined;
  board: Board | undefined;
  attention: AttentionItem[];
}

export interface RenderedStatus {
  text: string;
  blocks: UiBlock[];
}

/** Role ids are validated identifiers, so they are safe inside a diagram; task text never is. */
const diagram = (pack: Pack): UiBlock => ({
  kind: "mermaid",
  source: `flowchart LR\n  ${[...roleIds(pack), "done"].join(" --> ")}`,
  title: pack.name,
});

export function renderStatus(projects: ProjectSnapshot[]): RenderedStatus {
  if (projects.length === 0) {
    return {
      text: "No projects yet. Create one with /swarm:project new <name> -- <mission>.",
      blocks: [],
    };
  }
  const lines: string[] = [];
  const blocks: UiBlock[] = [];
  for (const project of projects) {
    const state = project.running ? "running" : project.open ? "open, not running" : "closed";
    lines.push(`${project.name} (${project.pack?.name ?? "unknown pack"}, ${state})`);
    const tasks = project.board?.tasks ?? [];
    if (project.pack) {
      const counts = roleIds(project.pack).map((role) => {
        const here = tasks.filter((task) => task.lane === role && task.status !== "done");
        return `${role}: ${here.length}`;
      });
      lines.push(
        `  ${counts.join(" | ")} | done: ${tasks.filter((t) => t.status === "done").length}`,
      );
    }
    for (const task of tasks) {
      lines.push(`  - ${task.name} [${task.lane}] ${task.status} (audits ${task.auditCount})`);
    }
    if (project.attention.length > 0) {
      lines.push("  Needs your attention:");
      for (const item of project.attention) {
        lines.push(`  - ${item.kind}: ${item.task} (${item.actions.join(", ")})`);
        if (item.detail) lines.push(`    ${item.detail.split("\n")[0]}`);
      }
    }
    if (tasks.length > 0) {
      blocks.push({
        kind: "table",
        caption: project.name,
        columns: ["Task", "Lane", "Status", "Audits"],
        rows: tasks.map((task) => [task.name, task.lane, task.status, String(task.auditCount)]),
      });
    }
    if (project.attention.length > 0) {
      blocks.push({
        kind: "table",
        caption: `${project.name}: needs your attention`,
        columns: ["Kind", "Task", "Actions"],
        rows: project.attention.map((item) => [item.kind, item.task, item.actions.join(", ")]),
      });
    }
    if (project.pack) blocks.push(diagram(project.pack));
  }
  return { text: lines.join("\n"), blocks };
}
