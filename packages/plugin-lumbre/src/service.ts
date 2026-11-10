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
import { errorCode, LumbreError, type LumbreErrorCode } from "./errors.js";
import { budget, buildPrompt, type ChatMessage, type Ignored, parseOutput } from "./generate.js";
import {
  isStackId,
  nodeAtLeast,
  packageJson,
  presetLock,
  STACK_IDS,
  type Stack,
  stack,
} from "./presets.js";
import { type ProjectRuntime, type RuntimeOptions, reapOrphans } from "./runtime.js";
import { exportFolder, type Files, filePath, isManagedPath, LIMITS, text } from "./safety.js";
import { buildSnapshot, type Snapshot, sourceSnapshot } from "./snapshot.js";
import { isId, type ProjectMeta, ProjectStore } from "./store.js";
import { VERSION } from "./version.js";
import { syncWork } from "./workdir.js";
import { zip } from "./zip.js";

export const MIN_HOST = "0.11.6";
export const MAX_FIX_ATTEMPTS = 2;
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
  instructions(mode: "build" | "fix"): Promise<string>;
  npmCli(): string;
  runtime(options: RuntimeOptions): RuntimeLike;
  openUrl(url: string): Promise<void>;
  idleMs?: number;
}

type JobKind = "generate" | "check" | "install" | "start";
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
  private idleTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

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
    const files: Files = { ...s.owned };
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
    return {
      ...job,
      elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
      log: job.log.slice(-8_000),
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
    const first: Step = { key: kind === "generate" ? "thinking" : "preparing", at: now };
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
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    // Keep finished jobs for a while so the frame can read their outcome.
    for (const [id, j] of this.jobs)
      if (j.state !== "running" && this.jobs.size > 40) this.jobs.delete(id);
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
    await this.say(m.id, { role: "user", text: request });
    return this.startJob(m, "generate", (job, signal) =>
      this.generate(m.id, job, signal, ctx.sessionId, { request, locale, fixAttempt: 0 }),
    );
  }

  /** One builder pass in a child session; stores a proposal when the model changed something. */
  private async generate(
    id: string,
    job: Job,
    signal: AbortSignal,
    parent: string,
    pass: { request: string; locale: "en" | "es"; fixAttempt: number; errorLog?: string },
  ) {
    const m = this.store.require(id);
    const s = this.stackOf(m);
    try {
      const { model, info, fallback } = await this.modelFor(m, parent, signal);
      const b = budget(info);
      const files = await this.head(m);
      const owned = Object.keys(await this.owned(m));
      const history = (await this.chat(id)).slice(0, pass.fixAttempt ? undefined : -1);
      const { prompt, omitted } = buildPrompt({
        stack: s,
        request: pass.request,
        chat: history,
        files,
        owned,
        inputChars: b.inputChars,
        locale: pass.locale,
        ...(pass.errorLog !== undefined ? { errorLog: pass.errorLog } : {}),
      });
      this.stage(
        job,
        pass.fixAttempt
          ? "fixing"
          : Object.keys(files).length > 3 && history.length
            ? "thinkingChanges"
            : "thinking",
        pass.fixAttempt ? { attempt: pass.fixAttempt, max: MAX_FIX_ATTEMPTS } : undefined,
      );
      const child = await this.deps.sessions.create({
        parentId: parent,
        agent: "lmb-builder",
        title: `Lumbre: ${m.title}`.slice(0, 120),
        instructions: await this.deps.instructions(pass.fixAttempt ? "fix" : "build"),
        tools: { allow: [] },
        readOnly: true,
        permission: { write: "deny", process: "deny" },
        maxTurns: 2,
        maxTokens: b.contextTokens,
        maxOutputTokens: b.outputTokens,
        timeoutMs: 6 * 60_000,
        ...(model ? { model } : {}),
      });
      const cancel = () => this.deps.sessions.cancel(child.id);
      signal.addEventListener("abort", cancel, { once: true });
      let result: ChildRunResult;
      try {
        result = await this.deps.sessions.run(child.id, prompt, { signal });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      signal.throwIfAborted();
      if (result.status !== "completed" && !result.turnsExceeded)
        throw new LumbreError("agent_failed");
      this.stage(job, "reading");
      const out = parseOutput(result.text, { stack: s, current: files, owned, omitted });
      const changed = [...Object.keys(out.files), ...out.deletes];
      for (const [i, path] of changed.entries())
        this.stage(
          job,
          Object.hasOwn(out.files, path) ? "writing" : "removing",
          { file: path, index: i + 1, count: changed.length },
          (i + 1) / changed.length,
        );
      const hasChanges = changed.length > 0 || Object.keys(out.dependencies).length > 0;
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
      });
      this.stage(job, proposalId ? "reviewReady" : "answered");
      return { proposalId: proposalId ?? null, ignored: out.ignored, omitted };
    } catch (error) {
      const code = signal.aborted ? "cancelled" : errorCode(error);
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
