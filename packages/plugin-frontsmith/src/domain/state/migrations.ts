import { type FeatureState, validateFeatureState } from "./feature-state.js";

export const CURRENT_STATE_SCHEMA = 1;

/** Raised when a document was written by a newer Frontsmith than this one. */
export class NewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`State written by a newer Frontsmith (schemaVersion ${version}); upgrade the plugin`);
    this.name = "NewerSchemaError";
  }
}

const versionOf = (raw: unknown): number | undefined =>
  typeof raw === "object" &&
  raw !== null &&
  Number.isInteger((raw as { schemaVersion?: unknown }).schemaVersion)
    ? (raw as { schemaVersion: number }).schemaVersion
    : undefined;

/** Chain keyed by `schemaVersion`; version 1 is the identity after validation. */
export function migrate(raw: unknown): FeatureState {
  const version = versionOf(raw);
  if (version === undefined || version < 1) throw new Error("State has no valid schemaVersion");
  if (version > CURRENT_STATE_SCHEMA) throw new NewerSchemaError(version);
  const result = validateFeatureState(raw);
  if (!result.ok)
    throw new Error(
      `Invalid state: ${result.errors.map((e) => `${e.pointer} ${e.message}`).join("; ")}`,
    );
  return result.state;
}

export interface OpenedState {
  state: FeatureState | undefined;
  version: number | undefined;
  /** True for a newer schema: status works, every mutating command must refuse. */
  readOnly: boolean;
}

/** Open a document for reading; a newer schema yields a best-effort read-only view. */
export function openState(raw: unknown): OpenedState {
  const version = versionOf(raw);
  if (version !== undefined && version > CURRENT_STATE_SCHEMA) {
    const record = raw as Partial<FeatureState>;
    return {
      state: typeof record.feature === "string" ? (raw as FeatureState) : undefined,
      version,
      readOnly: true,
    };
  }
  return { state: migrate(raw), version, readOnly: false };
}
