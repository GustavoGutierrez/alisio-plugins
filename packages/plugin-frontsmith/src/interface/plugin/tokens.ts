import type { CommandContext, PluginAPI, ToolDefinition } from "@alisio/sdk";
import type { TokensService } from "../../application/tokens/service.js";
import {
  type ContrastInput,
  type ContrastKind,
  evaluateContrast,
} from "../../domain/color/contrast.js";
import type { Theme } from "../../domain/color/pairs.js";
import { isHex6 } from "../../domain/color/parse.js";
import { askQuestions } from "../presenters/interaction.js";
import { code } from "../presenters/markdown.js";
import {
  contrastSummary,
  contrastTable,
  pairCases,
  pairTable,
  palettePreviewMarkdown,
  paletteSummary,
  paletteTable,
  tokensMarkdown,
  tokensSummary,
} from "../presenters/tokens.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { workspaceOf } from "./commands.js";
import { testResultsBlock } from "./rules-tools.js";
import { checkInput } from "./tools.js";

const KINDS: readonly string[] = ["normal_text", "large_text", "non_text"];
const THEMES: readonly string[] = ["light", "dark"];
const MAX_PAIRS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate the `fs_contrast` input; returns pairs or a message. */
export function parseContrastPairs(input: Record<string, unknown>): ContrastInput[] | string {
  const problem = checkInput(input, ["pairs"]);
  if (problem) return problem;
  const pairs = input.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > MAX_PAIRS)
    return `pairs must be an array of 1 to ${MAX_PAIRS} entries`;
  const out: ContrastInput[] = [];
  for (const [index, pair] of pairs.entries()) {
    if (!isRecord(pair)) return `pairs/${index} must be an object`;
    const extra = Object.keys(pair).filter(
      (k) => !["fg", "bg", "kind", "backgroundStack"].includes(k),
    );
    if (extra.length > 0) return `pairs/${index}: unknown input ${extra.join(", ")}`;
    if (typeof pair.fg !== "string" || typeof pair.bg !== "string")
      return `pairs/${index}: fg and bg must be colour strings`;
    if (typeof pair.kind !== "string" || !KINDS.includes(pair.kind))
      return `pairs/${index}: kind must be ${KINDS.join(", ")}`;
    let stack: string[] | undefined;
    if (pair.backgroundStack !== undefined) {
      if (
        !Array.isArray(pair.backgroundStack) ||
        pair.backgroundStack.length > 20 ||
        !pair.backgroundStack.every((c) => typeof c === "string")
      )
        return `pairs/${index}: backgroundStack must be an array of at most 20 colour strings`;
      stack = pair.backgroundStack as string[];
    }
    out.push({
      fg: pair.fg,
      bg: pair.bg,
      kind: pair.kind as ContrastKind,
      ...(stack ? { backgroundStack: stack } : {}),
    });
  }
  return out;
}

export interface PaletteInput {
  family: string;
  themes: Theme[];
  locked?: Record<string, string>;
  catalog?: string;
}

export function parsePaletteInput(input: Record<string, unknown>): PaletteInput | string {
  const problem = checkInput(input, ["family", "themes", "locked", "catalog"]);
  if (problem) return problem;
  if (typeof input.family !== "string" || input.family === "") return "family is required";
  if (
    !Array.isArray(input.themes) ||
    input.themes.length === 0 ||
    !input.themes.every((t) => typeof t === "string" && THEMES.includes(t))
  )
    return "themes must be a non-empty list of light and dark";
  let locked: Record<string, string> | undefined;
  if (input.locked !== undefined) {
    if (
      !isRecord(input.locked) ||
      !Object.values(input.locked).every((v) => typeof v === "string" && isHex6(v))
    )
      return "locked must map role ids to #RRGGBB colours";
    locked = input.locked as Record<string, string>;
  }
  if (input.catalog !== undefined && typeof input.catalog !== "string")
    return "catalog must be a catalog version string";
  return {
    family: input.family,
    themes: input.themes as Theme[],
    ...(locked ? { locked } : {}),
    ...(typeof input.catalog === "string" ? { catalog: input.catalog } : {}),
  };
}

