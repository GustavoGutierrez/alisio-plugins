import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = [
  "scriptsForbid",
  "dependencyForbid",
  "requireDeclaredImports",
  // Owner extensions (B-11): inspect non-JSON workspace files such as tailwind.config.*.
  "fileContent",
  "minTailwindMajor",
  "jsonLiteralCountMax",
] as const;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 1-based line of the first occurrence of a quoted key in JSON text. */
export function lineOfKey(text: string, key: string): number {
  const index = text.indexOf(`"${key}"`);
  return index === -1 ? 1 : text.slice(0, index).split("\n").length;
}

/** Count top-level elements of the array that follows `key:` in JS or JSON text. */
export function arrayLiteralLength(
  text: string,
  key: string,
): { count: number; line: number } | undefined {
  const match = new RegExp(`["']?${key}["']?\\s*:\\s*\\[`).exec(text);
  if (!match) return undefined;
  let index = match.index + match[0].length;
  let depth = 1;
  let count = 0;
  let pending = false;
  while (index < text.length && depth > 0) {
    const char = text[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      pending = true;
      index += 1;
      while (index < text.length && text[index] !== char) index += text[index] === "\\" ? 2 : 1;
    } else if (char === "[" || char === "{" || char === "(") {
      depth += 1;
      pending = true;
    } else if (char === "]" || char === "}" || char === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (char === "," && depth === 1) {
      if (pending) count += 1;
      pending = false;
    } else if (!/\s/.test(char)) pending = true;
    index += 1;
  }
  if (pending) count += 1;
  return { count, line: text.slice(0, match.index).split("\n").length };
}

export const packageJson: Engine = {
  id: "package-json",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.regex("scriptsForbid");
    reader.regex("dependencyForbid");
    reader.bool("requireDeclaredImports");
    reader.regex("fileContent");
    reader.number("minTailwindMajor", 1);
    const literal = reader.object("jsonLiteralCountMax");
    if (literal) {
      const inner = new ParamReader(literal, ["key", "max"]);
      inner.string("key", true);
      inner.number("max", 0, true);
      for (const error of inner.errors) reader.errors.push(`jsonLiteralCountMax.${error}`);
    }
    const configured = [
      "scriptsForbid",
      "dependencyForbid",
      "requireDeclaredImports",
      "fileContent",
      "jsonLiteralCountMax",
    ].some((key) => params[key] !== undefined && params[key] !== false);
    if (!configured) reader.errors.push("no check configured");
    return reader.errors;
  },
  async run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const scriptsForbid = reader.regex("scriptsForbid");
    const dependencyForbid = reader.regex("dependencyForbid");
    const requireImports = reader.bool("requireDeclaredImports") === true;
    const fileContent = reader.regex("fileContent");
    const minTailwind = reader.number("minTailwindMajor", 1);
    const literal = reader.object("jsonLiteralCountMax") as
      | { key: string; max: number }
      | undefined;
    const findings: RawFinding[] = [];

    if (scriptsForbid || dependencyForbid) {
      for (const path of context.matchedPaths.filter(
        (p) => p === "package.json" || p.endsWith("/package.json"),
      )) {
        const text = await context.workspace.readText(path);
        if (text === undefined) continue;
        let manifest: unknown;
        try {
          manifest = JSON.parse(text);
        } catch {
          continue;
        }
        if (!isRecord(manifest)) continue;
        if (scriptsForbid && isRecord(manifest.scripts))
          for (const [name, command] of Object.entries(manifest.scripts))
            if (typeof command === "string" && scriptsForbid.test(command))
              findings.push({
                file: path,
                line: lineOfKey(text, name),
                column: 1,
                detail: `script "${name}": ${command}`,
              });
        if (dependencyForbid)
          for (const section of DEPENDENCY_SECTIONS) {
            const deps = manifest[section];
            if (isRecord(deps))
              for (const name of Object.keys(deps))
                if (dependencyForbid.test(name))
                  findings.push({
                    file: path,
                    line: lineOfKey(text, name),
                    column: 1,
                    detail: `dependency ${name}`,
                  });
          }
      }
    }

    if (requireImports) {
      for (const edge of context.graph.edges) {
        if (edge.resolution.kind !== "package" || edge.typeOnly) continue;
        if (!context.files.some((file) => file.path === edge.from)) continue;
        const name = edge.resolution.name;
        if (
          name.includes(":") ||
          name.startsWith("~") ||
          name.startsWith("$") ||
          name.startsWith("@/") ||
          name.startsWith("#")
        )
          continue;
        const found = context.workspace.manifestFor(edge.from);
        if (!found) continue;
        const manifest = found.manifest;
        if (manifest.name === name) continue;
        const declared = DEPENDENCY_SECTIONS.some(
          (section) =>
            isRecord(manifest[section]) && name in (manifest[section] as Record<string, unknown>),
        );
        const typesDeclared =
          isRecord(manifest.devDependencies) &&
          `@types/${name.replace(/^@/, "").replace("/", "__")}` in manifest.devDependencies;
        if (!declared && !typesDeclared)
          findings.push({
            file: edge.from,
            line: edge.line,
            column: edge.column,
            detail: `${name} is imported but not declared in ${found.path}`,
          });
      }
    }

    if (fileContent || literal) {
      if (minTailwind !== undefined && (context.stack.tailwindMajor ?? 0) < minTailwind)
        return { findings, skipped: `needs Tailwind major ${minTailwind}` };
      for (const path of context.matchedPaths) {
        const text = await context.workspace.readText(path);
        if (text === undefined) continue;
        if (fileContent) {
          const match = fileContent.exec(text);
          if (match)
            findings.push({
              file: path,
              line: text.slice(0, match.index).split("\n").length,
              column: 1,
              detail: `${path} matches ${fileContent.source}`,
            });
        }
        if (literal) {
          const found = arrayLiteralLength(text, literal.key);
          if (found && found.count > literal.max)
            findings.push({
              file: path,
              line: found.line,
              column: 1,
              detail: `${literal.key} has ${found.count} entries (max ${literal.max})`,
            });
        }
      }
    }
    return { findings };
  },
};
