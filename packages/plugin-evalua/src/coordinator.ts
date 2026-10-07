import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { buildBlueprint } from "./blueprint.js";
import { buildExam, type PdfPrinter } from "./build.js";
import { verifyExam } from "./checks.js";
import { detectChrome } from "./chrome/detect.js";
import { type Clock, systemClock } from "./clock.js";
import { type ExamSpec, fromDraft, parseExam, stringifyExam, toSpecLike } from "./exam.js";
import { families, familyIds } from "./families/index.js";
import { generateExam } from "./generate.js";
import {
  acceptAnswers,
  buildDraft,
  buildRound,
  emptyCatalog,
  flattenAnswers,
  nextRound,
  parseAnswerText,
  renderPending,
} from "./interview.js";
import { freezeItems, itemsSha256, parseItemsFile } from "./items-file.js";
import {
  createTopicCatalog,
  loadKnowledge,
  shippedKnowledgeDir,
  shippedLocalesDir,
  shippedQuotesDir,
  shippedThemesDir,
} from "./knowledge/index.js";
import type { LevelCalibration, LoadedKnowledge } from "./knowledge/types.js";
import { loadLocale } from "./locales.js";
import { buildPlanProject, buildVersionLog } from "./plan.js";
import {
  copyLogo,
  DEFAULT_SUBJECT,
  readProfile,
  validateProfile,
  writeProfile,
} from "./profile.js";
import { loadQuotes, selectClosing } from "./quotes.js";
import { cleanText } from "./schemas.js";
import { atomicWrite, emptyState, readState, validateRootName, writeState } from "./storage.js";
import { loadThemeLayers, resolveTheme } from "./themes.js";
import type {
  EvaluaState,
  InterviewFlow,
  InterviewState,
  RoundId,
  TeacherProfile,
  TopicCatalog,
} from "./types.js";
import { VERSION } from "./version.js";
import {
  allocateExamFolder,
  evaluaRootPath,
  examFolderName,
  listExamFolders,
  nextExamNumber,
} from "./workspace.js";

export const DEFAULT_ROOT = "evalua";

export interface CoordinatorOptions {
  clock?: Clock;
  catalog?: TopicCatalog;
  /** Test seam: when given, the build uses this printer instead of launching a browser. */
  printer?: PdfPrinter;
}

const profileKeys = ["language", "teacher_name", "institution", "logo", "subject"].flatMap(
  (key) => [key, `${key}:text`],
);

export interface ProfileInput {
  teacherName?: string;
  institution?: string;
  subject?: string;
  paper?: string;
  language?: string;
  logoPath?: string;
  removeLogo?: boolean;
}

/** Phase 1 coordinator: profile, interview rounds, headless continuation and state. */
export class EvaluaCoordinator {
  private readonly clock: Clock;
  private readonly injectedCatalog: TopicCatalog | undefined;
  private readonly printer: PdfPrinter | undefined;
  private readonly catalogCache = new Map<string, TopicCatalog>();

  constructor(
    private readonly api: PluginAPI,
    options: CoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.injectedCatalog = options.catalog;
    this.printer = options.printer;
  }

  /** The knowledge-base catalog for a workspace: injected (tests) or loaded from packs. */
  private async catalogFor(workspace: string, state: EvaluaState): Promise<TopicCatalog> {
    if (this.injectedCatalog !== undefined) return this.injectedCatalog;
    const base = await this.rootOf(workspace, state);
    const cached = this.catalogCache.get(base);
    if (cached !== undefined) return cached;
    try {
      const knowledge = await loadKnowledge({
        shippedDir: shippedKnowledgeDir(),
        workspaceDirs: [join(base, "knowledge-packs")],
        families: familyIds,
      });
      const catalog = createTopicCatalog(knowledge);
      this.catalogCache.set(base, catalog);
      return catalog;
    } catch {
      return emptyCatalog;
    }
  }

