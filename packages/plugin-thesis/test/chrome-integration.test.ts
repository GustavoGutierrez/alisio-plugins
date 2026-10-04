import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChrome } from "../src/chrome/detect.js";
import { chromePdfRenderer } from "../src/render/adapters/chrome-pdf/index.js";
import { htmlPreviewRenderer } from "../src/render/adapters/html-preview/index.js";
import { buildThesis } from "../src/render/build.js";
import { createDefaultRegistry } from "../src/render/default-registry.js";
import type { Renderer } from "../src/render/port.js";
import { RendererRegistry } from "../src/render/registry.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(cleanSamples);

const cache = join(tmpdir(), "thesis-chrome-cache");
// No Typst anywhere: the explicit override points at nothing.
const noTypst = { ...process.env, ALISIO_THESIS_TYPST: "/nonexistent/typst" };
const chromeAvailable = (await detectChrome({ env: process.env })).browser !== null;
const pdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const fake = (id: string, available: boolean): Renderer => ({
  id,
  format: "pdf",
  capabilities: () => ({
    math: "native",
    mermaid: "native",
    footnotes: "native",
    toc: "native",
    crossrefs: "native",
    bibliography: "native",
    pdfa: id === "first",
    extension: "pdf",
  }),
  available: async () =>
    available
      ? { available: true, engine: id, source: "test" }
      : { available: false, reason: `${id} is unavailable`, hint: "Run /thesis:setup" },
  render: async () => ({ ok: true, engine: id, ms: 1, findings: [], unrepresented: [] }),
});

describe("engine order and fallback selection", () => {
  const base = (root: string, registry: RendererRegistry, extra = {}) =>
    ({ root, scope: "full", env: noTypst, cacheRoot: cache, registry, ...extra }) as never;

  it("uses the second engine with a layout warning when the first is unavailable", async () => {
    const root = await sampleThesis();
    const registry = new RendererRegistry()
      .register(fake("first", false))
      .register(fake("second", true));
    const outcome = await buildThesis(base(root, registry));
    expect(outcome.ok).toBe(true);
    expect(outcome.engine).toBe("second");
    expect(outcome.warnings.join("\n")).toMatch(
      /second fallback.*first is unavailable.*layout differs/,
    );
  });

  it("returns an actionable message naming /thesis:setup when no engine exists", async () => {
    const root = await sampleThesis();
    const registry = new RendererRegistry()
      .register(fake("first", false))
      .register(fake("second", false));
    const outcome = await buildThesis(base(root, registry));
    expect(outcome.ok).toBe(false);
    const message = outcome.findings.find((f) => f.severity === "error");
    expect(message?.message).toMatch(/first is unavailable.*second is unavailable/);
    expect(message?.hint).toMatch(/\/thesis:setup/);
  });

  it("PDF/A skips renderers that cannot write it", async () => {
    const root = await sampleThesis();
    const registry = new RendererRegistry()
      .register(fake("first", false))
      .register(fake("second", true));
    const outcome = await buildThesis(base(root, registry, { pdfa: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.engine).toBe("none");
    expect(outcome.findings.at(-1)?.message).toMatch(/first is unavailable/);
  });

  it("with Chrome disabled and no Typst the real registry points at /thesis:setup", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis(
      base(root, createDefaultRegistry(), { env: { ...noTypst, ALISIO_THESIS_CHROME: "off" } }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.find((f) => f.severity === "error")?.hint).toMatch(/\/thesis:setup/);
    expect(
      await chromePdfRenderer.available({
        env: { ALISIO_THESIS_CHROME: "off" },
        cacheRoot: cache,
        root,
      }),
    ).toMatchObject({
      available: false,
    });
  });
});

describe("HTML preview (no browser needed)", () => {
  it("builds build/thesis.html with its assets and no Chrome", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis({
      root,
      scope: "full",
      format: "html",
      env: { ...noTypst, ALISIO_THESIS_CHROME: "off" },
      cacheRoot: cache,
      registry: createDefaultRegistry(),
    } as never);
    expect(outcome.ok).toBe(true);
    expect(outcome.engine).toBe("html-preview");
    expect(outcome.path).toBe(join(root, "build", "thesis.html"));
    const html = await readFile(outcome.path as string, "utf8");
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="mermaid-src"');
    expect(html).toContain("Metodología");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    const assets = await readdir(join(root, "build", "_html"));
    expect(assets).toEqual(
      expect.arrayContaining(["runtime.js", "paged.polyfill.min.js", "mermaid.min.js", "fonts"]),
    );
    expect(htmlPreviewRenderer.capabilities().extension).toBe("html");
  });
});

describe.skipIf(!chromeAvailable)("Chrome fallback PDF of the sample-es thesis (no Typst)", () => {
  for (const transport of ["pipe", "websocket"]) {
    it(`builds a PDF through the ${transport} transport`, async () => {
      const root = await sampleThesis();
      const outcome = await buildThesis({
        root,
        scope: "full",
        env: { ...noTypst, ALISIO_THESIS_CDP: transport },
        cacheRoot: cache,
        registry: createDefaultRegistry(),
      } as never);
      expect(outcome.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(outcome.ok).toBe(true);
      expect(outcome.engine).toMatch(/^chrome-pdf/);
      expect(outcome.pages).toBeGreaterThan(0);
      expect(outcome.warnings.join("\n")).toMatch(/chrome-pdf fallback/);
      expect((await stat(outcome.path as string)).size).toBeGreaterThan(10_000);
      expect((await readFile(outcome.path as string)).subarray(0, 5).toString()).toBe("%PDF-");
      // The page loaded nothing from the network (a blocked request would be a BLD-004 warning).
      expect(outcome.warnings.join("\n")).not.toMatch(/network request/);
    }, 60_000);
  }

  it.skipIf(!pdftotext)(
    "TOC with page numbers, numbered figures, math, bibliography",
    async () => {
      const root = await sampleThesis();
      const outcome = await buildThesis({
        root,
        scope: "full",
        env: noTypst,
        cacheRoot: cache,
        registry: createDefaultRegistry(),
      } as never);
      const text = execFileSync("pdftotext", ["-layout", outcome.path as string, "-"], {
        encoding: "utf8",
      });
      expect(text).toMatch(/Contenido/);
      expect(text).toMatch(/Metodolog[ií]a\s*\.*\s*2/);
      expect(text).toMatch(/Figura 2\.1\./);
      expect(text).toMatch(/Tabla 2\.1\./);
      expect(text).toMatch(/Ecuación \(2\.1\)/);
      expect(text).toContain("Referencias");
      expect(text).toContain("Pérez, A. y Gómez, L. (2021)");
      expect(text).toContain("costo de $5");
      expect(text).toContain("@perez2021");
    },
    60_000,
  );

  it("refuses PDF/A (needs Typst) and leaves no Chrome profile behind", async () => {
    const root = await sampleThesis();
    const outcome = await buildThesis({
      root,
      scope: "full",
      pdfa: true,
      env: noTypst,
      cacheRoot: cache,
      registry: createDefaultRegistry(),
    } as never);
    expect(outcome.ok).toBe(false);
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("alisio-thesis-chrome-"),
    );
    expect(leftovers).toEqual([]);
  }, 60_000);
});
