import { relative } from "node:path";
import type { ChildSessionSpec, PluginAPI } from "@alisio/sdk";
import {
  assertScopePath,
  boundedSurvivors,
  buildMutationPlan,
  inspectMutationEnvironment,
  isTestPath,
  mutationBounds,
  mutationRemediationLimit,
  nonEquivalentSurvivors,
} from "./mutation.js";
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
  MutationDecisionValue,
  MutationRun,
  MutationScopeMode,
  NormalizedChangeState,
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
  validateMutation,
  validatePlan,
  validateProposal,
  validateSpecification,
  validateTargetedVerification,
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
  mutationist: {
    agent: "Wayfinder Mutationist",
    readOnly: true,
    permission: { write: "deny", process: "allow" },
    tools: { allow: [...readable, "run_process"], deny: delegationTools },
    maxTurns: 12,
    timeoutMs: mutationBounds.timeoutMs,
    maxOutputTokens: 5_000,
  },
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
  mutation:
    '{ "schemaVersion": 1, "tool": "stryker", "stack": "javascript", "survivors": [{ "file": "src/a.ts", "line": 12, "description": "...", "equivalent": false, "justification": "" }], "mutationScore": 92.5, "summary": "..." }',
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
        `## ${unit.id}: ${unit.title}\n\n${unit.goal}\n\n${unit.kind === "test-strengthening" ? `- Kind: ${unit.kind}\n` : ""}- Requirements: ${unit.requirements.join(", ")}\n- Paths: ${unit.paths.join(", ")}\n- Checks: ${unit.checks.join("; ")}\n- Status: ${unit.status}`,
    )
    .join("\n\n")}`;
}
const nextUnitId = (state: ChangeState): string =>
  `UNIT-${String(state.units.length + 1).padStart(3, "0")}`;
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
function renderMutation(run: MutationRun): string {
  const state = run.unavailableReason
    ? `unavailable — ${run.unavailableReason}`
    : `${run.failingSurvivors} failing, ${run.equivalentSurvivors} equivalent${run.truncated ? " (survivor list truncated)" : ""}`;
  const survivors = run.survivors.map(
    (survivor) =>
      `${survivor.file}${survivor.line ? `:${survivor.line}` : ""} — ${survivor.description}${survivor.equivalent ? ` (equivalent: ${survivor.justification})` : ""}`,
  );
  return `# Mutation testing\n\n**Tool:** ${run.tool}\n**Stack:** ${run.stack}\n**Mode:** ${run.mode}\n**Scope support:** ${run.scopeSupport ?? "unknown"}\n**Concurrency bound:** ${run.concurrencyApplied ? mutationBounds.concurrency : "not applied"}\n**Scope:** ${run.scope.length ? run.scope.join(", ") : "whole repository"}\n**Command:** ${run.command || "(not run)"}\n**Result:** ${state}${run.mutationScore !== undefined ? `\n**Mutation score:** ${run.mutationScore}` : ""}\n\n${run.summary}\n\n${section("Survivors", survivors)}`;
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
      mutationRemediationCount: 0,
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
    const mutation = state.mutation?.decision
      ? `Mutation: ${state.mutation.decision.decision}${state.mutation.targeted ? " (targeted)" : ""} (${state.mutationRemediationCount}/${mutationRemediationLimit})`
      : "Mutation: decision pending";
    return `${state.name}\nPhase: ${state.phase}\nUnits: ${state.units.filter(({ status }) => status === "completed").length}/${state.units.length}\nRemediation: ${state.remediationCount}/2\n${mutation}\nNext action: ${this.nextAction(state)}`;
  }

  private nextAction(state: ChangeState): string {
    if (state.phase === "proposal-approval") return `/wayfinder:approve ${state.name} proposal`;
    if (state.phase === "plan-approval") return `/wayfinder:approve ${state.name} plan`;
    if (["discovery", "proposal", "specification", "design", "plan"].includes(state.phase)) {
      return `/wayfinder:next ${state.name}`;
    }
    if (state.phase === "implementation") return `/wayfinder:build ${state.name}`;
    if (state.phase === "verification") {
      if (state.verification?.passed && !state.mutation?.decision) {
        return `/wayfinder:mutate ${state.name} run|skip -- <reason>`;
      }
      return `/wayfinder:verify ${state.name}`;
    }
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
    if (unit.kind === "test-strengthening") {
      const offending = output.changedPaths.filter((path) => !isTestPath(path));
      if (offending.length) {
        throw new Error(
          `Test-strengthening unit ${unit.id} may modify test paths only; rejected production edits: ${offending.join(", ")}. Strengthen tests only and do not change production behavior, then retry /wayfinder:build ${name}.`,
        );
      }
    }
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

  private safeFiles(paths: string[]): string[] {
    const scope: string[] = [];
    for (const path of paths) {
      try {
        const safe = assertScopePath(path);
        if (!scope.includes(safe)) scope.push(safe);
      } catch {
        // Skip paths that cannot be safely passed as an argument.
      }
      if (scope.length >= mutationBounds.scopeLimit) break;
    }
    return scope;
  }

  private changeScope(state: ChangeState): string[] {
    const changed = state.units.flatMap((unit) => unit.changedPaths ?? []);
    return this.safeFiles(changed.length ? changed : state.units.flatMap((unit) => unit.paths));
  }

  private targetRequirements(state: ChangeState, files: string[]): string[] {
    const matched = state.units
      .filter((unit) => unit.paths.some((path) => files.includes(path)))
      .flatMap((unit) => unit.requirements);
    const unique = [...new Set(matched)];
    return unique.length ? unique : [...state.requirementIds];
  }

  private mutationPrompt(
    name: string,
    state: ChangeState,
    plan: ReturnType<typeof buildMutationPlan>,
  ): string {
    return `Change: ${name}\nIntent: ${state.intent}\n\nStack: ${plan.stack}\nTool: ${plan.tool}\nMode: ${plan.mode}\nScope support: ${plan.scopeSupport === "paths" ? "bounded paths" : "whole repository only"}\nScope (${plan.scope.length} file(s)): ${plan.scope.length ? plan.scope.join(", ") : "whole repository (explicit full mode)"}\nBounds: concurrency ${plan.concurrencyApplied ? plan.concurrency : "not applied (tool does not support it)"}, timeout ${plan.timeoutMs} ms, report at most ${plan.survivorLimit} survivors.\n\nRun exactly this argument list with the run_process tool; never install tooling and never build a shell command from file content:\n${JSON.stringify(plan.args)}\n\nTriage every survivor. Mark a survivor equivalent only with a concrete justification.\n\nReturn only:\n${schemas.mutation}`;
  }

  private async persistUnavailableRun(
    state: ChangeState,
    workspace: string,
    name: string,
    plan: ReturnType<typeof buildMutationPlan>,
  ): Promise<string> {
    const reason = plan.reason ?? "Mutation tooling unavailable.";
    const run: MutationRun = {
      tool: plan.tool ?? "none",
      stack: plan.stack,
      mode: plan.mode,
      scopeSupport: plan.scopeSupport,
      concurrencyApplied: plan.concurrencyApplied,
      scope: plan.scope,
      command: "",
      survivors: [],
      failingSurvivors: 0,
      equivalentSurvivors: 0,
      summary: reason,
      ranAt: now(),
      unavailableReason: reason,
    };
    state.mutation = { ...(state.mutation ?? {}), run };
    if (state.mutation) delete state.mutation.targeted;
    state.phase = "archive";
    state.updatedAt = now();
    await writeArtifact(workspace, name, "mutation.md", renderMutation(run));
    await writeState(workspace, state);
    return `Mutation testing unavailable for ${name} (${reason}). Advanced to archive without blocking. Next: /wayfinder:close ${name}`;
  }

  private async scheduleVerificationRemediation(
    state: ChangeState,
    workspace: string,
    name: string,
    output: VerificationOutput,
  ): Promise<string> {
    if (state.remediationCount >= 2) {
      state.updatedAt = now();
      await writeState(workspace, state);
      return `Verification failed for ${name}; remediation limit reached. Resolve externally or revise the change before retrying verification.`;
    }
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
      id: nextUnitId(state),
      title: `Remediate verification attempt ${state.remediationCount}`,
      goal: output.blockers.join("; "),
      requirements: failed.length ? failed : [...state.requirementIds],
      paths,
      checks: output.blockers,
      status: "pending",
    });
    state.phase = "implementation";
    await writeArtifact(workspace, name, "plan.md", renderPlan(state.units));
    state.updatedAt = now();
    await writeState(workspace, state);
    return `Verification failed for ${name}. A bounded remediation unit is ready: /wayfinder:build ${name}`;
  }

  private async scheduleMutationRemediation(
    state: NormalizedChangeState,
    workspace: string,
    name: string,
    input: {
      files: string[];
      requirementIds: string[];
      count: number;
      goal: string;
      command: string;
    },
  ): Promise<string> {
    if (state.mutationRemediationCount >= mutationRemediationLimit) {
      state.updatedAt = now();
      await writeState(workspace, state);
      return `Mutation remediation limit reached for ${name} (${state.mutationRemediationCount}/${mutationRemediationLimit}) with ${input.count} unresolved item(s). Stop for human reassessment; strengthen tests or revise scope manually.`;
    }
    state.mutationRemediationCount += 1;
    const attempt = state.mutationRemediationCount;
    const requirementIds = input.requirementIds.length
      ? input.requirementIds
      : [...state.requirementIds];
    state.mutation = {
      ...(state.mutation ?? {}),
      targeted: { files: input.files, requirementIds, attempt },
    };
    state.units.push({
      id: nextUnitId(state),
      kind: "test-strengthening",
      title: `Strengthen tests (mutation attempt ${attempt})`,
      goal: input.goal,
      requirements: requirementIds,
      paths: input.files.length
        ? input.files
        : [...new Set(state.units.flatMap((unit) => unit.paths))],
      checks: [input.command],
      status: "pending",
    });
    state.phase = "implementation";
    await writeArtifact(workspace, name, "plan.md", renderPlan(state.units));
    state.updatedAt = now();
    await writeState(workspace, state);
    return `Mutation remediation required for ${name} (${input.count} item(s)). A test-strengthening unit is ready: /wayfinder:build ${name}. Strengthen TESTS ONLY; do not change production behavior to satisfy the tool.`;
  }

  private recordMutationRun(
    state: ChangeState,
    plan: ReturnType<typeof buildMutationPlan>,
    output: ReturnType<typeof validateMutation>,
  ): MutationRun {
    const failing = nonEquivalentSurvivors(output.survivors);
    const triaged = boundedSurvivors(output.survivors);
    const run: MutationRun = {
      tool: plan.tool ?? output.tool,
      stack: plan.stack,
      mode: plan.mode,
      scopeSupport: plan.scopeSupport,
      concurrencyApplied: plan.concurrencyApplied,
      scope: plan.scope,
      command: plan.command,
      survivors: triaged.survivors,
      failingSurvivors: failing.length,
      equivalentSurvivors: output.survivors.length - failing.length,
      summary: output.summary,
      ranAt: now(),
      ...(output.mutationScore !== undefined ? { mutationScore: output.mutationScore } : {}),
      ...(triaged.truncated ? { truncated: true } : {}),
    };
    state.mutation = { ...(state.mutation ?? {}), run };
    return run;
  }

  private async runMutation(
    state: NormalizedChangeState,
    workspace: string,
    parentId: string,
    name: string,
  ): Promise<string> {
    const decision = state.mutation?.decision;
    if (!decision) throw new Error(`No mutation decision recorded for ${name}`);
    const environment = await inspectMutationEnvironment(workspace);
    const plan = buildMutationPlan(environment, {
      mode: decision.mode,
      changedPaths: decision.mode === "full" ? [] : this.changeScope(state),
    });
    if (!plan.available) return this.persistUnavailableRun(state, workspace, name, plan);
    const output = validateMutation(
      await this.delegate(
        "mutationist",
        parentId,
        workspace,
        `Mutate ${name}`,
        this.mutationPrompt(name, state, plan),
      ),
    );
    const run = this.recordMutationRun(state, plan, output);
    await writeArtifact(workspace, name, "mutation.md", renderMutation(run));
    const failing = nonEquivalentSurvivors(output.survivors);
    if (!failing.length) {
      if (state.mutation) delete state.mutation.targeted;
      state.phase = "archive";
      state.updatedAt = now();
      await writeState(workspace, state);
      return `Mutation testing passed for ${name} (${run.equivalentSurvivors} equivalent survivor(s) excluded). Next: /wayfinder:close ${name}`;
    }
    const files = this.safeFiles(failing.map(({ file }) => file));
    return this.scheduleMutationRemediation(state, workspace, name, {
      files,
      requirementIds: this.targetRequirements(state, files),
      count: failing.length,
      goal: `Kill ${failing.length} non-equivalent mutant(s) by strengthening tests only; do not change production behavior to satisfy the mutation tool.`,
      command: plan.command,
    });
  }

  private async targetedReVerification(
    state: NormalizedChangeState,
    workspace: string,
    parentId: string,
    name: string,
  ): Promise<string> {
    const target = state.mutation?.targeted;
    if (!target) throw new Error(`No targeted mutation scope recorded for ${name}`);
    const environment = await inspectMutationEnvironment(workspace);
    const plan = buildMutationPlan(environment, { mode: "changed", changedPaths: target.files });
    if (!plan.available) return this.persistUnavailableRun(state, workspace, name, plan);
    const output = validateMutation(
      await this.delegate(
        "mutationist",
        parentId,
        workspace,
        `Re-mutate ${name}`,
        this.mutationPrompt(name, state, plan),
      ),
    );
    const run = this.recordMutationRun(state, plan, output);
    await writeArtifact(workspace, name, "mutation.md", renderMutation(run));
    const failing = nonEquivalentSurvivors(output.survivors);
    if (failing.length) {
      const files = this.safeFiles(failing.map(({ file }) => file));
      return this.scheduleMutationRemediation(state, workspace, name, {
        files,
        requirementIds: this.targetRequirements(state, files),
        count: failing.length,
        goal: `Kill ${failing.length} remaining non-equivalent mutant(s) in the targeted scope by strengthening tests only.`,
        command: plan.command,
      });
    }
    const specification = await readArtifact(workspace, name, "specification.md");
    const progress = await optionalArtifact(workspace, name, "progress.md");
    const recheck = validateTargetedVerification(
      await this.delegate(
        "verifier",
        parentId,
        workspace,
        `Re-verify ${name} (mutation remediation)`,
        `Change: ${name}\nIntent: ${state.intent}\n\nSpecification:\n${specification}${progress ? `\n\nImplementation self-report (context only; inspect current files):\n${progress}` : ""}\n\nAfter test strengthening, verify ONLY these requirement ids: ${target.requirementIds.join(", ")}. Cover exactly those ids and no others.\n\nReturn only:\n${schemas.verification}`,
      ),
      new Set(target.requirementIds),
    );
    await writeArtifact(workspace, name, "verification-targeted.md", renderVerification(recheck));
    if (!recheck.passed) {
      const failed = recheck.requirements
        .filter(({ status }) => status === "failed")
        .map(({ id }) => id);
      return this.scheduleMutationRemediation(state, workspace, name, {
        files: target.files,
        requirementIds: failed.length ? failed : target.requirementIds,
        count: failed.length || 1,
        goal: `Address failed targeted verification (${failed.join(", ") || "remaining"}) by strengthening tests only.`,
        command: plan.command,
      });
    }
    state.verification = {
      passed: true,
      summary: recheck.summary,
      blockers: [],
      checkedAt: now(),
    };
    if (state.mutation) delete state.mutation.targeted;
    state.phase = "archive";
    state.updatedAt = now();
    await writeState(workspace, state);
    return `Targeted mutation and verification passed for ${name}. Next: /wayfinder:close ${name}`;
  }

  private async requestMutationDecision(
    state: NormalizedChangeState,
    workspace: string,
    parentId: string,
    name: string,
  ): Promise<string> {
    const environment = await inspectMutationEnvironment(workspace);
    const plan = buildMutationPlan(environment, {
      mode: "changed",
      changedPaths: this.changeScope(state),
    });
    const concurrency = plan.concurrencyApplied
      ? String(plan.concurrency)
      : "not applied (tool does not support it)";
    const recommendation = plan.available
      ? `Run ${plan.tool} (${plan.stack}, mode ${plan.mode}, concurrency ${concurrency}, at most ${plan.survivorLimit} survivors reported)`
      : `No tooling available: ${plan.reason}`;
    if (!this.api.ui.interactive()) {
      return `Mutation testing decision required for ${name} before archive. Recommendation: ${recommendation}. Record it with /wayfinder:mutate ${name} run -- <reason> or /wayfinder:mutate ${name} skip -- <reason>`;
    }
    const result = await this.api.ui.askQuestions({
      label: "Wayfinder mutation testing",
      questions: [
        {
          id: "mutation",
          header: "Mutation testing",
          question: `Run mutation testing for ${name} before archive?`,
          options: [
            {
              value: "run",
              label: "Run mutation testing",
              description: recommendation,
              recommended: plan.available,
            },
            { value: "skip", label: "Skip for this change" },
          ],
        },
      ],
    });
    const choice = result.mutation;
    if (choice !== "run" && choice !== "skip") {
      return `Mutation testing decision required for ${name}. Record it with /wayfinder:mutate ${name} run -- <reason> or /wayfinder:mutate ${name} skip -- <reason>`;
    }
    return this.recordMutationDecision(state, workspace, parentId, name, {
      decision: choice,
      mode: "changed",
      reason: plan.available
        ? `Recommended ${plan.tool} for ${plan.stack}`
        : `No tooling available: ${plan.reason}`,
      source: "recommended",
      execute: true,
    });
  }

  private async recordMutationDecision(
    state: NormalizedChangeState,
    workspace: string,
    parentId: string,
    name: string,
    input: {
      decision: MutationDecisionValue;
      mode: MutationScopeMode;
      reason: string;
      source: "recommended" | "manual";
      execute: boolean;
    },
  ): Promise<string> {
    if (state.mutation?.decision) {
      throw new Error(`Mutation decision already recorded for ${name}; it is immutable`);
    }
    const environment = await inspectMutationEnvironment(workspace);
    state.mutation = {
      ...(state.mutation ?? {}),
      decision: {
        decision: input.decision,
        mode: input.mode,
        reason: input.reason,
        decidedAt: now(),
        stack: environment.stack,
        source: input.source,
        ...(environment.tool ? { tool: environment.tool.name } : {}),
      },
    };
    state.updatedAt = now();
    await writeState(workspace, state);
    if (input.decision === "skip") {
      if (state.verification?.passed) {
        state.phase = "archive";
        state.updatedAt = now();
        await writeState(workspace, state);
        return `Recorded skip decision for ${name}. Verification already passed; advanced to archive. Next: /wayfinder:close ${name}`;
      }
      return `Recorded skip decision for ${name}. Complete verification with /wayfinder:verify ${name}`;
    }
    if (input.execute) return this.runMutation(state, workspace, parentId, name);
    return `Recorded run decision (mode ${input.mode}) for ${name}. Next: /wayfinder:verify ${name}`;
  }

  async mutate(args: string, sessionId?: string): Promise<string> {
    const { parentId, workspace } = this.workspace(sessionId);
    const usage = "Usage: /wayfinder:mutate <change> <run|skip> [--mode changed|full] -- <reason>";
    const delimiter = args.indexOf(" -- ");
    if (delimiter < 0) throw new Error(usage);
    const head = args.slice(0, delimiter).trim();
    const reason = args.slice(delimiter + 4).trim();
    if (!head || !reason) throw new Error(usage);
    const parts = head.split(/\s+/);
    const name = validateChangeName(parts[0] ?? "");
    const action = parts[1];
    if (action !== "run" && action !== "skip") throw new Error(usage);
    let mode: MutationScopeMode = "changed";
    for (let index = 2; index < parts.length; index += 1) {
      const candidate = parts[index + 1];
      if (parts[index] === "--mode" && (candidate === "changed" || candidate === "full")) {
        mode = candidate;
        index += 1;
      } else {
        throw new Error(usage);
      }
    }
    const state = await readState(workspace, name);
    return this.recordMutationDecision(state, workspace, parentId, name, {
      decision: action,
      mode,
      reason,
      source: "manual",
      execute: false,
    });
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

    if (state.mutation?.targeted) {
      return this.targetedReVerification(state, workspace, parentId, name);
    }

    if (state.verification?.passed !== true) {
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
      if (!output.passed) {
        return this.scheduleVerificationRemediation(state, workspace, name, output);
      }
      state.updatedAt = now();
      await writeState(workspace, state);
    }

    const decision = state.mutation?.decision;
    if (!decision) return this.requestMutationDecision(state, workspace, parentId, name);
    if (decision.decision === "skip") {
      state.phase = "archive";
      state.updatedAt = now();
      await writeState(workspace, state);
      return `Verification passed and mutation testing was skipped for ${name} (${decision.reason}). Next: /wayfinder:close ${name}`;
    }
    return this.runMutation(state, workspace, parentId, name);
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
    if (!state.mutation?.decision) {
      throw new Error(
        `Cannot close ${name}: record a mutation decision with /wayfinder:mutate ${name} run|skip -- <reason>`,
      );
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
