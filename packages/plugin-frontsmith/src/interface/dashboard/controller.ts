import type { PluginAPI } from "@alisio/sdk";
import type { FrontsmithServices } from "../../application/services.js";
import { isFeatureId } from "../../domain/ids.js";
import { workspaceOf } from "../plugin/commands.js";
import { code } from "../presenters/markdown.js";
import { type DashboardHandle, startDashboard } from "./server.js";

const USAGE = `Usage: ${code("/frontsmith:dashboard [feature]")}`;

/**
 * One dashboard per workspace, started on demand by `/frontsmith:dashboard` and stopped on
 * `dispose` (spec 18.4). Nothing else depends on it: a start failure returns the error and the
 * Markdown commands keep working.
 */
export class DashboardController {
  private readonly running = new Map<string, DashboardHandle>();

  constructor(private readonly services: FrontsmithServices) {}

  async open(workspace: string, args: string): Promise<string> {
    const feature = args.trim();
    if (feature !== "" && !isFeatureId(feature)) return USAGE;
    const config = await this.services.deps.project.readConfig(workspace);
    if (!config.config.dashboard.enabled)
      return `The dashboard is disabled in ${code(".frontsmith/config.json")} (${code("dashboard.enabled")}). Use ${code("/frontsmith:status")} instead.`;
    const hash = feature === "" ? "" : `#${feature}`;
    const existing = this.running.get(workspace);
    if (existing) return this.describe(`${existing.url}${hash}`, true);
    let handle: DashboardHandle;
    try {
      handle = await startDashboard({
        services: this.services,
        workspace,
        onClosed: () => this.running.delete(workspace),
      });
    } catch (error) {
      return `The dashboard could not start: ${error instanceof Error ? error.message : String(error)}. Use ${code("/frontsmith:status")} for the same information as text.`;
    }
    this.running.set(workspace, handle);
    return this.describe(`${handle.url}${hash}`, false);
  }

  private describe(url: string, already: boolean): string {
    return [
      already ? `The dashboard is already running: ${url}` : `Frontsmith dashboard: ${url}`,
      "Open the link in a browser on this machine. It is only reachable from the machine running Alisio; on a remote web client use the Dock previews and the tool images instead.",
      "The link carries a private token that only works with this run: do not share it. It stops when the host exits.",
    ].join("\n\n");
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.running.values()].map((handle) => handle.close()));
    this.running.clear();
  }
}

export function registerDashboard(api: PluginAPI, controller: DashboardController): void {
  api.commands.register(
    "dashboard",
    (args, context) => controller.open(workspaceOf(api, context), args),
    {
      description: "Open the local review dashboard (fidelity diffs, gate board, approvals)",
      argumentHint: "[feature]",
    },
  );
}
