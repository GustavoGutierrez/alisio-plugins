import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, {
  assertRelativePath,
  atomicWrite,
  executionRoles,
  loadRoleInstructions,
  parseResource,
  phaseProfiles,
  phaseRoles,
  resourcePaths,
  roleSkills,
  validateChangeName,
  validatePlan,
  validateState,
  validateVerification,
} from "../src/index.js";

type Handler = (args: string, context?: { sessionId?: string }) => Promise<string>;
type FakeResult =
  | string
  | { status?: string; text?: string; error?: string; turnsExceeded?: boolean };

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(outputs: FakeResult[] = [], interactive = false) {
  const workspace = await mkdtemp(join(tmpdir(), "wayfinder-test-"));
  workspaces.push(workspace);
  const commands = new Map<string, Handler>();
  const options = new Map<string, unknown>();
  const profiles: ChildSessionSpec[] = [];
  const agents: string[] = [];
  const skills: string[] = [];
  let child = 0;
  const api = {
    commands: {
      register(name: string, handler: Handler, info: unknown) {
        commands.set(name, handler);
        options.set(name, info);
        return () => commands.delete(name);
      },
    },
    resources: {
      agents: (path: string) => agents.push(path),
      skills: (path: string) => skills.push(path),
    },
    sessions: {
      workspace: () => workspace,
      async create(spec: ChildSessionSpec) {
        profiles.push(spec);
        child += 1;
        return { id: `child-${child}` };
      },
      async run() {
        const next = outputs.shift();
        if (typeof next === "string") {
          return { id: "child", status: "completed", text: next, usage: { input: 0, output: 0 } };
        }
        return {
          id: "child",
          status: next?.status ?? "failed",
          text: next?.text ?? "",
          error: next?.error,
          turnsExceeded: next?.turnsExceeded,
          usage: { input: 0, output: 0 },
        };
      },
    },
    ui: {
      status() {},
      interactive: () => interactive,
      async askQuestions() {
        return { approval: "approve" };
      },
    },
  } as unknown as PluginAPI;
  await plugin.setup(api);
  const run = (name: string, args: string) =>
    commands.get(name)?.(args, { sessionId: "parent" }) as Promise<string>;
  return { workspace, commands, options, profiles, agents, skills, run };
}

const validOutputs = [
  JSON.stringify({
    schemaVersion: 1,
    summary: "Existing TypeScript service",
    findings: ["Tests use Vitest"],
    constraints: ["Keep API stable"],
    criticalQuestions: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    outcome: "Expose a health response",
    inScope: ["Health endpoint"],
    outOfScope: ["Metrics"],
    assumptions: [],
    criticalQuestions: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    requirements: [
      { id: "REQ-001", statement: "Expose health", acceptance: ["Returns healthy response"] },
    ],
    criticalQuestions: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    summary: "Add one endpoint",
    decisions: [{ topic: "Route", choice: "Add /health", rationale: "Matches intent" }],
    paths: ["src/health.ts"],
    risks: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    units: [
      {
        id: "UNIT-001",
        title: "Add health route",
        goal: "Expose health",
        requirements: ["REQ-001"],
        paths: ["src/health.ts"],
        checks: ["pnpm test"],
      },
    ],
  }),
  JSON.stringify({
    schemaVersion: 1,
    unitId: "UNIT-001",
    summary: "Added route",
    changedPaths: ["src/health.ts"],
    checks: [{ command: "pnpm test", status: "passed", summary: "1 test passed" }],
    notes: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    passed: true,
    summary: "Requirement satisfied",
    requirements: [{ id: "REQ-001", status: "passed", evidence: ["Focused test passed"] }],
    checks: [{ command: "pnpm test", status: "passed", summary: "1 test passed" }],
    blockers: [],
  }),
  JSON.stringify({
    schemaVersion: 1,
    ready: true,
    artifacts: [
      "intent.md",
      "discovery.md",
      "proposal.md",
      "specification.md",
      "design.md",
      "plan.md",
      "progress.md",
      "verification.md",
    ],
    completedUnits: ["UNIT-001"],
    requirements: ["REQ-001"],
    blockers: [],
    summary: "Complete",
  }),
];

async function reachImplementation(h: Awaited<ReturnType<typeof harness>>, name = "health-check") {
  await h.run("new", `${name} -- Expose health for load balancers`);
  await h.run("next", name);
  await h.run("next", name);
  await h.run("approve", `${name} proposal`);
  await h.run("next", name);
  await h.run("next", name);
  await h.run("next", name);
  await h.run("approve", `${name} plan`);
}

