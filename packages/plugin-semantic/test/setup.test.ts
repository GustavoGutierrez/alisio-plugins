import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SemanticActivationResult, SemanticApi } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { E5Embedder } from "../src/engine/embedder.js";
import { runtimeBytes } from "../src/engine/runtime.js";
import { SetupManager } from "../src/engine/setup.js";
import { activationMessage, messagesFor } from "../src/messages.js";
import { fakeModel, fakeFetcher as fakeModelFetcher } from "./model-fixture.js";
import { fakeRuntime } from "./runtime-fixture.js";

const rt = fakeRuntime();
const RUNTIME = runtimeBytes(rt.packages);
/** Serves the fake runtime tarballs together with the given model files. */
const fakeFetcher = (
  served: Record<string, Buffer>,
  options?: Parameters<typeof fakeModelFetcher>[1],
) => fakeModelFetcher({ ...rt.served, ...served }, options);

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const files = {
  "config.json": Buffer.from(JSON.stringify({ hidden_size: 4 })),
  "onnx/model_quantized.onnx": Buffer.alloc(5000, 3),
};
const STATUSES: SemanticActivationResult["status"][] = [
  "activated",
  "already_active",
  "other_provider_active",
  "declined",
  "needs_confirmation",
  "disabled",
  "unavailable",
];

async function manager(
  activate?: SemanticApi["activate"],
  fetch = fakeFetcher(files),
  semantic: "present" | "absent" = "present",
) {
  const root = await mkdtemp(join(tmpdir(), "sem-setup-"));
  roots.push(root);
  const spec = fakeModel(files);
  const embedder = new E5Embedder({ spec, cacheRoot: root });
  const calls: unknown[] = [];
  const api =
    semantic === "absent"
      ? undefined
      : ({
          ...(activate
            ? {
                activate: async (...args: Parameters<NonNullable<SemanticApi["activate"]>>) => {
                  calls.push(args);
                  return activate(...args);
                },
              }
            : {}),
        } as unknown as SemanticApi);
  const setup = new SetupManager({
    spec,
    cacheRoot: root,
    embedder,
    semantic: api,
    fetcher: fetch.fetcher,
    runtimePackages: rt.packages,
    target: { platform: "linux", arch: "x64" },
  });
  return { setup, calls, root, fetch };
}

describe("setup flow (§6.1, D3)", () => {
  it("activates with recommend after a verified download and words every status (SEM-AC-03)", async () => {
    for (const status of STATUSES) {
      const result: SemanticActivationResult =
        status === "other_provider_active"
          ? { status, active: { embedding: "acme.embed", store: "acme.store" } }
          : { status };
      const { setup, calls } = await manager(async () => result);
      const job = await setup.run();
      expect(job.state).toBe("done");
      expect(job.result?.activation).toBe(status);
      expect(calls).toEqual([
        [{ embedding: "semantic.e5", store: "semantic.lance" }, { recommend: true }],
      ]);
      for (const locale of ["en", "es"] as const) {
        const text = activationMessage(locale, job.result!);
        expect(text.length).toBeGreaterThan(10);
        if (status === "other_provider_active") expect(text).toContain("acme.embed");
      }
    }
    const texts = STATUSES.map((status) =>
      activationMessage("en", { downloaded: true, activation: status }),
    );
    expect(new Set(texts).size).toBe(STATUSES.length);
  });

  it("does not activate when the download is corrupt (SEM-AC-02)", async () => {
    const tampered = fakeFetcher({ ...files, "onnx/model_quantized.onnx": Buffer.alloc(5000, 4) });
    const { setup, calls } = await manager(async () => ({ status: "activated" }), tampered);
    const job = await setup.run();
    expect(job).toMatchObject({ state: "failed", error: "model_corrupt" });
    expect(calls).toEqual([]);
  });

  it("shows the one-time download notice with the size only until the model is verified", async () => {
    const { setup } = await manager(async () => ({ status: "activated" }));
    const before = await setup.plan();
    expect(before.prepared).toBe(false);
    // One combined first-time size: runtime tarballs + model files.
    expect(before.bytes).toBe(RUNTIME + 5000 + files["config.json"].length);
    expect(before.runtime).toMatchObject({ ready: false, supported: true, bytes: RUNTIME });
    const en = messagesFor("en");
    const es = messagesFor("es");
    expect(en.downloadNotice(135_392_016)).toBe(
      "Semantic search needs a one-time download of about 135 MB. After that it works offline.",
    );
    expect(es.downloadNotice(135_392_016)).toBe(
      "La búsqueda semántica necesita una descarga única de unos 135 MB. Después funciona sin conexión.",
    );
    const first = await setup.run();
    expect(first.result?.downloaded).toBe(true);
    expect((await setup.plan()).prepared).toBe(true);
    const lines = await setup.commandText("en");
    expect(lines).not.toContain("one-time download");
    expect(lines).toContain(en.alreadyPrepared);
  });

  it("reports monotonic job progress and totals while downloading", async () => {
    const { setup } = await manager(
      async () => ({ status: "activated" }),
      fakeFetcher(files, { chunk: 200 }),
    );
    const seen: number[] = [];
    const job = setup.start();
    expect(setup.start().id).toBe(job.id);
    while (setup.get(job.id)?.state === "running") {
      seen.push(setup.get(job.id)?.progress ?? 0);
      await new Promise((r) => setImmediate(r));
    }
    const done = setup.get(job.id)!;
    expect(done.state).toBe("done");
    expect(done.progress).toBe(1);
    expect(done.detail?.total).toBe(RUNTIME + 5000 + files["config.json"].length);
    expect(done.detail?.fileCount).toBe(4);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(setup.running()).toBe(false);
  });

  it("cancels a running setup, leaves no partial file and never activates", async () => {
    const { setup, calls } = await manager(
      async () => ({ status: "activated" }),
      fakeFetcher(files, { chunk: 50 }),
    );
    const job = setup.start();
    while ((setup.get(job.id)?.detail?.bytes ?? 0) < 1000)
      await new Promise((r) => setImmediate(r));
    expect(setup.cancel(job.id)).toBe(true);
    while (setup.get(job.id)?.state === "running") await new Promise((r) => setImmediate(r));
    expect(setup.get(job.id)).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(calls).toEqual([]);
    expect((await setup.plan()).prepared).toBe(false);
  });

  it("explains activation on a host without api.semantic or without activate", async () => {
    const absent = await manager(undefined, fakeFetcher(files), "absent");
    expect((await absent.setup.run()).result?.activation).toBe("no_semantic_api");
    const noActivate = await manager(undefined);
    const job = await noActivate.setup.run();
    expect(job.result?.activation).toBe("activate_unsupported");
    expect(activationMessage("en", job.result!)).toContain("semantic.embedding");
  });
});
