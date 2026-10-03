import type { DecisionRequest } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { LayaProtocolError, LayaRequestError } from "../src/errors.js";
import { decodeResponse, encodeRequest } from "../src/protocol/codec.js";

function request(partial: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    version: 1,
    id: "test-call",
    state: { text: "refund request for order 4411" },
    decisions: {
      route: {
        type: "select",
        instruction: "Where should this go?",
        options: { billing: "billing team", support: "support team", sales: "sales team" },
      },
      urgent: { type: "boolean", instruction: "Is this urgent?" },
      severity: {
        type: "ordinal",
        instruction: "How severe is it?",
        levels: ["low", "medium", "high"],
      },
    },
    ...partial,
  };
}

describe("encodeRequest", () => {
  it("maps select, boolean and ordinal to choice, noul and score with positional ids", () => {
    const { wire, plan } = encodeRequest(request());
    expect(wire.questions).toEqual({
      q0: {
        type: "choice",
        instructions: "Where should this go?",
        criteria: { billing: "billing team", support: "support team", sales: "sales team" },
      },
      q1: {
        type: "noul",
        instructions: "Is this urgent?",
        criteria: { true: "yes, the statement holds", false: "no, the statement does not hold" },
      },
      q2: {
        type: "score",
        instructions: "How severe is it?",
        criteria: ["low", "medium", "high"],
      },
    });
    expect(plan.entries.map((e) => e.key)).toEqual(["route", "urgent", "severity"]);
    expect(JSON.stringify(wire)).not.toContain("route");
    expect(JSON.stringify(wire)).not.toContain("severity");
  });

  it("uses boolean meanings when provided", () => {
    const { wire } = encodeRequest(
      request({
        decisions: {
          ok: { type: "boolean", instruction: "ok?", trueMeaning: "fine", falseMeaning: "broken" },
        },
      }),
    );
    expect(wire.questions.q0).toMatchObject({ criteria: { true: "fine", false: "broken" } });
  });

  it("passes object, array and string state through and wraps scalars", () => {
    expect(encodeRequest(request({ state: "plain text" })).wire.state).toBe("plain text");
    expect(encodeRequest(request({ state: ["a", "b"] })).wire.state).toEqual(["a", "b"]);
    expect(encodeRequest(request({ state: { a: 1 } })).wire.state).toEqual({ a: 1 });
    expect(encodeRequest(request({ state: 42 })).wire.state).toEqual({ value: 42 });
    expect(encodeRequest(request({ state: null })).wire.state).toEqual({ value: null });
    expect(encodeRequest(request({ state: true })).wire.state).toEqual({ value: true });
  });

  it("never sends min_confidence, task, lang or hooks", () => {
    const { wire } = encodeRequest(request(), { model: "multilingual" });
    for (const forbidden of ["min_confidence", "task", "lang", "hooks"]) {
      expect(wire).not.toHaveProperty(forbidden);
    }
    expect(wire.model).toBe("multilingual");
  });

  it("omits model when none is requested", () => {
    expect(encodeRequest(request()).wire).not.toHaveProperty("model");
  });

  it("forwards a well-formed BCP 47 language as lang_guess and drops malformed ones", () => {
    expect(encodeRequest(request({ language: "es-CO" })).wire.lang_guess).toBe("es-CO");
    expect(encodeRequest(request({ language: "en" })).wire.lang_guess).toBe("en");
    expect(encodeRequest(request({ language: "not a tag!" })).wire).not.toHaveProperty(
      "lang_guess",
    );
    expect(encodeRequest(request({ language: "" })).wire).not.toHaveProperty("lang_guess");
    expect(encodeRequest(request({ language: "x".repeat(80) })).wire).not.toHaveProperty(
      "lang_guess",
    );
  });

  it("rejects an unsupported request version", () => {
    expect(() => encodeRequest({ ...request(), version: 2 as unknown as 1 })).toThrow(
      LayaProtocolError,
    );
  });

  describe("limits (defense in depth)", () => {
    it("rejects zero and more than 16 decisions", () => {
      expect(() => encodeRequest(request({ decisions: {} }))).toThrow(LayaRequestError);
      const many = Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [
          `d${i}`,
          { type: "boolean", instruction: "x" } as const,
        ]),
      );
      expect(() => encodeRequest(request({ decisions: many }))).toThrow(LayaRequestError);
    });

    it("accepts exactly 16 decisions", () => {
      const sixteen = Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          `d${i}`,
          { type: "boolean", instruction: "x" } as const,
        ]),
      );
      expect(() => encodeRequest(request({ decisions: sixteen }))).not.toThrow();
    });

    it("rejects keys outside the allowed pattern", () => {
      for (const key of ["__proto__", "1abc", "has space", "a-b", "", "x".repeat(65)]) {
        const decisions = Object.fromEntries([[key, { type: "boolean", instruction: "x" }]]);
        expect(() =>
          encodeRequest(request({ decisions: decisions as DecisionRequest["decisions"] })),
        ).toThrow(LayaRequestError);
      }
    });

    it("accepts a hostile-looking but valid key without prototype pollution", () => {
      const { plan } = encodeRequest(
        request({ decisions: { constructor: { type: "boolean", instruction: "x" } } }),
      );
      expect(plan.entries[0]?.key).toBe("constructor");
      const out = decodeResponse(
        { answers: { q0: { noul: 0.9, confidence: 0.9, answer_confidence: 0.9 } } },
        plan,
      );
      expect(Object.hasOwn(out.decisions, "constructor")).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("rejects more than 20 select options and empty option keys or descriptions", () => {
      const options = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, "d"]));
      expect(() =>
        encodeRequest(request({ decisions: { a: { type: "select", instruction: "x", options } } })),
      ).toThrow(LayaRequestError);
      expect(() =>
        encodeRequest(
          request({ decisions: { a: { type: "select", instruction: "x", options: {} } } }),
        ),
      ).toThrow(LayaRequestError);
      expect(() =>
        encodeRequest(
          request({ decisions: { a: { type: "select", instruction: "x", options: { "": "d" } } } }),
        ),
      ).toThrow(LayaRequestError);
      expect(() =>
        encodeRequest(
          request({ decisions: { a: { type: "select", instruction: "x", options: { k: "" } } } }),
        ),
      ).toThrow(LayaRequestError);
    });

    it("rejects empty, duplicate and more than 32 ordinal levels", () => {
      const bad = (levels: string[]) =>
        encodeRequest(request({ decisions: { a: { type: "ordinal", instruction: "x", levels } } }));
      expect(() => bad([])).toThrow(LayaRequestError);
      expect(() => bad(["a", "a"])).toThrow(LayaRequestError);
      expect(() => bad(["a", ""])).toThrow(LayaRequestError);
      expect(() => bad(Array.from({ length: 33 }, (_, i) => `l${i}`))).toThrow(LayaRequestError);
      expect(() => bad(Array.from({ length: 32 }, (_, i) => `l${i}`))).not.toThrow();
    });

    it("rejects state above 16 KB and a request above 32 KB", () => {
      expect(() => encodeRequest(request({ state: "x".repeat(16 * 1024 + 1) }))).toThrow(
        LayaRequestError,
      );
      const big = Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          `d${i}`,
          { type: "boolean", instruction: "i".repeat(2100) } as const,
        ]),
      );
      expect(() => encodeRequest(request({ decisions: big }))).toThrow(LayaRequestError);
    });

    it("rejects a malformed definition type", () => {
      expect(() =>
        encodeRequest(
          request({
            decisions: { a: { type: "weird", instruction: "x" } as unknown as never },
          }),
        ),
      ).toThrow(LayaRequestError);
    });
  });
});

