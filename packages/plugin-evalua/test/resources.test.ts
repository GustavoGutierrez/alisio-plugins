import { describe, expect, it } from "vitest";
import { agentNames, loadRoleInstructions, roleSkills, skillNames } from "../src/resources.js";

describe("plugin resources", () => {
  it("loads every agent by its bare role and by its full name", async () => {
    for (const name of agentNames) {
      const bare = name.replace(/^evl-/, "");
      expect(await loadRoleInstructions(bare), bare).toContain("#");
      expect(await loadRoleInstructions(name), name).toContain("#");
    }
  });

  it("every role has known skills and every agent is prefixed", async () => {
    for (const [role, skills] of Object.entries(roleSkills)) {
      expect(agentNames).toContain(role);
      for (const skill of skills) expect(skillNames).toContain(skill);
    }
    expect(agentNames.every((name) => name.startsWith("evl-"))).toBe(true);
    expect(skillNames.every((name) => name.startsWith("evl-"))).toBe(true);
  });
});
