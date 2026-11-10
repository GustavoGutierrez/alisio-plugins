// The actions' real logic, testable without a host: projects, chat thread, proposals and review,
// jobs with visible stages, the live preview, the automatic fix-up pass and exports.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AvailableProviderModel,
  ChildRunResult,
  ChildSessionInfo,
  ChildSessionSpec,
  PluginAppContext,
  ResolvedProviderModel,
} from "@alisio/sdk";
import { Draft, type DraftState, type ToolResult } from "./draft.js";
import { errorCode, LumbreError, type LumbreErrorCode } from "./errors.js";
import {
  agentContinuePrompt,
  agentFixPrompt,
  agentPrompt,
  batchPrompt,
  budget,
  buildPrompt,
  type ChatMessage,
  continuePrompt,
  type Ignored,
  looksLikeBlocks,
  validateOutput,
} from "./generate.js";
import type { InstructionMode } from "./instructions.js";
import {
  classifyFailure,
  type FailureCategory,
  mergeOutputs,
  planBatches,
  type RawOutput,
  readOutput,
} from "./output.js";
import {
  allowlistFor,
  isStackId,
  nodeAtLeast,
  ownedFiles,
  packageJson,
  presetLock,
  STACK_IDS,
  type Stack,
  type StackId,
  stack,
} from "./presets.js";
import { type ProjectRuntime, type RuntimeOptions, reapOrphans } from "./runtime.js";
import { exportFolder, type Files, filePath, isManagedPath, LIMITS, text } from "./safety.js";
import { buildSnapshot, type Snapshot, sourceSnapshot } from "./snapshot.js";
import { isId, type ProjectMeta, ProjectStore } from "./store.js";
import { type AgentToolName, allowedTools } from "./tools.js";
import { VERSION } from "./version.js";
import { syncWork } from "./workdir.js";
import { zip } from "./zip.js";

export const MIN_HOST = "0.11.6";
export const MAX_FIX_ATTEMPTS = 2;
export const MAX_CONTINUATIONS = 3;
export const MAX_AUTO_CONTINUES = 2;
export const MAX_AGENT_FIXES = 2;
export const AGENT_MAX_TURNS = 40;
const AGENT_RUN_TIMEOUT_MS = 15 * 60_000;
const AGENT_JOB_CAP_MS = 45 * 60_000;
/** The host's own output limit when a child sets none (`DEFAULT_MAX_OUTPUT_TOKENS`). */
const HOST_DEFAULT_OUTPUT = 16_384;
const MAX_JOBS = 3;
const MAX_SERVERS = 3;
const MAX_CHAT = 200;

export type RuntimeLike = Pick<
  ProjectRuntime,
  | "running"
  | "snapshot"
  | "log"
  | "touch"
  | "idleCheck"
  | "install"
  | "build"
  | "start"
  | "stop"
  | "probe"
  | "reload"
  | "killSync"
>;

export interface ServiceDeps {
  /** The workspace this service serves (agent tools find their service by it). */
  workspace?: string;
  /** Lumbre's private state for this workspace. */
  root: string;
  cacheDir: string;
  models?: {
    list(signal?: AbortSignal): Promise<AvailableProviderModel[]>;
    resolve(reference: string, signal?: AbortSignal): Promise<ResolvedProviderModel>;
  };
  sessions: {
    create(spec: ChildSessionSpec): Promise<ChildSessionInfo>;
    run(id: string, prompt: string, options?: { signal?: AbortSignal }): Promise<ChildRunResult>;
    cancel(id: string): number;
    model?(id: string): string;
  };
  /** Child-session instructions (the packaged agent and skills) for a normal or a fix-up pass. */
  instructions(mode: InstructionMode, stack: StackId): Promise<string>;
  npmCli(): string;
  runtime(options: RuntimeOptions): RuntimeLike;
  openUrl(url: string): Promise<void>;
  idleMs?: number;
}

type JobKind = "generate" | "check" | "install" | "start" | "agent" | "agentCheck";
type JobState = "running" | "done" | "failed" | "cancelled";
interface Step {
  key: string;
  args?: Record<string, string | number>;
  at: number;
}
interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  state: JobState;
  stage: Step;
  steps: Step[];
  progress: number | null;
  startedAt: number;
  endedAt: number | null;
  error: LumbreErrorCode | null;
  result: Record<string, unknown> | null;
  log: string;
  diagnostics: Diagnostics | null;
  /** Agent jobs: the live draft (its timeline and counts are shown while the job runs). */
  draft?: Draft | undefined;
}

export type AgentPhase =
  | "running"
  | "needs_check"
  | "checking"
  | "fixing"
  | "paused"
  | "planned"
  | "failed";
/** The persisted agent state of a project (`agent.json`): one draft at a time. */
interface AgentState {
  phase: AgentPhase;
  mode: "plan" | "build";
  childId: string | null;
  request: string;
  locale: "en" | "es";
  autoContinues: number;
  fixRounds: number;
  checkFailed: boolean;
  pausedReason: "turns" | "cancelled" | "failed" | null;
  draft: DraftState;
  startedAt: number;
}

/** Per-job generation facts for the "Details" panel: numbers and categories, never content. */
export interface Diagnostics {
  /** `agent`: tool loop; `blocks`: the 0.1.1 answer format (models without tool calling). */
  mode: "agent" | "blocks";
  model: string | null;
  contextWindow: number;
  contextSource: "provider" | "estimated";
  outputBudget: number;
  outputSource: "provider" | "estimated";
  usageInput: number;
  usageOutput: number;
  planned: boolean;
  batches: number;
  continuations: number;
  retriedWithoutLimit: boolean;
  runs: number;
  toolCalls: number;
  fixRounds: number;
  reason: string | null;
}

/** A child run that failed for a reason other than the output limit. */
class TurnFailure extends Error {
  constructor(readonly category: FailureCategory) {
    super(category);
  }
}

interface Proposal {
  id: string;
  base: string;
  createdAt: number;
  summary: string;
  message: string;
  files: Files;
  deletes: string[];
  dependencies: Record<string, string>;
  ignored: Ignored[];
  fixAttempt: number;
  /** Set when the model stopped before finishing: what arrived and what is missing. */
  partial?: { received: number; missing: string[] };
  /** Agent mode: the draft still failed to build after the automatic fixes. */
  checkFailed?: boolean;
}

type Input = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const slug = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "lumbre-site";

export class Service {
  readonly store: ProjectStore;
  private runtimes = new Map<string, RuntimeLike>();
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private locks = new Map<string, Promise<unknown>>();
  private heads = new Map<string, Files>();
  private fixChain = new Map<string, number>();
  private retries = new Map<string, { hash: string; result: Promise<unknown> }>();
  /** Child session id -> the agent job it works for (only while a run executes). */
  private agentRuns = new Map<
    string,
    { projectId: string; mode: "plan" | "build"; draft: Draft; job: Job }
  >();
  /** Models seen answering without tools this activation: they use the 0.1.1 block path. */
  private noTools = new Set<string>();
  private idleTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  get workspace() {
    return this.deps.workspace;
  }

  constructor(readonly deps: ServiceDeps) {
    this.store = new ProjectStore(deps.root);
  }

  async init() {
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const { projects, damaged } = await this.store.load();
    // Dev servers left behind by an abrupt exit of a previous activation.
    await Promise.all(
      [...projects.map((p) => p.id), ...damaged].map((id) =>
        reapOrphans(this.store.dir(id)).catch(() => []),
      ),
    );
    this.idleTimer = setInterval(() => void this.idleSweep(), 30_000);
    this.idleTimer.unref?.();
    return this;
  }

  /** Background work keeps the workspace from idle eviction; an idle preview stops by itself. */
  busy() {
    return (
      [...this.jobs.values()].some((j) => j.state === "running") ||
      [...this.runtimes.values()].some((r) => r.running)
    );
  }

  async idleSweep(now = Date.now()) {
    for (const r of this.runtimes.values()) await r.idleCheck(now).catch(() => false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const c of this.controllers.values()) c.abort();
    for (const r of this.runtimes.values()) r.killSync();
  }

  // ---------- plumbing ----------

  private stackOf(m: ProjectMeta): Stack {
    return stack(m.stack, m.tailwind);
  }

  private runtime(m: ProjectMeta): RuntimeLike {
    let r = this.runtimes.get(m.id);
    if (!r) {
      r = this.deps.runtime({
        dir: this.store.dir(m.id),
        stack: this.stackOf(m),
        npmCli: this.deps.npmCli(),
        cacheDir: this.deps.cacheDir,
        ...(this.deps.idleMs ? { idleMs: this.deps.idleMs } : {}),
      });
      this.runtimes.set(m.id, r);
    }
    return r;
  }

