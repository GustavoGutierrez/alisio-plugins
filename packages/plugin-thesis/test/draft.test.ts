// biome-ignore-all lint/style/noNonNullAssertion: fixtures index arrays whose length the test controls
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaimsText } from "../src/claims.js";
import { json } from "./helpers/data.js";
import { cleanup } from "./helpers/harness.js";
import {
  bodyOf,
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
  coordinator: {
    env: {
      LANG: "es_CO.UTF-8",
      ALISIO_THESIS_TYPST: "/nonexistent/typst",
      ALISIO_THESIS_CHROME: "off",
    },
  },
};

describe("/thesis:draft", () => {
  it("drafts from approved evidence, edits, writes the chapter and the claims, and asks for approval", async () => {
    const h = await researched();
    const message = await drafted(h);
    expect(message).toContain("Drafted SEC-07 Marco teórico: chapters/07-marco.md.");
    expect(message).toContain("Editor pass applied");
    expect(message).toContain("/thesis:approve SEC-07");

    const chapter = await h.read("chapters/07-marco.md");
    expect(chapter).toMatch(
      /^---\nsection: SEC-07\n---\n\n# Marco teórico \{#sec-marco\}\n\n<!-- claim:c1 -->/,
    );
    expect(chapter).toContain("Asimismo,"); // the editor's wording change
    expect(chapter).toContain("[@rojas2021]");

    const claims = parseClaimsText(await h.read("claims/claims.jsonl")).records;
    expect(claims.map((entry) => [entry.id, entry.section, entry.anchor, entry.kind])).toEqual([
      ["CLM-0001", "SEC-07", "c1", "background"],
      ["CLM-0002", "SEC-07", "c2", "argument"],
    ]);
    expect(claims[0]?.evidence).toEqual(["EVD-00001"]);

    const state = await h.state();
    expect(state.sections["SEC-07"]).toMatchObject({
      status: "draft_review",
      chapter: "chapters/07-marco.md",
    });
    expect(state.counters.claim).toBe(2);
    expect(state.phase).toBe("sections");
  });

  it("gives the writer only citable evidence, read-only tools and the dossier", async () => {
    const h = await researched();
    await drafted(h);
    const writer = h.prompts.find((entry) => entry.role === "thesis-writer")!;
    expect(writer.spec).toMatchObject({
      readOnly: true,
      permission: { write: "deny", process: "deny" },
      maxOutputTokens: 12000,
      tools: { deny: expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]) },
    });
    const packet = packetOf(writer.prompt);
    // petrov2022 is CONTEXTUAL_ONLY: not in the packet until the user approves it for the section.
    expect(packet.map((entry) => entry.citeKey).sort()).toEqual(["rojas2021", "vega2018"]);
    expect(writer.prompt).toContain("DOSSIER");
    expect(writer.prompt).toContain("Write in the thesis language: es-CO");
    const editor = h.prompts.find((entry) => entry.role === "thesis-editor")!;
    expect(editor.spec).toMatchObject({ readOnly: true, permission: { write: "deny" } });
  });

  it("retries a draft that cites a key outside the packet, then writes the corrected one", async () => {
    const h = await researched();
    h.script(
      "thesis-writer",
      (prompt) =>
        json(
          sectionDraft(prompt, {
            markdown: "<!-- claim:c1 -->\nLa verificación es viable [@petrov2022].",
            claims: [claim({ anchor: "c1", evidence: ["EVD-00001"] })],
          }),
        ),
      writerReply(),
    );
    h.script("thesis-editor", editorReply());
    await h.run("draft", "SEC-07");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!;
    expect(retry.prompt).toContain("Your previous reply was rejected");
    expect(retry.prompt).toMatch(/@petrov2022/);
    expect((await h.state()).sections["SEC-07"]?.status).toBe("draft_review");
  });

  it("leaves the section as it was, and writes nothing, after two bad drafts", async () => {
    const h = await researched();
    const bad = (prompt: string) =>
      json(
        sectionDraft(prompt, {
          markdown: "<!-- claim:c1 -->\nTexto con una fuente inventada [@inventado2020].",
          claims: [claim({ anchor: "c1", evidence: ["EVD-00001"] })],
        }),
      );
    h.script("thesis-writer", bad, bad);
    const message = await h.run("draft", "SEC-07");
    expect(message).toContain("did not return a valid draft after one retry");
    expect(message).toContain("inventado2020");
    await expect(h.read("chapters/07-marco.md")).rejects.toThrow();
    await expect(h.read("claims/claims.jsonl")).rejects.toThrow();
    expect((await h.state()).sections["SEC-07"]?.status).toBe("research_approved");
  });

  it("rejects a draft whose claim anchors do not match its declared claims", async () => {
    const h = await researched();
    h.script(
      "thesis-writer",
      writerReply({ claims: [claim({ anchor: "c1", evidence: ["EVD-00001"] })] }),
      writerReply(),
    );
    h.script("thesis-editor", editorReply());
    await h.run("draft", "SEC-07");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!;
    expect(retry.prompt).toContain("CLM-001");
    expect(retry.prompt).toContain("Claim anchor c2 has no record");
  });

  it("fails CLM-003 for a conclusion that rests on no result, and accepts one that does", async () => {
    const h = await researched();
    const conclusion = (results: string[]) => (prompt: string) => {
      const [first] = packetOf(prompt);
      return json(
        sectionDraft(prompt, {
          markdown: [
            "<!-- claim:c1 -->",
            `El indicador de exactitud alcanzó un valor alto en el corpus de prueba que se utilizó durante toda la evaluación del método propuesto [@${first?.citeKey}].`,
            "",
            "<!-- claim:c2 -->",
            "Por lo tanto, se concluye que la verificación automática cumple el objetivo general del trabajo y que su uso es recomendable en proyectos similares.",
          ].join("\n"),
          claims: [
            claim({ anchor: "c1", kind: "result", evidence: [first?.id], objectives: ["OBJ-03"] }),
            claim({ anchor: "c2", kind: "conclusion", results, objectives: ["OBJ-G"] }),
          ],
        }),
      );
    };
    h.script("thesis-writer", conclusion([]), conclusion(["c1"]));
    h.script(
      "thesis-editor",
      editorReply((body) => body),
    );
    await h.run("draft", "SEC-07");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!;
    expect(retry.prompt).toContain("CLM-003");
    expect(retry.prompt).toContain("does not rest on any result claim");
    const claims = parseClaimsText(await h.read("claims/claims.jsonl")).records;
    expect(claims.find((entry) => entry.anchor === "c2")).toMatchObject({
      kind: "conclusion",
      results: ["CLM-0001"],
    });
  });

  it("rejects an editor pass that changes a citation, then keeps the writer's text", async () => {
    const h = await researched();
    h.script("thesis-writer", writerReply());
    const tamper = editorReply((body) => body.replace("[@rojas2021]", "[@vega2018]"));
    h.script("thesis-editor", tamper, tamper);
    const message = await h.run("draft", "SEC-07");
    expect(message).toContain("The editor pass was rejected");
    const retry = h.prompts.filter((entry) => entry.role === "thesis-editor")[1]!;
    expect(retry.prompt).toContain("The edit changed citations or cross-references");
    const chapter = await h.read("chapters/07-marco.md");
    expect(chapter).toContain("[@rojas2021]");
    expect(chapter).toContain("Además,"); // not edited
    expect((await h.state()).sections["SEC-07"]?.status).toBe("draft_review");
  });

  it("rejects an editor pass that changes a number or a claim anchor", async () => {
    const h = await researched();
    h.script("thesis-writer", writerReply());
    const changeNumber = editorReply((body) => `${body}\n\nEl 5 % restante.`);
    h.script("thesis-editor", changeNumber, changeNumber);
    const message = await h.run("draft", "SEC-07");
    expect(message).toContain("The editor pass was rejected");
    expect(h.prompts.filter((entry) => entry.role === "thesis-editor")[1]!.prompt).toContain(
      "changed numbers",
    );
    // Guard sanity: the editor sees the body, which carries the anchors.
    expect(bodyOf(h.prompts.find((entry) => entry.role === "thesis-editor")!.prompt)).toContain(
      "claim:c1",
    );
  });

  it("warns (LNG-001) about a section written in the wrong language but still drafts it", async () => {
    const h = await researched();
    const english = (prompt: string) => {
      const [first, second] = packetOf(prompt);
      return json(
        sectionDraft(prompt, {
          markdown: [
            "<!-- claim:c1 -->",
            `The verification of references is feasible and it reduces the citation errors in the theses that are written by students of the university, because the tools are available for all of them [@${first?.citeKey}].`,
            "",
            "<!-- claim:c2 -->",
            `The integrity of the citations depends on checking each source against open records that are maintained by the publishers [@${second?.citeKey}], and this is the reason for the approach of this work.`,
          ].join("\n"),
        }),
      );
    };
    h.script("thesis-writer", english);
    h.script(
      "thesis-editor",
      editorReply((body) => body),
    );
    const message = await h.run("draft", "SEC-07");
    expect(message).toContain("LNG-001");
    expect((await h.state()).sections["SEC-07"]?.status).toBe("draft_review");
  });

  it("blocks drafting before the research is approved and before dependencies are approved", async () => {
    const h = await researched();
    expect(await h.run("draft", "SEC-08")).toMatch(
      /Blocked: SEC-08 is planned; it needs approved research/,
    );
    expect(await h.run("draft", "SEC-99")).toMatch(/not a section of the approved outline/);
    // The bibliography is generated and counts as approved from the start.
    expect(await h.run("draft", "SEC-12")).toContain("generated from the evidence library");
    expect((await h.state()).sections["SEC-12"]?.status).toBe("approved");
  });
});

