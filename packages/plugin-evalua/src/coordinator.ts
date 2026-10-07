import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { detectChrome } from "./chrome/detect.js";
import { type Clock, systemClock } from "./clock.js";
import { familyIds } from "./families/index.js";
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
import { createTopicCatalog, loadKnowledge, shippedKnowledgeDir } from "./knowledge/index.js";
import {
  copyLogo,
  DEFAULT_SUBJECT,
  readProfile,
  validateProfile,
  writeProfile,
} from "./profile.js";
import { cleanText } from "./schemas.js";
import { emptyState, readState, validateRootName, writeState } from "./storage.js";
import type {
  EvaluaState,
  InterviewFlow,
  InterviewState,
  RoundId,
  TeacherProfile,
  TopicCatalog,
} from "./types.js";
import { evaluaRootPath, examFolderName, listExamFolders, nextExamNumber } from "./workspace.js";

export const DEFAULT_ROOT = "evalua";

export interface CoordinatorOptions {
  clock?: Clock;
  catalog?: TopicCatalog;
}

const profileKeys = ["teacher_name", "institution", "logo", "subject"].flatMap((key) => [
  key,
  `${key}:text`,
]);

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
  private readonly catalogCache = new Map<string, TopicCatalog>();

  constructor(
    private readonly api: PluginAPI,
    options: CoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.injectedCatalog = options.catalog;
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
    try {
      const profile = validateProfile({
        ...current,
        teacherName: pick("teacher_name", current?.teacherName),
        institution: pick("institution", current?.institution),
        subject,
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