  /** Serializes mutations of one project. */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  private async head(m: ProjectMeta): Promise<Files> {
    const cached = this.heads.get(m.id);
    if (cached) return cached;
    const files = await this.store.files(m.id, m.head);
    this.heads.set(m.id, files);
    return files;
  }

  /** Lumbre-owned files: preset configuration, package.json and the lockfile. */
  private async owned(m: ProjectMeta): Promise<Files> {
    const s = this.stackOf(m);
    const files: Files = ownedFiles(s, m.extras);
    if (!s.npm) return files;
    files["package.json"] = packageJson(s, m.extras);
    const custom = await this.store.readJson<{ content?: string; extras?: string } | null>(
      m.id,
      "lock",
      null,
    );
    const extrasKey = JSON.stringify(m.extras);
    files["package-lock.json"] =
      Object.keys(m.extras).length && custom?.content && custom.extras === extrasKey
        ? custom.content
        : await presetLock(s);
    return files;
  }

  private async sync(m: ProjectMeta, verify = false) {
    const result = await syncWork(
      this.store.dir(m.id),
      { ...(await this.head(m)), ...(await this.owned(m)) },
      { verify },
    );
    const r = this.runtimes.get(m.id);
    if (r?.running && (result.written.length || result.deleted.length)) r.reload();
    return result;
  }

  private async commit(
    m: ProjectMeta,
    files: Files,
    summary: string,
    kind: "proposal" | "fix" | "manual" | "restore",
  ) {
    await this.store.commit(m.id, files, { summary, kind });
    this.heads.set(m.id, files);
    const fresh = this.store.require(m.id);
    await this.sync(fresh);
    return fresh;
  }

  private async chat(id: string) {
    return this.store.readJson<ChatMessage[]>(id, "chat", []);
  }
  private async say(id: string, message: Omit<ChatMessage, "id" | "at">) {
    const chat = await this.chat(id);
    const entry = { id: randomUUID(), at: Date.now(), ...message } as ChatMessage;
    chat.push(entry);
    await this.store.writeJson(id, "chat", chat.slice(-MAX_CHAT));
    return entry;
  }

  private async proposal(id: string) {
    return this.store.readJson<Proposal | null>(id, "proposal", null);
  }

  private activeJob(id: string) {
    return [...this.jobs.values()].find((j) => j.projectId === id && j.state === "running");
  }

  private async view(m: ProjectMeta) {
    const s = this.stackOf(m);
    const head = await this.head(m);
    const owned = await this.owned(m);
    const p = await this.proposal(m.id);
    const r = this.runtimes.get(m.id);
    const server = r
      ? { ...r.snapshot(), logs: undefined }
      : { state: "stopped", url: null, port: null, startedAt: null, stoppedReason: null };
    return {
      id: m.id,
      title: m.title,
      stack: m.stack,
      tailwind: m.tailwind,
      model: m.model,
      archived: m.archived,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      head: m.head,
      revisions: [...m.revisions].reverse(),
      extras: m.extras,
      files: [
        ...Object.keys(head).map((path) => ({ path, owned: false })),
        ...Object.keys(owned).map((path) => ({ path, owned: true })),
      ].sort((a, b) => a.path.localeCompare(b.path)),
      needsBuild: !!(s.build || s.css),
      proposal:
        p && p.base === m.head ? { id: p.id, summary: p.summary, fixAttempt: p.fixAttempt } : null,
      server,
      job: this.activeJob(m.id)?.id ?? null,
      chat: await this.chat(m.id),
      agent: await this.agentView(m.id),
    };
  }

  private async agentView(id: string) {
    const st = await this.agentState(id);
    if (!st) return null;
    return {
      phase: st.phase,
      mode: st.mode,
      pausedReason: st.pausedReason,
      autoContinues: st.autoContinues,
      fixRounds: st.fixRounds,
      counts: st.draft.counts,
      changed: Object.keys(st.draft.changes).length,
      timeline: st.draft.timeline.slice(-60),
    };
  }

  private summary(m: ProjectMeta) {
    return {
      id: m.id,
      title: m.title,
      stack: m.stack,
      tailwind: m.tailwind,
      archived: m.archived,
      updatedAt: m.updatedAt,
      running: this.runtimes.get(m.id)?.running ?? false,
      damaged: false,
    };
  }

  // ---------- entry ----------

