// Worker thread entry (D5): loads the cached ONNX Runtime (downloaded on first use, owner O9), the
// pinned ONNX model (CPU) and the tokenizer (@huggingface/tokenizers), then embeds batches posted by
// `embedder.ts`.

import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { batchInputs, encodeBatch, meanPoolNormalize } from "./infer.js";
import { loadRuntime } from "./runtime.js";

/** The part of onnxruntime-node's API the worker uses (the package is not an npm dependency). */
interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}
interface OrtModule {
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create(
      path: string,
      options: {
        executionProviders: string[];
        intraOpNumThreads: number;
        interOpNumThreads: number;
      },
    ): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
    }>;
  };
}

const { modelDir, runtimeDir, maxTokens } = workerData as {
  modelDir: string;
  runtimeDir: string;
  maxTokens: number;
};
const port = parentPort;

async function start() {
  if (!port) return;
  try {
    const ort = loadRuntime<OrtModule>(runtimeDir);
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const readJson = async (name: string) =>
      JSON.parse(await readFile(join(modelDir, name), "utf8"));
    const [tokenizerJson, tokenizerConfig, config] = await Promise.all([
      readJson("tokenizer.json"),
      readJson("tokenizer_config.json"),
      readJson("config.json"),
    ]);
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const padToken =
      typeof tokenizerConfig.pad_token === "string" ? tokenizerConfig.pad_token : "<pad>";
    const padId = tokenizer.token_to_id(padToken) ?? (Number(config.pad_token_id) || 0);
    const session = await ort.InferenceSession.create(join(modelDir, "onnx/model_quantized.onnx"), {
      executionProviders: ["cpu"],
      intraOpNumThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
      interOpNumThreads: 1,
    });
    const output = session.outputNames[0] as string;
    port.on("message", async (message: { type: string; id: number; texts: string[] }) => {
      if (message?.type !== "embed") return;
      try {
        const encoded = encodeBatch(tokenizer, message.texts, maxTokens);
        const input = batchInputs(encoded, padId);
        const shape = [input.batch, input.length];
        const feeds: Record<string, OrtTensor> = {
          input_ids: new ort.Tensor("int64", input.inputIds, shape),
          attention_mask: new ort.Tensor("int64", input.attention, shape),
        };
        if (session.inputNames.includes("token_type_ids"))
          feeds.token_type_ids = new ort.Tensor("int64", input.tokenTypes, shape);
        const result = await session.run(feeds);
        const hidden = result[output];
        if (!hidden) throw new Error("no output");
        const vectors = meanPoolNormalize(hidden.data as Float32Array, hidden.dims, input.lengths);
        port.postMessage(
          { type: "vectors", id: message.id, vectors },
          vectors.map((v) => v.buffer as ArrayBuffer),
        );
      } catch {
        port.postMessage({ type: "error", id: message.id, code: "inference_failed" });
      }
    });
    port.postMessage({ type: "ready", dimensions: Number(config.hidden_size) });
  } catch {
    port.postMessage({ type: "error", code: "load_failed" });
  }
}

void start();
