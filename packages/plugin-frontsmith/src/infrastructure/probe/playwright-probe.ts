import { fileURLToPath } from "node:url";
import type {
  BrowserProbe,
  ProbeInput,
  ProbeOutcome,
} from "../../application/ports/browser-probe.js";
import type { ProcessRunner } from "../../application/ports/process-runner.js";
import type { WorkspaceWriter } from "../../application/ports/workspace-writer.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { parseMeasure } from "../../domain/fidelity/measure.js";

export interface PlaywrightProbeDeps {
  process: ProcessRunner;
  writer: WorkspaceWriter;
  /** Workspace-relative text file reader (the probe's `measure.json`). */
  readText(root: string, relative: string): Promise<string | undefined>;
  /** Absolute path of the compiled probe; defaults to the one built beside this module. */
  probeScript?: string;
  /** Extra environment for the probe (a browser executable, no-sandbox), merged over the scrubbed one. */
  env?: Record<string, string>;
}

const OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * `BrowserProbe` over a child Node process: the plugin writes the request, runs the compiled probe
 * with the workspace as its directory, and reads the measurements back (spec 11.2).
 */
export class PlaywrightProbe implements BrowserProbe {
  constructor(private readonly deps: PlaywrightProbeDeps) {}

  async run(input: ProbeInput): Promise<ProbeOutcome> {
    const script = this.deps.probeScript ?? fileURLToPath(new URL("./probe.js", import.meta.url));
    const requestPath = `${input.runDir}/request.json`;
    await this.deps.writer.write(input.root, requestPath, canonicalJson(input.request));
    const cases =
      input.request.cases.length * (1 + input.request.repetitions + input.request.mutations.length);
    const result = await this.deps.process.run(["node", script, "--request", requestPath], {
      cwd: input.root,
      timeoutMs: Math.max(60_000, 15_000 * cases),
      maxOutput: OUTPUT_CAP,
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.cancelled)
      return { status: "BLOCKED", reason: "cancelled", hint: "The run was cancelled." };
    if (result.timedOut)
      return {
        status: "BLOCKED",
        reason: "probe-timeout",
        hint: "The browser probe timed out; check that the app responds on fidelity.baseUrl.",
      };
    const last = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    let summary: { status?: string; reason?: string; hint?: string } = {};
    try {
      summary = JSON.parse(last) as typeof summary;
    } catch {
      summary = {};
    }
    if (summary.status === "BLOCKED")
      return {
        status: "BLOCKED",
        reason: summary.reason ?? "probe-blocked",
        hint: summary.hint ?? "",
      };
    if (result.code !== 0 || summary.status !== "ok")
      return {
        status: "BLOCKED",
        reason: "probe-failed",
        hint: (result.stderr || result.spawnError || "the probe produced no result")
          .trim()
          .slice(0, 500),
      };
    const text = await this.deps.readText(input.root, `${input.runDir}/measure.json`);
    if (text === undefined)
      return { status: "BLOCKED", reason: "probe-failed", hint: "measure.json was not written" };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { status: "BLOCKED", reason: "probe-failed", hint: "measure.json is not valid JSON" };
    }
    const parsed = parseMeasure(raw);
    if (!parsed.ok)
      return {
        status: "BLOCKED",
        reason: "probe-failed",
        hint: parsed.errors.slice(0, 3).join("; "),
      };
    return { status: "ok", measure: parsed.doc, runDir: input.runDir };
  }
}
