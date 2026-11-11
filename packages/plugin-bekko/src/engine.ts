/**
 * Loads a Bekko variant through `jev-web` (ONNX Runtime Web on its WebAssembly backend, CPU only).
 * `jev-web` is imported lazily, so installing or loading the plugin never pulls the runtime in;
 * every model file goes through the pinned, verified cache.
 */
import { createCachedFetch } from "./cache.js";
import { VARIANTS } from "./pins.js";
import type { Engine, EngineFactory, Prediction, Question, Variant } from "./types.js";

interface JevDecider {
  decide(state: string, questions: Question[]): Promise<Prediction>;
  dispose(): Promise<void>;
}

interface JevWeb {
  createBekkoDecider(options: {
    variant: Variant;
    device: "wasm";
    fetchImpl: typeof fetch;
    onProgress?: (event: { phase?: unknown; loaded?: unknown; total?: unknown }) => void;
  }): Promise<JevDecider>;
}

/** Builds the default engine factory, caching model files under `cacheDir`. */
export function createEngineFactory(cacheDir: string): EngineFactory {
  return async (variant, progress) => {
    const pin = VARIANTS[variant];
    progress(`loading Bekko ${variant}`);
    const jev = (await import("jev-web")) as unknown as JevWeb;
    const decider = await jev.createBekkoDecider({
      variant,
      device: "wasm",
      fetchImpl: createCachedFetch({ dir: cacheDir, files: pin.files }),
      onProgress: (event) => {
        const phase = typeof event.phase === "string" ? event.phase.slice(0, 40) : "loading";
        const { loaded, total } = event;
        const pct =
          typeof loaded === "number" && typeof total === "number" && total > 0
            ? ` ${Math.min(100, Math.round((loaded / total) * 100))}%`
            : "";
        progress(`${phase}${pct}`);
      },
    });
    const engine: Engine = {
      decide: (state, questions) => decider.decide(state, questions),
      dispose: () => decider.dispose(),
    };
    return engine;
  };
}
