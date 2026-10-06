import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArchitectureCheck } from "../src/application/checks/architecture-check.js";
import { MemoryWorkspace } from "../src/application/checks/memory-workspace.js";
import { engineValidators } from "../src/application/engines/index.js";
import {
  type ArchitectureConfig,
  parseArchitectureConfig,
} from "../src/domain/architecture/config.js";
import { parsePatternsCatalog } from "../src/domain/architecture/patterns.js";
import { checkPlannedGraph } from "../src/domain/architecture/planned.js";
import { presetIds, recommendPreset } from "../src/domain/architecture/presets.js";
import { registerFrontsmith } from "../src/index.js";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../src/infrastructure/analysis/graph-builder.js";
import { packageRoot } from "../src/infrastructure/packs/adapter-loader.js";
import { loadPatternsCatalog } from "../src/infrastructure/packs/catalog-loader.js";
import { loadShippedPacks } from "../src/infrastructure/packs/loader.js";
import { compose } from "../src/interface/composition.js";
import { cliRun } from "./helpers/cli.js";
import { createHarness } from "./helpers/harness.js";
import { validateAgainstSchema } from "./helpers/json-schema.js";
import { tempWorkspace } from "./helpers/workspace.js";

const deps = { analyzer: new DefaultFileAnalyzer(), graphBuilder: new DefaultImportGraphBuilder() };
const presetFile = (id: string) => join(packageRoot(), "presets", "architecture", `${id}.json`);
const loadPreset = async (id: string): Promise<ArchitectureConfig> => {
  const parsed = parseArchitectureConfig(JSON.parse(await readFile(presetFile(id), "utf8")));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

const FSD_TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
});

/** A feature-sliced project with exactly one violation of every checkable kind. */
const FSD_FILES: Record<string, string> = {
  "tsconfig.json": FSD_TSCONFIG,
  "package.json": JSON.stringify({ name: "fsd", dependencies: { zustand: "5.0.0" } }),
  // clean: app -> pages through the public API, pages -> widgets, widgets -> shared
  "src/app/main.tsx": 'import { Home } from "@/pages/home";\nexport const main = Home;\n',
  "src/pages/home/index.ts": 'export { Home } from "./ui/Home";\n',
  // publicApi: deep import of an entity internals
  "src/pages/home/ui/Home.tsx":
    'import { Header } from "@/widgets/header";\nimport { helper } from "@/entities/user/lib/helper";\nexport const Home = () => [Header, helper];\n',
  "src/widgets/header/index.ts": 'export { Header } from "./ui/Header";\n',
  "src/widgets/header/ui/Header.tsx":
    'import { Card } from "@/shared/ui/Card";\nexport const Header = Card;\n',
  "src/entities/user/index.ts": 'export { store } from "./model/store";\n',
  "src/entities/user/model/store.ts": "export const store = {};\n",
  "src/entities/user/lib/helper.ts": "export const helper = 1;\n",
  // direction: shared may not import entities
  "src/shared/lib/format.ts":
    'import { store } from "../../entities/user";\nexport const f = store;\n',
  // crossSlice: login imports signup, both slices of features
  "src/features/login/index.ts":
    'import { signup } from "@/features/signup";\nexport const login = signup;\n',
  "src/features/signup/index.ts": "export const signup = 1;\n",
  // roles: a presentational shared/ui file imports a state library
  "src/shared/ui/Card.tsx": 'import create from "zustand";\nexport const Card = create;\n',
  // cycles: one three-file cycle and one two-file cycle (each reported once)
  "src/entities/cycle/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
  "src/entities/cycle/b.ts": 'import { c } from "./c";\nexport const b = c;\n',
  "src/entities/cycle/c.ts": 'import { a } from "./a";\nexport const c = a;\n',
  "src/entities/pair/d.ts": 'import { e } from "./e";\nexport const d = e;\n',
  "src/entities/pair/e.ts": 'import { d } from "./d";\nexport const e = d;\n',
  // a type-only cycle is erased at runtime and is not reported
  "src/entities/types/x.ts": 'import type { Y } from "./y";\nexport type X = Y;\n',
  "src/entities/types/y.ts": 'import type { X } from "./x";\nexport type Y = X;\n',
  // unmapped: under a source root but in no layer
  "src/misc/orphan.ts": "export const orphan = 1;\n",
  // ignored by the config
  "src/shared/lib/format.test.ts":
    'import { store } from "../../entities/user";\nexport const t = store;\n',
};

