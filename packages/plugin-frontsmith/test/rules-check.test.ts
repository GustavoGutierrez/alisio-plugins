import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../src/application/checks/memory-workspace.js";
import { defaultFixtureStack } from "../src/application/checks/rule-fixtures.js";
import { type RulesCheckInput, runRulesCheck } from "../src/application/checks/rules-check.js";
import { engines } from "../src/application/engines/index.js";
import { defaultConfig } from "../src/domain/config/defaults.js";
import type { ResolvedRule } from "../src/domain/rules/model.js";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../src/infrastructure/analysis/graph-builder.js";
import { loadAriaCatalog } from "../src/infrastructure/packs/catalog-loader.js";

const deps = { analyzer: new DefaultFileAnalyzer(), graphBuilder: new DefaultImportGraphBuilder() };
const aria = await loadAriaCatalog();

const rule = (id: string, patch: Partial<ResolvedRule> = {}): ResolvedRule => ({
  id,
  title: id,
  severity: "minor",
  kind: "deterministic",
  category: "layout",
  engine: "css-declaration",
  params: { property: "^color$", value: "^red$" },
  files: ["**/*.css"],
  appliesWhen: {},
  message: "msg",
  fix: "fix",
  rationale: "r",
  source: "s",
  suppressible: true,
  tags: [],
  packId: "fs-test",
  origin: "shipped:fs-test",
  trail: [],
  ...patch,
});

const run = (
  files: Record<string, string>,
  rules: ResolvedRule[],
  extra: Partial<RulesCheckInput> = {},
) =>
  runRulesCheck(
    {
      fs: new MemoryWorkspace(files),
      rules,
      stack: defaultFixtureStack(),
      config: defaultConfig(),
      aria,
      today: "2026-06-01",
      ...extra,
    },
    deps,
  );

