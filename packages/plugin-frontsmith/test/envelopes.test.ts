import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  envelopeKinds,
  LIMITS,
  parseChildJson,
  sanitizeEnvelope,
} from "../src/domain/envelopes/parse.js";
import { validateEnvelope } from "../src/domain/envelopes/registry.js";
import { reviewVerdict } from "../src/domain/envelopes/review.js";

const fixtureRoot = join(import.meta.dirname, "fixtures", "envelopes");
const load = (kind: string, name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureRoot, kind, `${name}.json`), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("envelope fixtures", () => {
  it("covers all ten kinds", () => {
    expect(envelopeKinds).toHaveLength(10);
    expect(readdirSync(fixtureRoot).sort()).toEqual([...envelopeKinds].sort());
  });

  for (const kind of envelopeKinds) {
    const names = readdirSync(join(fixtureRoot, kind)).map((file) => file.replace(/\.json$/, ""));
    describe(kind, () => {
      it("has a valid fixture and at least two invalid ones", () => {
        expect(names).toContain("valid");
        expect(names.filter((name) => name.startsWith("invalid-")).length).toBeGreaterThanOrEqual(
          2,
        );
      });
      for (const name of names) {
        it(`${name} is ${name.startsWith("invalid-") ? "rejected" : "accepted"}`, () => {
          const result = validateEnvelope(kind, load(kind, name));
          if (name.startsWith("invalid-")) {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
          } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
          }
        });
      }
    });
  }
});