describe("canonical package resources", () => {
  it("ships and loads the exact agent and focused skill inventories", async () => {
    const expectedAgents = ["coordinator", ...executionRoles];
    const expectedSkills = expectedAgents.map((role) => roleSkills[role]);
    const root = resolve(import.meta.dirname, "..");
    expect((await readdir(join(root, ".agents/agents"))).sort()).toEqual(
      expectedAgents.map((name) => `${name}.md`).sort(),
    );
    expect((await readdir(join(root, ".agents/skills"))).sort()).toEqual(expectedSkills.sort());
    for (const role of expectedAgents) {
      const loaded = await loadRoleInstructions(role);
      expect(loaded).toContain(`# Loaded skill: ${roleSkills[role]}`);
      expect(loaded.length).toBeGreaterThan(300);
    }
  });

  it("rejects malformed restricted frontmatter", () => {
    expect(() => parseResource("---\nname: broken\nunsafe: |\n---\nbody", "broken.md")).toThrow(
      "Unsupported frontmatter",
    );
  });

  it("registers exact package-local agent and skill directories", async () => {
    const h = await harness();
    expect(h.agents).toEqual([resourcePaths.agents]);
    expect(h.skills).toEqual([resourcePaths.skills]);
    expect([...h.commands.keys()]).toEqual([
      "new",
      "status",
      "answer",
      "next",
      "approve",
      "build",
      "verify",
      "close",
    ]);
  });

  it("maps every delegated lifecycle phase to one canonical role resource", () => {
    expect(phaseRoles).toEqual({
      discovery: "discoverer",
      proposal: "proposer",
      specification: "specifier",
      design: "designer",
      plan: "planner",
      implementation: "implementer",
      verification: "verifier",
      archive: "archivist",
    });
    for (const role of Object.values(phaseRoles)) expect(roleSkills[role]).toBeDefined();
  });
});

describe("permission and direct execution boundaries", () => {
  it("allows writes only for implementer and process only for implementer and verifier", () => {
    for (const [role, profile] of Object.entries(phaseProfiles)) {
      expect(profile.tools?.deny).toEqual(
        expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]),
      );
      expect(profile.tools?.allow).toEqual(expect.arrayContaining(["memory_search", "memory_get"]));
      expect(profile.tools?.allow).not.toContain("memory_save");
      if (role === "implementer") {
        expect(profile).toMatchObject({ readOnly: false, permission: { write: "allow" } });
        expect(profile.tools?.allow).toContain("write_file");
      } else {
        expect(profile).toMatchObject({ readOnly: true, permission: { write: "deny" } });
        expect(profile.tools?.allow).not.toContain("write_file");
      }
      expect(profile.permission?.process).toBe(
        role === "implementer" || role === "verifier" ? "allow" : "deny",
      );
    }
  });

  it("loads canonical agent and skill prose into direct child instructions without memory", async () => {
    const h = await harness([validOutputs[0] as string]);
    await h.run("new", "no-memory -- Work without optional memory tools");
    await expect(h.run("next", "no-memory")).resolves.toContain("discovery.md");
    expect(h.profiles[0]?.instructions).toContain("Investigate only the repository");
    expect(h.profiles[0]?.instructions).toContain("# Loaded skill: wayfinder-discover");
  });
});

describe("validation and persistence gates", () => {
  it.each(["../escape", "UPPER", "a/b", "", ".hidden"])("rejects change name %j", (name) => {
    expect(() => validateChangeName(name)).toThrow();
  });

  it.each(["../secret", "/absolute", "a/../b", "C:\\secret", "a\\b"])(
    "rejects artifact path %j",
    (path) => expect(() => assertRelativePath(path)).toThrow(),
  );

  it("atomically replaces a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-atomic-"));
    workspaces.push(root);
    const path = join(root, "nested/state.json");
    await atomicWrite(path, "old");
    await atomicWrite(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(join(root, "nested"))).toEqual(["state.json"]);
  });

  it("rejects corrupt and incomplete state", () => {
    expect(() => validateState({ schemaVersion: 2, name: "partial" })).toThrow();
    expect(() =>
      validateState({
        schemaVersion: 2,
        name: "bad",
        intent: "intent",
        phase: "implementation",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proposalApproved: true,
        planApproved: true,
        requirementIds: ["REQ-001"],
        units: [{ id: "UNIT-001", status: "completed" }],
        remediationCount: 0,
      }),
    ).toThrow();
  });

  it("requires complete plan coverage and exact verification coverage", () => {
    expect(() =>
      validatePlan(
        {
          schemaVersion: 1,
          units: [
            {
              id: "UNIT-001",
              title: "One",
              goal: "One",
              requirements: ["REQ-001"],
              paths: ["src/a.ts"],
              checks: ["test"],
            },
          ],
        },
        new Set(["REQ-001", "REQ-002"]),
      ),
    ).toThrow("cover every requirement");
    expect(() =>
      validateVerification(
        {
          schemaVersion: 1,
          passed: true,
          summary: "duplicate",
          requirements: [
            { id: "REQ-001", status: "passed", evidence: ["a"] },
            { id: "REQ-001", status: "passed", evidence: ["b"] },
          ],
          checks: [{ command: "test", status: "passed", summary: "ok" }],
          blockers: [],
        },
        new Set(["REQ-001", "REQ-002"]),
      ),
    ).toThrow("exactly once");
  });

  it("preserves state when child output is malformed or turn-limited", async () => {
    const h = await harness([
      "{ partial",
      { status: "completed", text: validOutputs[0], turnsExceeded: true },
    ]);
    await h.run("new", "safe-change -- Preserve state");
    await expect(h.run("next", "safe-change")).rejects.toThrow("single valid JSON");
    await expect(h.run("next", "safe-change")).rejects.toThrow("partial output rejected");
    expect(await h.run("status", "safe-change")).toContain("Phase: discovery");
  });

  it("blocks critical questions and resumes after a recorded clarification", async () => {
    const blocked = JSON.stringify({
      schemaVersion: 1,
      summary: "Need policy",
      findings: ["Existing endpoint"],
      constraints: [],
      criticalQuestions: ["Which clients may call it?"],
    });
    const h = await harness([blocked, validOutputs[0] as string]);
    await h.run("new", "questions -- Add endpoint");
    await expect(h.run("next", "questions")).resolves.toContain("without advancement");
    expect(await h.run("status", "questions")).toContain("Phase: discovery");
    await h.run("answer", "questions -- Internal authenticated clients only");
    await expect(h.run("next", "questions")).resolves.toContain("discovery.md");
    expect(await h.run("status", "questions")).toContain("Phase: proposal");
  });
});

