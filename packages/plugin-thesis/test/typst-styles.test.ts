import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/checks/index.js";
import { resolveTypst } from "../src/render/adapters/typst-pdf/runner.js";
import { buildThesis } from "../src/render/build.js";
import { readShippedStyle } from "../src/styles/csl.js";
import { goldenText, renderStyleFixtures, styleFixtureFindings } from "../src/styles/golden.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

// Engine tests run only when a Typst >= 0.15 is reachable (ALISIO_THESIS_TYPST or PATH).
const env = process.env;
const cacheRoot = join(tmpdir(), "thesis-integration-cache");
const engine = await resolveTypst(env, cacheRoot);
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

const configure = async (root: string, style: string, standard?: string) => {
  const brief = await readFile(join(root, "thesis.yaml"), "utf8");
  await writeFile(
    join(root, "thesis.yaml"),
    brief
      .replace("citationStyle: apa-7", `citationStyle: ${style}`)
      .replace(
        "standard: generic",
        `standard: ${standard ?? (style === "apa-7" ? "generic" : style)}`,
      ),
  );
};
const build = (root: string) => buildThesis({ root, scope: "full", env, cacheRoot });
const errors = (outcome: Awaited<ReturnType<typeof build>>) =>
  outcome.findings.filter((finding) => finding.severity === "error");

const simpleCsl = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="es-ES">
  <info>
    <title>Thesis test</title>
    <id>thesis-test</id>
    <updated>2026-10-04T00:00:00+00:00</updated>
    <category citation-format="author-date"/>
    <rights license="http://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights>
  </info>
  <macro name="who"><names variable="author"><name form="short" and="text"/></names></macro>
  <citation><layout prefix="[" suffix="]" delimiter="; "><group delimiter=" "><text macro="who"/><date variable="issued"><date-part name="year"/></date></group></layout></citation>
  <bibliography><layout><group delimiter=" - "><text macro="who"/><text variable="title"/></group></layout></bibliography>
