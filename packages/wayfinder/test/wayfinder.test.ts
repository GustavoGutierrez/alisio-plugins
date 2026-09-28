import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, {
  assertRelativePath,
  assertScopePath,
  atomicWrite,
  boundedSurvivors,
  buildMutationPlan,
  executionRoles,
  inspectMutationEnvironment,
  isTestId,
  isTestPath,
  isUiPath,
  loadRoleInstructions,
  mutationBounds,
  parseResource,
  phaseProfiles,
  phaseRoles,
  resourcePaths,
  roleSkills,
  validateChangeName,
  validateMutation,
  validatePlan,
  validateState,
  validateTargetedVerification,
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

async function harness(
  outputs: FakeResult[] = [],
  interactive = false,
  answers: Record<string, string> = { approval: "approve" },
) {
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
        return answers;
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

async function reachPlanApproval(h: Awaited<ReturnType<typeof harness>>, name = "health-check") {
  await h.run("new", `${name} -- Expose health for load balancers`);
  await h.run("next", name);
  await h.run("next", name);
  await h.run("approve", `${name} proposal`);
  await h.run("next", name);
  await h.run("next", name);
  await h.run("next", name);
}

async function reachImplementation(
  h: Awaited<ReturnType<typeof harness>>,
  name = "health-check",
  decision: "strict" | "off" = "off",
) {
  await reachPlanApproval(h, name);
  await h.run(
    "tdd",
    `${name} ${decision} -- ${decision === "strict" ? "enforce test-first" : "documented decision to skip test-first"}`,
  );
  await h.run("approve", `${name} plan`);
}

async function reachVerification(h: Awaited<ReturnType<typeof harness>>, name = "health-check") {
  await reachImplementation(h, name);
  await h.run("build", name);
}

const cleanMutation = JSON.stringify({
  schemaVersion: 1,
  tool: "stryker",
  stack: "javascript",
  survivors: [],
  mutationScore: 100,
  summary: "No survivors",
});

const survivorMutation = JSON.stringify({
  schemaVersion: 1,
  tool: "stryker",
  stack: "javascript",
  survivors: [
    {
      file: "src/health.ts",
      description: "String literal not asserted",
      equivalent: false,
      justification: "",
    },
  ],
  mutationScore: 80,
  summary: "One surviving mutant",
});

function implementationOutput(unitId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    unitId,
    summary: "Strengthened assertions",
    changedPaths: ["src/health.test.ts"],
    checks: [
      {
        command: "pnpm exec stryker run --mutate src/health.ts --concurrency 2 --reporters json",
        status: "passed",
        summary: "mutants killed",
      },
    ],
    notes: [],
  });
}

const targetedVerification = JSON.stringify({
  schemaVersion: 1,
  passed: true,
  summary: "Targeted requirements still hold",
  requirements: [{ id: "REQ-001", status: "passed", evidence: ["assertions strengthened"] }],
  checks: [{ command: "pnpm test", status: "passed", summary: "suite passed" }],
  blockers: [],
});

function archiveOutput(completedUnits: string[]): string {
  return JSON.stringify({
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
    completedUnits,
    requirements: ["REQ-001"],
    blockers: [],
    summary: "Complete",
  });
}

async function stubJavaScriptProject(h: Awaited<ReturnType<typeof harness>>, withStryker: boolean) {
  await writeFile(
    join(h.workspace, "package.json"),
    JSON.stringify({
      name: "fixture",
      devDependencies: withStryker ? { "@stryker-mutator/core": "^8.0.0" } : {},
    }),
  );
  if (withStryker) await writeFile(join(h.workspace, "pnpm-lock.yaml"), "");
}

