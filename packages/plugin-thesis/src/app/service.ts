// Thesis Studio action logic (spec §6.3), testable without a host. Every lifecycle step calls the
// same ThesisCoordinator methods as the chat commands (D2), on a job-scoped API facade (D3).
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { PluginAPI, PluginAppContext } from "@alisio/sdk";
import { parseDocument } from "yaml";
import { readClaims } from "../claims.js";
import { Blocked } from "../context.js";
import { type CoordinatorOptions, formatBuild, ThesisCoordinator } from "../coordinator.js";
import type { LockHolder, WorkspaceLock } from "../lock.js";
import { parseProtocol } from "../protocol.js";
import { parseAddedSource } from "../research/flow.js";
import {
  evidencePaths,
  type RejectedEntry,
  readJsonl,
  readLibrary,
  readSearchLog,
} from "../research/library.js";
import { readFindings } from "../review.js";
import {
  assertRelativePath,
  atomicWrite,
  ensureInside,
  readState,
  resolveInside,
  stateRevision,
  writeState,
} from "../storage.js";
import { type EvidenceRecord, gateNames, idPatterns, type ThesisState } from "../types.js";
import { thesisRootPath } from "../workspace.js";
import { CHILD_ACTIONS, effectOf, matchesSchema, SCHEMAS, type StudioAction } from "./actions.js";
import { jobApi } from "./facade.js";
import { type JobHooks, type JobOutcome, JobRegistry, StudioError } from "./jobs.js";
import { nextStep, presentationOpen, sectionStep } from "./views.js";

/** Real minimum host of the app: 0.11.5 shows apps but never prompts for write/process (§2). */
export const MIN_HOST = "0.11.6";

const MAX_ARTIFACT = 1024 * 1024;
const MAX_FILE = 256 * 1024;
const MAX_PDF = 60 * 1024 * 1024;
const MAX_IDEMPOTENT = 100;

/** Editable and read-only files the app may open (spec §7.2), relative to the thesis root. */
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,80}";
const EDITABLE = [
  /^thesis\.yaml$/,
  new RegExp(`^policy/${NAME}\\.yaml$`),
  new RegExp(`^data/${NAME}\\.csv$`),
];
const READ_ONLY = [
  new RegExp(`^styles/${NAME}\\.csl$`),
  new RegExp(`^styles/${NAME}\\.profile\\.yaml$`),
  new RegExp(`^policy-packs/(${NAME}/){0,4}${NAME}\\.(yaml|yml|json|md)$`),
];

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Replaces the workspace and home paths so no absolute path reaches the frame (§8). */
export function scrub(text: string, workspace: string): string {
  const root = resolve(workspace);
  let out = text.split(`${root}${sep}`).join("").split(root).join(".");
  const home = homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  return out;
}

export interface StudioDeps {
  api: PluginAPI;
  /** The activation's chat coordinator (shared scholarly client and read helpers). */
  coordinator: ThesisCoordinator;
  /** Coordinator options of the activation (test seams travel to job coordinators). */
  options: CoordinatorOptions;
  lock: WorkspaceLock;
}

/** Plain English job labels; the chat shows them when a command meets the lock. */
const LABELS: Partial<Record<StudioAction, (target?: string) => string>> = {
  "design.run": () => "the research plan draft",
  "outline.run": () => "the chapter plan draft",
  "research.run": (t) => `the research for ${t === "next" || !t ? "the next chapter" : t}`,
  "draft.run": (t) => `the draft of ${t === "next" || !t ? "the next chapter" : t}`,
  "figure.run": (t) => `a figure for ${t}`,
  "review.run": (t) => (t && t !== "all" ? `the review of ${t}` : "the review"),
  revise: (t) => `the changes to ${t}`,
  "next.run": () => "the next step",
  "styles.new": () => "a new citation style",
  "norms.import": () => "the norms import",
  "build.run": () => "a PDF build",
  "finalize.run": () => "the final document",
  "engine.setup": () => "the Typst installation",
  "doctor.run": () => "the engine check",
  approve: (t) => `an approval of ${t}`,
  "project.init": () => "the project setup",
  "interview.answer": () => "the interview answers",
  "check.run": () => "the checks",
  "packs.new": () => "a new rules pack",
  "files.write": () => "a file edit",
  "settings.setModel": () => "the model choice",
};

