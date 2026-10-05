import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { roleIds } from "../src/domain/pack.js";
import {
  agentForRole,
  isResourceRole,
  listShippedPacks,
  loadAgentProfile,
  loadRoleInstructions,
  loadShippedPack,
  loadToolchain,
  parseResource,
  resourceRoles,
  roleSkills,
} from "../src/resources.js";

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe("role resources", () => {
  it("ships exactly the eight agents the registry declares", async () => {
    const files = (await readdir(dir("../.agents/agents"))).map((f) => f.replace(/\.md$/, ""));
    expect(files.sort()).toEqual([...resourceRoles].sort());
    expect(resourceRoles).toHaveLength(8);
  });

  it("ships the eleven skills and every one is used by some role", async () => {
    const skills = (await readdir(dir("../.agents/skills"))).sort();
    expect(skills).toHaveLength(11);
    const used = new Set(Object.values(roleSkills).flat());
    expect([...used].sort()).toEqual(skills);
  });

  it.each([...resourceRoles])("loads %s with its skills", async (role) => {
    const text = await loadRoleInstructions(role);
    expect(text.length).toBeGreaterThan(200);
    for (const skill of roleSkills[role]) expect(text).toContain(`# Loaded skill: ${skill}`);
  });

  it("recognises role names", () => {
    expect(isResourceRole("swarm-coder")).toBe(true);
    expect(isResourceRole("coder")).toBe(false);
    expect(isResourceRole("../swarm-coder")).toBe(false);
  });

  it("prefixes every agent with swarm- to avoid catalog overlaps", () => {
    for (const agent of resourceRoles) expect(agent.startsWith("swarm-")).toBe(true);
  });

  it("maps pack role ids to agent names in one place", () => {
    expect(agentForRole("coder")).toBe("swarm-coder");
    expect(agentForRole("specifier")).toBe("swarm-specifier");
    expect(agentForRole("lieutenant")).toBe("swarm-lieutenant");
    expect(agentForRole("custom-role")).toBeUndefined();
  });

  it("declares a timeout and an output budget for every agent", async () => {
    for (const agent of resourceRoles) {
      const profile = await loadAgentProfile(agent);
      expect(profile.timeoutMs).toBeGreaterThan(0);
      expect(profile.maxOutputTokens).toBeGreaterThan(0);
      expect(profile.maxTurns).toBeGreaterThan(0);
      expect(profile.disallowedTools).toEqual(
        expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]),
      );
    }
  });

  it("marks the read-only roles as read-only", async () => {
    expect((await loadAgentProfile("swarm-qa")).readOnly).toBe(true);
    expect((await loadAgentProfile("swarm-lieutenant")).readOnly).toBe(true);
    expect((await loadAgentProfile("swarm-coder")).readOnly).toBe(false);
  });

  it("rejects malformed frontmatter and unsupported syntax", () => {
    expect(() => parseResource("no frontmatter", "x")).toThrow(/Malformed resource/);
    expect(() => parseResource("---\nname: a & b\n---\nbody", "x")).toThrow(/Unsupported/);
    expect(() => parseResource("---\nname: a\n---\n   ", "x")).toThrow(/body is empty|Malformed/);
  });

  it("forbids delegation in every agent", async () => {
    for (const role of resourceRoles) {
      const { frontmatter } = parseResource(
        await (await import("node:fs/promises")).readFile(
          dir(`../.agents/agents/${role}.md`),
          "utf8",
        ),
        role,
      );
      expect(frontmatter.disallowedTools).toEqual(
        expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]),
      );
      expect(frontmatter.mode).toBe(role === "swarm-lieutenant" ? "primary" : "subagent");
    }
  });
});

describe("shipped packs and toolchain", () => {
  it("lists two-pack, four-pack and six-pack", async () => {
    expect((await listShippedPacks()).sort()).toEqual(["four-pack", "six-pack", "two-pack"]);
  });

  it("matches the pipelines documented in the spec", async () => {
    expect(roleIds(await loadShippedPack("two-pack"))).toEqual(["coder", "cleaner"]);
    for (const name of await listShippedPacks()) {
      for (const role of (await loadShippedPack(name)).roles) {
        expect(role.agent).toBe(`swarm-${role.id}`);
      }
    }
    expect(roleIds(await loadShippedPack("four-pack"))).toEqual([
      "specifier",
      "coder",
      "refactorer",
      "architect",
    ]);
    expect(roleIds(await loadShippedPack("six-pack"))).toEqual([
      "specifier",
      "coder",
      "cleaner",
      "architect",
      "hardener",
      "qa",
    ]);
  });

  it("gives gated packs a specifier approval and the two-pack none", async () => {
    expect((await loadShippedPack("two-pack")).approval).toBeUndefined();
    expect((await loadShippedPack("four-pack")).approval).toEqual({ after: "specifier" });
    expect((await loadShippedPack("six-pack")).approval).toEqual({ after: "specifier" });
  });

  it("only references agents that exist", async () => {
    for (const name of await listShippedPacks()) {
      for (const role of (await loadShippedPack(name)).roles) {
        expect(isResourceRole(role.agent)).toBe(true);
      }
    }
  });

  it("rejects an unknown or hostile pack name", async () => {
    await expect(loadShippedPack("nine-pack")).rejects.toThrow(/unknown shipped pack/i);
    await expect(loadShippedPack("../six-pack")).rejects.toThrow(/pack name/i);
  });

  it("loads the node-ts toolchain", async () => {
    const profile = await loadToolchain("node-ts");
    expect(profile.id).toBe("node-ts");
    expect(Object.keys(profile.commands).sort()).toEqual([
      "acceptance",
      "complexity",
      "coverage",
      "mutation",
      "test",
    ]);
    await expect(loadToolchain("cobol")).rejects.toThrow(/unknown toolchain/i);
  });
});
