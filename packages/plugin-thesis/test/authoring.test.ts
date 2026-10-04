// biome-ignore-all lint/style/noNonNullAssertion: fixtures index arrays whose length the test controls
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { json } from "./helpers/data.js";
import { cleanup, intakeAnswers, type Lifecycle, lifecycle } from "./helpers/harness.js";

afterEach(cleanup);

const typst = process.env.ALISIO_THESIS_TYPST;
const engineEnv = { LANG: "es_CO.UTF-8", ALISIO_THESIS_TYPST: typst ?? "/nonexistent/typst" };

async function interviewed(env = engineEnv, answers: Record<string, string>[] = []) {
  const h = await lifecycle({
    answers: [...intakeAnswers, ...answers],
    coordinator: { env },
  });
  await h.run("init", "--lang es-CO");
  h.setInteractive(false);
  return h;
}

const shippedIeee = async () =>
  readFile(join(import.meta.dirname, "..", "styles", "ieee.csl"), "utf8");

/** A valid workspace style: the shipped IEEE style under another id. */
async function styleDraft(id: string, over: Record<string, unknown> = {}) {
  const csl = (await shippedIeee())
    .replace(/<id>[^<]*<\/id>/, `<id>${id}</id>`)
    .replace(/<title>[^<]*<\/title>/, "<title>Guía de la Universidad Ejemplo</title>")
    .replace(/<link [^>]*rel="self"[^>]*\/>/, "");
  return {
    csl,
    questions: [],
    ruleTrace: [
      {
        rule: "Referencias numeradas",
        guide: "Guía, sección 3",
        effect: "Citas numéricas entre corchetes",
      },
    ],
    ...over,
  };
}