describe("complete lifecycle", () => {
  it("requires explicit approvals in headless mode and archives only after readiness", async () => {
    const h = await harness([...validOutputs]);
    await h.run("new", "health-check -- Expose health for load balancers");
    await h.run("next", "health-check");
    await h.run("next", "health-check");
    await expect(h.run("next", "health-check")).resolves.toContain(
      "Approval required for proposal",
    );
    await h.run("approve", "health-check proposal");
    await h.run("next", "health-check");
    await h.run("next", "health-check");
    await h.run("next", "health-check");
    await expect(h.run("next", "health-check")).resolves.toContain("Approval required for plan");
    await h.run("approve", "health-check plan");
    await h.run("build", "health-check");
    await h.run("verify", "health-check");
    await expect(h.run("close", "health-check")).resolves.toContain("atomically archived");
    const archives = await readdir(join(h.workspace, ".alisio/wayfinder/archive"));
    expect(archives).toHaveLength(1);
    const archive = archives[0] as string;
    const state = JSON.parse(
      await readFile(join(h.workspace, ".alisio/wayfinder/archive", archive, "state.json"), "utf8"),
    );
    expect(state).toMatchObject({ phase: "closed", verification: { passed: true } });
    expect(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/archive", archive, "archive-readiness.md"),
        "utf8",
      ),
    ).toContain("Archive readiness");
    expect(h.profiles.map(({ agent }) => agent)).toEqual([
      "Wayfinder Discoverer",
      "Wayfinder Proposer",
      "Wayfinder Specifier",
      "Wayfinder Designer",
      "Wayfinder Planner",
      "Wayfinder Implementer",
      "Wayfinder Verifier",
      "Wayfinder Archivist",
    ]);
  });

  it("keeps failed verification resumable with at most two remediation units", async () => {
    const failed = JSON.stringify({
      schemaVersion: 1,
      passed: false,
      summary: "Coverage missing",
      requirements: [{ id: "REQ-001", status: "failed", evidence: ["No assertion"] }],
      checks: [{ command: "pnpm test", status: "passed", summary: "Suite ran" }],
      blockers: ["Add focused assertion"],
    });
    const remediation = (unitId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        unitId,
        summary: "Remediated",
        changedPaths: ["src/health.test.ts"],
        checks: [{ command: "pnpm test", status: "passed", summary: "Suite passed" }],
        notes: [],
      });
    const h = await harness([
      ...validOutputs.slice(0, 6),
      failed,
      remediation("UNIT-002"),
      failed,
      remediation("UNIT-003"),
      failed,
    ]);
    await reachImplementation(h, "bounded");
    await h.run("build", "bounded");
    await expect(h.run("verify", "bounded")).resolves.toContain("remediation unit");
    await h.run("build", "bounded");
    await expect(h.run("verify", "bounded")).resolves.toContain("remediation unit");
    await h.run("build", "bounded");
    await expect(h.run("verify", "bounded")).resolves.toContain("limit reached");
    expect(await h.run("status", "bounded")).toContain("Remediation: 2/2");
    expect(await h.run("status", "bounded")).toContain("Phase: verification");
  });

  it("refuses archive when a required artifact is missing", async () => {
    const h = await harness([...validOutputs.slice(0, 7)]);
    await reachImplementation(h, "missing-artifact");
    await h.run("build", "missing-artifact");
    await h.run("verify", "missing-artifact");
    await rm(join(h.workspace, ".alisio/wayfinder/changes/missing-artifact/design.md"), {
      force: true,
    });
    await expect(h.run("close", "missing-artifact")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.run("status", "missing-artifact")).toContain("Phase: archive");
  });

  it("rejects externally corrupted persisted state", async () => {
    const h = await harness();
    await h.run("new", "corrupt -- Test state validation");
    await writeFile(
      join(h.workspace, ".alisio/wayfinder/changes/corrupt/state.json"),
      '{"schemaVersion":2,"name":"corrupt"}',
    );
    await expect(h.run("status", "corrupt")).rejects.toThrow("Invalid Wayfinder state");
  });
});
