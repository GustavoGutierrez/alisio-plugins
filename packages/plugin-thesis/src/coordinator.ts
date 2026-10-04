import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { isValidLanguageTag, loadBrief } from "./brief.js";
import { cacheRoot } from "./cache.js";
import {
  formatReport,
  type LoadProjectOptions,
  loadProject,
  parseGates,
  runChecks,
} from "./checks/index.js";
import { Blocked } from "./context.js";
import { Delegator } from "./delegate.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import {
  acceptAnswers,
  buildBriefText,
  buildRound,
  defaultRounds,
  flattenAnswers,
  hintFromEnvironment,
  icontecRound,
  intakeIntent,
  parseAnswerText,
  presentationRound,
  renderPending,
  seedAnswersFromRaw,
} from "./intake.js";
import { checkPacks, explain, listPacks, newPack } from "./pack-commands.js";
import type { ComplianceProfile } from "./policy/resolver.js";
import { type SetupDeps, setupTypst } from "./render/adapters/typst-pdf/setup.js";
import { type BuildOutcome, buildThesis } from "./render/build.js";
import { createDefaultRegistry } from "./render/default-registry.js";
import type { BuildScope } from "./render/model.js";
import type { RendererRegistry } from "./render/registry.js";
import {
  type Identifier,
  parseIdentifier,
  parseSearchInput,
  ScholarClient,
  type ScholarRecord,
} from "./research/client.js";
import { parseAddedSource } from "./research/flow.js";
import {
  classifyHost,
  officialDomainsFromProfile,
  resolveChecked,
  suggestStatus,
} from "./research/verify.js";
import {
  atomicWrite,
  canonicalJson,
  defaultState,
  readState,
  validateRootName,
  writeState,
} from "./storage.js";
import { checkStyleFiles, listStyles } from "./style-commands.js";
import { type CheckReport, type Gate, idPatterns, type ThesisState } from "./types.js";
import { Workflow } from "./workflow.js";
import {
  createWorkspaceTree,
  refreshProject,
  thesisRootPath,
  writeCheckReport,
} from "./workspace.js";

export interface CoordinatorOptions {
  /** Renderer registry; tests add the test-json adapter here. */
  registry?: RendererRegistry;
  /** Test seam for `/thesis:setup` (fetch, process runner, pins). */
  setupDeps?: Partial<SetupDeps>;
  /** Test seams; production uses the package defaults. */
  packsRoot?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Scholarly HTTP client; tests inject one backed by recorded fixtures. */
  scholar?: ScholarClient;
}

/** Plain-text build summary shared by the command and the CLI. */
export function formatBuild(outcome: BuildOutcome): string {
  const errors = outcome.findings.filter((finding) => finding.severity === "error");
  const lines = [
    outcome.ok
      ? `Build OK (${outcome.scope}): ${outcome.path ?? "no file"}`
      : `Build failed (${outcome.scope}): ${errors.length} error(s)`,
    `Engine: ${outcome.engine}${outcome.pages === undefined ? "" : `; ${outcome.pages} page(s)`}; ${outcome.ms} ms`,
  ];
  for (const finding of errors.slice(0, 10)) {
    lines.push(
      `ERROR ${finding.code}${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""} ${finding.message}${finding.hint ? ` (${finding.hint})` : ""}`,
    );
  }
  if (errors.length > 10) lines.push(`... and ${errors.length - 10} more error(s)`);
  for (const warning of outcome.warnings.slice(0, 5)) lines.push(`warning ${warning}`);
  if (outcome.warnings.length > 5)
    lines.push(`... and ${outcome.warnings.length - 5} more warning(s)`);
  return lines.join("\n");
}

/** A phase command that cannot run yet answers with its reason instead of failing. */
async function blockable(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Blocked) return `Blocked: ${error.message}`;
    throw error;
  }
}

/** Split `<target> -- <text>` into its two parts; the text is empty when there is no delimiter. */
function splitDelimited(args: string): { head: string; text: string } {
  const delimiter = args.search(/(^|\s)--(\s|$)/);
  if (delimiter < 0) return { head: args.trim(), text: "" };
  const marker = args.indexOf("--", delimiter);
  return { head: args.slice(0, marker).trim(), text: args.slice(marker + 2).trim() };
}