describe("/thesis:style new", () => {
  it("is blocked without the Typst engine, before any child runs", async () => {
    const h = await interviewed({ LANG: "es_CO.UTF-8", ALISIO_THESIS_TYPST: "/nonexistent/typst" });
    const message = await h.run("style", "new mi-universidad -- Las referencias van numeradas.");
    expect(message).toContain("Run /thesis:setup");
    expect(h.prompts).toHaveLength(0);
  });

  it("validates the arguments, the id and the guide", async () => {
    const h = await interviewed();
    await expect(h.run("style", "new")).rejects.toThrow(/Usage: \/thesis:style new <id>/);
    expect(await h.run("style", "new MiUniversidad -- guía")).toMatch(
      /lowercase letters, digits and dashes/,
    );
    expect(await h.run("style", "new ieee -- guía")).toMatch(/shipped with the plugin/);
    expect(await h.run("style", "new mi-guia -- ../secreto.txt")).toMatch(
      /Unsafe relative path|does not exist/,
    );
    expect(await h.run("style", "new mi-guia -- docs/reglamento.txt")).toMatch(
      /does not exist in the workspace/,
    );
    expect(await h.run("style", "new mi-guia -- reglamento.pdf")).toMatch(
      /PDF cannot be read here/,
    );
    expect(h.prompts).toHaveLength(0);
  });

  it.skipIf(!typst)(
    "authors a style, renders the fixtures, blocks on open questions and writes on approval",
    { timeout: 40_000 },
    async () => {
      const h = await interviewed();
      h.script(
        "thesis-editor",
        json(
          await styleDraft("mi-universidad", {
            questions: ["¿El título del libro va en cursiva?"],
          }),
        ),
        json(await styleDraft("mi-universidad")),
      );
      const shown = await h.run(
        "style",
        "new mi-universidad -- Las referencias se numeran en orden de aparición, entre corchetes.",
      );
      expect(shown).toContain('Drafted the style "mi-universidad"');
      expect(shown).toContain("Fixtures rendered in es-CO:");
      expect(shown).toMatch(/journal\n\s+in text:\s+\[1, p\. 12\]/);
      expect(shown).toContain("1. ¿El título del libro va en cursiva?");
      expect(shown).toContain("/thesis:approve style:mi-universidad");
      expect(
        await readFile(
          join(h.workspace, "thesis", "build", "authoring", "style-mi-universidad.json"),
          "utf8",
        ),
      ).toContain("mi-universidad");
      // Nothing is applied before approval.
      await expect(
        readFile(join(h.workspace, "thesis", "styles", "mi-universidad.csl"), "utf8"),
      ).rejects.toThrow();

      const blocked = await h.run("approve", "style:mi-universidad");
      expect(blocked).toContain("has open questions");
      expect(await h.run("revise", "style:mi-universidad -- answers:")).toMatch(
        /Usage|give one answer/,
      );
      expect(await h.run("revise", "style:mi-universidad -- answers: Sí, en cursiva")).toContain(
        'Drafted the style "mi-universidad"',
      );
      const second = h.prompts.filter((entry) => entry.role === "thesis-editor")[1]!;
      expect(second.prompt).toContain("ANSWERS ALREADY GIVEN BY THE AUTHOR");
      expect(second.prompt).toContain("Sí, en cursiva");
      expect(second.spec).toMatchObject({ readOnly: true, permission: { write: "deny" } });

      const approved = await h.run("approve", "style:mi-universidad");
      expect(approved).toContain('Approved the style "mi-universidad"');
      expect(approved).toContain("set citationStyle: mi-universidad");
      expect(
        await readFile(join(h.workspace, "thesis", "styles", "mi-universidad.csl"), "utf8"),
      ).toContain("<id>mi-universidad</id>");
      const golden = JSON.parse(
        await readFile(
          join(h.workspace, "thesis", "styles", "fixtures", "mi-universidad.expected.json"),
          "utf8",
        ),
      );
      expect(golden).toMatchObject({ styleId: "mi-universidad", lang: "es-CO" });
      expect(Object.keys(golden.bibliography)).toHaveLength(8);
      expect((await h.state()).styles["mi-universidad"].approvedAt).toBeDefined();

      // The golden check (CSL-010) accepts what was approved, and the style is listed.
      expect(await h.run("style", "check")).toContain("Checks passed");
      expect(await h.run("style", "list")).toContain(
        "mi-universidad: Guía de la Universidad Ejemplo",
      );
    },
  );

  it.skipIf(!typst)(
    "retries a style that fails CSL-001 and asks the approval question interactively",
    { timeout: 40_000 },
    async () => {
      const h = await interviewed(engineEnv, [{ style: "approve" }]);
      const bad = await styleDraft("mi-guia");
      h.script(
        "thesis-editor",
        json({ ...bad, csl: `<!DOCTYPE style [<!ENTITY x "y">]>${bad.csl}` }),
        json(await styleDraft("mi-guia")),
      );
      h.setInteractive(true);
      const message = await h.run(
        "style",
        "new mi-guia -- Guía de la universidad: referencias numeradas.",
      );
      expect(h.prompts[1]!.prompt).toContain("CSL-001");
      const question = h.asked.at(-1)!.questions[0]!;
      expect(question.options.map((option) => option.label)).toEqual([
        "Approve style",
        "Correct with feedback",
        "Answer open questions",
      ]);
      expect(question.options[0]).toMatchObject({ recommended: true });
      expect(message).toContain('Approved the style "mi-guia"');
      expect(
        await readFile(join(h.workspace, "thesis", "styles", "mi-guia.csl"), "utf8"),
      ).toContain("mi-guia");
    },
  );

  it.skipIf(!typst)(
    "writes a presentation profile too, and validates it (PRF-001)",
    { timeout: 40_000 },
    async () => {
      const h = await interviewed();
      h.script(
        "thesis-editor",
        json(await styleDraft("mi-perfil", { profile: "margins: { top: 3cm }\nunknownKey: 1\n" })),
        json(
          await styleDraft("mi-perfil", {
            profile: "extends: generic\nmargins:\n  top: 3cm\n  bottom: 3cm\n",
          }),
        ),
      );
      await h.run("style", "new mi-perfil -- Márgenes de 3 cm.");
      expect(h.prompts[1]!.prompt).toContain("PRF-001");
      expect(await h.run("approve", "style:mi-perfil")).toContain("styles/mi-perfil.profile.yaml");
      expect(
        await readFile(join(h.workspace, "thesis", "styles", "mi-perfil.profile.yaml"), "utf8"),
      ).toContain("top: 3cm");
    },
  );

  it.skipIf(!typst)("takes the guide from a workspace file", async () => {
    const h = await interviewed();
    await mkdir(join(h.workspace, "guides"), { recursive: true });
    await writeFile(
      join(h.workspace, "guides", "referencias.txt"),
      "Regla 7: los libros llevan ciudad y editorial.",
    );
    h.script("thesis-editor", json(await styleDraft("desde-archivo")));
    await h.run("style", "new desde-archivo -- guides/referencias.txt");
    expect(h.prompts[0]!.prompt).toContain("Regla 7: los libros llevan ciudad y editorial.");
  });

  it.skipIf(!typst)("passes a URL to the editor as a fetch instruction", async () => {
    const h = await interviewed();
    h.script("thesis-editor", json(await styleDraft("desde-url")));
    await h.run("style", "new desde-url -- https://ejemplo.edu.co/guia-de-estilo");
    expect(h.prompts[0]!.prompt).toContain("URL: https://ejemplo.edu.co/guia-de-estilo");
    expect((h.prompts[0]!.spec.tools as { allow: string[] }).allow).toContain("web_fetch");
  });

  it("reports an editor that never returns a valid style", async () => {
    // Without an engine nothing runs; with one, two bad replies leave nothing behind.
    if (!typst) return;
    const h = await interviewed();
    h.script(
      "thesis-editor",
      json({ csl: "no es xml", questions: [], ruleTrace: [] }),
      json({ csl: "tampoco", questions: [], ruleTrace: [] }),
    );
    expect(await h.run("style", "new mala -- x")).toContain(
      "did not return a valid style after one retry",
    );
    await expect(
      readFile(join(h.workspace, "thesis", "styles", "mala.csl"), "utf8"),
    ).rejects.toThrow();
  });
});

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  ruleId: id,
  level: "INSTITUTIONAL_RULE",
  status: "active",
  appliesWhen: {},
  requirement: { kind: "page_margins", values: { top: "3cm", bottom: "3cm" } },
  source: {
    reference: "Reglamento de trabajos de grado, art. 12",
    url: "https://ejemplo.edu.co/reglamento",
  },
  verification: { lastChecked: "2026-10-04", basis: "official_text" },
  supersedes: [],
  ...over,
});

