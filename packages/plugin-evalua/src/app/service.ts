import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { buildBlueprint } from "../blueprint.js";
import { type CapacityShortfall, shortfallsFromFindings } from "../capacity.js";
import { DEFAULT_ROOT, type EvaluaCoordinator } from "../coordinator.js";
import { type ExamSpec, parseExam } from "../exam.js";
import { familyIds } from "../families/index.js";
import { generateExam } from "../generate.js";
import { inlineHtml, markupHtml } from "../html/emit.js";
import { parseItemsFile } from "../items-file.js";
import { evaluaMathRenderer } from "../katex.js";
import { shippedLocalesDir } from "../knowledge/index.js";
import {
  LogoError,
  readProfile,
  saveLogoBytes,
  validateProfile,
  writeProfile,
} from "../profile.js";
import { emptyState, readState, stateFile } from "../storage.js";
import type { EvaluaState, TeacherProfile } from "../types.js";
import { listExamFolders, nextExamNumber } from "../workspace.js";
import { AppError } from "./errors.js";
import type { AppJobs } from "./jobs.js";
import { type BuildFinding, readPrefs, writePrefs } from "./prefs.js";
import { capacityErrors, runWizard, WIZARD_FIELDS, type WizardAnswers } from "./wizard.js";
import { buildWordingPrompt, parseWordingOutput, validateTemplates } from "./wording.js";

/** What a handler knows about the call (the host's `PluginAppContext`). */
export interface ActionContext {
  sessionId: string;
  workspace: string;
  signal: AbortSignal;
  idempotencyKey?: string;
}

type Input = Record<string, unknown>;

/** Waiting for the chat's lock longer than this answers `busy` (handlers time out at 30 s). */
export const LOCK_WAIT_MS = 10_000;
/** Largest document `docs.get` returns: its base64 must stay under the 90 MiB result limit. */
export const MAX_DOC_BYTES = 64 * 1024 * 1024;
const IDEMPOTENCY_ENTRIES = 64;

export const DOCS = {
  exam: "01_examen_estudiante",
  sheet: "02_hoja_respuestas",
  book: "03_solucionario_completo",
  rubric: "04_rubrica_calificacion",
} as const;
type DocKind = keyof typeof DOCS;

const examIdPattern = /^e[0-9]{2,3}$/;
const jobIdPattern = /^[a-z0-9]{12}$/;
const LOGO_MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
/** Phases in which the wording, the questions and the documents can still change (D9). */
const EDITABLE = ["approved-a", "generated", "built"];

// ---- input readers (the host validates the schema too; tests call handlers directly) ---------

function invalid(): never {
  throw new AppError("invalid_input");
}
function str(input: Input, key: string, max: number, { optional = false, min = 0 } = {}) {
  const value = input[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > max || value.length < min) invalid();
  return value;
}
function oneOf<T extends string>(input: Input, key: string, values: readonly T[]): T {
  const value = input[key];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) invalid();
  return value as T;
}
function int(input: Input, key: string, min: number, max: number, fallback: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid();
  }
  return value;
}
function bool(input: Input, key: string): boolean {
  const value = input[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") invalid();
  return value;
}

function wizardAnswers(value: unknown): WizardAnswers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const out: WizardAnswers = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(WIZARD_FIELDS as readonly string[]).includes(key)) invalid();
    if (key === "types") {
      if (!Array.isArray(entry) || entry.length > 4) invalid();
      out.types = entry.map((type) => {
        if (typeof type !== "string" || type.length > 40) invalid();
        return type;
      });
    } else {
      if (typeof entry !== "string" || entry.length > (key === "topic" ? 120 : 40)) invalid();
      (out as Record<string, string>)[key] = entry;
    }
  }
  return out;
}

