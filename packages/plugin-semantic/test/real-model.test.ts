// Slow, networked test of the real engine: downloads the pinned e5-small (or reuses
// SEM_MODEL_CACHE), embeds through the built worker and searches LanceDB. Not part of `pnpm check`;
// run with `SEM_REAL_MODEL=1 pnpm --filter @alisio/plugin-semantic exec vitest run test/real-model.test.ts`
// after `pnpm build`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const enabled = process.env.SEM_REAL_MODEL === "1";

describe.skipIf(!enabled)("real model (SEM_REAL_MODEL=1)", () => {
  it(
    "downloads, verifies, embeds with prefixes and ranks the matching passage first",
    async () => {
      const dist = "../dist/";
      const { downloadModel, ProgressTracker } = await import(`${dist}engine/download.js`);
      const { installRuntime, runtimeBytes } = await import(`${dist}engine/runtime.js`);
      const { E5Embedder } = await import(`${dist}engine/embedder.js`);
      const { LanceStore } = await import(`${dist}engine/store.js`);
      const { resolveModel } = await import(`${dist}engine/models.js`);
      const spec = resolveModel("e5-small");
      const cacheRoot = process.env.SEM_MODEL_CACHE ?? (await mkdtemp(join(tmpdir(), "sem-real-")));
      const started = performance.now();
      let last = 0;
      await installRuntime(cacheRoot, {
        signal: AbortSignal.timeout(30 * 60_000),
        tracker: new ProgressTracker(runtimeBytes(), 2),
      });
      await downloadModel(cacheRoot, spec, {
        signal: AbortSignal.timeout(30 * 60_000),
        onProgress: (p: { fraction: number }) => {
          expect(p.fraction).toBeGreaterThanOrEqual(last);
          last = p.fraction;
        },
      });
      const downloadMs = performance.now() - started;
      const embedder = new E5Embedder({ spec, cacheRoot });
      const signal = new AbortController().signal;
      const coldStart = performance.now();
      const [query] = await embedder.embed(["how much protein should a woman eat"], {
        kind: "query",
        signal,
      });
      const coldMs = performance.now() - coldStart;
      const passages = [
        "As a general guideline, the average protein requirement for women ages 19 to 70 is 46 grams per day.",
        "La fotosíntesis convierte la luz en energía química en las plantas.",
        "The Eiffel Tower is in Paris.",
      ];
      const vectors = await embedder.embed(passages, { kind: "document", signal });
      const dir = await mkdtemp(join(tmpdir(), "sem-real-lance-"));
      const store = new LanceStore({ dir });
      await store.ensureCollection(
        "semantic/real",
        { modelId: embedder.modelId(), dimensions: 384 },
        signal,
      );
      await store.upsert(
        "semantic/real",
        vectors.map((vector: Float32Array, i: number) => ({ id: `p${i}`, vector })),
        signal,
      );
      const matches = await store.query("semantic/real", query, { topK: 3, signal });
      expect(matches[0]?.id).toBe("p0");
      const chunk = "El gobierno municipal anunció un plan de transporte con rutas nocturnas. "
        .repeat(16)
        .slice(0, 1200);
      const batch = Array.from({ length: 128 }, (_, i) => `${chunk} ${i}`);
      const t0 = performance.now();
      await embedder.embed(batch, { kind: "document", signal });
      const perSecond = 128 / ((performance.now() - t0) / 1000);
      console.log(
        JSON.stringify({
          downloadMs: Math.round(downloadMs),
          coldMs: Math.round(coldMs),
          chunksPerSecond: Math.round(perSecond * 10) / 10,
        }),
      );
      embedder.close();
      await rm(dir, { recursive: true, force: true });
      if (!process.env.SEM_MODEL_CACHE) await rm(cacheRoot, { recursive: true, force: true });
    },
    30 * 60_000,
  );
});
