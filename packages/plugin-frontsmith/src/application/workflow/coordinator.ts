import { canonicalJson } from "../../domain/canonical-json.js";
import type { RawConfig } from "../../domain/config/defaults.js";
import type { PlanEnvelope } from "../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import type { UiContractEnvelope } from "../../domain/envelopes/ui-contract.js";
import { compileGlob } from "../../domain/glob.js";
import { isFeatureId, isShippedRuleId, isWorkspaceRuleId, matchesId } from "../../domain/ids.js";
import {
  createFeatureState,
  type FeatureState,
  type GateId,
  gateIds,
  type Mode,
  modes,
} from "../../domain/state/feature-state.js";
import { isLevel, type Level, phasesForLevel } from "../../domain/state/levels.js";
import { NewerSchemaError } from "../../domain/state/migrations.js";
import { FeatureLockedError } from "../ports/feature-store.js";
import {
  type ApprovalTarget,
  applyApproval,
  applyRejection,
  approvalCommand,
  approvalToLeave,
  type RejectTarget,
} from "./approvals.js";
import {
  artifactDirOf,
  finishGate,
  type PhaseEnv,
  readJson,
  type UnitResult,
  type WorkflowDeps,
} from "./env.js";
import { FOREGROUND_COMMAND_LIMIT_MS } from "./jobs.js";
import { runAccept } from "./phases/accept.js";
import { runArchive } from "./phases/archive.js";
import { runBuild } from "./phases/build.js";
import { runContext } from "./phases/context.js";
import { evaluatePlanGate, planArchitecture, runPlan } from "./phases/plan.js";
import { runReview } from "./phases/review.js";
import { advance } from "./phases/shared.js";
import { runSpecify } from "./phases/specify.js";
import { runTestDesign } from "./phases/test-design.js";
import { runTokens } from "./phases/tokens.js";
import { referencesDir, runUiContract } from "./phases/ui-contract.js";
import { runValidate } from "./phases/validate.js";
import { tokensPhaseNeeded } from "./project.js";
import { prepareSource, snapshotName } from "./source-spec.js";
import { gateHolds, type NextAction, nextAction, openBlockingQuestions } from "./status.js";
import { buildCoordinatorView, type CoordinatorView } from "./view.js";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface NewFeatureInput {
  feature: string;
  /** Required unless `fromSpec` is given, which derives one. */
  intent?: string;
  level: Level;
  mode?: Mode;
  /** Workspace-relative `.md`, `.markdown` or `.json` specification file (`--from-spec`). */
  fromSpec?: string;
}

export interface RunOptions {
  /** The session children hang from. */
  sessionId: string;
  /** Run the unit in the foreground even when it would normally start a job. */
  foreground?: boolean;
  signal?: AbortSignal;
  progress?: (line: string) => void;
}

/** Units that run no child: `fs_next` runs them inline (spec 7.5). */
const INLINE_UNITS = new Set(["intake", "context", "accept"]);

export interface JobFinishedEvent {
  feature: string;
  id: string;
  unit: string;
  /** The unit result kind (`advanced`, `waiting`, `blocked`, `closed`, `cancelled`), or `failed`. */
  outcome: string;
  next: NextAction;
}

export interface AdvanceOptions extends RunOptions {
  onJobFinished?: (event: JobFinishedEvent) => void;
}

export type AdvanceOutcome =
  | NextOutcome
  | { kind: "job"; id: string; unit: string }
  | { kind: "waiting-for-person"; next: NextAction };

export type NextOutcome =
  | { kind: "job-started"; id: string; unit: string }
  | { kind: "unit"; unit: string; result: UnitResult; next: NextAction };

/** Units that start a job unless `--foreground` is given (spec 7.5). */
const JOB_UNITS = new Set(["build", "validate", "review"]);

const MAX_TEXT = 4000;
const USAGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function newerSchema(error: unknown): never {
  if (error instanceof NewerSchemaError) throw new WorkflowError(error.message);
  throw error;
}

