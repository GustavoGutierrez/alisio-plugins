import type { TestCaseResult, UiBlock } from "@alisio/sdk";
import type { GeneratePlan, TokensCheckOutcome } from "../../application/tokens/service.js";
import type { PairRow } from "../../application/tokens/token-sets.js";
import type { ContrastResult } from "../../domain/color/contrast.js";
import type { PaletteResult } from "../../domain/color/palette.js";
import { capOutput, code, table } from "./markdown.js";

export const ratioText = (ratio: number | null): string =>
  ratio === null ? "-" : ratio.toFixed(6);
const minimumText = (minimum: number): string => String(Number(minimum.toFixed(4)));

export const contrastTable = (results: readonly ContrastResult[]): UiBlock => ({
  kind: "table",
  columns: ["fg", "bg", "composited fg", "ratio", "minimum", "status"],
  rows: results.map((r) => [
    r.fg,
    r.bg,
    r.compositedFg ?? "-",
    ratioText(r.ratio),
    minimumText(r.minimum),
    r.status,
  ]),
});

export function contrastSummary(results: readonly ContrastResult[]): string {
  const count = (status: string): number => results.filter((r) => r.status === status).length;
  return [
    `${results.length} pairs: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("REVIEW")} REVIEW`,
    ...results.map(
      (r) =>
        `${r.fg} on ${r.bg}: ${r.status}${r.ratio === null ? "" : ` ${ratioText(r.ratio)} (minimum ${minimumText(r.minimum)})`}${r.reason ? ` - ${r.reason}` : ""}`,
    ),
  ].join("\n");
}

export const pairTable = (rows: readonly PairRow[]): UiBlock => ({
  kind: "table",
  columns: ["source", "theme", "fg", "bg", "kind", "ratio", "minimum", "status"],
  rows: rows.map((r) => [
    r.source,
    r.theme,
    r.fg,
    r.bg,
    r.kind,
    ratioText(r.ratio),
    minimumText(r.minimum),
    r.status,
  ]),
});

export function pairCases(rows: readonly PairRow[]): TestCaseResult[] {
  return rows.map((r) => ({
    name: `${r.fg} on ${r.bg} (${r.theme})`,
    status: r.status === "PASS" ? "passed" : r.status === "FAIL" ? "failed" : "todo",
    ...(r.status === "PASS"
      ? {}
      : { error: `${ratioText(r.ratio)} below ${minimumText(r.minimum)}` }),
  }));
}

export function sourcesLine(outcome: Extract<TokensCheckOutcome, { blocked: false }>): string {
  const { sources } = outcome;
  if (sources.length === 0)
    return "No tokens found: no tokens.json under the artifacts directory and no colour custom properties in the token files.";
  const json = sources.filter((s) => s.kind === "tokens-json");
  if (json.length > 0)
    return `Sources: ${json.length} tokens.json files (${json.map((s) => `${s.path}: ${s.tokens} tokens, ${s.pairs} pairs`).join("; ")})`;
  const css = sources[0];
  return `Sources: css token files (${css?.path}: ${css?.tokens} tokens, ${css?.pairs} pairs)`;
}

export function tokensSummary(outcome: Extract<TokensCheckOutcome, { blocked: false }>): string {
  const open = outcome.result.findings.filter((f) => f.status === "FAIL" || f.status === "REVIEW");
  const lines = [
    `Verdict: ${outcome.verdict}`,
    sourcesLine(outcome),
    `${open.length} open findings, ${outcome.rows.filter((r) => r.status === "PASS").length}/${outcome.rows.length} pairs pass`,
    ...open
      .slice(0, 40)
      .map((f) => `${f.id} ${f.ruleId} ${f.severity} ${f.status} ${f.file}:${f.line} ${f.message}`),
  ];
  if (open.length > 40) lines.push(`... ${open.length - 40} more`);
  if (outcome.notEvaluated.length > 0)
    lines.push(
      `Not evaluated (${outcome.notEvaluated.length}, never counted as evidence): ${outcome.notEvaluated.slice(0, 10).join("; ")}${outcome.notEvaluated.length > 10 ? "; ..." : ""}`,
    );
  return lines.join("\n");
}