export class StudioService {
  readonly jobs: JobRegistry;
  private readonly idempotent = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(private readonly deps: StudioDeps) {
    this.jobs = new JobRegistry({
      cancelChild: (id) => {
        deps.api.sessions.cancel?.(id);
      },
    });
  }

  busy(): boolean {
    return this.jobs.busy();
  }

  /** Synchronous and idempotent: cancels this activation's jobs and releases their locks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobs.dispose();
    this.idempotent.clear();
  }

  async invoke(action: StudioAction, input: unknown, ctx: PluginAppContext): Promise<unknown> {
    const args = (input ?? {}) as Record<string, unknown>;
    if (!SCHEMAS[action] || !matchesSchema(args, SCHEMAS[action] as Record<string, unknown>))
      throw new StudioError("invalid_input");
    const key =
      effectOf(action) !== "read" && ctx.idempotencyKey
        ? `${action}\u0000${ctx.idempotencyKey}`
        : undefined;
    const known = key ? this.idempotent.get(key) : undefined;
    if (known) return known;
    const running = this.run(action, args, ctx);
    if (key) {
      this.idempotent.set(key, running);
      if (this.idempotent.size > MAX_IDEMPOTENT)
        this.idempotent.delete(this.idempotent.keys().next().value as string);
      running.catch(() => this.idempotent.delete(key));
    }
    return running;
  }

  // ------------------------------------------------------------------------------------------

  /** A coordinator over the facade; `inlineBuild` only for process work (D8). */
  private coordinatorFor(ctx: PluginAppContext, hooks: Partial<JobHooks>, inlineBuild = false) {
    const api = jobApi(this.deps.api, {
      workspace: ctx.workspace,
      signal: hooks.signal ?? ctx.signal,
      ...(hooks.progress ? { progress: hooks.progress } : {}),
      ...(hooks.child ? { child: hooks.child } : {}),
    });
    return new ThesisCoordinator(api, {
      ...this.deps.options,
      scholar: this.deps.coordinator.scholar,
      inlineBuild,
    });
  }

  private acquire(ctx: PluginAppContext, action: StudioAction, target?: string): () => void {
    const label = LABELS[action]?.(target) ?? action;
    const release = this.deps.lock.tryAcquire(ctx.workspace, "app", label);
    if (!release) {
      const holder = this.deps.lock.holderOf(ctx.workspace) as {
        holder: LockHolder;
        label: string;
      };
      throw new StudioError("busy", { holder: holder.holder, label: holder.label });
    }
    return release;
  }

  private async checkRevision(ctx: PluginAppContext, revision: unknown) {
    if (revision !== (await stateRevision(ctx.workspace))) throw new StudioError("conflict");
  }

  /** A short write under the lock, with the revision guard when given (D4, D5). */
  private async locked<T>(
    ctx: PluginAppContext,
    action: StudioAction,
    target: string | undefined,
    revision: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquire(ctx, action, target);
    try {
      if (revision !== undefined) await this.checkRevision(ctx, revision);
      return await work();
    } finally {
      release();
    }
  }

  /** Starts long work as a job holding the lock (D6); returns at once with its id. */
  private async job(
    ctx: PluginAppContext,
    action: StudioAction,
    target: string | undefined,
    revision: unknown,
    work: (coordinator: ThesisCoordinator, hooks: JobHooks) => Promise<JobOutcome | string>,
    inlineBuild = false,
  ): Promise<{ jobId: string }> {
    const release = this.acquire(ctx, action, target);
    try {
      if (revision !== undefined) await this.checkRevision(ctx, revision);
    } catch (error) {
      release();
      throw error;
    }
    const view = this.jobs.start(
      { kind: action, label: LABELS[action]?.(target) ?? action, ...(target ? { target } : {}) },
      release,
      async (hooks) => {
        const coordinator = this.coordinatorFor(ctx, hooks, inlineBuild);
        let outcome: JobOutcome;
        try {
          const done = await work(coordinator, hooks);
          outcome = typeof done === "string" ? { text: done } : done;
        } catch (error) {
          if (error instanceof Blocked)
            throw new StudioError("blocked", { reason: scrub(error.message, ctx.workspace) });
          throw error;
        }
        if (outcome.text !== undefined) outcome.text = this.decided(outcome.text, ctx);
        const notice = coordinator.takeModelNotice(ctx.workspace);
        return notice ? { ...outcome, notice } : outcome;
      },
    );
    return { jobId: view.id };
  }

