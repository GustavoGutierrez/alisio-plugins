import type { ArchitectureConfig, ArchitectureError } from "../../domain/architecture/config.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import type { ConfigDiagnostic } from "../../domain/config/validate.js";
import type { PackDef, RuleDef } from "../../domain/rules/model.js";
import type { PackDiagnostic } from "../../domain/rules/pack-validate.js";
import type { Waiver, WaiverError } from "../../domain/rules/waivers.js";

export interface ProjectConfigResult {
  /** Defaults applied; the defaults themselves when the file is absent or invalid. */
  config: FrontsmithConfig;
  present: boolean;
  diagnostics: ConfigDiagnostic[];
}

export interface RuleCandidate {
  id: string;
  feature: string;
  rule: RuleDef;
}

/** Access to the versioned, human-owned `.frontsmith/` directory of a workspace. */
export interface ProjectStore {
  readConfig(root: string): Promise<ProjectConfigResult>;
  readArchitecture(
    root: string,
  ): Promise<{ config?: ArchitectureConfig; present: boolean; errors: ArchitectureError[] }>;
  readWaivers(root: string): Promise<{ waivers: Waiver[]; errors: WaiverError[] }>;
  readCandidates(root: string): Promise<RuleCandidate[]>;
  /** Fixture text of a workspace pack, relative to the pack directory. */
  readPackFixture(root: string, packId: string, relative: string): Promise<string | undefined>;
  readLocalPack(root: string): Promise<PackDef | undefined>;
  writeLocalPack(root: string, pack: PackDef): Promise<void>;
}

export interface PackStore {
  shipped(): Promise<PackDef[]>;
  workspace(root: string): Promise<{ packs: PackDef[]; diagnostics: PackDiagnostic[] }>;
}
