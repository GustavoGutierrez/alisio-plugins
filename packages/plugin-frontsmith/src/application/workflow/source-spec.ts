import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import {
  checkSourceJson,
  checkSourceLevel,
  checkSourcePath,
  decodeSource,
  deriveIntent,
  SOURCE_MAX_BYTES,
  type SourceFormat,
  type SourceProblem,
} from "../../domain/spec-source.js";
import type { SourceReader } from "../ports/source-reader.js";

export interface SourceDeps {
  sources: SourceReader;
  sha256(text: string): string;
}

/** A validated source specification, ready to be copied into the feature (spec 8.1, AD-17). */
export interface PreparedSource {
  path: string;
  format: SourceFormat;
  /** Normalized text (no BOM, LF): this is what is copied, hashed and used. */
  text: string;
  sha256: string;
  bytes: number;
  /** The envelope of a valid `.json` source. */
  spec?: SpecEnvelope;
  /** The intent to use when none was given. */
  intent: string;
}

export const snapshotName = (format: SourceFormat): string =>
  format === "markdown" ? "source-spec.md" : "source-spec.json";

/** The preflight of spec 19: path, location, type, kind, size, encoding, JSON and level. */
export async function prepareSource(
  deps: SourceDeps,
  root: string,
  rawPath: string,
  level?: string,
): Promise<{ ok: true; source: PreparedSource } | SourceProblem> {
  const located = checkSourcePath(rawPath);
  if (!located.ok) return located;
  if (level !== undefined) {
    const refused = checkSourceLevel(level);
    if (refused) return refused;
  }
  const read = await deps.sources.read(root, located.path, SOURCE_MAX_BYTES);
  const fail = (code: SourceProblem["code"], message: string): SourceProblem => ({
    ok: false,
    code,
    message: `${code}: ${message}`,
  });
  switch (read.kind) {
    case "escape":
      return fail("SRC-001", `the spec path leaves the workspace (${read.message})`);
    case "missing":
      return fail("SRC-004", `${located.path} does not exist`);
    case "not-file":
      return fail("SRC-004", `${located.path} is not a regular file`);
    case "too-large":
      return fail("SRC-005", `${located.path} is larger than ${SOURCE_MAX_BYTES} bytes`);
    case "ok":
      break;
  }
  const decoded = decodeSource(read.bytes);
  if (!decoded.ok) return decoded;
  let spec: SpecEnvelope | undefined;
  if (located.format === "spec-json") {
    const checked = checkSourceJson(decoded.text);
    if (!checked.ok) return checked;
    spec = checked.spec;
  }
  return {
    ok: true,
    source: {
      path: located.path,
      format: located.format,
      text: decoded.text,
      sha256: deps.sha256(decoded.text),
      bytes: decoded.bytes,
      ...(spec ? { spec } : {}),
      intent: deriveIntent(decoded.text, located.format, located.path),
    },
  };
}
