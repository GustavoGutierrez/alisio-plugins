import { describe, expect, it } from "vitest";
import plugin, { registerFrontsmith } from "../src/index.js";
import { loadRoleInstructions } from "../src/resources.js";
import { VERSION } from "../src/version.js";
import { createHarness } from "./helpers/harness.js";

describe("plugin definition", () => {
  it("declares identity, category and the package version", async () => {
    expect(plugin).toMatchObject({
      id: "frontsmith",
      name: "Frontsmith",
      apiVersion: 1,
      categories: ["methodology-harness"],
      version: VERSION,
    });
    const manifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    );
    expect(VERSION).toBe(manifest.version);
    expect(plugin.description).toBe(manifest.description);
  });

  it("registers on a fake host without touching unavailable APIs", () => {
    const harness = createHarness();
    expect(() => registerFrontsmith(harness.api)).not.toThrow();
    expect(harness.tools.size).toBeGreaterThan(0);
  });

  it("registers the agent and skill directories with the host catalog", () => {
    const harness = createHarness();
    registerFrontsmith(harness.api);
    expect(harness.resources).toEqual({
      agents: ["../.agents/agents"],
      skills: ["../.agents/skills"],
    });
  });

  it("loads the instructions of a role by bare name and by agent name, and rejects other names", async () => {
    expect(await loadRoleInstructions("architect")).toBe(
      await loadRoleInstructions("fs-architect"),
    );
    await expect(loadRoleInstructions("nobody")).rejects.toThrow();
  });
});
