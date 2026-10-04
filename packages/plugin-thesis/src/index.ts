import { type CommandContext, definePlugin, type PluginAPI, type ToolResult } from "@alisio/sdk";
import { type CoordinatorOptions, ThesisCoordinator } from "./coordinator.js";
import { resourcePaths } from "./resources.js";
import { VERSION } from "./version.js";

export { applyBriefDefaults, isValidLanguageTag, loadBrief, stringifyBrief } from "./brief.js";
export { cacheRoot } from "./cache.js";
export { checkRegistry, formatReport, loadProject, parseGates, runChecks } from "./checks/index.js";
export { detectChrome } from "./chrome/detect.js";
export { parseClaimsText, serializeClaims } from "./claims.js";
export { ThesisCoordinator } from "./coordinator.js";
export { diffProtected } from "./diffguard.js";
export { formatDoctor, runDoctor } from "./doctor.js";
export { mapEthicsRequirements, validateEthicsAnswers } from "./policy/ethics.js";
export { loadOverrides, loadPacks, resolve } from "./policy/resolver.js";
export { type BuildOutcome, type BuildRequest, buildThesis } from "./render/build.js";
export { createDefaultRegistry } from "./render/default-registry.js";
export * from "./render/index.js";
export { generateBibtex } from "./research/bibtex.js";
export { ScholarClient } from "./research/client.js";
export { loadRoleInstructions, parseResource, resourcePaths, roleSkills } from "./resources.js";
export {
  assertRelativePath,
  atomicWrite,
  canonicalJson,
  validateRootName,
  validateState,
} from "./storage.js";
export * from "./types.js";

