import { compileGlob } from "../glob.js";
import type { ArchitectureConfig } from "./config.js";

export interface LayerMap {
  layerOf(path: string): string | undefined;
  isIgnored(path: string): boolean;
  /** Slice of a path inside a sliced layer, or `undefined` outside any slice. */
  sliceOf(path: string): { layer: string; slice: string; rest: string } | undefined;
  /** Atomic level of a path, or `undefined`. */
  levelOf(path: string): number | undefined;
  isPresentational(path: string): boolean;
}

/** Directory prefix of a layer glob up to the first wildcard (`src/pages/**` -> `src/pages/`). */
export function layerDirectory(glob: string): string {
  const wildcard = glob.search(/[*?{[]/);
  const prefix = wildcard === -1 ? glob : glob.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash + 1);
}

/** Compile the path matchers of an architecture config once. */
export function buildLayerMap(config: ArchitectureConfig): LayerMap {
  const layers = config.layers.map((layer) => ({
    name: layer.name,
    tests: layer.paths.map((glob) => compileGlob(glob)),
    directories: layer.paths.map(layerDirectory),
  }));
  const ignore = config.ignore.map((glob) => compileGlob(glob));
  const sliced = new Set(config.slices?.layers ?? []);
  const depth = config.slices?.depth ?? 1;
  const atomicLevels = config.atomic?.levels ?? [];
  const atomicTests = atomicLevels.map((level) =>
    (config.atomic?.paths[level] ?? []).map((glob) => compileGlob(glob)),
  );
  const presentational = (config.roles?.presentational ?? []).map((glob) => compileGlob(glob));
  const layerOf = (path: string): string | undefined =>
    layers.find((layer) => layer.tests.some((test) => test(path)))?.name;
  return {
    layerOf,
    isIgnored: (path) => ignore.some((test) => test(path)),
    sliceOf(path) {
      const layer = layers.find((candidate) => candidate.tests.some((test) => test(path)));
      if (!layer || !sliced.has(layer.name)) return undefined;
      const directory = layer.directories
        .filter((dir) => path.startsWith(dir))
        .sort((a, b) => b.length - a.length)[0];
      if (directory === undefined) return undefined;
      const parts = path.slice(directory.length).split("/");
      if (parts.length <= depth)
        return { layer: layer.name, slice: parts.slice(0, depth).join("/"), rest: "" };
      return {
        layer: layer.name,
        slice: parts.slice(0, depth).join("/"),
        rest: parts.slice(depth).join("/"),
      };
    },
    levelOf(path) {
      const index = atomicTests.findIndex((tests) => tests.some((test) => test(path)));
      return index === -1 ? undefined : index;
    },
    isPresentational: (path) => presentational.some((test) => test(path)),
  };
}