describe("runRulesCheck", () => {
  it("aggregates findings, sorts them and assigns ids", async () => {
    const result = await run(
      { "b.css": ".a { color: red; }\n", "a.css": ".a {\n  color: red;\n}\n.b { color: red; }\n" },
      [rule("FS-T-001", { severity: "major" })],
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.map((f) => `${f.id} ${f.file}:${f.line}`)).toEqual([
      "F-0001 a.css:2",
      "F-0002 a.css:4",
      "F-0003 b.css:1",
    ]);
    expect(result.checks).toEqual([
      {
        ruleId: "FS-T-001",
        packId: "fs-test",
        required: true,
        status: "FAIL",
        summary: "3 findings",
        findings: 3,
      },
    ]);
    expect(result.coverage).toEqual({ required: 1, executed: 1, pending: 0 });
  });

  it("maps severity and kind to status: minor is REVIEW, heuristic is capped, nit passes with a note", async () => {
    const files = { "a.css": ".a { color: red; }\n" };
    expect((await run(files, [rule("FS-T-001", { severity: "minor" })])).verdict).toBe("REVIEW");
    expect(
      (await run(files, [rule("FS-T-001", { severity: "blocker", kind: "heuristic" })])).verdict,
    ).toBe("REVIEW");
    const nit = await run(files, [rule("FS-T-001", { severity: "nit" })]);
    expect(nit.verdict).toBe("PASS");
    expect(nit.findings).toHaveLength(1);
    expect(nit.findings[0]?.status).toBe("PASS");
  });

  it("honours a valid suppression for the next line and keeps ignored ones as findings", async () => {
    const files = {
      "a.css":
        "/* frontsmith-disable-next-line FS-T-001 -- legacy palette kept for now */\n.a { color: red; }\n.b { color: red; }\n",
    };
    const result = await run(files, [rule("FS-T-001")]);
    const [first, second] = result.findings;
    expect(first).toMatchObject({
      line: 2,
      status: "PASS",
      note: "suppressed: legacy palette kept for now",
    });
    expect(second).toMatchObject({ line: 3, status: "REVIEW" });
    const locked = await run(files, [rule("FS-T-001", { suppressible: false })]);
    expect(locked.findings[0]).toMatchObject({ line: 2, status: "REVIEW" });
    expect(locked.findings[0]?.note).toMatch(/suppression ignored/);
    const major = await run(files, [rule("FS-T-001", { severity: "major" })]);
    expect(major.findings[0]).toMatchObject({ status: "FAIL" });
  });

  it("lets an active waiver resolve a finding of any severity and lists expired waivers", async () => {
    const waiver = (id: string, expires: string) => ({
      id,
      ruleId: "FS-T-001",
      paths: ["src/legacy/**"],
      reason: "legacy",
      approvedBy: "human" as const,
      createdAt: "2026-01-01T00:00:00Z",
      expires,
    });
    const files = {
      "src/legacy/a.css": ".a { color: red; }\n",
      "src/new/b.css": ".a { color: red; }\n",
    };
    const result = await run(
      files,
      [rule("FS-T-001", { severity: "blocker", suppressible: false })],
      { waivers: [waiver("W-001", "2026-12-31"), waiver("W-002", "2026-01-31")] },
    );
    expect(result.findings.map((f) => [f.file, f.status, f.note])).toEqual([
      ["src/legacy/a.css", "PASS", "waived: W-001"],
      ["src/new/b.css", "FAIL", undefined],
    ]);
    expect(result.expiredWaivers.map((w) => w.id)).toEqual(["W-002"]);
  });

  it("filters by paths, packs, categories and minimum severity without hiding analysis", async () => {
    const files = { "src/a.css": ".a { color: red; }\n", "lib/b.css": ".a { color: red; }\n" };
    const rules = [
      rule("FS-T-001", { severity: "major", category: "layout" }),
      rule("FS-U-001", { packId: "fs-other", severity: "nit", category: "tokens" }),
    ];
    expect((await run(files, rules, { paths: ["src/**"] })).findings.map((f) => f.file)).toEqual([
      "src/a.css",
      "src/a.css",
    ]);
    expect((await run(files, rules, { packs: ["fs-other"] })).checks.map((c) => c.ruleId)).toEqual([
      "FS-U-001",
    ]);
    expect(
      (await run(files, rules, { categories: ["tokens"] })).checks.map((c) => c.ruleId),
    ).toEqual(["FS-U-001"]);
    expect((await run(files, rules, { minSeverity: "major" })).checks.map((c) => c.ruleId)).toEqual(
      ["FS-T-001"],
    );
  });

  it("applies excludeFiles and the rule files globs", async () => {
    const files = {
      "src/a.css": ".a { color: red; }\n",
      "src/reset.css": ".a { color: red; }\n",
      "src/a.scss": ".a { color: red; }\n",
    };
    const result = await run(files, [
      rule("FS-T-001", {
        params: { property: "^color$", value: "^red$", excludeFiles: ["**/reset.css"] },
      }),
    ]);
    expect(result.findings.map((f) => f.file)).toEqual(["src/a.css"]);
  });

  it("reports unparsable files as REVIEW (FS-SRC-001) and never crashes", async () => {
    const result = await run({ "src/bad.tsx": "export const a = <div;\n" }, [
      rule("FS-T-002", {
        engine: "jsx-element",
        params: { element: "^div$" },
        files: ["**/*.tsx"],
      }),
    ]);
    const source = result.findings.find((f) => f.ruleId === "FS-SRC-001");
    expect(source).toMatchObject({ status: "REVIEW", file: "src/bad.tsx" });
    expect(result.verdict).toBe("REVIEW");
  });

  it("skips analysis of files above the size limit and says so", async () => {
    const fs = new MemoryWorkspace(
      { "big.css": `.a { color: red; }\n${"/* x */".repeat(10)}` },
      20,
    );
    const result = await runRulesCheck(
      {
        fs,
        rules: [rule("FS-T-001")],
        stack: defaultFixtureStack(),
        config: defaultConfig(),
        aria,
        today: "2026-06-01",
      },
      deps,
    );
    expect(result.skippedFiles).toEqual([
      { path: "big.css", reason: expect.stringContaining("larger than the analysis limit") },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("marks a crashing engine BLOCKED instead of throwing", async () => {
    const spy = vi.spyOn(engines["css-declaration"], "run").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const result = await run({ "a.css": ".a { color: red; }\n" }, [rule("FS-T-001")]);
      expect(result.checks[0]).toMatchObject({ status: "BLOCKED", summary: "engine failed: boom" });
      expect(result.verdict).toBe("BLOCKED");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports SKIPPED when an engine lacks its input, and SKIPPED when nothing runs", async () => {
    const guard = rule("FS-GOV-001", {
      engine: "diff-guard",
      params: { guard: "protected" },
      files: ["**/*"],
      severity: "blocker",
    });
    const skipped = await run({ "a.css": "" }, [guard]);
    expect(skipped.checks[0]).toMatchObject({
      status: "SKIPPED",
      summary: "requires unit diff",
      required: false,
    });
    expect(skipped.verdict).toBe("PASS");
    const none = await run({ "a.css": "" }, []);
    expect(none.verdict).toBe("SKIPPED");
    const advisory = await run({ "a.css": "" }, [
      rule("FS-DSN-UI01", { kind: "advisory", engine: "advisory", params: { guidance: "g" } }),
    ]);
    expect(advisory.checks).toEqual([]);
  });

  it("builds a stable result for the same input", async () => {
    const files = { "a.css": ".a { color: red; }\n", "b.css": ".a { color: red; }\n" };
    expect(await run(files, [rule("FS-T-001")])).toEqual(await run(files, [rule("FS-T-001")]));
  });
});

describe("engine behaviour beyond the fixtures", () => {
  const one = (
    id: string,
    engine: ResolvedRule["engine"],
    params: Record<string, unknown>,
    files: string[],
    severity: ResolvedRule["severity"] = "major",
  ) => rule(id, { engine, params, files, severity });
  const count = async (
    files: Record<string, string>,
    r: ResolvedRule,
    extra: Partial<RulesCheckInput> = {},
  ) => (await run(files, [r], extra)).findings.filter((f) => f.ruleId === r.id).length;

  it("jsx-element ignores elements with spread attributes when claiming something is missing", async () => {
    const r = one("FS-T-010", "jsx-element", { element: "^img$", lacksAttr: ["alt"] }, [
      "**/*.tsx",
    ]);
    expect(await count({ "a.tsx": "export const A = (p: object) => <img {...p} />;\n" }, r)).toBe(
      0,
    );
    expect(await count({ "a.tsx": "export const A = () => <img />;\n" }, r)).toBe(1);
  });

  it("template-element normalises event and binding syntax", async () => {
    const r = one("FS-T-011", "template-element", { element: "^div$", hasAttr: ["onClick"] }, [
      "**/*.vue",
      "**/*.svelte",
      "**/*.html",
    ]);
    for (const [path, text] of [
      ["a.vue", '<template><div @click="go"></div></template>'],
      ["a.vue", '<template><div v-on:click="go"></div></template>'],
      ["a.svelte", "<div on:click={go}></div>"],
      ["a.component.html", '<div (click)="go()"></div>'],
      ["a.html", '<div onclick="go()"></div>'],
    ] as const)
      expect(await count({ [path]: text }, r), `${path}: ${text}`).toBe(1);
    expect(await count({ "a.vue": "<template><div></div></template>" }, r)).toBe(0);
  });

  it("css-declaration resolves nested selectors and per-block siblings", async () => {
    const r = one(
      "FS-T-012",
      "css-declaration",
      {
        property: "^height$",
        selector: "^\\.card \\.title$",
        requireSiblingProperty: { property: "^overflow$" },
      },
      ["**/*.scss"],
    );
    expect(
      await count(
        {
          "a.scss":
            ".card { .title { height: 10px; overflow: hidden; } .other { height: 1px; overflow: hidden; } }\n",
        },
        r,
      ),
    ).toBe(1);
    expect(
      await count(
        { "a.scss": ".card { .title { height: 10px; } .other { overflow: hidden; } }\n" },
        r,
      ),
    ).toBe(0);
  });

  it("css-raw-value ignores url(), strings, var() and definition files", async () => {
    const r = one(
      "FS-T-013",
      "css-raw-value",
      { properties: ".", kinds: ["color", "length"], allow: ["0"] },
      ["**/*.css"],
    );
    expect(
      await count(
        {
          "src/a.css":
            '.a { background: url(#abc); content: "#fff"; color: var(--c); margin: 0; }\n',
        },
        r,
      ),
    ).toBe(0);
    expect(await count({ "src/a.css": ".a { border: 1px solid red; }\n" }, r)).toBe(1);
    expect(await count({ "src/styles/tokens.css": ":root { --c: #fff; }\n" }, r)).toBe(0);
    expect(await count({ "src/a.css": ".a { color: rgb(1 2 3); }\n" }, r)).toBe(1);
  });

  it("class-token separates variants and understands template class attributes", async () => {
    const conflicts = one("FS-T-014", "class-token", { conflicts: [["p-*", "px-*"]] }, [
      "**/*.tsx",
      "**/*.vue",
    ]);
    expect(
      await count(
        { "a.tsx": 'export const A = () => <div className="p-2 md:p-4" />;\n' },
        conflicts,
      ),
    ).toBe(0);
    expect(
      await count(
        { "a.tsx": 'export const A = () => <div className="md:p-2 md:px-4" />;\n' },
        conflicts,
      ),
    ).toBe(1);
    const dynamic = one("FS-T-015", "class-token", { dynamicInterpolation: true }, [
      "**/*.tsx",
      "**/*.vue",
    ]);
    expect(
      await count({ "a.vue": '<template><div class="bg-{{ c }}-500"></div></template>' }, dynamic),
    ).toBe(1);
    expect(
      await count(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is source text under test
        { "a.tsx": "export const A = ({ c }: { c: string }) => <div className={`${c} p-2`} />;\n" },
        dynamic,
      ),
    ).toBe(0);
  });

  it("component-api skips forwardRef checks for React 19 and propsTyped for JavaScript", async () => {
    const forward = one(
      "FS-T-016",
      "component-api",
      { checks: ["forwardRefPrimitives"], forwardRefPrimitives: ["**/ui/**"] },
      ["**/*.tsx"],
    );
    const source = {
      "src/ui/I.tsx": "export function I(p: { a: string }) { return <input />; }\n",
    };
    expect(
      await count(source, forward, { stack: defaultFixtureStack({ frameworkVersion: "18.3.1" }) }),
    ).toBe(1);
    expect(
      await count(source, forward, {
        stack: defaultFixtureStack({ frameworkVersion: "^19.1.0 (declared)" }),
      }),
    ).toBe(0);
    const typed = one("FS-T-017", "component-api", { checks: ["propsTyped"] }, [
      "**/*.jsx",
      "**/*.tsx",
    ]);
    expect(await count({ "a.jsx": "export function A(props) { return <div />; }\n" }, typed)).toBe(
      0,
    );
    expect(await count({ "a.tsx": "export function A(props) { return <div />; }\n" }, typed)).toBe(
      1,
    );
  });

  it("import-specifier tests resolved paths, honours allow and skips type-only imports", async () => {
    const r = one("FS-T-018", "import-specifier", { forbid: "^src/legacy/", allow: "ok" }, [
      "**/*.ts",
    ]);
    const files = {
      "src/a.ts":
        'import { x } from "./legacy/x";\nimport type { Y } from "./legacy/y";\nexport { x };\n',
      "src/legacy/x.ts": "export const x = 1;\n",
      "src/legacy/y.ts": "export type Y = 1;\n",
    };
    expect(await count(files, r)).toBe(1);
    expect(
      await count(
        { ...files, "src/a.ts": 'import { x } from "./legacy/x"; // ok\nexport { x };\n' },
        { ...r, params: { forbid: "^src/legacy/", allow: "legacy/x" } },
      ),
    ).toBe(0);
  });

  it("token-file treats @theme tokens as used and compares themes across files", async () => {
    const unused = one("FS-T-019", "token-file", { unused: true }, ["**/*.css"]);
    expect(
      await count(
        { "src/styles/t.css": "@theme {\n  --color-brand: #123;\n}\n:root {\n  --extra: 1;\n}\n" },
        unused,
      ),
    ).toBe(1);
    const parity = one("FS-T-020", "token-file", { themeParity: true }, ["**/*.css"]);
    const files = {
      "src/styles/light.css": '[data-theme="light"] { --a: 1; --b: 2; }\n',
      "src/styles/dark.css": '[data-theme="dark"] { --a: 1; }\n',
    };
    expect(await count(files, parity)).toBe(1);
  });

  it("diff-guard lets a moved test through and rejects a deleted one", async () => {
    const r = one("FS-T-021", "diff-guard", { guard: "testWeakening" }, ["**/*"]);
    const unit = (changes: unknown[]) =>
      ({
        changes,
        taskFiles: [],
        testPaths: [],
        allowedGeneratedPaths: [],
        scope: "task",
        sourceRoots: ["src"],
        protectedGlobs: [],
        approvedDependencies: [],
        rules: {},
      }) as never;
    const body = 'test("moves", () => {\n  expect(1).toBe(1);\n});\n';
    const deleted = { path: "src/a.test.ts", status: "D", before: body };
    expect(await count({}, r, { unit: unit([deleted]) })).toBe(1);
    expect(
      await count({}, r, {
        unit: unit([deleted, { path: "src/b.test.ts", status: "A", after: body }]),
      }),
    ).toBe(0);
    expect(
      await count({}, r, {
        unit: unit([
          {
            path: "src/a.test.ts",
            status: "M",
            before: body,
            after: body.replace("test(", "test.skip("),
          },
        ]),
      }),
    ).toBe(1);
    expect(
      await count({}, r, {
        unit: unit([
          {
            path: "vitest.config.ts",
            status: "M",
            before: "coverage: { thresholds: { lines: 80 } }",
            after: "coverage: { thresholds: { lines: 60 } }",
          },
        ]),
      }),
    ).toBe(1);
  });

  it("architecture evaluates cycles once per component and honours ignore globs", async () => {
    const config = {
      schemaVersion: 1,
      sourceRoots: ["src"],
      layers: [{ name: "all", paths: ["src/**"] }],
      allow: { all: [] },
      allowSameLayer: ["all"],
      ignore: ["**/*.test.ts"],
    } as const;
    const { parseArchitectureConfig } = await import("../src/domain/architecture/config.js");
    const parsed = parseArchitectureConfig(config);
    if (!parsed.ok) throw new Error("invalid");
    const r = one("FS-T-022", "architecture", { check: "cycles" }, ["**/*.ts"]);
    const files = {
      "src/a.ts": 'import "./b";\nimport "./c";\n',
      "src/b.ts": 'import "./a";\n',
      "src/c.ts": 'import "./a";\n',
      "src/x.test.ts": 'import "./y.test";\n',
      "src/y.test.ts": 'import "./x.test";\n',
    };
    expect(await count(files, r, { architecture: parsed.config })).toBe(1);
  });

  it("budget skips when a limit is unset and reports growth against the baseline", async () => {
    const config = {
      schemaVersion: 1,
      bundle: {
        dir: "dist",
        entryGlobs: ["dist/*.js"],
        cssGlobs: ["dist/*.css"],
        maxInitialJsGzipKb: null,
        maxInitialCssGzipKb: null,
        maxDeltaGzipKb: 1,
      },
      images: { globs: ["public/*.png"], maxBytes: 100, maxWidthPx: 100 },
      inlineData: { maxBytes: 10 },
    } as const;
    const input = { config, assets: [{ path: "dist/a.js", bytes: 5000, gzipBytes: 3000 }] };
    const js = one("FS-T-023", "budget", { kind: "initialJs" }, ["**/*"]);
    const skipped = await run({}, [js], { budget: input });
    expect(skipped.checks[0]).toMatchObject({ status: "SKIPPED" });
    const delta = one("FS-T-024", "budget", { kind: "delta" }, ["**/*"]);
    expect(await count({}, delta, { budget: input })).toBe(0);
    expect(
      await count({}, delta, { budget: { ...input, baseline: { initialJsGzipBytes: 1000 } } }),
    ).toBe(1);
  });
});
