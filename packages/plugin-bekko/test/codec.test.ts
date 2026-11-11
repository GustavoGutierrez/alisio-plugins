import { describe, expect, it } from "vitest";
import { BekkoRequestError, BekkoResponseError, decode, encode } from "../src/codec.js";
import { request } from "./helpers.js";

describe("encode", () => {
  it("maps select, boolean and ordinal decisions to Bekko questions", () => {
    const encoded = encode(
      request({
        intent: { type: "select", instruction: "Which?", options: { a: "first", b: "second" } },
        risky: { type: "boolean", instruction: "Risky?", trueMeaning: "it is risky" },
        level: { type: "ordinal", instruction: "How much?", levels: ["low", "mid", "high"] },
      }),
    );
    expect(encoded.state).toBe('{"a":1}');
    expect(encoded.keys).toEqual(["intent", "risky", "level"]);
    expect(encoded.questions[0]).toEqual({
      id: "intent",
      type: "choice",
      instructions: "Which?",
      options: ["a", "b"],
      criteria: { a: "first", b: "second" },
    });
    expect(encoded.questions[1]).toMatchObject({
      type: "noul",
      options: ["no", "yes"],
      criteria: { true: "it is risky" },
    });
    expect(encoded.questions[2]).toMatchObject({ type: "score", options: ["low", "mid", "high"] });
  });

  it("passes a string state through unchanged", () => {
    const encoded = encode(
      request({ x: { type: "boolean", instruction: "ok?" } }, "plain text state"),
    );
    expect(encoded.state).toBe("plain text state");
  });

  it.each([
    ["no decisions", {}],
    ["bad key", { "1bad": { type: "boolean", instruction: "x" } }],
    ["empty instruction", { a: { type: "boolean", instruction: " " } }],
    ["one option", { a: { type: "select", instruction: "x", options: { only: "one" } } }],
    ["duplicate levels", { a: { type: "ordinal", instruction: "x", levels: ["a", "a"] } }],
    ["one level", { a: { type: "ordinal", instruction: "x", levels: ["a"] } }],
    ["unknown type", { a: { type: "free", instruction: "x" } }],
  ])("rejects %s", (_label, decisions) => {
    expect(() => encode(request(decisions as never))).toThrow(BekkoRequestError);
  });

  it("rejects more than 16 decisions and oversized requests", () => {
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`d${i}`, { type: "boolean", instruction: "x" }]),
    );
    expect(() => encode(request(many as never))).toThrow(/number of decisions/);
    expect(() =>
      encode(request({ a: { type: "boolean", instruction: "x" } }, "y".repeat(40_000))),
    ).toThrow(/32 KiB/);
  });

  it("rejects an unsupported request version", () => {
    expect(() =>
      encode({ ...request({ a: { type: "boolean", instruction: "x" } }), version: 2 } as never),
    ).toThrow(/version/);
  });
});

describe("decode", () => {
  const encoded = encode(
    request({
      intent: { type: "select", instruction: "Which?", options: { a: "first", b: "second" } },
      risky: { type: "boolean", instruction: "Risky?" },
      level: { type: "ordinal", instruction: "How much?", levels: ["low", "mid", "high"] },
    }),
  );
  const valid = [
    { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.8 },
    { type: "noul", noul: 0.3 },
    { type: "score", probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
  ];

  it("maps valid answers to host decisions", () => {
    expect(decode(encoded, valid, false).decisions).toEqual({
      intent: { type: "select", value: "b", confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } },
      risky: { type: "boolean", value: false, confidence: 0.7, probability: 0.3 },
      level: {
        type: "ordinal",
        level: "high",
        index: 2,
        confidence: 0.7,
        distribution: [0.1, 0.2, 0.7],
      },
    });
  });

  it("refuses a truncated input", () => {
    expect(() => decode(encoded, valid, true)).toThrow(/truncated/);
  });

  it.each([
    ["a wrong answer count", valid.slice(0, 2)],
    ["an unknown choice", [{ ...valid[0], choice: "z" }, valid[1], valid[2]]],
    ["a NaN probability", [valid[0], { type: "noul", noul: Number.NaN }, valid[2]]],
    ["a probability above 1", [valid[0], { type: "noul", noul: 1.5 }, valid[2]]],
    ["a missing level", [valid[0], valid[1], { type: "score", probabilities: { "0": 0.5 } }]],
    ["a mismatched type", [valid[1], valid[0], valid[2]]],
    [
      "missing probabilities",
      [{ type: "choice", choice: "a", confidence: 0.5 }, valid[1], valid[2]],
    ],
  ])("rejects %s", (_label, answers) => {
    expect(() => decode(encoded, answers as never, false)).toThrow(BekkoResponseError);
  });
});