describe("architecture presets", () => {
  it("ships exactly the four presets of the spec, each a valid architecture config", async () => {
    expect([...presetIds]).toEqual(["feature-sliced", "hexagonal", "layered", "atomic"]);
    const files = (await readdir(join(packageRoot(), "presets", "architecture"))).sort();
    expect(files).toEqual(["atomic.json", "feature-sliced.json", "hexagonal.json", "layered.json"]);
    for (const id of presetIds) {
      const config = await loadPreset(id);
      expect(config.preset).toBe(id);
    }
  });

  it("feature-sliced matches the layout of spec 14.1", async () => {
    const config = await loadPreset("feature-sliced");
    expect(config.layers.map((l) => l.name)).toEqual([
      "app",
      "pages",
      "widgets",
      "features",
      "entities",
      "shared",
    ]);
    expect(config.allow.app).toEqual(["pages", "widgets", "features", "entities", "shared"]);
    expect(config.allow.shared).toEqual([]);
    expect(config.allowSameLayer).toEqual(["app", "shared"]);
    expect(config.slices).toEqual({
      layers: ["pages", "widgets", "features", "entities"],
      depth: 1,
      publicApi: ["index.ts", "index.tsx", "index.js"],
    });
  });

  it("hexagonal lets domain import nothing and ui reach only application", async () => {
    const config = await loadPreset("hexagonal");
    expect(config.layers.map((l) => l.name)).toEqual([
      "domain",
      "application",
      "infrastructure",
      "ui",
    ]);
    expect(config.allow.domain).toEqual([]);
    expect(config.allow.application).toEqual(["domain"]);
    expect(config.allow.infrastructure).toEqual(["application", "domain"]);
    expect(config.allow.ui).toEqual(["application"]);
  });

  it("layered follows pages, components, hooks, services, lib and atomic declares five levels", async () => {
    const layered = await loadPreset("layered");
    expect(layered.layers.map((l) => l.name)).toEqual([
      "pages",
      "components",
      "hooks",
      "services",
      "lib",
    ]);
    expect(layered.allow.lib).toEqual([]);
    const atomic = await loadPreset("atomic");
    expect(atomic.atomic?.levels).toEqual([
      "atoms",
      "molecules",
      "organisms",
      "templates",
      "pages",
    ]);
  });

  it("recommends the preset the project layout suggests", () => {
    expect(recommendPreset(["src/entities/a/index.ts", "src/shared/x.ts"])).toBe("feature-sliced");
    expect(recommendPreset(["src/domain/a.ts", "src/application/b.ts"])).toBe("hexagonal");
    expect(recommendPreset(["src/components/atoms/Button.tsx"])).toBe("atomic");
    expect(recommendPreset(["src/entities/a.ts"])).toBe("layered");
    expect(recommendPreset([])).toBe("layered");
  });
});