</style>`;

describe.skipIf(!engine.available)("shipped styles render their golden fixtures", () => {
  for (const id of ["apa-7", "ieee", "icontec-ntc1486-2022"]) {
    it(`${id}: journal, book, chapter, thesis, law, standard, web page and dataset`, async () => {
      const style = readShippedStyle(id) as NonNullable<ReturnType<typeof readShippedStyle>>;
      const actual = await renderStyleFixtures(style, {
        binary: (engine as { path: string }).path,
        lang: "es",
        env,
      });
      const expected = await readFile(
        join(import.meta.dirname, "..", "styles", "fixtures", `${id}.expected.json`),
        "utf8",
      );
      expect(goldenText(actual)).toBe(expected);
      expect(Object.keys(actual.bibliography)).toHaveLength(8);
    });
  }

  it("ICONTEC: author capitals, ';' and 'y', 'En:', Spanish genre labels; the dataset uses the fallback", async () => {
    const expected = JSON.parse(
      await readFile(
        join(import.meta.dirname, "..", "styles", "fixtures", "icontec-ntc1486-2022.expected.json"),
        "utf8",
      ),
    ) as { bibliography: Record<string, string>; citations: Record<string, string> };
    expect(expected.bibliography.chapter).toMatch(
      /^ROJAS, Carlos; DÍAZ MORA, Elena y SILVA, Pedro\. .*En: /,
    );
    expect(expected.bibliography.journal).toMatch(
      /vol\. 12, no\. 3, p\. 45-67\. ISSN 1234-5679\. Doi: /,
    );
    expect(expected.bibliography.law).toContain("Ley.");
    expect(expected.bibliography.dataset).toContain("Conjunto de datos.");
    expect(expected.citations.journal).toMatch(/no\. 3, p\. 12\.$/); // a note, with the locator
  });
});

describe.skipIf(!engine.available || !pdftotext)(
  "builds with every citation style and the chart",
  () => {
    for (const style of ["apa-7", "ieee", "icontec-ntc1486-2022"]) {
      it(`${style}: chart, lists without the source line, bibliography`, async () => {
        const root = await sampleThesis();
        await configure(root, style);
        const outcome = await build(root);
        expect(errors(outcome)).toEqual([]);
        expect(outcome.ok).toBe(true);
        const pages = text(outcome.path as string).split("\f");
        const list = pages.find((page) => /Lista de figuras|LISTA DE FIGURAS/.test(page)) as string;
        expect(list).toMatch(/Figura 2?\.?[12]\s+Errores de citación por tipo de fuente y método/);
        expect(list).not.toContain("Fuente:");
        const files = await readdir(join(root, "build", "figures"));
        expect(files.some((name) => name.endsWith(".svg"))).toBe(true);
        expect(text(outcome.path as string)).toMatch(
          /Figura (\d\.)?\d\. Errores de citación por tipo de fuente y método\./,
        );
      });
    }

    it("ICONTEC: notes with Ibid./Op. cit., 'pág.' column, no APA '(2012,)' comma, no prose cite inline", async () => {
      const root = await sampleThesis();
      await configure(root, "icontec-ntc1486-2022");
      const outcome = await build(root);
      const content = text(outcome.path as string);
      expect(content).toMatch(/Ibid\./);
      expect(content).toMatch(/Op\. cit\./);
      expect(content).toContain("pág.");
      expect(content).not.toMatch(/Según GARCÍA, María \(/);
      expect(outcome.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["CSL-020"]));
    });

    it("APA references are produced by the shipped CSL", async () => {
      const root = await sampleThesis();
      const outcome = await build(root);
      expect(text(outcome.path as string)).toContain("Pérez, A., & Gómez, L. (2021)");
    });

    it("ICONTEC: levels 3 and 4 run into the paragraph and end with a period", async () => {
      const root = await sampleThesis();
      await configure(root, "icontec-ntc1486-2022");
      await writeFile(
        join(root, "chapters", "03-niveles.md"),
        "# Tres\n\n## Dos\n\n### Tercer nivel\n\nEl texto sigue en la misma línea que el título.\n",
      );
      const content = text((await build(root)).path as string);
      expect(content).toMatch(/3\.1\.1\s+Tercer nivel\.\s+El texto sigue/);
    });

    it("heading-level skips are warnings and do not block the build", async () => {
      const root = await sampleThesis();
      await writeFile(join(root, "chapters", "03-salto.md"), "# Tres\n\n### Salto\n\nTexto.\n");
      const outcome = await build(root);
      expect(outcome.ok).toBe(true);
      expect(outcome.findings.filter((f) => f.code === "XRF-003")).toHaveLength(1);
    });
  },
);

describe.skipIf(!engine.available || !pdftotext)("workspace styles and profiles", () => {
  const install = async (root: string, files: Record<string, string>) => {
    await mkdir(join(root, "styles", "fixtures"), { recursive: true });
    for (const [name, content] of Object.entries(files))
      await writeFile(join(root, "styles", name), content);
  };

  it("applies thesis-test.csl and a profile that changes margins and heading case", async () => {
    const root = await sampleThesis();
    await install(root, {
      "thesis-test.csl": simpleCsl,
      "thesis-test.profile.yaml":
        "extends: generic\nmargins: { top: 5cm }\nheadings:\n  - { level: 1, case: upper }\n",
    });
    await configure(root, "thesis-test", "thesis-test");
    const outcome = await build(root);
    expect(errors(outcome)).toEqual([]);
    const content = text(outcome.path as string);
    expect(content).toContain("INTRODUCCIÓN");
    expect(content).toContain("[Pérez y Gómez 2021]");
    expect(content).toMatch(/García - Metodología de la investigación aplicada/);
    // The 5 cm top margin pushes the chapter title down the page.
    const bbox = execFileSync("pdftotext", ["-bbox", outcome.path as string, "-"], {
      encoding: "utf8",
    });
    const top = /yMin="([0-9.]+)"[^>]*>INTRODUCCIÓN</.exec(bbox);
    expect(Number(top?.[1])).toBeGreaterThan(5 * 28.35 - 5);
  });

  it("an unknown profile key fails PRF-001; a DOCTYPE or shadowed style fails CSL-001", async () => {
    const root = await sampleThesis();
    await install(root, { "thesis-test.profile.yaml": "margins: { top: 5cm }\nzzz: 1\n" });
    await configure(root, "apa-7", "thesis-test");
    expect(errors(await build(root)).map((f) => f.code)).toContain("PRF-001");

    const doctype = await sampleThesis();
    await install(doctype, {
      "thesis-test.csl": `<!DOCTYPE style [<!ENTITY x "y">]>${simpleCsl}`,
    });
    await configure(doctype, "thesis-test", "generic");
    expect(errors(await build(doctype)).map((f) => f.code)).toContain("CSL-001");

    const shadow = await sampleThesis();
    await install(shadow, {
      "apa-7.csl": simpleCsl.replace("<id>thesis-test</id>", "<id>apa-7</id>"),
    });
    const shadowFindings = (await loadProject(shadow)).styleFiles;
    expect(shadowFindings.map((f) => f.id)).toEqual(["apa-7"]);
    await configure(shadow, "apa-7");
    expect((await build(shadow)).ok).toBe(true); // the shipped style still wins; check reports CSL-001
  });

  it("CSL-010: approved fixtures must keep rendering identically; skipped with a warning without an engine", {
    timeout: 60_000,
  }, async () => {
    const root = await sampleThesis();
    await install(root, { "thesis-test.csl": simpleCsl });
    const approved = await renderStyleFixtures(
      { id: "thesis-test", text: simpleCsl },
      { binary: (engine as { path: string }).path, lang: "es", env },
    );
    await install(root, { "fixtures/thesis-test.expected.json": goldenText(approved) });
    const project = await loadProject(root);
    expect(await styleFixtureFindings(project, { env, cacheRoot })).toEqual([]);
    await configure(root, "thesis-test", "generic");
    const first = await build(root);
    expect(errors(first)).toEqual([]);

    await install(root, {
      "thesis-test.csl": simpleCsl.replace('delimiter=" - "', 'delimiter=" / "'),
    });
    const drifted = await buildThesis({ root, scope: "full", env, cacheRoot });
    expect(drifted.ok).toBe(false);
    expect(drifted.findings.find((f) => f.code === "CSL-010")?.message).toMatch(
      /no longer renders its approved fixtures/,
    );

    const skipped = await styleFixtureFindings(await loadProject(root), {
      env: { ALISIO_THESIS_TYPST: "/nonexistent/typst" },
      cacheRoot,
    });
    expect(skipped).toMatchObject([{ code: "CSL-010", severity: "warning" }]);
  });
});
