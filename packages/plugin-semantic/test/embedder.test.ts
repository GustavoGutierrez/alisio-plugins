import { describe, expect, it } from "vitest";
import { E5Embedder, type EmbedBackend } from "../src/engine/embedder.js";
import { encodeBatch, meanPoolNormalize } from "../src/engine/infer.js";
import { MODELS, modelId, resolveModel } from "../src/engine/models.js";

function fakeFactory() {
  const calls: string[][] = [];
  let closed = 0;
  let created = 0;
  const factory = async (): Promise<EmbedBackend> => {
    created++;
    return {
      async embed(texts) {
        calls.push(texts);
        return texts.map((_, i) => new Float32Array([i, 1, 0, 0]));
      },
      async close() {
        closed++;
      },
    };
  };
  return { factory, calls, closedCount: () => closed, createdCount: () => created };
}
const signal = () => new AbortController().signal;

describe("E5 embedder (D5-D7)", () => {
  it("prefixes query and document inputs for e5 and nothing for MiniLM (SEM-AC-05)", async () => {
    const fake = fakeFactory();
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: "/nonexistent",
      factory: fake.factory,
      ready: async () => true,
    });
    await e5.embed(["a"], { kind: "query", signal: signal() });
    await e5.embed(["b"], { kind: "document", signal: signal() });
    const minilm = new E5Embedder({
      spec: resolveModel("minilm"),
      cacheRoot: "/nonexistent",
      factory: fake.factory,
      ready: async () => true,
    });
    await minilm.embed(["c"], { kind: "query", signal: signal() });
    await minilm.embed(["d"], { kind: "document", signal: signal() });
    expect(fake.calls).toEqual([["query: a"], ["passage: b"], ["c"], ["d"]]);
    e5.close();
    minilm.close();
  });

  it("exposes the pinned model identity and its dimensions (D6)", () => {
    const e5 = new E5Embedder({ spec: MODELS["e5-base"]!, cacheRoot: "/nonexistent" });
    expect(e5.id).toBe("semantic.e5");
    expect(e5.modelId()).toBe(modelId(MODELS["e5-base"]!));
    expect(e5.dimensions()).toBe(768);
  });

  it("embeds in batches of 32, keeps order and loads the backend once", async () => {
    const fake = fakeFactory();
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: "/nonexistent",
      factory: fake.factory,
      ready: async () => true,
    });
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const vectors = await e5.embed(texts, { kind: "document", signal: signal() });
    expect(vectors).toHaveLength(70);
    expect(fake.calls.map((c) => c.length)).toEqual([32, 32, 6]);
    expect(fake.calls.flat()[69]).toBe("passage: t69");
    expect(fake.createdCount()).toBe(1);
    e5.close();
  });

  it("stops the backend after the idle period and reloads on the next call", async () => {
    const fake = fakeFactory();
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: "/nonexistent",
      factory: fake.factory,
      ready: async () => true,
      idleMs: 20,
    });
    await e5.embed(["a"], { kind: "query", signal: signal() });
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.closedCount()).toBe(1);
    await e5.embed(["b"], { kind: "query", signal: signal() });
    expect(fake.createdCount()).toBe(2);
    e5.close();
  });

  it("fails with model_missing before setup and reports health in plain states", async () => {
    let ready = false;
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: "/nonexistent",
      factory: fakeFactory().factory,
      ready: async () => ready,
    });
    await expect(e5.embed(["a"], { kind: "query", signal: signal() })).rejects.toMatchObject({
      code: "model_missing",
    });
    expect(await e5.health()).toEqual({ status: "unavailable", detail: "run /semantic:setup" });
    e5.setDownloading(true);
    expect((await e5.health()).status).toBe("starting");
    e5.setDownloading(false);
    ready = true;
    expect((await e5.health()).status).toBe("ready");
  });

  it("is not ready while the cached ONNX Runtime is missing, even with the model present", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "sem-emb-"));
    const fake = fakeFactory();
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: root,
      factory: fake.factory,
    });
    await expect(e5.embed(["a"], { kind: "query", signal: signal() })).rejects.toMatchObject({
      code: "model_missing",
    });
    expect(await e5.health()).toEqual({ status: "unavailable", detail: "run /semantic:setup" });
    expect(fake.createdCount()).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it("honors an aborted signal without calling the backend", async () => {
    const fake = fakeFactory();
    const e5 = new E5Embedder({
      spec: resolveModel("e5-small"),
      cacheRoot: "/nonexistent",
      factory: fake.factory,
      ready: async () => true,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(e5.embed(["a"], { kind: "query", signal: controller.signal })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe("inference helpers", () => {
  it("truncates to the model window and keeps the closing special token", () => {
    const tokenizer = {
      encode: (text: string) => ({ ids: [0, ...text.split("").map(() => 5), 2] }),
    };
    const [ids] = encodeBatch(tokenizer, ["abcdefghij"], 6);
    expect(ids).toEqual([0, 5, 5, 5, 5, 2]);
  });

  it("mean-pools only the attended tokens and L2-normalizes", () => {
    // Batch of 2, length 2, dims 2. Second row has one real token and one pad.
    const hidden = new Float32Array([1, 0, 3, 0, 0, 2, 9, 9]);
    const [a, b] = meanPoolNormalize(hidden, [2, 2, 2], [2, 1]);
    expect(Array.from(a!)).toEqual([1, 0]);
    expect(Array.from(b!)).toEqual([0, 1]);
  });
});
