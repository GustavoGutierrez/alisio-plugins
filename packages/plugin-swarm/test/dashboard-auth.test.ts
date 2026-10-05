import { describe, expect, it } from "vitest";
import {
  allowedHosts,
  generateToken,
  hostAllowed,
  originAllowed,
  parseCookies,
  tokenMatches,
} from "../src/dashboard/auth.js";

describe("dashboard auth helpers", () => {
  it("generates distinct 256-bit hex tokens", () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("compares tokens in constant time and rejects missing, short and wrong values", () => {
    const token = generateToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
    expect(tokenMatches(token, token.slice(1))).toBe(false);
    expect(tokenMatches(token, `${token.slice(0, -1)}0`)).toBe(token.endsWith("0"));
  });

  it("parses cookies defensively", () => {
    expect(parseCookies("a=1; swarm_token=abc; b=x=y")).toEqual({
      a: "1",
      swarm_token: "abc",
      b: "x=y",
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("novalue; =x; ok=1")).toEqual({ ok: "1" });
  });

  it("only allows the loopback host names with the bound port", () => {
    expect([...allowedHosts(4123)].sort()).toEqual(["127.0.0.1:4123", "localhost:4123"]);
    expect(hostAllowed("127.0.0.1:4123", 4123)).toBe(true);
    expect(hostAllowed("localhost:4123", 4123)).toBe(true);
    expect(hostAllowed("evil.example:4123", 4123)).toBe(false);
    expect(hostAllowed("127.0.0.1:9", 4123)).toBe(false);
    expect(hostAllowed(undefined, 4123)).toBe(false);
    expect(hostAllowed("127.0.0.1.evil.example:4123", 4123)).toBe(false);
  });

  it("allows a missing Origin and the exact local origins, nothing else", () => {
    expect(originAllowed(undefined, 4123)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4123", 4123)).toBe(true);
    expect(originAllowed("http://localhost:4123", 4123)).toBe(true);
    expect(originAllowed("null", 4123)).toBe(false);
    expect(originAllowed("http://evil.example", 4123)).toBe(false);
    expect(originAllowed("https://127.0.0.1:4123", 4123)).toBe(false);
    expect(originAllowed("http://127.0.0.1:4124", 4123)).toBe(false);
  });
});
