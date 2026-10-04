// biome-ignore-all lint/style/noNonNullAssertion: fixtures index arrays whose length the test controls
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { json } from "./helpers/data.js";
import { cleanup, type Lifecycle } from "./helpers/harness.js";
import {
  claim,
  drafted,
  editorReply,
  packetOf,
  researched,
  sectionDraft,
  writerReply,
} from "./helpers/phase5.js";

afterEach(cleanup);

const noEngine = {
  coordinator: { env: { LANG: "es_CO.UTF-8", ALISIO_THESIS_TYPST: "/nonexistent/typst" } },
};
const typst = process.env.ALISIO_THESIS_TYPST;
const engine = typst
  ? { coordinator: { env: { LANG: "es_CO.UTF-8", ALISIO_THESIS_TYPST: typst } } }
  : noEngine;

const finding = (over: Record<string, unknown> = {}) => ({
  severity: "major",
  category: "argument",
  target: "SEC-07",
  evidence: "La verificación automática de referencias es viable",
  description: "La afirmación no se sigue de la evidencia citada.",
  routeTo: "architect",
  ...over,
});
const report = (...findings: Record<string, unknown>[]) =>
  json({ summary: "El argumento es claro pero la primera afirmación se excede.", findings });

/** A draft whose claims reach every objective (for CLM-004 at G10). */
const completeDraft = (prompt: string) => {
  const [first, second] = packetOf(prompt);
  return json(
    sectionDraft(prompt, {
      claims: [
        claim({
          anchor: "c1",
          kind: "result",
          evidence: [first?.id],
          objectives: ["OBJ-01", "OBJ-02", "OBJ-03"],
        }),
        claim({
          anchor: "c2",
          kind: "conclusion",
          evidence: [second?.id],
          results: ["c1"],
          objectives: ["OBJ-G"],
        }),
      ],
    }),
  );
};

