import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoleInstructions, parseResource } from "../src/resources.js";
import { roles } from "../src/types.js";
import { cleanup, lifecycle, round1 } from "./helpers/harness.js";

afterEach(cleanup);

const root = fileURLToPath(new URL("../", import.meta.url));
type Result = { content: { text: string }[]; isError?: boolean };

async function answer(h: Awaited<ReturnType<typeof lifecycle>>, answers: Record<string, string>) {
  const result = (await h.tools.get("thesis_answer")?.execute({ answers }, {
    workspace: h.workspace,
    signal: new AbortController().signal,
  } as never)) as Result;
  return { text: result.content[0]?.text ?? "", isError: result.isError === true };
}

describe("coordinator instructions", () => {
  it("keep the JSON-envelope rule for child roles only", async () => {
    for (const role of roles) {
      const text = await loadRoleInstructions(role);
      if (role === "thesis-coordinator") {
        expect(text).not.toMatch(/return one JSON object/i);
        expect(text).not.toMatch(/No prose around it/i);
        expect(text).toMatch(/plain conversational prose/i);
      } else {
        expect(text, role).toMatch(/return one JSON object/);
      }
    }
  });

  it("gives the coordinator thesis_answer with the narrowest write permission", async () => {
    const parsed = parseResource(
      await readFile(`${root}.agents/agents/thesis-coordinator.md`, "utf8"),
      "c",
    );
    expect(parsed.frontmatter.tools).toContain("thesis_answer");
    expect(parsed.frontmatter.permission).toEqual({ write: "ask", process: "deny" });
    for (const denied of ["write_file", "edit_file", "run_process"]) {
      expect(parsed.frontmatter.disallowedTools).toContain(denied);
    }
  });
});

describe("thesis_answer", () => {
  it("is a write tool with a closed input schema", async () => {
    const h = await lifecycle({ interactive: false });
    const tool = h.tools.get("thesis_answer");
    expect(tool?.effect).toBe("write");
    expect(tool?.inputSchema).toMatchObject({ required: ["answers"], additionalProperties: false });
  });

  it("refuses when no interview is pending", async () => {
    const h = await lifecycle({ interactive: false });
    const none = await answer(h, { language: "en" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/\/thesis:init/);
  });

  it("records valid answers and returns the next pending questions", async () => {
    const h = await lifecycle({ interactive: false });
    await h.run("init", "--lang es-CO");
    const done = await answer(h, round1 as Record<string, string>);
    expect(done.isError).toBe(false);
    expect(done.text).toContain("Recorded: language, workType, country, secondaryAbstract");
    expect(done.text).toContain("thesis.yaml");
    expect(done.text).toMatch(/institution/);
    expect(done.text).toMatch(/recommended/);
    expect((await h.state()).intake.completedRounds).toContain(1);
    expect(await h.read("thesis.yaml")).toContain("master_thesis");
  });

  it("rejects ids that are not pending and lists the pending ones, writing nothing", async () => {
    const h = await lifecycle({ interactive: false });
    await h.run("init", "--lang es-CO");
    for (const id of ["A", "SEC-01", "FND-001", "style:apa", "norms", "institution"]) {
      const result = await answer(h, { [id]: "approve" });
      expect(result.isError, id).toBe(true);
      expect(result.text).toContain(
        "Pending question ids: language, workType, country, secondaryAbstract",
      );
    }
    expect((await h.state()).intake.completedRounds).toEqual([]);
  });

  it("applies the same domain validation as /thesis:answer", async () => {
    const h = await lifecycle({ interactive: false });
    await h.run("init", "--lang es-CO");
    const bad = await answer(h, { ...round1, workType: "novel" } as Record<string, string>);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Allowed values");
    expect((await h.state()).intake.answers).toEqual({});
  });

  it("never asks interactively from the tool", async () => {
    const h = await lifecycle({ interactive: true, answers: [] });
    await h.coordinator.init("--lang en", "parent").catch(() => undefined);
    const before = h.asked.length;
    await answer(h, { language: "en" });
    expect(h.asked.length).toBe(before);
  });
});

describe("/thesis:init directory guard", () => {
  it("refuses a bare language tag as the thesis folder", async () => {
    const h = await lifecycle({ interactive: false });
    for (const tag of ["es", "en", "es-CO", "pt-BR"]) {
      await expect(h.run("init", tag)).rejects.toThrow(
        new RegExp(`looks like a language code.*--lang ${tag}.*./${tag}`, "s"),
      );
    }
    expect(await h.state().catch(() => null)).toBeNull();
  });

  it("still accepts an explicit path prefix and normal folder names", async () => {
    const h = await lifecycle({ interactive: false });
    const out = await h.run("init", "./es");
    expect(out).toContain("Created the thesis workspace at es/");
    expect((await h.state()).root).toBe("es");
    const g = await lifecycle({ interactive: false });
    expect(await g.run("init", "mythesis --lang es")).toContain("mythesis/");
  });
});