/** The state machine and the human-facing operations of the workflow (AD-3, AD-11, AD-12). */
export class WorkflowCoordinator {
  constructor(private readonly deps: WorkflowDeps) {}

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  /** Loads the feature; a newer schemaVersion opens read-only and every mutating call refuses. */
  async load(root: string, feature: string, options: { mutating: boolean }): Promise<FeatureState> {
    if (!isFeatureId(feature)) throw new WorkflowError(`Invalid feature id: ${feature}`);
    const opened = await this.deps.store.read(root, feature);
    if (!opened)
      throw new WorkflowError(`Unknown feature ${feature}. Create it with /frontsmith:new.`);
    if (opened.readOnly && options.mutating)
      throw new WorkflowError(
        `State written by a newer Frontsmith (schemaVersion ${opened.version}); upgrade the plugin`,
      );
    return opened.state;
  }

  async makeEnv(
    root: string,
    feature: string,
    options: { sessionId: string; signal?: AbortSignal; progress?: (line: string) => void },
  ): Promise<PhaseEnv> {
    const configResult = await this.deps.project.readConfig(root);
    if (configResult.diagnostics.length > 0)
      throw new WorkflowError(
        `The project configuration is invalid: ${configResult.diagnostics.map((d) => `${d.code} ${d.pointer || "/"}: ${d.message}`).join("; ")}`,
      );
    return {
      deps: this.deps,
      root,
      feature,
      parentSession: options.sessionId,
      signal: options.signal ?? new AbortController().signal,
      progress: options.progress ?? (() => undefined),
      evidenceDir: `.alisio/frontsmith/evidence/${feature}/${this.deps.newId()}`,
      config: configResult.config,
    };
  }

  // ---- init and creation ----

  /** `/frontsmith:init`: a minimal valid config, the gitignore entry and the protected baseline. */
  async init(root: string): Promise<{ created: string[]; existing: string[] }> {
    const created: string[] = [];
    const existing: string[] = [];
    const fs = this.deps.fsFor(root);
    const configPath = ".frontsmith/config.json";
    if (await fs.exists(configPath)) existing.push(configPath);
    else {
      const raw: RawConfig = { schemaVersion: 1 };
      await this.deps.writer.write(root, configPath, canonicalJson(raw));
      created.push(configPath);
    }
    const ignore = await this.deps.ignore(root, [".alisio/frontsmith/"]);
    if (ignore) created.push(".gitignore (.alisio/frontsmith/)");
    return { created, existing };
  }

  async newFeature(root: string, input: NewFeatureInput): Promise<FeatureState> {
    if (!isFeatureId(input.feature))
      throw new WorkflowError(
        `Invalid feature id ${JSON.stringify(input.feature)}: use lowercase letters, digits and dashes (max 48).`,
      );
    if (!isLevel(input.level)) throw new WorkflowError("Level must be L0, L1, L2 or L3.");
    const mode = input.mode ?? "build";
    if (!(modes as readonly string[]).includes(mode))
      throw new WorkflowError(`Mode must be one of ${modes.join(", ")}.`);
    if (await this.deps.store.read(root, input.feature))
      throw new WorkflowError(`Feature ${input.feature} already exists.`);
    const prepared =
      input.fromSpec === undefined
        ? undefined
        : await prepareSource(this.deps, root, input.fromSpec, input.level);
    if (prepared && !prepared.ok) throw new WorkflowError(prepared.message);
    const source = prepared?.ok ? prepared.source : undefined;
    const intent = (input.intent?.trim() || source?.intent || "").trim();
    if (intent === "" || intent.length > MAX_TEXT)
      throw new WorkflowError(
        `The intent must be between 1 and ${MAX_TEXT} characters (give one, or use --from-spec).`,
      );
    const state = createFeatureState({
      feature: input.feature,
      intent,
      level: input.level,
      mode,
      now: this.now(),
    });
    if (source) {
      const config = await this.deps.project.readConfig(root);
      const snapshot = `${artifactDirOf(config.config, input.feature)}/${snapshotName(source.format)}`;
      await this.deps.writer.write(root, snapshot, source.text);
      state.source = {
        path: source.path,
        format: source.format,
        sha256: source.sha256,
        bytes: source.bytes,
        snapshot,
        importedAt: this.now(),
      };
      state.artifacts["source-spec"] = {
        path: snapshot,
        sha256: source.sha256,
        writtenAt: this.now(),
      };
      state.protected[snapshot] = source.sha256;
    }
    await this.deps.store.create(root, state);
    return state;
  }