/** The thesis with SEC-07 drafted and approved, and every other section approved by hand. */
async function ready(h: Lifecycle, options: { aiDeclaration?: boolean } = {}) {
  h.script("thesis-writer", completeDraft);
  h.script("thesis-editor", editorReply());
  await h.run("draft", "SEC-07");
  await h.run("approve", "SEC-07");
  const path = join(h.workspace, ".alisio", "thesis", "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  const stamp = new Date().toISOString();
  for (const section of Object.values(state.sections) as { status: string; updatedAt?: string }[]) {
    section.status = "approved";
    section.updatedAt = section.updatedAt ?? stamp;
  }
  state.phase = "review";
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  if (options.aiDeclaration !== false) {
    await writeFile(
      join(h.workspace, "thesis", "chapters", "03-declaracion-ia.md"),
      "---\nrole: ai-declaration\nsection: SEC-03\n---\n\nSe utilizó un asistente de inteligencia artificial para apoyar la redacción y la edición del texto; el autor revisó todo el contenido y asume su responsabilidad.\n",
    );
  }
}

describe("/thesis:review", () => {
  it("shows the reviewer only built artifacts and records findings as FND files", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script(
      "thesis-reviewer",
      report(
        finding(),
        finding({
          severity: "minor",
          category: "wording",
          routeTo: "editor",
          description: "Frase larga.",
        }),
      ),
    );
    const message = await h.run("review", "SEC-07");
    expect(message).toContain("FND-0001 major argument in SEC-07");
    expect(message).toContain("FND-0002 minor wording in SEC-07");
    expect(message).toContain("/thesis:revise FND-0001");
    expect(message).toContain("G9: 1 open critical or major finding(s) block /thesis:finalize");

    const reviewer = h.prompts.find((entry) => entry.role === "thesis-reviewer")!;
    // writer != reviewer: the reviewer never sees the writer's task, packet or dossier.
    expect(reviewer.prompt).not.toContain("Task: draft the section");
    expect(reviewer.prompt).not.toContain("EVIDENCE PACKET");
    expect(reviewer.prompt).not.toContain("Dialect rules");
    for (const part of ["OUTLINE", "PROTOCOL", "DETERMINISTIC CHECK REPORT", "SECTION SEC-07"])
      expect(reviewer.prompt).toContain(part);
    expect(reviewer.spec).toMatchObject({ readOnly: true, permission: { write: "deny" } });
    expect((reviewer.spec.tools as { allow: string[] }).allow).toContain("thesis_check");

    const first = JSON.parse(await h.read("reviews/FND-0001.json"));
    expect(first).toMatchObject({
      id: "FND-0001",
      severity: "major",
      status: "open",
      routeTo: "architect",
      target: "SEC-07",
    });
    expect((await h.state()).lastReview).toMatchObject({
      scope: "SEC-07",
      findings: 2,
      blocking: 1,
    });
    expect(await h.run("check", "G9")).toContain("REV-001");
  });

  it("rejects a finding whose quote is not in the section, or whose route does not follow its category", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script(
      "thesis-reviewer",
      report(finding({ evidence: "Una frase que no existe en el texto de la sección" })),
      report(finding({ routeTo: "writer" })),
    );
    const message = await h.run("review", "SEC-07");
    expect(message).toContain("did not return a valid report after one retry");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-reviewer")[1]!;
    expect(retry.prompt).toContain("not a verbatim quote of SEC-07");
    await expect(h.read("reviews/FND-0001.json")).rejects.toThrow();
  });

  it("blocks reviewing a section without a draft", async () => {
    const h = await researched(noEngine);
    expect(await h.run("review", "SEC-07")).toMatch(/has no draft to review yet/);
    expect(await h.run("review", "all")).toMatch(/no section has a draft yet/);
    expect(await h.run("review", "SEC-99")).toMatch(/not a section/);
  });

  it("routes an argument finding to the architect and the writer, and resolves it", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script("thesis-reviewer", report(finding()));
    await h.run("review", "SEC-07");
    h.script("thesis-architect", (prompt) => {
      expect(prompt).toContain("PREVIOUS DOSSIER");
      expect(prompt).toContain("La afirmación no se sigue");
      return json({
        synthesis: [
          { topic: "verificación de referencias", summary: "Síntesis revisada.", evidence: [] },
          { topic: "integridad de citas", summary: "Síntesis revisada.", evidence: [] },
        ],
        claims: [],
        gaps: [],
      });
    });
    h.script("thesis-writer", writerReply());
    h.script("thesis-editor", editorReply());
    const message = await h.run("revise", "FND-0001");
    expect(message).toContain("The architect revised the dossier of SEC-07");
    expect(message).toContain("FND-0001 is resolved");
    const writer = h.prompts.filter((entry) => entry.role === "thesis-writer").at(-1)!;
    expect(writer.prompt).toContain("Reviewer finding FND-0001");
    expect(writer.prompt).toContain("The architect revised the dossier");
    expect(JSON.parse(await h.read("reviews/FND-0001.json"))).toMatchObject({ status: "resolved" });
    expect((await h.state()).lastReview?.blocking).toBe(0);
    expect(await h.run("check", "G9")).toContain("Checks passed");
  });

  it("routes a wording finding to the editor only, and a build finding to the template", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script(
      "thesis-reviewer",
      report(
        finding({ severity: "minor", category: "wording", routeTo: "editor" }),
        finding({
          severity: "major",
          category: "format",
          routeTo: "build",
          description: "El pie de figura va arriba.",
        }),
      ),
    );
    await h.run("review", "SEC-07");
    h.script(
      "thesis-editor",
      editorReply((body) => body.replace("Asimismo,", "También,")),
    );
    const edited = await h.run("revise", "FND-0001");
    expect(edited).toContain("Edited the wording of SEC-07");
    expect(await h.read("chapters/07-marco.md")).toContain("También,");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer")).toHaveLength(1);
    const format = await h.run("revise", "FND-0002");
    expect(format).toContain("fixed in the template or the presentation profile");
    expect(JSON.parse(await h.read("reviews/FND-0002.json")).status).toBe("open");
  });

  it("routes a method finding to the methodologist; a protocol change is the user's call", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script("thesis-reviewer", report(finding({ category: "method", routeTo: "methodologist" })));
    await h.run("review", "SEC-07");
    h.script(
      "thesis-methodologist",
      json({ guidance: "Cambiar el diseño a un estudio de caso.", protocolChange: true }),
    );
    const message = await h.run("revise", "FND-0001");
    expect(message).toContain("needs a change to the protocol, which is locked");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer")).toHaveLength(1);
    expect(JSON.parse(await h.read("reviews/FND-0001.json")).status).toBe("open");

    h.script(
      "thesis-methodologist",
      json({ guidance: "Explicar la muestra y sus límites.", protocolChange: false }),
    );
    h.script("thesis-writer", writerReply());
    h.script("thesis-editor", editorReply());
    await h.run("revise", "FND-0001");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer").at(-1)!.prompt).toContain(
      "Guidance from the methodologist: Explicar la muestra",
    );
    expect(JSON.parse(await h.read("reviews/FND-0001.json")).status).toBe("resolved");
  });

  it("lets the user dismiss a finding, but only with a reason", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script("thesis-reviewer", report(finding()));
    await h.run("review", "SEC-07");
    expect(await h.run("approve", "FND-0001")).toMatch(/say why FND-0001 can be dismissed/);
    expect(await h.run("approve", "FND-0001 -- the committee accepts this framing")).toContain(
      "Dismissed FND-0001",
    );
    const stored = JSON.parse(await h.read("reviews/FND-0001.json"));
    expect(stored).toMatchObject({
      status: "dismissed",
      notes: "the committee accepts this framing",
    });
    expect(await h.run("approve", "FND-0001 -- again")).toContain("already dismissed");
    expect(await h.run("revise", "FND-0009")).toMatch(/not a finding/);
  });

  it("supersedes the open findings of a section when it is reviewed again", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    h.script("thesis-reviewer", report(finding()), report());
    await h.run("review", "SEC-07");
    const again = await h.run("review", "SEC-07");
    expect(again).toContain("No findings.");
    expect(JSON.parse(await h.read("reviews/FND-0001.json")).status).toBe("superseded");
  });
});

