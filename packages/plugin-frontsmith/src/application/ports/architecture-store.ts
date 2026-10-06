import type { ArchitectureConfig } from "../../domain/architecture/config.js";
import type { PresetId } from "../../domain/architecture/presets.js";

/** Shipped architecture presets, and the one write `/frontsmith:arch init` performs. */
export interface ArchitectureStore {
  preset(id: PresetId): Promise<ArchitectureConfig>;
  /** Write `.frontsmith/architecture.json`; refuses to replace an existing file. */
  create(root: string, config: ArchitectureConfig): Promise<{ created: boolean }>;
}