export function tokensMarkdown(outcome: TokensCheckOutcome): string {
  if (outcome.blocked)
    return ["## Tokens check: BLOCKED", "", ...outcome.problems.map((p) => `- ${p}`)].join("\n");
  const open = outcome.result.findings.filter((f) => f.status === "FAIL" || f.status === "REVIEW");
  const lines = [`## Tokens check: ${outcome.verdict}`, "", sourcesLine(outcome)];
  if (open.length > 0)
    lines.push(
      "",
      table(
        ["id", "rule", "severity", "status", "location", "message"],
        open.map((f) => [
          f.id ?? "",
          f.ruleId,
          f.severity,
          f.status,
          `${f.file}:${f.line}`,
          f.message,
        ]),
      ),
    );
  if (outcome.rows.length > 0)
    lines.push(
      "",
      table(
        ["theme", "fg", "bg", "ratio", "minimum", "status"],
        outcome.rows.map((r) => [
          r.theme,
          r.fg,
          r.bg,
          ratioText(r.ratio),
          minimumText(r.minimum),
          r.status,
        ]),
      ),
    );
  if (outcome.notEvaluated.length > 0)
    lines.push(
      "",
      `Not evaluated (${outcome.notEvaluated.length}), never counted as evidence:`,
      ...outcome.notEvaluated.slice(0, 20).map((entry) => `- ${entry}`),
    );
  return capOutput(lines.join("\n"), "Run `alisio-frontsmith tokens --json` for the full report.");
}

type SolvedPalette = Extract<PaletteResult, { ok: true }>;

export function paletteTable(result: SolvedPalette): UiBlock {
  const first = result.themes[0];
  const roles = Object.keys(first?.tokens ?? {});
  return {
    kind: "table",
    columns: ["role", ...result.themes.map((t) => t.theme)],
    rows: roles.map((role) => [role, ...result.themes.map((t) => t.tokens[role] as string)]),
  };
}

export function paletteSummary(result: SolvedPalette): string {
  const pairs = result.themes.flatMap((t) => t.pairs);
  return [
    `Palette ${result.family} (profile ${result.profile}, catalog ${result.catalogVersion})`,
    ...result.themes.map(
      (t) =>
        `${t.theme}: ${Object.entries(t.tokens)
          .map(([role, value]) => `${role} ${value}`)
          .join(", ")}`,
    ),
    `${pairs.filter((p) => p.pass).length}/${pairs.length} required pairs pass`,
    `inputsSha256: ${result.inputsSha256}`,
    `outputSha256: ${result.outputSha256}`,
  ].join("\n");
}

export function palettePreviewMarkdown(plan: GeneratePlan, command: string): string {
  const { palette } = plan;
  const pairs = palette.themes.flatMap((t) => t.pairs);
  const lines = [
    `## Palette ${palette.family}: ${pairs.filter((p) => p.pass).length}/${pairs.length} pairs pass`,
    "",
    table(
      ["role", ...palette.themes.map((t) => t.theme)],
      Object.keys(palette.themes[0]?.tokens ?? {}).map((role) => [
        role,
        ...palette.themes.map((t) => t.tokens[role] as string),
      ]),
    ),
    "",
    `Files: ${code(plan.tokensPath)} and ${code(plan.themeCssPath)}${plan.existing.length > 0 ? ` (existing: ${plan.existing.map(code).join(", ")} would be replaced)` : ""}.`,
    `Hashes: inputs ${palette.inputsSha256.slice(0, 12)}, tokens ${palette.outputSha256.slice(0, 12)}.`,
    "",
    `Nothing was written. To write these files run ${code(command)}.`,
  ];
  return lines.join("\n");
}