describe("canonical package resources", () => {
  it("ships and loads the exact agent and focused skill inventories", async () => {
    const expectedAgents = ["coordinator", ...executionRoles];
    const expectedSkills = [...new Set(expectedAgents.flatMap((role) => roleSkills[role]))].sort();
    const root = resolve(import.meta.dirname, "..");
    expect((await readdir(join(root, ".agents/agents"))).sort()).toEqual(
      expectedAgents.map((name) => `${name}.md`).sort(),
    );
    expect((await readdir(join(root, ".agents/skills"))).sort()).toEqual(expectedSkills);
    for (const role of expectedAgents) {
      const loaded = await loadRoleInstructions(role);
      for (const skill of roleSkills[role]) {
        expect(loaded).toContain(`# Loaded skill: ${skill}`);
      }
      expect(loaded.length).toBeGreaterThan(300);
    }
  });

  it("loads every mapped skill per role in deterministic order", async () => {
    for (const role of ["implementer", "verifier", "planner"] as const) {
      const loaded = await loadRoleInstructions(role);
      const positions = roleSkills[role].map((skill) => loaded.indexOf(`# Loaded skill: ${skill}`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
    expect(roleSkills.implementer).toContain("wayfinder-test-design");
    expect(roleSkills.verifier).toContain("wayfinder-test-design");
    expect(roleSkills.planner).toContain("wayfinder-test-design");
    expect(roleSkills.discoverer).toEqual(["wayfinder-discover"]);
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
      "mutate",
      "tdd",
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
  it("allows writes only for implementer and process for implementer, verifier, and mutationist", () => {
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
        role === "implementer" || role === "verifier" || role === "mutationist" ? "allow" : "deny",
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

  it("accepts a legacy state without mutation fields and keeps mutation optional", () => {
    const timestamp = new Date().toISOString();
    const state = validateState({
      schemaVersion: 2,
      name: "legacy",
      intent: "intent",
      phase: "discovery",
      createdAt: timestamp,
      updatedAt: timestamp,
      proposalApproved: false,
      planApproved: false,
      requirementIds: [],
      units: [],
      remediationCount: 0,
    });
    expect(state.mutation).toBeUndefined();
    expect(state.mutationRemediationCount).toBeUndefined();
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
    await h.run("tdd", "health-check off -- low-risk additive change");
    await h.run("approve", "health-check plan");
    await h.run("build", "health-check");
    await h.run("verify", "health-check");
    await expect(
      h.run("mutate", "health-check skip -- low-risk additive change"),
    ).resolves.toContain("advanced to archive");
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

  it("loads and archives a legacy state that predates the mutation fields", async () => {
    const h = await harness([...validOutputs]);
    await h.run("new", "legacy -- Additive compatibility");
    const stateFile = join(h.workspace, ".alisio/wayfinder/changes/legacy/state.json");
    const legacy = JSON.parse(await readFile(stateFile, "utf8"));
    delete legacy.mutationRemediationCount;
    delete legacy.mutation;
    delete legacy.tdd;
    await writeFile(stateFile, JSON.stringify(legacy));
    expect(await h.run("status", "legacy")).toContain("Mutation: decision pending");
    expect(await h.run("status", "legacy")).toContain("TDD: decision pending");
    await h.run("next", "legacy");
    await h.run("next", "legacy");
    await h.run("approve", "legacy proposal");
    await h.run("next", "legacy");
    await h.run("next", "legacy");
    await h.run("next", "legacy");
    await h.run("tdd", "legacy off -- legacy state without mutation or tdd fields");
    await h.run("approve", "legacy plan");
    await h.run("build", "legacy");
    await h.run("verify", "legacy");
    await h.run("mutate", "legacy skip -- legacy state without mutation fields");
    await expect(h.run("close", "legacy")).resolves.toContain("atomically archived");
    const archives = await readdir(join(h.workspace, ".alisio/wayfinder/archive"));
    const archived = JSON.parse(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/archive", archives[0] as string, "state.json"),
        "utf8",
      ),
    );
    expect(archived.mutationRemediationCount).toBe(0);
    expect(archived.mutation.decision.decision).toBe("skip");
    expect(archived.tdd.decision).toBe("off");
  });

  it("refuses archive when a required artifact is missing", async () => {
    const h = await harness([...validOutputs.slice(0, 7)]);
    await reachImplementation(h, "missing-artifact");
    await h.run("build", "missing-artifact");
    await h.run("verify", "missing-artifact");
    await h.run("mutate", "missing-artifact skip -- artifact inventory test");
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

describe("mutation testing", () => {
  it("detects JavaScript and non-JavaScript stacks from their own manifests", async () => {
    const js = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(js);
    await writeFile(
      join(js, "package.json"),
      JSON.stringify({ devDependencies: { "@stryker-mutator/core": "^8.0.0" } }),
    );
    await writeFile(join(js, "pnpm-lock.yaml"), "");
    const jsEnv = await inspectMutationEnvironment(js);
    expect(jsEnv.stack).toBe("javascript");
    expect(jsEnv.packageManager).toBe("pnpm");
    expect(jsEnv.tool?.name).toBe("stryker");
    const many = Array.from({ length: 25 }, (_, index) => `src/f${index}.ts`);
    const jsPlan = buildMutationPlan(jsEnv, { mode: "changed", changedPaths: many });
    expect(jsPlan.available).toBe(true);
    expect(jsPlan.command).toContain("stryker");
    expect(jsPlan.command).toContain("--concurrency 2");
    expect(jsPlan.concurrency).toBe(mutationBounds.concurrency);
    expect(jsPlan.scopeSupport).toBe("paths");
    expect(jsPlan.concurrencyApplied).toBe(true);
    expect(jsPlan.timeoutMs).toBe(mutationBounds.timeoutMs);
    expect(jsPlan.scope).toHaveLength(mutationBounds.scopeLimit);
    const full = buildMutationPlan(jsEnv, { mode: "full", changedPaths: many });
    expect(full.scope).toEqual([]);
    expect(full.command).not.toContain("--mutate");

    const rust = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(rust);
    await writeFile(join(rust, "Cargo.toml"), '[dev-dependencies]\ncargo-mutants = "0.6"\n');
    const rustEnv = await inspectMutationEnvironment(rust);
    expect(rustEnv.stack).toBe("rust");
    expect(rustEnv.tool?.name).toBe("cargo-mutants");
    const rustPlan = buildMutationPlan(rustEnv, { mode: "changed", changedPaths: ["src/lib.rs"] });
    expect(rustPlan.available).toBe(true);
    expect(rustPlan.scopeSupport).toBe("paths");
    expect(rustPlan.concurrencyApplied).toBe(true);
    expect(rustPlan.command).toContain("cargo mutants");
    expect(rustPlan.command).toContain("--jobs 2");
  });

  it("never auto-installs and reports unavailable tooling without blocking", async () => {
    const root = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "plain" }));
    const env = await inspectMutationEnvironment(root);
    expect(env.stack).toBe("javascript");
    expect(env.tool).toBeUndefined();
    const plan = buildMutationPlan(env, { mode: "changed", changedPaths: ["src/a.ts"] });
    expect(plan.available).toBe(false);
    expect(plan.reason).toContain("already-installed");
  });

  it("keeps mutation scope paths free of shell metacharacters", () => {
    expect(() => assertScopePath("src/a.ts; rm -rf /")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("a/../b")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("/etc/passwd")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("src/a$(whoami).ts")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("-rf.ts")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("src/-flag.ts")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath(" src/a.ts")).toThrow("Unsafe mutation scope path");
    expect(() => assertScopePath("src/a.ts ")).toThrow("Unsafe mutation scope path");
    expect(assertScopePath("src/a-b_c.d/e f.ts")).toBe("src/a-b_c.d/e f.ts");
  });

  it("requires a justification for equivalent survivors and rejects unsafe paths", () => {
    expect(() =>
      validateMutation({
        schemaVersion: 1,
        tool: "stryker",
        stack: "javascript",
        survivors: [{ file: "src/a.ts", description: "d", equivalent: true, justification: "" }],
        summary: "s",
      }),
    ).toThrow("justification");
    expect(() =>
      validateMutation({
        schemaVersion: 1,
        tool: "stryker",
        stack: "javascript",
        survivors: [{ file: "../escape.ts", description: "d", equivalent: false }],
        summary: "s",
      }),
    ).toThrow();
  });

  it("enforces exact targeted verification coverage", () => {
    const raw = {
      schemaVersion: 1,
      passed: true,
      summary: "ok",
      requirements: [{ id: "REQ-001", status: "passed", evidence: ["e"] }],
      checks: [{ command: "t", status: "passed", summary: "s" }],
      blockers: [],
    };
    expect(() => validateTargetedVerification(raw, new Set(["REQ-001", "REQ-002"]))).toThrow(
      "exactly once",
    );
    expect(validateTargetedVerification(raw, new Set(["REQ-001"])).requirements).toHaveLength(1);
    expect(() =>
      validateTargetedVerification(
        {
          ...raw,
          requirements: [{ id: "REQ-002", status: "passed", evidence: ["e"] }],
        },
        new Set(["REQ-001"]),
      ),
    ).toThrow("Unknown verification requirement");
  });

  it("selects the package-manager runner for npm, yarn, and bun", async () => {
    const cases: Array<[string, string, string]> = [
      ["package-lock.json", "npm", "npx --no-install stryker"],
      ["yarn.lock", "yarn", "yarn exec stryker"],
      ["bun.lockb", "bun", "bunx --no-install stryker"],
    ];
    for (const [lockfile, manager, runner] of cases) {
      const root = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
      workspaces.push(root);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ devDependencies: { "@stryker-mutator/core": "^8.0.0" } }),
      );
      await writeFile(join(root, lockfile), "");
      const env = await inspectMutationEnvironment(root);
      expect(env.packageManager).toBe(manager);
      const plan = buildMutationPlan(env, { mode: "changed", changedPaths: ["src/a.ts"] });
      expect(plan.command.startsWith(runner)).toBe(true);
    }
  });

  it("detects Python, Go, and Java tools and builds their bounded commands", async () => {
    const py = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(py);
    await writeFile(join(py, "pyproject.toml"), '[tool.mutmut]\npaths_to_mutate = "src"\n');
    const pyEnv = await inspectMutationEnvironment(py);
    expect(pyEnv.stack).toBe("python");
    expect(pyEnv.tool?.name).toBe("mutmut");
    const pyPlan = buildMutationPlan(pyEnv, { mode: "changed", changedPaths: ["src/a.py"] });
    expect(pyPlan.available).toBe(true);
    expect(pyPlan.scopeSupport).toBe("paths");
    expect(pyPlan.concurrencyApplied).toBe(false);
    expect(pyPlan.command).toBe("mutmut run --paths-to-mutate src/a.py");

    const go = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(go);
    await writeFile(
      join(go, "go.mod"),
      "module example.com/x\nrequire github.com/go-gremlins/gremlins v0.5.0\n",
    );
    const goEnv = await inspectMutationEnvironment(go);
    expect(goEnv.stack).toBe("go");
    expect(goEnv.tool?.name).toBe("gremlins");
    const goPlan = buildMutationPlan(goEnv, { mode: "changed", changedPaths: ["pkg/a.go"] });
    expect(goPlan.available).toBe(true);
    expect(goPlan.concurrencyApplied).toBe(true);
    expect(goPlan.command).toBe("gremlins unleash --workers 2 ./pkg/a.go");

    const gom = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(gom);
    await writeFile(
      join(gom, "go.mod"),
      "module example.com/y\nrequire github.com/zimmski/go-mutesting v0.0.0\n",
    );
    const gomEnv = await inspectMutationEnvironment(gom);
    expect(gomEnv.tool?.name).toBe("go-mutesting");
    const gomPlan = buildMutationPlan(gomEnv, { mode: "changed", changedPaths: ["pkg/a.go"] });
    expect(gomPlan.concurrencyApplied).toBe(false);
    expect(gomPlan.command).toBe("go-mutesting ./pkg/a.go");

    const java = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(java);
    await writeFile(
      join(java, "pom.xml"),
      "<project><build><plugins><plugin><groupId>org.pitest</groupId></plugin></plugins></build></project>",
    );
    const javaEnv = await inspectMutationEnvironment(java);
    expect(javaEnv.stack).toBe("java");
    expect(javaEnv.tool?.name).toBe("pitest");
    expect(javaEnv.tool?.scopeSupport).toBe("none");
  });

  it("refuses bounded runs for whole-repository-only tools and allows explicit full mode", async () => {
    const java = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(java);
    await writeFile(
      join(java, "pom.xml"),
      "<project><build><plugins><plugin><groupId>org.pitest</groupId></plugin></plugins></build></project>",
    );
    const javaEnv = await inspectMutationEnvironment(java);
    const bounded = buildMutationPlan(javaEnv, {
      mode: "changed",
      changedPaths: ["src/Main.java"],
    });
    expect(bounded.available).toBe(false);
    expect(bounded.scopeSupport).toBe("none");
    expect(bounded.args).toEqual([]);
    expect(bounded.reason).toContain("whole-repository");
    const full = buildMutationPlan(javaEnv, { mode: "full", changedPaths: [] });
    expect(full.available).toBe(true);
    expect(full.scopeSupport).toBe("none");
    expect(full.command).toContain("pitest");

    const gradle = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(gradle);
    await writeFile(join(gradle, "build.gradle"), "plugins { id 'info.solidsoft.pitest' }\n");
    const gradleEnv = await inspectMutationEnvironment(gradle);
    expect(gradleEnv.tool?.scopeSupport).toBe("none");
    const gradleBounded = buildMutationPlan(gradleEnv, {
      mode: "changed",
      changedPaths: ["src/Main.java"],
    });
    expect(gradleBounded.available).toBe(false);
    expect(gradleBounded.reason).toContain("whole-repository");
    const gradleFull = buildMutationPlan(gradleEnv, { mode: "full", changedPaths: [] });
    expect(gradleFull.available).toBe(true);
    expect(gradleFull.command).toContain("pitest");

    const py = await mkdtemp(join(tmpdir(), "wayfinder-detect-"));
    workspaces.push(py);
    await writeFile(join(py, "pyproject.toml"), 'name = "x"\n# cosmic-ray session\n');
    const crEnv = await inspectMutationEnvironment(py);
    expect(crEnv.tool?.name).toBe("cosmic-ray");
    const crBounded = buildMutationPlan(crEnv, { mode: "changed", changedPaths: ["src/a.py"] });
    expect(crBounded.available).toBe(false);
    expect(crBounded.reason).toContain("whole-repository");
  });

  it("truncates the survivor report at the cap", () => {
    const survivors = Array.from({ length: mutationBounds.survivorLimit + 3 }, (_, index) => ({
      file: `src/f${index}.ts`,
      description: "mutant",
      equivalent: false,
      justification: "",
    }));
    const bounded = boundedSurvivors(survivors);
    expect(bounded.truncated).toBe(true);
    expect(bounded.survivors).toHaveLength(mutationBounds.survivorLimit);
    expect(boundedSurvivors(survivors.slice(0, 2)).truncated).toBe(false);
  });

  it("classifies test paths for test-strengthening enforcement", () => {
    expect(isTestPath("src/health.test.ts")).toBe(true);
    expect(isTestPath("test/health.ts")).toBe(true);
    expect(isTestPath("src/__tests__/health.ts")).toBe(true);
    expect(isTestPath("pkg/handler_test.go")).toBe(true);
    expect(isTestPath("src/HealthSpec.kt")).toBe(true);
    expect(isTestPath("src/test.ts")).toBe(true);
    expect(isTestPath("src/tests.ts")).toBe(true);
    expect(isTestPath("src/spec.rb")).toBe(true);
    expect(isTestPath("src/health.ts")).toBe(false);
    expect(isTestPath("src/contest/health.ts")).toBe(false);
  });

  it("blocks archive until an immutable mutation decision is recorded", async () => {
    const h = await harness([...validOutputs]);
    await reachVerification(h, "gate");
    await expect(h.run("verify", "gate")).resolves.toContain("Mutation testing decision required");
    expect(await h.run("status", "gate")).toContain("Mutation: decision pending");
    await expect(h.run("close", "gate")).rejects.toThrow("Cannot close");
    await expect(h.run("mutate", "gate skip -- low-risk additive change")).resolves.toContain(
      "advanced to archive",
    );
    await expect(h.run("mutate", "gate skip -- again")).rejects.toThrow("immutable");
    await expect(h.run("close", "gate")).resolves.toContain("atomically archived");
  });

  it("runs bounded mutation testing and archives when no failing survivors remain", async () => {
    const h = await harness([...validOutputs.slice(0, 7), cleanMutation, validOutputs[7]]);
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "mutate-clean");
    await expect(h.run("verify", "mutate-clean")).resolves.toContain(
      "Mutation testing decision required",
    );
    await expect(h.run("mutate", "mutate-clean run -- changed behavior")).resolves.toContain(
      "Next: /wayfinder:verify",
    );
    await expect(h.run("verify", "mutate-clean")).resolves.toContain("Mutation testing passed");
    expect(await h.run("status", "mutate-clean")).toContain("Phase: archive");
    expect(h.profiles.map(({ agent }) => agent)).toContain("Wayfinder Mutationist");
    await expect(h.run("close", "mutate-clean")).resolves.toContain("atomically archived");
  });

  it("advances to archive without blocking when mutation tooling is unavailable", async () => {
    const h = await harness([...validOutputs.slice(0, 7), validOutputs[7]]);
    await stubJavaScriptProject(h, false);
    await reachVerification(h, "mutate-unavailable");
    await h.run("verify", "mutate-unavailable");
    await h.run("mutate", "mutate-unavailable run -- attempt anyway");
    await expect(h.run("verify", "mutate-unavailable")).resolves.toContain(
      "Mutation testing unavailable",
    );
    expect(await h.run("status", "mutate-unavailable")).toContain("Phase: archive");
    await expect(h.run("close", "mutate-unavailable")).resolves.toContain("atomically archived");
  });

  it("routes a survivor into a test-strengthening unit and targeted re-verification", async () => {
    const h = await harness([
      ...validOutputs.slice(0, 7),
      survivorMutation,
      implementationOutput("UNIT-002"),
      cleanMutation,
      targetedVerification,
      archiveOutput(["UNIT-001", "UNIT-002"]),
    ]);
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "mutate-survivor");
    await h.run("verify", "mutate-survivor");
    await h.run("mutate", "mutate-survivor run -- cover new branch");
    await expect(h.run("verify", "mutate-survivor")).resolves.toContain(
      "test-strengthening unit is ready",
    );
    expect(await h.run("status", "mutate-survivor")).toContain("Mutation: run (targeted) (1/2)");
    const plan = await readFile(
      join(h.workspace, ".alisio/wayfinder/changes/mutate-survivor/plan.md"),
      "utf8",
    );
    expect(plan).toContain("test-strengthening");
    await expect(h.run("build", "mutate-survivor")).resolves.toContain("UNIT-002");
    await expect(h.run("verify", "mutate-survivor")).resolves.toContain(
      "Targeted mutation and verification passed",
    );
    expect(await h.run("status", "mutate-survivor")).toContain("Phase: archive");
    await expect(h.run("close", "mutate-survivor")).resolves.toContain("atomically archived");
    const archives = await readdir(join(h.workspace, ".alisio/wayfinder/archive"));
    const archived = JSON.parse(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/archive", archives[0] as string, "state.json"),
        "utf8",
      ),
    );
    expect(archived.mutation.targeted).toBeUndefined();
    expect(archived.mutationRemediationCount).toBe(1);
  });

  it("bounds mutation remediation and stops for human reassessment", async () => {
    const h = await harness([
      ...validOutputs.slice(0, 7),
      survivorMutation,
      implementationOutput("UNIT-002"),
      survivorMutation,
      implementationOutput("UNIT-003"),
      survivorMutation,
    ]);
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "mutate-budget");
    await h.run("verify", "mutate-budget");
    await h.run("mutate", "mutate-budget run -- bounded");
    await expect(h.run("verify", "mutate-budget")).resolves.toContain(
      "test-strengthening unit is ready",
    );
    await h.run("build", "mutate-budget");
    await expect(h.run("verify", "mutate-budget")).resolves.toContain(
      "test-strengthening unit is ready",
    );
    await h.run("build", "mutate-budget");
    await expect(h.run("verify", "mutate-budget")).resolves.toContain(
      "Mutation remediation limit reached",
    );
    const status = await h.run("status", "mutate-budget");
    expect(status).toContain("Mutation: run (targeted) (2/2)");
    expect(status).toContain("Phase: verification");
  });

  it("excludes equivalent survivors from failure", async () => {
    const equivalentMutation = JSON.stringify({
      schemaVersion: 1,
      tool: "stryker",
      stack: "javascript",
      survivors: [
        {
          file: "src/health.ts",
          description: "Unreachable defensive branch",
          equivalent: true,
          justification: "Unreachable by contract",
        },
      ],
      mutationScore: 95,
      summary: "One equivalent survivor",
    });
    const h = await harness([...validOutputs.slice(0, 7), equivalentMutation, validOutputs[7]]);
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "mutate-equivalent");
    await h.run("verify", "mutate-equivalent");
    await h.run("mutate", "mutate-equivalent run -- triage");
    await expect(h.run("verify", "mutate-equivalent")).resolves.toContain("equivalent survivor");
    expect(await h.run("status", "mutate-equivalent")).toContain("Phase: archive");
    await expect(h.run("close", "mutate-equivalent")).resolves.toContain("atomically archived");
  });

  it("persists an interactive mutation decision from the answered question", async () => {
    const h = await harness([...validOutputs.slice(0, 7), cleanMutation, validOutputs[7]], true, {
      mutation: "run",
    });
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "interactive");
    await expect(h.run("verify", "interactive")).resolves.toContain("Mutation testing passed");
    const state = JSON.parse(
      await readFile(join(h.workspace, ".alisio/wayfinder/changes/interactive/state.json"), "utf8"),
    );
    expect(state.mutation.decision).toMatchObject({
      decision: "run",
      mode: "changed",
      source: "recommended",
    });
    await expect(h.run("close", "interactive")).resolves.toContain("atomically archived");
  });

  it("rejects production edits from a test-strengthening unit and accepts test-only edits", async () => {
    const productionEdit = JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-002",
      summary: "edited production",
      changedPaths: ["src/health.ts"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      notes: [],
    });
    const h = await harness([
      ...validOutputs.slice(0, 7),
      survivorMutation,
      productionEdit,
      implementationOutput("UNIT-002"),
      cleanMutation,
      targetedVerification,
      archiveOutput(["UNIT-001", "UNIT-002"]),
    ]);
    await stubJavaScriptProject(h, true);
    await reachVerification(h, "tests-only");
    await h.run("verify", "tests-only");
    await h.run("mutate", "tests-only run -- strengthen");
    await expect(h.run("verify", "tests-only")).resolves.toContain(
      "test-strengthening unit is ready",
    );
    await expect(h.run("build", "tests-only")).rejects.toThrow("test paths only");
    expect(await h.run("status", "tests-only")).toContain("Phase: implementation");
    await expect(h.run("build", "tests-only")).resolves.toContain("UNIT-002");
    await expect(h.run("verify", "tests-only")).resolves.toContain(
      "Targeted mutation and verification passed",
    );
    await expect(h.run("close", "tests-only")).resolves.toContain("atomically archived");
  });

  it("advances without blocking when a bounded run is refused by a whole-repo tool", async () => {
    const h = await harness([...validOutputs.slice(0, 7), validOutputs[7]]);
    await writeFile(
      join(h.workspace, "pom.xml"),
      "<project><build><plugins><plugin><groupId>org.pitest</groupId></plugin></plugins></build></project>",
    );
    await reachVerification(h, "java-bounded");
    await h.run("verify", "java-bounded");
    await h.run("mutate", "java-bounded run -- bounded attempt");
    await expect(h.run("verify", "java-bounded")).resolves.toContain(
      "Mutation testing unavailable",
    );
    const state = JSON.parse(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/changes/java-bounded/state.json"),
        "utf8",
      ),
    );
    expect(state.mutation.run.scopeSupport).toBe("none");
    expect(state.mutation.run.unavailableReason).toContain("whole-repository");
    expect(await h.run("status", "java-bounded")).toContain("Phase: archive");
    await expect(h.run("close", "java-bounded")).resolves.toContain("atomically archived");
  });
});

