import { describe, expect, it } from "vitest";
import { parseFlags, splitDoubleDash } from "../src/args.js";

describe("argument parsing", () => {
  it("splits at the first double dash", () => {
    expect(splitDoubleDash("new demo --pack two-pack -- build -- things")).toEqual({
      head: ["new", "demo", "--pack", "two-pack"],
      tail: "build -- things",
    });
    expect(splitDoubleDash("  status ")).toEqual({ head: ["status"], tail: "" });
    expect(splitDoubleDash("")).toEqual({ head: [], tail: "" });
  });

  it("extracts value flags and keeps positionals", () => {
    expect(
      parseFlags(["demo", "--pack", "two-pack", "--github", "o/r"], ["pack", "github"]),
    ).toEqual({
      positional: ["demo"],
      flags: { pack: "two-pack", github: "o/r" },
    });
  });

  it("rejects unknown flags and flags without a value", () => {
    expect(() => parseFlags(["--nope", "x"], ["pack"])).toThrow(/unknown flag/i);
    expect(() => parseFlags(["--pack"], ["pack"])).toThrow(/needs a value/i);
    expect(() => parseFlags(["--pack", "--github"], ["pack", "github"])).toThrow(/needs a value/i);
  });
});