  // ---- reading ----

  async status(
    root: string,
    feature: string,
  ): Promise<{ state: FeatureState; next: NextAction; readOnly: boolean; running: boolean }> {
    const opened = await this.deps.store.read(root, feature);
    if (!opened) throw new WorkflowError(`Unknown feature ${feature}.`);
    const running = this.deps.jobs.isRunning(feature);
    return {
      state: opened.state,
      next: nextAction(opened.state, running),
      readOnly: opened.readOnly,
      running,
    };
  }

  /** The state the conversational coordinator reads (`fs_status`, `fs_approval_request`). */
  async view(root: string, feature: string): Promise<CoordinatorView> {
    const opened = await this.deps.store.read(root, feature);
    if (!opened) throw new WorkflowError(`Unknown feature ${feature}.`);
    return buildCoordinatorView(
      this.deps.fsFor(root),
      opened.state,
      this.deps.jobs.isRunning(feature),
    );
  }

  async list(root: string): Promise<FeatureState[]> {
    const out: FeatureState[] = [];
    for (const feature of await this.deps.store.list(root)) {
      const opened = await this.deps.store.read(root, feature).catch(() => undefined);
      if (opened) out.push(opened.state);
    }
    return out;
  }

  // ---- running units ----

  /** One unit for the current phase, with the blocked marker cleared and its result reported. */
  async runUnit(env: PhaseEnv): Promise<UnitResult> {
    const opened = await this.deps.store.read(env.root, env.feature);
    if (!opened) return { kind: "blocked", message: `Unknown feature ${env.feature}.` };
    if (opened.readOnly)
      return {
        kind: "blocked",
        message: `State written by a newer Frontsmith (schemaVersion ${opened.version}); upgrade the plugin`,
      };
    const state = opened.state;
    await this.deps.store.update(
      env.root,
      env.feature,
      (draft) => void delete draft.blocked,
      this.now(),
    );
    switch (state.phase) {
      case "intake": {
        await advance(env);
        return { kind: "advanced", message: "Feature created; context discovery runs next." };
      }
      case "context":
        return runContext(env);
      case "specify":
        return runSpecify(env);
      case "ui-contract":
        return runUiContract(env);
      case "tokens":
        return runTokens(env);
      case "plan":
        return runPlan(env);
      case "test-design":
        return runTestDesign(env);
      case "build":
        return runBuild(env);
      case "validate":
        return runValidate(env);
      case "review":
        return runReview(env);
      case "accept":
        return runAccept(env);
      case "archive":
        return runArchive(env);
      case "closed":
        return { kind: "closed", message: "The feature is closed." };
    }
  }

  /** `/frontsmith:next`: the next runnable unit, inline or as a job (spec 7.5). */
  async next(root: string, feature: string, options: RunOptions): Promise<NextOutcome> {
    const state = await this.load(root, feature, { mutating: true });
    const unit = state.phase;
    if (this.deps.jobs.isRunning(feature)) throw new FeatureLockedError(feature, process.pid);
    const env = await this.makeEnv(root, feature, options);
    if (JOB_UNITS.has(unit) && !options.foreground) {
      const { id } = await this.deps.jobs.start({
        root,
        feature,
        unit,
        onStop: () => this.deps.agents.runner.cancelAll(),
        run: async (signal) => {
          const result = await this.runUnit({ ...env, signal });
          return result.message;
        },
      });
      return { kind: "job-started", id, unit };
    }
    const result = await this.deps.jobs.runInline({
      root,
      feature,
      unit,
      run: () => this.runUnit(env),
    });
    const after = await this.load(root, feature, { mutating: false });
    return { kind: "unit", unit, result, next: nextAction(after) };
  }

