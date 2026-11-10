import { randomUUID } from "node:crypto";
import type { SemanticActivationResult, SemanticApi } from "@alisio/sdk";
import { errorCode, SemanticPluginError, type SemanticPluginErrorCode } from "../errors.js";
import { activationMessage, type Locale, messagesFor } from "../messages.js";
import {
  type DownloadProgress,
  downloadModel,
  type Fetcher,
  isModelReady,
  ProgressTracker,
} from "./download.js";
import type { E5Embedder } from "./embedder.js";
import { type ModelSpec, totalBytes } from "./models.js";
import {
  currentTarget,
  installRuntime,
  isRuntimeReady,
  RUNTIME_PACKAGES,
  type RuntimePackage,
  type RuntimeTarget,
  runtimeBytes,
  runtimeSupported,
} from "./runtime.js";

export const EMBEDDING_ID = "semantic.e5";
export const STORE_ID = "semantic.lance";

export type ActivationOutcome =
  | SemanticActivationResult["status"]
  | "no_semantic_api"
  | "activate_unsupported";

export interface SetupResult {
  downloaded: boolean;
  activation: ActivationOutcome;
  active?: { embedding?: string; store?: string };
  message?: string;
}

export interface SetupJob {
  id: string;
  kind: "setup";
  state: "running" | "done" | "failed" | "cancelled";
  progress: number;
  detail?: DownloadProgress;
  result?: SetupResult;
  error?: SemanticPluginErrorCode;
}

export interface SetupPlan {
  key: string;
  label: string;
  /** Bytes still to download this first time (runtime + model). 0 once prepared. */
  bytes: number;
  prepared: boolean;
  destination: string;
  runtime: { bytes: number; ready: boolean; supported: boolean };
  model: { bytes: number; ready: boolean };
}

export interface SetupOptions {
  spec: ModelSpec;
  cacheRoot: string;
  embedder: E5Embedder;
  semantic: SemanticApi | undefined;
  fetcher?: Fetcher;
  /** Test seams for the runtime download (defaults: pinned packages, this process's platform). */
  runtimePackages?: RuntimePackage[];
  target?: RuntimeTarget;
}

/**
 * The one setup flow shared by `/semantic:setup` and the app's "Prepare" step (§6.1): show the
 * model, its size and destination; download and verify it as a job with progress; then ask the host
 * to activate this plugin's providers. Never runs on install or on a first query.
 */
export class SetupManager {
  private readonly options: SetupOptions;
  private readonly jobs = new Map<string, SetupJob>();
  private current:
    | { job: SetupJob; controller: AbortController; done: Promise<SetupJob> }
    | undefined;

  constructor(options: SetupOptions) {
    this.options = options;
  }

  async plan(): Promise<SetupPlan> {
    const { spec, cacheRoot } = this.options;
    const target = this.options.target ?? currentTarget();
    const packages = this.options.runtimePackages ?? RUNTIME_PACKAGES;
    const runtimeReady = await isRuntimeReady(cacheRoot, target, packages);
    const modelReady = await isModelReady(cacheRoot, spec);
    const runtime = {
      bytes: runtimeBytes(packages),
      ready: runtimeReady,
      supported: runtimeSupported(target),
    };
    const model = { bytes: totalBytes(spec), ready: modelReady };
    return {
      key: spec.key,
      label: spec.label,
      bytes: (runtimeReady ? 0 : runtime.bytes) + (modelReady ? 0 : model.bytes),
      prepared: runtimeReady && modelReady,
      destination: cacheRoot,
      runtime,
      model,
    };
  }

  running() {
    return this.current?.job.state === "running";
  }

  get(id: string): SetupJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  cancel(id: string): boolean {
    if (this.current?.job.id !== id || this.current.job.state !== "running") return false;
    this.current.controller.abort();
    return true;
  }

  currentId(): string | undefined {
    return this.current?.job.id;
  }

  cancelRunning(): boolean {
    return this.current ? this.cancel(this.current.job.id) : false;
  }