function text(value: unknown, isError = false): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/** Register the thesis plugin on an API. `options` are test seams; production passes none. */
export function registerThesis(
  api: PluginAPI,
  options: CoordinatorOptions = {},
): ThesisCoordinator {
  api.resources.agents(resourcePaths.agents);
  api.resources.skills(resourcePaths.skills);
  const coordinator = new ThesisCoordinator(api, options);
  const register = (
    name: string,
    description: string,
    argumentHint: string,
    handler: (args: string, sessionId?: string) => Promise<string>,
  ) =>
    api.commands.register(
      name,
      (args: string, context?: CommandContext) => handler(args, context?.sessionId),
      {
        description,
        argumentHint,
      },
    );
  register(
    "init",
    "Create the thesis workspace and run the intake interview",
    "[dir] [--lang <bcp47>] [--presentation]",
    coordinator.init.bind(coordinator),
  );
  register(
    "answer",
    "Answer pending interview questions headlessly",
    "-- <id=value ...|json>",
    coordinator.answer.bind(coordinator),
  );
  register(
    "status",
    "Show phase, gates, sections and the next step",
    "",
    coordinator.status.bind(coordinator),
  );
  register(
    "check",
    "Run the deterministic checks and write the report",
    "[gate...]",
    coordinator.check.bind(coordinator),
  );
  register(
    "pack",
    "Create, list, check and explain policy packs",
    "new <scope> <id> | list | check | explain <ruleId|value>",
    coordinator.pack.bind(coordinator),
  );
  register(
    "style",
    "Author, list and check citation styles and presentation profiles",
    "new <id> -- <guide text|URL|path> | list | check",
    coordinator.style.bind(coordinator),
  );
  register(
    "norms",
    "Turn an institutional guide or rubric into a workspace policy pack",
    "import -- <guide text|URL|path>",
    coordinator.norms.bind(coordinator),
  );
  register(
    "design",
    "Draft the research protocol and ask Human Gates A and B",
    "",
    coordinator.design.bind(coordinator),
  );
  register(
    "outline",
    "Draft the section outline and ask the OUTLINE gate",
    "",
    coordinator.outline.bind(coordinator),
  );
  register(
    "approve",
    "Record a human approval: a gate, a section, a finding, an ethics requirement, norms or a style",
    "<A|B|OUTLINE|C|SEC-id|FND-id|ETH-id|norms|style:id> [-- notes]",
    coordinator.approve.bind(coordinator),
  );
  register(
    "revise",
    "Send feedback to the role that owns a draft, a section or a review finding",
    "<A|B|OUTLINE|SEC-id|FND-id|norms|style:id> -- <feedback>",
    coordinator.revise.bind(coordinator),
  );
  register(
    "research",
    "Search, verify and appraise sources for a section and write its dossier",
    "<SEC-id|next> [-- <search more on ...> | -- add <DOI or URL; title; year; type>]",
    coordinator.research.bind(coordinator),
  );
  register(
    "draft",
    "Draft a section from approved evidence, edit it, check it and ask for approval",
    "<SEC-id|next> [-- <feedback>]",
    coordinator.draft.bind(coordinator),
  );
  register(
    "figure",
    "Draft a chart, diagram or table for a section",
    "<SEC-id> -- <request>",
    coordinator.figure.bind(coordinator),
  );
  register(
    "review",
    "Independent review of the built sections; findings go to reviews/",
    "[SEC-id|all]",
    coordinator.review.bind(coordinator),
  );
  register(
    "finalize",
    "G9 and G10, Human Gate C, PDF/A build and the submission package",
    "",
    coordinator.finalize.bind(coordinator),
  );
  register(
    "build",
    "Build the thesis PDF (full, approved sections or one section)",
    "[full|approved|SEC-id] [--pdfa] [--html]",
    coordinator.build.bind(coordinator),
  );
  register(
    "setup",
    "Install the pinned Typst engine into the cache (checksum verified)",
    "",
    (args) => coordinator.setup(args),
  );
  register("next", "Run the next recommended step", "", coordinator.next.bind(coordinator));
  register("doctor", "Report engines, vendored packages and policy packs", "", () =>
    coordinator.doctor(),
  );

  api.tools.register({
    name: "thesis_scholar_search",
    description:
      "Search OpenAlex, Crossref or arXiv and return structured JSON ScholarRecords. Discovery only: a record is citable only after the coordinator verifies it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        source: { type: "string", enum: ["openalex", "crossref", "arxiv"] },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        fromYear: { type: "integer", minimum: 1600, maximum: 2200 },
        toYear: { type: "integer", minimum: 1600, maximum: 2200 },
        language: { type: "string", pattern: "^[A-Za-z]{2,3}$" },
      },
      required: ["query", "source"],
      additionalProperties: false,
    },
    effect: "external",
    async execute(input, context) {
      try {
        return text(await coordinator.scholarSearch(input, context.signal));
      } catch (error) {
        return text(error instanceof Error ? error.message : "thesis_scholar_search failed", true);
      }
    },
  });
  api.tools.register({
    name: "thesis_scholar_resolve",
    description:
      "Resolve a DOI, arXiv id, OpenAlex id (W...) or an official-domain URL to one structured JSON ScholarRecord with its retraction flag and the status verification would assign.",
    inputSchema: {
      type: "object",
      properties: { identifier: { type: "string", minLength: 1, maxLength: 2048 } },
      required: ["identifier"],
      additionalProperties: false,
    },
    effect: "external",
    async execute(input, context) {
      try {
        return text(await coordinator.scholarResolve(context.workspace, input, context.signal));
      } catch (error) {
        return text(error instanceof Error ? error.message : "thesis_scholar_resolve failed", true);
      }
    },
  });
  api.tools.register({
    name: "thesis_status",
    description: "Summarize the thesis workspace: phase, human gates, sections and the next step.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    async execute(_input, context) {
      try {
        return text(await coordinator.statusSummary(context.workspace));
      } catch (error) {
        return text(error instanceof Error ? error.message : "thesis_status failed", true);
      }
    },
  });
  api.tools.register({
    name: "thesis_check",
    description:
      "Run the deterministic thesis checks and return the CheckReport as JSON. Read-only; use /thesis:check to also write the report.",
    inputSchema: {
      type: "object",
      properties: {
        gates: {
          type: "array",
          items: { type: "string", pattern: "^G(0|[1-9]|10)$" },
          maxItems: 11,
          uniqueItems: true,
        },
        section: { type: "string", pattern: "^SEC-\\d{2}(\\.\\d{2}){0,2}$" },
      },
      additionalProperties: false,
    },
    effect: "read",
    async execute(input, context) {
      try {
        const request: { gates?: string[]; section?: string } = {};
        if (Array.isArray(input.gates))
          request.gates = input.gates.filter((gate): gate is string => typeof gate === "string");
        if (typeof input.section === "string") request.section = input.section;
        return text(await coordinator.checkReadOnly(context.workspace, request));
      } catch (error) {
        return text(error instanceof Error ? error.message : "thesis_check failed", true);
      }
    },
  });
  api.tools.register({
    name: "thesis_build",
    description:
      "Build the thesis into a PDF (or report why it cannot). scope full builds everything, approved only approved sections, section needs a section id. Returns JSON with the output path, engine, duration, page count, warnings and errors.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["full", "approved", "section"] },
        section: { type: "string", pattern: "^SEC-\\d{2}(\\.\\d{2}){0,2}$" },
        format: { type: "string", enum: ["pdf", "html"] },
        pdfa: { type: "boolean" },
      },
      required: ["scope"],
      additionalProperties: false,
    },
    effect: "process",
    async execute(input, context) {
      try {
        const scope = input.scope;
        if (scope !== "full" && scope !== "approved" && scope !== "section") {
          return text("scope must be full, approved or section", true);
        }
        const outcome = await coordinator.buildRun(
          context.workspace,
          {
            scope,
            ...(typeof input.section === "string" ? { section: input.section } : {}),
            ...(typeof input.format === "string" ? { format: input.format } : {}),
            ...(input.pdfa === true ? { pdfa: true } : {}),
          },
          context.signal,
        );
        return text(
          {
            ok: outcome.ok,
            path: outcome.path ?? null,
            engine: outcome.engine,
            ms: outcome.ms,
            pages: outcome.pages ?? null,
            warnings: outcome.warnings,
            errors: outcome.findings.filter((finding) => finding.severity === "error"),
          },
          !outcome.ok,
        );
      } catch (error) {
        return text(error instanceof Error ? error.message : "thesis_build failed", true);
      }
    },
  });
  return coordinator;
}

const plugin = definePlugin({
  id: "thesis",
  name: "Thesis Studio",
  description:
    "Plans, researches, drafts and typesets university theses with verified evidence and deterministic quality gates.",
  categories: ["methodology-harness"],
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI) {
    registerThesis(api);
  },
});

export default plugin;
