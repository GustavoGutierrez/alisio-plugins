// biome-ignore-all lint/style/noNonNullAssertion: fixtures index arrays whose length the test controls
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fenced, json, outlineDraft, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers, type Lifecycle, lifecycle } from "./helpers/harness.js";

afterEach(cleanup);

async function interviewed(options: Parameters<typeof lifecycle>[0] = {}) {
  const h = await lifecycle({
    ...options,
    answers: [...intakeAnswers, ...(options.answers ?? [])],
  });
  await h.run("init", "--lang es-CO");
  return h;
}

async function designed(h: Lifecycle) {
  h.setInteractive(false);
  h.script("thesis-methodologist", json(protocolDraft()));
  return h.run("design");
}

async function approvedDesign(h: Lifecycle) {
  await designed(h);
  await h.run("approve", "A");
  await h.run("approve", "B");
}

describe("/thesis:design", () => {
  it("is blocked until the interview is complete", async () => {
    const h = await lifecycle({ interactive: false });
    await h.run("init", "--lang es-CO");
    expect(await h.run("design")).toMatch(/Blocked: finish the intake interview/);
    expect(h.prompts).toHaveLength(0);
  });

  it("delegates to a read-only methodologist and writes protocol.md with code-allocated ids", async () => {
    const h = await interviewed();
    const message = await designed(h);
    expect(message).toContain("Drafted research/protocol.md (revision 1)");
    expect(message).toContain("G1: 0 error(s), 0 warning(s).");
    expect(message).toContain("/thesis:approve A");
    expect(message).toContain("/thesis:approve B");

    const spec = h.prompts[0]?.spec as Record<string, unknown>;
    expect(h.prompts[0]?.role).toBe("thesis-methodologist");
    expect(spec).toMatchObject({
      readOnly: true,
      permission: { write: "deny", process: "deny" },
      tools: { deny: expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]) },
    });
    expect(spec.instructions).toEqual(expect.stringContaining("ProtocolDraft"));
    expect(h.prompts[0]?.prompt).toContain("USER FEEDBACK".slice(0, 0));
    expect(h.prompts[0]?.prompt).toContain("approved objective verbs (es-CO)");
    expect(h.prompts[0]?.prompt).toContain("Automatic evidence verification for theses");

    const protocol = await h.read("research/protocol.md");
    expect(protocol).toContain("id: OBJ-01");
    expect(protocol).toContain("## Preguntas de investigación");
    const state = await h.state();
    expect(state.phase).toBe("design");
    expect(state.humanGates.A.status).toBe("pending");
    expect(state.protocolAt).toBeDefined();
    expect(await h.run("status")).toContain("Next: /thesis:approve A");
  });

  it("retries a malformed reply once with the validation errors, then succeeds", async () => {
    const h = await interviewed();
    h.setInteractive(false);
    h.script("thesis-methodologist", "this is not json", json(protocolDraft()));
    const message = await h.run("design");
    expect(message).toContain("Drafted research/protocol.md");
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]?.prompt).toContain("Your previous reply was rejected");
    expect(h.prompts[1]?.prompt).toContain("not valid JSON");
  });

  it("retries a schema-invalid reply with the field errors", async () => {
    const h = await interviewed();
    h.setInteractive(false);
    h.script(
      "thesis-methodologist",
      fenced(protocolDraft({ specificObjectives: [] })),
      fenced(protocolDraft()),
    );
    await h.run("design");
    expect(h.prompts[1]?.prompt).toContain("specificObjectives must hold 2 to 6");
  });

  it("reports a second failure and writes nothing", async () => {
    const h = await interviewed();
    h.setInteractive(false);
    h.script("thesis-methodologist", "nope", json({ problem: 1 }));
    const message = await h.run("design");
    expect(message).toMatch(
      /did not return a valid result after one retry, so nothing was written/,
    );
    await expect(h.read("research/protocol.md")).rejects.toThrow();
    expect((await h.state()).protocolAt).toBeUndefined();
    expect(h.remaining("thesis-methodologist")).toBe(0);
  });

  it("asks gates A and B interactively with a recommended approve option", async () => {
    const h = await interviewed({ answers: [{ A: "approve", B: "approve" }] });
    h.script("thesis-methodologist", json(protocolDraft()));
    const message = await h.run("design");
    const request = h.asked.at(-1);
    expect(request?.questions.map((question) => question.id)).toEqual(["A", "B"]);
    for (const question of request?.questions ?? []) {
      expect(question.options.map((option) => option.value)).toEqual([
        "approve",
        "revise",
        "later",
      ]);
      expect(question.options.find((option) => option.value === "approve")?.recommended).toBe(true);
      expect(question.options.find((option) => option.value === "revise")?.textInput).toBeDefined();
    }
    expect(message).toContain("Approved Gate A.");
    const state = await h.state();
    expect(state.humanGates.A.status).toBe("approved");
    expect(state.humanGates.B.status).toBe("approved");
    expect(state.phase).toBe("outline");
  });

  it("sends interactive feedback to the methodologist and resets both gates", async () => {
    const h = await interviewed({
      answers: [{ A: "approve", B: "revise", "B:text": "Add an interview study" }],
    });
    h.script(
      "thesis-methodologist",
      json(protocolDraft()),
      json(protocolDraft({ scope: "Alcance ajustado con entrevistas." })),
    );
    const message = await h.run("design");
    expect(h.prompts[1]?.prompt).toContain("Add an interview study");
    expect(h.prompts[1]?.prompt).toContain("PREVIOUS PROTOCOL");
    expect(message).toContain("(revision 2)");
    expect(await h.read("research/protocol.md")).toContain("Alcance ajustado con entrevistas.");
    const state = await h.state();
    expect(state.humanGates.A.status).toBe("pending");
    expect(state.phase).toBe("design");
  });

  it("does not redraft an existing protocol without feedback", async () => {
    const h = await interviewed();
    await designed(h);
    expect(await h.run("design")).toContain("A protocol draft already exists");
    expect(h.prompts).toHaveLength(1);
  });
});

