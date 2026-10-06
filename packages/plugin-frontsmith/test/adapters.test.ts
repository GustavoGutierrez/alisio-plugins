import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveAdapter,
  type StackAdapter,
  selectAdapters,
  validateAdapter,
} from "../src/domain/stack/adapter.js";
import { loadShippedAdapters } from "../src/infrastructure/packs/adapter-loader.js";

const adaptersDir = new URL("../adapters/", import.meta.url).pathname;

describe("shipped adapters", () => {
  it("ships exactly the eleven adapters of the spec", async () => {
    const files = (await readdir(adaptersDir)).sort();
    expect(files).toEqual(
      [
        "angular",
        "astro",
        "html",
        "next",
        "nuxt",
        "preact",
        "react",
        "solid",
        "svelte",
        "sveltekit",
        "vue",
      ].map((id) => `${id}.json`),
    );
  });

  it("loads and validates all of them with unique ids matching their file names", async () => {
    const adapters = await loadShippedAdapters();
    expect(adapters.map((a) => a.id)).toEqual([
      "angular",
      "astro",
      "html",
      "next",
      "nuxt",
      "preact",
      "react",
      "solid",
      "svelte",
      "sveltekit",
      "vue",
    ]);
    for (const adapter of adapters) expect(validateAdapter(adapter)).toEqual({ ok: true, adapter });
  });

  it("resolves extends so a child overrides its parent", async () => {
    const adapters = await loadShippedAdapters();
    const next = resolveAdapter("next", adapters);
    expect(next.componentApi).toBe("react");
    expect(next.packs).toEqual(["fs-react", "fs-next"]);
    expect(resolveAdapter("sveltekit", adapters).templates.kind).toBe("svelte");
  });
});

describe("adapter validation", () => {
  const base = (): StackAdapter => ({
    schemaVersion: 1,
    id: "x",
    extends: null,
    detect: { dependencies: ["x"] },
    sourceGlobs: ["src/**"],
    templates: { kind: "jsx", globs: ["**/*.tsx"] },
    componentApi: "none",
    testGlobs: [],
    packs: [],
    commands: { testRelated: null },
  });

  it.each([
    ["unknown template kind", { templates: { kind: "pug", globs: [] } }, "/templates/kind"],
    ["unknown component api", { componentApi: "vue" }, "/componentApi"],
    ["bad id", { id: "Bad Id" }, "/id"],
    ["unknown key", { extra: 1 }, "/extra"],
    ["bad glob", { sourceGlobs: ["!src/**"] }, "/sourceGlobs/0"],
    ["bad pack id", { packs: ["Not A Pack"] }, "/packs/0"],
    ["bad schemaVersion", { schemaVersion: 2 }, "/schemaVersion"],
    ["bad command", { commands: { testRelated: [] } }, "/commands/testRelated"],
  ])("rejects %s", (_name, patch, pointer) => {
    const result = validateAdapter({ ...base(), ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.pointer === pointer)).toBe(true);
  });

  it("refuses a workspace adapter that adds a template kind its parent lacks", () => {
    const parent = base();
    const child = {
      ...base(),
      id: "child",
      extends: "x",
      templates: { kind: "vue-sfc" as const, globs: ["**/*.vue"] },
    };
    expect(() => resolveAdapter("child", [parent, child], { workspace: true })).toThrow(
      /template kind/,
    );
    expect(resolveAdapter("child", [parent, child]).templates.kind).toBe("vue-sfc");
  });

  it("detects extends cycles and unknown parents", () => {
    const a = { ...base(), id: "a", extends: "b" };
    const b = { ...base(), id: "b", extends: "a" };
    expect(() => resolveAdapter("a", [a, b])).toThrow(/cycle/);
    expect(() => resolveAdapter("a", [a])).toThrow(/unknown/);
  });
});

describe("adapter selection", () => {
  it("selects adapters whose dependencies or files match and honours enable and disable", async () => {
    const adapters = await loadShippedAdapters();
    const ids = (deps: string[], files: string[] = [], options = {}) =>
      selectAdapters(adapters, new Set(deps), files, options).map((a) => a.id);
    expect(ids(["react", "next"])).toEqual(["next", "react"]);
    expect(ids(["vue"])).toEqual(["vue"]);
    expect(ids([], ["public/index.html"])).toEqual(["html"]);
    expect(ids(["react"], [], { disable: ["react"] })).toEqual([]);
    expect(ids([], [], { enable: ["solid"] })).toEqual(["solid"]);
  });
});