function promptsInput(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const entries = Object.entries(value);
  if (entries.length > 20) invalid();
  const out: Record<string, string[]> = {};
  for (const [family, list] of entries) {
    if (family.length > 80 || !Array.isArray(list) || list.length > 5) invalid();
    out[family] = list.map((entry) => {
      if (typeof entry !== "string" || entry.length > 200) invalid();
      return entry;
    });
  }
  return out;
}

/** A content hash of what the app shows: state, profile and the active exam's spec (D2). */
export async function revisionOf(workspace: string): Promise<string> {
  const hash = createHash("sha256");
  const read = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  };
  const stateText = await read(stateFile(workspace));
  hash.update(stateText).update("\0");
  let state: EvaluaState | undefined;
  try {
    state = await readState(workspace);
  } catch {
    state = undefined;
  }
  const base = join(workspace, state?.root ?? DEFAULT_ROOT);
  hash.update(await read(join(base, "teacher.yaml"))).update("\0");
  if (state?.activeExamId) {
    for (const name of await listExamFolders(base).catch(() => [] as string[])) {
      const text = await read(join(base, "exams", name, "exam.yaml"));
      if (text.split("\n").includes(`id: ${state.activeExamId}`)) hash.update(text);
    }
  }
  return hash.digest("hex").slice(0, 24);
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Findings as the app shows them: id, severity and the plain message (no paths). */
const findingsOf = (list: readonly { id: string; severity: string; message: string }[]) =>
  list.map(
    (finding): BuildFinding => ({
      id: finding.id,
      severity: finding.severity === "error" ? "error" : "warning",
      message: finding.message,
    }),
  );

export interface ServiceDeps {
  api: PluginAPI;
  coordinator: EvaluaCoordinator;
  jobs: AppJobs;
}

/**
 * The Evalua app's backend (app spec D1): every action maps to the same coordinator the chat uses,
 * under its lock, with a revision check on mutations. One instance per activation.
 */
export class EvaluaAppService {
  private readonly done = new Map<string, unknown>();
  private locales: string[] | undefined;

  constructor(private readonly deps: ServiceDeps) {}

  private get coordinator() {
    return this.deps.coordinator;
  }

  async invoke(action: string, input: Input, ctx: ActionContext): Promise<unknown> {
    ctx.signal.throwIfAborted();
    const ws = ctx.workspace;
    switch (action) {
      case "status":
        return this.status(ws);
      case "catalog.list":
        return this.catalogList(ws, str(input, "grade", 40, { optional: true }));
      case "kb.check": {
        const report = (await this.coordinator.knowledgeFor(ws)).report;
        return { ok: report.ok, findings: report.results };
      }
      case "doctor":
        return this.doctor(ws);
      case "models.list":
        return this.modelList(ws, ctx.signal);
      case "draft.get":
        return this.draftGet(ws);
      case "wording.get":
        return this.wordingGet(ws);
      case "items.get":
        return this.itemsGet(ws, int(input, "offset", 0, 400, 0), int(input, "limit", 1, 50, 50));
      case "docs.get":
        return this.docsGet(ws, input);
      case "jobs.get": {
        const job = this.deps.jobs.get(str(input, "jobId", 12) as string);
        if (!job) throw new AppError("not_found");
        return job;
      }
      case "jobs.cancel": {
        const id = str(input, "jobId", 12) as string;
        if (!jobIdPattern.test(id)) invalid();
        const state = this.deps.jobs.cancel(id);
        if (state === undefined) throw new AppError("not_found");
        return { state };
      }
      case "models.choose":
        return this.modelsChoose(ws, input, ctx);
      case "profile.save":
        return this.mutate(input, ctx, () => this.profileSave(ws, input));
      case "profile.setLogo":
        return this.mutate(input, ctx, () => this.profileSetLogo(ws, input));
      case "profile.removeLogo":
        return this.mutate(input, ctx, () => this.profileRemoveLogo(ws));
      case "draft.create":
        return this.mutate(input, ctx, () => this.draftCreate(ws, input));
      case "draft.discard":
        return this.mutate(input, ctx, async () => {
          const state = await readState(ws);
          if (state?.draft) {
            delete state.draft;
            await this.coordinator.saveState(ws, state);
          }
          return {};
        });
      case "exam.approveA":
        return this.mutate(input, ctx, async () => {
          const state = await readState(ws);
          if (!state?.draft) throw new AppError("phase_mismatch");
          const result = await this.coordinator.approveCore(ws, "a");
          return { examId: result.examId, folder: result.folder };
        });
      case "wording.draft":
        return this.mutate(input, ctx, () => this.wordingDraft(ws, ctx));
      case "wording.save":
        return this.mutate(input, ctx, () => this.wordingSave(ws, input));
      case "exam.generate":
        return this.mutate(input, ctx, () => this.examGenerate(ws));
      case "exam.approveB":
        return this.mutate(input, ctx, () => this.approveB(ws, input));
      case "build.start":
        return this.mutate(input, ctx, () => this.buildStart(ws));
      default:
        throw new AppError("not_found");
    }
  }