  /** Coordinator text, scrubbed; "Blocked: ..." becomes the `blocked` code with its reason. */
  private decided(text: string, ctx: PluginAppContext): string {
    const clean = scrub(text, ctx.workspace)
      .split("\n")
      .filter((line) => line !== "Build skipped.")
      .join("\n");
    if (clean.startsWith("Blocked: "))
      throw new StudioError("blocked", { reason: clean.slice("Blocked: ".length) });
    return clean;
  }

  /** §7.1: no listed model and no active model means no child can run. */
  private async requireModel(ctx: PluginAppContext) {
    const models = this.deps.api.models;
    if (!models?.list) return;
    let listed = 0;
    try {
      listed = (await models.list(ctx.signal)).length;
    } catch {
      listed = 0;
    }
    let active = "";
    try {
      active = this.deps.api.sessions.model?.(ctx.sessionId) ?? "";
    } catch {
      active = "";
    }
    if (listed === 0 && !active) throw new StudioError("no_model");
  }

  private async state(ctx: PluginAppContext): Promise<ThesisState> {
    const state = await readState(ctx.workspace);
    if (!state) throw new StudioError("not_initialized");
    return state;
  }

  private async base(ctx: PluginAppContext, state: ThesisState): Promise<string> {
    return thesisRootPath(ctx.workspace, state.root);
  }

  // ------------------------------------------------------------------------------------------