describe("/thesis:approve ETH-...", () => {
  it("records how an ethics requirement was met", async () => {
    const h = await researched(noEngine);
    // Rewrite the protocol so a requirement exists.
    const path = join(h.workspace, "thesis", "research", "protocol.md");
    const text = await readFile(path, "utf8");
    const withEthics = text
      .replace("human_participants: false", "human_participants: true")
      .replace(
        "ethicsRequirements: []",
        "ethicsRequirements:\n  - { id: ETH-HUMAN_PARTICIPANTS-01, trigger: human_participants, ruleId: R1, text: Aprobación del comité, generic: false }",
      );
    await writeFile(path, withEthics);
    expect(await h.run("check", "G6")).toContain("ETH-001");
    expect(await h.run("approve", "ETH-HUMAN_PARTICIPANTS-01")).toMatch(
      /say how ETH-HUMAN_PARTICIPANTS-01 was met/,
    );
    expect(await h.run("approve", "ETH-ANIMALS-01 -- x")).toMatch(/not an ethics requirement/);
    expect(await h.run("approve", "ETH-HUMAN_PARTICIPANTS-01 -- Acta 12/2026, anexo B")).toContain(
      "Every ethics requirement has a resolution",
    );
    expect((await h.state()).ethicsResolutions["ETH-HUMAN_PARTICIPANTS-01"].text).toBe(
      "Acta 12/2026, anexo B",
    );
    expect(await h.run("check", "G6")).not.toContain("ETH-001");
  });
});

