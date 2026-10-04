import type { Finding } from "../types.js";
import type { BuildScope, ThesisDocument } from "./model.js";

/**
 * The renderer port (spec 10.0). An adapter turns a resolved `ThesisDocument` into one output
 * format. Adapters never read Markdown, the library or the brief: everything they need is in the
 * document. Adding a format means adding a folder under `adapters/` and registering it; no other
 * module changes.
 */

export type Support = "native" | "converted" | "none";

export interface RendererCapabilities {
  /** Math rendering: native, converted to images/another notation, or not represented. */
  math: Support;
  mermaid: Support;
  footnotes: Support;
  /** Table of contents and lists of figures/tables with page numbers. */
  toc: Support;
  crossrefs: Support;
  /** Bibliography formatted from the library by the engine itself. */
  bibliography: Support;
  /** PDF/A archival output. */
  pdfa: boolean;
  /** Output file extension without a dot. */
  extension: string;
}

export type Availability =
  | { available: true; engine: string; version?: string; source: string; path?: string }
  | { available: false; reason: string; hint?: string };

export interface RenderEnvironment {
  env: NodeJS.ProcessEnv;
  /** Cache root for downloaded engines (`api.paths?.cache` or the environment fallback). */
  cacheRoot: string;
  /** Absolute path of the thesis root (the folder with thesis.yaml). */
  root: string;
}

export interface RenderOptions {
  scope: BuildScope;
  /** Outline section built in `section` scope; names the output file. */
  section?: string;
  pdfa?: boolean;
}

export interface RenderContext extends RenderEnvironment {
  /** Absolute build directory; adapters read resolved assets from here and write output here. */
  buildDir: string;
  signal?: AbortSignal;
  /** Called with short progress notes for the UI status line. */
  progress?: (note: string) => void;
}

/** A construct the format could not represent, reported instead of silently dropped. */
export interface Unrepresented {
  construct: string;
  count: number;
  note?: string;
}

export interface RenderResult {
  ok: boolean;
  engine: string;
  /** Output path relative to the build directory, when produced. */
  output?: string;
  pages?: number;
  ms: number;
  findings: Finding[];
  unrepresented: Unrepresented[];
}

export interface Renderer {
  readonly id: string;
  readonly format: string;
  capabilities(): RendererCapabilities;
  available(env: RenderEnvironment): Promise<Availability>;
  render(
    doc: ThesisDocument,
    options: RenderOptions,
    context: RenderContext,
  ): Promise<RenderResult>;
}
