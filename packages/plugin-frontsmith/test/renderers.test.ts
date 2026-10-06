import { describe, expect, it } from "vitest";
import { envelopeExamples } from "../src/application/agents/examples.js";
import { renderAdrMd } from "../src/application/render/adr-md.js";
import { renderContextMd } from "../src/application/render/context-md.js";
import { renderPlanMd } from "../src/application/render/plan-md.js";
import { renderRetroMd } from "../src/application/render/retro-md.js";
import { renderReviewMd } from "../src/application/render/review-md.js";
import { renderSpecMd } from "../src/application/render/spec-md.js";
import { renderTasksMd } from "../src/application/render/tasks-md.js";
import { renderUiMd } from "../src/application/render/ui-md.js";
import { renderValidationMd } from "../src/application/render/validation-md.js";
import { validateEnvelope } from "../src/domain/envelopes/registry.js";
import type { StackProfile } from "../src/domain/stack/profile.js";

const ok = <T>(r: { ok: true; value: T } | { ok: false; errors: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const spec = ok(validateEnvelope("spec", envelopeExamples.spec));
const plan = ok(validateEnvelope("plan", envelopeExamples.plan));
const contract = ok(validateEnvelope("ui-contract", envelopeExamples["ui-contract"]));
const review = ok(validateEnvelope("review", envelopeExamples.review));
const archive = ok(validateEnvelope("archive", envelopeExamples.archive));

const portable = (text: string): void => {
  expect(text.endsWith("\n")).toBe(true);
  expect(text).not.toMatch(/<[a-z!/][^>]*>/i);
  expect(text).not.toMatch(/!\[/);
  expect(text).not.toContain("data:");
};

describe("artifact renderers", () => {
  it("spec.md has the headings of the specification template in order", () => {
    const text = renderSpecMd(spec, "projects");
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Problem",
      "## Objective",
      "## Users and permissions",
      "## In scope",
      "## Out of scope",
      "## Functional requirements",
      "## Business rules",
      "## User-visible states",
      "## Error handling",
      "## Acceptance criteria",
      "## Edge cases",
      "## Analytics / telemetry",
      "## Accessibility requirements",
      "## Performance requirements",
      "## Security / privacy considerations",
      "## Assumptions",
      "## Open questions",
    ]);
    expect(text).toContain("| AC-01 | R-01 |");
    portable(text);
  });

  it("escapes pipes and newlines inside table cells", () => {
    const tricky = {
      ...spec,
      requirements: [{ id: "R-01", statement: "a | b\nc", priority: "must" as const }],
    };
    expect(renderSpecMd(tricky, "x")).toContain("a \\| b c");
  });

  it("is deterministic", () => {
    expect(renderSpecMd(spec, "projects")).toBe(renderSpecMd(spec, "projects"));
    expect(renderPlanMd(plan, "projects")).toBe(renderPlanMd(plan, "projects"));
  });

  it("ui.md, plan.md, tasks.md and adr render portable Markdown", () => {
    portable(renderUiMd(contract, "projects"));
    portable(renderPlanMd(plan, "projects"));
    const tasks = renderTasksMd(plan.tasks, "projects");
    portable(tasks);
    for (const heading of [
      "### Goal",
      "### Scope",
      "### Requirements",
      "### Tests to add or update",
      "### Validation commands",
      "### Constraints",
      "### Dependencies",
      "### Stop conditions",
    ])
      expect(tasks).toContain(heading);
    expect(tasks).toContain("## T-001: ...");
    const adr = renderAdrMd({
      id: "ADR-001",
      title: "Server cache",
      context: "c",
      decision: "d",
      consequences: "e",
    });
    expect(adr).toContain("# ADR-001: Server cache");
    portable(adr);
  });

  it("review.md lists strongest findings first and retro.md answers the questions", () => {
    const multi = {
      ...review,
      findings: [
        { ...review.findings[0]!, severity: "NIT" as const, claim: "nit claim" },
        { ...review.findings[0]!, severity: "BLOCKER" as const, claim: "blocker claim" },
      ],
    };
    const text = renderReviewMd([multi], "projects");
    expect(text.indexOf("blocker claim")).toBeLessThan(text.indexOf("nit claim"));
    portable(text);
    const retro = renderRetroMd(archive, "projects", ["CAND-002: invalid rule"]);
    expect(retro).toContain("## What escaped the gates");
    expect(retro).toContain("## Candidates dropped");
    portable(retro);
  });

  it("context.md records the stack, commands and unknowns", () => {
    const stack = {
      framework: "react",
      meta: "none",
      typescript: true,
      packageManager: "pnpm",
      monorepo: false,
      styling: ["tailwind"],
      state: [],
      tests: ["vitest"],
      sourceRoots: ["src"],
    } as unknown as StackProfile;
    const text = renderContextMd(
      {
        stack,
        commands: [
          {
            name: "test",
            argv: ["pnpm", "run", "test"],
            source: "inferred:package.json#scripts.test",
          },
        ],
        inventory: { components: 3, hooks: 1, stores: 0, tokens: 12 },
        docs: ["AGENTS.md"],
        architecturePresent: false,
        unknowns: ["no typecheck command"],
      },
      "projects",
    );
    expect(text).toContain("Framework: react");
    expect(text).toContain("`pnpm run test`");
    expect(text).toContain("no typecheck command");
    portable(text);
  });

  it("validation.md has the evidence template sections", () => {
    const text = renderValidationMd({
      feature: "projects",
      specSha256: "abc",
      trace: [
        {
          requirementId: "R-01",
          acId: "AC-01",
          tasks: ["T-001"],
          tests: ["src/a.test.ts"],
          status: "PASS",
          note: "",
          evidence: "tasks T-001",
        },
      ],
      commands: [{ name: "test", argv: "pnpm run test", status: "PASS", summary: "exit 0" }],
      gates: {},
      uiEvidence: [],
      accessibility: [],
      performance: [],
      limitations: ["Automated checks do not establish WCAG conformance."],
      deviations: [],
    });
    expect(text.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Specification",
      "## Acceptance criteria traceability",
      "## Commands executed",
      "## Automated results",
      "## UI evidence",
      "## Accessibility",
      "## Performance",
      "## Known limitations",
      "## Deviations from specification",
    ]);
    expect(text).toContain("| R-01 | AC-01 | T-001 | src/a.test.ts | PASS |");
    portable(text);
  });
});