  private async run(
    action: StudioAction,
    input: Record<string, unknown>,
    ctx: PluginAppContext,
  ): Promise<unknown> {
    if (CHILD_ACTIONS.includes(action)) await this.requireModel(ctx);
    const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
    switch (action) {
      case "status":
        return this.status(ctx);
      case "interview.get": {
        const state = await readState(ctx.workspace);
        return {
          pending: state?.pendingQuestions ?? null,
          completedRounds: state?.intake.completedRounds ?? [],
          languageHint: state?.intake.languageHint ?? null,
          presentationOpen: state ? presentationOpen(state) : false,
        };
      }
      case "artifact.get":
        return this.artifact(ctx, str("kind"), str("section"));
      case "evidence.list":
        return this.evidence(ctx, input);
      case "claims.list": {
        const state = await this.state(ctx);
        const claims = await readClaims(await this.base(ctx, state)).catch(() => []);
        return { claims: claims.filter((c) => !str("section") || c.section === str("section")) };
      }
      case "findings.list": {
        const state = await this.state(ctx);
        const findings = await readFindings(await this.base(ctx, state));
        return {
          findings: findings.filter((f) => !str("status") || f.status === str("status")),
          blocking: findings.filter(
            (f) => f.status === "open" && (f.severity === "critical" || f.severity === "major"),
          ).length,
        };
      }
      case "check.last":
        return { report: await this.lastReport(ctx) };
      case "packs.list":
        return { text: await this.readText(ctx, (c) => c.pack("list", ctx.sessionId)) };
      case "packs.explain":
        return {
          text: await this.readText(ctx, (c) => c.pack(`explain ${str("query")}`, ctx.sessionId)),
        };
      case "packs.check":
        return { text: await this.readText(ctx, (c) => c.pack("check", ctx.sessionId)) };
      case "styles.list":
        return { text: await this.readText(ctx, (c) => c.style("list", ctx.sessionId)) };
      case "files.list":
        return this.filesList(ctx);
      case "files.read":
        return this.fileRead(ctx, str("path"));
      case "pdf.get":
        return this.pdf(ctx, str("which"));
      case "models.list":
        return this.models(ctx);
      case "jobs.get": {
        const job = this.jobs.get(str("jobId"));
        if (!job) throw new StudioError("not_found");
        return job;
      }

      case "project.init": {
        const parts = [
          ...(str("dir") ? [str("dir")] : []),
          ...(str("lang") ? ["--lang", str("lang")] : []),
          ...(input.presentation === true ? ["--presentation"] : []),
        ];
        return this.locked(ctx, action, undefined, undefined, async () => {
          let text: string;
          try {
            text = await this.coordinatorFor(ctx, {}).init(parts.join(" "), ctx.sessionId);
          } catch (error) {
            if (error instanceof Error && !(error instanceof StudioError))
              throw new StudioError("invalid_input");
            throw error;
          }
          const state = await readState(ctx.workspace);
          return { text: scrub(text, ctx.workspace), pending: state?.pendingQuestions ?? null };
        });
      }
      case "interview.answer":
        return this.locked(ctx, action, undefined, undefined, async () => {
          const state = await this.state(ctx);
          if (!state.pendingQuestions) throw new StudioError("not_found");
          const answers = input.answers as Record<string, string>;
          const outcome = await this.coordinatorFor(ctx, {}).answerFromApp(ctx.workspace, answers);
          if (!outcome.ok) {
            // Question ids only: never the rejected value (§8).
            const ids = state.pendingQuestions.questions.map((q) => q.id);
            const fields = [
              ...new Set(
                outcome.errors.map(
                  (error) => ids.find((id) => error.startsWith(`${id}:`)) ?? "_form",
                ),
              ),
            ];
            throw new StudioError("invalid_input", { fields });
          }
          const after = await readState(ctx.workspace);
          return {
            pending: after?.pendingQuestions ?? null,
            completedRounds: after?.intake.completedRounds ?? [],
            phase: after?.phase ?? null,
          };
        });
      case "approve": {
        const target = str("target");
        return this.locked(ctx, action, target, input.revision, async () => {
          const notes = str("notes").trim();
          const text = await this.coordinatorFor(ctx, {}).approve(
            `${target}${notes ? ` -- ${notes}` : ""}`,
            ctx.sessionId,
          );
          const result = this.decided(text, ctx);
          const after = await readState(ctx.workspace);
          return {
            text: result,
            // D8: the frame starts `build.run { scope: "approved" }` after a chapter approval.
            buildAfter:
              idPatterns.section.test(target) && after?.sections[target]?.status === "approved",
          };
        });
      }
      case "revise": {
        const target = str("target");
        return this.job(ctx, action, target, input.revision, (c) =>
          c.revise(`${target} -- ${str("feedback")}`, ctx.sessionId),
        );
      }
      case "design.run":
        return this.job(ctx, action, undefined, undefined, (c) => c.design("", ctx.sessionId));
      case "outline.run":
        return this.job(ctx, action, undefined, undefined, (c) => c.outline("", ctx.sessionId));
      case "research.run": {
        const section = str("section");
        const add = str("add").trim();
        const more = str("more").trim();
        if (add && parseAddedSource(add).error) throw new StudioError("invalid_input");
        const tail = add ? ` -- add ${add}` : more ? ` -- ${more}` : "";
        return this.job(ctx, action, section, undefined, (c) =>
          c.research(`${section}${tail}`, ctx.sessionId),
        );
      }
      case "draft.run": {
        const section = str("section");
        const feedback = str("feedback").trim();
        return this.job(ctx, action, section, undefined, (c) =>
          c.draft(`${section}${feedback ? ` -- ${feedback}` : ""}`, ctx.sessionId),
        );
      }
      case "figure.run": {
        const section = str("section");
        return this.job(ctx, action, section, undefined, (c) =>
          c.figure(`${section} -- ${str("request")}`, ctx.sessionId),
        );
      }
      case "review.run": {
        const target = str("target");
        return this.job(ctx, action, target, undefined, (c) => c.review(target, ctx.sessionId));
      }
      case "next.run":
        return this.job(ctx, action, undefined, undefined, (c) => c.next("", ctx.sessionId));
      case "styles.new": {
        const id = str("id");
        return this.job(ctx, action, id, undefined, (c) =>
          c.style(`new ${id} -- ${str("guide")}`, ctx.sessionId),
        );
      }
      case "norms.import":
        return this.job(ctx, action, undefined, undefined, (c) =>
          c.norms(`import -- ${str("guide")}`, ctx.sessionId),
        );
      case "check.run": {
        const gates = Array.isArray(input.gates) ? (input.gates as string[]) : [];
        return this.locked(ctx, action, undefined, undefined, async () => {
          await this.state(ctx);
          await this.coordinatorFor(ctx, {}).check(gates.join(" "), ctx.sessionId);
          return { report: await this.lastReport(ctx) };
        });
      }
      case "packs.new":
        return this.locked(ctx, action, undefined, undefined, async () => {
          await this.state(ctx);
          const text = await this.coordinatorFor(ctx, {}).pack(
            `new ${str("scope")} ${str("id")}`,
            ctx.sessionId,
          );
          return { text: this.decided(text, ctx) };
        });
      case "files.write":
        return this.fileWrite(ctx, str("path"), str("content"), str("revision"));
      case "settings.setModel":
        return this.locked(ctx, action, undefined, input.revision, async () => {
          const state = await this.state(ctx);
          let model: string | null = null;
          if (typeof input.model === "string" && input.model.trim()) {
            try {
              const resolved = await this.deps.api.models?.resolve(input.model.trim(), ctx.signal);
              if (!resolved?.reference) throw new Error("unresolved");
              model = resolved.reference;
            } catch {
              throw new StudioError("unknown_model");
            }
          }
          state.settings = { ...(state.settings ?? {}), model };
          await writeState(ctx.workspace, state);
          return { chosen: model, revision: await stateRevision(ctx.workspace) };
        });
      case "jobs.cancel": {
        const id = str("jobId");
        if (!this.jobs.get(id)) throw new StudioError("not_found");
        return { cancelled: this.jobs.cancel(id) };
      }

      case "build.run": {
        const scope = str("scope") as "full" | "approved" | "section";
        const section = str("section");
        if (scope === "section" && !section) throw new StudioError("invalid_input");
        return this.job(
          ctx,
          action,
          scope === "section" ? section : scope,
          undefined,
          async (c, hooks) => {
            const outcome = await c.buildRun(
              ctx.workspace,
              {
                scope,
                ...(scope === "section" ? { section } : {}),
                ...(input.pdfa === true ? { pdfa: true } : {}),
                ...(str("format") ? { format: str("format") } : {}),
              },
              hooks.signal,
            );
            const relative = outcome.path ? scrub(outcome.path, ctx.workspace) : null;
            return {
              text: formatBuild(outcome),
              value: {
                ok: outcome.ok,
                path: relative,
                engine: outcome.engine,
                ms: outcome.ms,
                pages: outcome.pages ?? null,
                warnings: outcome.warnings.slice(0, 20).map((w) => scrub(w, ctx.workspace)),
                errors: outcome.findings
                  .filter((f) => f.severity === "error")
                  .slice(0, 20)
                  .map((f) => ({
                    code: f.code,
                    message: scrub(f.message, ctx.workspace),
                    ...(f.file ? { file: scrub(f.file, ctx.workspace) } : {}),
                    ...(f.line ? { line: f.line } : {}),
                  })),
              },
            };
          },
          true,
        );
      }
      case "finalize.run":
        return this.job(
          ctx,
          action,
          undefined,
          undefined,
          (c) => c.finalize("", ctx.sessionId),
          true,
        );
      case "engine.setup":
        return this.job(ctx, action, undefined, undefined, (c) => c.setup(""), true);
      case "doctor.run":
        return this.job(
          ctx,
          action,
          undefined,
          undefined,
          async (c) => {
            const report = await c.doctorReport();
            return {
              value: {
                engineAvailable: report.engineAvailable,
                items: report.items.map((item) => ({
                  ...item,
                  detail: scrub(item.detail, ctx.workspace),
                })),
              },
            };
          },
          true,
        );
      default:
        throw new StudioError("invalid_input");
    }
  }

