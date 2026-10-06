import { compileGlob } from "../../domain/glob.js";
import type { CssDeclaration } from "../ports/css-scanner.js";
import type { FileAnalysis } from "../ports/file-analyzer.js";
import { ParamReader } from "./params.js";
import type { Engine, EngineContext, RawFinding } from "./types.js";

const PARAMS = ["naming", "forbidNames", "themeParity", "unused", "undefinedRefs"] as const;
const THEME_SELECTOR = /\[data-theme\s*=\s*["']?([\w-]+)["']?\]/;

interface Definition {
  declaration: CssDeclaration;
  file: string;
}

const customDeclarations = (analysis: FileAnalysis): CssDeclaration[] =>
  analysis.styles.flatMap((piece) => piece.scan.customProperties);

function tokenFiles(context: EngineContext): FileAnalysis[] {
  const tests = context.config.paths.tokenFiles.map((glob) => compileGlob(glob));
  return context.files.filter((file) => tests.some((test) => test(file.path)));
}

function referencedNames(context: EngineContext): Set<string> {
  const names = new Set<string>();
  for (const analysis of context.all.values()) {
    for (const piece of analysis.styles) for (const ref of piece.scan.varRefs) names.add(ref.name);
    for (const piece of analysis.scripts)
      for (const name of piece.view.customPropertyStrings) names.add(name);
    for (const piece of analysis.templates)
      for (const element of piece.scan.elements)
        for (const attr of element.attrs)
          for (const match of (attr.value ?? "").matchAll(/var\(\s*(--[\w-]+)/g))
            names.add(match[1] as string);
  }
  return names;
}

function definedNames(context: EngineContext): Set<string> {
  const names = new Set<string>();
  for (const analysis of context.all.values()) {
    for (const piece of analysis.styles) {
      for (const property of piece.scan.customProperties) names.add(property.name);
      for (const atRule of piece.scan.atRules)
        if (atRule.name === "property" && atRule.prelude.startsWith("--"))
          names.add(atRule.prelude);
    }
    for (const piece of analysis.scripts)
      for (const name of piece.view.customPropertyStrings) names.add(name);
  }
  return names;
}

export const tokenFile: Engine = {
  id: "token-file",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.regex("naming");
    reader.regex("forbidNames");
    reader.bool("themeParity");
    reader.bool("unused");
    reader.bool("undefinedRefs");
    const configured = PARAMS.some((key) => params[key] !== undefined && params[key] !== false);
    if (!configured) reader.errors.push("no check configured");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const naming = reader.regex("naming");
    const forbid = reader.regex("forbidNames");
    const parity = reader.bool("themeParity") === true;
    const unused = reader.bool("unused") === true;
    const undefinedRefs = reader.bool("undefinedRefs") === true;
    const findings: RawFinding[] = [];
    const tokens = tokenFiles(context);

    for (const analysis of tokens)
      for (const declaration of customDeclarations(analysis)) {
        const at = { file: analysis.path, line: declaration.line, column: declaration.column };
        if (naming && !naming.test(declaration.property))
          findings.push({ ...at, detail: `${declaration.property} is not kebab-case` });
        if (forbid?.test(declaration.property))
          findings.push({ ...at, detail: `${declaration.property} names a colour or position` });
      }

    if (parity) {
      const themes = new Map<
        string,
        { names: Set<string>; file: string; line: number; column: number }
      >();
      for (const analysis of tokens)
        for (const piece of analysis.styles)
          for (const rule of piece.scan.rules) {
            const theme = rule.selectors.map((s) => THEME_SELECTOR.exec(s)?.[1]).find(Boolean);
            if (!theme) continue;
            const entry = themes.get(theme) ?? {
              names: new Set<string>(),
              file: analysis.path,
              line: rule.line,
              column: rule.column,
            };
            for (const declaration of rule.declarations)
              if (declaration.isCustomProperty) entry.names.add(declaration.property);
            themes.set(theme, entry);
          }
      if (themes.size >= 2) {
        const union = new Set([...themes.values()].flatMap((entry) => [...entry.names]));
        for (const [theme, entry] of themes)
          for (const name of [...union].sort())
            if (!entry.names.has(name))
              findings.push({
                file: entry.file,
                line: entry.line,
                column: entry.column,
                detail: `${name} is missing in theme "${theme}"`,
              });
      }
    }

    if (unused) {
      const used = referencedNames(context);
      const seen = new Set<string>();
      for (const analysis of tokens)
        for (const declaration of customDeclarations(analysis)) {
          if (
            declaration.atRules.some((a) => a.name === "theme") ||
            declaration.property.startsWith("--tw-")
          )
            continue;
          if (used.has(declaration.property) || seen.has(declaration.property)) continue;
          seen.add(declaration.property);
          findings.push({
            file: analysis.path,
            line: declaration.line,
            column: declaration.column,
            detail: `${declaration.property} is never used`,
          });
        }
    }

    if (undefinedRefs) {
      const defined = definedNames(context);
      for (const analysis of context.files)
        for (const piece of analysis.styles)
          for (const ref of piece.scan.varRefs)
            if (!ref.hasFallback && !defined.has(ref.name) && !ref.name.startsWith("--tw-"))
              findings.push({
                file: analysis.path,
                line: ref.line,
                column: ref.column,
                detail: `var(${ref.name}) has no definition`,
              });
    }
    return { findings };
  },
};

export type { Definition };
