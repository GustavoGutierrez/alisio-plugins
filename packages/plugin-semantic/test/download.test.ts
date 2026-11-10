import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DownloadProgress,
  downloadModel,
  isModelReady,
  modelPath,
  partialPath,
} from "../src/engine/download.js";
import { SemanticPluginError } from "../src/errors.js";
import { fakeFetcher, fakeModel } from "./model-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function cache() {
  const root = await mkdtemp(join(tmpdir(), "sem-dl-"));
  roots.push(root);
  return root;
}
async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name).slice(dir.length + 1));
  return out.sort();
}
const files = {
  "config.json": Buffer.from(JSON.stringify({ hidden_size: 4 })),
  "onnx/model_quantized.onnx": Buffer.alloc(10_000, 7),
};

describe("pinned model download (D3)", () => {
  it("reports monotonic per-file and overall progress from 0 to 1 with known totals", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const { fetcher, log } = fakeFetcher(files, { chunk: 999 });
    const events: DownloadProgress[] = [];
    const result = await downloadModel(root, spec, {
      fetcher,
      onProgress: (p) => events.push(p),
      signal: new AbortController().signal,
    });
    expect(result.downloaded).toBe(true);
    expect(
      log.every((l) => l.url.startsWith("https://huggingface.co/Fake/model/resolve/0123")),
    ).toBe(true);
    expect(events[0]?.fraction).toBe(0);
    expect(events.at(-1)?.fraction).toBe(1);
    expect(events.at(-1)?.bytes).toBe(10_000 + files["config.json"].length);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.bytes).toBeGreaterThanOrEqual(events[i - 1]!.bytes);
      expect(events[i]!.fraction).toBeGreaterThanOrEqual(events[i - 1]!.fraction);
    }
    for (const e of events) {
      expect(e.total).toBe(10_000 + files["config.json"].length);
      expect(e.fileCount).toBe(2);
      expect(e.fileBytes).toBeLessThanOrEqual(e.fileTotal);
    }
    expect(
      events.some((e) => e.file === "onnx/model_quantized.onnx" && e.fileBytes === 10_000),
    ).toBe(true);
    expect(await isModelReady(root, spec)).toBe(true);
    expect(await readFile(join(modelPath(root, spec), "onnx/model_quantized.onnx"))).toEqual(
      files["onnx/model_quantized.onnx"],
    );
  });

  it("rejects a tampered file as model_corrupt and leaves nothing of it in the cache (SEM-AC-02)", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const tampered = { ...files, "onnx/model_quantized.onnx": Buffer.alloc(10_000, 8) };
    const { fetcher } = fakeFetcher(tampered);
    const failure = downloadModel(root, spec, { fetcher, signal: new AbortController().signal });
    await expect(failure).rejects.toMatchObject({ code: "model_corrupt" });
    expect(await isModelReady(root, spec)).toBe(false);
    const left = await listAll(root);
    expect(left.some((f) => f.includes("model_quantized"))).toBe(false);
  });

  it("does not download again once the model is present and verified", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const first = fakeFetcher(files);
    await downloadModel(root, spec, {
      fetcher: first.fetcher,
      signal: new AbortController().signal,
    });
    const second = fakeFetcher(files);
    const result = await downloadModel(root, spec, {
      fetcher: second.fetcher,
      signal: new AbortController().signal,
    });
    expect(result.downloaded).toBe(false);
    expect(second.log).toEqual([]);
  });

  it("removes the partial file when cancelled and reports cancelled", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const { fetcher } = fakeFetcher(files, { chunk: 100 });
    const controller = new AbortController();
    const run = downloadModel(root, spec, {
      fetcher,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.file === "onnx/model_quantized.onnx" && p.fileBytes >= 500) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect((await listAll(root)).some((f) => f.includes("model_quantized"))).toBe(false);
    expect(await isModelReady(root, spec)).toBe(false);
  });

  it("removes the partial file on a network failure and restarts cleanly on the next try", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const broken = fakeFetcher(files, { failAfter: { "onnx/model_quantized.onnx": 3000 } });
    await expect(
      downloadModel(root, spec, { fetcher: broken.fetcher, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "download_failed" });
    expect((await listAll(root)).some((f) => f.includes("model_quantized"))).toBe(false);
    const ok = fakeFetcher(files);
    await downloadModel(root, spec, { fetcher: ok.fetcher, signal: new AbortController().signal });
    expect(await isModelReady(root, spec)).toBe(true);
  });

  it("resumes a partial file left by a crash with a Range request and verifies the whole file", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const partial = partialPath(root, spec, "onnx/model_quantized.onnx");
    await mkdir(join(partial, ".."), { recursive: true });
    await writeFile(partial, files["onnx/model_quantized.onnx"].subarray(0, 4000));
    const { fetcher, log } = fakeFetcher(files);
    const events: DownloadProgress[] = [];
    await downloadModel(root, spec, {
      fetcher,
      signal: new AbortController().signal,
      onProgress: (p) => events.push(p),
    });
    expect(log.find((l) => l.url.endsWith("model_quantized.onnx"))?.range).toBe("bytes=4000-");
    expect(await isModelReady(root, spec)).toBe(true);
    expect(await readFile(join(modelPath(root, spec), "onnx/model_quantized.onnx"))).toEqual(
      files["onnx/model_quantized.onnx"],
    );
    expect((await listAll(root)).filter((f) => f.startsWith(".partial"))).toEqual([]);
  });

  it("restarts from zero when the server ignores the Range header", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const partial = partialPath(root, spec, "onnx/model_quantized.onnx");
    await mkdir(join(partial, ".."), { recursive: true });
    await writeFile(partial, Buffer.alloc(4000, 1));
    const { fetcher } = fakeFetcher(files, { ignoreRange: true });
    await downloadModel(root, spec, { fetcher, signal: new AbortController().signal });
    expect(await isModelReady(root, spec)).toBe(true);
  });

  it("treats a model file changed after verification as not ready", async () => {
    const root = await cache();
    const spec = fakeModel(files);
    const { fetcher } = fakeFetcher(files);
    await downloadModel(root, spec, { fetcher, signal: new AbortController().signal });
    await writeFile(join(modelPath(root, spec), "onnx/model_quantized.onnx"), "short");
    expect(await isModelReady(root, spec)).toBe(false);
    expect(new SemanticPluginError("model_missing").code).toBe("model_missing");
  });
});