describe("section approval", () => {
  it("asks with Approve section recommended, then approves and reports the partial build", async () => {
    const h = await researched({ ...noEngine, answers: [{ section: "approve" }] });
    h.setInteractive(true);
    h.script("thesis-writer", writerReply());
    h.script("thesis-editor", editorReply());
    const message = await h.run("draft", "SEC-07");
    const question = h.asked.at(-1)!.questions[0]!;
    expect(question.options.map((option) => option.label)).toEqual([
      "Approve section",
      "Revise with feedback",
      "Re-research",
    ]);
    expect(question.options[0]).toMatchObject({ recommended: true });
    expect(question.options[1]?.textInput).toBeDefined();
    expect(message).toContain("Approved SEC-07 Marco teórico.");
    expect(message).toContain("/thesis:setup"); // no engine: fail-open with the way out
    expect((await h.state()).sections["SEC-07"]?.status).toBe("approved");
  });

  it("approves with /thesis:approve SEC-07 and refuses a section that is not in draft review", async () => {
    const h = await researched(noEngine);
    expect(await h.run("approve", "SEC-08")).toMatch(/no research to approve yet/);
    await drafted(h);
    const message = await h.run("approve", "SEC-07");
    expect(message).toContain("Approved SEC-07");
    expect(message).toContain("2 of 13 sections approved");
    expect(await h.run("approve", "SEC-07")).toContain("already approved");
  });

  it("revises with feedback: the writer sees the previous draft and the feedback", async () => {
    const h = await researched();
    await drafted(h);
    h.script("thesis-writer", writerReply());
    h.script("thesis-editor", editorReply());
    await h.run("revise", "SEC-07 -- Add a sentence about limitations");
    const writer = h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!;
    expect(writer.prompt).toContain("PREVIOUS DRAFT");
    expect(writer.prompt).toContain("Add a sentence about limitations");
    const claims = parseClaimsText(await h.read("claims/claims.jsonl")).records;
    // The section's claims are replaced, never duplicated.
    expect(claims.filter((entry) => entry.section === "SEC-07")).toHaveLength(2);
    expect((await h.state()).sections["SEC-07"]?.status).toBe("draft_review");
  });

  it("goes back to research from the approval prompt", async () => {
    const h = await researched({
      answers: [{ section: "research", "section:text": "more on benchmarks" }],
    });
    h.setInteractive(true);
    h.script("thesis-writer", writerReply());
    h.script("thesis-editor", editorReply());
    h.script(
      "thesis-librarian",
      json({ queries: [], yearRangeReason: "x", webToolsAvailable: false, gaps: [] }),
      json({ candidates: [], gaps: [], webToolsUsed: false }),
    );
    h.script("thesis-architect", (prompt) => {
      void prompt;
      return json({ synthesis: [], claims: [], gaps: [] });
    });
    const message = await h.run("draft", "SEC-07");
    const librarian = h.prompts.filter((entry) => entry.role === "thesis-librarian")[2];
    expect(librarian?.prompt ?? message).toContain("more on benchmarks");
  });
});

