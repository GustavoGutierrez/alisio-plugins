import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import { testJsonRenderer } from "../src/render/adapters/test-json/index.js";
import { assembleDocument } from "../src/render/assemble.js";
import { defaultAssetResolvers, resolveAssets } from "../src/render/assets.js";
import { buildThesis } from "../src/render/build.js";
import { createDefaultRegistry } from "../src/render/default-registry.js";
import type { ThesisDocument } from "../src/render/model.js";
import { RendererRegistry } from "../src/render/registry.js";
import type { SectionState } from "../src/types.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(cleanSamples);

const registry = () => new RendererRegistry().register(testJsonRenderer);
const base = (root: string, extra: Record<string, unknown> = {}) => ({
  root,
  format: "json",
  registry: registry(),
  env: {},
  cacheRoot: join(tmpdir(), "thesis-cache-unused"),
  ...extra,
});
const approved = (...ids: string[]): Record<string, SectionState> =>
  Object.fromEntries(ids.map((id) => [id, { status: "approved" } as SectionState]));

describe("the renderer port is sufficient: test-json renders the sample thesis", () => {
  it("builds the full model without any Typst type", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis(base(root, { scope: "full" }) as never);
    expect(outcome).toMatchObject({ ok: true, engine: "test-json", scope: "full" });
    const json = JSON.parse(await readFile(join(root, "build", "thesis.json"), "utf8"));
    expect(json.counts).toMatchObject({ heading: 6, figure: 2, table: 1, equation: 1 });
    expect([...json.bibliography.keys].sort()).toEqual([
      "garcia2019",
      "icontec2022",
      "ley15812012",
      "mintic2023",
      "perez2021",
      "rojas2020",
    ]);
    expect(Object.keys(json.figures)).toEqual(["fig-flujo", "fig-errores"]);
    expect(json.figures["fig-flujo"].resolved.format).toBe("mmd");
    expect(json.frontMatter.map((section: { role: string }) => section.role).sort()).toEqual([
      "abstract",
      "abstract-secondary",
    ]);
    expect(json.annexes).toHaveLength(1);
    expect(Object.keys(json.footnotes)).toHaveLength(1);
    expect(json.meta).toMatchObject({ languageCode: "es", region: "co", citationStyle: "apa-7" });
  });

  it("registry exposes adapters by id and format, and rejects duplicates", () => {
    const reg = createDefaultRegistry();
    expect(reg.list().map((r) => r.id)).toEqual(["typst-pdf", "chrome-pdf", "html-preview"]);
    expect(reg.byFormat("json")).toEqual([]);
    reg.register(testJsonRenderer);
    expect(reg.get("test-json")?.format).toBe("json");
    expect(() => reg.register(testJsonRenderer)).toThrow(/already registered/);
    expect(reg.get("typst-pdf")?.capabilities()).toMatchObject({ pdfa: true, extension: "pdf" });
  });

  it("reports a missing renderer for formats without an adapter", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis({
      ...base(root, { scope: "full", format: "docx" }),
    } as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings[0]?.message).toMatch(/No renderer .* "docx"/);
  });
});

describe("build scopes", () => {
  it("approved: only approved sections plus front matter; outside references degrade to text", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis(
      base(root, { scope: "approved", sections: approved("SEC-01") }) as never,
    );
    expect(outcome.ok).toBe(true);
    const json = JSON.parse(await readFile(join(root, "build", "thesis.json"), "utf8"));
    expect(json.body.map((s: { section: string }) => s.section)).toEqual(["SEC-01"]);
    expect(json.annexes).toEqual([]);
    expect(json.frontMatter).toHaveLength(2);
    expect(outcome.warnings.join("\n")).toMatch(/BLD-003 \d+ cross-reference/);
    expect(JSON.stringify(json.body)).toContain("«fig-flujo»");
  });

  it("section: one section's file, no front matter", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis(base(root, { scope: "section", section: "SEC-02" }) as never);
    expect(outcome.ok).toBe(true);
    const json = JSON.parse(await readFile(join(root, "build", "thesis.json"), "utf8"));
    expect(json.body.map((s: { section: string }) => s.section)).toEqual(["SEC-02"]);
    expect(json.frontMatter).toEqual([]);
  });

  it("section: fails when no chapter declares it", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis(base(root, { scope: "section", section: "SEC-09" }) as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings[0]?.message).toMatch(/No chapter file declares section SEC-09/);
    const needsId = await buildThesis(base(root, { scope: "section" }) as never);
    expect(needsId.findings[0]?.message).toMatch(/needs a section id/);
  });
});

