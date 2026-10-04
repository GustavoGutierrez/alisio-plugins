import { afterEach, describe, expect, it } from "vitest";
import { json, outlineDraft, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers, lifecycle } from "./helpers/harness.js";
import {
  appraise,
  candidateSet,
  dossier,
  searchPlan,
  standardCandidates,
} from "./helpers/research.js";

afterEach(cleanup);

describe("lifecycle: intake, design, outline, research", () => {
  it("runs from the interview to approved research with scripted children and interactive gates", async () => {
    const h = await lifecycle({
      interactive: true,
      answers: [
        ...intakeAnswers,
        { A: "approve", B: "approve" }, // /thesis:design
        { OUTLINE: "approve" }, // /thesis:outline
        { research: "approve" }, // /thesis:research SEC-07
      ],
    });
    h.script("thesis-methodologist", json(protocolDraft()));
    h.script("thesis-architect", json(outlineDraft()), dossier());
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet(standardCandidates())));
    h.script("thesis-evidence-auditor", appraise());

    // intake
    await h.run("init", "--lang es-CO");
    expect((await h.state()).phase).toBe("design");

    // design: protocol drafted, gates A and B approved from the prompts
    const design = await h.run("design");
    expect(design).toContain("Approved Gate A.");
    expect((await h.state()).phase).toBe("outline");

    // outline: drafted, OUTLINE approved from the prompt, sections planned
    const outline = await h.run("outline");
    expect(outline).toContain("Approved the OUTLINE gate. 13 sections are planned.");
    expect((await h.state()).phase).toBe("sections");

    // research one section, validate it
    const research = await h.run("research", "SEC-07");
    expect(research).toContain("Researched SEC-07 Marco teórico");
    expect(research).toContain("Approved the research for SEC-07.");

    const state = await h.state();
    expect(state.humanGates).toMatchObject({
      A: { status: "approved" },
      B: { status: "approved" },
      OUTLINE: { status: "approved" },
      C: { status: "pending" },
    });
    expect(state.sections["SEC-07"].status).toBe("research_approved");
    expect(state.sections["SEC-08"].status).toBe("planned");
    expect(state.counters.evidence).toBe(3);

    // Every child was read-only and delegated through its own session.
    expect(h.prompts.map((entry) => entry.role)).toEqual([
      "thesis-methodologist",
      "thesis-architect",
      "thesis-librarian",
      "thesis-librarian",
      "thesis-evidence-auditor",
      "thesis-architect",
    ]);
    for (const entry of h.prompts) {
      expect(entry.spec).toMatchObject({
        readOnly: true,
        permission: { write: "deny", process: "deny" },
      });
    }

    // The deterministic gates agree with the files on disk.
    const report = await h.run("check", "G0 G1 G2 G4 G5");
    expect(report).toContain("Checks passed");
    expect(report).toContain("EVD-010");
    const status = await h.run("status");
    expect(status).toContain("Phase: sections");
    expect(status).toContain("SEC-07 Marco teórico [research_approved] -> /thesis:draft SEC-07");
    // The AI declaration needs no research, so it is the first section ready to draft.
    expect(status).toContain("Next: /thesis:draft SEC-03");

    // Evidence files exist and the dossier is readable.
    for (const path of [
      "research/protocol.md",
      "outline/outline.json",
      "outline/outline.md",
      "evidence/library.jsonl",
      "evidence/rejected.jsonl",
      "evidence/search-log.jsonl",
      "evidence/dossiers/SEC-07.md",
      "bibliography/references.bib",
    ]) {
      expect((await h.read(path)).length, path).toBeGreaterThan(0);
    }
    // No question was left unanswered and nothing is pending.
    expect(state.pendingQuestions).toBeUndefined();
    expect(h.remaining("thesis-architect")).toBe(0);
  });
});
