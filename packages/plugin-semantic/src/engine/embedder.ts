import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { EmbeddingKind, EmbeddingProvider, SemanticHealth } from "@alisio/sdk";
import { SemanticPluginError } from "../errors.js";
import { isModelReady, modelPath } from "./download.js";
import { applyPrefix, type ModelSpec, modelId } from "./models.js";
import { isRuntimeReady, runtimePath } from "./runtime.js";

/** What the embedder needs from an inference backend (the worker, or a fake in tests). */
export interface EmbedBackend {
  /** Texts already prefixed; one unit vector per text, same order. */
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}
export type BackendFactory = (
  modelDir: string,
  spec: ModelSpec,
  runtimeDir: string,
) => Promise<EmbedBackend>;

export interface EmbedderOptions {
  spec: ModelSpec;
  cacheRoot: string;
  factory?: BackendFactory;
  /** Defaults to: the cached ONNX Runtime and the model snapshot are both verified. */
  ready?: () => Promise<boolean>;
  idleMs?: number;
  batchSize?: number;
}

const IDLE_MS = 5 * 60 * 1000;
const BATCH = 32;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Local `EmbeddingProvider` (`semantic.e5`). Inference runs in a worker thread started lazily and
 * stopped after 5 minutes idle (D5); inputs get the model family's prefixes (D7).
 */
export class E5Embedder implements EmbeddingProvider {
  readonly id = "semantic.e5";
  readonly name: string;
  private readonly spec: ModelSpec;
  private readonly cacheRoot: string;
  private readonly factory: BackendFactory;
  private readonly ready: () => Promise<boolean>;
  private readonly idleMs: number;
  private readonly batchSize: number;
  private backend: Promise<EmbedBackend> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private downloading = false;
  private loading = false;
  private configDimensions: number | undefined;

  constructor(options: EmbedderOptions) {
    this.spec = options.spec;
    this.cacheRoot = options.cacheRoot;
    this.factory = options.factory ?? workerBackend;
    this.ready =
      options.ready ??
      (async () =>
        (await isRuntimeReady(this.cacheRoot)) && (await isModelReady(this.cacheRoot, this.spec)));
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.batchSize = options.batchSize ?? BATCH;
    this.name = `Local ${options.spec.label}`;
  }

  modelId() {
    return modelId(this.spec);
  }

  /** `hidden_size` of the downloaded `config.json`, else the size the table declares. */
  dimensions() {
    if (this.configDimensions === undefined) {
      try {
        const config = JSON.parse(
          readFileSync(join(modelPath(this.cacheRoot, this.spec), "config.json"), "utf8"),
        ) as { hidden_size?: unknown };
        if (Number.isInteger(config.hidden_size))
          this.configDimensions = config.hidden_size as number;
      } catch {
        return this.spec.dimensions;
      }
    }
    return this.configDimensions ?? this.spec.dimensions;
  }

  /** Set by the setup job so `health()` reports `starting` while the model downloads. */
  setDownloading(value: boolean) {
    this.downloading = value;
  }

  async embed(texts: string[], options: { kind: EmbeddingKind; signal: AbortSignal }) {
    options.signal.throwIfAborted();
    if (!(await this.ready())) throw new SemanticPluginError("model_missing");
    const prefixed = texts.map((text) => applyPrefix(this.spec, options.kind, text));
    const vectors: Float32Array[] = [];
    clearTimeout(this.idleTimer);
    try {
      const backend = await abortable(this.load(), options.signal);
      for (let i = 0; i < prefixed.length; i += this.batchSize) {
        options.signal.throwIfAborted();
        vectors.push(
          ...(await abortable(
            backend.embed(prefixed.slice(i, i + this.batchSize)),
            options.signal,
          )),
        );
      }
    } finally {
      this.armIdle();
    }
    return vectors;
  }

  async health(): Promise<SemanticHealth> {
    if (this.downloading || this.loading) return { status: "starting" };
    if (!(await this.ready())) return { status: "unavailable", detail: "run /semantic:setup" };
    return { status: "ready" };
  }

  /** Stops the worker (plugin dispose); the next `embed` starts it again. */
  close() {
    clearTimeout(this.idleTimer);
    const backend = this.backend;
    this.backend = undefined;
    void backend?.then((b) => b.close()).catch(() => {});
  }

  private load() {
    if (!this.backend) {
      this.loading = true;
      const started = this.factory(
        modelPath(this.cacheRoot, this.spec),
        this.spec,
        runtimePath(this.cacheRoot),
      ).finally(() => {
        this.loading = false;
      });
      started.catch(() => {
        if (this.backend === started) this.backend = undefined;
      });
      this.backend = started;
    }
    return this.backend;
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }
}

type WorkerReply =
  | { type: "ready"; dimensions: number }
  | { type: "vectors"; id: number; vectors: Float32Array[] }
  | { type: "error"; id?: number; code: string };

/** Starts `worker.js` (a `node:worker_threads` worker) and talks to it by request id. */
export async function workerBackend(
  modelDir: string,
  spec: ModelSpec,
  runtimeDir: string,
): Promise<EmbedBackend> {
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: { modelDir, runtimeDir, maxTokens: spec.maxTokens },
  });
  worker.unref();
  const pending = new Map<
    number,
    { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
  >();
  let next = 0;
  const failAll = (code: string) => {
    for (const p of pending.values()) p.reject(new SemanticPluginError("engine_unavailable", code));
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    worker.once("error", () => reject(new SemanticPluginError("engine_unavailable")));
    worker.on("message", (message: WorkerReply) => {
      if (message.type === "ready") {
        if (message.dimensions !== spec.dimensions) {
          reject(new SemanticPluginError("model_corrupt"));
          void worker.terminate();
        } else resolve();
        return;
      }
      if (message.type === "error" && message.id === undefined) {
        reject(
          new SemanticPluginError(
            message.code === "model_corrupt" ? "model_corrupt" : "engine_unavailable",
          ),
        );
        return;
      }
      const request = message.id === undefined ? undefined : pending.get(message.id);
      if (!request || message.id === undefined) return;
      pending.delete(message.id);
      if (message.type === "vectors") request.resolve(message.vectors);
      else request.reject(new SemanticPluginError("engine_unavailable", message.code));
    });
  });
  worker.on("error", () => failAll("worker_error"));
  worker.on("exit", () => failAll("worker_exit"));
  return {
    embed(texts) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "embed", id, texts });
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}