describe("/thesis:finalize", () => {
  it("refuses while a section is not approved", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    expect(await h.run("finalize")).toMatch(/Blocked: \d+ section\(s\) are not approved yet/);
  });

  it("refuses with an open major finding, and with no fresh review", async () => {
    const h = await researched(noEngine);
    await ready(h);
    const stale = await h.run("finalize");
    expect(stale).toContain("Blocked: the thesis is not ready for Human Gate C");
    expect(stale).toContain("No independent review was run");

    h.script("thesis-reviewer", report(finding()));
    await h.run("review", "all");
    const blocked = await h.run("finalize");
    expect(blocked).toContain("REV-001");
    expect(blocked).toContain("FND-0001 is an open major finding");
    expect((await h.state()).humanGates.C.status).toBe("pending");
    expect(await h.run("approve", "C")).toContain(
      "Blocked: the thesis is not ready for Human Gate C",
    );
    expect(await h.run("next")).toMatch(/open critical or major findings/);

    // Dismissing it (with a reason) unblocks the gate.
    await h.run("approve", "FND-0001 -- accepted");
    h.setInteractive(false);
    expect(await h.run("finalize")).toContain("Human Gate C is pending");
  });

  it("asks Human Gate C, records it and reports how to set up the engine when none exists", async () => {
    const h = await researched({ ...noEngine, answers: [{ C: "approve" }] });
    await ready(h);
    h.script("thesis-reviewer", report());
    expect(await h.run("review", "all")).toContain("No findings.");
    expect(await h.run("status")).toContain("Next: /thesis:finalize");
    h.setInteractive(true);
    const message = await h.run("finalize");
    expect(h.asked.at(-1)!.questions[0]).toMatchObject({
      id: "C",
      options: [{ value: "approve", recommended: true }, { value: "later" }],
    });
    expect(message).toContain("Approved Gate C.");
    expect(message).toContain("/thesis:setup");
    expect(message).toContain("Gate C stays approved");
    const state = await h.state();
    expect(state.phase).toBe("final");
    expect(state.humanGates.C.status).toBe("approved");
    expect(await h.run("next")).toContain("/thesis:setup"); // resumes at the build
  });

  it("leaves Gate C pending headlessly and approves it with /thesis:approve C", async () => {
    const h = await researched(noEngine);
    await ready(h);
    h.script("thesis-reviewer", report());
    await h.run("review", "all");
    h.setInteractive(false);
    expect(await h.run("finalize")).toContain("/thesis:approve C");
    expect(await h.run("approve", "C -- read it all")).toContain(
      "Approved Gate C. Next: /thesis:finalize",
    );
    expect((await h.state()).humanGates.C).toMatchObject({
      status: "approved",
      notes: "read it all",
    });
    expect(await h.run("approve", "C")).toContain("already approved");
  });

  it("requires the AI-use declaration the policy asks for (POL-AI-001)", async () => {
    const h = await researched(noEngine);
    await ready(h, { aiDeclaration: false });
    h.script("thesis-reviewer", report());
    await h.run("review", "all");
    expect(await h.run("finalize")).toContain("POL-AI-001");
  });

  it.skipIf(!typst)(
    "builds a PDF/A with the engine and writes the submission package",
    async () => {
      const h = await researched(engine);
      await ready(h);
      h.script("thesis-reviewer", report());
      await h.run("review", "all");
      h.setInteractive(false);
      await h.run("approve", "C");
      const message = await h.run("finalize");
      expect(message).toContain("Built the PDF/A");
      expect(message).toContain("Submission package: thesis/build/submission/");

      const state = await h.state();
      expect(state.phase).toBe("submitted");
      expect(state.finalBuild.sha256).toMatch(/^[0-9a-f]{64}$/);
      const directory = join(h.workspace, "thesis", "build", "submission");
      expect((await readdir(directory)).sort()).toEqual([
        "ai-declaration.md",
        "check-report.json",
        "compliance-profile.json",
        "manifest.json",
        "protocol.md",
        "references.bib",
        "thesis-pdfa.pdf",
      ]);
      const pdf = await readFile(join(directory, "thesis-pdfa.pdf"));
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.toString("latin1")).toContain("pdfaid:part");
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      expect(manifest.files.map((file: { path: string }) => file.path)).toContain(
        "thesis-pdfa.pdf",
      );
      const check = JSON.parse(await readFile(join(directory, "check-report.json"), "utf8"));
      expect(check.counts.error).toBe(0);
      expect(await readFile(join(directory, "ai-declaration.md"), "utf8")).toContain(
        "asistente de inteligencia artificial",
      );
      try {
        const info = execFileSync("pdfinfo", [join(directory, "thesis-pdfa.pdf")], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        expect(info).toMatch(/Pages:\s+\d+/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // pdfinfo is optional
      }
      expect(await h.run("finalize")).toContain("was submitted at");
      expect(await h.run("check", "G10")).toContain("Checks passed");
    },
  );
});

