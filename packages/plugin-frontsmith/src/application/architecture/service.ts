import type { ArchitectureConfig, ArchitectureError } from "../../domain/architecture/config.js";
import { type PresetId, recommendPreset } from "../../domain/architecture/presets.js";
import {
  type ArchitectureCheckResult,
  runArchitectureCheck,
} from "../checks/architecture-check.js";
import type { ArchitectureStore } from "../ports/architecture-store.js";
import type { FileAnalyzer } from "../ports/file-analyzer.js";
import type { ImportGraphBuilder } from "../ports/import-graph-builder.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface ArchitectureServiceDeps {
  fsFor(root: string): WorkspaceFs;
  project: ProjectStore;
  store: ArchitectureStore;
  analyzer: FileAnalyzer;
  graphBuilder: ImportGraphBuilder;
}

export type ArchitectureOutcome =
  | { state: "missing" }
  | { state: "invalid"; errors: ArchitectureError[] }
  | { state: "ok"; config: ArchitectureConfig; result: ArchitectureCheckResult };

/** One facade for architecture: check the workspace, recommend and write a preset (AD-12). */
export class ArchitectureService {
  constructor(private readonly deps: ArchitectureServiceDeps) {}

  async check(root: string, options: { paths?: string[] } = {}): Promise<ArchitectureOutcome> {
    const loaded = await this.deps.project.readArchitecture(root);
    if (!loaded.present) return { state: "missing" };
    if (!loaded.config) return { state: "invalid", errors: loaded.errors };
    const result = await runArchitectureCheck(
      {
        fs: this.deps.fsFor(root),
        config: loaded.config,
        ...(options.paths && options.paths.length > 0 ? { paths: options.paths } : {}),
      },
      { analyzer: this.deps.analyzer, graphBuilder: this.deps.graphBuilder },
    );
    return { state: "ok", config: loaded.config, result };
  }

  async recommend(root: string): Promise<PresetId> {
    const { files } = await this.deps.fsFor(root).listFiles();
    return recommendPreset(files);
  }

  /** Activate a validated configuration proposed by a plan (spec 7.2 G3); an existing file is never replaced. */
  async activate(root: string, config: ArchitectureConfig): Promise<{ created: boolean }> {
    return this.deps.store.create(root, config);
  }

  /** Write a preset as `.frontsmith/architecture.json`; an existing file is never replaced. */
  async init(
    root: string,
    preset: PresetId,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const existing = await this.deps.project.readArchitecture(root);
    const path = ".frontsmith/architecture.json";
    if (existing.present)
      return {
        ok: false,
        reason: `${path} already exists; it is human-owned, so edit it by hand or delete it first.`,
      };
    const config = await this.deps.store.preset(preset);
    const { created } = await this.deps.store.create(root, config);
    return created
      ? { ok: true, path }
      : { ok: false, reason: `${path} already exists; it is human-owned.` };
  }
}