describe("test-first (TDD) gate", () => {
  it("rejects a TDD decision outside plan-approval", async () => {
    const h = await harness();
    await h.run("new", "tdd-phase -- Expose behavior");
    await expect(h.run("tdd", "tdd-phase off -- too early")).rejects.toThrow("plan-approval");
  });

  it("requires a TDD decision before plan approval and rejects a second decision", async () => {
    const h = await harness([...validOutputs]);
    await reachPlanApproval(h, "tdd-gate");
    await expect(h.run("approve", "tdd-gate plan")).resolves.toContain("/wayfinder:tdd tdd-gate");
    expect(await h.run("status", "tdd-gate")).toContain("Phase: plan-approval");
    await expect(h.run("approve", "tdd-gate plan")).resolves.toContain("TDD decision required");
    expect(await h.run("status", "tdd-gate")).toContain("TDD: decision pending");
    await expect(h.run("tdd", "tdd-gate off -- documentation only")).resolves.toContain(
      "No test-first evidence",
    );
    await expect(h.run("tdd", "tdd-gate strict -- change my mind")).rejects.toThrow("immutable");
    await expect(h.run("approve", "tdd-gate plan")).resolves.toContain("Approved plan");
    expect(await h.run("status", "tdd-gate")).toContain("Phase: implementation");
  });

  it("persists the interactive TDD decision with source recommended", async () => {
    const h = await harness([...validOutputs], true, { approval: "approve", tdd: "off" });
    await reachPlanApproval(h, "tdd-interactive");
    await h.run("approve", "tdd-interactive plan");
    const state = JSON.parse(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/changes/tdd-interactive/state.json"),
        "utf8",
      ),
    );
    expect(state.tdd).toMatchObject({ decision: "off", source: "recommended" });
    expect(state.phase).toBe("implementation");
  });

  it("blocks when the interactive TDD answer is invalid and does not advance", async () => {
    const h = await harness([...validOutputs], true, { approval: "approve" });
    await reachPlanApproval(h, "tdd-invalid");
    await expect(h.run("approve", "tdd-invalid plan")).resolves.toContain(
      "/wayfinder:tdd tdd-invalid",
    );
    const state = JSON.parse(
      await readFile(join(h.workspace, ".alisio/wayfinder/changes/tdd-invalid/state.json"), "utf8"),
    );
    expect(state.tdd).toBeUndefined();
    expect(state.phase).toBe("plan-approval");
  });

  it("allows implementation without test-first evidence when TDD is off", async () => {
    const h = await harness([...validOutputs]);
    await reachImplementation(h, "tdd-off");
    await expect(h.run("build", "tdd-off")).resolves.toContain("Completed UNIT-001");
  });

  it("rejects a strict unit that reports no test path and keeps it pending", async () => {
    const h = await harness([...validOutputs]);
    await reachImplementation(h, "tdd-no-test-path", "strict");
    await expect(h.run("build", "tdd-no-test-path")).rejects.toThrow(
      "change at least one test file",
    );
    expect(await h.run("status", "tdd-no-test-path")).toContain("Phase: implementation");
    const state = JSON.parse(
      await readFile(
        join(h.workspace, ".alisio/wayfinder/changes/tdd-no-test-path/state.json"),
        "utf8",
      ),
    );
    expect(state.units[0].status).toBe("pending");
    expect(state.tdd.decision).toBe("strict");
  });

  it("rejects a strict unit that reports a test path without testFirst evidence", async () => {
    const noTestFirst = JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-001",
      summary: "Added behavior",
      changedPaths: ["src/health.test.ts"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      notes: [],
    });
    const h = await harness([...validOutputs.slice(0, 5), noTestFirst]);
    await reachImplementation(h, "tdd-no-test-first", "strict");
    await expect(h.run("build", "tdd-no-test-first")).rejects.toThrow(
      "provide test-first evidence",
    );
    expect(await h.run("status", "tdd-no-test-first")).toContain("Phase: implementation");
  });

  it("rejects a strict unit when the failing and passing runs reference different scopes", async () => {
    const mismatch = JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-001",
      summary: "Added behavior",
      changedPaths: ["src/health.test.ts"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      testFirst: {
        failingCommand: "pnpm vitest run src/a.test.ts",
        passingCommand: "pnpm vitest run src/b.test.ts",
      },
      notes: [],
    });
    const h = await harness([...validOutputs.slice(0, 5), mismatch]);
    await reachImplementation(h, "tdd-mismatch", "strict");
    await expect(h.run("build", "tdd-mismatch")).rejects.toThrow("same test scope");
  });

  it("accepts a strict unit with complete test-first evidence", async () => {
    const complete = JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-001",
      summary: "Added behavior",
      changedPaths: ["src/health.test.ts"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      testFirst: {
        failingCommand: "pnpm vitest run src/health.test.ts",
        failingEvidenceRef: "first run: 1 failing",
        passingCommand: "pnpm vitest run src/health.test.ts",
      },
      notes: [],
    });
    const h = await harness([...validOutputs.slice(0, 5), complete]);
    await reachImplementation(h, "tdd-complete", "strict");
    await expect(h.run("build", "tdd-complete")).resolves.toContain("Completed UNIT-001");
    expect(await h.run("status", "tdd-complete")).toContain("Phase: verification");
    const plan = await readFile(
      join(h.workspace, ".alisio/wayfinder/changes/tdd-complete/plan.md"),
      "utf8",
    );
    expect(plan).toContain("Requirements: REQ-001");
  });

  it("rejects a plan exemption without justification and accepts one with justification", async () => {
    const unit = {
      id: "UNIT-001",
      title: "Bump dependency",
      goal: "Bump dependency version",
      requirements: ["REQ-001"],
      paths: ["package.json"],
      checks: ["pnpm test"],
    };
    expect(() =>
      validatePlan(
        { schemaVersion: 1, units: [{ ...unit, tddExempt: true }] },
        new Set(["REQ-001"]),
      ),
    ).toThrow("tddExemptReason");
    expect(() =>
      validatePlan(
        {
          schemaVersion: 1,
          units: [
            { ...unit, tddExempt: true, tddExemptReason: "Dependency bump with no behavior" },
          ],
        },
        new Set(["REQ-001"]),
      ),
    ).not.toThrow();
    expect(() =>
      validatePlan(
        {
          schemaVersion: 1,
          units: [{ ...unit, tddExempt: true, tddExemptReason: "   " }],
        },
        new Set(["REQ-001"]),
      ),
    ).toThrow();

    const exemptPlan = JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          ...unit,
          tddExempt: true,
          tddExemptReason: "Dependency bump with no behavior",
        },
      ],
    });
    const exemptImplementation = JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-001",
      summary: "Bumped dependency",
      changedPaths: ["package.json"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      notes: [],
    });
    const h = await harness([
      validOutputs[0],
      validOutputs[1],
      validOutputs[2],
      validOutputs[3],
      exemptPlan,
      exemptImplementation,
    ]);
    await reachImplementation(h, "tdd-exempt", "strict");
    await expect(h.run("build", "tdd-exempt")).resolves.toContain("Completed UNIT-001");
    expect(await h.run("status", "tdd-exempt")).toContain("Phase: verification");
  });

  it("grandfathers a legacy state past plan approval without a tdd decision", async () => {
    const h = await harness([...validOutputs]);
    await reachPlanApproval(h, "tdd-legacy");
    const stateFile = join(h.workspace, ".alisio/wayfinder/changes/tdd-legacy/state.json");
    const legacy = JSON.parse(await readFile(stateFile, "utf8"));
    expect(legacy.tdd).toBeUndefined();
    legacy.planApproved = true;
    legacy.phase = "implementation";
    await writeFile(stateFile, JSON.stringify(legacy));
    expect(await h.run("status", "tdd-legacy")).toContain("TDD: decision pending");
    await expect(h.run("build", "tdd-legacy")).resolves.toContain("Completed UNIT-001");
    expect(await h.run("status", "tdd-legacy")).toContain("Phase: verification");
  });

  it("validates persisted tddExempt units and rejects blank or invalid reasons", () => {
    const timestamp = new Date().toISOString();
    const base = {
      schemaVersion: 2,
      name: "exempt-state",
      intent: "intent",
      phase: "implementation",
      createdAt: timestamp,
      updatedAt: timestamp,
      proposalApproved: true,
      planApproved: true,
      requirementIds: ["REQ-001"],
      remediationCount: 0,
    };
    const unit = {
      id: "UNIT-001",
      title: "Bump dependency",
      goal: "Bump dependency",
      requirements: ["REQ-001"],
      paths: ["package.json"],
      checks: ["pnpm test"],
      status: "pending",
      tddExempt: true,
      tddExemptReason: "Dependency bump with no behavior",
    };
    expect(() => validateState({ ...base, units: [unit] })).not.toThrow();
    for (const bad of ["", "   "]) {
      expect(() => validateState({ ...base, units: [{ ...unit, tddExemptReason: bad }] })).toThrow(
        "Invalid Wayfinder state",
      );
    }
    const withoutReason: Record<string, unknown> = { ...unit };
    delete withoutReason.tddExemptReason;
    expect(() => validateState({ ...base, units: [withoutReason] })).toThrow(
      "Invalid Wayfinder state",
    );
    expect(() => validateState({ ...base, units: [{ ...unit, tddExemptReason: 7 }] })).toThrow(
      "Invalid Wayfinder state",
    );
  });
});