describe("architecture schema", () => {
  const load = async () =>
    JSON.parse(
      await readFile(join(packageRoot(), "schemas", "architecture.schema.json"), "utf8"),
    ) as Record<string, unknown>;

  it("accepts the presets and agrees with the hand-written validator on shape errors", async () => {
    const schema = await load();
    for (const id of presetIds) {
      const raw = JSON.parse(await readFile(presetFile(id), "utf8"));
      expect(validateAgainstSchema(schema, raw), id).toEqual([]);
      expect(parseArchitectureConfig(raw).ok, id).toBe(true);
    }
    const bad: unknown[] = [
      {},
      { schemaVersion: 2, layers: [{ name: "a", paths: ["src/a/**"] }], allow: {} },
      { schemaVersion: 1, layers: [], allow: {} },
      { schemaVersion: 1, layers: [{ name: "A", paths: ["x"] }], allow: {} },
      { schemaVersion: 1, layers: [{ name: "a", paths: [] }], allow: {} },
      { schemaVersion: 1, layers: [{ name: "a", paths: ["x/**"] }], allow: {}, extra: true },
      { schemaVersion: 1, layers: [{ name: "a", paths: ["x/**"] }], allow: {}, aliases: "yes" },
      {
        schemaVersion: 1,
        layers: [{ name: "a", paths: ["x/**"] }],
        allow: {},
        slices: { layers: ["a"], depth: 0, publicApi: [] },
      },
    ];
    for (const raw of bad) {
      expect(validateAgainstSchema(schema, raw).length, JSON.stringify(raw)).toBeGreaterThan(0);
      expect(parseArchitectureConfig(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

describe("architecture check over a feature-sliced project", () => {
  const run = async (config: ArchitectureConfig, files = FSD_FILES, paths?: string[]) =>
    runArchitectureCheck(
      { fs: new MemoryWorkspace(files), config, ...(paths ? { paths } : {}) },
      deps,
    );

  it("reports exactly the expected violations, each cycle once, with rule ids", async () => {
    const config = await loadPreset("feature-sliced");
    const result = await run({ ...config, ignore: ["**/*.test.*"] });
    expect(result.violations.map((v) => `${v.ruleId} ${v.check} ${v.file}`)).toEqual([
      "FS-ARC-004 cycles src/entities/cycle/a.ts",
      "FS-ARC-004 cycles src/entities/pair/d.ts",
      "FS-ARC-002 crossSlice src/features/login/index.ts",
      "FS-ARC-007 unmapped src/misc/orphan.ts",
      "FS-ARC-003 publicApi src/pages/home/ui/Home.tsx",
      "FS-ARC-001 direction src/shared/lib/format.ts",
      "FS-ARC-005 roles src/shared/ui/Card.tsx",
    ]);
    const cycle = result.violations.find((v) => v.file === "src/entities/cycle/a.ts");
    expect(cycle?.detail).toBe(
      "import cycle: src/entities/cycle/a.ts -> src/entities/cycle/b.ts -> src/entities/cycle/c.ts",
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.byCheck).toMatchObject({
      direction: 1,
      crossSlice: 1,
      publicApi: 1,
      cycles: 2,
      roles: 1,
      atomic: 0,
      unmapped: 1,
    });
    expect(result.violations.every((v) => v.line >= 1 && v.column >= 1)).toBe(true);
  });

  it("applies the ignore globs from the config", async () => {
    const config = await loadPreset("feature-sliced");
    const withTests = await run({ ...config, ignore: [] });
    expect(withTests.violations.some((v) => v.file.endsWith("format.test.ts"))).toBe(true);
    const without = await run({ ...config, ignore: ["**/*.test.*"] });
    expect(without.violations.some((v) => v.file.endsWith("format.test.ts"))).toBe(false);
  });

  it("resolves tsconfig aliases and treats them as packages when aliases is none", async () => {
    const config = await loadPreset("feature-sliced");
    const files = {
      ...FSD_FILES,
      "src/shared/lib/alias.ts":
        'import { store } from "@/entities/user";\nexport const z = store;\n',
    };
    const viaAlias = await run({ ...config, ignore: ["**/*.test.*"] }, files);
    expect(
      viaAlias.violations.some((v) => v.check === "direction" && v.file.endsWith("alias.ts")),
    ).toBe(true);
    const noAlias = await run({ ...config, aliases: "none", ignore: ["**/*.test.*"] }, files);
    expect(noAlias.violations.some((v) => v.file.endsWith("alias.ts"))).toBe(false);
  });

  it("restricts findings to the requested paths while still analysing the whole workspace", async () => {
    const config = await loadPreset("feature-sliced");
    const result = await run({ ...config, ignore: ["**/*.test.*"] }, FSD_FILES, ["src/shared/**"]);
    expect(result.violations.map((v) => v.file)).toEqual([
      "src/shared/lib/format.ts",
      "src/shared/ui/Card.tsx",
    ]);
  });

  it("is clean for a conforming project and reports REVIEW for minor findings only", async () => {
    const config = await loadPreset("feature-sliced");
    const clean = await run(config, {
      "src/app/main.tsx": 'import { a } from "../shared/a";\nexport const m = a;\n',
      "src/shared/a.ts": "export const a = 1;\n",
    });
    expect(clean.verdict).toBe("PASS");
    expect(clean.violations).toEqual([]);
    const minor = await run(config, { "src/misc/orphan.ts": "export const o = 1;\n" });
    expect(minor.verdict).toBe("REVIEW");
  });

  it("flags an atomic level that imports a higher level once, not twice", async () => {
    const config = await loadPreset("atomic");
    const result = await run(config, {
      "src/components/atoms/Button.tsx":
        'import { Card } from "../molecules/Card";\nexport const Button = Card;\n',
      "src/components/molecules/Card.tsx":
        'import { Button } from "../atoms/Button";\nexport const Card = Button;\n',
    });
    const atomic = result.violations.filter((v) => v.check === "atomic");
    expect(atomic.map((v) => `${v.ruleId} ${v.file}`)).toEqual([
      "FS-ARC-006 src/components/atoms/Button.tsx",
    ]);
    expect(result.violations.filter((v) => v.check === "direction")).toEqual([]);
  });

  it("builds a layer graph where violating edges are marked", async () => {
    const config = await loadPreset("feature-sliced");
    const result = await run({ ...config, ignore: ["**/*.test.*"] });
    const shared = result.graph.edges.find((e) => e.from === "shared" && e.to === "entities");
    expect(shared).toMatchObject({ violating: true });
    const ok = result.graph.edges.find((e) => e.from === "app" && e.to === "pages");
    expect(ok).toMatchObject({ violating: false, count: 1 });
  });
});

describe("planned graph check (G3)", () => {
  it("maps planned files to layers and judges planned imports", async () => {
    const config = await loadPreset("feature-sliced");
    const violations = checkPlannedGraph(config, {
      files: [
        "src/features/cart/ui/Cart.tsx",
        "src/features/cart/index.ts",
        "src/entities/product/index.ts",
        "src/entities/product/lib/format.ts",
        "src/shared/lib/money.ts",
        "src/lib/rogue.ts",
      ],
      imports: [
        { from: "src/features/cart/ui/Cart.tsx", to: "src/entities/product" },
        { from: "src/features/cart/ui/Cart.tsx", to: "src/entities/product/lib/format.ts" },
        { from: "src/entities/product/index.ts", to: "src/features/cart/index.ts" },
        { from: "src/shared/lib/money.ts", to: "zustand" },
      ],
    });
    expect(violations.map((v) => `${v.check} ${v.file}`)).toEqual([
      "direction src/entities/product/index.ts",
      "publicApi src/features/cart/ui/Cart.tsx",
      "unmapped src/lib/rogue.ts",
    ]);
  });

  it("accepts a conforming plan", async () => {
    const config = await loadPreset("feature-sliced");
    expect(
      checkPlannedGraph(config, {
        files: ["src/features/a/index.ts", "src/shared/x.ts"],
        imports: [{ from: "src/features/a/index.ts", to: "src/shared/x.ts" }],
      }),
    ).toEqual([]);
  });
});

describe("patterns catalog", () => {
  it("ships the 18 fixed pattern ids and every verifying rule exists", async () => {
    const catalog = await loadPatternsCatalog();
    expect(catalog.patterns.map((p) => p.id)).toEqual([
      "PAT-CONTAINER-PRESENTATIONAL",
      "PAT-HEADLESS-HOOK",
      "PAT-COMPOUND",
      "PAT-SLOTS",
      "PAT-POLYMORPHIC-AS",
      "PAT-VARIANT-MAP",
      "PAT-CONTROLLED-UNCONTROLLED",
      "PAT-UI-STATE-MACHINE",
      "PAT-API-ADAPTER",
      "PAT-REPOSITORY",
      "PAT-QUERY-CACHE",
      "PAT-OPTIMISTIC-COMMAND",
      "PAT-PROVIDER-INJECTION",
      "PAT-FEATURE-SLICED",
      "PAT-HEXAGONAL",
      "PAT-ATOMIC",
      "PAT-ERROR-BOUNDARY",
      "PAT-FORM-SCHEMA",
    ]);
    const packs = await loadShippedPacks(engineValidators);
    const ruleIds = new Set(packs.flatMap((pack) => pack.rules.map((rule) => rule.id)));
    for (const pattern of catalog.patterns)
      for (const id of pattern.verifiedBy)
        expect(ruleIds.has(id), `${pattern.id} ${id}`).toBe(true);
    const byId = Object.fromEntries(catalog.patterns.map((p) => [p.id, p.verifiedBy]));
    expect(byId["PAT-FEATURE-SLICED"]).toEqual(["FS-ARC-001", "FS-ARC-002", "FS-ARC-003"]);
    expect(byId["PAT-COMPOUND"]).toEqual([]);
    expect(byId["PAT-VARIANT-MAP"]).toEqual(["FS-CMP-002", "FS-TW-001"]);
  });

  it("rejects malformed entries, duplicate ids and unknown keys", () => {
    const entry = {
      id: "PAT-X-Y",
      name: "n",
      intent: "i",
      useWhen: ["a"],
      avoidWhen: ["b"],
      structure: "s",
      verifiedBy: [],
      frameworks: ["all"],
    };
    expect(parsePatternsCatalog({ schemaVersion: 1, patterns: [entry] }).ok).toBe(true);
    for (const raw of [
      { schemaVersion: 1, patterns: [entry, entry] },
      { schemaVersion: 1, patterns: [{ ...entry, id: "pat-x" }] },
      { schemaVersion: 1, patterns: [{ ...entry, extra: 1 }] },
      { schemaVersion: 1, patterns: [{ ...entry, verifiedBy: ["nope"] }] },
      { schemaVersion: 1, patterns: [{ ...entry, useWhen: [] }] },
      { schemaVersion: 2, patterns: [entry] },
      [],
    ])
      expect(parsePatternsCatalog(raw).ok, JSON.stringify(raw)).toBe(false);
  });

  it("does not point to the research documents", async () => {
    const text = await readFile(join(packageRoot(), "catalog", "patterns.json"), "utf8");
    expect(text).not.toMatch(/\b(?:METH|FID)\s*§|frontend-agent-engineering|fidelidad-ui/);
  });
});

describe("architecture surfaces", () => {
  it("fs_architecture_check returns test-results first, then mermaid, then a table", async () => {
    const ws = await tempWorkspace({
      ...Object.fromEntries(
        Object.entries(FSD_FILES).filter(([path]) => path !== "src/shared/lib/format.test.ts"),
      ),
      ".frontsmith/architecture.json": await readFile(presetFile("feature-sliced"), "utf8"),
    });
    try {
      const harness = createHarness(() => ws.root);
      registerFrontsmith(harness.api, { composition: compose() });
      const result = await harness.callTool("fs_architecture_check", {}, ws.root);
      const kinds = result.content.map((c) => (c.type === "ui" ? c.block.kind : c.type));
      expect(kinds).toEqual(["text", "test-results", "mermaid", "table"]);
      expect(result.content[0]).toMatchObject({ type: "text" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Verdict: FAIL");
      expect(text).toContain("FS-ARC-001");
      const narrowed = await harness.callTool(
        "fs_architecture_check",
        { paths: ["src/shared/**"] },
        ws.root,
      );
      expect((narrowed.content[0] as { text: string }).text).not.toContain("src/features/login");
      const bad = await harness.callTool("fs_architecture_check", { paths: ["../x"] }, ws.root);
      expect(bad.isError).toBe(true);
      const unknown = await harness.callTool("fs_architecture_check", { nope: 1 }, ws.root);
      expect(unknown.isError).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("is BLOCKED with a hint when there is no architecture config", async () => {
    const ws = await tempWorkspace({ "src/a.ts": "export const a = 1;\n" });
    try {
      const harness = createHarness(() => ws.root);
      registerFrontsmith(harness.api, { composition: compose() });
      const result = await harness.callTool("fs_architecture_check", {}, ws.root);
      expect((result.content[0] as { text: string }).text).toContain("/frontsmith:arch init");
      expect(result.isError).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("/frontsmith:arch init writes a chosen preset once and never overwrites", async () => {
    const ws = await tempWorkspace({
      "src/entities/a/index.ts": "export const a = 1;\nexport {};\n",
    });
    try {
      const harness = createHarness(() => ws.root);
      registerFrontsmith(harness.api, { composition: compose() });
      const bad = await harness.callCommand("arch", "init nope", "s1");
      expect(bad).toContain("Usage");
      const headless = await harness.callCommand("arch", "init", "s1");
      expect(headless).toContain("/frontsmith:arch init layered");
      await expect(
        readFile(join(ws.root, ".frontsmith/architecture.json"), "utf8"),
      ).rejects.toThrow();
      const ok = await harness.callCommand("arch", "init hexagonal", "s1");
      expect(ok).toContain(".frontsmith/architecture.json");
      const written = JSON.parse(
        await readFile(join(ws.root, ".frontsmith/architecture.json"), "utf8"),
      );
      expect(written.preset).toBe("hexagonal");
      const again = await harness.callCommand("arch", "init atomic", "s1");
      expect(again).toContain("already exists");
      const check = await harness.callCommand("arch", "check", "s1");
      expect(check).toContain("Architecture check");
      expect(await harness.callCommand("arch", "", "s1")).toContain("Usage");
      await expect(harness.callCommand("arch", "check")).rejects.toThrow();
    } finally {
      await ws.cleanup();
    }
  });

  it("CLI arch exits 1 on violations, 0 when clean and 3 without a config", async () => {
    const dirty = await tempWorkspace({
      ...FSD_FILES,
      ".frontsmith/architecture.json": await readFile(presetFile("feature-sliced"), "utf8"),
    });
    const clean = await tempWorkspace({
      "src/shared/a.ts": "export const a = 1;\n",
      ".frontsmith/architecture.json": await readFile(presetFile("feature-sliced"), "utf8"),
    });
    const none = await tempWorkspace({ "src/a.ts": "export const a = 1;\n" });
    try {
      const a = await cliRun(["arch", dirty.root, "--json"]);
      expect(a.code).toBe(1);
      expect(JSON.parse(a.stdout).violations.length).toBeGreaterThan(0);
      expect((await cliRun(["arch", clean.root])).code).toBe(0);
      expect((await cliRun(["arch", none.root])).code).toBe(3);
      expect((await cliRun(["arch", "--bogus"])).code).toBe(2);
    } finally {
      await Promise.all([dirty.cleanup(), clean.cleanup(), none.cleanup()]);
    }
  });
});