describe("figures", () => {
  const chart = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { url: "errores.csv" },
    mark: "bar",
    encoding: {
      x: { field: "tipo", type: "nominal", title: "Tipo de fuente" },
      y: { field: "errores", type: "quantitative", title: "Errores (%)" },
    },
  };
  const figure = (over: Record<string, unknown> = {}) => ({
    label: "fig-errores-tipo",
    kind: "chart",
    spec: chart,
    caption: "Errores de citación por tipo de fuente. Fuente: elaboración propia.",
    width: "80%",
    supports: "Los errores se concentran en los libros.",
    ...over,
  });

  async function withData(h: Lifecycle) {
    await mkdir(join(h.workspace, "thesis", "data"), { recursive: true });
    await cp(
      join(import.meta.dirname, "fixtures", "sample-es", "data", "errores.csv"),
      join(h.workspace, "thesis", "data", "errores.csv"),
    );
  }

  it("validates a chart with the FIG checks, writes it and returns the Markdown to insert", async () => {
    const h = await researched(noEngine);
    await withData(h);
    h.script("thesis-writer", json(figure()));
    const message = await h.run("figure", "SEC-07 -- barras de errores por tipo de fuente");
    expect(message).toContain("Wrote figures/charts/errores-tipo.vl.json.");
    expect(message).toContain(
      "![Errores de citación por tipo de fuente. Fuente: elaboración propia.](figures/charts/errores-tipo.vl.json){#fig-errores-tipo width=80%}",
    );
    expect(JSON.parse(await h.read("figures/charts/errores-tipo.vl.json")).mark).toBe("bar");
    const prompt = h.prompts.find((entry) => entry.role === "thesis-writer")!.prompt;
    expect(prompt).toContain("data/errores.csv");
    expect(prompt).toContain("Artículo,Manual,3.1");
    expect(prompt).toContain("barras de errores por tipo de fuente");
  });

  it("retries a chart that sets colors or points at a missing file", async () => {
    const h = await researched(noEngine);
    await withData(h);
    h.script(
      "thesis-writer",
      json(figure({ spec: { ...chart, config: { range: { category: ["#ff0000"] } } } })),
      json(figure({ spec: { ...chart, data: { url: "no-existe.csv" } } })),
    );
    const message = await h.run("figure", "SEC-07 -- barras");
    expect(message).toContain("did not return a valid figure after one retry");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!;
    expect(retry.prompt).toContain("FIG-003");
    expect(message).toMatch(/FIG-001|no-existe/);
    await expect(h.read("figures/charts/errores-tipo.vl.json")).rejects.toThrow();
  });

  it("requires a source line in the caption", async () => {
    const h = await researched(noEngine);
    await withData(h);
    h.script("thesis-writer", json(figure({ caption: "Errores por tipo." })), json(figure()));
    await h.run("figure", "SEC-07 -- barras");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!.prompt).toContain(
      "FIG-004",
    );
    expect(await h.read("figures/charts/errores-tipo.vl.json")).toContain("errores.csv");
  });

  it("drafts a diagram and a table, and refuses a label that is already used", async () => {
    const h = await researched(noEngine);
    h.script(
      "thesis-writer",
      json({
        label: "fig-flujo-nuevo",
        kind: "diagram",
        source: "flowchart LR\n  A[Buscar] --> B[Verificar]",
        caption: "Flujo de verificación. Fuente: elaboración propia.",
        supports: "El flujo.",
      }),
    );
    expect(await h.run("figure", "SEC-07 -- diagrama del flujo")).toContain(
      "figures/diagrams/flujo-nuevo.mmd",
    );
    expect(await h.read("figures/diagrams/flujo-nuevo.mmd")).toContain("A[Buscar]");

    h.script(
      "thesis-writer",
      json({
        label: "tbl-resumen",
        kind: "table",
        table: "| Tipo | Errores |\n|:--|--:|\n| Libro | 5.8 |",
        caption: "Errores por tipo. Fuente: elaboración propia.",
        supports: "La tabla.",
      }),
    );
    const table = await h.run("figure", "SEC-07 -- tabla de resultados");
    expect(table).toContain("Table: Errores por tipo. Fuente: elaboración propia. {#tbl-resumen}");
    expect(table).toContain("| Libro | 5.8 |");

    // A drafted section uses fig-flujo through its own figures; a second figure may not reuse the label.
    h.script(
      "thesis-writer",
      writerReply({
        figures: [
          {
            label: "fig-flujo2",
            kind: "diagram",
            source: "flowchart LR\n  A --> B",
            caption: "Otro flujo. Fuente: propia.",
            supports: "x",
          },
        ],
      }),
    );
    h.script("thesis-editor", editorReply());
    await h.run("draft", "SEC-07");
    h.script(
      "thesis-writer",
      json({
        label: "fig-flujo2",
        kind: "diagram",
        source: "flowchart LR\n  A --> B",
        caption: "Otro. Fuente: propia.",
        supports: "x",
      }),
      json({
        label: "fig-flujo3",
        kind: "diagram",
        source: "flowchart LR\n  A --> B",
        caption: "Otro. Fuente: propia.",
        supports: "x",
      }),
    );
    await h.run("figure", "SEC-07 -- otro diagrama");
    expect(
      h.prompts.filter((entry) => entry.role === "thesis-writer").at(-2)!.prompt,
    ).toBeDefined();
    expect(await h.read("figures/diagrams/flujo3.mmd")).toContain("A --> B");
  });

  it("validates figures declared inside a section draft", async () => {
    const h = await researched(noEngine);
    await withData(h);
    h.script(
      "thesis-writer",
      writerReply((prompt) => ({
        markdown: sectionDraft(prompt).markdown.replace(
          "<!-- claim:c2 -->",
          "Véase @fig-errores-tipo.\n\n[[figure fig-errores-tipo]]\n\n<!-- claim:c2 -->",
        ),
        figures: [figure()],
      })),
    );
    h.script("thesis-editor", editorReply());
    await h.run("draft", "SEC-07");
    const chapter = await h.read("chapters/07-marco.md");
    expect(chapter).toContain(
      "](figures/charts/errores-tipo.vl.json){#fig-errores-tipo width=80%}",
    );
    expect(chapter).not.toContain("[[figure");
    expect(await h.read("figures/charts/errores-tipo.vl.json")).toContain("errores.csv");
  });
});