describe("human gates cannot be skipped", () => {
  it("blocks the outline until both A and B are approved", async () => {
    const h = await interviewed();
    expect(await h.run("outline")).toMatch(
      /Blocked: Human Gate A and B must be approved.*Run \/thesis:design first/,
    );
    await designed(h);
    expect(await h.run("outline")).toMatch(
      /Blocked: Human Gate A and B must be approved.*\/thesis:approve A/,
    );
    await h.run("approve", "B");
    expect(await h.run("outline")).toMatch(/Blocked: Human Gate A must be approved/);
    expect((await h.state()).phase).toBe("design");
    expect(h.prompts.filter((entry) => entry.role === "thesis-architect")).toHaveLength(0);
  });

  it("blocks OUTLINE and research approvals out of order", async () => {
    const h = await interviewed();
    await designed(h);
    expect(await h.run("approve", "OUTLINE")).toMatch(
      /Blocked: Human Gate A and B must be approved before the OUTLINE gate/,
    );
    expect(await h.run("approve", "SEC-01")).toMatch(/not a section of the approved outline/);
    expect(await h.run("research", "SEC-01")).toMatch(
      /Blocked: research starts after the OUTLINE gate/,
    );
    expect(await h.run("approve", "C")).toMatch(
      /Blocked: Gate C can only be approved in the review phase/,
    );
  });

  it("refuses to approve a protocol that fails G1", async () => {
    const h = await interviewed();
    await designed(h);
    const { writeFile } = await import("node:fs/promises");
    const path = join(h.workspace, "thesis", "research", "protocol.md");
    await writeFile(path, (await readFile(path, "utf8")).replace(/^problem: .*$/m, "problem: ''"));
    expect(await h.run("approve", "A")).toMatch(
      /Blocked: G1 has errors[\s\S]*no problem statement/,
    );
    expect((await h.state()).humanGates.A.status).toBe("pending");
  });

  it("approves A and B in any order and moves to the outline phase", async () => {
    const h = await interviewed();
    await designed(h);
    expect(await h.run("approve", "B -- looks right")).toContain("Approved Gate B.");
    expect((await h.state()).phase).toBe("design");
    const done = await h.run("approve", "A");
    expect(done).toContain("Gates A and B are approved and G1 passes.");
    expect(done).toContain("Next: /thesis:outline");
    const state = await h.state();
    expect(state.phase).toBe("outline");
    expect(state.humanGates.B.notes).toBe("looks right");
    expect(await h.run("approve", "A")).toBe("Gate A is already approved.");
  });
});