describe("parseChildJson", () => {
  it("accepts one JSON value, plain or in one fenced json block", () => {
    expect(parseChildJson('  {"a":1}\n')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseChildJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects prose around the value, two blocks, empty output and invalid JSON", () => {
    expect(parseChildJson('Here it is: {"a":1}').ok).toBe(false);
    expect(parseChildJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```').ok).toBe(false);
    expect(parseChildJson("").ok).toBe(false);
    expect(parseChildJson("{nope").ok).toBe(false);
    expect(parseChildJson('```json\n{"a":1}\n``` thanks').ok).toBe(false);
  });
});

describe("caps and sanitising", () => {
  const spec = (): Record<string, unknown> =>
    clone(load("spec", "valid")) as Record<string, unknown>;

  it("strips control characters except newline and tab and keeps the value valid", () => {
    const raw = spec();
    raw.problem = "a\u0007b\nc\td\u001b";
    const result = validateEnvelope("spec", raw);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.problem).toBe("ab\nc\td");
  });

  it("rejects a NUL instead of silently stripping it", () => {
    const raw = spec();
    raw.problem = "a\u0000b";
    expect(validateEnvelope("spec", raw).ok).toBe(false);
  });

  it("rejects strings over 4000 characters, with no 8000 character cap anywhere (B-03)", () => {
    const raw = spec();
    raw.problem = "x".repeat(LIMITS.string + 1);
    const result = validateEnvelope("spec", raw);
    expect(result.ok).toBe(false);
    const task = clone(load("task-result", "valid")) as Record<string, unknown>;
    (task.testFirst as Record<string, string>).failingOutputExcerpt = "y".repeat(4001);
    expect(validateEnvelope("task-result", task).ok).toBe(false);
    (task.testFirst as Record<string, string>).failingOutputExcerpt = "y".repeat(4000);
    expect(validateEnvelope("task-result", task).ok).toBe(true);
  });

  it("rejects arrays over 200 items and nesting deeper than 8 levels", () => {
    const raw = spec();
    raw.inScope = Array.from({ length: 201 }, (_, i) => `scope ${i}`);
    expect(validateEnvelope("spec", raw).ok).toBe(false);
    let nested: unknown = "leaf";
    for (let i = 0; i < 9; i += 1) nested = { next: nested };
    expect(sanitizeEnvelope(nested).errors.length).toBeGreaterThan(0);
  });

  it("rejects every unknown key at every level", () => {
    const raw = spec();
    (raw.users as Array<Record<string, unknown>>)[0].extra = true;
    const result = validateEnvelope("spec", raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.pointer)).toContain("/users/0/extra");
  });

  it("rejects a wrong kind or schemaVersion", () => {
    const raw = spec();
    raw.schemaVersion = 2;
    expect(validateEnvelope("spec", raw).ok).toBe(false);
    expect(validateEnvelope("review", load("spec", "valid")).ok).toBe(false);
  });
});

describe("path escapes", () => {
  const bad = [
    "../x.ts",
    "/abs/x.ts",
    "a\\b.ts",
    "a/../b.ts",
    "a\u0000b.ts",
    "",
    "C:/x.ts",
    "./x.ts",
  ];
  it.each(bad)("rejects %j in task results and plans", (path) => {
    const task = clone(load("task-result", "valid")) as Record<string, unknown>;
    task.changedPaths = [path];
    expect(validateEnvelope("task-result", task).ok).toBe(false);
    const plan = clone(load("plan", "valid")) as { tasks: Array<{ files: string[] }> };
    plan.tasks[0].files = [path];
    expect(validateEnvelope("plan", plan).ok).toBe(false);
  });
});

describe("fidelity-review rules", () => {
  const base = (verdict: string): unknown => {
    const raw = clone(load("fidelity-review", "valid")) as {
      classifications: Array<Record<string, string>>;
    };
    raw.classifications[0].verdict = verdict;
    return raw;
  };

  it("rejects acceptable-variation on a FAIL finding but accepts it on a REVIEW finding", () => {
    expect(
      validateEnvelope("fidelity-review", base("acceptable-variation"), {
        fidelityReview: { findings: { "F-0007": "FAIL" } },
      }).ok,
    ).toBe(false);
    expect(
      validateEnvelope("fidelity-review", base("acceptable-variation"), {
        fidelityReview: { findings: { "F-0007": "REVIEW" } },
      }).ok,
    ).toBe(true);
  });

  it("rejects reference-conflict on a FAIL finding too (B-23)", () => {
    expect(
      validateEnvelope("fidelity-review", base("reference-conflict"), {
        fidelityReview: { findings: { "F-0007": "FAIL" } },
      }).ok,
    ).toBe(false);
    expect(
      validateEnvelope("fidelity-review", base("reference-conflict"), {
        fidelityReview: { findings: { "F-0007": "REVIEW" } },
      }).ok,
    ).toBe(true);
  });

  it("lets a FAIL be a defect or needs-human and rejects findings it was never shown", () => {
    for (const verdict of ["defect", "needs-human"])
      expect(
        validateEnvelope("fidelity-review", base(verdict), {
          fidelityReview: { findings: { "F-0007": "FAIL" } },
        }).ok,
      ).toBe(true);
    expect(
      validateEnvelope("fidelity-review", base("defect"), {
        fidelityReview: { findings: { "F-0001": "FAIL" } },
      }).ok,
    ).toBe(false);
  });
});

describe("review verdict", () => {
  it("is recomputed: changes are requested iff a BLOCKER or MAJOR is open", () => {
    expect(reviewVerdict([{ severity: "MINOR" }, { severity: "NIT" }])).toBe("approved");
    expect(reviewVerdict([{ severity: "MAJOR" }])).toBe("changes-requested");
    expect(reviewVerdict([{ severity: "BLOCKER" }])).toBe("changes-requested");
    expect(reviewVerdict([])).toBe("approved");
  });

  it("rejects an envelope whose verdict disagrees with its findings", () => {
    const raw = clone(load("review", "valid")) as { verdict: string };
    raw.verdict = "approved";
    const result = validateEnvelope("review", raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.pointer).toBe("/verdict");
  });
});

describe("spec rules", () => {
  it("rejects duplicate ids and ids outside the 9.1 patterns", () => {
    const raw = clone(load("spec", "valid")) as { states: Array<Record<string, string>> };
    raw.states.push({ ...(raw.states[0] as Record<string, string>) });
    expect(validateEnvelope("spec", raw).ok).toBe(false);
    raw.states.pop();
    raw.states[0].id = "ST-X";
    expect(validateEnvelope("spec", raw).ok).toBe(false);
  });
});