  private workspace(sessionId?: string): string {
    if (!sessionId) throw new Error("Evalua commands require an active Alisio session");
    return this.api.sessions.workspace(sessionId);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private async save(workspace: string, state: EvaluaState): Promise<void> {
    state.updatedAt = this.now();
    await writeState(workspace, state);
  }

  private async rootOf(workspace: string, state?: EvaluaState): Promise<string> {
    return evaluaRootPath(workspace, state?.root ?? DEFAULT_ROOT);
  }

  // ---- commands ---------------------------------------------------------------------------

  /** `/evalua:init [dir] [--edit]`: set up the workspace and the teacher profile. */
  async init(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    let state = await readState(workspace);
    const pending = state?.interview?.pending;
    if (state && pending && state.interview?.flow === "init") {
      const answers = parseAnswerText(
        args,
        pending.questions.map((question) => question.id),
      );
      if (answers) return this.applyAnswers(workspace, state, answers, true);
      if (!args.trim()) return this.advance(workspace, state, true);
    }
    const tokens = args.split(/\s+/).filter(Boolean);
    const edit = tokens.includes("--edit");
    const dirs = tokens.filter((token) => !token.startsWith("--"));
    if (dirs.length > 1) throw new Error("Usage: /evalua:init [dir] [--edit]");
    const first = dirs[0];
    const requested = first ? validateRootName(first.replace(/^\.\//, "")) : undefined;
    if (state && requested && requested !== state.root) {
      throw new Error(
        `An Evalua workspace already exists at "${state.root}"; it cannot be moved with init`,
      );
    }
    state ??= emptyState(requested ?? DEFAULT_ROOT, this.now());
    const base = await this.rootOf(workspace, state);
    await mkdir(base, { recursive: true, mode: 0o755 });
    const existing = await readProfile(base);
    if (existing && !edit) {
      await this.save(workspace, state);
      return `The teacher profile already exists in ${state.root}/teacher.yaml; nothing to ask. Run /evalua:init --edit to change it, or /evalua:new to start an exam.`;
    }
    state.interview = {
      flow: "init",
      edit: edit && existing !== undefined,
      answers: {},
      completedRounds: [],
    };
    delete state.draft;
    return this.advance(workspace, state, true);
  }

  /** `/evalua:new [description | id=value ...]`: run the interview and keep the draft until Gate A. */
  async new(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    let state = await readState(workspace);
    const pending = state?.interview?.pending;
    if (state && pending) {
      const answers = parseAnswerText(
        args,
        pending.questions.map((question) => question.id),
      );
      if (answers) return this.applyAnswers(workspace, state, answers, true);
      if (!args.trim() && state.interview?.flow === "new")
        return this.advance(workspace, state, true);
    }
    state ??= emptyState(DEFAULT_ROOT, this.now());
    const base = await this.rootOf(workspace, state);
    await mkdir(base, { recursive: true, mode: 0o755 });
    const interview: InterviewState = {
      flow: "new",
      edit: false,
      answers: {},
      completedRounds: [],
    };
    const description = args.trim();
    if (description) {
      try {
        interview.answers.topic = "enter";
        interview.answers["topic:text"] = cleanText(description, "The description", 200);
      } catch (error) {
        throw new Error(
          `${(error as Error).message}. Usage: /evalua:new [short topic description]`,
        );
      }
    }
    state.interview = interview;
    delete state.draft;
    return this.advance(workspace, state, true);
  }

  /** `/evalua:status` */
  async status(_args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const info = await this.statusInfo(workspace);
    if (!info.initialized) return "No Evalua workspace here. Run /evalua:init or /evalua:new.";
    const lines = [
      `Evalua workspace: ${info.root}`,
      `Teacher profile: ${info.profile ? "set" : "missing (the first interview asks for it)"}`,
    ];
    if (info.pendingRound) {
      lines.push(
        `Pending interview round: ${info.pendingRound} (continue with /evalua:new or /evalua:init).`,
      );
    }
    lines.push(`Exam folders: ${info.exams.length === 0 ? "none yet" : info.exams.join(", ")}`);
    if (info.draft) {
      lines.push(`Draft exam: ${info.draftTitle} (${info.draftTheme}).`);
      lines.push(
        "Next: Gate A, the teacher's approval of the spec and blueprint, which arrives in a later release.",
      );
    }
    return lines.join("\n");
  }

  // ---- tools ------------------------------------------------------------------------------

  async statusInfo(workspace: string) {
    const state = await readState(workspace);
    if (!state) {
      return { initialized: false as const };
    }
    const base = await this.rootOf(workspace, state);
    const profile = await readProfile(base);
    const exams = await listExamFolders(base);
    const pending = state.interview?.pending;
    return {
      initialized: true as const,
      root: state.root,
      profile: profile !== undefined,
      pendingRound: pending?.round ?? null,
      pendingQuestionIds: pending?.questions.map((question) => question.id) ?? [],
      draft: state.draft !== undefined,
      draftTitle: state.draft?.title ?? null,
      draftTheme: state.draft?.theme ?? null,
      exams,
      nextExamNumber: nextExamNumber(exams, state.lastExamNumber),
    };
  }

  /** `evalua_answer`: persist answers for the pending round, then report the next questions. */
  async answerTool(
    workspace: string,
    input: Record<string, string | string[] | undefined>,
  ): Promise<{ text: string; isError: boolean }> {
    const state = await readState(workspace);
    const pending = state?.interview?.pending;
    if (!state || !pending) {
      return {
        text: "There are no pending interview questions. Run /evalua:new to start an exam interview.",
        isError: true,
      };
    }
    const flat = flattenAnswers(input, pending.questions);
    const ids = pending.questions.map((question) => question.id);
    const unknown = Object.keys(flat).filter((key) => !ids.includes(key.replace(/:text$/, "")));
    if (Object.keys(flat).length === 0 || unknown.length > 0) {
      return {
        text: `${Object.keys(flat).length === 0 ? "No answers were given" : `Not pending interview ids: ${unknown.join(", ")}`}. Nothing was recorded. Pending question ids: ${ids.join(", ")}.`,
        isError: true,
      };
    }
    const { accepted, errors } = acceptAnswers(pending.questions, flat);
    if (Object.keys(accepted).length === 0) {
      return {
        text: `No answers were recorded${errors.length ? `:\n- ${errors.join("\n- ")}` : "."}\n\n${renderPending(pending, "evalua_answer")}`,
        isError: true,
      };
    }
    return { text: await this.applyAnswers(workspace, state, flat, false), isError: false };
  }

  /** `evalua_profile`: read or update the teacher profile with validation. */
  async profileTool(
    workspace: string,
    input: { action: "get" | "set" } & ProfileInput,
  ): Promise<{ text: string; isError: boolean }> {
    const state = (await readState(workspace)) ?? emptyState(DEFAULT_ROOT, this.now());
    const base = await this.rootOf(workspace, state);
    const existing = await readProfile(base);
    if (input.action === "get") {
      if (!existing) {
        return {
          text: "No teacher profile yet. Ask for the teacher's name and institution, then call evalua_profile with action set.",
          isError: false,
        };
      }
      return {
        text: JSON.stringify({ root: state.root, profile: existing }, null, 2),
        isError: false,
      };
    }
    try {
      const merged: Record<string, unknown> = {
        ...existing,
        ...(input.teacherName !== undefined ? { teacherName: input.teacherName } : {}),
        ...(input.institution !== undefined ? { institution: input.institution } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.paper !== undefined ? { paper: input.paper } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
      };
      if (input.removeLogo) delete merged.logo;
      const checked = validateProfile({ ...merged, logo: undefined });
      let logo = input.removeLogo ? undefined : existing?.logo;
      if (input.logoPath !== undefined)
        logo = await copyLogo(base, this.logoSource(workspace, input.logoPath));
      const profile: TeacherProfile = { ...checked, ...(logo ? { logo } : {}) };
      await mkdir(base, { recursive: true, mode: 0o755 });
      await writeProfile(base, profile);
      await this.save(workspace, state);
      return { text: JSON.stringify({ root: state.root, profile }, null, 2), isError: false };
    } catch (error) {
      return { text: (error as Error).message, isError: true };
    }
  }

  // ---- knowledge and doctor tools ----------------------------------------------------------

  private async loadKnowledgeFor(workspace: string) {
    const state = (await readState(workspace)) ?? emptyState(DEFAULT_ROOT, this.now());
    const base = await this.rootOf(workspace, state);
    return loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      workspaceDirs: [join(base, "knowledge-packs")],
      families: familyIds,
    });
  }

  /** `evalua_kb`: list packs, topics and levels from the knowledge base. */
  async kbTool(workspace: string): Promise<{ text: string; isError: boolean }> {
    try {
      const knowledge = await this.loadKnowledgeFor(workspace);
      const summary = {
        ok: knowledge.report.ok,
        packs: knowledge.packs.map((pack) => ({
          id: pack.id,
          code: pack.code,
          layer: pack.layer,
          levels: Object.keys(pack.levels),
          topics: pack.topics.map((topic) => topic.fullId),
        })),
        findings: knowledge.report.results,
      };
      return { text: JSON.stringify(summary, null, 2), isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : "evalua_kb failed", isError: true };
    }
  }

  /** `/evalua:kb`: print the knowledge base summary. */
  async kbCommand(_args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const result = await this.kbTool(workspace);
    return result.text;
  }

  /** `evalua_check`: run the deterministic knowledge-base checks and return the report. */
  async checkTool(workspace: string): Promise<{ text: string; isError: boolean }> {
    try {
      const knowledge = await this.loadKnowledgeFor(workspace);
      return { text: JSON.stringify(knowledge.report, null, 2), isError: false };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : "evalua_check failed",
        isError: true,
      };
    }
  }

  /** `/evalua:doctor`: report the knowledge base and the available print browser. */
  async doctor(_args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const detection = await detectChrome();
    const knowledge = await this.loadKnowledgeFor(workspace);
    const errors = knowledge.report.results.filter(
      (finding) => finding.severity === "error",
    ).length;
    return [
      `Knowledge base: ${knowledge.report.ok ? "ok" : `${errors} error(s)`}`,
      `Packs: ${knowledge.packs.map((pack) => pack.id).join(", ") || "none"}`,
      `Browser: ${detection.path ?? "not found"} (${detection.source})`,
      detection.path === undefined
        ? "PDFs need a Chrome-family browser (Chrome, Chromium, Brave, Edge, Vivaldi or Opera); the HTML output still works."
        : "PDF output is available.",
    ].join("\n");
  }

  // ---- exam folder flow (Gate A, generate) -------------------------------------------------

  private async findExamFolder(
    base: string,
    id: string,
  ): Promise<{ name: string; path: string; spec: ExamSpec } | undefined> {
    for (const name of await listExamFolders(base)) {
      try {
        const text = await readFile(join(base, "exams", name, "exam.yaml"), "utf8");
        const spec = parseExam(text);
        if (spec.id === id) return { name, path: join(base, "exams", name), spec };
      } catch {
        // a folder without a readable exam.yaml is skipped
      }
    }
    return undefined;
  }

  private calibrationFor(spec: ExamSpec, knowledge: LoadedKnowledge): LevelCalibration {
    const pack =
      knowledge.packs.find((entry) => spec.packs.includes(entry.id)) ??
      knowledge.packs.find((entry) =>
        entry.topics.some((topic) => spec.topics.includes(topic.fullId)),
      ) ??
      knowledge.packs[0];
    if (!pack) throw new Error("The knowledge base has no pack to calibrate the level");
    return pack.levels[spec.level];
  }

  private async approveAt(workspace: string, gate: string): Promise<string> {
    const state = await readState(workspace);
    if (!state) throw new Error("No Evalua workspace here. Run /evalua:new first.");
    const base = await this.rootOf(workspace, state);
    if (gate === "b") {
      const active = state.activeExamId;
      const progress = active ? state.exams[active] : undefined;
      if (!active || !progress) throw new Error("There is no active exam to approve");
      state.exams[active] = {
        ...progress,
        phase: "approved-b",
        gates: { ...progress.gates, b: { decision: "approved", at: this.now() } },
      };
      await this.save(workspace, state);
      return "Gate B approved: the final package is approved.";
    }
    const draft = state.draft;
    if (!draft) throw new Error("There is no draft exam to approve. Run /evalua:new first.");
    const folder = await allocateExamFolder(workspace, base, draft.slug, state.lastExamNumber);
    const id = `e${String(folder.number).padStart(2, "0")}`;
    const spec = fromDraft(draft, { id, number: folder.number });
    await writeFile(join(folder.path, "exam.yaml"), stringifyExam(spec), { mode: 0o644 });
    state.activeExamId = id;
    state.lastExamNumber = folder.number;
    state.exams[id] = {
      phase: "approved-a",
      revision: 1,
      gates: { a: { decision: "approved", at: this.now() } },
    };
    delete state.draft;
    await this.save(workspace, state);
    return `Gate A approved. Exam folder: ${state.root}/exams/${folder.name}. Run /evalua:generate to build the items.`;
  }

  /** `/evalua:approve a|b`: Gate A allocates the folder and freezes exam.yaml; Gate B closes it. */
  async approveCommand(args: string, sessionId?: string): Promise<string> {
    const gate = args.trim().toLowerCase();
    if (gate !== "a" && gate !== "b") throw new Error("Usage: /evalua:approve a|b");
    return this.approveAt(this.workspace(sessionId), gate);
  }

  private async generateAt(workspace: string): Promise<string> {
    const state = await readState(workspace);
    const active = state?.activeExamId;
    if (!state || !active) {
      throw new Error("No approved exam. Run /evalua:new and /evalua:approve a first.");
    }
    const base = await this.rootOf(workspace, state);
    const found = await this.findExamFolder(base, active);
    if (!found) throw new Error(`The folder for exam ${active} was not found`);
    const knowledge = await this.loadKnowledgeFor(workspace);
    const calibration = this.calibrationFor(found.spec, knowledge);
    const blueprint = buildBlueprint({
      topics: found.spec.topics,
      level: found.spec.level,
      calibration,
      itemTypes: found.spec.itemTypes,
    });
    const result = generateExam({
      blueprint,
      topics: knowledge.topics,
      level: found.spec.level,
      calibration,
      seed: found.spec.id,
      ...(found.spec.itemPrompts === undefined ? {} : { prompts: found.spec.itemPrompts }),
    });
    const examFindings = verifyExam({
      items: result.items,
      blueprint,
      questionCount: found.spec.questionCount,
      itemTypes: found.spec.itemTypes,
      mode: found.spec.distribution,
    });
    const errors = [...result.findings, ...examFindings].filter(
      (finding) => finding.severity === "error",
    );
    if (errors.length > 0) {
      return `Generation blocked:\n${errors
        .map((finding) => `- ${finding.id} ${finding.subject}: ${finding.message}`)
        .join("\n")}`;
    }
    const frozen = freezeItems(result.items);
    await atomicWrite(join(found.path, "items.json"), frozen, 0o644);
    const progress = state.exams[active];
    if (progress) {
      state.exams[active] = {
        ...progress,
        phase: "generated",
        revision: (progress.revision ?? 0) + 1,
      };
    }
    await this.save(workspace, state);
    return `Generated ${result.items.length} items for ${active} (items.json SHA-256 ${itemsSha256(frozen).slice(0, 12)}).`;
  }

  /** `/evalua:generate`: blueprint + generate + verify + freeze items.json. */
  async generateCommand(_args: string, sessionId?: string): Promise<string> {
    return this.generateAt(this.workspace(sessionId));
  }

  /** `evalua_exam`: approve a gate, report the active exam, or save item instructions. */
  async examTool(
    workspace: string,
    input: {
      action: "approve" | "status" | "set-prompts";
      gate?: string;
      prompts?: Record<string, string[]>;
    },
  ): Promise<{ text: string; isError: boolean }> {
    try {
      if (input.action === "approve") {
        const gate = input.gate === "b" ? "b" : "a";
        return { text: await this.approveAt(workspace, gate), isError: false };
      }
      if (input.action === "set-prompts") {
        return { text: await this.setPromptsAt(workspace, input.prompts ?? {}), isError: false };
      }
      return { text: JSON.stringify(await this.statusInfo(workspace), null, 2), isError: false };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : "evalua_exam failed",
        isError: true,
      };
    }
  }