describe("checks on the document model", () => {
  const run = async (root: string) =>
    runChecks(await loadProject(root), { gates: ["G7", "G8"] }).findings;

  it("the sample thesis passes XRF, MTH and HYG", async () => {
    const root = await sampleThesis();
    expect(
      (await run(root)).filter((f) => ["XRF", "MTH", "HYG", "BLD"].includes(f.code.slice(0, 3))),
    ).toEqual([]);
  });

  it("flags unresolved and duplicate labels, unreferenced floats, bad math and hygiene", async () => {
    const root = await sampleThesis();
    await writeFile(
      join(root, "chapters", "03-roto.md"),
      [
        "# Roto {#sec-metodologia}",
        "",
        "Ver @fig-fantasma y $\\input{x}$.",
        "",
        "![Pie.](figures/diagrams/flujo.mmd){#fig-extra}",
        "",
        "Pendiente: TODO. <div>x</div>",
        "",
      ].join("\n"),
    );
    const findings = await run(root);
    const by = (code: string) => findings.filter((f) => f.code === code);
    expect(by("XRF-001").map((f) => f.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@fig-fantasma"),
        expect.stringContaining("sec-metodologia is defined more than once"),
      ]),
    );
    expect(by("XRF-002")).toMatchObject([
      { severity: "warning", message: expect.stringContaining("fig-extra") },
    ]);
    expect(by("MTH-001")).toMatchObject([
      { gate: "G8", severity: "error", file: "chapters/03-roto.md", line: 3 },
    ]);
    expect(by("HYG-001").length).toBeGreaterThanOrEqual(2);
  });

  it("an unresolved reference blocks the build before any renderer runs", async () => {
    const root = await sampleThesis();
    await writeFile(join(root, "chapters", "03-roto.md"), "# R\n\nVer @tbl-fantasma.\n");
    const outcome = await buildThesis(base(root, { scope: "full" }) as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.engine).toBe("none");
    expect(outcome.findings.map((f) => f.code)).toContain("XRF-001");
  });

  it("BLD-001 reflects the last recorded build", async () => {
    const root = await sampleThesis();
    await writeFile(join(root, "chapters", "03-roto.md"), "# R\n\nVer @tbl-fantasma.\n");
    await buildThesis(base(root, { scope: "full" }) as never);
    expect((await run(root)).map((f) => f.code)).toContain("BLD-001");
    await rm(join(root, "chapters", "03-roto.md"));
    expect((await buildThesis(base(root, { scope: "full" }) as never)).ok).toBe(true);
    expect((await run(root)).map((f) => f.code)).not.toContain("BLD-001");
  });
});

describe("labels (LNG-002) and i18n", () => {
  it("falls back to English with LNG-002 for an unsupported language", async () => {
    const root = await sampleThesis();
    const brief = (await readFile(join(root, "thesis.yaml"), "utf8")).replace(
      "language: es-CO",
      "language: fr-FR",
    );
    await writeFile(join(root, "thesis.yaml"), brief);
    const assembled = assembleDocument(await loadProject(root));
    expect(assembled?.findings.map((f) => f.code)).toContain("LNG-002");
    expect(assembled?.document.strings.figure).toBe("Figure");
  });

  it("merges thesis/i18n.yaml over the shipped labels and warns about unknown keys", async () => {
    const root = await sampleThesis();
    await writeFile(join(root, "i18n.yaml"), "figure: Ilustración\nbogus: x\n");
    const assembled = assembleDocument(await loadProject(root));
    expect(assembled?.document.strings.figure).toBe("Ilustración");
    expect(assembled?.document.strings.table).toBe("Tabla");
    expect(assembled?.findings.filter((f) => f.code === "LNG-002")).toHaveLength(1);
  });

  it("adds abstract labels for the secondary abstract language", async () => {
    const root = await sampleThesis();
    const assembled = assembleDocument(await loadProject(root));
    expect(assembled?.document.strings["abstract@en"]).toBe("Abstract");
    expect(assembled?.document.strings["keywords@en"]).toBe("Keywords");
  });

  it("resolves the body font and spacing from the brief", async () => {
    const root = await sampleThesis();
    const brief = (await readFile(join(root, "thesis.yaml"), "utf8")).replace(
      "diagramTheme: neutral }",
      "diagramTheme: neutral, bodyFont: Arial, lineSpacing: 1.5 }",
    );
    await writeFile(join(root, "thesis.yaml"), brief);
    const meta = assembleDocument(await loadProject(root))?.document.meta;
    expect(meta).toMatchObject({ bodyFont: "Arial", lineSpacing: 1.5 });
  });
});