  /**
   * `fs_next` (conversational coordinator): stops at every human gate without running anything,
   * runs deterministic units inline, and starts every unit that runs a child as a background job
   * with a completion hook, so the run clock of the calling session never limits it (AD-16).
   */
  async advance(root: string, feature: string, options: AdvanceOptions): Promise<AdvanceOutcome> {
    const state = await this.load(root, feature, { mutating: true });
    const running = this.deps.jobs.isRunning(feature);
    if (running) {
      const id = state.job?.id ?? "";
      return { kind: "job", id, unit: state.job?.unit ?? state.phase };
    }
    const next = nextAction(state);
    if (next.kind === "answer" || next.kind === "approve" || next.kind === "closed")
      return { kind: "waiting-for-person", next };
    const unit = state.phase;
    if (INLINE_UNITS.has(unit)) return this.next(root, feature, { ...options, foreground: true });
    const env = await this.makeEnv(root, feature, options);
    let last: UnitResult | undefined;
    let jobId = "";
    const { id } = await this.deps.jobs.start({
      root,
      feature,
      unit,
      onStop: () => this.deps.agents.runner.cancelAll(),
      run: async (signal) => {
        last = await this.runUnit({ ...env, signal });
        return last.message;
      },
      onFinish: async (result) => {
        if (!options.onJobFinished) return;
        const after = await this.load(root, feature, { mutating: false });
        options.onJobFinished({
          feature,
          id: jobId,
          unit,
          outcome: result.status === "completed" ? (last?.kind ?? "failed") : result.status,
          next: nextAction(after),
        });
      },
    });
    jobId = id;
    return { kind: "job-started", id, unit };
  }

  /** `fs_phase_run`: the same unit in the agent loop, with cancellation and progress (spec 7.5). */
  async runForeground(root: string, feature: string, options: RunOptions): Promise<NextOutcome> {
    return this.next(root, feature, { ...options, foreground: true });
  }

  async stop(root: string, feature: string): Promise<boolean> {
    await this.load(root, feature, { mutating: false });
    return this.deps.jobs.stop(feature);
  }

  /** `/frontsmith:resume`: interrupted attempts are marked, then the unit starts from its beginning. */
  async resume(
    root: string,
    feature: string,
    options: RunOptions,
  ): Promise<{ interrupted: number; outcome: NextOutcome }> {
    await this.load(root, feature, { mutating: true });
    if (this.deps.jobs.isRunning(feature)) throw new FeatureLockedError(feature, process.pid);
    const interrupted = await this.deps.store.recoverInterrupted(root, feature, this.now());
    return { interrupted, outcome: await this.next(root, feature, options) };
  }

  // ---- human decisions ----

  async answer(
    root: string,
    feature: string,
    questionId: string,
    text: string,
    options: { via?: "command" | "dialog" } = {},
  ): Promise<{ message: string }> {
    if (!matchesId("question", questionId))
      throw new WorkflowError(`Invalid question id ${questionId}; use Q-01.`);
    const answer = text.trim();
    if (answer === "" || answer.length > MAX_TEXT)
      throw new WorkflowError(`The answer must be between 1 and ${MAX_TEXT} characters.`);
    const state = await this.load(root, feature, { mutating: true });
    const question = state.questions.find((q) => q.id === questionId);
    if (!question) throw new WorkflowError(`${feature} has no question ${questionId}.`);
    let regenerate = false;
    let unblocked: string | undefined;
    await this.deps.store
      .update(
        root,
        feature,
        (draft) => {
          const q = draft.questions.find((x) => x.id === questionId);
          if (!q) return;
          q.answer = answer;
          q.answeredAt = this.now();
          q.answeredVia = options.via ?? "command";
          const open = openBlockingQuestions(draft);
          if (open.length > 0) return;
          if (draft.phase === "specify" && draft.artifacts["spec-json"]) {
            // The spec is rewritten with the answers; the gate is evaluated again on the new one.
            delete draft.artifacts["spec-json"];
            delete draft.gates.G1;
            regenerate = true;
          }
          if (draft.blocked?.task) {
            const task = draft.tasks.find((t) => t.id === draft.blocked?.task);
            if (task) task.status = "pending";
            unblocked = draft.blocked.task;
            delete draft.blocked;
          }
        },
        this.now(),
      )
      .catch(newerSchema);
    return {
      message: regenerate
        ? `Recorded ${questionId}. All blocking questions are answered: the specifier will rewrite the spec on the next unit.`
        : unblocked
          ? `Recorded ${questionId}. ${unblocked} can run again.`
          : `Recorded ${questionId}.`,
    };
  }