  /** Saves agent-authored item instructions into the active exam's `exam.yaml`. */
  private async setPromptsAt(
    workspace: string,
    prompts: Record<string, string[]>,
  ): Promise<string> {
    const state = await readState(workspace);
    const active = state?.activeExamId;
    if (!state || !active) throw new Error("No approved exam. Run /evalua:approve a first.");
    const base = await this.rootOf(workspace, state);
    const found = await this.findExamFolder(base, active);
    if (!found) throw new Error(`The folder for exam ${active} was not found`);
    const clean: Record<string, string[]> = {};
    for (const [family, templates] of Object.entries(prompts)) {
      if (families[family] === undefined) throw new Error(`Unknown item family: ${family}`);
      const list = (Array.isArray(templates) ? templates : [])
        .map((entry) => String(entry).trim())
        .filter((entry) => entry !== "");
      if (list.length > 0) clean[family] = list;
    }
    const spec: ExamSpec = { ...found.spec };
    if (Object.keys(clean).length > 0) spec.itemPrompts = clean;
    else delete spec.itemPrompts;
    await writeFile(join(found.path, "exam.yaml"), stringifyExam(spec), { mode: 0o644 });
    const saved = Object.keys(clean);
    return saved.length > 0
      ? `Saved item instructions for: ${saved.join(", ")}.`
      : "Cleared item instructions; the families' defaults apply.";
  }