describe("test design and UI testability", () => {
  const planWithTests = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          id: "UNIT-001",
          title: "Add health",
          goal: "Expose health",
          requirements: ["REQ-001"],
          paths: ["src/health.ts"],
          checks: ["pnpm test"],
          requiresTests: true,
          ...extra,
        },
      ],
    });
  const implementationWith = (partial: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 1,
      unitId: "UNIT-001",
      summary: "Implemented",
      changedPaths: ["src/health.ts"],
      checks: [{ command: "pnpm test", status: "passed", summary: "ok" }],
      notes: [],
      ...partial,
    });
  const queueFor = (plan: string, output: string) => [
    validOutputs[0] as string,
    validOutputs[1] as string,
    validOutputs[2] as string,
    validOutputs[3] as string,
    plan,
    output,
  ];

  it("classifies UI paths and validates test-id naming", () => {
    const uiExtensions = [
      ".html",
      ".htm",
      ".xhtml",
      ".jsx",
      ".tsx",
      ".vue",
      ".svelte",
      ".astro",
      ".ejs",
      ".hbs",
      ".handlebars",
      ".mustache",
      ".pug",
      ".jade",
      ".twig",
      ".njk",
      ".liquid",
      ".erb",
      ".haml",
      ".slim",
    ];
    for (const extension of uiExtensions) {
      expect(isUiPath(`views/Component${extension}`)).toBe(true);
    }
    expect(isUiPath("views/Cart.VUE")).toBe(true);
    expect(isUiPath("src/health.ts")).toBe(false);
    expect(isUiPath("scripts/build.mjs")).toBe(false);
    expect(isTestId("cart-checkout-button")).toBe(true);
    expect(isTestId("login-email-input")).toBe(true);
    expect(isTestId("login")).toBe(false);
    expect(isTestId("Login-Email")).toBe(false);
    expect(isTestId("login_email")).toBe(false);
  });

  it("rejects a non-boolean requiresTests in a plan", () => {
    expect(() =>
      validatePlan(
        {
          schemaVersion: 1,
          units: [
            {
              id: "UNIT-001",
              title: "Add health",
              goal: "Expose health",
              requirements: ["REQ-001"],
              paths: ["src/health.ts"],
              checks: ["pnpm test"],
              requiresTests: "yes",
            },
          ],
        },
        new Set(["REQ-001"]),
      ),
    ).toThrow("requiresTests");
  });

  it("rejects a requiresTests unit when testDesign is missing", async () => {
    const h = await harness(
      queueFor(planWithTests(), implementationWith({ changedPaths: ["src/health.test.ts"] })),
    );
    await reachImplementation(h, "design-missing");
    await expect(h.run("build", "design-missing")).rejects.toThrow("requires tests");
  });

  it("rejects a scenario without a happy test", async () => {
    const h = await harness(
      queueFor(
        planWithTests(),
        implementationWith({
          changedPaths: ["src/health.test.ts"],
          testDesign: [{ scenario: "expose", happy: [], unhappy: ["rejects bad input"] }],
        }),
      ),
    );
    await reachImplementation(h, "design-happy");
    await expect(h.run("build", "design-happy")).rejects.toThrow("no happy-path test");
  });

  it("rejects a scenario without an unhappy test", async () => {
    const h = await harness(
      queueFor(
        planWithTests(),
        implementationWith({
          changedPaths: ["src/health.test.ts"],
          testDesign: [{ scenario: "expose", happy: ["returns 200"], unhappy: [] }],
        }),
      ),
    );
    await reachImplementation(h, "design-unhappy");
    await expect(h.run("build", "design-unhappy")).rejects.toThrow("no unhappy-path test");
  });

  it("rejects duplicate or blank scenario names", async () => {
    const duplicate = implementationWith({
      changedPaths: ["src/health.test.ts"],
      testDesign: [
        { scenario: "expose", happy: ["a"], unhappy: ["b"] },
        { scenario: "expose", happy: ["c"], unhappy: ["d"] },
      ],
    });
    const h = await harness(queueFor(planWithTests(), duplicate));
    await reachImplementation(h, "design-duplicate");
    await expect(h.run("build", "design-duplicate")).rejects.toThrow("repeats the scenario");

    const blank = implementationWith({
      changedPaths: ["src/health.test.ts"],
      testDesign: [{ scenario: "   ", happy: ["a"], unhappy: ["b"] }],
    });
    const h2 = await harness(queueFor(planWithTests(), blank));
    await reachImplementation(h2, "design-blank");
    await expect(h2.run("build", "design-blank")).rejects.toThrow("must be non-empty");
  });

  it("accepts a complete happy and unhappy design", async () => {
    const h = await harness(
      queueFor(
        planWithTests(),
        implementationWith({
          changedPaths: ["src/health.test.ts"],
          testDesign: [
            { scenario: "expose", happy: ["returns 200"], unhappy: ["rejects bad input"] },
          ],
        }),
      ),
    );
    await reachImplementation(h, "design-complete");
    await expect(h.run("build", "design-complete")).resolves.toContain("Completed UNIT-001");
  });

  it("rejects a UI unit without testability", async () => {
    const h = await harness(
      queueFor(validOutputs[4] as string, implementationWith({ changedPaths: ["src/App.tsx"] })),
    );
    await reachImplementation(h, "ui-missing");
    await expect(h.run("build", "ui-missing")).rejects.toThrow("testability");
  });

  it("rejects non-convention UI test ids", async () => {
    const h = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({
          changedPaths: ["src/App.tsx"],
          testability: { testIds: ["Login", "login_email"] },
        }),
      ),
    );
    await reachImplementation(h, "ui-bad-id");
    await expect(h.run("build", "ui-bad-id")).rejects.toThrow("non-convention test ids");
  });

  it("rejects empty UI test ids without a reason", async () => {
    const h = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({ changedPaths: ["src/App.tsx"], testability: { testIds: [] } }),
      ),
    );
    await reachImplementation(h, "ui-empty");
    await expect(h.run("build", "ui-empty")).rejects.toThrow("accessibleOnlyReason");
  });

  it("accepts an accessible-only reason for a UI unit", async () => {
    const h = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({
          changedPaths: ["src/App.tsx"],
          testability: { testIds: [], accessibleOnlyReason: "Semantic roles only" },
        }),
      ),
    );
    await reachImplementation(h, "ui-reason");
    await expect(h.run("build", "ui-reason")).resolves.toContain("Completed UNIT-001");
  });

  it("accepts convention-matching UI test ids", async () => {
    const h = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({
          changedPaths: ["src/App.tsx"],
          testability: { testIds: ["login-email-input"] },
        }),
      ),
    );
    await reachImplementation(h, "ui-ids");
    await expect(h.run("build", "ui-ids")).resolves.toContain("Completed UNIT-001");
  });

  it("does not apply the testability rule to a non-UI unit", async () => {
    const h = await harness(
      queueFor(validOutputs[4] as string, implementationWith({ changedPaths: ["src/health.ts"] })),
    );
    await reachImplementation(h, "no-ui");
    await expect(h.run("build", "no-ui")).resolves.toContain("Completed UNIT-001");
  });

  it("treats a UI-extension test file as a test path, not a UI path", async () => {
    const testOnly = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({ changedPaths: ["src/App.test.tsx"] }),
      ),
    );
    await reachImplementation(testOnly, "ui-test-file");
    const stateFile = join(testOnly.workspace, ".alisio/wayfinder/changes/ui-test-file/state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.units[0].kind = "test-strengthening";
    await writeFile(stateFile, JSON.stringify(state));
    await expect(testOnly.run("build", "ui-test-file")).resolves.toContain("Completed UNIT-001");

    const mixed = await harness(
      queueFor(
        validOutputs[4] as string,
        implementationWith({ changedPaths: ["src/App.tsx", "src/App.test.tsx"] }),
      ),
    );
    await reachImplementation(mixed, "ui-mixed");
    await expect(mixed.run("build", "ui-mixed")).rejects.toThrow("testability");

    const real = await harness(
      queueFor(validOutputs[4] as string, implementationWith({ changedPaths: ["src/App.tsx"] })),
    );
    await reachImplementation(real, "ui-real");
    await expect(real.run("build", "ui-real")).rejects.toThrow("testability");
  });
});