  private async approvalHashes(
    env: PhaseEnv,
    state: FeatureState,
    target: ApprovalTarget,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    const artifact = (kind: "spec-json" | "ui-contract" | "plan-json"): void => {
      const entry = state.artifacts[kind];
      if (entry) hashes[entry.path] = entry.sha256;
    };
    if (target === "spec") artifact("spec-json");
    if (target === "plan") artifact("plan-json");
    if (target === "ui-contract") {
      artifact("ui-contract");
      const base = referencesDir(env.feature);
      const tree = await this.deps.integrity.digestTree(env.root, base);
      const fixtures = await this.deps.integrity.digestTree(
        env.root,
        `.frontsmith/fixtures/${env.feature}`,
      );
      for (const [path, digest] of Object.entries({ ...tree, ...fixtures }))
        hashes[path] = digest.split(":").pop() ?? digest;
    }
    return hashes;
  }

  /** `/frontsmith:approve`: records a human approval, hashes the approved oracles and moves the feature on. */
  async approve(
    root: string,
    feature: string,
    target: ApprovalTarget,
    options: { name?: string; note?: string; sessionId?: string } = {},
  ): Promise<{ message: string; next: NextAction }> {
    const state = await this.load(root, feature, { mutating: true });
    const env = await this.makeEnv(root, feature, { sessionId: options.sessionId ?? "" });
    if (target === "dependency") {
      const name = options.name ?? "";
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214)
        throw new WorkflowError(
          "Usage: /frontsmith:approve <feature> dependency <npm package name>",
        );
      await this.deps.store.update(
        root,
        feature,
        (d) =>
          applyApproval(d, "dependency", {
            now: this.now(),
            name,
            ...(options.note ? { note: options.note } : {}),
          }),
        this.now(),
      );
      return {
        message: `Approved dependency ${name}.`,
        next: nextAction(await this.load(root, feature, { mutating: false })),
      };
    }
    if (target === "config") {
      await this.deps.store.update(
        root,
        feature,
        (d) => {
          if (d.blocked?.task) {
            const task = d.tasks.find((t) => t.id === d.blocked?.task);
            if (task) {
              task.status = "pending";
              task.bounces = 0;
            }
          }
          delete d.blocked;
        },
        this.now(),
      );
      return {
        message:
          "Accepted the current .frontsmith files as the new baseline; blocked tasks can run again.",
        next: nextAction(await this.load(root, feature, { mutating: false })),
      };
    }
    const owed = approvalToLeave(state, state.phase);
    if (owed !== target)
      throw new WorkflowError(
        owed
          ? `${feature} is in ${state.phase}: the approval it needs is ${owed} (${approvalCommand(feature, owed)}).`
          : `Nothing to approve: ${feature} is in phase ${state.phase}.`,
      );
    if (!gateHolds(state, state.phase))
      throw new WorkflowError(
        `The ${state.phase} gate has not passed yet; run /frontsmith:next ${feature} first.`,
      );
    const hashes = await this.approvalHashes(env, state, target);
    let dependencies: string[] = [];
    if (target === "plan") {
      const plan = await readJson<PlanEnvelope>(env, state.artifacts["plan-json"]?.path);
      dependencies = plan?.dependencies.map((d) => d.name) ?? [];
      const architecture = plan ? await planArchitecture(env, plan) : undefined;
      if (architecture?.config && !architecture.present)
        await this.deps.architecture.activate(root, architecture.config);
    }
    await this.deps.store.update(
      root,
      feature,
      (d) => {
        applyApproval(d, target, {
          now: this.now(),
          hashes,
          ...(options.note ? { note: options.note } : {}),
        });
        for (const name of dependencies) applyApproval(d, "dependency", { now: this.now(), name });
      },
      this.now(),
    );
    if (target === "plan") {
      const plan = await readJson<PlanEnvelope>(env, state.artifacts["plan-json"]?.path);
      const spec = await readJson<SpecEnvelope>(env, state.artifacts["spec-json"]?.path);
      if (plan && spec) {
        const report = await finishGate(env, "G3", await evaluatePlanGate(env, plan, spec));
        if (report.verdict === "FAIL" || report.verdict === "BLOCKED")
          throw new WorkflowError(
            `The plan no longer passes G3 (${report.verdict}); run /frontsmith:next ${feature}.`,
          );
      }
    }
    let tokensNeeded = false;
    if (target === "ui-contract") {
      const contract = await readJson<UiContractEnvelope>(
        env,
        state.artifacts["ui-contract"]?.path,
      );
      tokensNeeded = contract ? await tokensPhaseNeeded(env, contract) : false;
    }
    await advance({ ...env }, { tokensNeeded });
    const after = await this.load(root, feature, { mutating: false });
    return { message: `Approved ${target}. Next phase: ${after.phase}.`, next: nextAction(after) };
  }

  /** `/frontsmith:reject`: back to the producing phase with the comments for its next prompt. */
  async reject(
    root: string,
    feature: string,
    target: RejectTarget,
    comments: string,
  ): Promise<{ message: string; next: NextAction }> {
    const text = comments.trim();
    if (text === "")
      throw new WorkflowError(
        "Usage: /frontsmith:reject <feature> <spec|ui-contract|plan|acceptance> -- <comments>",
      );
    const state = await this.load(root, feature, { mutating: true });
    let phase = state.phase;
    await this.deps.store.update(
      root,
      feature,
      (d) => {
        phase = applyRejection(d, target, text);
        if (target === "spec") {
          delete d.artifacts["spec-json"];
          delete d.artifacts.spec;
          d.questions = d.questions.filter((q) => q.answer);
        }
        if (target === "ui-contract") {
          delete d.artifacts["ui-contract"];
          delete d.artifacts.ui;
        }
        if (target === "plan") {
          delete d.artifacts["plan-json"];
          delete d.artifacts.plan;
          delete d.artifacts.tasks;
          d.tasks = [];
          delete d.taskContracts;
        }
        if (target === "acceptance") {
          const max = Math.max(0, ...d.tasks.map((t) => Number(t.id.slice(2))));
          const id = `T-${String(max + 1).padStart(3, "0")}`;
          d.tasks.push({
            id,
            layer: "ui",
            status: "pending",
            bounces: 0,
            changedPaths: [],
            origin: "remediation",
          });
          d.taskContracts = {
            ...(d.taskContracts ?? {}),
            [id]: {
              id,
              title: "Address the acceptance feedback",
              goal: `Address this feedback from the person who rejected acceptance: ${text}`,
              layer: "ui",
              files: [],
              acceptanceCriteria: [],
              tests: [],
              validation: ["typecheck", "lint", "testRelated"],
              constraints: ["Change only what the feedback needs."],
              dependsOn: [],
              stopConditions: ["The feedback contradicts the approved spec."],
              tdd: "exempt",
              tddExemptReason: "acceptance feedback",
              findings: [text],
            },
          };
          delete d.artifacts.validation;
          delete d.gates.G7;
          delete d.gates.G8;
          delete d.gates.G9;
        }
      },
      this.now(),
    );
    const after = await this.load(root, feature, { mutating: false });
    return {
      message: `Rejected ${target}; ${feature} returns to ${phase}. The comments go into the next prompt.`,
      next: nextAction(after),
    };
  }

  /** `/frontsmith:waive`: a human waiver in `.frontsmith/waivers.json` (spec 13.5). */
  async waive(
    root: string,
    feature: string,
    input: { ruleId: string; glob: string; until: string; reason: string },
  ): Promise<{ id: string }> {
    await this.load(root, feature, { mutating: true });
    if (!isShippedRuleId(input.ruleId) && !isWorkspaceRuleId(input.ruleId))
      throw new WorkflowError(`${JSON.stringify(input.ruleId)} is not a rule id.`);
    try {
      compileGlob(input.glob);
    } catch {
      throw new WorkflowError(`${JSON.stringify(input.glob)} is not a valid glob.`);
    }
    if (input.glob.startsWith("/") || input.glob.includes(".."))
      throw new WorkflowError("The glob must be workspace-relative.");
    if (!USAGE_DATE.test(input.until)) throw new WorkflowError("Usage: --until <YYYY-MM-DD>");
    const today = this.now().slice(0, 10);
    if (input.until < today) throw new WorkflowError(`--until ${input.until} is in the past.`);
    const reason = input.reason.trim();
    if (reason === "" || reason.length > 1000)
      throw new WorkflowError("A reason of 1 to 1000 characters is required (after --).");
    const existing = await this.deps.project.readWaivers(root);
    if (existing.errors.length > 0)
      throw new WorkflowError(
        `.frontsmith/waivers.json is invalid: ${existing.errors[0]?.message}. Fix it by hand first.`,
      );
    const max = Math.max(0, ...existing.waivers.map((w) => Number(w.id.slice(2))));
    const id = `W-${String(max + 1).padStart(3, "0")}`;
    const waivers = [
      ...existing.waivers,
      {
        id,
        ruleId: input.ruleId,
        paths: [input.glob],
        reason,
        approvedBy: "human" as const,
        createdAt: this.now(),
        expires: input.until,
      },
    ];
    await this.deps.writer.write(
      root,
      ".frontsmith/waivers.json",
      canonicalJson({ schemaVersion: 1, waivers }),
    );
    return { id };
  }

  /** `/frontsmith:verify-manual`: manual evidence for one acceptance criterion (spec 7.4). */
  async verifyManual(
    root: string,
    feature: string,
    acId: string,
    evidence: string,
  ): Promise<{ message: string }> {
    if (!matchesId("acceptance", acId))
      throw new WorkflowError("Usage: /frontsmith:verify-manual <feature> <AC-id> -- <evidence>");
    const text = evidence.trim();
    if (text === "" || text.length > MAX_TEXT)
      throw new WorkflowError(`The evidence must be between 1 and ${MAX_TEXT} characters.`);
    const state = await this.load(root, feature, { mutating: true });
    const env = await this.makeEnv(root, feature, { sessionId: "" });
    const spec = await readJson<SpecEnvelope>(env, state.artifacts["spec-json"]?.path);
    if (!spec?.acceptanceCriteria.some((ac) => ac.id === acId))
      throw new WorkflowError(`${feature} has no acceptance criterion ${acId}.`);
    await this.deps.store.update(
      root,
      feature,
      (d) => {
        d.manualVerifications = {
          ...(d.manualVerifications ?? {}),
          [acId]: { at: this.now(), evidence: text },
        };
      },
      this.now(),
    );
    return { message: `Recorded manual verification of ${acId}.` };
  }

  /** Artifact directory of a feature, for status output. */
  artifactDir(state: FeatureState, artifacts = "docs/frontsmith"): string {
    return `${artifacts.replace(/\/$/, "")}/${state.feature}`;
  }

  phasesOf(state: FeatureState): string[] {
    return phasesForLevel(state.level, {
      tokensNeeded: state.phase === "tokens" || state.artifacts.tokens !== undefined,
    });
  }

  static readonly foregroundLimitMs = FOREGROUND_COMMAND_LIMIT_MS;
  static readonly gateIds: readonly GateId[] = gateIds;
}