  /**
   * Every state mutation: refused while the app's build runs (D3), serialized with the chat by the
   * coordinator's lock (D2), and checked against the revision the frame last saw. A retried
   * request (same idempotency key) returns the first result instead of `state_changed`.
   */
  private async mutate<T>(input: Input, ctx: ActionContext, write: () => Promise<T>) {
    const key = ctx.idempotencyKey;
    if (key !== undefined && this.done.has(key)) return this.done.get(key);
    const expected = str(input, "expectedRevision", 40);
    if (this.deps.jobs.running("build")) throw new AppError("busy");
    return this.coordinator.lock.run(
      async () => {
        if ((await revisionOf(ctx.workspace)) !== expected) throw new AppError("state_changed");
        const value = await write();
        const result = { ...(value as object), revision: await revisionOf(ctx.workspace) };
        if (key !== undefined) {
          this.done.set(key, result);
          if (this.done.size > IDEMPOTENCY_ENTRIES) {
            this.done.delete(this.done.keys().next().value as string);
          }
        }
        return result;
      },
      { timeoutMs: LOCK_WAIT_MS },
    );
  }

  // ---- reads ----------------------------------------------------------------------------------

  private async shippedLocales(): Promise<string[]> {
    if (this.locales) return this.locales;
    try {
      const names = await readdir(shippedLocalesDir());
      this.locales = names
        .filter((name) => /^[a-z]{2,3}\.yaml$/.test(name))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch {
      this.locales = ["es"];
    }
    return this.locales;
  }

  private async logoUrl(base: string, profile: TeacherProfile | undefined) {
    if (!profile?.logo) return undefined;
    const ext = profile.logo.split(".").pop() as string;
    const mime = LOGO_MIME[(ext === "jpeg" ? "jpg" : ext) as keyof typeof LOGO_MIME];
    try {
      return dataUrl(await readFile(join(base, profile.logo)), mime ?? "image/png");
    } catch {
      return undefined;
    }
  }

  private async exams(base: string, state: EvaluaState | undefined) {
    const out = [];
    for (const folder of await listExamFolders(base).catch(() => [] as string[])) {
      let spec: ExamSpec;
      try {
        spec = parseExam(await readFile(join(base, "exams", folder, "exam.yaml"), "utf8"));
      } catch {
        continue;
      }
      const has = async (name: string) =>
        stat(join(base, "exams", folder, name)).then(
          () => true,
          () => false,
        );
      const progress = state?.exams[spec.id];
      out.push({
        id: spec.id,
        number: spec.number,
        folder,
        title: spec.title,
        theme: spec.theme,
        grade: spec.grade,
        level: spec.level,
        questionCount: spec.questionCount,
        phase: progress?.phase ?? spec.status,
        gates: progress?.gates ?? {},
        active: state?.activeExamId === spec.id,
        docs: { html: await has(`${DOCS.exam}.html`), pdf: await has(`${DOCS.exam}.pdf`) },
      });
    }
    return out.sort((a, b) => b.number - a.number);
  }

  private async status(ws: string) {
    const state = await readState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const profile = await readProfile(base).catch(() => undefined);
    const prefs = await readPrefs(ws);
    const jobs = this.deps.jobs;
    const buildJob = jobs.current("build");
    const wordingJob = jobs.current("wording");
    const draft = state?.draft;
    const pending = state?.interview;
    return {
      revision: await revisionOf(ws),
      initialized: state !== undefined,
      ...(profile
        ? {
            profile: {
              teacherName: profile.teacherName,
              institution: profile.institution,
              subject: profile.subject,
              paper: profile.paper,
              language: profile.language,
              hasLogo: profile.logo !== undefined,
            },
          }
        : {}),
      ...(profile?.logo ? { logo: await this.logoUrl(base, profile) } : {}),
      ...(draft
        ? {
            draft: {
              title: draft.title,
              theme: draft.theme,
              grade: draft.grade,
              level: draft.level,
              questionCount: draft.questionCount,
            },
          }
        : {}),
      ...(pending
        ? { chatInterview: { round: pending.pending?.round ?? null, flow: pending.flow } }
        : {}),
      exams: await this.exams(base, state),
      activeExamId: state?.activeExamId ?? null,
      lastBuild: state?.activeExamId ? (prefs.lastBuild[state.activeExamId] ?? null) : null,
      locales: await this.shippedLocales(),
      jobs: {
        build: buildJob ? { id: buildJob, ...jobs.get(buildJob) } : null,
        wording: wordingJob ? { id: wordingJob, ...jobs.get(wordingJob) } : null,
      },
    };
  }

  private async catalogList(ws: string, grade: string | undefined) {
    const catalog = await this.coordinator.catalogForWorkspace(ws);
    const topics = (catalog.topics?.() ?? []).filter(
      (topic) => grade === undefined || topic.grades.includes(grade),
    );
    const packs = new Map<string, Record<string, string>>();
    for (const topic of catalog.topics?.() ?? []) packs.set(topic.pack, topic.packName);
    return {
      topics: topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        pack: topic.pack,
        grades: topic.grades,
        levels: topic.levels,
        supports: topic.supports,
      })),
      packs: [...packs.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  private async doctor(ws: string) {
    const detection = await this.coordinator.detect();
    const report = (await this.coordinator.knowledgeFor(ws)).report;
    return {
      browser: detection.path === undefined ? "missing" : "found",
      source: detection.source,
      kbOk: report.ok,
      kbErrors: report.results.filter((finding) => finding.severity === "error").length,
    };
  }

  private async modelList(ws: string, signal: AbortSignal) {
    const prefs = await readPrefs(ws);
    let list: Awaited<ReturnType<NonNullable<PluginAPI["models"]>["list"]>> = [];
    try {
      list = (await this.deps.api.models?.list(signal)) ?? [];
    } catch {
      list = [];
    }
    const models = list.slice(0, 500).map((entry) => ({
      reference: entry.reference,
      label: entry.model?.name || entry.model?.id || entry.reference,
      provider: entry.providerName || entry.provider,
    }));
    return { models, chosen: prefs.model, available: models.length > 0 };
  }

  private async draftGet(ws: string) {
    const state = await readState(ws);
    const draft = state?.draft;
    if (!state || !draft) return null;
    const base = await this.coordinator.rootFor(ws, state);
    const knowledge = await this.coordinator.knowledgeFor(ws);
    let blueprint: ReturnType<typeof buildBlueprint> | null = null;
    try {
      blueprint = buildBlueprint({
        topics: draft.topics,
        level: draft.level,
        calibration: this.coordinator.calibrationOf(draft, knowledge),
        itemTypes: draft.itemTypes,
      });
    } catch {
      blueprint = null;
    }
    const names = Object.fromEntries(
      knowledge.topics
        .filter((topic) => draft.topics.includes(topic.fullId))
        .map((topic) => [topic.fullId, topic.name]),
    );
    const folders = await listExamFolders(base).catch(() => [] as string[]);
    return {
      draft,
      blueprint,
      topicNames: names,
      folderNumber: nextExamNumber(folders, state.lastExamNumber),
    };
  }

  /** The active exam with its knowledge, calibration and blueprint; `phase_mismatch` if none. */
  private async activeExam(ws: string) {
    const state = await readState(ws);
    const active = state?.activeExamId;
    if (!state || !active) throw new AppError("phase_mismatch");
    const base = await this.coordinator.rootFor(ws, state);
    const found = await this.coordinator.examFolder(base, active);
    if (!found) throw new AppError("not_found");
    const knowledge = await this.coordinator.knowledgeFor(ws);
    const calibration = this.coordinator.calibrationOf(found.spec, knowledge);
    const blueprint = buildBlueprint({
      topics: found.spec.topics,
      level: found.spec.level,
      calibration,
      itemTypes: found.spec.itemTypes,
    });
    const phase = state.exams[active]?.phase ?? found.spec.status;
    return { state, base, active, found, knowledge, calibration, blueprint, phase };
  }

  /** The families an exam's items come from, with one default-worded sample each. */
  private async families(ws: string) {
    const exam = await this.activeExam(ws);
    const generated = generateExam({
      blueprint: exam.blueprint,
      topics: exam.knowledge.topics,
      level: exam.found.spec.level,
      calibration: exam.calibration,
      seed: exam.found.spec.id,
    });
    const samples = new Map<string, string>();
    for (const item of generated.items) {
      const first = item.stem.find((line): line is string => typeof line === "string");
      if (item.family && !samples.has(item.family)) samples.set(item.family, first ?? "");
    }
    return { exam, samples };
  }

  private async wordingGet(ws: string) {
    const { exam, samples } = await this.families(ws);
    const prefs = await readPrefs(ws);
    const pending = prefs.wording[exam.active];
    const job = this.deps.jobs.current("wording");
    return {
      examId: exam.active,
      phase: exam.phase,
      model: prefs.model,
      families: [...samples.entries()].map(([id, sample]) => ({
        id,
        sample,
        sampleHtml: markupHtml([sample], evaluaMathRenderer),
        templates: exam.found.spec.itemPrompts?.[id] ?? [],
        ...(pending?.templates[id] ? { draft: pending.templates[id] } : {}),
      })),
      draft: pending
        ? {
            dropped: pending.dropped,
            fallback: pending.fallback,
            model: pending.model,
            at: pending.at,
          }
        : null,
      job: job ? { id: job, ...this.deps.jobs.get(job) } : null,
    };
  }

  private async itemsGet(ws: string, offset: number, limit: number) {
    const exam = await this.activeExam(ws);
    let text: string;
    try {
      text = await readFile(join(exam.found.path, "items.json"), "utf8");
    } catch {
      return { total: 0, items: [] };
    }
    const items = parseItemsFile(text);
    const math = evaluaMathRenderer;
    return {
      total: items.length,
      items: items.slice(offset, offset + limit).map((item, index) => ({
        n: offset + index + 1,
        type: item.type,
        family: item.family,
        stemHtml: markupHtml(item.stem, math),
        options: item.options.map((option) => ({
          key: option.key,
          html: inlineHtml(option.display, math),
          correct: option.correct,
        })),
        answerHtml: inlineHtml(item.answer.display, math),
      })),
    };
  }

  private async docsGet(ws: string, input: Input) {
    const examId = str(input, "examId", 4) as string;
    if (!examIdPattern.test(examId)) invalid();
    const doc = oneOf(input, "doc", Object.keys(DOCS) as DocKind[]);
    const format = oneOf(input, "format", ["pdf", "html"] as const);
    const state = await readState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const found = await this.coordinator.examFolder(base, examId);
    if (!found) throw new AppError("not_found");
    const name = `${DOCS[doc]}.${format}`;
    const path = join(found.path, name);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new AppError("not_found");
    }
    if (size > MAX_DOC_BYTES) throw new AppError("operation_failed");
    return {
      name,
      mime: format === "pdf" ? "application/pdf" : "text/html",
      base64: (await readFile(path)).toString("base64"),
    };
  }

