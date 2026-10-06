import type { MeasureDoc } from "../../domain/fidelity/measure.js";
import type { ProbeRequest } from "../../domain/fidelity/request.js";

export interface ProbeInput {
  root: string;
  /** Workspace-relative directory the probe writes into. */
  runDir: string;
  request: ProbeRequest;
  signal?: AbortSignal;
}

export type ProbeOutcome =
  | { status: "ok"; measure: MeasureDoc; runDir: string }
  | { status: "BLOCKED"; reason: string; hint: string };

/** Drives the project's own Playwright in a child process (AD-7). Never installs a browser. */
export interface BrowserProbe {
  run(input: ProbeInput): Promise<ProbeOutcome>;
}