  /** `evalua_generate`: run the generation pipeline and freeze items.json. */
  async generateTool(workspace: string): Promise<{ text: string; isError: boolean }> {
    try {
      return { text: await this.generateAt(workspace), isError: false };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : "evalua_generate failed",
        isError: true,
      };
    }
  }

  /** `/evalua:build`: read the approved exam folder and write the documents. */
  private async buildAt(workspace: string): Promise<string> {
    const state = await readState(workspace);
    const active = state?.activeExamId;
    if (!state || !active) {
      throw new Error("No approved exam. Run /evalua:approve a and /evalua:generate first.");
    }
    const base = await this.rootOf(workspace, state);
    const found = await this.findExamFolder(base, active);
    if (!found) throw new Error(`The folder for exam ${active} was not found`);
    const profile = await readProfile(base);
    if (!profile) throw new Error("The teacher profile is missing; run /evalua:init");
    const itemsText = await readFile(join(found.path, "items.json"), "utf8");
    const items = parseItemsFile(itemsText);
    if (items.length === 0) throw new Error("items.json has no items; run /evalua:generate first");
    const knowledge = await this.loadKnowledgeFor(workspace);
    const calibration = this.calibrationFor(found.spec, knowledge);
    const blueprint = buildBlueprint({
      topics: found.spec.topics,
      level: found.spec.level,
      calibration,
      itemTypes: found.spec.itemTypes,
    });
    const localeResult = await loadLocale(shippedLocalesDir(), profile.language);
    if (!localeResult.locale) throw new Error(`The locale "${profile.language}" is missing`);
    const themes = await loadThemeLayers([{ dir: shippedThemesDir(), layer: "shipped" }]);
    const resolution = resolveTheme(themes.themes, found.spec.template);
    if (!resolution.theme) throw new Error(resolution.finding?.message ?? "Unknown template");
    const quotes = await loadQuotes(shippedQuotesDir());
    const closing = selectClosing({
      kind: found.spec.closing.kind,
      pinned: found.spec.closing.pinned,
      language: profile.language,
      keywords: [],
      examId: found.spec.id,
      entries: quotes.entries,
    });
    const detection = await detectChrome();
    const result = await buildExam({
      spec: toSpecLike(found.spec),
      profile,
      items,
      locale: localeResult.locale,
      theme: resolution.theme,
      paper: profile.paper,
      columns: found.spec.columns,
      blueprint,
      closing,
      executable: detection.path ?? "",
      outDir: found.path,
      maxPages: found.spec.maxPages,
      ...(this.printer === undefined ? {} : { printer: this.printer }),
    });
    const progress = state.exams[active] ?? { phase: "generated", revision: 1, gates: {} };
    const planInput = {
      examId: found.spec.id,
      title: found.spec.title,
      theme: found.spec.theme,
      grade: found.spec.grade,
      level: found.spec.level,
      questionCount: found.spec.questionCount,
      itemTypes: found.spec.itemTypes,
      packs: found.spec.packs,
      topics: found.spec.topics,
      schoolYear: found.spec.schoolYear,
      revision: progress.revision ?? 1,
      gates: progress.gates,
      phases: [
        { name: "Profile", status: "done" as const },
        { name: "Intake", status: "done" as const },
        { name: "Ficha tecnica y blueprint", status: "done" as const },
        { name: "Item generation", status: "done" as const },
        { name: "Layout fit", status: "done" as const },
        { name: "Package", status: "done" as const },
      ],
      seeds: [found.spec.id],
      pluginVersion: VERSION,
      itemsSha256: itemsSha256(itemsText),
      ...(result.engineVersion === undefined ? {} : { engine: result.engineVersion }),
      builtAt: this.now(),
    };
    await atomicWrite(
      join(found.path, "05_control_versiones.md"),
      buildVersionLog(planInput),
      0o644,
    );
    await atomicWrite(join(found.path, "00_plan_proyecto.md"), buildPlanProject(planInput), 0o644);
    state.exams[active] = { ...progress, phase: "built" };
    await this.save(workspace, state);
    const errors = result.findings.filter((finding) => finding.severity === "error");
    const warnings = result.findings.filter((finding) => finding.severity === "warning");
    return [
      `Built ${items.length} items into ${state.root}/exams/${found.name} (${result.files.length} files).`,
      detection.path === undefined
        ? "No browser: HTML only, page limits not verified (EVL-LAY-000)."
        : `Engine: ${result.engineVersion ?? "unknown"}.`,
      ...(errors.length > 0
        ? [`Errors:\n${errors.map((finding) => `- ${finding.id} ${finding.message}`).join("\n")}`]
        : []),
      ...(warnings.length > 0 ? [`Warnings: ${warnings.map((w) => w.id).join(", ")}`] : []),
    ].join("\n");
  }

  /** `/evalua:build`: build the documents for the active exam. */
  async buildCommand(_args: string, sessionId?: string): Promise<string> {
    return this.buildAt(this.workspace(sessionId));
  }

  /** `evalua_build`: build the documents for the active exam. */
  async buildTool(workspace: string): Promise<{ text: string; isError: boolean }> {
    try {
      return { text: await this.buildAt(workspace), isError: false };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : "evalua_build failed",
        isError: true,
      };
    }
  }

  // ---- interview engine -------------------------------------------------------------------

  private logoSource(workspace: string, path: string): string {
    if (path.includes("\0")) throw new Error("The logo path contains an invalid character");
    return isAbsolute(path) ? path : resolve(workspace, path);
  }

  private commandFor(flow: InterviewFlow): string {
    return flow === "init" ? "/evalua:init" : "/evalua:new";
  }

  private async applyAnswers(
    workspace: string,
    state: EvaluaState,
    flat: Record<string, string>,
    mayAsk: boolean,
  ): Promise<string> {
    const interview = state.interview as InterviewState;
    const pending = interview.pending;
    if (!pending) throw new Error("There are no pending interview questions. Run /evalua:new.");
    const { accepted, errors } = acceptAnswers(pending.questions, flat);
    Object.assign(interview.answers, accepted);
    const remaining = this.questionsFor(
      pending.round,
      state,
      await this.catalogFor(workspace, state),
    );
    if (errors.length > 0 && remaining.length > 0)
      return this.park(workspace, state, pending.round, remaining, errors);
    if (errors.length > 0) return `Some answers were not accepted:\n- ${errors.join("\n- ")}`;
    return this.advance(workspace, state, mayAsk);
  }

  private questionsFor(
    round: RoundId,
    state: EvaluaState,
    catalog: TopicCatalog,
    current?: Partial<TeacherProfile>,
  ) {
    const interview = state.interview as InterviewState;
    return buildRound(round, {
      answers: interview.answers,
      catalog,
      ...(interview.edit && current ? { current } : {}),
    });
  }

  private async currentFor(workspace: string, state: EvaluaState) {
    const interview = state.interview as InterviewState;
    if (!interview.edit) return undefined;
    return readProfile(await this.rootOf(workspace, state));
  }

  private async roundToRun(workspace: string, state: EvaluaState): Promise<RoundId | undefined> {
    const interview = state.interview as InterviewState;
    if (interview.flow === "init")
      return interview.completedRounds.includes("profile") ? undefined : "profile";
    const profile = await readProfile(await this.rootOf(workspace, state));
    return nextRound({
      profileMissing: profile === undefined,
      answers: interview.answers,
      completed: interview.completedRounds,
    });
  }

  /** Drive the interview: ask interactively, or park the round as pending questions. */
  private async advance(workspace: string, state: EvaluaState, mayAsk: boolean): Promise<string> {
    const interview = state.interview as InterviewState;
    const current = await this.currentFor(workspace, state);
    const catalog = await this.catalogFor(workspace, state);
    let notice: string[] = [];
    for (;;) {
      const round = await this.roundToRun(workspace, state);
      if (!round) break;
      let questions = this.questionsFor(round, state, catalog, current);
      while (questions.length > 0) {
        if (!mayAsk || !this.api.ui.interactive()) {
          return this.park(workspace, state, round, questions, notice);
        }
        this.api.ui.status("evalua", `Interview round ${round}`);
        const asked = await this.api.ui.askQuestions({ questions, label: "Evalua interview" });
        const { accepted, errors } = acceptAnswers(questions, flattenAnswers(asked, questions));
        Object.assign(interview.answers, accepted);
        const remaining = this.questionsFor(round, state, catalog, current);
        if (errors.length > 0 || remaining.length === questions.length) {
          return this.park(workspace, state, round, remaining, errors);
        }
        questions = remaining;
      }
      notice = await this.completeRound(workspace, state, round);
      if (notice.length > 0) {
        const retry = this.questionsFor(round, state, catalog, current);
        return this.park(workspace, state, round, retry, notice);
      }
    }
    return this.finish(workspace, state, catalog);
  }

  private async park(
    workspace: string,
    state: EvaluaState,
    round: RoundId,
    questions: ReturnType<EvaluaCoordinator["questionsFor"]>,
    errors: string[] = [],
  ): Promise<string> {
    const interview = state.interview as InterviewState;
    interview.pending = { round, createdAt: this.now(), questions };
    await this.save(workspace, state);
    const prefix = errors.length
      ? `Some answers were not accepted:\n- ${errors.join("\n- ")}\n\n`
      : "";
    return `${prefix}${renderPending(interview.pending, this.commandFor(interview.flow))}`;
  }

  /** Persist what a finished round produces. Returns problems to re-ask about (empty when fine). */
  private async completeRound(
    workspace: string,
    state: EvaluaState,
    round: RoundId,
  ): Promise<string[]> {
    const interview = state.interview as InterviewState;
    if (round === "profile") {
      const problems = await this.saveProfile(workspace, state);
      if (problems.length > 0) return problems;
      for (const key of profileKeys) delete interview.answers[key];
    }
    if (!interview.completedRounds.includes(round)) interview.completedRounds.push(round);
    delete interview.pending;
    await this.save(workspace, state);
    return [];
  }

  private async saveProfile(workspace: string, state: EvaluaState): Promise<string[]> {
    const interview = state.interview as InterviewState;
    const answers = interview.answers;
    const base = await this.rootOf(workspace, state);
    const current = interview.edit ? await readProfile(base) : undefined;
    const pick = (id: string, fallback: string | undefined) =>
      answers[id] === "keep" ? fallback : (answers[`${id}:text`] ?? answers[id]);
    let logo = current?.logo;
    if (answers.logo === "none") logo = undefined;
    else if (answers.logo === "path") {
      try {
        logo = await copyLogo(base, this.logoSource(workspace, answers["logo:text"] ?? ""));
      } catch (error) {
        delete answers.logo;
        delete answers["logo:text"];
        return [`logo: ${(error as Error).message}`];
      }
    }
    const subject =
      answers.subject === "math" ? DEFAULT_SUBJECT : pick("subject", current?.subject);
    const language =
      answers.language === "keep"
        ? (current?.language ?? "es")
        : answers.language === "en"
          ? "en"
          : answers.language === "other"
            ? (answers["language:text"] ?? "es")
            : "es";
    try {
      const profile = validateProfile({
        ...current,
        teacherName: pick("teacher_name", current?.teacherName),
        institution: pick("institution", current?.institution),
        subject,
        language,
        ...(logo ? { logo } : { logo: undefined }),
      });
      await mkdir(base, { recursive: true, mode: 0o755 });
      await writeProfile(base, profile);
      return [];
    } catch (error) {
      for (const key of ["teacher_name", "institution", "subject"]) {
        delete answers[key];
        delete answers[`${key}:text`];
      }
      return [(error as Error).message];
    }
  }

  private async finish(
    workspace: string,
    state: EvaluaState,
    catalog: TopicCatalog,
  ): Promise<string> {
    const interview = state.interview as InterviewState;
    const base = await this.rootOf(workspace, state);
    const profile = await readProfile(base);
    if (interview.flow === "init") {
      delete state.interview;
      await this.save(workspace, state);
      return `Teacher profile saved in ${state.root}/teacher.yaml. Run /evalua:new to start an exam.`;
    }
    if (!profile) throw new Error("The teacher profile is missing; run /evalua:init");
    const draft = buildDraft(interview.answers, profile, this.clock, catalog);
    state.draft = draft;
    delete state.interview;
    await this.save(workspace, state);
    const exams = await listExamFolders(base);
    const folder = examFolderName(nextExamNumber(exams, state.lastExamNumber), draft.slug);
    const types = Object.entries(draft.itemTypes)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${type} ${count}`)
      .join(", ");
    return [
      "Exam draft recorded (the ficha tecnica for Gate A):",
      `- Title: ${draft.title}`,
      `- Theme: TEMA: ${draft.theme}`,
      `- Grade and level: ${draft.grade}, ${draft.level}`,
      `- Questions: ${draft.questionCount} (${types})`,
      `- Distribution: ${draft.distribution}${draft.bank ? ` (bank ${draft.bank.size}, ${draft.bank.variants} variants)` : ""}`,
      `- Layout: ${draft.columns} column(s), page limit ${draft.maxPages}`,
      `- Time: ${draft.durationMinutes} minutes, ${draft.instrument}, calculator ${draft.calculator ? "yes" : "no"}`,
      `- Closing: ${draft.closing.kind}`,
      `- School year: ${draft.schoolYear}`,
      `- Proposed folder: ${folder} (created only after Gate A)`,
      "",
      "Gate A, the teacher's approval of the spec and blueprint, arrives in a later release. Until then the draft stays in the workspace state and no exam folder is created.",
    ].join("\n");
  }
}
