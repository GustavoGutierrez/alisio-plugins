export type SourceRead =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "not-file" }
  | { kind: "too-large"; size: number }
  | { kind: "escape"; message: string };

/** Reads one specification file of the workspace for `--from-spec`; never follows a link out of it. */
export interface SourceReader {
  read(root: string, relative: string, maxBytes: number): Promise<SourceRead>;
}