  /** Starts the setup job, or returns the one already running. */
  start(): SetupJob {
    if (this.current && this.current.job.state === "running") return this.current.job;
    const job: SetupJob = {
      id: `setup-${randomUUID()}`,
      kind: "setup",
      state: "running",
      progress: 0,
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    const done = this.execute(job, controller.signal);
    this.current = { job, controller, done };
    return job;
  }

  async run(): Promise<SetupJob> {
    this.start();
    return (this.current as { done: Promise<SetupJob> }).done;
  }

  /** Full text of `/semantic:setup`: notice (first time only), progress milestones, outcome. */
  async commandText(locale: Locale): Promise<string> {
    const m = messagesFor(locale);
    const plan = await this.plan();
    const lines: string[] = [];
    if (!plan.prepared) lines.push(m.downloadNotice(plan.bytes));
    lines.push(m.model(plan.label, plan.destination));
    if (plan.prepared) lines.push(m.alreadyPrepared);
    const job = this.start();
    let milestone = 25;
    const progressLines: string[] = [];
    const watcher = setInterval(() => {
      const detail = this.jobs.get(job.id)?.detail;
      if (!detail || plan.prepared) return;
      while (detail.fraction * 100 >= milestone && milestone < 100) {
        progressLines.push(m.progress(milestone, detail.bytes, detail.total));
        milestone += 25;
      }
    }, 100);
    const finished = await (this.current as { done: Promise<SetupJob> }).done;
    clearInterval(watcher);
    lines.push(...progressLines);
    if (finished.state === "cancelled") lines.push(m.cancelled);
    else if (finished.state === "failed")
      lines.push(m.failed(finished.error ?? "operation_failed"));
    else if (finished.result) {
      if (finished.result.downloaded) {
        lines.push(m.progress(100, plan.bytes, plan.bytes));
        lines.push(m.doneNotice);
      }
      lines.push(activationMessage(locale, finished.result));
    }
    return lines.join("\n");
  }

  /** Cancels a running download (plugin dispose). */
  dispose() {
    this.current?.controller.abort();
  }

  private async execute(job: SetupJob, signal: AbortSignal): Promise<SetupJob> {
    const { spec, cacheRoot, embedder, semantic, fetcher } = this.options;
    embedder.setDownloading(true);
    try {
      // One progress bar for the whole first-time download: runtime tarballs, then model files.
      const plan = await this.plan();
      if (!plan.runtime.supported) throw new SemanticPluginError("engine_unavailable");
      const target = this.options.target ?? currentTarget();
      const packages = this.options.runtimePackages ?? RUNTIME_PACKAGES;
      const count =
        (plan.runtime.ready ? 0 : packages.length) + (plan.model.ready ? 0 : spec.files.length);
      const tracker = new ProgressTracker(plan.bytes, count, (detail) => {
        job.detail = detail;
        job.progress = Math.max(job.progress, detail.fraction);
      });
      const { installed } = await installRuntime(cacheRoot, {
        signal,
        tracker,
        target,
        packages,
        ...(fetcher ? { fetcher } : {}),
      });
      const { downloaded } = await downloadModel(cacheRoot, spec, {
        signal,
        tracker,
        ...(fetcher ? { fetcher } : {}),
      });
      job.progress = 1;
      job.result = { downloaded: downloaded || installed, ...(await this.activate(semantic)) };
      job.state = "done";
    } catch (error) {
      const code = errorCode(error);
      job.error = code;
      job.state = code === "cancelled" ? "cancelled" : "failed";
    } finally {
      embedder.setDownloading(false);
    }
    return job;
  }

  private async activate(
    semantic: SemanticApi | undefined,
  ): Promise<Omit<SetupResult, "downloaded">> {
    if (!semantic) return { activation: "no_semantic_api" };
    if (typeof semantic.activate !== "function") return { activation: "activate_unsupported" };
    try {
      const result = await semantic.activate(
        { embedding: EMBEDDING_ID, store: STORE_ID },
        { recommend: true },
      );
      return {
        activation: result.status,
        ...(result.active ? { active: result.active } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
    } catch {
      return { activation: "unavailable" };
    }
  }
}