function tokens(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export class ThesisCoordinator {
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly projectOptions: LoadProjectOptions;
  readonly scholar: ScholarClient;
  private readonly workflow: Workflow;
  private readonly registry: RendererRegistry;
  private readonly setupDeps: Partial<SetupDeps> | undefined;

  constructor(
    private readonly api: PluginAPI,
    options: CoordinatorOptions = {},
  ) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.setupDeps = options.setupDeps;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.projectOptions = options.packsRoot ? { packsRoot: options.packsRoot } : {};
    this.scholar = options.scholar ?? new ScholarClient({ env: this.env });
    this.workflow = new Workflow({
      api,
      now: this.now,
      projectOptions: this.projectOptions,
      scholar: this.scholar,
      delegator: new Delegator(api),
      env: this.env,
      cacheRoot: () => this.cacheRoot(),
      build: (workspace, input) => this.buildRun(workspace, input),
    });
  }

  private workspace(sessionId?: string): string {
    if (!sessionId) throw new Error("Thesis commands require an active Alisio session");
    return this.api.sessions.workspace(sessionId);
  }

  private async requireState(workspace: string): Promise<ThesisState> {
    const state = await readState(workspace);
    if (!state) throw new Error("No thesis workspace here. Run /thesis:init first.");
    return state;
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:init
  // ------------------------------------------------------------------------------------------

  async init(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    let directory: string | undefined;
    let hintArgument: string | undefined;
    let presentation = false;
    const parts = tokens(args);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as string;
      if (part === "--presentation") presentation = true;
      else if (part === "--lang") {
        index += 1;
        hintArgument = parts[index];
        if (!hintArgument) throw new Error("--lang needs a BCP-47 tag");
      } else if (part.startsWith("--")) throw new Error(`Unknown option ${part}`);
      else if (directory === undefined) directory = part;
      else throw new Error("Usage: /thesis:init [dir] [--lang <bcp47>] [--presentation]");
    }
    if (directory !== undefined) validateRootName(directory);
    if (hintArgument !== undefined && !isValidLanguageTag(hintArgument)) {
      throw new Error("--lang must be a well-formed BCP-47 tag such as es-CO");
    }

    let state = await readState(workspace);
    if (state && directory !== undefined && directory !== state.root) {
      throw new Error(
        `A thesis workspace already exists at "${state.root}"; it cannot be moved with init`,
      );
    }
    const fresh = !state;
    state ??= defaultState(directory ?? "thesis");
    const base = await createWorkspaceTree(workspace, state.root);

    if (fresh) {
      try {
        const existing = loadBrief(await readFile(join(base, "thesis.yaml"), "utf8"));
        if (existing.raw) state.intake.answers = seedAnswersFromRaw(existing.raw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (hintArgument) {
      state.intake.languageHint = hintArgument;
    } else {
      state.intake.languageHint ??= hintFromEnvironment(this.env);
    }

    if (presentation) {
      if (![1, 2].every((round) => state.intake.completedRounds.includes(round))) {
        throw new Error(
          "Finish interview rounds 1 and 2 before the presentation settings (/thesis:init)",
        );
      }
    }
    await writeState(workspace, state);
    const message = await this.advance(
      workspace,
      state,
      presentation ? await this.presentationRounds(workspace, state) : defaultRounds,
    );
    return fresh ? `Created the thesis workspace at ${state.root}/.\n\n${message}` : message;
  }

  /** Round 4, plus the ICONTEC questions (round 5) when that profile is selected. */
  private async presentationRounds(workspace: string, state: ThesisState): Promise<number[]> {
    let icontec = state.intake.answers.citationStyle === "icontec-ntc1486-2022";
    if (!icontec) {
      try {
        const base = await thesisRootPath(workspace, state.root);
        const profile = JSON.parse(await readFile(join(base, "compliance-profile.json"), "utf8"));
        icontec = profile?.presentationStandard?.value === "icontec-ntc1486-2022";
      } catch {
        icontec = false;
      }
    }
    return icontec ? [presentationRound, icontecRound] : [presentationRound];
  }

  /** Drive the interview: ask interactively, or park the round as pending questions. */
  private async advance(
    workspace: string,
    state: ThesisState,
    rounds: readonly number[],
  ): Promise<string> {
    const hint = state.intake.languageHint ?? "en";
    for (const round of rounds) {
      if (state.intake.completedRounds.includes(round)) continue;
      let questions = buildRound(round, state.intake.answers, hint);
      while (questions.length > 0) {
        if (!this.api.ui.interactive()) return this.park(workspace, state, round, questions);
        const asked = await this.api.ui.askQuestions({ questions, label: "Thesis interview" });
        const { accepted, errors } = acceptAnswers(questions, flattenAnswers(asked), hint);
        Object.assign(state.intake.answers, accepted);
        const remaining = buildRound(round, state.intake.answers, hint);
        if (errors.length > 0 || remaining.length === questions.length) {
          return this.park(workspace, state, round, remaining, errors);
        }
        questions = remaining;
      }
      await this.completeRound(workspace, state, round);
    }
    delete state.pendingQuestions;
    await writeState(workspace, state);
    return this.summary(workspace, state);
  }

  private async park(
    workspace: string,
    state: ThesisState,
    round: number,
    questions: ReturnType<typeof buildRound>,
    errors: string[] = [],
  ): Promise<string> {
    state.pendingQuestions = { round, createdAt: this.now().toISOString(), questions };
    await writeState(workspace, state);
    const prefix = errors.length
      ? `Some answers were not accepted:\n- ${errors.join("\n- ")}\n\n`
      : "";
    return `${prefix}${renderPending(state.pendingQuestions)}`;
  }

  /** Persist everything a finished round produces: brief, profile, G0, intent, state. */
  private async completeRound(workspace: string, state: ThesisState, round: number): Promise<void> {
    const base = await thesisRootPath(workspace, state.root);
    let existing: Record<string, unknown> | undefined;
    try {
      const parsed = loadBrief(await readFile(join(base, "thesis.yaml"), "utf8"));
      if (!parsed.raw)
        throw new Error("thesis.yaml is not valid YAML; fix it and run /thesis:init again");
      existing = parsed.raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const built = buildBriefText(state.intake.answers, existing, {
      hint: state.intake.languageHint ?? "en",
      year: this.now().getFullYear(),
    });
    if (!built.text) {
      throw new Error(
        `thesis.yaml cannot be updated from the answers:\n- ${built.errors.join("\n- ")}`,
      );
    }
    await atomicWrite(join(base, "thesis.yaml"), built.text);
    if (round === 3)
      await atomicWrite(
        join(base, "research", "intake.json"),
        canonicalJson(intakeIntent(state.intake.answers)),
      );

    if (!state.intake.completedRounds.includes(round)) state.intake.completedRounds.push(round);
    state.intake.completedRounds.sort();
    delete state.pendingQuestions;

    const report = await this.runG0(base);
    state.lastCheck = {
      at: report.at,
      errors: report.counts.error,
      warnings: report.counts.warning,
    };
    if (
      state.phase === "intake" &&
      [1, 2].every((needed) => state.intake.completedRounds.includes(needed)) &&
      report.ok
    ) {
      state.phase = "design";
    }
    await writeState(workspace, state);
  }

  private async runG0(base: string): Promise<CheckReport> {
    const project = await refreshProject(base, this.projectOptions);
    const report = runChecks(project, { gates: ["G0"], now: this.now });
    await writeCheckReport(base, report);
    return report;
  }

  private async summary(workspace: string, state: ThesisState): Promise<string> {
    const base = await thesisRootPath(workspace, state.root);
    const lines = [`Interview complete for ${state.root}/.`];
    const brief = loadBrief(await readFile(join(base, "thesis.yaml"), "utf8")).brief;
    const project = await loadProject(base, this.projectOptions);
    if (brief && project.profile) {
      lines.push(
        `Language ${brief.language}, ${brief.workType}, country ${brief.institution.country}.`,
        `Citation style: ${project.profile.citationStyle.value}${project.profile.citationStyle.defaulted ? " (default; confirm with your program)" : ""}.`,
        "Wrote thesis.yaml and compliance-profile.json.",
      );
    }
    if (state.lastCheck) {
      lines.push(
        `G0: ${state.lastCheck.errors} error(s), ${state.lastCheck.warnings} warning(s). Run /thesis:check for details.`,
      );
    }
    lines.push(this.nextStep(state));
    return lines.join("\n");
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:answer
  // ------------------------------------------------------------------------------------------

  async answer(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const state = await this.requireState(workspace);
    const pending = state.pendingQuestions;
    if (!pending)
      throw new Error("There are no pending interview questions. Run /thesis:init to continue.");
    const hint = state.intake.languageHint ?? "en";

    let flat: Record<string, string>;
    try {
      flat = parseAnswerText(
        args,
        pending.questions.map((question) => question.id),
      );
    } catch (error) {
      return `${(error as Error).message}\n\n${renderPending(pending)}`;
    }
    const { accepted, errors } = acceptAnswers(pending.questions, flat, hint);
    if (errors.length > 0) {
      return `No answers were recorded:\n- ${errors.join("\n- ")}\n\n${renderPending(pending)}`;
    }
    Object.assign(state.intake.answers, accepted);
    const remaining = buildRound(pending.round, state.intake.answers, hint);
    if (remaining.length > 0) {
      return this.park(workspace, state, pending.round, remaining);
    }
    await this.completeRound(workspace, state, pending.round);
    return this.advance(
      workspace,
      state,
      pending.round === presentationRound
        ? await this.presentationRounds(workspace, state)
        : pending.round === icontecRound
          ? []
          : defaultRounds,
    );
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:status and thesis_status
  // ------------------------------------------------------------------------------------------

  private nextStep(state: ThesisState): string {
    if (state.pendingQuestions)
      return `Next: answer the pending round ${state.pendingQuestions.round} questions with /thesis:answer.`;
    if (!defaultRounds.every((round) => state.intake.completedRounds.includes(round))) {
      return "Next: finish the interview with /thesis:init.";
    }
    if (state.phase === "intake")
      return "Next: fix the G0 errors (see /thesis:check), then run /thesis:check again.";
    const command = this.workflow.nextCommand({ state });
    const extra =
      state.phase === "design" && !state.intake.completedRounds.includes(presentationRound)
        ? " Optional: /thesis:init --presentation sets paper, palette, typeface and AI declaration."
        : "";
    return `Next: ${command}.${extra}`;
  }

  async statusSummary(workspace: string): Promise<Record<string, unknown>> {
    const state = await readState(workspace);
    if (!state) {
      return { initialized: false, next: "Run /thesis:init to create the thesis workspace." };
    }
    return {
      initialized: true,
      root: state.root,
      phase: state.phase,
      humanGates: Object.fromEntries(
        Object.entries(state.humanGates).map(([name, gate]) => [name, gate.status]),
      ),
      sections: Object.entries(state.sections)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, section]) => ({
          id,
          title: section.title ?? null,
          status: section.status,
          next: this.workflow.sectionNext(state, id) || null,
        })),
      lastReview: state.lastReview ?? null,
      intake: {
        completedRounds: state.intake.completedRounds,
        pendingRound: state.pendingQuestions?.round ?? null,
        pendingQuestionIds: state.pendingQuestions?.questions.map((question) => question.id) ?? [],
      },
      lastCheck: state.lastCheck ?? null,
      lastBuild: state.lastBuild ?? null,
      next: this.nextStep(state),
    };
  }

  async status(_args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const summary = await this.statusSummary(workspace);
    if (!summary.initialized) return `Thesis Studio: not initialized.\n${summary.next as string}`;
    const state = (await readState(workspace)) as ThesisState;
    const gates = Object.entries(state.humanGates)
      .map(([name, gate]) => `${name} ${gate.status}`)
      .join(", ");
    const sectionLines = Object.keys(state.sections)
      .sort()
      .map((id) => {
        const section = state.sections[id] as ThesisState["sections"][string];
        const next = this.workflow.sectionNext(state, id);
        return `  ${id} ${section.title ?? ""} [${section.status}]${next ? ` -> ${next}` : ""}`;
      });
    return [
      "Thesis Studio",
      `Root: ${state.root}/`,
      `Phase: ${state.phase}`,
      `Interview: rounds ${state.intake.completedRounds.join(", ") || "none"} complete${state.pendingQuestions ? `; round ${state.pendingQuestions.round} awaits answers` : ""}`,
      `Human gates: ${gates}`,
      sectionLines.length ? `Sections:\n${sectionLines.join("\n")}` : "Sections: none yet",
      ...(state.lastReview
        ? [
            `Last review: ${state.lastReview.scope}, ${state.lastReview.findings} finding(s), ${state.lastReview.blocking ?? 0} blocking, at ${state.lastReview.at}`,
          ]
        : []),
      state.lastCheck
        ? `Last check: ${state.lastCheck.errors} error(s), ${state.lastCheck.warnings} warning(s) at ${state.lastCheck.at}`
        : "Last check: never",
      this.nextStep(state),
    ].join("\n");
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:check and thesis_check
  // ------------------------------------------------------------------------------------------

  async check(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const state = await this.requireState(workspace);
    const selected: Gate[] = parseGates(
      tokens(args.replace(/^--\s*/, "")).flatMap((token) => token.split(",").filter(Boolean)),
    );
    const base = await thesisRootPath(workspace, state.root);
    const project = await refreshProject(base, {
      ...this.projectOptions,
      state,
    });
    const report = runChecks(project, { gates: selected, now: this.now });
    await writeCheckReport(base, report);
    state.lastCheck = {
      at: report.at,
      errors: report.counts.error,
      warnings: report.counts.warning,
    };
    await writeState(workspace, state);
    return formatReport(report);
  }

  /** Read-only variant used by the thesis_check tool: it never writes files. */
  async checkReadOnly(
    workspace: string,
    input: { gates?: string[]; section?: string },
  ): Promise<CheckReport> {
    const state = await this.requireState(workspace);
    if (input.section !== undefined && !idPatterns.section.test(input.section)) {
      throw new Error("section must look like SEC-03 or SEC-03.02");
    }
    const selected = parseGates(input.gates ?? []);
    const project = await loadProject(await thesisRootPath(workspace, state.root), {
      ...this.projectOptions,
      state,
    });
    return runChecks(project, {
      gates: selected,
      now: this.now,
      ...(input.section ? { section: input.section } : {}),
    });
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:pack
  // ------------------------------------------------------------------------------------------

  async pack(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const state = await this.requireState(workspace);
    const [sub, ...rest] = tokens(args.replace(/^--\s*/, ""));
    const base = await thesisRootPath(workspace, state.root);
    const project = await loadProject(base, this.projectOptions);
    switch (sub) {
      case "list":
        return listPacks(project);
      case "check":
        return checkPacks(project, this.now);
      case "explain":
        if (rest.length === 0) throw new Error("Usage: /thesis:pack explain <ruleId|value>");
        return explain(project, rest.join(" "));
      case "new":
        return newPack(this.api, project, base, rest, this.now);
      default:
        throw new Error(
          "Usage: /thesis:pack new <scope> <id> | list | check | explain <ruleId|value>",
        );
    }
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:style
  // ------------------------------------------------------------------------------------------

  async style(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    const usage = "Usage: /thesis:style new <id> -- <guide text|URL|path> | list | check";
    const { head, text } = splitDelimited(args.replace(/^--\s*/, ""));
    const [sub, ...rest] = tokens(head);
    if (sub === "new") {
      if (rest.length !== 1 || !text) throw new Error(usage);
      return blockable(() =>
        this.workflow.authoring.styleNew(workspace, sessionId as string, rest[0] as string, text),
      );
    }
    const state = await this.requireState(workspace);
    const base = await thesisRootPath(workspace, state.root);
    if ((sub !== "list" && sub !== "check") || rest.length > 0 || text) throw new Error(usage);
    const project = await loadProject(base, this.projectOptions);
    if (sub === "list") return listStyles(project);
    return (
      await checkStyleFiles(project, { env: this.env, cacheRoot: this.cacheRoot(), now: this.now })
    ).text;
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:norms
  // ------------------------------------------------------------------------------------------

  async norms(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args.replace(/^--\s*/, ""));
    if (head !== "import" || !text)
      throw new Error("Usage: /thesis:norms import -- <guide text|URL|path>");
    return blockable(() =>
      this.workflow.authoring.normsImport(this.workspace(sessionId), sessionId as string, text),
    );
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:design, outline, approve, revise, research, next
  // ------------------------------------------------------------------------------------------

  async design(args: string, sessionId?: string): Promise<string> {
    if (args.trim())
      throw new Error(
        "Usage: /thesis:design (use /thesis:revise A|B -- <feedback> to change a draft)",
      );
    return blockable(() => this.workflow.design(this.workspace(sessionId), sessionId as string));
  }

  async outline(args: string, sessionId?: string): Promise<string> {
    if (args.trim())
      throw new Error(
        "Usage: /thesis:outline (use /thesis:revise OUTLINE -- <feedback> to change a draft)",
      );
    return blockable(() => this.workflow.outline(this.workspace(sessionId), sessionId as string));
  }

  async approve(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args);
    if (!head || head.includes(" ")) {
      throw new Error(
        "Usage: /thesis:approve <A|B|OUTLINE|C|SEC-id|FND-id|ETH-id|norms|style:id> [-- notes]",
      );
    }
    return blockable(() =>
      this.workflow.approve(
        this.workspace(sessionId),
        sessionId as string,
        head,
        text || undefined,
      ),
    );
  }

  async revise(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args);
    if (!head || head.includes(" ") || (!text && !/^FND-\d{4}$/.test(head))) {
      throw new Error(
        "Usage: /thesis:revise <A|B|OUTLINE|SEC-id|FND-id|norms|style:id> -- <feedback>",
      );
    }
    return blockable(() =>
      this.workflow.revise(this.workspace(sessionId), sessionId as string, head, text),
    );
  }

  async research(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args);
    const usage =
      "Usage: /thesis:research <SEC-id|next> [-- <search more on ...> | -- add <DOI or URL; title; year; type>]";
    if (!head || head.includes(" ") || (head !== "next" && !idPatterns.section.test(head))) {
      throw new Error(usage);
    }
    const added = /^add\s+(.+)$/i.exec(text);
    if (added) {
      const parsed = parseAddedSource(added[1] as string);
      if (parsed.error) throw new Error(parsed.error);
    }
    return blockable(() =>
      this.workflow.research.run(this.workspace(sessionId), sessionId as string, head, {
        ...(added ? { add: added[1] as string } : text ? { focus: text } : {}),
      }),
    );
  }

  async draft(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args);
    if (!head || head.includes(" ") || (head !== "next" && !idPatterns.section.test(head))) {
      throw new Error("Usage: /thesis:draft <SEC-id|next> [-- <feedback>]");
    }
    return blockable(() =>
      this.workflow.drafts.run(this.workspace(sessionId), sessionId as string, head, {
        ...(text ? { feedback: text } : {}),
      }),
    );
  }

  async figure(args: string, sessionId?: string): Promise<string> {
    const { head, text } = splitDelimited(args);
    if (!idPatterns.section.test(head) || !text)
      throw new Error("Usage: /thesis:figure <SEC-id> -- <what the figure should show>");
    return blockable(() =>
      this.workflow.figures.run(this.workspace(sessionId), sessionId as string, head, text),
    );
  }

  async review(args: string, sessionId?: string): Promise<string> {
    const target = args.trim() || "all";
    if (target !== "all" && !idPatterns.section.test(target))
      throw new Error("Usage: /thesis:review [SEC-id|all]");
    return blockable(() =>
      this.workflow.reviews.run(this.workspace(sessionId), sessionId as string, target),
    );
  }

  async finalize(args: string, sessionId?: string): Promise<string> {
    if (args.trim()) throw new Error("Usage: /thesis:finalize");
    return blockable(() =>
      this.workflow.finalize.run(this.workspace(sessionId), sessionId as string),
    );
  }

  async next(_args: string, sessionId?: string): Promise<string> {
    return blockable(() => this.workflow.next(this.workspace(sessionId), sessionId as string));
  }

  // ------------------------------------------------------------------------------------------
  // scholarly tools
  // ------------------------------------------------------------------------------------------

  /** thesis_scholar_search: structured, sanitized and capped ScholarRecords. */
  async scholarSearch(input: unknown, signal?: AbortSignal): Promise<{ results: ScholarRecord[] }> {
    const parsed = parseSearchInput(input);
    return { results: await this.scholar.search(parsed, signal) };
  }

  /** thesis_scholar_resolve: one record with its retraction flag and what verification would say. */
  async scholarResolve(workspace: string | undefined, input: unknown, signal?: AbortSignal) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error("invalid input");
    const keys = Object.keys(input);
    if (keys.some((key) => key !== "identifier")) throw new Error("invalid input");
    const identifier: Identifier = parseIdentifier((input as { identifier?: unknown }).identifier);
    let profile: ComplianceProfile | undefined;
    if (workspace) {
      const state = await readState(workspace).catch(() => undefined);
      if (state) {
        profile = (
          await loadProject(await thesisRootPath(workspace, state.root), this.projectOptions)
        ).profile;
      }
    }
    const domains = officialDomainsFromProfile(profile);
    if (identifier.kind === "url") {
      // Official pages are matched by host only; reachability is never tested.
      const tier = classifyHost(identifier.value, "law", domains).tier;
      return {
        identifier,
        record: null,
        retraction: { retracted: false },
        verification: {
          method: "official_domain",
          officialDomain:
            tier === "primary" || tier === "type_not_allowed"
              ? "official"
              : tier === "indexing"
                ? "indexing"
                : "none",
          suggestedStatus:
            tier === "primary" || tier === "type_not_allowed"
              ? "VERIFIED_PRIMARY (when the type is law, standard, report or dataset)"
              : "UNVERIFIED",
        },
      };
    }
    const resolved = await resolveChecked(this.scholar, identifier, signal);
    if (!resolved)
      return {
        identifier,
        record: null,
        retraction: { retracted: false },
        verification: {
          method: identifier.kind === "doi" ? "crossref" : identifier.kind,
          officialDomain: "none",
          suggestedStatus: "UNVERIFIED",
        },
      };
    return {
      identifier,
      record: resolved.record,
      retraction: { retracted: resolved.retracted },
      verification: {
        method: resolved.record.source,
        officialDomain: "none",
        suggestedStatus: resolved.retracted ? "REJECTED" : suggestStatus(resolved.record, domains),
      },
    };
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:doctor
  // ------------------------------------------------------------------------------------------

  async doctor(): Promise<string> {
    return formatDoctor(await runDoctor({ env: this.env, cacheRoot: this.cacheRoot() }));
  }

  // ------------------------------------------------------------------------------------------
  // /thesis:build, /thesis:setup and thesis_build
  // ------------------------------------------------------------------------------------------

  private cacheRoot(): string {
    const host = (this.api as { paths?: { cache?: string } }).paths?.cache;
    return cacheRoot(host, this.env);
  }

  /** Build the thesis and record the result in the state; shared by the command and the tool. */
  async buildRun(
    workspace: string,
    input: { scope: BuildScope; section?: string; pdfa?: boolean; format?: string },
    signal?: AbortSignal,
  ): Promise<BuildOutcome> {
    const state = await this.requireState(workspace);
    if (state.phase === "intake") {
      throw new Blocked("finish the intake interview first (/thesis:init, /thesis:answer).");
    }
    const root = await thesisRootPath(workspace, state.root);
    const outcome = await buildThesis({
      root,
      scope: input.scope,
      ...(input.section ? { section: input.section } : {}),
      ...(input.pdfa ? { pdfa: true } : {}),
      ...(input.format ? { format: input.format } : {}),
      sections: state.sections,
      env: this.env,
      cacheRoot: this.cacheRoot(),
      registry: this.registry,
      ...(this.projectOptions.packsRoot ? { packsRoot: this.projectOptions.packsRoot } : {}),
      now: this.now,
      ...(signal ? { signal } : {}),
      progress: (note) => this.api.ui.status("build", note),
    });
    this.api.ui.status("build", undefined);
    if (outcome.ok && outcome.path?.endsWith(".pdf")) {
      state.lastBuild = {
        at: this.now().toISOString(),
        engine: outcome.engine.startsWith("chrome-pdf") ? "chrome" : "typst-cli",
        pdf: relative(workspace, outcome.path).split("\\").join("/"),
        ms: outcome.ms,
      };
      await writeState(workspace, state);
    }
    return outcome;
  }

  async build(args: string, sessionId?: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    let scope: BuildScope = "full";
    let section: string | undefined;
    let pdfa = false;
    let format = "pdf";
    const parts = tokens(args);
    for (const part of parts) {
      if (part === "--pdfa") pdfa = true;
      else if (part === "--html") format = "html";
      else if (part === "full") scope = "full";
      else if (part === "approved") scope = "approved";
      else if (idPatterns.section.test(part)) {
        scope = "section";
        section = part;
      } else throw new Error("Usage: /thesis:build [full|approved|SEC-id] [--pdfa] [--html]");
    }
    return blockable(async () =>
      formatBuild(
        await this.buildRun(workspace, { scope, ...(section ? { section } : {}), pdfa, format }),
      ),
    );
  }

  async setup(args: string): Promise<string> {
    if (args.trim()) throw new Error("Usage: /thesis:setup");
    this.api.ui.status("setup", "installing the pinned Typst");
    try {
      const result = await setupTypst({
        cacheRoot: this.cacheRoot(),
        ...(this.setupDeps ? { deps: this.setupDeps } : {}),
      });
      return result.ok ? result.message : `Setup failed: ${result.message}`;
    } finally {
      this.api.ui.status("setup", undefined);
    }
  }
}
