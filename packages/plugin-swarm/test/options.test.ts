import { describe, expect, it } from "vitest";
import { parseOptions } from "../src/options.js";

describe("parseOptions", () => {
  it("defaults when absent", () => {
    expect(parseOptions(undefined)).toEqual({ maxConcurrent: 3, roles: {} });
    expect(parseOptions({})).toEqual({ maxConcurrent: 3, roles: {} });
  });

  it("accepts valid concurrency and per-role models", () => {
    expect(
      parseOptions({ maxConcurrent: 2, roles: { coder: { model: "provider/model" }, qa: {} } }),
    ).toEqual({ maxConcurrent: 2, roles: { coder: { model: "provider/model" }, qa: {} } });
  });

  it("falls back instead of failing on invalid values", () => {
    expect(parseOptions({ maxConcurrent: 99 }).maxConcurrent).toBe(3);
    expect(parseOptions({ maxConcurrent: "two" }).maxConcurrent).toBe(3);
    expect(
      parseOptions({ roles: { "bad_role!": { model: "x" }, coder: { model: 5 } } }).roles,
    ).toEqual({
      coder: {},
    });
  });

  it("reads a token budget and ignores nonsense", () => {
    expect(parseOptions({ tokenBudget: 50000 }).tokenBudget).toBe(50000);
    expect(parseOptions({ tokenBudget: 10 }).tokenBudget).toBeUndefined();
    expect(parseOptions({ tokenBudget: "lots" }).tokenBudget).toBeUndefined();
    expect(parseOptions({}).tokenBudget).toBeUndefined();
  });
});