describe("decodeResponse", () => {
  const { plan } = encodeRequest(request());
  const base = {
    q0: {
      choice: "billing",
      confidence: 0.4,
      answer_confidence: 0.82,
      probabilities: { billing: 0.82, support: 0.12, sales: 0.06 },
    },
    q1: { noul: 0.91, confidence: 0.91, answer_confidence: 0.91 },
    q2: {
      score: 1.7,
      legend: ["low", "medium", "high"],
      confidence: 0.3,
      answer_confidence: 0.6,
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
    },
  };

  it("decodes the three answer types with answer_confidence as confidence", () => {
    const result = decodeResponse(
      { answers: base, usage: { input_tokens: 12, output_tokens: 3 } },
      plan,
    );
    expect(result.decisions.route).toEqual({
      type: "select",
      value: "billing",
      confidence: 0.82,
      probabilities: { billing: 0.82, support: 0.12, sales: 0.06 },
    });
    expect(result.decisions.urgent).toEqual({
      type: "boolean",
      value: true,
      confidence: 0.91,
      probability: 0.91,
    });
    expect(result.decisions.severity).toEqual({
      type: "ordinal",
      level: "high",
      index: 2,
      confidence: 0.6,
      distribution: [0.1, 0.2, 0.7],
    });
    expect(result.usage).toEqual({ inputUnits: 12, outputUnits: 3 });
  });

  it("falls back to probabilities[value] when answer_confidence is missing", () => {
    const answers = {
      ...base,
      q0: { choice: "support", probabilities: { support: 0.7, billing: 0.2, sales: 0.1 } },
    };
    const result = decodeResponse({ answers }, plan);
    expect(result.decisions.route).toMatchObject({ value: "support", confidence: 0.7 });
  });

  it("fails closed when there is no confidence source for a select", () => {
    const answers = { ...base, q0: { choice: "support" } };
    expect(() => decodeResponse({ answers }, plan)).toThrow(LayaProtocolError);
  });

  it("derives boolean value and confidence from P(true)", () => {
    const low = decodeResponse(
      { answers: { ...base, q1: { noul: 0.2, confidence: 0.2, answer_confidence: 0.2 } } },
      plan,
    );
    expect(low.decisions.urgent).toEqual({
      type: "boolean",
      value: false,
      confidence: 0.8,
      probability: 0.2,
    });
    const edge = decodeResponse({ answers: { ...base, q1: { noul: 0.5 } } }, plan);
    expect(edge.decisions.urgent).toMatchObject({ value: true, confidence: 0.5 });
  });

  describe("ordinal", () => {
    const decode = (q2: unknown) => decodeResponse({ answers: { ...base, q2 } }, plan);

    it("derives level and index from probabilities, never from score", () => {
      const out = decode({
        score: 0.1,
        probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 },
        answer_confidence: 0.8,
      });
      expect(out.decisions.severity).toMatchObject({ index: 2, level: "high" });
    });

    it("resolves ties to the lowest index", () => {
      const out = decode({ score: 1, probabilities: { "0": 0.4, "1": 0.4, "2": 0.2 } });
      expect(out.decisions.severity).toMatchObject({ index: 0, level: "low", confidence: 0.4 });
    });

    it("orders the distribution by index regardless of key order", () => {
      const out = decode({
        score: 1,
        probabilities: { "2": 0.2, "0": 0.3, "1": 0.5 },
        answer_confidence: 0.5,
      });
      expect(out.decisions.severity).toMatchObject({ index: 1, distribution: [0.3, 0.5, 0.2] });
    });

    it.each([
      ["missing probabilities", { score: 1.2 }],
      ["missing key", { score: 1, probabilities: { "0": 0.5, "2": 0.5 } }],
      ["extra key", { score: 1, probabilities: { "0": 0.2, "1": 0.2, "2": 0.2, "3": 0.4 } }],
      ["non-index key", { score: 1, probabilities: { low: 0.2, "1": 0.2, "2": 0.6 } }],
      ["NaN-like value", { score: 1, probabilities: { "0": "x", "1": 0.2, "2": 0.6 } }],
      ["out of range", { score: 1, probabilities: { "0": -0.1, "1": 0.2, "2": 1.2 } }],
    ])("fails closed on %s (no round(score) fallback)", (_name, q2) => {
      expect(() => decode(q2)).toThrow(LayaProtocolError);
    });
  });

  it("rejects a choice outside the requested options", () => {
    const answers = { ...base, q0: { ...base.q0, choice: "legal" } };
    expect(() => decodeResponse({ answers }, plan)).toThrow(LayaProtocolError);
  });

  it("rejects probabilities for unknown labels", () => {
    const answers = {
      ...base,
      q0: { ...base.q0, probabilities: { billing: 0.5, legal: 0.5 } },
    };
    expect(() => decodeResponse({ answers }, plan)).toThrow(LayaProtocolError);
  });

  it("rejects missing ids, non-objects and wrong shapes", () => {
    expect(() => decodeResponse({ answers: { q0: base.q0, q1: base.q1 } }, plan)).toThrow(
      LayaProtocolError,
    );
    expect(() => decodeResponse(null, plan)).toThrow(LayaProtocolError);
    expect(() => decodeResponse([], plan)).toThrow(LayaProtocolError);
    expect(() => decodeResponse({}, plan)).toThrow(LayaProtocolError);
    expect(() => decodeResponse({ answers: [] }, plan)).toThrow(LayaProtocolError);
    expect(() => decodeResponse({ answers: { ...base, q1: "yes" } }, plan)).toThrow(
      LayaProtocolError,
    );
  });

  it("ignores extra answer ids it did not request", () => {
    const result = decodeResponse({ answers: { ...base, q9: { choice: "x" } } }, plan);
    expect(Object.keys(result.decisions).sort()).toEqual(["route", "severity", "urgent"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["above 1", 1.01],
    ["below 0", -0.01],
    ["string", "0.5"],
  ])("rejects a noul value that is %s", (_name, noul) => {
    expect(() => decodeResponse({ answers: { ...base, q1: { noul } } }, plan)).toThrow(
      LayaProtocolError,
    );
  });

  it("rejects out-of-range confidences", () => {
    const answers = { ...base, q0: { ...base.q0, answer_confidence: 1.5 } };
    expect(() => decodeResponse({ answers }, plan)).toThrow(LayaProtocolError);
  });

  it("maps usage only when non-negative integers", () => {
    expect(decodeResponse({ answers: base }, plan).usage).toBeUndefined();
    expect(
      decodeResponse({ answers: base, usage: { input_tokens: -1, output_tokens: 2.5 } }, plan)
        .usage,
    ).toBeUndefined();
    expect(
      decodeResponse({ answers: base, usage: { input_tokens: 5, output_tokens: 2.5 } }, plan).usage,
    ).toEqual({ inputUnits: 5 });
  });

  it("never echoes server text or state in error messages", () => {
    try {
      decodeResponse({ answers: { ...base, q0: { choice: "secret-label-from-server" } } }, plan);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-label-from-server");
    }
  });
});