describe("asset service", () => {
  const empty = { figures: new Map() } as unknown as ThesisDocument;
  async function figureDoc(path: string, kind: "svg" | "raster" | "mermaid" | "chart") {
    return {
      ...empty,
      frontMatter: [],
      annexes: [],
      body: [
        {
          path: "chapters/x.md",
          role: "body",
          blocks: [{ kind: "figure", asset: { kind, path }, caption: [], line: 3 }],
        },
      ],
    } as unknown as ThesisDocument;
  }
  async function context() {
    const root = await sampleThesis();
    return { root, buildDir: join(root, "build"), cacheDir: join(root, "build", "cache") };
  }

  it("copies assets under a content-addressed name and reuses them", async () => {
    const ctx = await context();
    const doc = await figureDoc("figures/diagrams/flujo.mmd", "mermaid");
    expect(await resolveAssets(doc, ctx)).toEqual([]);
    const asset = (
      (doc.body[0]?.blocks ?? [])[0] as { asset: { resolved?: { file: string; text?: string } } }
    ).asset;
    expect(asset.resolved?.file).toMatch(/^figures\/[0-9a-f]{16}\.mmd$/);
    expect(asset.resolved?.text).toContain("flowchart LR");
    expect(await readFile(join(ctx.buildDir, asset.resolved?.file as string), "utf8")).toContain(
      "flowchart LR",
    );
  });

  it("reports a missing chart spec as FIG-001; resolvers stay pluggable", async () => {
    const ctx = await context();
    const findings = await resolveAssets(await figureDoc("figures/charts/a.vl.json", "chart"), ctx);
    expect(findings).toMatchObject([
      { code: "FIG-001", severity: "error", file: "chapters/x.md", line: 3 },
    ]);
    expect(findings[0]?.message).toMatch(/does not exist/);
    // Another resolver can be plugged in without touching anything else.
    const custom = {
      ...defaultAssetResolvers,
      chart: async () => ({ file: "figures/c.svg", sha256: "x", bytes: 1, format: "svg" as const }),
    };
    expect(
      await resolveAssets(await figureDoc("figures/charts/a.vl.json", "chart"), ctx, custom),
    ).toEqual([]);
  });

  it("rejects missing files, escaping paths, symlink escapes, hostile SVG and fake rasters", async () => {
    const ctx = await context();
    const bad = async (path: string, kind: "svg" | "raster" | "mermaid") =>
      (await resolveAssets(await figureDoc(path, kind), ctx)).map((f) => f.message);
    expect(await bad("figures/images/none.png", "raster")).toEqual([
      expect.stringContaining("does not exist"),
    ]);
    expect(await bad("figures/../../x.png", "raster")).toEqual([
      expect.stringContaining("outside the thesis folder"),
    ]);

    await mkdir(join(ctx.root, "figures", "images"), { recursive: true });
    const outside = join(tmpdir(), `thesis-outside-${process.pid}.png`);
    await writeFile(
      outside,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    );
    await symlink(outside, join(ctx.root, "figures", "images", "link.png"));
    expect(await bad("figures/images/link.png", "raster")).toEqual([
      expect.stringContaining("outside"),
    ]);
    await rm(outside, { force: true });

    await writeFile(
      join(ctx.root, "figures", "images", "evil.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    );
    await writeFile(
      join(ctx.root, "figures", "images", "ext.svg"),
      '<svg><image href="file:///etc/passwd"/></svg>',
    );
    await writeFile(
      join(ctx.root, "figures", "images", "dtd.svg"),
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
    );
    await writeFile(join(ctx.root, "figures", "images", "fake.png"), "not a png");
    expect(await bad("figures/images/evil.svg", "svg")).toEqual([
      expect.stringContaining("scripts"),
    ]);
    expect(await bad("figures/images/ext.svg", "svg")).toEqual([
      expect.stringContaining("external resource"),
    ]);
    expect(await bad("figures/images/dtd.svg", "svg")).toEqual([
      expect.stringContaining("DOCTYPE"),
    ]);
    expect(await bad("figures/images/fake.png", "raster")).toEqual([
      expect.stringContaining("not a PNG"),
    ]);
  });
});