describe("sections that need no research", () => {
  it("drafts the AI declaration before research, and the abstract only after the body is approved", async () => {
    const h = await researched();
    expect(await h.run("status")).toContain(
      "SEC-03 Declaración de uso de IA [planned] -> /thesis:draft SEC-03",
    );
    h.script("thesis-writer", () =>
      json(
        sectionDraft("", {
          markdown:
            "Se utilizó un asistente de escritura y el autor revisó y asume todo el contenido del trabajo presentado en este documento.",
          claims: [],
        }),
      ),
    );
    h.script(
      "thesis-editor",
      editorReply((body) => body),
    );
    const message = await h.run("draft", "SEC-03");
    expect(message).toContain(
      "Drafted SEC-03 Declaración de uso de IA: chapters/03-declaracion-ia.md.",
    );
    const chapter = await h.read("chapters/03-declaracion-ia.md");
    expect(chapter).toMatch(/^---\nrole: ai-declaration\nsection: SEC-03\n---\n\nSe utilizó/);
    expect(chapter).not.toContain("# "); // no heading: the template prints the title
    expect((await h.state()).sections["SEC-03"]).toMatchObject({
      status: "draft_review",
      role: "ai-declaration",
    });

    // The abstract summarizes the whole thesis, so it waits for every other section.
    expect(await h.run("draft", "SEC-01")).toMatch(
      /Blocked: SEC-01 summarizes the whole thesis, so it is written last; first approve SEC-04, SEC-05/,
    );
  });

  it("gives an abstract its keywords and language in the front matter", async () => {
    const h = await researched();
    const path = join(h.workspace, ".alisio", "thesis", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    for (const [id, section] of Object.entries(state.sections) as [string, { status: string }][])
      if (id !== "SEC-01" && id !== "SEC-02") section.status = "approved";
    await writeFile(path, `${JSON.stringify(state)}\n`);
    h.script("thesis-writer", () =>
      json(
        sectionDraft("", {
          markdown:
            "Este trabajo presenta un flujo reproducible que verifica cada referencia contra fuentes abiertas antes de redactar el documento final del trabajo de grado.",
          keywords: ["evidencia verificada", "citación", "tesis"],
          claims: [],
        }),
      ),
    );
    h.script(
      "thesis-editor",
      editorReply((body) => body),
    );
    await h.run("draft", "SEC-01");
    const chapter = await h.read("chapters/01-resumen.md");
    expect(chapter).toMatch(
      /^---\nrole: abstract\nsection: SEC-01\nlang: es\nkeywords:\n {2}- evidencia verificada\n {2}- citación\n {2}- tesis\n---\n\nEste trabajo/,
    );
    const prompt = h.prompts.filter((entry) => entry.role === "thesis-writer").at(-1)!.prompt;
    expect(prompt).toContain("This is the abstract in es");
  });

  it("rejects an abstract without keywords and a draft with headings it may not have", async () => {
    const h = await researched();
    const path = join(h.workspace, ".alisio", "thesis", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    for (const [id, section] of Object.entries(state.sections) as [string, { status: string }][])
      if (id !== "SEC-01" && id !== "SEC-02") section.status = "approved";
    await writeFile(path, `${JSON.stringify(state)}\n`);
    const text =
      "Este trabajo presenta un flujo reproducible que verifica cada referencia contra fuentes abiertas antes de redactar el documento final.";
    h.script(
      "thesis-writer",
      () => json(sectionDraft("", { markdown: text, keywords: [], claims: [] })),
      () =>
        json(sectionDraft("", { markdown: `## Título\n\n${text}`, keywords: ["a"], claims: [] })),
    );
    const message = await h.run("draft", "SEC-01");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!.prompt).toContain(
      "An abstract needs keywords",
    );
    expect(message).toContain("have no headings");
  });
});

describe("headings", () => {
  it("accepts subsections below the title and rejects a heading at the title's level", async () => {
    const h = await researched();
    const withHeading = (marker: string) => (prompt: string) => {
      const draft = sectionDraft(prompt);
      return json({ ...draft, markdown: `${marker} Subtema {#sec-subtema}\n\n${draft.markdown}` });
    };
    h.script("thesis-writer", withHeading("#"), withHeading("##"));
    h.script(
      "thesis-editor",
      editorReply((body) => body),
    );
    await h.run("draft", "SEC-07");
    expect(h.prompts.filter((entry) => entry.role === "thesis-writer")[1]!.prompt).toContain(
      "Heading level 1 is reserved",
    );
    expect(await h.read("chapters/07-marco.md")).toContain("## Subtema {#sec-subtema}");
  });
});