  // ---------- reads -----------------------------------------------------------------------

  private async readText(
    ctx: PluginAppContext,
    read: (coordinator: ThesisCoordinator) => Promise<string>,
  ): Promise<string> {
    await this.state(ctx);
    try {
      return scrub(await read(this.coordinatorFor(ctx, {})), ctx.workspace);
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw new StudioError("operation_failed");
    }
  }

  private async status(ctx: PluginAppContext) {
    const state = await readState(ctx.workspace);
    const coordinator = this.deps.coordinator;
    const common = {
      revision: await stateRevision(ctx.workspace),
      job: this.jobs.running() ?? null,
      lock: this.deps.lock.holderOf(ctx.workspace) ?? null,
      minHost: MIN_HOST,
    };
    if (!state)
      return {
        initialized: false,
        nextStep: nextStep(undefined, (s) => coordinator.nextCommandFor(s)),
        ...common,
      };
    const base = await this.base(ctx, state);
    return {
      initialized: true,
      root: state.root,
      phase: state.phase,
      title: await this.title(base),
      gates: Object.fromEntries(
        gateNames.map((name) => [
          name,
          { status: state.humanGates[name].status, at: state.humanGates[name].at ?? null },
        ]),
      ),
      sections: Object.keys(state.sections)
        .sort()
        .map((id) => {
          const section = state.sections[id] as ThesisState["sections"][string];
          return {
            id,
            title: section.title ?? null,
            status: section.status,
            role: section.role ?? null,
            dependsOn: section.dependsOn ?? [],
            hasChapter: Boolean(section.chapter),
            hasDossier: Boolean(section.dossierAt),
            next: sectionStep(coordinator.sectionNextFor(state, id), state),
          };
        }),
      intake: {
        completedRounds: state.intake.completedRounds,
        pendingRound: state.pendingQuestions?.round ?? null,
        presentationOpen: presentationOpen(state),
      },
      protocolDrafted: state.protocolAt !== undefined,
      outlineDrafted: state.outlineAt !== undefined,
      lastCheck: state.lastCheck ?? null,
      lastBuild: state.lastBuild ? { ...state.lastBuild } : null,
      lastReview: state.lastReview ?? null,
      finalBuild: state.finalBuild ? { at: state.finalBuild.at, pdf: state.finalBuild.pdf } : null,
      submittedAt: state.submittedAt ?? null,
      ethics: await this.ethics(base, state),
      authoring: await this.authoring(base),
      model: { chosen: state.settings?.model ?? null },
      nextStep: nextStep(state, (s) => coordinator.nextCommandFor(s)),
      ...common,
    };
  }