  async invoke(action: string, input: Input, ctx: PluginAppContext): Promise<unknown> {
    if (this.disposed) throw new LumbreError("unavailable");
    ctx.signal.throwIfAborted();
    if (!ctx.idempotencyKey) return this.dispatch(action, input, ctx);
    const key = `${ctx.sessionId}:${ctx.idempotencyKey}`;
    const hash = sha(JSON.stringify({ action, input }));
    const previous = this.retries.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new LumbreError("conflict");
      return previous.result;
    }
    const result = this.dispatch(action, input, ctx);
    this.retries.set(key, { hash, result });
    // A failed call may be retried with the same key.
    result.catch(() => this.retries.delete(key));
    if (this.retries.size > 300) this.retries.delete(this.retries.keys().next().value as string);
    return result;
  }

  private async dispatch(action: string, input: Input, ctx: PluginAppContext): Promise<unknown> {
    switch (action) {
      case "status":
        return {
          version: VERSION,
          minHost: MIN_HOST,
          node: process.versions.node,
          maxFixAttempts: MAX_FIX_ATTEMPTS,
          stacks: STACK_IDS.map((id) => {
            const s = stack(id, id !== "vanilla");
            return {
              id,
              label: s.label,
              description: s.description,
              tailwindOptional: id === "vanilla",
              allowlist: s.allowlist,
              minNode: s.minNode,
              nodeOk: nodeAtLeast(process.versions.node, s.minNode),
            };
          }),
        };
      case "models.list":
        return this.models(ctx);
      case "projects.list":
        return [
          ...this.store.list().map((m) => this.summary(m)),
          ...this.store.damaged().map((id) => ({ id, damaged: true })),
        ];
      case "projects.create":
        return this.create(input);
      case "jobs.get":
        return this.jobView(this.job(input.jobId));
      case "jobs.cancel": {
        const job = this.job(input.jobId);
        const controller = this.controllers.get(job.id);
        controller?.abort();
        return { cancelled: !!controller };
      }
      case "projects.delete":
        return this.remove(input.projectId);
    }
    const m = this.store.require(input.projectId);
    switch (action) {
      case "projects.get":
        return this.view(m);
      case "files.get":
        return this.fileGet(m, input);
      case "proposal.get":
        return this.proposalView(m);
      case "preview.snapshot":
        return this.snapshot(m);
      case "server.status": {
        const r = this.runtime(m);
        r.touch();
        const snap = r.snapshot();
        return { ...snap, logs: snap.logs.slice(-8_000) };
      }
      case "project.zip":
        return this.zip(m);
      case "projects.update":
        return this.lock(m.id, () => this.update(m, input));
      case "chat.send":
        return this.send(m, input, ctx);
      case "agent.continue":
        return this.agentContinue(m, input, ctx);
      case "agent.review":
        return this.lock(m.id, async () => {
          await this.agentReview(m.id, true);
          return this.view(this.store.require(m.id));
        });
      case "agent.discard":
        return this.lock(m.id, async () => {
          if (this.activeJob(m.id)) throw new LumbreError("project_busy");
          await this.store.deleteJson(m.id, "agent");
          return this.view(this.store.require(m.id));
        });
      case "agent.check":
        return this.startJob(m, "agentCheck", (job, signal) =>
          this.agentCheck(m.id, job, signal, ctx),
        );
      case "plan.discard":
        return this.lock(m.id, async () => {
          const chat = await this.chat(m.id);
          const msg = chat.find((x) => x.id === input.messageId && x.plan);
          if (!msg?.plan) throw new LumbreError("not_found");
          msg.plan.status = "discarded";
          await this.store.writeJson(m.id, "chat", chat);
          return this.view(this.store.require(m.id));
        });
      case "chat.clear":
        return this.lock(m.id, async () => {
          await this.store.writeJson(m.id, "chat", []);
          return this.view(this.store.require(m.id));
        });
      case "proposal.apply":
        return this.lock(m.id, () => this.apply(m.id, input));
      case "proposal.discard":
        return this.lock(m.id, async () => {
          const p = await this.proposal(m.id);
          if (!p || p.id !== input.proposalId) throw new LumbreError("not_found");
          await this.store.deleteJson(m.id, "proposal");
          return this.view(this.store.require(m.id));
        });
      case "files.save":
      case "files.delete":
        return this.lock(m.id, () => this.edit(m.id, action, input));
      case "revisions.restore":
        return this.lock(m.id, () => this.restore(m.id, input));
      case "project.export":
        return this.lock(m.id, () => this.exportTo(m, input, ctx));
      case "preview.check":
        return this.startJob(m, "check", (job, signal) =>
          this.check(m.id, job, signal, ctx, input.locale === "es" ? "es" : "en"),
        );
      case "deps.install":
        return this.startJob(m, "install", (job, signal) => this.install(m.id, job, signal, true));
      case "server.start":
        return this.startJob(m, "start", (job, signal) => this.serve(m.id, job, signal));
      case "server.stop": {
        const r = this.runtime(m);
        await r.stop("user");
        return { ...r.snapshot(), logs: undefined };
      }
      case "server.open": {
        const snap = this.runtime(m).snapshot();
        if (snap.state !== "running" || !snap.url) throw new LumbreError("server_stopped");
        await this.deps.openUrl(snap.url);
        return { opened: true, url: snap.url };
      }
    }
    throw new LumbreError("invalid_input");
  }

  // ---------- models ----------

  private async models(ctx: PluginAppContext) {
    let active: string | null = null;
    try {
      active = this.deps.sessions.model?.(ctx.sessionId) || null;
    } catch {
      active = null;
    }
    if (!this.deps.models) return { models: [], active, available: true };
    let list: AvailableProviderModel[] = [];
    try {
      list = await this.deps.models.list(ctx.signal);
    } catch {
      list = [];
    }
    const models = list.slice(0, 1000).map((m) => ({
      reference: m.reference,
      name: m.model?.name || m.model?.id || m.reference,
      provider: m.providerName || m.provider,
    }));
    return { models, active, available: models.length > 0 };
  }

  /** The model that answers: the project's choice (cleared and noted when gone), else Alisio's. */
  private async modelFor(m: ProjectMeta, parent: string, signal: AbortSignal) {
    const models = this.deps.models;
    let model: string | undefined = m.model ?? undefined;
    let info: ResolvedProviderModel["model"] | undefined;
    let fallback = false;
    if (model && models) {
      try {
        info = (await models.resolve(model, signal)).model;
      } catch {
        if (signal.aborted) throw new LumbreError("cancelled");
        fallback = true;
        model = undefined;
        await this.store.update(m.id, { model: null });
      }
    }
    if (!model && models) {
      try {
        const active = this.deps.sessions.model?.(parent);
        if (active) info = (await models.resolve(active, signal)).model;
      } catch {
        info = undefined;
      }
    }
    return { model, info, fallback };
  }

  private async requireModel(signal: AbortSignal) {
    if (!this.deps.models) return;
    let list: AvailableProviderModel[] = [];
    try {
      list = await this.deps.models.list(signal);
    } catch {
      list = [];
    }
    if (!list.length) throw new LumbreError("no_model");
  }

  // ---------- projects ----------

  private async create(input: Input) {
    if (!isStackId(input.stack)) throw new LumbreError("invalid_input");
    const title = text(input.title ?? "", 100).trim() || "My site";
    const tailwind = input.stack === "vanilla" ? input.tailwind === true : true;
    const model =
      input.model === undefined || input.model === null ? null : text(input.model, 300) || null;
    const s = stack(input.stack, tailwind);
    const m = await this.store.create({ title, stack: s.id, tailwind, model }, s.starter);
    await this.sync(m);
    return this.view(m);
  }

  private async update(m: ProjectMeta, input: Input) {
    const patch: Partial<Pick<ProjectMeta, "title" | "model" | "archived">> = {};
    if (input.title !== undefined) patch.title = text(input.title, 100).trim() || m.title;
    if (input.model !== undefined)
      patch.model = input.model === null ? null : text(input.model, 300) || null;
    if (input.archived !== undefined) patch.archived = input.archived === true;
    return this.view(await this.store.update(m.id, patch));
  }

  private async remove(id: unknown) {
    if (!isId(id)) throw new LumbreError("invalid_input");
    return this.lock(id, async () => {
      for (const job of this.jobs.values())
        if (job.projectId === id) this.controllers.get(job.id)?.abort();
      const r = this.runtimes.get(id);
      if (r) await r.stop("user");
      this.runtimes.delete(id);
      this.heads.delete(id);
      await this.store.remove(id);
      return { deleted: true };
    });
  }

  private async fileGet(m: ProjectMeta, input: Input) {
    const path = filePath(input.path);
    const head = await this.head(m);
    if (Object.hasOwn(head, path))
      return { path, content: head[path], owned: false, revision: m.head };
    const owned = await this.owned(m);
    if (Object.hasOwn(owned, path))
      return { path, content: owned[path], owned: true, revision: m.head };
    throw new LumbreError("not_found");
  }

  private async edit(id: string, action: string, input: Input) {
    const m = this.store.require(id);
    if (input.baseRevision !== m.head) throw new LumbreError("conflict");
    const path = filePath(input.path);
    if (isManagedPath(path, this.stackOf(m).generated) || Object.hasOwn(await this.owned(m), path))
      throw new LumbreError("managed_file");
    const files = { ...(await this.head(m)) };
    if (action === "files.save") files[path] = text(input.content, LIMITS.fileBytes);
    else {
      if (!Object.hasOwn(files, path)) throw new LumbreError("not_found");
      delete files[path];
    }
    this.fixChain.set(id, 0);
    return this.view(
      await this.commit(
        m,
        files,
        action === "files.save" ? `Edited ${path}` : `Deleted ${path}`,
        "manual",
      ),
    );
  }

  private async restore(id: string, input: Input) {
    const m = this.store.require(id);
    if (!isId(input.revisionId)) throw new LumbreError("invalid_input");
    const files = await this.store.files(id, input.revisionId);
    this.fixChain.set(id, 0);
    return this.view(await this.commit(m, files, "Restored an earlier version", "restore"));
  }

  // ---------- proposals ----------

  private async proposalView(m: ProjectMeta) {
    const p = await this.proposal(m.id);
    if (!p || p.base !== m.head) throw new LumbreError("not_found");
    const head = await this.head(m);
    return {
      ...p,
      before: Object.fromEntries(
        [...Object.keys(p.files), ...p.deletes].map((path) => [path, head[path] ?? null]),
      ),
    };
  }

  private async apply(id: string, input: Input) {
    const m = this.store.require(id);
    const p = await this.proposal(id);
    if (!p || p.id !== input.proposalId) throw new LumbreError("not_found");
    if (p.base !== m.head) throw new LumbreError("conflict");
    const pick = (value: unknown, allowed: string[]) => {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !allowed.includes(v)))
        throw new LumbreError("invalid_input");
      return [...new Set(value as string[])];
    };
    const files = pick(input.files ?? [], Object.keys(p.files));
    const deletes = pick(input.deletes ?? [], p.deletes);
    const deps = pick(input.dependencies ?? [], Object.keys(p.dependencies));
    if (!files.length && !deletes.length && !deps.length) throw new LumbreError("invalid_input");
    const next = { ...(await this.head(m)) };
    for (const f of files) next[f] = p.files[f] as string;
    for (const d of deletes) delete next[d];
    if (deps.length) {
      const extras = { ...m.extras };
      for (const d of deps) extras[d] = p.dependencies[d] as string;
      await this.store.update(id, { extras });
    }
    const fresh = this.store.require(id);
    let committed = fresh;
    if (files.length || deletes.length)
      committed = await this.commit(fresh, next, p.summary, p.fixAttempt ? "fix" : "proposal");
    else await this.sync(fresh);
    this.fixChain.set(id, p.fixAttempt);
    await this.store.deleteJson(id, "proposal");
    await this.say(id, {
      role: "notice",
      text: "",
      notice: "applied",
      ...(p.fixAttempt ? { fixAttempt: p.fixAttempt } : {}),
    });
    return this.view(committed);
  }

  // ---------- jobs ----------

  private job(id: unknown): Job {
    const job = typeof id === "string" ? this.jobs.get(id) : undefined;
    if (!job) throw new LumbreError("not_found");
    return job;
  }

  private jobView(job: Job) {
    const { draft, ...rest } = job;
    return {
      ...rest,
      elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
      log: job.log.slice(-8_000),
      ...(draft
        ? { agent: { timeline: draft.state.timeline.slice(-80), counts: draft.state.counts } }
        : {}),
    };
  }

  private stage(
    job: Job,
    key: string,
    args?: Record<string, string | number>,
    progress: number | null = null,
  ) {
    const step: Step = { key, at: Date.now(), ...(args ? { args } : {}) };
    job.stage = step;
    job.steps.push(step);
    if (job.steps.length > 60) job.steps.splice(0, job.steps.length - 60);
    job.progress = progress;
  }

  private startJob(
    m: ProjectMeta,
    kind: JobKind,
    run: (job: Job, signal: AbortSignal) => Promise<Record<string, unknown> | null>,
  ) {
    if (this.activeJob(m.id)) throw new LumbreError("project_busy");
    if ([...this.jobs.values()].filter((j) => j.state === "running").length >= MAX_JOBS)
      throw new LumbreError("too_many_jobs");
    if (
      kind === "start" &&
      !this.runtime(m).running &&
      [...this.runtimes.values()].filter((r) => r.running).length >= MAX_SERVERS
    )
      throw new LumbreError("too_many_servers");
    const now = Date.now();
    const first: Step = {
      key: kind === "generate" || kind === "agent" ? "thinking" : "preparing",
      at: now,
    };
    const job: Job = {
      id: randomUUID(),
      projectId: m.id,
      kind,
      state: "running",
      stage: first,
      steps: [first],
      progress: null,
      startedAt: now,
      endedAt: null,
      error: null,
      result: null,
      log: "",
      diagnostics: null,
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    // Keep finished jobs for a while so the frame can read their outcome.
    for (const [id, j] of this.jobs)
      if (j.state !== "running" && this.jobs.size > 40) this.jobs.delete(id);
    // Agent jobs have an overall cap; each run is also bounded by its own timeout.
    const cap =
      kind === "agent" || kind === "agentCheck"
        ? setTimeout(() => controller.abort(), AGENT_JOB_CAP_MS)
        : undefined;
    cap?.unref?.();
    void (async () => {
      try {
        job.result = await run(job, controller.signal);
        controller.signal.throwIfAborted();
        job.state = "done";
        this.stage(job, "done", undefined, 1);
      } catch (error) {
        job.error = controller.signal.aborted ? "cancelled" : errorCode(error);
        job.state = job.error === "cancelled" ? "cancelled" : "failed";
      } finally {
        if (cap) clearTimeout(cap);
        job.endedAt = Date.now();
        this.controllers.delete(job.id);
      }
    })();
    return { jobId: job.id };
  }

  private async send(m: ProjectMeta, input: Input, ctx: PluginAppContext) {
    const request = text(input.text, 8_000).trim();
    if (!request) throw new LumbreError("invalid_input");
    const locale = input.locale === "es" ? "es" : "en";
    if (this.activeJob(m.id)) throw new LumbreError("project_busy");
    await this.requireModel(ctx.signal);
    const mode = input.mode === "plan" ? "plan" : "build";
    // An approved plan: built exactly, and its card stops asking.
    let plan: string | undefined;
    if (typeof input.planId === "string") {
      const chat = await this.chat(m.id);
      const msg = chat.find((x) => x.id === input.planId && x.plan);
      if (!msg?.plan) throw new LumbreError("not_found");
      msg.plan.status = "approved";
      plan = msg.text;
      await this.store.writeJson(m.id, "chat", chat);
    }
    await this.say(m.id, { role: "user", text: request });
    if (await this.useBlocks(m, ctx))
      return this.startJob(m, "generate", (job, signal) =>
        this.generate(m.id, job, signal, ctx.sessionId, { request, locale, fixAttempt: 0 }),
      );
    if (!plan && (await this.store.readJson<AgentState | null>(m.id, "agent", null)))
      await this.store.deleteJson(m.id, "agent"); // a new request replaces an unreviewed draft
    return this.startJob(m, "agent", (job, signal) =>
      this.agentRun(m.id, job, signal, ctx.sessionId, {
        mode,
        request: plan ? `${request}` : request,
        locale,
        ...(plan ? { plan } : {}),
      }),
    );
  }

  /** Models that cannot call tools (catalog says so, or seen this activation) use 0.1.1 blocks. */
  private async useBlocks(m: ProjectMeta, ctx: PluginAppContext) {
    let active: string | null = null;
    try {
      active = this.deps.sessions.model?.(ctx.sessionId) || null;
    } catch {
      active = null;
    }
    // Read-only lookup (no clearing a vanished model here: the run itself reports that).
    const refs = [m.model, active].filter((r): r is string => !!r);
    if (refs.some((r) => this.noTools.has(r))) return true;
    let info: ResolvedProviderModel["model"] | undefined;
    for (const ref of refs) {
      try {
        info = (await this.deps.models?.resolve(ref, ctx.signal))?.model;
        if (info) break;
      } catch {
        info = undefined;
      }
    }
    if (!info && this.deps.models)
      try {
        const list = await this.deps.models.list(ctx.signal);
        info = list.find((x) => refs.includes(x.reference))?.model;
      } catch {
        info = undefined;
      }
    return toolSupport(info as Parameters<typeof toolSupport>[0]) === "no";
  }

  /** One builder pass in a child session; stores a proposal when the model changed something. */
  private async generate(
    id: string,
    job: Job,
    signal: AbortSignal,
    parent: string,
    pass: {
      request: string;
      locale: "en" | "es";
      fixAttempt: number;
      errorLog?: string;
      /** An agent run's answer that came back as 0.1.1 blocks (the model used no tools). */
      seed?: { text: string; output: number; diagnostics: Diagnostics | null };
    },
  ) {
    const m = this.store.require(id);
    const s = this.stackOf(m);
    try {
      const { model, info, fallback } = await this.modelFor(m, parent, signal);
      const b = budget(info);
      let active: string | null = model ?? null;
      if (!active)
        try {
          active = this.deps.sessions.model?.(parent) || null;
        } catch {
          active = null;
        }
      // Diagnostics: numbers and categories only, never content.
      const diag: Diagnostics = {
        model: active,
        contextWindow: b.contextTokens,
        contextSource: b.contextSource,
        outputBudget: b.outputTokens,
        outputSource: b.outputSource,
        usageInput: 0,
        usageOutput: 0,
        planned: false,
        batches: 0,
        continuations: 0,
        retriedWithoutLimit: false,
        mode: "blocks",
        runs: 0,
        toolCalls: 0,
        fixRounds: 0,
        reason: null,
      };
      job.diagnostics = diag;
      const files = await this.head(m);
      const owned = Object.keys(await this.owned(m));
      const history = (await this.chat(id)).slice(0, pass.fixAttempt ? undefined : -1);
      const planFirst =
        !pass.fixAttempt &&
        !pass.seed &&
        (m.revisions.length === 1 || pass.request.length > 1_500 || b.outputTokens < 12_000);
      const { prompt, omitted } = buildPrompt({
        allowlist: allowlistFor(s, m.extras),
        stack: s,
        request: pass.request,
        chat: history,
        files,
        owned,
        inputChars: b.inputChars,
        locale: pass.locale,
        mode: planFirst ? "plan" : "write",
        ...(pass.errorLog !== undefined ? { errorLog: pass.errorLog } : {}),
      });
      this.stage(
        job,
        pass.fixAttempt
          ? "fixing"
          : planFirst
            ? "planning"
            : Object.keys(files).length > 3 && history.length
              ? "thinkingChanges"
              : "thinking",
        pass.fixAttempt ? { attempt: pass.fixAttempt, max: MAX_FIX_ATTEMPTS } : undefined,
      );
      const instructions = await this.deps.instructions(pass.fixAttempt ? "fix" : "build", s.id);
      let outputLimit: number | undefined = b.outputTokens;
      const create = () =>
        this.deps.sessions.create({
          parentId: parent,
          agent: "lmb-builder",
          title: `Lumbre: ${m.title}`.slice(0, 120),
          instructions,
          tools: { allow: [] },
          readOnly: true,
          permission: { write: "deny", process: "deny" },
          maxTurns: 2,
          timeoutMs: 6 * 60_000,
          ...(outputLimit ? { maxOutputTokens: outputLimit } : {}),
          ...(model ? { model } : {}),
        });
      let child = await create();
      let seen = { input: 0, output: 0 };
      /** One run on the child; usage is cumulative per child, so only the growth counts. */
      const turn = async (text: string): Promise<{ raw: RawOutput | null; cutOff: boolean }> => {
        const cancel = () => this.deps.sessions.cancel(child.id);
        signal.addEventListener("abort", cancel, { once: true });
        let result: ChildRunResult;
        try {
          result = await this.deps.sessions.run(child.id, text, { signal });
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        signal.throwIfAborted();
        diag.runs++;
        const out = result.usage?.output ?? 0;
        const inp = result.usage?.input ?? 0;
        const delta = out >= seen.output ? out - seen.output : out;
        diag.usageOutput += delta;
        diag.usageInput += inp >= seen.input ? inp - seen.input : inp;
        seen = { input: inp, output: out };
        if (result.status === "cancelled") throw new LumbreError("cancelled");
        if (result.status !== "completed") {
          const category = classifyFailure(result.error);
          diag.reason = category;
          if (category === "truncated") return { raw: null, cutOff: true };
          throw new TurnFailure(category);
        }
        const nearLimit = delta >= 0.95 * (outputLimit ?? HOST_DEFAULT_OUTPUT);
        let raw: RawOutput;
        try {
          raw = readOutput(result.text);
        } catch (error) {
          if (nearLimit || result.turnsExceeded) return { raw: null, cutOff: true };
          throw error;
        }
        return { raw, cutOff: raw.truncated || !!result.turnsExceeded || (!raw.done && nearLimit) };
      };
      let first: { raw: RawOutput | null; cutOff: boolean };
      if (pass.seed) {
        diag.mode = "blocks";
        diag.usageOutput += pass.seed.output;
        diag.usageInput += pass.seed.diagnostics?.usageInput ?? 0;
        diag.runs = pass.seed.diagnostics?.runs ?? 0;
        let raw: RawOutput | null = null;
        try {
          raw = readOutput(pass.seed.text);
        } catch {
          raw = null;
        }
        const near = pass.seed.output >= 0.95 * b.outputTokens;
        first = raw
          ? { raw, cutOff: raw.truncated || (!raw.done && near) }
          : { raw: null, cutOff: true };
      } else
        try {
          first = await turn(prompt);
        } catch (error) {
          // An estimated output limit the provider rejects: retry once with the host's own limit.
          const retry =
            error instanceof TurnFailure &&
            b.outputSource === "estimated" &&
            (error.category === "output_limit" || error.category === "provider");
          if (!retry) throw error;
          diag.retriedWithoutLimit = true;
          diag.reason = null;
          outputLimit = undefined;
          child = await create();
          seen = { input: 0, output: 0 };
          first = await turn(prompt);
        }
      let acc: RawOutput | undefined;
      let pending = false;
      const absorb = (r: { raw: RawOutput | null; cutOff: boolean }) => {
        if (r.raw) acc = mergeOutputs(acc, r.raw);
        pending = r.cutOff;
      };
      absorb(first);
      const received = () => acc?.files.map((f) => f.path) ?? [];
      const continueCut = async (expected: string[]) => {
        while (pending && diag.continuations < MAX_CONTINUATIONS) {
          diag.continuations++;
          this.stage(job, "continuing", { part: diag.continuations + 1 });
          const got = received();
          absorb(
            await turn(
              continuePrompt(
                got,
                acc?.cut ?? null,
                expected.filter((p) => !got.includes(p)),
              ),
            ),
          );
        }
      };
      let expected: string[] = [];
      const planned = (acc?.plan ?? []).filter((e) => !received().includes(e.path));
      if (planFirst && planned.length) {
        diag.planned = true;
        pending = false;
        expected = planned.map((e) => e.path);
        const batches = planBatches(planned, outputLimit ?? HOST_DEFAULT_OUTPUT);
        diag.batches = batches.length;
        for (const [i, paths] of batches.entries()) {
          this.stage(job, "writingBatch", { part: i + 1, total: batches.length });
          const missing = paths.filter((p) => !received().includes(p));
          if (!missing.length) continue;
          absorb(await turn(batchPrompt(missing, i + 1, batches.length)));
          await continueCut(missing);
        }
      } else await continueCut([]);
      if (!acc) {
        diag.reason = "truncated";
        throw new LumbreError("output_truncated");
      }
      const missing = expected.filter((p) => !received().includes(p));
      const cutPath = pending ? acc.cut : null;
      const partial = pending || missing.length > 0;
      this.stage(job, "reading");
      const out = validateOutput(acc, {
        stack: s,
        current: files,
        owned,
        omitted,
        extras: m.extras,
      });
      const changed = [...Object.keys(out.files), ...out.deletes];
      if (partial && !Object.keys(out.files).length) {
        diag.reason = "truncated";
        throw new LumbreError("output_truncated");
      }
      if (partial) diag.reason = "truncated";
      for (const [i, path] of changed.entries())
        this.stage(
          job,
          Object.hasOwn(out.files, path) ? "writing" : "removing",
          { file: path, index: i + 1, count: changed.length },
          (i + 1) / changed.length,
        );
      const hasChanges = changed.length > 0 || Object.keys(out.dependencies).length > 0;
      const partialInfo = partial
        ? {
            received: Object.keys(out.files).length,
            missing: [...new Set([...(cutPath ? [cutPath] : []), ...missing])].slice(0, 50),
          }
        : null;
      let proposalId: string | undefined;
      await this.lock(id, async () => {
        if (hasChanges) {
          const p: Proposal = {
            id: randomUUID(),
            base: this.store.require(id).head,
            createdAt: Date.now(),
            summary: out.summary,
            message: out.message,
            files: out.files,
            deletes: out.deletes,
            dependencies: out.dependencies,
            ignored: out.ignored,
            fixAttempt: pass.fixAttempt,
            ...(partialInfo ? { partial: partialInfo } : {}),
          };
          await this.store.writeJson(id, "proposal", p);
          proposalId = p.id;
        }
        await this.say(id, {
          role: "assistant",
          text: out.message || out.summary,
          ...(proposalId ? { proposalId } : {}),
          ...(pass.fixAttempt ? { fixAttempt: pass.fixAttempt } : {}),
          ...(fallback ? { modelFallback: true } : {}),
        });
        if (partialInfo)
          await this.say(id, {
            role: "notice",
            text: "",
            notice: "output_partial",
            count: partialInfo.received,
          });
      });
      this.stage(job, proposalId ? "reviewReady" : "answered");
      return {
        proposalId: proposalId ?? null,
        ignored: out.ignored,
        omitted,
        partial: partialInfo,
      };
    } catch (error) {
      if (error instanceof TurnFailure) {
        const code = error.category === "context_length" ? "context_limit" : "agent_failed";
        if (job.diagnostics) job.diagnostics.reason = error.category;
        if (!pass.fixAttempt)
          await this.say(id, { role: "notice", text: "", notice: "generation_failed", code }).catch(
            () => {},
          );
        throw new LumbreError(code);
      }
      const code = signal.aborted ? "cancelled" : errorCode(error);
      if (job.diagnostics && !job.diagnostics.reason && code !== "cancelled")
        job.diagnostics.reason = code;
      if (!pass.fixAttempt)
        await this.say(id, { role: "notice", text: "", notice: "generation_failed", code }).catch(
          () => {},
        );
      throw error;
    }
  }

  private async installIfNeeded(id: string, job: Job, signal: AbortSignal, force: boolean) {
    const m = this.store.require(id);
    const s = this.stackOf(m);
    if (!s.npm) return;
    const owned = await this.owned(m);
    const key = sha(`${owned["package.json"]}\n${owned["package-lock.json"]}`);
    const installed = await this.store.readJson<{ key?: string } | null>(id, "installed", null);
    const work = join(this.store.dir(id), "work");
    if (!force && installed?.key === key && existsSync(join(work, "node_modules"))) return;
    this.stage(job, "installing");
    const custom = await this.store.readJson<{ extras?: string } | null>(id, "lock", null);
    const extrasKey = JSON.stringify(m.extras);
    const mode = Object.keys(m.extras).length && custom?.extras !== extrasKey ? "install" : "ci";
    const r = this.runtime(m);
    try {
      await r.install(signal, mode);
    } finally {
      job.log = r.log();
    }
    let finalKey = key;
    if (mode === "install") {
      const lock = await readFile(join(work, "package-lock.json"), "utf8");
      await this.store.writeJson(id, "lock", { content: lock, extras: extrasKey });
      finalKey = sha(`${owned["package.json"]}\n${lock}`);
      await this.sync(this.store.require(id));
    }
    await this.store.writeJson(id, "installed", { key: finalKey, at: Date.now() });
  }

  private async install(id: string, job: Job, signal: AbortSignal, force: boolean) {
    await this.sync(this.store.require(id), true);
    await this.installIfNeeded(id, job, signal, force);
    return { installed: true };
  }

  private async serve(id: string, job: Job, signal: AbortSignal) {
    const m = this.store.require(id);
    const r = this.runtime(m);
    if (r.running) return { server: { ...r.snapshot(), logs: undefined } };
    await this.sync(m, true);
    await this.installIfNeeded(id, job, signal, false);
    this.stage(job, "starting");
    try {
      await r.start(signal);
    } finally {
      job.log = r.log();
    }
    return { server: { ...r.snapshot(), logs: undefined } };
  }

  /**
   * Verifies the current version: probes the running preview, or builds. A failure starts an
   * automatic fix-up pass (at most MAX_FIX_ATTEMPTS in a row), whose proposal the user reviews.
   */
  private async check(
    id: string,
    job: Job,
    signal: AbortSignal,
    ctx: PluginAppContext,
    locale: "en" | "es",
  ) {
    const m = this.store.require(id);
    const s = this.stackOf(m);
    const r = this.runtime(m);
    await this.sync(m, true);
    await this.installIfNeeded(id, job, signal, false);
    let failure = false;
    if (r.running) {
      this.stage(job, "checking");
      const status = await r.probe();
      job.log = r.log();
      failure = status === null || status >= 500;
    } else if (s.build || s.css) {
      this.stage(job, "building");
      try {
        await r.build(signal);
      } catch (error) {
        if (signal.aborted || errorCode(error) !== "build_failed") throw error;
        failure = true;
      } finally {
        job.log = r.log();
      }
      if (!failure) {
        this.stage(job, "thumbnail");
        const fresh = this.store.require(id);
        const work = join(this.store.dir(id), "work");
        const snap = s.css
          ? sourceSnapshot(
              await this.head(fresh),
              fresh.head,
              await readFile(join(work, "styles", "tailwind.css"), "utf8").catch(() => ""),
            )
          : await buildSnapshot(work, s, fresh.head);
        await this.store.writeJson(id, "snapshot", snap);
      }
    }
    if (!failure) {
      this.fixChain.set(id, 0);
      return { ok: true };
    }
    const attempt = (this.fixChain.get(id) ?? 0) + 1;
    if (attempt > MAX_FIX_ATTEMPTS) {
      await this.say(id, { role: "notice", text: "", notice: "fix_exhausted" });
      throw new LumbreError("build_failed");
    }
    await this.say(id, { role: "notice", text: "", notice: "build_failed", fixAttempt: attempt });
    try {
      await this.requireModel(signal);
    } catch {
      throw new LumbreError("build_failed");
    }
    const generated = await this.generate(id, job, signal, ctx.sessionId, {
      request: "",
      locale,
      fixAttempt: attempt,
      errorLog: job.log || "The build failed without output.",
    });
    return { ok: false, fixProposal: generated.proposalId, attempt };
  }

  // ---------- agent mode (0.2.0) ----------

  /** A draft tool call from a child session; refuses unless that child runs a Lumbre job now. */
  async agentTool(
    name: AgentToolName,
    input: Record<string, unknown>,
    session: string | undefined,
  ): Promise<ToolResult> {
    const run = session ? this.agentRuns.get(session) : undefined;
    if (run?.job.state !== "running") return { ok: false, error: "not_in_lumbre_job" };
    if (run.mode === "plan" && name !== "lumbre_list_files" && name !== "lumbre_read_file")
      return { ok: false, error: "not_allowed_in_plan" };
    const d = run.draft;
    d.state.counts.tools++;
    if (run.job.diagnostics) run.job.diagnostics.toolCalls++;
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    let result: ToolResult;
    switch (name) {
      case "lumbre_list_files":
        result = { ok: true, files: d.list() };
        break;
      case "lumbre_read_file":
        result = d.read(input.path, n(input.offset), n(input.limit));
        break;
      case "lumbre_write_file":
        result = d.write(input.path, input.content);
        break;
      case "lumbre_edit_file":
        result = d.edit(input.path, input.find, input.replace);
        break;
      case "lumbre_delete_file":
        result = d.remove(input.path);
        break;
      case "lumbre_add_dependency":
        result = d.addDependency(input.name, input.version);
        break;
      case "lumbre_progress":
        result = d.progress(input.message);
        break;
      case "lumbre_done":
        result = d.finish(input.summary, input.message);
        break;
      default:
        result = { ok: false, error: "invalid_input" };
    }
    const last = d.state.timeline.at(-1);
    if (last)
      this.stage(run.job, "agentStep", {
        kind: last.kind,
        ...(last.path ? { file: last.path } : {}),
        ...(last.text ? { text: last.text } : {}),
      });
    // Plans never persist a draft (they change no file).
    if (run.mode === "build") this.saveAgentSoon(run.projectId);
    return result;
  }

  private agentStates = new Map<string, AgentState>();
  private agentSaves = new Map<string, ReturnType<typeof setTimeout>>();
  private saveAgentSoon(id: string) {
    if (this.agentSaves.has(id)) return;
    const timer = setTimeout(() => {
      this.agentSaves.delete(id);
      const st = this.agentStates.get(id);
      if (st) void this.store.writeJson(id, "agent", st).catch(() => {});
    }, 300);
    timer.unref?.();
    this.agentSaves.set(id, timer);
  }
  private async saveAgent(id: string, st: AgentState | null) {
    const timer = this.agentSaves.get(id);
    if (timer) clearTimeout(timer);
    this.agentSaves.delete(id);
    if (st) {
      this.agentStates.set(id, st);
      await this.store.writeJson(id, "agent", st);
    } else {
      this.agentStates.delete(id);
      await this.store.deleteJson(id, "agent");
    }
  }
  /** The project's agent state; a run interrupted by a restart shows as paused. */
  private async agentState(id: string): Promise<AgentState | null> {
    const st =
      this.agentStates.get(id) ?? (await this.store.readJson<AgentState | null>(id, "agent", null));
    if (!st) return null;
    const busy = ["running", "checking", "fixing"].includes(st.phase);
    if (busy && !this.activeJob(id)) {
      st.phase = "paused";
      st.pausedReason = st.pausedReason ?? "cancelled";
    }
    return st;
  }

  private async agentDraft(id: string, st: AgentState) {
    const m = this.store.require(id);
    const owned = Object.keys(await this.owned(m));
    const base = m.revisions.some((r) => r.id === st.draft.base)
      ? await this.store.files(id, st.draft.base)
      : await this.head(m);
    return new Draft(this.stackOf(m), owned, base, st.draft.base, st.draft, m.extras);
  }

  private async agentRun(
    id: string,
    job: Job,
    signal: AbortSignal,
    parent: string,
    pass: {
      mode: "plan" | "build";
      request: string;
      locale: "en" | "es";
      plan?: string;
      goal?: string;
      resume?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const m = this.store.require(id);
    const s = this.stackOf(m);
    const { model, info, fallback } = await this.modelFor(m, parent, signal);
    const b = budget(info);
    let active: string | null = model ?? null;
    if (!active)
      try {
        active = this.deps.sessions.model?.(parent) || null;
      } catch {
        active = null;
      }
    const diag: Diagnostics = {
      mode: "agent",
      model: active,
      contextWindow: b.contextTokens,
      contextSource: b.contextSource,
      outputBudget: b.outputTokens,
      outputSource: b.outputSource,
      usageInput: 0,
      usageOutput: 0,
      planned: pass.mode === "plan" || !!pass.plan,
      batches: 0,
      continuations: 0,
      retriedWithoutLimit: false,
      runs: 0,
      toolCalls: 0,
      fixRounds: 0,
      reason: null,
    };
    job.diagnostics = diag;
    const owned = Object.keys(await this.owned(m));
    let st = pass.resume ? await this.agentState(id) : null;
    if (!st)
      st = {
        phase: "running",
        mode: pass.mode,
        childId: null,
        request: pass.request,
        locale: pass.locale,
        autoContinues: 0,
        fixRounds: 0,
        checkFailed: false,
        pausedReason: null,
        draft: new Draft(s, owned, await this.head(m), m.head).state,
        startedAt: Date.now(),
      };
    st.phase = "running";
    st.pausedReason = null;
    st.autoContinues = 0;
    const draft = await this.agentDraft(id, st);
    st.draft = draft.state;
    job.draft = draft;
    if (pass.mode === "build") await this.saveAgent(id, st);
    if (!pass.resume) draft.note("thinking", { text: pass.mode === "plan" ? "plan" : "build" });
    this.stage(
      job,
      pass.mode === "plan" ? "planning" : pass.resume ? "agentContinuing" : "thinking",
      pass.resume ? { part: 1 } : undefined,
    );
    const instructions = await this.deps.instructions(
      pass.mode === "plan" ? "plan" : "agent",
      s.id,
    );
    let childId = pass.resume && st.childId ? st.childId : null;
    if (!childId) {
      const child = await this.deps.sessions.create({
        parentId: parent,
        agent: "lmb-agent",
        title: `Lumbre: ${m.title}`.slice(0, 120),
        instructions,
        tools: { allow: allowedTools(pass.mode) },
        readOnly: true,
        permission: { write: "deny", process: "deny" },
        maxTurns: AGENT_MAX_TURNS,
        timeoutMs: AGENT_RUN_TIMEOUT_MS,
        maxOutputTokens: b.outputTokens,
        ...(model ? { model } : {}),
      });
      childId = child.id;
    }
    st.childId = childId;
    const run = { projectId: id, mode: pass.mode, draft, job };
    this.agentRuns.set(childId, run);
    let seen = { input: 0, output: 0 };
    const runOnce = async (prompt: string) => {
      const cancel = () => this.deps.sessions.cancel(childId as string);
      signal.addEventListener("abort", cancel, { once: true });
      let result: ChildRunResult;
      try {
        result = await this.deps.sessions.run(childId as string, prompt, { signal });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      diag.runs++;
      const out = result.usage?.output ?? 0;
      const inp = result.usage?.input ?? 0;
      const delta = out >= seen.output ? out - seen.output : out;
      diag.usageOutput += delta;
      diag.usageInput += inp >= seen.input ? inp - seen.input : inp;
      seen = { input: inp, output: out };
      return { result, delta };
    };
    try {
      const listing = draft.list();
      let prompt = pass.resume
        ? agentContinuePrompt(pass.goal)
        : agentPrompt({
            allowlist: allowlistFor(s, m.extras),
            stack: s,
            mode: pass.mode,
            request: pass.request,
            chat: (await this.chat(id)).slice(0, -1),
            files: listing,
            locale: pass.locale,
            inputChars: b.inputChars,
            ...(pass.plan ? { plan: pass.plan } : {}),
          });
      for (;;) {
        const toolsBefore = draft.state.counts.tools;
        const { result, delta } = await runOnce(prompt);
        signal.throwIfAborted();
        if (result.status === "cancelled") throw new LumbreError("cancelled");
        const usedTools = draft.state.counts.tools > toolsBefore;
        if (result.status !== "completed") {
          const category = classifyFailure(result.error);
          diag.reason = category;
          if (category !== "truncated" || pass.mode === "plan") throw new TurnFailure(category);
        }
        if (pass.mode === "plan")
          return await this.agentPlanned(id, st, result.text, fallback, job);
        // No tool at all, but a 0.1.1 answer: this model cannot use tools; switch to blocks.
        if (!usedTools && diag.runs === 1 && !pass.resume && looksLikeBlocks(result.text)) {
          if (active) this.noTools.add(active);
          this.agentRuns.delete(childId);
          await this.saveAgent(id, null);
          job.draft = undefined;
          return (await this.generate(id, job, signal, parent, {
            request: pass.request,
            locale: pass.locale,
            fixAttempt: 0,
            seed: { text: result.text, output: delta, diagnostics: diag },
          })) as Record<string, unknown>;
        }
        if (draft.state.done) break;
        if (st.autoContinues >= MAX_AUTO_CONTINUES) {
          st.phase = "paused";
          st.pausedReason = "turns";
          await this.saveAgent(id, st);
          await this.say(id, {
            role: "notice",
            text: "",
            notice: "agent_paused",
            count: draft.state.counts.tools,
          });
          this.stage(job, "agentPaused");
          return { paused: true };
        }
        st.autoContinues++;
        diag.continuations++;
        this.stage(job, "agentContinuing", { part: st.autoContinues + 1 });
        prompt = agentContinuePrompt(pass.goal);
      }
      const s2 = this.stackOf(this.store.require(id));
      const changed = Object.keys(draft.state.changes).length > 0;
      if (changed && (s2.build || s2.css)) {
        st.phase = "needs_check";
        await this.saveAgent(id, st);
        this.stage(job, "agentNeedsCheck");
        return { needsCheck: true };
      }
      return await this.agentReview(id, false, job);
    } catch (error) {
      if (error instanceof TurnFailure) {
        diag.reason = error.category;
        st.phase = pass.mode === "plan" ? "failed" : "paused";
        st.pausedReason = "failed";
        if (pass.mode === "build") await this.saveAgent(id, st);
        await this.say(id, {
          role: "notice",
          text: "",
          notice: "generation_failed",
          code: error.category === "context_length" ? "context_limit" : "agent_failed",
        }).catch(() => {});
        throw new LumbreError(
          error.category === "context_length" ? "context_limit" : "agent_failed",
        );
      }
      if (signal.aborted || errorCode(error) === "cancelled") {
        st.phase = "paused";
        st.pausedReason = "cancelled";
        if (pass.mode === "build") await this.saveAgent(id, st).catch(() => {});
        throw new LumbreError("cancelled");
      }
      throw error;
    } finally {
      this.agentRuns.delete(childId);
    }
  }

  /** A Plan-mode answer: a plan card (Markdown + design token plan) that the person approves. */
  private async agentPlanned(
    id: string,
    st: AgentState,
    text: string,
    fallback: boolean,
    job: Job,
  ) {
    let message = text.trim();
    let design = null;
    try {
      const out = readOutput(text);
      design = out.design;
      // The Markdown is everything outside the DESIGN block (or the MESSAGE block when present).
      message = (out.message || text.replace(/<<<LUMBRE-DESIGN>>>[\s\S]*?(<<<LUMBRE-END>>>|$)/, ""))
        .replace(/<<<LUMBRE-[A-Z]+>>>/g, "")
        .trim();
    } catch {
      design = null;
    }
    if (!message && !design) throw new LumbreError("invalid_output");
    void st;
    await this.say(id, {
      role: "assistant",
      text: message.slice(0, 20_000),
      plan: { status: "pending", design },
      ...(fallback ? { modelFallback: true } : {}),
    });
    // A plan leaves no agent state behind (it would show as a paused draft).
    await this.saveAgent(id, null);
    this.stage(job, "planReady");
    return { planned: true };
  }

  private async agentContinue(m: ProjectMeta, input: Input, ctx: PluginAppContext) {
    const st = await this.agentState(m.id);
    if (st?.phase !== "paused") throw new LumbreError("not_found");
    const goal = input.goal === undefined ? undefined : text(input.goal, 2_000).trim() || undefined;
    if (goal) await this.say(m.id, { role: "user", text: goal });
    return this.startJob(m, "agent", (job, signal) =>
      this.agentRun(m.id, job, signal, ctx.sessionId, {
        mode: "build",
        request: st.request,
        locale: st.locale,
        resume: true,
        ...(goal ? { goal } : {}),
      }),
    );
  }

  /** Builds the draft in `draft/work` (packages linked from `work`), fixing up to 2 rounds. */
  private async agentCheck(id: string, job: Job, signal: AbortSignal, ctx: PluginAppContext) {
    const st = await this.agentState(id);
    if (!st || (st.phase !== "needs_check" && st.phase !== "paused"))
      throw new LumbreError("not_found");
    const m = this.store.require(id);
    const s = this.stackOf(m);
    const draft = await this.agentDraft(id, st);
    job.draft = draft;
    job.diagnostics = {
      mode: "agent",
      model: null,
      contextWindow: 0,
      contextSource: "estimated",
      outputBudget: 0,
      outputSource: "estimated",
      usageInput: 0,
      usageOutput: 0,
      planned: false,
      batches: 0,
      continuations: 0,
      retriedWithoutLimit: false,
      runs: 0,
      toolCalls: 0,
      fixRounds: st.fixRounds,
      reason: null,
    };
    st.phase = "checking";
    await this.saveAgent(id, st);
    if (Object.keys(draft.state.deps).length) {
      // New packages are installed after the person applies; the build is checked then.
      draft.note("check", { text: "packages" });
      return await this.agentReview(id, false, job);
    }
    await this.sync(m, true);
    await this.installIfNeeded(id, job, signal, false);
    const root = join(this.store.dir(id), "draft");
    const r = this.deps.runtime({
      dir: root,
      stack: s,
      npmCli: this.deps.npmCli(),
      cacheDir: this.deps.cacheDir,
    });
    for (;;) {
      this.stage(job, "checkingDraft");
      draft.note("check");
      await syncWork(root, { ...draft.files(), ...(await this.owned(m)) }, { verify: true });
      await linkModules(
        join(this.store.dir(id), "work", "node_modules"),
        join(root, "work", "node_modules"),
      );
      let failed = false;
      try {
        await r.build(signal);
      } catch (error) {
        if (signal.aborted || errorCode(error) !== "build_failed") throw error;
        failed = true;
      }
      job.log = r.log();
      if (!failed) {
        st.checkFailed = false;
        draft.note("check", { text: "ok" });
        return await this.agentReview(id, false, job);
      }
      draft.note("error", { text: "build_failed" });
      if (st.fixRounds >= MAX_AGENT_FIXES) {
        st.checkFailed = true;
        return await this.agentReview(id, false, job);
      }
      st.fixRounds++;
      st.phase = "fixing";
      if (job.diagnostics) job.diagnostics.fixRounds = st.fixRounds;
      draft.note("fix", { text: String(st.fixRounds) });
      this.stage(job, "fixingDraft", { round: st.fixRounds, max: MAX_AGENT_FIXES });
      await this.agentFixRun(
        id,
        st,
        draft,
        job,
        signal,
        ctx.sessionId,
        agentFixPrompt(job.log, st.fixRounds, MAX_AGENT_FIXES),
      );
    }
  }

  /** One fix round on the same child, with the build tools. */
  private async agentFixRun(
    id: string,
    st: AgentState,
    draft: Draft,
    job: Job,
    signal: AbortSignal,
    parent: string,
    prompt: string,
  ) {
    let childId = st.childId;
    if (!childId) {
      const m = this.store.require(id);
      const { model, info } = await this.modelFor(m, parent, signal);
      const child = await this.deps.sessions.create({
        parentId: parent,
        agent: "lmb-agent",
        title: `Lumbre: ${m.title}`.slice(0, 120),
        instructions: await this.deps.instructions("agentFix", m.stack),
        tools: { allow: allowedTools("build") },
        readOnly: true,
        permission: { write: "deny", process: "deny" },
        maxTurns: AGENT_MAX_TURNS,
        timeoutMs: AGENT_RUN_TIMEOUT_MS,
        maxOutputTokens: budget(info).outputTokens,
        ...(model ? { model } : {}),
      });
      childId = child.id;
      st.childId = childId;
    }
    draft.state.done = null;
    this.agentRuns.set(childId, { projectId: id, mode: "build", draft, job });
    const cancel = () => this.deps.sessions.cancel(childId as string);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.deps.sessions.run(childId, prompt, { signal });
      if (job.diagnostics) job.diagnostics.runs++;
      signal.throwIfAborted();
      if (result.status === "failed") {
        if (job.diagnostics) job.diagnostics.reason = classifyFailure(result.error);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      this.agentRuns.delete(childId);
      await this.saveAgent(id, st);
    }
  }

  /**
   * Turns the draft into the usual reviewable proposal. `early`: the person asked for it before
   * the agent finished (the proposal is marked partial).
   */
  private async agentReview(
    id: string,
    early: boolean,
    job?: Job,
  ): Promise<Record<string, unknown>> {
    const st = await this.agentState(id);
    if (!st) throw new LumbreError("not_found");
    if (early && this.activeJob(id) && this.activeJob(id) !== job)
      throw new LumbreError("project_busy");
    const m = this.store.require(id);
    const draft = await this.agentDraft(id, st);
    const out = validateOutput(draft.toRaw(), {
      extras: m.extras,
      stack: this.stackOf(m),
      current: draft.baseFiles,
      owned: draft.owned,
    });
    const changed =
      Object.keys(out.files).length + out.deletes.length + Object.keys(out.dependencies).length;
    if (!changed) {
      await this.saveAgent(id, null);
      if (early) throw new LumbreError("not_found");
      await this.say(id, {
        role: "assistant",
        text: draft.state.done?.message || draft.state.done?.summary || "",
      });
      if (job) this.stage(job, "answered");
      return { proposalId: null };
    }
    const p: Proposal = {
      id: randomUUID(),
      base: draft.state.base,
      createdAt: Date.now(),
      summary: out.summary || draft.state.done?.summary || "Changes",
      message: out.message,
      files: out.files,
      deletes: out.deletes,
      dependencies: out.dependencies,
      ignored: out.ignored,
      fixAttempt: 0,
      ...(early || !draft.state.done
        ? { partial: { received: Object.keys(out.files).length, missing: [] } }
        : {}),
      ...(st.checkFailed ? { checkFailed: true } : {}),
    };
    await this.store.writeJson(id, "proposal", p);
    await this.saveAgent(id, null);
    await this.say(id, {
      role: "assistant",
      text: draft.state.done?.message || out.summary,
      proposalId: p.id,
    });
    if (st.checkFailed)
      await this.say(id, { role: "notice", text: "", notice: "agent_check_failed" });
    if (job) this.stage(job, "reviewReady");
    return { proposalId: p.id, checkFailed: st.checkFailed };
  }

  // ---------- preview, export ----------

  private async snapshot(m: ProjectMeta) {
    const s = this.stackOf(m);
    if (!s.npm) return { ...sourceSnapshot(await this.head(m), m.head), stale: false };
    const stored = await this.store.readJson<Snapshot | null>(m.id, "snapshot", null);
    if (s.css) {
      const css = await readFile(
        join(this.store.dir(m.id), "work", "styles", "tailwind.css"),
        "utf8",
      ).catch(() => undefined);
      return {
        ...sourceSnapshot(await this.head(m), m.head, css),
        stale: stored?.revision !== m.head,
      };
    }
    if (!stored)
      return { revision: null, at: null, kind: "none", html: "", css: [], assets: {}, stale: true };
    return { ...stored, stale: stored.revision !== m.head };
  }

  private async exportFiles(m: ProjectMeta) {
    return { ...(await this.head(m)), ...(await this.owned(m)) };
  }

  private async zip(m: ProjectMeta) {
    const folder = slug(m.title);
    const files = await this.exportFiles(m);
    const archive = zip(
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, content]) => ({
          name: `${folder}/${name}`,
          data: Buffer.from(content, "utf8"),
        })),
    );
    return { name: `${folder}.zip`, base64: archive.toString("base64") };
  }

  /** Writes the current version into a NEW (or empty) folder of the workspace. */
  private async exportTo(m: ProjectMeta, input: Input, ctx: PluginAppContext) {
    const folder = exportFolder(input.folder ?? slug(m.title));
    const workspace = await realpath(ctx.workspace).catch(() => {
      throw new LumbreError("invalid_path");
    });
    const target = resolve(workspace, ...folder.split("/"));
    // Every existing component must be a real folder inside the workspace.
    let probe = workspace;
    for (const part of folder.split("/")) {
      probe = join(probe, part);
      try {
        const info = await lstat(probe);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new LumbreError("export_exists");
      } catch (error) {
        if (error instanceof LumbreError) throw error;
        break;
      }
    }
    const rel = relative(workspace, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new LumbreError("invalid_path");
    if (existsSync(target) && (await readdir(target)).length)
      throw new LumbreError("export_exists");
    const files = await this.exportFiles(m);
    for (const [path, content] of Object.entries(files)) {
      const file = join(target, ...path.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, { flag: "wx", mode: 0o644 });
    }
    return { folder, files: Object.keys(files).length };
  }
}

/** Tool calling as the catalog states it: "yes", "no" or "unknown" (try, and detect). */
export function toolSupport(
  info:
    | { capabilities?: Record<string, unknown>; apiCapabilities?: Record<string, unknown> }
    | undefined,
): "yes" | "no" | "unknown" {
  for (const source of [info?.capabilities, info?.apiCapabilities])
    if (source)
      for (const [key, value] of Object.entries(source))
        if (
          /^(tool_?call(ing)?|tools|function_?call(ing)?|supports_?tools)$/i.test(key) &&
          typeof value === "boolean"
        )
          return value ? "yes" : "no";
  return "unknown";
}

/** Links the project's installed packages into the draft copy (a junction on Windows). */
async function linkModules(target: string, link: string) {
  const { lstat: stat, symlink } = await import("node:fs/promises");
  try {
    await stat(link);
    return;
  } catch {
    // not linked yet
  }
  if (!existsSync(target)) return;
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