const normsDraft = (over: Record<string, unknown> = {}) => ({
  pack: {
    scope: "institution",
    id: "ignored",
    description: "Reglamento de la Universidad Ejemplo",
    appliesWhen: {},
  },
  rules: [
    rule("EJEMPLO.REGLAMENTO.MARGEN.01"),
    rule("EJEMPLO.REGLAMENTO.RESUMEN.01", {
      requirement: {
        kind: "length_limit",
        values: { section: "abstract", maxWords: 200, severity: "warning" },
      },
      verification: { lastChecked: "2026-10-04", basis: "secondary_source" },
    }),
  ],
  questions: [],
  sourceTrace: [
    { rule: "EJEMPLO.REGLAMENTO.MARGEN.01", guide: "art. 12: «márgenes de 3 cm»", effect: "" },
  ],
  ...over,
});

describe("/thesis:norms import", () => {
  it("shows the extracted rules for approval and writes a workspace pack on approval", async () => {
    const h = await interviewed();
    h.script("thesis-editor", json(normsDraft()));
    const shown = await h.run(
      "norms",
      "import -- Art. 12: los márgenes son de 3 cm. Art. 14: el resumen no excede 200 palabras.",
    );
    expect(shown).toContain("Extracted 2 rule(s) for a institution pack (CO-example-university");
    expect(shown).toContain(
      "EJEMPLO.REGLAMENTO.MARGEN.01 [INSTITUTIONAL_RULE, page_margins, official_text]",
    );
    expect(shown).toContain("/thesis:approve norms");
    // Not written before approval.
    await expect(
      readFile(
        join(
          h.workspace,
          "thesis",
          "policy-packs",
          "institutions",
          "CO",
          "example-university",
          "manifest.yaml",
        ),
        "utf8",
      ),
    ).rejects.toThrow();

    const approved = await h.run("approve", "norms");
    expect(approved).toContain("re-resolved compliance-profile.json");
    expect(approved).toContain("2 of 2 imported rule(s) apply");
    const directory = join(
      h.workspace,
      "thesis",
      "policy-packs",
      "institutions",
      "CO",
      "example-university",
    );
    const manifest = await readFile(join(directory, "manifest.yaml"), "utf8");
    expect(manifest).toContain("packId: CO-example-university");
    expect(manifest).toContain("scope: institution");
    expect(manifest).toContain("extends: CO");
    const files = (await import("node:fs/promises")).readdir(directory);
    expect((await files).some((name) => name.startsWith("import-"))).toBe(true);

    const profile = JSON.parse(await h.read("compliance-profile.json"));
    expect(profile.rules.map((entry: { ruleId: string }) => entry.ruleId)).toContain(
      "EJEMPLO.REGLAMENTO.MARGEN.01",
    );
    const check = await h.run("pack", "check");
    expect(check).toContain("Checks passed");
    expect(await h.run("pack", "list")).toContain("CO-example-university [institution, workspace]");
    expect(await h.run("pack", "explain EJEMPLO.REGLAMENTO.MARGEN.01")).toContain("applied");
  });

  it("rejects a rule that reuses a shipped ruleId without overrides (PCK-002), then accepts the fix", async () => {
    const h = await interviewed();
    h.script(
      "thesis-editor",
      json(normsDraft({ rules: [rule("GLOBAL.ICMJE.2026.AI.AUTHORSHIP.01")] })),
      json(normsDraft()),
    );
    const shown = await h.run("norms", "import -- guía");
    expect(h.prompts[1]!.prompt).toContain("PCK-002");
    expect(shown).toContain("Extracted 2 rule(s)");
  });

  it("rejects an unknown requirement kind and unknown appliesWhen keys", async () => {
    const h = await interviewed();
    h.script(
      "thesis-editor",
      json(
        normsDraft({
          rules: [rule("A.B.C.01", { requirement: { kind: "tamano_de_letra", values: {} } })],
        }),
      ),
      json(normsDraft({ rules: [rule("A.B.C.02", { appliesWhen: { colorFavorito: "azul" } })] })),
    );
    const message = await h.run("norms", "import -- guía");
    expect(message).toContain("did not return valid rules after one retry");
    expect(message).toContain("colorFavorito");
    expect(h.prompts[1]!.prompt).toContain("closed vocabulary");
  });

  it("blocks approval while questions are open, then takes the answers", async () => {
    const h = await interviewed();
    h.script(
      "thesis-editor",
      json(normsDraft({ questions: ["¿El límite del resumen incluye las palabras clave?"] })),
      json(normsDraft()),
    );
    await h.run("norms", "import -- guía");
    expect(await h.run("approve", "norms")).toContain("open questions");
    expect(await h.run("revise", "norms -- answers: No, no las incluye")).toContain(
      "Extracted 2 rule(s)",
    );
    expect(h.prompts[1]!.prompt).toContain("No, no las incluye");
    expect(await h.run("approve", "norms")).toContain("re-resolved compliance-profile.json");
  });

  it("asks interactively with the three options", async () => {
    const h = await interviewed(engineEnv, [{ norms: "approve" }]);
    h.setInteractive(true);
    h.script("thesis-editor", json(normsDraft()));
    const message = await h.run("norms", "import -- guía");
    const question = h.asked.at(-1)!.questions[0]!;
    expect(question.options.map((option) => option.label)).toEqual([
      "Approve and write",
      "Correct with feedback",
      "Answer open questions",
    ]);
    expect(message).toContain("re-resolved compliance-profile.json");
  });

  it("writes faculty rules only into an existing institution pack", async () => {
    const h = await interviewed();
    const faculty = json(
      normsDraft({ pack: { scope: "faculty", id: "x", description: "Facultad", appliesWhen: {} } }),
    );
    h.script("thesis-editor", faculty, faculty);
    expect(await h.run("norms", "import -- guía")).toMatch(/Create the institution pack first/);
  });

  it("validates the arguments", async () => {
    const h = await interviewed();
    await expect(h.run("norms", "")).rejects.toThrow(/Usage: \/thesis:norms import/);
    await expect(h.run("norms", "export -- x")).rejects.toThrow(/Usage/);
    expect(await h.run("approve", "norms")).toContain("no pending rules");
  });
});

describe("/thesis:pack new (interactive)", () => {
  it("asks the scope and the id when the command line gives none", async () => {
    const h = await interviewed(engineEnv, [
      { scope: "institution", id: "derive", appliesWhen: "country" },
    ]);
    h.setInteractive(true);
    const message = await h.run("pack", "new");
    const first = h.asked.at(-2)!.questions.map((question) => question.id);
    expect(first).toEqual(["scope", "id"]);
    expect(
      h.asked.at(-2)!.questions[0]!.options.find((option) => option.value === "institution"),
    ).toMatchObject({ recommended: true });
    expect(message).toContain("Created pack CO-example-university");
    expect(
      await readFile(
        join(
          h.workspace,
          "thesis",
          "policy-packs",
          "institutions",
          "CO",
          "example-university",
          "manifest.yaml",
        ),
        "utf8",
      ),
    ).toContain("appliesWhen: { country: CO }");
  });

  it("still needs arguments when headless", async () => {
    const h: Lifecycle = await interviewed();
    await expect(h.run("pack", "new")).rejects.toThrow(/Usage: \/thesis:pack new/);
  });
});