describe("/thesis:revise A|B", () => {
  it("routes feedback to the methodologist and keeps the revision count", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    h.script(
      "thesis-methodologist",
      json(protocolDraft({ problem: "Problema reformulado tras la revisión." })),
    );
    const message = await h.run("revise", "A -- Narrow the problem");
    expect(message).toContain("(revision 2)");
    expect(h.prompts.at(-1)?.prompt).toContain("Narrow the problem");
    const state = await h.state();
    expect(state.humanGates.A.status).toBe("pending");
    expect(state.humanGates.B.status).toBe("pending");
    expect(state.phase).toBe("design");
  });

  it("removes a derived outline when the protocol changes", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    h.script("thesis-architect", json(outlineDraft()));
    await h.run("outline");
    h.script("thesis-methodologist", json(protocolDraft()));
    const message = await h.run("revise", "B -- Change the method");
    expect(message).toContain("outline was derived from the old protocol");
    await expect(h.read("outline/outline.json")).rejects.toThrow();
    expect((await h.state()).outlineAt).toBeUndefined();
  });

  it("requires feedback text", async () => {
    const h = await interviewed();
    await expect(h.run("revise", "A")).rejects.toThrow(/Usage: \/thesis:revise/);
  });
});

describe("/thesis:outline", () => {
  it("delegates to a read-only architect and writes outline.json and outline.md", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    h.script("thesis-architect", json(outlineDraft()));
    const message = await h.run("outline");
    expect(message).toContain("Drafted outline/outline.json and outline/outline.md (13 sections).");
    expect(message).toContain("G4: 0 error(s), 0 warning(s).");
    expect(message).toContain("/thesis:approve OUTLINE");

    const spec = h.prompts.at(-1)?.spec as Record<string, unknown>;
    expect(h.prompts.at(-1)?.role).toBe("thesis-architect");
    expect(spec).toMatchObject({ readOnly: true, permission: { write: "deny" } });
    const prompt = h.prompts.at(-1)?.prompt as string;
    expect(prompt).toContain("Required sections (requiredKey values): resumen or abstract");
    expect(prompt).toContain("Objective ids you may use: OBJ-G, OBJ-01, OBJ-02, OBJ-03");

    const outline = JSON.parse(await h.read("outline/outline.json"));
    expect(outline.sections[0].id).toBe("SEC-01");
    expect(outline.sections[6].children[0].id).toBe("SEC-07.01");
    expect(await h.read("outline/outline.md")).toContain("## Cobertura de objetivos");
    expect((await h.state()).outlineAt).toBeDefined();
  });

  it("retries once with the OUT-003 error when an objective is not covered", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    const uncovered = outlineDraft();
    for (const section of uncovered.sections)
      section.objectives = section.objectives.filter((objective) => objective !== "OBJ-03");
    h.script("thesis-architect", json(uncovered), json(outlineDraft()));
    const message = await h.run("outline");
    expect(h.prompts.at(-1)?.prompt).toContain("OUT-003");
    expect(h.prompts.at(-1)?.prompt).toContain(
      "Specific objective OBJ-03 is not covered by any section",
    );
    expect(message).toContain("Drafted outline/outline.json");
  });

  it("reports a second failure (OUT-003) and writes no outline", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    const uncovered = outlineDraft();
    for (const section of uncovered.sections)
      section.objectives = section.objectives.filter((objective) => objective !== "OBJ-03");
    h.script("thesis-architect", json(uncovered), json(uncovered));
    const message = await h.run("outline");
    expect(message).toMatch(/The architect did not return a valid result after one retry/);
    expect(message).toContain("OUT-003");
    await expect(h.read("outline/outline.json")).rejects.toThrow();
  });

  it("rejects dependency cycles and missing required sections from the architect", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    const cyclic = outlineDraft();
    cyclic.sections[7]!.dependsOn = ["conclusiones"];
    const missing = outlineDraft();
    missing.sections = missing.sections.filter((section) => section.key !== "referencias");
    h.script("thesis-architect", json(cyclic), json(missing));
    const message = await h.run("outline");
    expect(h.prompts.at(-1)?.prompt).toContain("OUT-002");
    expect(message).toContain("OUT-004");
  });

  it("asks the OUTLINE gate interactively, then plans every section on approval", async () => {
    const h = await interviewed({
      answers: [{ A: "approve", B: "approve" }, { OUTLINE: "approve" }],
    });
    h.script("thesis-methodologist", json(protocolDraft()));
    await h.run("design");
    h.script("thesis-architect", json(outlineDraft()));
    const message = await h.run("outline");
    const request = h.asked.at(-1);
    expect(request?.questions[0]?.id).toBe("OUTLINE");
    expect(request?.questions[0]?.options.find((option) => option.recommended)?.value).toBe(
      "approve",
    );
    expect(message).toContain("Approved the OUTLINE gate. 13 sections are planned.");
    const state = await h.state();
    expect(state.phase).toBe("sections");
    expect(state.humanGates.OUTLINE.status).toBe("approved");
    expect(Object.keys(state.sections)).toHaveLength(13);
    expect(state.sections["SEC-08"]).toMatchObject({
      status: "planned",
      title: "Metodología",
      dependsOn: ["SEC-07"],
    });
    expect(state.sections["SEC-07.01"].status).toBe("planned");
  });

  it("is blocked once approved and can be revised only before any research", async () => {
    const h = await interviewed();
    await approvedDesign(h);
    h.script("thesis-architect", json(outlineDraft()));
    await h.run("outline");
    await h.run("approve", "OUTLINE");
    expect(await h.run("outline")).toMatch(/Blocked: the outline is already approved/);
    const second = outlineDraft();
    second.sections[6]!.children = [];
    h.script("thesis-architect", json(second));
    const message = await h.run("revise", "OUTLINE -- drop the sub-section");
    expect(message).toContain("(12 sections)");
    expect(h.prompts.at(-1)?.prompt).toContain("drop the sub-section");
    const state = await h.state();
    expect(state.phase).toBe("outline");
    expect(state.sections).toEqual({});
    expect(state.humanGates.OUTLINE.status).toBe("pending");
  });
});

describe("/thesis:next", () => {
  it("runs the next phase step by step", async () => {
    const h = await interviewed();
    h.setInteractive(false);
    h.script("thesis-methodologist", json(protocolDraft()));
    expect(await h.run("next")).toContain("Drafted research/protocol.md");
    expect(await h.run("next")).toContain("The protocol draft is waiting for your decision.");
    await h.run("approve", "A");
    await h.run("approve", "B");
    h.script("thesis-architect", json(outlineDraft()));
    expect(await h.run("next")).toContain("Drafted outline/outline.json");
    expect(await h.run("next")).toContain("The outline draft is waiting for your decision.");
  });

  it("explains an unfinished interview", async () => {
    const h = await lifecycle({ interactive: false });
    await h.run("init", "--lang es-CO");
    expect(await h.run("next")).toContain("/thesis:answer");
  });
});
