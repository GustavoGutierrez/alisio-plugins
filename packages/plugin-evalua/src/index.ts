import { type CommandContext, definePlugin, type PluginAPI, type ToolResult } from "@alisio/sdk";
import { type CoordinatorOptions, EvaluaCoordinator } from "./coordinator.js";
import { VERSION } from "./version.js";

export {
  type Blueprint,
  type BlueprintCell,
  type BlueprintInput,
  blueprintTotal,
  buildBlueprint,
  distribute,
} from "./blueprint.js";
export {
  type BuildInput,
  type BuildOutput,
  buildExam,
  type FitOutput,
  fitDocuments,
  type PdfPrinter,
  type RenderedDocuments,
  type RenderInput,
  renderDocuments,
} from "./build.js";
export { type ExamCheckInput, verifyExam } from "./checks.js";
export {
  CdpError,
  chromeArgs,
  type PrintRequest,
  type PrintResult,
  printHtmlToPdf,
} from "./chrome/cdp.js";
export {
  type ChromeDeps,
  type ChromeDetection,
  detectChrome,
  ENV_OVERRIDES,
  knownBrowserPaths,
  pathBrowserNames,
} from "./chrome/detect.js";
export { type Clock, fixedClock, schoolYear, systemClock } from "./clock.js";
export { EvaluaCoordinator } from "./coordinator.js";
export { families, familyIds, getFamily } from "./families/index.js";
export {
  type ExamItem,
  type GenerateInput,
  type GenerateResult,
  generateExam,
  MAX_SLOT_ATTEMPTS,
} from "./generate.js";
export { type CssOptions, renderCss } from "./html/css.js";
export { type EmitOptions, emitDocument, type MathRenderer } from "./html/emit.js";
export {
  acceptAnswers,
  buildDraft,
  buildRound,
  emptyCatalog,
  nextRound,
  parseTimeAnswer,
  splitItemTypes,
} from "./interview.js";
export {
  checkKatexItem,
  evaluaMathRenderer,
  katexCss,
  katexVendorPath,
  type MathResult,
  renderMath,
} from "./katex.js";
export {
  type CheckFinding,
  type CheckReport,
  createTopicCatalog,
  defaultKnowledgeLimits,
  knowledgeCheckIds,
  type LoadedKnowledge,
  type LoadedPack,
  type LoadedTopic,
  loadKnowledge,
  type PackMeta,
  shippedKnowledgeDir,
  shippedLocalesDir,
  shippedQuotesDir,
  shippedThemesDir,
  type Topic,
} from "./knowledge/index.js";
export {
  type DensityPreset,
  densityLadder,
  type HeaderStyle,
  legibilityFloors,
  presetById,
  withinFloors,
} from "./layout/presets.js";
export {
  buildLayoutReport,
  choosePreset,
  countPdfPages,
  type FitFailure,
  type FitInput,
  type FitResult,
  type LayoutReport,
  type PageCount,
} from "./layout.js";
export { type Locale, type LocaleCatalogue, loadLocale, parseLocale } from "./locales.js";
export {
  type Block,
  escapeHtml,
  type InlineToken,
  type MarkupLine,
  parseMarkup,
  type TableBlock,
  tokenizeInline,
} from "./markup.js";
export { latexPoly, latexRational } from "./math/latex.js";
export { Poly } from "./math/poly.js";
export { Rational } from "./math/rational.js";
export { createRng, deriveSeed, examSeed, type Rng } from "./math/rng.js";
export {
  type LinearSolution,
  type QuadraticSolution,
  solveLinear,
  solveQuadratic,
} from "./math/solvers.js";
export {
  buildAnswerSheetModel,
  buildExamModel,
  buildIntro,
  buildRubricModel,
  buildSolutionBookModel,
  type DocumentModel,
  type ExamModel,
  type ExamSpecLike,
  type IntroResult,
  type ProfileLike,
} from "./model.js";
export {
  copyLogo,
  detectImageKind,
  parseProfile,
  readProfile,
  stringifyProfile,
  validateProfile,
  writeProfile,
} from "./profile.js";
export {
  type ClosingInput,
  type ClosingSelection,
  loadQuotes,
  loadQuotesLayers,
  parseQuoteFile,
  type QuoteEntry,
  type QuoteKind,
  type QuotesCatalogue,
  type QuotesLayer,
  selectClosing,
} from "./quotes.js";
export {
  assertRelativePath,
  atomicWrite,
  canonicalJson,
  emptyState,
  readState,
  validateRootName,
  validateState,
  writeState,
} from "./storage.js";
export {
  DOC_THEME,
  loadThemeLayers,
  parseThemeFile,
  resolveTheme,
  type Theme,
  type ThemeLayer,
  type ThemesCatalogue,
} from "./themes.js";
export * from "./types.js";
export { checkKeyDistribution, verifyDraft, verifyItem } from "./verify.js";
export {
  allocateExamFolder,
  evaluaRootPath,
  listExamFolders,
  nextExamNumber,
  slugify,
  validateExamFolderName,
  validateSlug,
} from "./workspace.js";

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** Register the Evalua plugin on an API. `options` are test seams; production passes none. */
export function registerEvalua(
  api: PluginAPI,
  options: CoordinatorOptions = {},
): EvaluaCoordinator {
  const coordinator = new EvaluaCoordinator(api, options);
  const register = (
    name: string,
    description: string,
    argumentHint: string,
    handler: (args: string, sessionId?: string) => Promise<string>,
  ) =>
    api.commands.register(
      name,
      (args: string, context?: CommandContext) => handler(args, context?.sessionId),
      { description, argumentHint },
    );
  register(
    "init",
    "Create the Evalua workspace and set up the teacher profile (asked once)",
    "[dir] [--edit]",
    coordinator.init.bind(coordinator),
  );
  register(
    "new",
    "Start a new exam: a short interview whose draft waits for the teacher's approval",
    "[topic description | id=value ...]",
    coordinator.new.bind(coordinator),
  );
  register(
    "status",
    "Show the profile, pending interview round, draft and exam folders",
    "",
    coordinator.status.bind(coordinator),
  );

  api.tools.register({
    name: "evalua_profile",
    description:
      "Get or set the teacher profile (teacher name, institution, subject, paper, optional logo). The profile is asked once per workspace; never ask for it again when it exists. A logo is a PNG, JPEG or WebP file of at most 2 MB (SVG is rejected) given by path and copied into the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"] },
        teacherName: { type: "string", maxLength: 100 },
        institution: { type: "string", maxLength: 150 },
        subject: { type: "string", maxLength: 80 },
        paper: { type: "string", enum: ["letter", "a4"] },
        language: { type: "string", maxLength: 16 },
        logoPath: { type: "string", maxLength: 1024 },
        removeLogo: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    effect: "write",
    async execute(input, context) {
      const action = input.action;
      if (action !== "get" && action !== "set") return text("action must be get or set", true);
      const str = (key: string) =>
        typeof input[key] === "string" ? (input[key] as string) : undefined;
      try {
        const result = await coordinator.profileTool(context.workspace, {
          action,
          ...(str("teacherName") !== undefined
            ? { teacherName: str("teacherName") as string }
            : {}),
          ...(str("institution") !== undefined
            ? { institution: str("institution") as string }
            : {}),
          ...(str("subject") !== undefined ? { subject: str("subject") as string } : {}),
          ...(str("paper") !== undefined ? { paper: str("paper") as string } : {}),
          ...(str("language") !== undefined ? { language: str("language") as string } : {}),
          ...(str("logoPath") !== undefined ? { logoPath: str("logoPath") as string } : {}),
          ...(input.removeLogo === true ? { removeLogo: true } : {}),
        });
        return text(result.text, result.isError);
      } catch (error) {
        return text(error instanceof Error ? error.message : "evalua_profile failed", true);
      }
    },
  });
  api.tools.register({
    name: "evalua_answer",
    description:
      "Persist the teacher's answers to the currently pending interview round (ids come from the pending questions). Free text goes in '<id>:text'; several choices for a multi-select question are comma-separated. Returns the next questions or the recorded exam draft.",
    inputSchema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          additionalProperties: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
        },
      },
      required: ["answers"],
      additionalProperties: false,
    },
    effect: "write",
    async execute(input, context) {
      const raw = input.answers;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return text("answers must be an object of question id to value", true);
      }
      const answers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") answers[key] = value;
        else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          answers[key] = value as string[];
        } else return text(`Answer for ${key} must be text or a list of text`, true);
      }
      try {
        const result = await coordinator.answerTool(context.workspace, answers);
        return text(result.text, result.isError);
      } catch (error) {
        return text(error instanceof Error ? error.message : "evalua_answer failed", true);
      }
    },
  });
  api.tools.register({
    name: "evalua_status",
    description:
      "Report the Evalua workspace state as JSON: whether it is initialized, whether the teacher profile exists, the pending interview round and its question ids, whether an exam draft awaits approval, and the existing exam folders.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    async execute(_input, context) {
      try {
        return text(JSON.stringify(await coordinator.statusInfo(context.workspace), null, 2));
      } catch (error) {
        return text(error instanceof Error ? error.message : "evalua_status failed", true);
      }
    },
  });
  return coordinator;
}

const plugin = definePlugin({
  id: "evalua",
  name: "Evalua",
  description:
    "Guides teachers through a short interview for printable school math exams and keeps the teacher profile, workspace and exam numbering.",
  categories: ["methodology-harness"],
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI) {
    registerEvalua(api);
  },
});

export default plugin;
