import type { PluginAPI } from "@alisio/sdk";
import type { FrontsmithServices } from "../../application/services.js";
import type { FeatureState } from "../../domain/state/feature-state.js";
import { StatusPresenter } from "../presenters/status.js";

/** Tasks finished out of all tasks; a feature without tasks counts as one unit. */
export function taskProgress(state: FeatureState): { done: number; total: number } {
  const done = state.tasks.filter((task) => task.status === "done").length;
  return { done, total: Math.max(1, state.tasks.length) };
}

/**
 * Keeps the `phase` and `job` footer lines (TUI only, spec 18.1) in step with the running unit and
 * clears them when nothing runs. It listens to the job manager, so every surface that starts a unit
 * shares the same lines.
 */
export class StatusWiring {
  private readonly presenter: StatusPresenter;
  private readonly jobs = new Map<string, string>();

  constructor(
    api: PluginAPI,
    private readonly services: FrontsmithServices,
  ) {
    this.presenter = new StatusPresenter((key, text) => api.ui.status(key, text));
  }

  attach(): () => void {
    return this.services.deps.jobs.subscribe((event) => {
      if (event.type === "started") {
        if (event.id) this.jobs.set(event.feature, event.id);
        void this.refresh(event.root, event.feature);
        return;
      }
      this.jobs.delete(event.feature);
      if (this.services.deps.jobs.runningCount() === 0 && this.jobs.size === 0)
        this.presenter.idle();
    });
  }

  /** Re-read the feature and write both lines; called when a unit starts and on each progress line. */
  async refresh(root: string, feature: string): Promise<void> {
    try {
      const { state } = await this.services.workflow.status(root, feature);
      const running = state.tasks.find((task) => task.status === "running");
      this.presenter.phase(feature, state.phase, running?.id ?? "-");
      const id = this.jobs.get(feature);
      if (id) {
        const { done, total } = taskProgress(state);
        this.presenter.job(id, done, total);
      }
    } catch {
      // The footer is decoration.
    }
  }
}