export function tokensTools(service: TokensService): ToolDefinition[] {
  return [
    {
      name: "fs_contrast",
      description:
        "Compute WCAG 2.2 contrast for colour pairs (hex or rgb, optionally translucent over a background stack). Ratios are unrounded and shown to six decimals.",
      inputSchema: {
        type: "object",
        properties: {
          pairs: {
            type: "array",
            maxItems: MAX_PAIRS,
            items: {
              type: "object",
              properties: {
                fg: { type: "string" },
                bg: { type: "string" },
                kind: { type: "string", enum: [...KINDS] },
                backgroundStack: { type: "array", items: { type: "string" }, maxItems: 20 },
              },
              required: ["fg", "bg", "kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["pairs"],
        additionalProperties: false,
      },
      effect: "read",
      async execute(input) {
        const pairs = parseContrastPairs(input);
        if (typeof pairs === "string") return errorResult(pairs);
        const results = pairs.map((pair) => evaluateContrast(pair));
        return toolResult({ summary: contrastSummary(results), primary: contrastTable(results) });
      },
    },
    {
      name: "fs_palette_generate",
      description:
        "Generate a deterministic palette from the curated catalog, or answer UNSAT naming the unsatisfiable constraint. The model never picks colour values.",
      inputSchema: {
        type: "object",
        properties: {
          family: { type: "string" },
          themes: { type: "array", items: { type: "string", enum: [...THEMES] }, minItems: 1 },
          locked: { type: "object", additionalProperties: { type: "string" } },
          catalog: { type: "string" },
        },
        required: ["family", "themes"],
        additionalProperties: false,
      },
      effect: "read",
      async execute(input) {
        try {
          const parsed = parsePaletteInput(input);
          if (typeof parsed === "string") return errorResult(parsed);
          const result = await service.palette(
            {
              family: parsed.family,
              themes: parsed.themes,
              ...(parsed.locked ? { locked: parsed.locked } : {}),
            },
            parsed.catalog,
          );
          if (!result.ok)
            return result.kind === "unsat"
              ? toolResult({ summary: result.reason })
              : errorResult(result.reason);
          return toolResult({
            summary: paletteSummary(result),
            primary: paletteTable(result),
            secondary: [
              {
                kind: "json",
                value: Object.fromEntries(result.themes.map((t) => [t.theme, t.tokens])),
              },
            ],
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "fs_tokens_check",
      description:
        "Check design tokens: token naming, themes and unused or undefined references, plus the contrast of every required pair in every theme.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      async execute(input, context) {
        try {
          const problem = checkInput(input, []);
          if (problem) return errorResult(problem);
          const outcome = await service.check(context.workspace);
          if (outcome.blocked)
            return errorResult(
              `BLOCKED: tokens could not be checked.\n${outcome.problems.map((p) => `- ${p}`).join("\n")}`,
            );
          const rules = testResultsBlock(outcome.result);
          const suites = rules.kind === "test-results" ? rules.suites : [];
          return toolResult({
            summary: tokensSummary(outcome),
            primary: {
              kind: "test-results",
              framework: "frontsmith",
              suites: [
                ...suites,
                ...(outcome.rows.length > 0
                  ? [{ name: "contrast", cases: pairCases(outcome.rows) }]
                  : []),
              ],
            },
            secondary: [pairTable(outcome.rows)],
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

const USAGE = [
  "Usage:",
  `- ${code("/frontsmith:tokens check")} checks token files, naming, themes and contrast`,
  `- ${code("/frontsmith:tokens generate --family <id> [--themes light,dark] [--confirm WRITE]")} solves a palette and writes tokens.json and the theme CSS`,
].join("\n");

// TODO(owner): Appendix A says `generate` writes "after confirmation" without a headless form;
// `--confirm WRITE` mirrors the `--confirm CALIBRATE` of `fidelity calibrate`.
function parseGenerateArgs(
  words: string[],
): { family: string; themes: Theme[]; confirm: boolean } | undefined {
  let family: string | undefined;
  let themes: Theme[] = ["light", "dark"];
  let confirm = false;
  for (let i = 0; i < words.length; i += 2) {
    const flag = words[i];
    const value = words[i + 1];
    if (value === undefined) return undefined;
    if (flag === "--family") family = value;
    else if (flag === "--themes") {
      const list = value.split(",").filter(Boolean);
      if (list.length === 0 || !list.every((t) => THEMES.includes(t))) return undefined;
      themes = list as Theme[];
    } else if (flag === "--confirm") {
      if (value !== "WRITE") return undefined;
      confirm = true;
    } else return undefined;
  }
  return family ? { family, themes, confirm } : undefined;
}

export async function tokensCommand(
  api: PluginAPI,
  service: TokensService,
  context: CommandContext | undefined,
  args: string,
): Promise<string> {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const workspace = workspaceOf(api, context);
  if (sub === "check")
    return rest.length === 0 ? tokensMarkdown(await service.check(workspace)) : USAGE;
  if (sub !== "generate") return USAGE;
  const parsed = parseGenerateArgs(rest);
  if (!parsed) return USAGE;
  const request = { family: parsed.family, themes: parsed.themes };
  const preview = await service.generate(workspace, request, { write: false });
  if (preview.state === "invalid") return preview.reason;
  if (preview.state === "unsat") return preview.reason;
  const themesArg = parsed.themes.length === 2 ? "" : ` --themes ${parsed.themes.join(",")}`;
  const command = `/frontsmith:tokens generate --family ${parsed.family}${themesArg} --confirm WRITE`;
  let write = parsed.confirm;
  if (!write) {
    const answers = await askQuestions(api, {
      scope: "tokens",
      session: context?.sessionId ?? "",
      questions: [
        {
          id: "confirm",
          header: "Write tokens",
          question: `Write ${preview.plan.tokensPath} and ${preview.plan.themeCssPath} for the ${parsed.family} palette?${preview.plan.existing.length > 0 ? ` Existing files would be replaced: ${preview.plan.existing.join(", ")}.` : ""}`,
          options: [
            { value: "write", label: "Write the files", recommended: true },
            { value: "cancel", label: "Cancel", description: "Leave the workspace unchanged" },
          ],
        },
      ],
    });
    if (answers?.confirm === "write") write = true;
    else if (answers?.confirm === "cancel") return "Nothing was written.";
  }
  if (!write) return palettePreviewMarkdown(preview.plan, command);
  const written = await service.generate(workspace, request, { write: true });
  if (written.state !== "written")
    return "reason" in written ? written.reason : "Nothing was written.";
  const { plan } = written;
  return `Wrote ${code(plan.tokensPath)} and ${code(plan.themeCssPath)} for the ${parsed.family} palette (${plan.palette.themes.flatMap((t) => t.pairs).length} required pairs pass${plan.existing.length > 0 ? `; replaced ${plan.existing.length} existing file${plan.existing.length === 1 ? "" : "s"}` : ""}). Review and commit them; run ${code("/frontsmith:tokens check")} next.`;
}

export function registerTokens(api: PluginAPI, service: TokensService): void {
  for (const tool of tokensTools(service)) api.tools.register(tool);
  api.commands.register("tokens", (args, context) => tokensCommand(api, service, context, args), {
    description: "Check design tokens and generate a palette",
    argumentHint: "check | generate --family <id>",
  });
}
