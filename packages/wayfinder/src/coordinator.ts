import { relative } from "node:path";
import type { ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import { loadRoleInstructions } from "./resources.js";
import {
  archiveChange,
  listChanges,
  readArtifact,
  readState,
  validateChangeName,
  writeArtifact,
  writeState,
} from "./storage.js";
import type {
  ArchiveOutput,
  ChangeState,
  DesignOutput,
  DiscoveryOutput,
  ExecutionRole,
  ImplementationOutput,
  PlanOutput,
  ProposalOutput,
  SpecificationOutput,
  VerificationOutput,
  WorkUnit,
} from "./types.js";
import {
  parseChildJson,
  validateArchive,
  validateDesign,
  validateDiscovery,
  validateImplementation,
  validatePlan,
  validateProposal,
  validateSpecification,
  validateVerification,
} from "./validation.js";

const readTools = ["read_file", "list_files", "search_text", "git_status", "git_diff"];
const optionalMemoryTools = ["memory_search", "memory_get"];
const delegationTools = ["task", "delegate", "subagent", "sessions_create"];
const readable = [...readTools, ...optionalMemoryTools];

type Profile = Pick<
  ChildSessionSpec,
  "agent" | "readOnly" | "permission" | "tools" | "maxTurns" | "timeoutMs" | "maxOutputTokens"
>;

const readProfile = (agent: string, maxTurns: number, process = false): Profile => ({
  agent,
  readOnly: true,
  permission: { write: "deny", process: process ? "allow" : "deny" },
  tools: { allow: process ? [...readable, "run_process"] : readable, deny: delegationTools },
  maxTurns,
  timeoutMs: process ? 300_000 : 120_000,
  maxOutputTokens: 5_000,
});

export const phaseProfiles: Record<ExecutionRole, Profile> = {
  discoverer: readProfile("Wayfinder Discoverer", 8),
  proposer: readProfile("Wayfinder Proposer", 8),
  specifier: readProfile("Wayfinder Specifier", 8),
  designer: readProfile("Wayfinder Designer", 10),
  planner: readProfile("Wayfinder Planner", 8),
  implementer: {
    agent: "Wayfinder Implementer",
    readOnly: false,
    permission: { write: "allow", process: "allow" },
    tools: {
      allow: [...readable, "write_file", "edit_file", "run_process"],
      deny: delegationTools,
    },
    maxTurns: 18,
    timeoutMs: 300_000,
    maxOutputTokens: 5_000,
  },
  verifier: readProfile("Wayfinder Verifier", 14, true),
  archivist: readProfile("Wayfinder Archivist", 8),
};

export const phaseRoles: Partial<Record<ChangeState["phase"], ExecutionRole>> = {
  discovery: "discoverer",
  proposal: "proposer",
  specification: "specifier",
  design: "designer",
  plan: "planner",
  implementation: "implementer",
  verification: "verifier",
  archive: "archivist",
};

const schemas = {
  discovery:
    '{ "schemaVersion": 1, "summary": "...", "findings": ["..."], "constraints": ["..."], "criticalQuestions": [] }',
  proposal:
    '{ "schemaVersion": 1, "outcome": "...", "inScope": ["..."], "outOfScope": [], "assumptions": [], "criticalQuestions": [] }',
  specification:
    '{ "schemaVersion": 1, "requirements": [{ "id": "REQ-001", "statement": "...", "acceptance": ["..."] }], "criticalQuestions": [] }',
  design:
    '{ "schemaVersion": 1, "summary": "...", "decisions": [{ "topic": "...", "choice": "...", "rationale": "..." }], "paths": ["relative/path"], "risks": [] }',
  plan: '{ "schemaVersion": 1, "units": [{ "id": "UNIT-001", "title": "...", "goal": "...", "requirements": ["REQ-001"], "paths": ["relative/path"], "checks": ["command or observable check"] }] }',
  implementation:
    '{ "schemaVersion": 1, "unitId": "UNIT-001", "summary": "...", "changedPaths": ["relative/path"], "checks": [{ "command": "...", "status": "passed", "summary": "..." }], "notes": [] }',
  verification:
    '{ "schemaVersion": 1, "passed": true, "summary": "...", "requirements": [{ "id": "REQ-001", "status": "passed", "evidence": ["..."] }], "checks": [{ "command": "...", "status": "passed", "summary": "..." }], "blockers": [] }',
  archive:
    '{ "schemaVersion": 1, "ready": true, "artifacts": ["intent.md"], "completedUnits": ["UNIT-001"], "requirements": ["REQ-001"], "blockers": [], "summary": "..." }',
} as const;

const now = () => new Date().toISOString();
const bullets = (items: string[]) =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
const section = (title: string, items: string[]) => `## ${title}\n\n${bullets(items)}\n`;
const criticalBlock = (name: string, questions: string[]) =>
  `Blocked by critical questions:\n${bullets(questions)}\nAdd clarification with: /wayfinder:answer ${name} -- <answer>`;

function renderDiscovery(output: DiscoveryOutput): string {
  return `# Discovery\n\n${output.summary}\n\n${section("Findings", output.findings)}\n${section("Constraints", output.constraints)}\n${section("Critical questions", output.criticalQuestions)}`;
}
function renderProposal(output: ProposalOutput): string {
  return `# Proposal\n\n${output.outcome}\n\n${section("In scope", output.inScope)}\n${section("Out of scope", output.outOfScope)}\n${section("Assumptions", output.assumptions)}\n${section("Critical questions", output.criticalQuestions)}`;
}
function renderSpecification(output: SpecificationOutput): string {
  const requirements = output.requirements
    .map((item) => `## ${item.id}: ${item.statement}\n\n${bullets(item.acceptance)}`)
    .join("\n\n");
  return `# Specification\n\n${requirements}\n\n${section("Critical questions", output.criticalQuestions)}`;
}
function renderDesign(output: DesignOutput): string {
  const decisions = output.decisions
    .map(
      (item) =>
        `## ${item.topic}\n\n**Choice:** ${item.choice}\n\n**Rationale:** ${item.rationale}`,
    )
    .join("\n\n");
  return `# Design\n\n${output.summary}\n\n${decisions}\n\n${section("Expected paths", output.paths)}\n${section("Risks", output.risks)}`;
}
function renderPlan(units: WorkUnit[]): string {
  return `# Plan\n\n${units
    .map(
      (unit) =>
        `## ${unit.id}: ${unit.title}\n\n${unit.goal}\n\n- Requirements: ${unit.requirements.join(", ")}\n- Paths: ${unit.paths.join(", ")}\n- Checks: ${unit.checks.join("; ")}\n- Status: ${unit.status}`,
    )
    .join("\n\n")}`;
}
function renderImplementation(output: ImplementationOutput): string {
  return `## ${output.unitId}\n\n${output.summary}\n\n- Changed paths: ${output.changedPaths.join(", ")}\n- Checks: ${output.checks.map((item) => `${item.command} — ${item.summary}`).join("; ")}\n- Notes: ${output.notes.join("; ") || "None"}\n`;
}
function renderVerification(output: VerificationOutput): string {
  return `# Verification\n\n**Result:** ${output.passed ? "passed" : "failed"}\n\n${output.summary}\n\n${output.requirements
    .map((item) => `## ${item.id}: ${item.status}\n\n${bullets(item.evidence)}`)
    .join("\n\n")}\n\n${section(
    "Checks",
    output.checks.map((item) => `${item.command} — ${item.summary}`),
  )}\n${section("Blockers", output.blockers)}`;
}
function renderArchive(output: ArchiveOutput): string {
  return `# Archive readiness\n\n${output.summary}\n\n${section("Artifacts", output.artifacts)}\n${section("Completed units", output.completedUnits)}\n${section("Requirements", output.requirements)}\n${section("Blockers", output.blockers)}`;
}

