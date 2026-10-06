import { compileGlob } from "../../domain/glob.js";
import { scansOf } from "./css-util.js";
import { ParamReader } from "./params.js";
import type { BudgetAsset, Engine, EngineContext, RawFinding } from "./types.js";

const KINDS = ["initialJs", "initialCss", "delta", "image", "inlineData", "fontDisplay"] as const;
type Kind = (typeof KINDS)[number];
const KIB = 1024;

const sumGzip = (
  assets: readonly BudgetAsset[],
  globs: readonly string[],
): { bytes: number; files: string[] } => {
  const tests = globs.map((glob) => compileGlob(glob));
  const matched = assets.filter((asset) => tests.some((test) => test(asset.path)));
  return {
    bytes: matched.reduce((total, asset) => total + asset.gzipBytes, 0),
    files: matched.map((asset) => asset.path),
  };
};

const kib = (bytes: number): string => `${(bytes / KIB).toFixed(1)} KiB`;

export const budget: Engine = {
  id: "budget",
  validateParams(params) {
    const reader = new ParamReader(params, ["kind"]);
    reader.oneOf("kind", KINDS, true);
    return reader.errors;
  },
  run(context) {
    const kind = new ParamReader(context.params, ["kind"]).oneOf("kind", KINDS, true) as Kind;
    const findings: RawFinding[] = [];
    if (kind === "inlineData") {
      const limit = context.budget?.config.inlineData.maxBytes ?? 4096;
      return { findings: inlineDataFindings(context, limit) };
    }
    if (kind === "fontDisplay") {
      for (const analysis of context.files)
        for (const scan of scansOf(analysis))
          for (const atRule of scan.atRules)
            if (
              atRule.name === "font-face" &&
              !atRule.declarations.some((d) => d.property === "font-display")
            )
              findings.push({
                file: analysis.path,
                line: atRule.line,
                column: atRule.column,
                detail: "@font-face without font-display",
              });
      return { findings };
    }
    const input = context.budget;
    if (!input) return { findings, skipped: "no .frontsmith/budgets.json or build output" };
    const { config, assets } = input;
    if (kind === "initialJs" || kind === "initialCss") {
      const limitKb =
        kind === "initialJs" ? config.bundle.maxInitialJsGzipKb : config.bundle.maxInitialCssGzipKb;
      if (limitKb === null) return { findings, skipped: `no absolute limit set for ${kind}` };
      const { bytes, files } = sumGzip(
        assets,
        kind === "initialJs" ? config.bundle.entryGlobs : config.bundle.cssGlobs,
      );
      if (files.length === 0)
        return { findings, skipped: `no build output matches the ${kind} globs` };
      if (bytes > limitKb * KIB)
        findings.push({
          file: files[0] as string,
          line: 1,
          column: 1,
          detail: `${kib(bytes)} gzip exceeds ${limitKb} KiB`,
        });
    } else if (kind === "delta") {
      const limitKb = config.bundle.maxDeltaGzipKb;
      if (limitKb === null) return { findings, skipped: "no maxDeltaGzipKb set" };
      if (!input.baseline) return { findings, skipped: "no budgets.baseline.json recorded" };
      const js = sumGzip(assets, config.bundle.entryGlobs);
      const css = sumGzip(assets, config.bundle.cssGlobs);
      const growth =
        js.bytes +
        css.bytes -
        ((input.baseline.initialJsGzipBytes ?? 0) + (input.baseline.initialCssGzipBytes ?? 0));
      if (growth > limitKb * KIB)
        findings.push({
          file: js.files[0] ?? css.files[0] ?? "budgets.baseline.json",
          line: 1,
          column: 1,
          detail: `grew by ${kib(growth)} gzip (limit ${limitKb} KiB)`,
        });
    } else if (kind === "image") {
      const tests = config.images.globs.map((glob) => compileGlob(glob));
      for (const asset of assets.filter((a) => tests.some((test) => test(a.path)))) {
        if (asset.bytes > config.images.maxBytes)
          findings.push({
            file: asset.path,
            line: 1,
            column: 1,
            detail: `${kib(asset.bytes)} exceeds ${kib(config.images.maxBytes)}`,
          });
        if (asset.width !== undefined && asset.width > config.images.maxWidthPx)
          findings.push({
            file: asset.path,
            line: 1,
            column: 1,
            detail: `${asset.width}px wide exceeds ${config.images.maxWidthPx}px`,
          });
      }
    }
    return { findings };
  },
};

/** `data:` URIs longer than the limit in CSS values, script string literals and template attributes. */
function inlineDataFindings(context: EngineContext, limit: number): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const analysis of context.files) {
    for (const scan of scansOf(analysis))
      for (const declaration of scan.declarations)
        for (const match of declaration.value.matchAll(/data:[^)"'\s]+/g))
          if (match[0].length > limit)
            findings.push({
              file: analysis.path,
              line: declaration.line,
              column: declaration.column,
              detail: `inline data URI of ${match[0].length} bytes (max ${limit})`,
            });
    for (const piece of analysis.scripts)
      for (const uri of piece.view.dataUris)
        if (uri.length > limit)
          findings.push({
            file: analysis.path,
            line: uri.loc.line,
            column: uri.loc.column,
            detail: `inline data URI of ${uri.length} bytes (max ${limit})`,
          });
    for (const piece of analysis.templates)
      for (const element of piece.scan.elements)
        for (const attr of element.attrs)
          if (attr.value?.startsWith("data:") && attr.value.length > limit)
            findings.push({
              file: analysis.path,
              line: attr.line,
              column: attr.column,
              detail: `inline data URI of ${attr.value.length} bytes (max ${limit})`,
            });
  }
  return findings;
}
