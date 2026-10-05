import { describe, expect, it } from "vitest";
import { unavailableRunner } from "../src/adapters/unavailable-runner.js";

describe("unavailableRunner", () => {
  it("fails every run with an actionable message and ignores cancellation", async () => {
    const result = await unavailableRunner.run({
      sessionKey: "demo/coder",
      project: "demo",
      role: "coder",
      agent: "coder",
      workdir: "/scratch/p",
      prompt: "go",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/runner/i);
    expect(() => unavailableRunner.cancelProject("demo")).not.toThrow();
  });
});
