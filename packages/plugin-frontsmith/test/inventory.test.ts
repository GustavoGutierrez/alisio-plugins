import { afterEach, describe, expect, it } from "vitest";
import { buildInventory } from "../src/application/detect/inventory.js";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import type { TempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const analyzer = new DefaultFileAnalyzer();
const analyze = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => analyzer.analyze(path, text));

describe("inventory", () => {
  const files = {
    "src/ui/Button.tsx":
      "export function Button() { return <button /> }\nexport const useFlag = () => true;",
    "src/ui/Panel.vue": "<template><div/></template>",
    "src/app/app.component.ts":
      "@Component({ selector: 'x', template: '' })\nexport class AppComponent {}",
    "src/store/projects.ts": `import { create } from "zustand";\nexport const useProjects = create(() => ({}));`,
    "src/styles/tokens.css":
      ":root {\n  --color-bg: #fff;\n  --space-1: 4px;\n}\n.a { color: red }",
    "src/styles/other.scss": "$x: 1;",
  };

  it("lists components from jsx, sfc and angular files", () => {
    const rows = buildInventory(analyze(files), {
      kinds: ["components"],
      tokenFiles: ["src/styles/**/*.css"],
    });
    expect(rows.map((r) => [r.name, r.path, r.kind])).toEqual([
      ["AppComponent", "src/app/app.component.ts", "component"],
      ["Button", "src/ui/Button.tsx", "component"],
      ["Panel", "src/ui/Panel.vue", "component"],
    ]);
  });

  it("lists hooks, stores and tokens", () => {
    const hooks = buildInventory(analyze(files), { kinds: ["hooks"], tokenFiles: [] });
    expect(hooks.map((r) => r.name)).toEqual(["useProjects", "useFlag"]);
    const stores = buildInventory(analyze(files), { kinds: ["stores"], tokenFiles: [] });
    expect(stores.map((r) => [r.name, r.path])).toEqual([["useProjects", "src/store/projects.ts"]]);
    const tokens = buildInventory(analyze(files), {
      kinds: ["tokens"],
      tokenFiles: ["src/styles/**/*.css"],
    });
    expect(tokens.map((r) => [r.name, r.line])).toEqual([
      ["--color-bg", 2],
      ["--space-1", 3],
    ]);
  });

  it("maps paths to layers when a mapper is given and defaults to a dash", () => {
    const rows = buildInventory(analyze(files), {
      kinds: ["components"],
      tokenFiles: [],
      layerOf: (p) => (p.startsWith("src/ui/") ? "shared" : undefined),
    });
    expect(rows.map((r) => r.layer)).toEqual(["-", "shared", "shared"]);
  });

  it("returns everything for kind all in a stable order", () => {
    const rows = buildInventory(analyze(files), {
      kinds: ["all"],
      tokenFiles: ["src/styles/**/*.css"],
    });
    expect(new Set(rows.map((r) => r.kind))).toEqual(
      new Set(["component", "hook", "store", "token"]),
    );
    expect(rows).toEqual(
      [...rows].sort(
        (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name),
      ),
    );
  });
});
