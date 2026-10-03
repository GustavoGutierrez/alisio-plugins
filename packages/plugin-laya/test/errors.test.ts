import { DecisionProviderError } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  LayaConfigError,
  LayaProtocolError,
  LayaRequestError,
  LayaTimeoutError,
  LayaUnavailableError,
  toProviderError,
} from "../src/errors.js";

describe("toProviderError", () => {
  it.each([
    [new LayaUnavailableError("starting", "warming"), "not_ready"],
    [new LayaUnavailableError("not_installed", "run setup"), "unavailable"],
    [new LayaUnavailableError("failed", "x"), "unavailable"],
    [new LayaUnavailableError("backoff", "x"), "unavailable"],
    [new LayaUnavailableError("overloaded", "x"), "unavailable"],
    [new LayaUnavailableError("inactive", "x"), "unavailable"],
    [new LayaConfigError("bad config"), "unavailable"],
    [new LayaTimeoutError("deadline"), "timeout"],
    [new LayaProtocolError("bad_json", "x"), "invalid_response"],
    [new LayaRequestError("too_many_decisions", "x"), "internal"],
    [new Error("boom"), "internal"],
    ["a string", "internal"],
    [undefined, "internal"],
  ])("maps %s to %s", (error, code) => {
    const mapped = toProviderError(error);
    expect(mapped).toBeInstanceOf(DecisionProviderError);
    expect(mapped.code).toBe(code);
  });

  it("maps abort and timeout DOM errors to timeout", () => {
    expect(toProviderError(new DOMException("x", "AbortError")).code).toBe("timeout");
    expect(toProviderError(new DOMException("x", "TimeoutError")).code).toBe("timeout");
  });

  it("passes a DecisionProviderError through unchanged", () => {
    const original = new DecisionProviderError("not_ready", "nope");
    expect(toProviderError(original)).toBe(original);
  });

  it("never echoes a raw error message for unknown errors", () => {
    const mapped = toProviderError(new Error("state: secret decision data"));
    expect(mapped.message).not.toContain("secret");
  });

  it("keeps the short typed message of Laya errors", () => {
    expect(toProviderError(new LayaUnavailableError("starting", "warming up")).message).toBe(
      "warming up",
    );
  });
});