  // ---- mutations (each runs inside `mutate`) -----------------------------------------------

  private async modelsChoose(ws: string, input: Input, ctx: ActionContext) {
    const reference = input.reference;
    if (reference !== null && (typeof reference !== "string" || reference.length > 200)) invalid();
    if (typeof reference === "string") {
      try {
        if (!this.deps.api.models) throw new Error("no models");
        await this.deps.api.models.resolve(reference, ctx.signal);
      } catch {
        throw new AppError("invalid_input");
      }
    }
    return this.coordinator.lock.run(
      async () => {
        const prefs = await readPrefs(ws);
        prefs.model = reference;
        await writePrefs(ws, prefs);
        return { chosen: reference };
      },
      { timeoutMs: LOCK_WAIT_MS },
    );
  }

  private async ensureState(ws: string): Promise<EvaluaState> {
    return (await readState(ws)) ?? emptyState(DEFAULT_ROOT, this.coordinator.nowIso());
  }

  private async profileSave(ws: string, input: Input) {
    const language = str(input, "language", 16) as string;
    if (!(await this.shippedLocales()).includes(language)) invalid();
    const state = await this.ensureState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const existing = await readProfile(base).catch(() => undefined);
    let profile: TeacherProfile;
    try {
      profile = validateProfile({
        teacherName: str(input, "teacherName", 100, { min: 1 }),
        institution: str(input, "institution", 150, { min: 1 }),
        subject: str(input, "subject", 80, { min: 1 }),
        paper: oneOf(input, "paper", ["letter", "a4"] as const),
        language,
        ...(existing?.logo ? { logo: existing.logo } : {}),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("invalid_input");
    }
    await mkdir(base, { recursive: true, mode: 0o755 });
    await writeProfile(base, profile);
    await this.coordinator.saveState(ws, state);
    return { profile };
  }

  private async profileSetLogo(ws: string, input: Input) {
    const data = str(input, "dataBase64", 2_796_208) as string;
    oneOf(input, "mime", Object.values(LOGO_MIME));
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new AppError("bad_image");
    const state = await this.ensureState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const profile = await readProfile(base).catch(() => undefined);
    if (!profile) throw new AppError("phase_mismatch");
    await mkdir(base, { recursive: true, mode: 0o755 });
    let logo: string;
    try {
      logo = await saveLogoBytes(base, Buffer.from(data, "base64"));
    } catch (error) {
      if (error instanceof LogoError) {
        throw new AppError(error.reason === "too_large" ? "file_too_large" : "bad_image");
      }
      throw error;
    }
    const updated = { ...profile, logo };
    await writeProfile(base, updated);
    await this.coordinator.saveState(ws, state);
    return { logo: await this.logoUrl(base, updated) };
  }

  private async profileRemoveLogo(ws: string) {
    const state = await this.ensureState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const profile = await readProfile(base).catch(() => undefined);
    if (!profile) throw new AppError("phase_mismatch");
    const { logo: _logo, ...rest } = profile;
    await writeProfile(base, rest);
    await this.coordinator.saveState(ws, state);
    return { profile: rest };
  }

  private async draftCreate(ws: string, input: Input) {
    const answers = wizardAnswers(input.answers);
    const replace = bool(input, "replace");
    const state = await this.ensureState(ws);
    const base = await this.coordinator.rootFor(ws, state);
    const profile = await readProfile(base).catch(() => undefined);
    if (!profile) throw new AppError("phase_mismatch");
    const result = runWizard(answers, {
      catalog: await this.coordinator.catalogForWorkspace(ws),
      profile,
      clock: this.coordinator.clockSource,
    });
    if ("errors" in result) return { errors: result.errors };
    // A deterministic dry run of the generation: refuse a plan whose questions cannot be created
    // instead of letting the teacher reach a dead "Create the questions" after Gate A.
    const shortfalls = await this.coordinator.capacityFor(ws, result.draft, state);
    if (shortfalls.length > 0) return { errors: capacityErrors(shortfalls) };
    if ((state.interview || state.draft) && !replace) {
      return { confirm: "replace", chatInterview: !!state.interview, draft: !!state.draft };
    }
    delete state.interview;
    state.draft = result.draft;
    await mkdir(base, { recursive: true, mode: 0o755 });
    await this.coordinator.saveState(ws, state);
    return { draft: result.draft };
  }

  private requireEditable(phase: string) {
    if (!EDITABLE.includes(phase)) throw new AppError("phase_mismatch");
  }

  private async wordingDraft(ws: string, ctx: ActionContext) {
    const { exam, samples } = await this.families(ws);
    this.requireEditable(exam.phase);
    const listed = await this.modelList(ws, ctx.signal);
    if (!listed.available) throw new AppError("no_model");
    const base = exam.base;
    const profile = await readProfile(base).catch(() => undefined);
    const prompt = buildWordingPrompt({
      language: profile?.language ?? "es",
      grade: exam.found.spec.grade,
      level: exam.found.spec.level,
      families: [...samples.entries()].map(([id, sample]) => ({ id, sample })),
    });
    const allowed = [...samples.keys()];
    const chosen = listed.chosen;
    const examId = exam.active;
    const jobId = this.deps.jobs.start("wording", async ({ signal, progress }) => {
      progress(0, 1, "drafting");
      let model: string | undefined;
      let fallback = false;
      if (chosen && this.deps.api.models) {
        try {
          await this.deps.api.models.resolve(chosen, signal);
          model = chosen;
        } catch {
          signal.throwIfAborted();
          fallback = true;
        }
      }
      let text: string;
      try {
        text = await this.deps.api.model.complete({
          ...prompt,
          signal,
          ...(model ? { model } : { sessionId: ctx.sessionId }),
        });
      } catch {
        signal.throwIfAborted();
        throw new AppError("model_failed");
      }
      signal.throwIfAborted();
      const parsed = parseWordingOutput(text, allowed);
      if (!parsed.valid || Object.keys(parsed.templates).length === 0) {
        throw new AppError("model_failed");
      }
      await this.coordinator.lock.run(async () => {
        const prefs = await readPrefs(ws);
        prefs.wording[examId] = {
          templates: parsed.templates,
          dropped: parsed.dropped,
          model: model ?? null,
          fallback,
          at: this.coordinator.nowIso(),
        };
        await writePrefs(ws, prefs);
      });
      progress(1, 1, "drafting");
      return { families: Object.keys(parsed.templates).length, dropped: parsed.dropped, fallback };
    });
    return { jobId };
  }

  private async wordingSave(ws: string, input: Input) {
    const prompts = promptsInput(input.prompts);
    const { exam, samples } = await this.families(ws);
    this.requireEditable(exam.phase);
    const allowed = [...samples.keys()].filter((id) => familyIds.includes(id));
    const { templates, dropped } = validateTemplates(prompts, allowed);
    const saved = await this.coordinator.setPromptsCore(ws, templates);
    let regenerated = false;
    let findings: BuildFinding[] | undefined;
    let capacity: CapacityShortfall[] | undefined;
    if (exam.phase === "generated" || exam.phase === "built") {
      const outcome = await this.coordinator.generateCore(ws);
      if ("blocked" in outcome) {
        // Stale questions must not stay approvable: send the exam back before generation.
        const state = await readState(ws);
        const progress = state?.exams[exam.active];
        if (state && progress) {
          state.exams[exam.active] = { ...progress, phase: "approved-a" };
          await this.coordinator.saveState(ws, state);
        }
        findings = findingsOf(outcome.blocked);
        capacity = shortfallsFromFindings(
          outcome.blocked,
          exam.blueprint.cells,
          exam.knowledge.topics,
        );
      } else regenerated = true;
    }
    const prefs = await readPrefs(ws);
    if (prefs.wording[exam.active]) {
      delete prefs.wording[exam.active];
      await writePrefs(ws, prefs);
    }
    return {
      saved,
      dropped,
      regenerated,
      ...(findings ? { findings } : {}),
      ...(capacity?.length ? { capacity } : {}),
    };
  }

  private async examGenerate(ws: string) {
    const exam = await this.activeExam(ws);
    this.requireEditable(exam.phase);
    const outcome = await this.coordinator.generateCore(ws);
    if ("blocked" in outcome) {
      const capacity = shortfallsFromFindings(
        outcome.blocked,
        exam.blueprint.cells,
        exam.knowledge.topics,
      );
      return {
        findings: outcome.blocked.map((finding) => ({
          id: finding.id,
          subject: finding.subject,
          message: finding.message,
        })),
        ...(capacity.length > 0 ? { capacity } : {}),
      };
    }
    return { count: outcome.count, sha: outcome.sha };
  }

  private async approveB(ws: string, input: Input) {
    const examId = str(input, "examId", 4) as string;
    if (!examIdPattern.test(examId)) invalid();
    const acknowledged = bool(input, "acknowledgeFindings");
    const state = await readState(ws);
    if (!state || state.activeExamId !== examId || state.exams[examId]?.phase !== "built") {
      throw new AppError("phase_mismatch");
    }
    const errors = ((await readPrefs(ws)).lastBuild[examId]?.findings ?? []).filter(
      (finding) => finding.severity === "error",
    );
    if (errors.length > 0 && !acknowledged) return { confirm: "findings", findings: errors };
    await this.coordinator.approveCore(ws, "b");
    return { approved: true };
  }

  private async buildStart(ws: string) {
    const exam = await this.activeExam(ws);
    if (exam.phase !== "generated" && exam.phase !== "built") {
      throw new AppError("phase_mismatch");
    }
    let prepared: Awaited<ReturnType<EvaluaCoordinator["prepareBuild"]>>;
    try {
      prepared = await this.coordinator.prepareBuild(ws);
    } catch {
      throw new AppError("operation_failed");
    }
    const coordinator = this.coordinator;
    const jobId = this.deps.jobs.start("build", async ({ signal, progress }) => {
      try {
        const result = await coordinator.runBuild(prepared, {
          signal,
          onProgress: (step, total, phase) => progress(step, total, phase),
        });
        signal.throwIfAborted();
        const findings = findingsOf(result.findings);
        const pdf = result.files.some((file) => file.endsWith(".pdf"));
        await coordinator.lock.run(async () => {
          await coordinator.finishBuild(ws, prepared, result);
          const prefs = await readPrefs(ws);
          prefs.lastBuild[prepared.examId] = { at: coordinator.nowIso(), findings, pdf };
          await writePrefs(ws, prefs);
        });
        return { findings, pdf, browser: prepared.browserFound };
      } catch (error) {
        // Documents may be half rewritten: a built exam must be rebuilt before Gate B.
        await coordinator.lock.run(async () => {
          const state = await readState(ws);
          const progressOf = state?.exams[prepared.examId];
          if (state && progressOf?.phase === "built") {
            state.exams[prepared.examId] = { ...progressOf, phase: "generated" };
            await coordinator.saveState(ws, state);
          }
        });
        throw error;
      }
    });
    return { jobId };
  }
}
