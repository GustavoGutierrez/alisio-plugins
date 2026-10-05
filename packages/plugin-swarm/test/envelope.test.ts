import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/domain/envelope.js";

const handoff = {
  schemaVersion: 1,
  kind: "handoff",
  commit: "0123456789",
  summary: "Implemented login",
  evidence: [{ requirement: "User can log in", proof: "test login.spec passes" }],
};

const ok = (value: unknown, options = {}) => parseEnvelope(JSON.stringify(value), options);

describe("parseEnvelope", () => {
  it("parses every envelope kind", () => {
    expect(ok(handoff)).toEqual({ ok: true, envelope: handoff });
    const clarification = { schemaVersion: 1, kind: "needs_clarification", question: "Which DB?" };
    expect(ok(clarification)).toEqual({ ok: true, envelope: clarification });
    const blocked = { schemaVersion: 1, kind: "blocked", reason: "No network" };
    expect(ok(blocked)).toEqual({ ok: true, envelope: blocked });
    const note = { schemaVersion: 1, kind: "note", message: "Heads up" };
    expect(ok(note)).toEqual({ ok: true, envelope: note });
  });

  it("accepts surrounding whitespace and one json fence", () => {
    expect(parseEnvelope(`\n  ${JSON.stringify(handoff)}  \n`).ok).toBe(true);
    expect(parseEnvelope(`\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``).ok).toBe(true);
  });

  const reject = (label: string, input: string | unknown, reason: RegExp, options = {}) =>
    it(`rejects ${label}`, () => {
      const result = parseEnvelope(
        typeof input === "string" ? input : JSON.stringify(input),
        options,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });

  reject("empty text", "", /empty/i);
  reject("prose around the json", `Done! ${JSON.stringify(handoff)}`, /json/i);
  reject("two documents", `${JSON.stringify(handoff)}\n${JSON.stringify(handoff)}`, /json/i);
  reject("invalid json", "{nope", /json/i);
  reject("an array", [handoff], /object/i);
  reject("a missing schemaVersion", { ...handoff, schemaVersion: undefined }, /schemaVersion/);
  reject("a wrong schemaVersion", { ...handoff, schemaVersion: 2 }, /schemaVersion/);
  reject("an unknown kind", { schemaVersion: 1, kind: "shout" }, /kind/);
  reject("extra keys", { ...handoff, approved: true }, /unknown key/i);
  reject("a bad commit", { ...handoff, commit: "HEAD" }, /commit/i);
  reject("a missing summary", { ...handoff, summary: "" }, /summary/);
  reject("empty evidence", { ...handoff, evidence: [] }, /evidence/);
  reject(
    "evidence with extra keys",
    { ...handoff, evidence: [{ requirement: "a", proof: "b", x: 1 }] },
    /unknown key/i,
  );
  reject(
    "evidence with blank proof",
    { ...handoff, evidence: [{ requirement: "a", proof: " " }] },
    /proof/,
  );
  reject(
    "an overlong question",
    { schemaVersion: 1, kind: "needs_clarification", question: "q".repeat(2001) },
    /question/,
  );
  reject("an empty reason", { schemaVersion: 1, kind: "blocked", reason: "" }, /reason/);
  reject("a long note", { schemaVersion: 1, kind: "note", message: "n".repeat(81) }, /message/);
  reject("a multi-line note", { schemaVersion: 1, kind: "note", message: "a\nb" }, /message/);
  reject("a truncated run", handoff, /turn/i, { turnsExceeded: true });
  reject(
    "an oversized document",
    `{"schemaVersion":1,"kind":"blocked","reason":"${"x".repeat(70_000)}"}`,
    /too large/i,
  );
});