  private async title(base: string): Promise<string | null> {
    try {
      const doc = parseDocument(await readFile(join(base, "thesis.yaml"), "utf8"));
      const title = doc.get("title");
      return typeof title === "string" ? title.slice(0, 300) : null;
    } catch {
      return null;
    }
  }

  private async ethics(base: string, state: ThesisState) {
    try {
      const parsed = parseProtocol(await readFile(join(base, "research", "protocol.md"), "utf8"));
      const list = Array.isArray(parsed.data?.ethicsRequirements)
        ? (parsed.data.ethicsRequirements as { id?: unknown; text?: unknown }[])
        : [];
      return list
        .filter((entry) => typeof entry.id === "string")
        .map((entry) => ({
          id: entry.id as string,
          text: typeof entry.text === "string" ? entry.text : "",
          resolution: state.ethicsResolutions?.[entry.id as string]?.text ?? null,
        }));
    } catch {
      return [];
    }
  }

  private async authoring(base: string) {
    try {
      const names = await readdir(join(base, "build", "authoring"));
      const out: { kind: string; id: string; questions: string[] }[] = [];
      for (const name of names.filter((n) => /^(style-[a-z0-9-]+|norms)\.json$/.test(n))) {
        try {
          const pending = JSON.parse(
            await readFile(join(base, "build", "authoring", name), "utf8"),
          );
          const draft = pending.style ?? pending.norms ?? {};
          out.push({
            kind: pending.kind === "style" ? "style" : "norms",
            id: typeof pending.id === "string" ? pending.id : "norms",
            questions: Array.isArray(draft.questions)
              ? draft.questions.filter((q: unknown) => typeof q === "string").slice(0, 20)
              : [],
          });
        } catch {
          // A damaged pending draft is reported by its own flow.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async lastReport(ctx: PluginAppContext) {
    const state = await this.state(ctx);
    try {
      return JSON.parse(
        await readFile(join(await this.base(ctx, state), "build", "check-report.json"), "utf8"),
      );
    } catch {
      return null;
    }
  }

  private async artifact(ctx: PluginAppContext, kind: string, section: string) {
    const state = await this.state(ctx);
    const base = await this.base(ctx, state);
    let relative: string;
    const extra: Record<string, unknown> = {};
    switch (kind) {
      case "protocol":
        relative = "research/protocol.md";
        break;
      case "outline": {
        relative = "outline/outline.md";
        try {
          const doc = JSON.parse(await readFile(join(base, "outline", "outline.json"), "utf8"));
          const tree = (nodes: unknown): unknown[] =>
            Array.isArray(nodes)
              ? nodes.map((n: { id?: unknown; title?: unknown; children?: unknown }) => ({
                  id: String(n.id ?? ""),
                  title: String(n.title ?? ""),
                  children: tree(n.children),
                }))
              : [];
          extra.tree = tree(doc.sections);
        } catch {
          extra.tree = [];
        }
        break;
      }
      case "chapter": {
        const chapter = state.sections[section]?.chapter;
        if (!idPatterns.section.test(section) || !chapter) return { text: null, findings: [] };
        relative = chapter;
        extra.claims = (await readClaims(base).catch(() => [])).filter(
          (c) => c.section === section,
        );
        break;
      }
      case "dossier":
        if (!idPatterns.section.test(section)) throw new StudioError("invalid_input");
        relative = `${evidencePaths.dossiers}/${section}.md`;
        break;
      default:
        throw new StudioError("invalid_input");
    }
    let absolute: string;
    try {
      absolute = resolveInside(base, assertRelativePath(relative));
      await ensureInside(base, absolute);
    } catch {
      throw new StudioError("path_not_allowed");
    }
    let text: string | null = null;
    try {
      const info = await stat(absolute);
      if (info.size > MAX_ARTIFACT) throw new StudioError("too_large");
      text = await readFile(absolute, "utf8");
    } catch (error) {
      if (error instanceof StudioError) throw error;
      text = null;
    }
    let findings: unknown[] = [];
    if (text !== null && (kind === "protocol" || kind === "outline")) {
      try {
        const report = await this.deps.coordinator.checkReadOnly(ctx.workspace, {
          gates: [kind === "protocol" ? "G1" : "G4"],
        });
        findings = report.findings.map((f) => ({
          code: f.code,
          severity: f.severity,
          message: scrub(f.message, ctx.workspace),
          ...(f.hint ? { hint: scrub(f.hint, ctx.workspace) } : {}),
        }));
      } catch {
        findings = [];
      }
    }
    return {
      kind,
      section: section || null,
      path: `${state.root}/${relative}`,
      text,
      findings,
      ...extra,
    };
  }

  private async evidence(ctx: PluginAppContext, input: Record<string, unknown>) {
    const state = await this.state(ctx);
    const base = await this.base(ctx, state);
    const offset = typeof input.offset === "number" ? input.offset : 0;
    const limit = typeof input.limit === "number" ? input.limit : 50;
    const tab = typeof input.tab === "string" ? input.tab : "library";
    if (tab === "rejected") {
      const rejected = await readJsonl<RejectedEntry>(join(base, evidencePaths.rejected));
      return { tab, total: rejected.length, records: rejected.slice(offset, offset + limit) };
    }
    if (tab === "log") {
      const log = await readSearchLog(base);
      return { tab, total: log.length, records: log.slice(offset, offset + limit) };
    }
    let library: EvidenceRecord[] = [];
    try {
      library = await readLibrary(base);
    } catch {
      library = [];
    }
    const section = typeof input.section === "string" ? input.section : "";
    const status = typeof input.status === "string" ? input.status : "";
    const needle = typeof input.text === "string" ? input.text.trim().toLowerCase() : "";
    const filtered = library.filter(
      (r) =>
        (!section || r.sections.includes(section)) &&
        (!status || r.status === status) &&
        (!needle ||
          [r.title, r.citeKey, r.doi ?? "", ...r.authors.map((a) => a.family)]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
    const byStatus: Record<string, number> = {};
    for (const record of library) byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    return {
      tab,
      total: library.length,
      filtered: filtered.length,
      byStatus,
      records: filtered.slice(offset, offset + limit).map((r) => ({
        id: r.id,
        citeKey: r.citeKey,
        type: r.type,
        title: r.title,
        authors: r.authors.map((a) => [a.given, a.family].filter(Boolean).join(" ")),
        year: r.year,
        containerTitle: r.containerTitle ?? null,
        doi: r.doi ?? null,
        url: r.url ?? null,
        status: r.status,
        sections: r.sections,
        verification: r.verification,
        appraisal: r.appraisal,
        permittedUse: r.permittedUse,
      })),
    };
  }

  private async models(ctx: PluginAppContext) {
    let listed: { reference: string; name: string; provider: string }[] = [];
    try {
      const all = (await this.deps.api.models?.list(ctx.signal)) ?? [];
      listed = all.slice(0, 1000).map((m) => ({
        reference: m.reference,
        name: m.model?.name || m.model?.id || m.reference,
        provider: m.providerName || m.provider,
      }));
    } catch {
      listed = [];
    }
    let active = "";
    try {
      active = this.deps.api.sessions.model?.(ctx.sessionId) ?? "";
    } catch {
      active = "";
    }
    const chosen = (await readState(ctx.workspace).catch(() => undefined))?.settings?.model ?? null;
    return {
      models: listed,
      active: active || null,
      chosen,
      chosenAvailable: chosen ? listed.some((m) => m.reference === chosen) : true,
    };
  }

  // ---------- files and PDF ------------------------------------------------------------------

  private async allowed(ctx: PluginAppContext, path: string) {
    const editable = EDITABLE.some((pattern) => pattern.test(path));
    const readOnly = READ_ONLY.some((pattern) => pattern.test(path));
    if (!editable && !readOnly) throw new StudioError("path_not_allowed");
    const state = await this.state(ctx);
    const base = await this.base(ctx, state);
    let absolute: string;
    try {
      absolute = resolveInside(base, assertRelativePath(path));
      await ensureInside(base, absolute);
    } catch {
      throw new StudioError("path_not_allowed");
    }
    return { absolute, editable, display: `${state.root}/${path}` };
  }

  private async filesList(ctx: PluginAppContext) {
    const state = await this.state(ctx);
    const base = await this.base(ctx, state);
    const files: { path: string; display: string; editable: boolean; bytes: number }[] = [];
    const visit = async (dir: string, depth: number) => {
      if (depth > 5 || files.length >= 500) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(join(base, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (["policy", "data", "styles", "policy-packs"].includes(path.split("/")[0] ?? ""))
            await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const editable = EDITABLE.some((p) => p.test(path));
        if (!editable && !READ_ONLY.some((p) => p.test(path))) continue;
        const info = await stat(join(base, path)).catch(() => undefined);
        files.push({ path, display: `${state.root}/${path}`, editable, bytes: info?.size ?? 0 });
      }
    };
    await visit("", 0);
    return { root: state.root, files };
  }

  private async fileRead(ctx: PluginAppContext, path: string) {
    const { absolute, editable, display } = await this.allowed(ctx, path);
    let bytes: Buffer;
    try {
      const info = await stat(absolute);
      if (info.size > MAX_FILE) throw new StudioError("too_large");
      bytes = await readFile(absolute);
    } catch (error) {
      if (error instanceof StudioError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path, display, editable, text: "", revision: "none" };
      throw new StudioError("operation_failed");
    }
    return { path, display, editable, text: bytes.toString("utf8"), revision: sha256(bytes) };
  }

  private async fileWrite(ctx: PluginAppContext, path: string, content: string, revision: string) {
    const { absolute, editable } = await this.allowed(ctx, path);
    if (!editable) throw new StudioError("path_not_allowed");
    if (Buffer.byteLength(content) > MAX_FILE) throw new StudioError("too_large");
    if (path.endsWith(".yaml")) {
      const doc = parseDocument(content);
      const error = doc.errors[0];
      if (error) {
        const position = error.linePos?.[0];
        throw new StudioError("invalid_input", {
          line: position?.line ?? null,
          column: position?.col ?? null,
        });
      }
    }
    return this.locked(ctx, "files.write", undefined, undefined, async () => {
      let current = "none";
      try {
        current = sha256(await readFile(absolute));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new StudioError("operation_failed");
      }
      if (current !== revision) throw new StudioError("conflict");
      await atomicWrite(absolute, content);
      let findings: unknown[] = [];
      if (path === "thesis.yaml") {
        try {
          const report = await this.deps.coordinator.checkReadOnly(ctx.workspace, {
            gates: ["G0"],
          });
          findings = report.findings.map((f) => ({
            code: f.code,
            severity: f.severity,
            message: scrub(f.message, ctx.workspace),
            ...(f.line ? { line: f.line } : {}),
          }));
        } catch {
          findings = [];
        }
      }
      return { revision: sha256(content), findings };
    });
  }

  private async pdf(ctx: PluginAppContext, which: string) {
    const state = await this.state(ctx);
    const relative = which === "final" ? state.finalBuild?.pdf : state.lastBuild?.pdf;
    if (!relative) throw new StudioError("not_found");
    let absolute: string;
    try {
      absolute = resolveInside(ctx.workspace, assertRelativePath(relative));
      await ensureInside(ctx.workspace, absolute);
    } catch {
      throw new StudioError("path_not_allowed");
    }
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      throw new StudioError("not_found");
    }
    if (size > MAX_PDF) throw new StudioError("too_large", { path: relative });
    const bytes = await readFile(absolute);
    return { base64: bytes.toString("base64"), bytes: bytes.length, path: relative };
  }
}
