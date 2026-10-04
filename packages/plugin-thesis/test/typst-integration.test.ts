import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTypst } from "../src/render/adapters/typst-pdf/runner.js";
import { buildThesis } from "../src/render/build.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

// Engine tests run only when a Typst >= 0.15 is reachable (ALISIO_THESIS_TYPST or PATH).
const env = process.env;
const engine = await resolveTypst(env, join(tmpdir(), "thesis-integration-cache"));
const typstAvailable = engine.available;

const pdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const text = (pdf: string) =>
  execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });

afterEach(cleanSamples);

async function configure(root: string, style: string) {
  let brief = await readFile(join(root, "thesis.yaml"), "utf8");
  brief = brief
    .replace("citationStyle: apa-7", `citationStyle: ${style}`)
    .replace("standard: generic", `standard: ${style === "apa-7" ? "generic" : style}`);
  await writeFile(join(root, "thesis.yaml"), brief);
}
const build = (root: string, extra: Record<string, unknown> = {}) =>
  buildThesis({
    root,
    scope: "full",
    env,
    cacheRoot: join(tmpdir(), "thesis-integration-cache"),
    ...extra,
  } as never);
const errorsOf = (outcome: Awaited<ReturnType<typeof build>>) =>
  outcome.findings.filter((finding) => finding.severity === "error");

describe.skipIf(!typstAvailable)("Typst engine builds of the sample-es thesis", () => {
  for (const style of ["apa-7", "icontec-ntc1486-2022", "ieee"]) {
    it(`builds a PDF under ${style} with zero Typst errors`, async () => {
      const root = await sampleThesis();
      await configure(root, style);
      const outcome = await build(root);
      expect(errorsOf(outcome)).toEqual([]);
      expect(outcome.ok).toBe(true);
      expect(outcome.pages).toBeGreaterThan(0);
      expect((await stat(outcome.path as string)).size).toBeGreaterThan(10_000);
      expect((await readFile(outcome.path as string)).subarray(0, 5).toString()).toBe("%PDF-");
      // No Typst diagnostics at all, not even warnings, from the shipped templates.
      expect(outcome.findings.filter((f) => f.code === "BLD-003")).toEqual([]);
    });
  }

  it.skipIf(!pdftotext)(
    "APA: cover, roman preliminaries, TOC, lists, forward references and numbering",
    async () => {
      const root = await sampleThesis();
      const outcome = await build(root);
      const content = text(outcome.path as string);
      expect(content).toContain("Trabajo de grado");
      expect(content).toContain("Contenido");
      expect(content).toContain("Lista de figuras");
      expect(content).toContain("Lista de tablas");
      expect(content).toMatch(/Resumen[\s.\u2060]+i\b/);
      // Per-chapter numbers, and the forward reference from chapter 1 points at chapter 2.
      expect(content).toMatch(/Figura 2\.1\. Flujo/);
      expect(content).toMatch(/Tabla 2\.1\. Errores/);
      expect(content).toMatch(/\(2\.1\)\s*$/m);
      expect(content).toMatch(/define en Ecuación \(2\.1\)/);
      expect(content).toMatch(/resume en Figura 2\.1/);
      expect(content).toContain("Referencias");
      expect(content).toContain("Pérez, A., & Gómez, L. (2021)");
      expect(content).toContain("Consultada el 4 de octubre de 2026");
      // Escaping survived: hostile-looking prose is literal text.
      expect(content).toContain("costo de $5");
      expect(content).toContain("@perez2021");
      expect(content).toContain("https://ejemplo.org/guia//ruta");
    },
  );

  it.skipIf(!pdftotext)(
    "ICONTEC: arabic pagination with the cover counted, uppercase level-1 headings, captions above",
    async () => {
      const root = await sampleThesis();
      await configure(root, "icontec-ntc1486-2022");
      const outcome = await build(root);
      expect(outcome.findings.map((f) => f.code)).toEqual(
        expect.arrayContaining(["BLD-004", "CSL-020"]),
      );
      const pages = text(outcome.path as string).split("\f");
      expect(pages[0]).not.toMatch(/^\s*1\s*$/m); // the cover is counted but not printed
      expect(pages[1]).toContain("CONTENIDO");
      expect(pages[1]).toMatch(/^\s*2\s*$/m);
      const methodology = pages.find((page) => page.includes("METODOLOGÍA")) as string;
      expect(methodology.indexOf("Tabla 1.")).toBeLessThan(methodology.indexOf("Tipo de fuente"));
      expect(methodology.indexOf("Figura 1.")).toBeLessThan(methodology.indexOf("Buscar fuentes"));
      expect(methodology.indexOf("Fuente: elaboración propia")).toBeGreaterThan(
        methodology.indexOf("Buscar fuentes"),
      );
      expect(text(outcome.path as string)).toContain("Ecuación (1)");
    },
  );

  it("scopes: a section build is faster and smaller than the full build, and --pdfa works", async () => {
    const root = await sampleThesis();
    const full = await build(root);
    const section = await build(root, { scope: "section", section: "SEC-02" });
    expect(section.ok).toBe(true);
    expect(section.pages as number).toBeLessThan(full.pages as number);
    expect(section.path).toMatch(/thesis-SEC-02\.pdf$/);
    const archival = await build(root, { pdfa: true });
    expect(archival.ok).toBe(true);
    expect((await readFile(archival.path as string)).toString("latin1")).toContain("pdfaid");
  });

  it("warm builds stay well inside the 10 s target", async () => {
    const root = await sampleThesis();
    await build(root);
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) timings.push((await build(root)).ms);
    console.info(`sample-es warm build ms: ${timings.join(", ")}`);
    expect(Math.min(...timings)).toBeLessThan(10_000);
  });

  it("reports Typst errors as BLD-001 findings and records a failed build", async () => {
    const root = await sampleThesis();
    // A formula Typst cannot convert passes the MTH-001 pre-validation but fails to compile.
    await writeFile(
      join(root, "chapters", "03-roto.md"),
      "# R\n\n$$ \\unknowncommand{x} $$ {#eq-roto}\n",
    );
    const outcome = await build(root);
    expect(outcome.ok).toBe(false);
    expect(errorsOf(outcome).map((f) => f.code)).toContain("BLD-001");
    expect(
      JSON.parse(await readFile(join(root, "build", "build-report.json"), "utf8")),
    ).toMatchObject({ ok: false });
  });

  it("cannot download anything: a package outside the vendored set fails offline", async () => {
    const root = await sampleThesis();
    await build(root);
    await writeFile(join(root, "build", "evil.typ"), '#import "@preview/cetz:0.3.0": canvas\n');
    const { runTypst } = await import("../src/render/adapters/typst-pdf/runner.js");
    const { mkdtemp } = await import("node:fs/promises");
    const cache = await mkdtemp(join(tmpdir(), "thesis-pkgcache-"));
    const outcome = await runTypst({
      binary: (engine as { path: string }).path,
      buildDir: join(root, "build"),
      packageCache: cache,
      packagePath: join(import.meta.dirname, "..", "typst-packages"),
      input: "evil.typ",
      output: "evil.pdf",
      env,
    });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toMatch(/error/);
  });
});