function parseDelimited(args: string, usage: string): { name: string; value: string } {
  const delimiter = args.indexOf("--");
  if (delimiter < 0) throw new Error(usage);
  const name = validateChangeName(args.slice(0, delimiter).trim());
  const value = args.slice(delimiter + 2).trim();
  if (!value) throw new Error(usage);
  return { name, value };
}

async function optionalArtifact(workspace: string, name: string, file: string): Promise<string> {
  try {
    return await readArtifact(workspace, name, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export class WayfinderCoordinator {
  constructor(private readonly api: PluginAPI) {}

  private workspace(sessionId?: string): { parentId: string; workspace: string } {
    if (!sessionId) throw new Error("Wayfinder commands require an active Alisio session");
    return { parentId: sessionId, workspace: this.api.sessions.workspace(sessionId) };
  }

  private async delegate(
    role: ExecutionRole,
    parentId: string,
    workspace: string,
    title: string,
    prompt: string,
  ): Promise<unknown> {
    const instructions = await loadRoleInstructions(role);
    const child = await this.api.sessions.create({
      parentId,
      workspace,
      title,
      instructions,
      ...phaseProfiles[role],
    });
    this.api.ui.status("phase", `${role}: running`, title);
    try {
      const result = await this.api.sessions.run(child.id, prompt);
      if (result.turnsExceeded)
        throw new Error(`${role} exceeded its turn limit; partial output rejected`);
      if (result.status !== "completed") {
        throw new Error(result.error || `${role} child ended with ${result.status}`);
      }
      return parseChildJson(result.text);
    } finally {
      this.api.ui.status("phase", undefined);
    }
  }

  async create(args: string, sessionId?: string): Promise<string> {
    const { workspace } = this.workspace(sessionId);
    const { name, value: intent } = parseDelimited(
      args,
      "Usage: /wayfinder:new <change> -- <explicit intent>",
    );
    try {
      await readState(workspace, name);
      throw new Error(`Change already exists: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const timestamp = now();
    const state: ChangeState = {
      schemaVersion: 2,
      name,
      intent,
      phase: "discovery",
      createdAt: timestamp,
      updatedAt: timestamp,
      proposalApproved: false,
      planApproved: false,
      requirementIds: [],
      units: [],
      remediationCount: 0,
    };
    await writeArtifact(workspace, name, "intent.md", `# Intent\n\n${intent}\n`);
    await writeState(workspace, state);
    return `Created ${name}. Next: /wayfinder:next ${name}`;
  }

  async answer(args: string, sessionId?: string): Promise<string> {
    const { workspace } = this.workspace(sessionId);
    const { name, value } = parseDelimited(
      args,
      "Usage: /wayfinder:answer <change> -- <clarification>",
    );
    const state = await readState(workspace, name);
    if (!["discovery", "proposal", "specification"].includes(state.phase)) {
      throw new Error(`Clarifications are not accepted while ${name} is in ${state.phase}`);
    }
    const current = await optionalArtifact(workspace, name, "clarifications.md");
    const content = current || "# Clarifications\n";
    await writeArtifact(
      workspace,
      name,
      "clarifications.md",
      `${content.trimEnd()}\n\n- ${value}\n`,
    );
    return `Clarification recorded for ${name}. Retry: /wayfinder:next ${name}`;
  }

  async status(args: string, sessionId?: string): Promise<string> {
    const { workspace } = this.workspace(sessionId);
    const name = args.trim();
    if (!name) {
      const changes = await listChanges(workspace);
      if (!changes.length) return "No active Wayfinder changes.";
      const states = await Promise.all(changes.map((change) => readState(workspace, change)));
      return states
        .map(
          (state) =>
            `${state.name}: ${state.phase} (${state.units.filter(({ status }) => status === "completed").length}/${state.units.length} units)`,
        )
        .join("\n");
    }
    const state = await readState(workspace, validateChangeName(name));
    return `${state.name}\nPhase: ${state.phase}\nUnits: ${state.units.filter(({ status }) => status === "completed").length}/${state.units.length}\nRemediation: ${state.remediationCount}/2\nNext action: ${this.nextAction(state)}`;
  }

  private nextAction(state: ChangeState): string {
    if (state.phase === "proposal-approval") return `/wayfinder:approve ${state.name} proposal`;
    if (state.phase === "plan-approval") return `/wayfinder:approve ${state.name} plan`;
    if (["discovery", "proposal", "specification", "design", "plan"].includes(state.phase)) {
      return `/wayfinder:next ${state.name}`;
    }
    if (state.phase === "implementation") return `/wayfinder:build ${state.name}`;
    if (state.phase === "verification") return `/wayfinder:verify ${state.name}`;
    if (state.phase === "archive") return `/wayfinder:close ${state.name}`;
    return "No action; change is closed";
  }

  private async requestApproval(state: ChangeState, workspace: string): Promise<string> {
    const target = state.phase === "proposal-approval" ? "proposal" : "plan";
    if (!this.api.ui.interactive()) {
      return `Approval required for ${target}. Review ${target}.md, then run /wayfinder:approve ${state.name} ${target}`;
    }
    const result = await this.api.ui.askQuestions({
      label: "Wayfinder approval",
      questions: [
        {
          id: "approval",
          header: `${target} approval`,
          question: `Approve the ${target} for ${state.name}?`,
          options: [
            { value: "approve", label: "Approve" },
            { value: "stop", label: "Not yet" },
          ],
        },
      ],
    });
    if (result.approval !== "approve") {
      return `Approval not recorded. Review ${target}.md and resume with /wayfinder:approve ${state.name} ${target}`;
    }
    return this.recordApproval(state, workspace, target);
  }

  private async recordApproval(
    state: ChangeState,
    workspace: string,
    target: "proposal" | "plan",
  ): Promise<string> {
    if (target === "proposal" && state.phase === "proposal-approval") {
      state.proposalApproved = true;
      state.phase = "specification";
    } else if (target === "plan" && state.phase === "plan-approval") {
      state.planApproved = true;
      state.phase = "implementation";
    } else {
      throw new Error(`Cannot approve ${target} while ${state.name} is in ${state.phase}`);
    }
    state.updatedAt = now();
    await writeState(workspace, state);
    return `Approved ${target} for ${state.name}. Next: ${this.nextAction(state)}`;
  }

  async approve(args: string, sessionId?: string): Promise<string> {
    const { workspace } = this.workspace(sessionId);
    const [rawName, rawTarget, ...extra] = args.trim().split(/\s+/);
    if (!rawName || (rawTarget !== "proposal" && rawTarget !== "plan") || extra.length) {
      throw new Error("Usage: /wayfinder:approve <change> <proposal|plan>");
    }
    const state = await readState(workspace, validateChangeName(rawName));
    return this.recordApproval(state, workspace, rawTarget);
  }

  async next(args: string, sessionId?: string): Promise<string> {
    const { parentId, workspace } = this.workspace(sessionId);
    const name = validateChangeName(args.trim());
    const state = await readState(workspace, name);
    if (state.phase === "proposal-approval" || state.phase === "plan-approval") {
      return this.requestApproval(state, workspace);
    }
    const clarification = await optionalArtifact(workspace, name, "clarifications.md");
    const context = `Change: ${name}\nIntent: ${state.intent}${clarification ? `\n\nClarifications:\n${clarification}` : ""}`;
    let artifact: string;
    let critical: string[] = [];
    if (state.phase === "discovery") {
      const output = validateDiscovery(
        await this.delegate(
          "discoverer",
          parentId,
          workspace,
          `Discover ${name}`,
          `${context}\n\nInspect the current repository. Return only:\n${schemas.discovery}`,
        ),
      );
      artifact = "discovery.md";
      critical = output.criticalQuestions;
      await writeArtifact(workspace, name, artifact, renderDiscovery(output));
      if (!critical.length) state.phase = "proposal";
    } else if (state.phase === "proposal") {
      const discovery = await readArtifact(workspace, name, "discovery.md");
      const output = validateProposal(
        await this.delegate(
          "proposer",
          parentId,
          workspace,
          `Propose ${name}`,
          `${context}\n\nDiscovery:\n${discovery}\n\nReturn only:\n${schemas.proposal}`,
        ),
      );
      artifact = "proposal.md";
      critical = output.criticalQuestions;
      await writeArtifact(workspace, name, artifact, renderProposal(output));
      if (!critical.length) state.phase = "proposal-approval";
    } else if (state.phase === "specification") {
      const proposal = await readArtifact(workspace, name, "proposal.md");
      const output = validateSpecification(
        await this.delegate(
          "specifier",
          parentId,
          workspace,
          `Specify ${name}`,
          `${context}\n\nApproved proposal:\n${proposal}\n\nReturn only:\n${schemas.specification}`,
        ),
      );
      artifact = "specification.md";
      critical = output.criticalQuestions;
      await writeArtifact(workspace, name, artifact, renderSpecification(output));
      if (!critical.length) {
        state.requirementIds = output.requirements.map(({ id }) => id);
        state.phase = "design";
      }
    } else if (state.phase === "design") {
      const specification = await readArtifact(workspace, name, "specification.md");
      const output = validateDesign(
        await this.delegate(
          "designer",
          parentId,
          workspace,
          `Design ${name}`,
          `${context}\n\nSpecification:\n${specification}\n\nReturn only:\n${schemas.design}`,
        ),
      );
      artifact = "design.md";
      await writeArtifact(workspace, name, artifact, renderDesign(output));
      state.phase = "plan";
    } else if (state.phase === "plan") {
      const specification = await readArtifact(workspace, name, "specification.md");
      const design = await readArtifact(workspace, name, "design.md");
      const output: PlanOutput = validatePlan(
        await this.delegate(
          "planner",
          parentId,
          workspace,
          `Plan ${name}`,
          `${context}\n\nSpecification:\n${specification}\n\nDesign:\n${design}\n\nReturn only:\n${schemas.plan}`,
        ),
        new Set(state.requirementIds),
      );
      state.units = output.units.map((unit) => ({ ...unit, status: "pending" }));
      artifact = "plan.md";
      await writeArtifact(workspace, name, artifact, renderPlan(state.units));
      state.phase = "plan-approval";
    } else {
      throw new Error(`Cannot run next while ${name} is in phase ${state.phase}`);
    }
    state.updatedAt = now();
    await writeState(workspace, state);
    if (critical.length)
      return `${artifact} recorded without advancement.\n${criticalBlock(name, critical)}`;
    return `Completed ${artifact} for ${name}. Next: ${this.nextAction(state)}`;
  }

  async build(args: string, sessionId?: string): Promise<string> {
    const { parentId, workspace } = this.workspace(sessionId);
    const name = validateChangeName(args.trim());
    const state = await readState(workspace, name);
    if (state.phase !== "implementation" || !state.proposalApproved || !state.planApproved) {
      throw new Error(`Cannot build while ${name} is in phase ${state.phase}`);
    }
    const unit = state.units.find(({ status }) => status === "pending");
    if (!unit) throw new Error("Implementation phase has no pending work unit");
    const specification = await readArtifact(workspace, name, "specification.md");
    const design = await readArtifact(workspace, name, "design.md");
    const priorVerification = await optionalArtifact(workspace, name, "verification.md");
    const output = validateImplementation(
      await this.delegate(
        "implementer",
        parentId,
        workspace,
        `Implement ${unit.id}: ${unit.title}`,
        `Change: ${name}\nIntent: ${state.intent}\n\nSpecification:\n${specification}\n\nDesign:\n${design}${priorVerification ? `\n\nPrior verification:\n${priorVerification}` : ""}\n\nImplement exactly this unit:\n${JSON.stringify(unit, null, 2)}\n\nReturn only after changing files and running focused checks:\n${schemas.implementation}`,
      ),
      unit.id,
    );
    unit.status = "completed";
    unit.changedPaths = output.changedPaths;
    unit.evidence = output.checks;
    const progress = (await optionalArtifact(workspace, name, "progress.md")) || "# Progress\n";
    await writeArtifact(
      workspace,
      name,
      "progress.md",
      `${progress.trimEnd()}\n\n${renderImplementation(output)}`,
    );
    await writeArtifact(workspace, name, "plan.md", renderPlan(state.units));
    if (state.units.every(({ status }) => status === "completed")) state.phase = "verification";
    state.updatedAt = now();
    await writeState(workspace, state);
    return `Completed ${unit.id} for ${name}. Next: ${this.nextAction(state)}`;
  }

  async verify(args: string, sessionId?: string): Promise<string> {
    const { parentId, workspace } = this.workspace(sessionId);
    const name = validateChangeName(args.trim());
    const state = await readState(workspace, name);
    if (state.phase !== "verification") {
      throw new Error(`Cannot verify while ${name} is in phase ${state.phase}`);
    }
    if (!state.units.length || state.units.some(({ status }) => status !== "completed")) {
      throw new Error("Verification requires every work unit to be completed");
    }
    const specification = await readArtifact(workspace, name, "specification.md");
    const design = await readArtifact(workspace, name, "design.md");
    const progress = await readArtifact(workspace, name, "progress.md");
    const output = validateVerification(
      await this.delegate(
        "verifier",
        parentId,
        workspace,
        `Verify ${name}`,
        `Change: ${name}\nIntent: ${state.intent}\n\nSpecification:\n${specification}\n\nDesign:\n${design}\n\nImplementation self-report (context only; independently inspect files and run checks):\n${progress}\n\nReturn only:\n${schemas.verification}`,
      ),
      new Set(state.requirementIds),
    );
    await writeArtifact(workspace, name, "verification.md", renderVerification(output));
    state.verification = {
      passed: output.passed,
      summary: output.summary,
      blockers: output.blockers,
      checkedAt: now(),
    };
    if (output.passed) {
      state.phase = "archive";
    } else if (state.remediationCount < 2) {
      state.remediationCount += 1;
      const failed = output.requirements
        .filter(({ status }) => status === "failed")
        .map(({ id }) => id);
      const paths = [
        ...new Set(
          state.units
            .filter((unit) => unit.requirements.some((id) => failed.includes(id)))
            .flatMap((unit) => unit.paths),
        ),
      ];
      state.units.push({
        id: `UNIT-${String(state.units.length + 1).padStart(3, "0")}`,
        title: `Remediate verification attempt ${state.remediationCount}`,
        goal: output.blockers.join("; "),
        requirements: failed.length ? failed : [...state.requirementIds],
        paths,
        checks: output.blockers,
        status: "pending",
      });
      state.phase = "implementation";
      await writeArtifact(workspace, name, "plan.md", renderPlan(state.units));
    }
    state.updatedAt = now();
    await writeState(workspace, state);
    if (output.passed) return `Verification passed for ${name}. Next: /wayfinder:close ${name}`;
    if (state.phase === "implementation") {
      return `Verification failed for ${name}. A bounded remediation unit is ready: /wayfinder:build ${name}`;
    }
    return `Verification failed for ${name}; remediation limit reached. Resolve externally or revise the change before retrying verification.`;
  }

  async close(args: string, sessionId?: string): Promise<string> {
    const { parentId, workspace } = this.workspace(sessionId);
    const name = validateChangeName(args.trim());
    const state = await readState(workspace, name);
    if (
      state.phase !== "archive" ||
      !state.verification?.passed ||
      state.units.some(({ status }) => status !== "completed")
    ) {
      throw new Error(`Cannot close ${name}: verification or implementation is incomplete`);
    }
    const artifacts = [
      "intent.md",
      "discovery.md",
      "proposal.md",
      "specification.md",
      "design.md",
      "plan.md",
      "progress.md",
      "verification.md",
    ];
    const contents = await Promise.all(
      artifacts.map(
        async (file) => `${file}: ${(await readArtifact(workspace, name, file)).length} bytes`,
      ),
    );
    const output = validateArchive(
      await this.delegate(
        "archivist",
        parentId,
        workspace,
        `Check archive readiness for ${name}`,
        `Change: ${name}\nExpected artifacts:\n${contents.join("\n")}\nCompleted units: ${state.units.map(({ id }) => id).join(", ")}\nRequirements: ${state.requirementIds.join(", ")}\nVerification: ${state.verification.summary}\n\nReturn only:\n${schemas.archive}`,
      ),
      {
        artifacts: new Set(artifacts),
        units: new Set(state.units.map(({ id }) => id)),
        requirements: new Set(state.requirementIds),
      },
    );
    await writeArtifact(workspace, name, "archive-readiness.md", renderArchive(output));
    state.phase = "closed";
    state.updatedAt = now();
    const destination = await archiveChange(workspace, state);
    return `Closed ${name} and atomically archived it at ${relative(workspace, destination)}.`;
  }
}
