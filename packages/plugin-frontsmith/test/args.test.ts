import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/interface/cli/args.js";

const spec = {
  flags: { json: "boolean", paths: "string", task: "string" },
  maxPositionals: 2,
} as const;

describe("parseArgs", () => {
  it("separates positionals from flags", () => {
    expect(parseArgs(["dir", "--json", "--paths", "a,b", "--task=T-001"], spec)).toEqual({
      positionals: ["dir"],
      flags: { json: true, paths: "a,b", task: "T-001" },
    });
  });

  it("lets the last occurrence win and defaults booleans to absent", () => {
    expect(parseArgs(["--paths", "a", "--paths", "b"], spec).flags).toEqual({ paths: "b" });
    expect(parseArgs([], spec)).toEqual({ positionals: [], flags: {} });
  });

  it("treats everything after -- as positional", () => {
    expect(parseArgs(["--", "--json"], spec)).toEqual({ positionals: ["--json"], flags: {} });
  });

  it.each([
    [["--nope"], /Unknown option/],
    [["--paths"], /requires a value/],
    [["--json=yes"], /does not take a value/],
    [["a", "b", "c"], /Too many arguments/],
    [["-x"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv, spec)).toThrow(UsageError);
    expect(() => parseArgs(argv, spec)).toThrow(message);
  });
});
