import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import {
  chartConfig,
  chartStyleFor,
  checkChartSpec,
  csvToValues,
  prepareChart,
  renderChart,
  resolveDataFile,
} from "../src/render/charts.js";
import { diagramThemeFor } from "../src/render/diagram-theme.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(cleanSamples);

const bar = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: { url: "errores.csv" },
    mark: "bar",
    encoding: {
      x: { field: "tipo", type: "nominal" },
      y: { field: "errores", type: "quantitative" },
      color: { field: "metodo", type: "nominal" },
    },
    ...extra,
  });
const codes = (text: string, dataFiles = new Set(["errores.csv"])) =>
  checkChartSpec(text, { dataFiles }).issues.map((issue) => issue.code);
const style = chartStyleFor({ palette: "okabe-ito", fontProfile: "serif", bodyFont: null });

describe("chart spec validation (FIG-001/002/003)", () => {
  it("accepts the supported subset", () => {
    expect(codes(bar())).toEqual([]);
    expect(
      codes(
        JSON.stringify({
          data: { values: [{ a: 1 }] },
          layer: [
            { mark: "line", encoding: {} },
            { mark: { type: "point" }, encoding: {} },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("FIG-001: bad JSON, unknown keys and marks, missing data file, unsupported data", () => {
    expect(codes("{nope")).toEqual(["FIG-001"]);
    expect(codes("[]")).toEqual(["FIG-001"]);
    expect(codes(bar({ facet: {} }))).toContain("FIG-001");
    expect(codes(bar({ mark: "boxplot" }))).toContain("FIG-001");
    expect(codes(bar(), new Set())).toEqual(["FIG-001"]);
    expect(codes(bar({ data: { name: "x" } }))).toContain("FIG-001");
    expect(codes(bar({ data: { url: "x.xlsx" } }))).toContain("FIG-001");
    expect(codes(bar({ transform: [{ lookup: "a", from: {} }] }))).toContain("FIG-001");
    expect(codes(bar({ width: 9000 }))).toContain("FIG-001");
  });

  it("FIG-002: image marks, href/url fields and non-plain data.url", () => {
    expect(codes(bar({ mark: "image" }))).toContain("FIG-002");
    expect(codes(bar({ mark: { type: "bar", href: "https://x" } }))).toContain("FIG-002");
    expect(codes(bar({ encoding: { href: { field: "u" } } }))).toContain("FIG-002");
    for (const url of [
      "https://x.org/a.csv",
      "../a.csv",
      "/etc/a.csv",
      "a/../b.csv",
      "file:///a.csv",
      "a\\b.csv",
    ]) {
      expect(codes(bar({ data: { url } })), url).toContain("FIG-002");
    }
    // A leading data/ is accepted and normalized.
    expect(codes(bar({ data: { url: "data/errores.csv" } }))).toEqual([]);
  });

  it("FIG-003: specs that set colors or fonts", () => {
    expect(codes(bar({ config: { font: "Arial" } }))).toContain("FIG-003");
    expect(codes(bar({ mark: { type: "bar", color: "red" } }))).toContain("FIG-003");
    expect(codes(bar({ background: "#000" }))).toContain("FIG-003");
    expect(
      codes(
        bar({
          encoding: { y: { field: "e", type: "quantitative" }, color: { value: "#f00" } },
        }),
      ),
    ).toContain("FIG-003");
    expect(
      codes(
        bar({
          encoding: {
            color: { field: "m", type: "nominal", scale: { range: ["#f00", "#0f0"] } },
          },
        }),
      ),
    ).toContain("FIG-003");
    expect(
      codes(bar({ encoding: { x: { field: "t", type: "nominal", axis: { labelFont: "X" } } } })),
    ).toContain("FIG-003");
    // Plain color channels are fine.
    expect(codes(bar())).toEqual([]);
  });
});

describe("data reading and rendering", () => {
  const workspace = async () => {
    const dir = await mkdtemp(join(tmpdir(), "thesis-chart-"));
    await mkdir(join(dir, "data"));
    await writeFile(
      join(dir, "data", "errores.csv"),
      "tipo,metodo,errores\nArtículo,Manual,3.1\nArtículo,Auto,0.4\nLibro,Manual,5.8\n",
    );
    return dir;
  };

  it("parses CSV without code generation and infers numeric columns", () => {
    expect(csvToValues('a,b\n1,"x, y"\n2.5,z\n')).toEqual([
      { a: 1, b: "x, y" },
      { a: 2.5, b: "z" },
    ]);
    expect(() => csvToValues("a,a\n1,2")).toThrow(/unique/);
    expect(() => csvToValues("")).toThrow();
  });

  it("renders an SVG with the palette and 9 pt (12 px) labels, no Function constructor", async () => {
    const dir = await workspace();
    const originalFunction = globalThis.Function;
    let attempts = 0;
    globalThis.Function = new Proxy(originalFunction, {
      apply() {
        attempts += 1;
        throw new Error("codegen");
      },
      construct() {
        attempts += 1;
        throw new Error("codegen");
      },
    });
    let svg: string;
    try {
      ({ svg } = await renderChart({ specText: bar(), dataDir: join(dir, "data"), style }));
    } finally {
      globalThis.Function = originalFunction;
    }
    expect(attempts).toBe(0);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain("#000000"); // okabe-ito first series
    expect(svg).toContain("#E69F00");
    expect(svg).toContain('font-size="12px"'); // 9 pt
    expect(svg).toContain("Libertinus Serif");
    expect(svg).not.toMatch(/href=|<script|<image/);
  });

  it("injects the palette, fonts and minimal gridlines from the profile", () => {
    const config = chartConfig(style) as Record<string, Record<string, unknown>>;
    expect(config.range?.category).toEqual([
      "#000000",
      "#E69F00",
      "#56B4E9",
      "#009E73",
      "#0072B2",
      "#D55E00",
      "#CC79A7",
    ]);
    expect(config.axis).toMatchObject({ labelFontSize: 12, grid: false, domainWidth: 1 });
    expect(config.axisY).toMatchObject({ grid: true });
    expect(config.line).toMatchObject({ point: true });
    const sans = chartStyleFor({ palette: "tol-bright", fontProfile: "sans", bodyFont: "Arial" });
    expect(chartConfig(sans).font).toBe("Arial, Liberation Sans, Arimo, DejaVu Sans, sans-serif");
  });

  it("caches by SHA-256 of spec, data and config", async () => {
    const dir = await workspace();
    const cache = join(dir, "cache");
    const input = { specText: bar(), dataDir: join(dir, "data"), style };
    const first = await renderChart(input, cache);
    expect((await readdir(join(cache, "charts"))).length).toBe(1);
    expect((await renderChart(input, cache)).key).toBe(first.key);
    await writeFile(join(dir, "data", "errores.csv"), "tipo,metodo,errores\nLibro,Manual,9\n");
    const changed = await prepareChart(input);
    expect(changed.key).not.toBe(first.key);
    const other = await prepareChart({
      ...input,
      style: chartStyleFor({ palette: "tol-bright", fontProfile: "serif", bodyFont: null }),
    });
    expect(other.key).not.toBe(changed.key);
  });

  it("refuses data outside data/, including through a symlink", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "outside.csv"), "a\n1\n");
    await symlink(join(dir, "outside.csv"), join(dir, "data", "link.csv"));
    await expect(resolveDataFile(join(dir, "data"), "link.csv")).rejects.toMatchObject({
      code: "FIG-002",
    });
    await expect(resolveDataFile(join(dir, "data"), "../outside.csv")).rejects.toMatchObject({
      code: "FIG-002",
    });
    await expect(resolveDataFile(join(dir, "data"), "missing.csv")).rejects.toMatchObject({
      code: "FIG-001",
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("fails on any Vega warning or error instead of drawing a broken chart", async () => {
    const dir = await workspace();
    const spec = bar({
      encoding: {
        x: { field: "tipo", type: "nominal" },
        y: { field: "nope", type: "quantitative", aggregate: "bogus" },
      },
    });
    await expect(
      renderChart({ specText: spec, dataDir: join(dir, "data"), style }),
    ).rejects.toMatchObject({ code: "FIG-001" });
  });
});

describe("chart checks on a thesis", () => {
  it("the sample thesis chart passes; a broken spec and a missing source fail the checks", async () => {
    const root = await sampleThesis();
    const clean = runChecks(await loadProject(root)).findings.filter((f) =>
      f.code.startsWith("FIG-"),
    );
    expect(clean).toEqual([]);
    await writeFile(
      join(root, "figures", "charts", "errores.vl.json"),
      bar({ config: { font: "X" }, data: { url: "nada.csv" } }),
    );
    const findings = runChecks(await loadProject(root)).findings.filter((f) =>
      f.code.startsWith("FIG-"),
    );
    expect(findings.map((f) => f.code).sort()).toEqual(["FIG-001", "FIG-003", "FIG-003"]);
    expect(findings[0]?.file).toBe("figures/charts/errores.vl.json");
  });

  it("FIG-004: a chart needs a caption and a source line", async () => {
    const root = await sampleThesis();
    const path = join(root, "chapters", "02-metodologia.md");
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace(" Fuente: elaboración propia.](figures/charts", "](figures/charts"),
    );
    const findings = runChecks(await loadProject(root)).findings.filter(
      (f) => f.code === "FIG-004",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/no source line/);
  });

  it("XRF-003 warns when a heading level is skipped", async () => {
    const root = await sampleThesis();
    await writeFile(join(root, "chapters", "03-salto.md"), "# Tres\n\n### Salto\n\nTexto.\n");
    const findings = runChecks(await loadProject(root)).findings.filter(
      (f) => f.code === "XRF-003",
    );
    expect(findings).toMatchObject([
      { severity: "warning", file: "chapters/03-salto.md", line: 3 },
    ]);
  });
});

describe("diagram theme from the palette", () => {
  it("neutral tints with the palette accent; grayscale uses only grays", () => {
    const neutral = diagramThemeFor({
      palette: "okabe-ito",
      diagramTheme: "neutral",
      fontProfile: "serif",
      bodyFont: null,
    });
    expect(neutral.variables.primaryBorderColor).toBe("#0072B2");
    expect(neutral.variables.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    const gray = diagramThemeFor({
      palette: "okabe-ito",
      diagramTheme: "grayscale",
      fontProfile: "sans",
      bodyFont: "Arial",
    });
    for (const value of Object.values(gray.variables)) {
      const [r, g, b] = [1, 3, 5].map((i) => value.slice(i, i + 2));
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    expect(gray.fonts[0]).toBe("Arial");
  });
});
