import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { LoadedProject } from "../checks/project.js";
import { packagePath } from "../package-paths.js";
import { generateBibtex, type TypeLabels } from "../research/bibtex.js";
import { parseLibraryText } from "../research/library.js";
import { resolveCitationStyle, resolvePresentationProfile } from "../styles/discovery.js";
import { loadShippedProfile } from "../styles/profile.js";
import type { Brief, Finding, SectionState } from "../types.js";
import { diagramThemeFor } from "./diagram-theme.js";
import type {
  BuildScope,
  FigureAsset,
  I18nStrings,
  ResolvedMeta,
  Section,
  ThesisDocument,
} from "./model.js";
import { parseChapter } from "./parse.js";
import { allBlockLists, walkBlocks, walkInlines } from "./walk.js";

export const supportedLanguages = ["en", "es", "pt"] as const;

const stringCache = new Map<string, I18nStrings>();

/** Label strings shipped with the package for one language code. */
export function shippedStrings(code: string): I18nStrings | undefined {
  if (!(supportedLanguages as readonly string[]).includes(code)) return undefined;
  const cached = stringCache.get(code);
  if (cached) return cached;
  const parsed = parseYaml(
    readFileSync(packagePath("templates", "typst", "i18n", `${code}.yaml`), "utf8"),
  ) as Record<string, unknown>;
  const strings: I18nStrings = {};
  for (const [key, value] of Object.entries(parsed))
    if (typeof value === "string") strings[key] = value;
  stringCache.set(code, strings);
  return strings;
}

const hasControl = (value: string): boolean =>
  [...value].some((char) => (char.codePointAt(0) as number) < 0x20 || char === "\u007f");

/** Merge `thesis/i18n.yaml` over a base label set; unknown keys and bad values become findings. */
function overrideStrings(
  base: I18nStrings,
  text: string | undefined,
  findings: Finding[],
): I18nStrings {
  if (text === undefined) return base;
  const fail = (message: string) =>
    findings.push({ code: "LNG-002", gate: "G7", severity: "warning", file: "i18n.yaml", message });
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    fail("i18n.yaml is not valid YAML and was ignored");
    return base;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail("i18n.yaml must be a mapping of label keys to text and was ignored");
    return base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!(key in base)) fail(`i18n.yaml: unknown label key "${key}"`);
    else if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 200 ||
      hasControl(value)
    )
      fail(`i18n.yaml: "${key}" must be a text of 1 to 200 characters`);
    else merged[key] = value;
  }
  return merged;
}

/** Institution rules may fix the body font or line spacing; they win over the interview answers. */
function ruleValue(
  project: LoadedProject,
  kind: string,
  pick: (values: Record<string, unknown>) => unknown,
): unknown {
  const rules = (project.profile?.rules ?? []).filter((rule) => rule.kind === kind);
  for (const rule of [...rules].sort((a, b) => a.rank - b.rank)) {
    const value = pick(rule.values);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Genre labels printed by the citation styles, in the thesis language. */
export function typeLabels(strings: I18nStrings): TypeLabels {
  const pick = (key: string) => strings[`evidence_${key}`];
  const labels: TypeLabels = {};
  if (pick("law")) labels.law = pick("law") as string;
  if (pick("standard")) labels.standard = pick("standard") as string;
  if (pick("dataset")) labels.dataset = pick("dataset") as string;
  if (pick("thesis")) labels.thesis = pick("thesis") as string;
  if (pick("preprint")) labels.preprint = pick("preprint") as string;
  return labels;
}

export function resolveMeta(project: LoadedProject, brief: Brief): ResolvedMeta {
  const profile = project.profile;
  const [languageCode = "en", ...rest] = brief.language.split("-");
  const region = rest.find((part) => /^[A-Za-z]{2}$/.test(part));
  const family = ruleValue(project, "font", (values) =>
    typeof values.family === "string" ? values.family : undefined,
  );
  const spacing = ruleValue(project, "line_spacing", (values) => {
    const candidate = values.body ?? values.multiple;
    return typeof candidate === "number" ? candidate : undefined;
  });
  return {
    language: brief.language,
    languageCode: languageCode.toLowerCase(),
    ...(region ? { region: region.toLowerCase() } : {}),
    title: brief.title ?? "Untitled thesis",
    subtitle: brief.subtitle,
    authors: brief.authors.map((author) => author.name),
    advisors: brief.advisors,
    institution: brief.institution,
    year: brief.year,
    workType: brief.workType,
    secondaryAbstractLanguage: brief.secondaryAbstractLanguage,
    paper: brief.presentation.paper,
    fontProfile: brief.presentation.fontProfile,
    bodyFont: typeof family === "string" ? family : (brief.presentation.bodyFont ?? null),
    palette: brief.presentation.palette,
    diagramTheme: brief.presentation.diagramTheme,
    lineSpacing: typeof spacing === "number" ? spacing : (brief.presentation.lineSpacing ?? null),
    presentationStandard: profile?.presentationStandard.value ?? "generic",
    citationStyle: profile?.citationStyle.value ?? "apa-7",
    aiDeclarationRequired: profile?.aiDeclaration.required ?? false,
    ruleIds: profile?.presentationStandard.ruleIds ?? [],
  };
}

type Pieces = Pick<ThesisDocument, "frontMatter" | "body" | "annexes" | "footnotes">;
const document0 = (
  frontMatter: Section[],
  body: Section[],
  annexes: Section[],
  footnotes: ThesisDocument["footnotes"],
): Pieces => ({ frontMatter, body, annexes, footnotes });

/** In a partial build, references to labels that are not included become plain text. */
function degradeRefs(pieces: Pieces): number {
  const lists = allBlockLists(pieces as ThesisDocument);
  const labels = new Set<string>();
  for (const { blocks } of lists) {
    walkBlocks(blocks, (block) => {
      if ("label" in block && block.label) labels.add(block.label);
    });
  }
  let degraded = 0;
  for (const { blocks } of lists) {
    walkInlines(blocks, (inline) => {
      if (inline.kind === "crossref" && !labels.has(inline.label)) {
        const text = inline as unknown as { kind: string; text?: string; label?: string };
        text.text = `\u00ab${inline.label}\u00bb`;
        text.kind = "text";
        delete text.label;
        degraded += 1;
      }
    });
  }
  return degraded;
}

export interface AssembleOptions {
  scope?: BuildScope;
  /** Required for `section` scope: an outline id such as SEC-03 (matches its sub-sections too). */
  section?: string;
  /** Section states from state.json; `approved` scope needs them. */
  sections?: Record<string, SectionState>;
}

export interface Assembled {
  document: ThesisDocument;
  /** HYG-001 findings from the dialect plus label/language notes. */
  findings: Finding[];
}

const frontRoles = new Set<Section["role"]>([
  "abstract",
  "abstract-secondary",
  "dedication",
  "acknowledgments",
  "ai-declaration",
]);

const matchesSection = (declared: string | undefined, wanted: string): boolean =>
  declared !== undefined && (declared === wanted || declared.startsWith(`${wanted}.`));

/** Does a chapter file take part in a scope? Files that declare no section are always included. */
function inScope(section: Section, options: AssembleOptions): boolean {
  const scope = options.scope ?? "full";
  if (scope === "full") return true;
  if (scope === "section") {
    return section.role === "body" && matchesSection(section.section, options.section ?? "");
  }
  if (frontRoles.has(section.role) || section.section === undefined) return true;
  const states = options.sections ?? {};
  return Object.entries(states).some(
    ([id, state]) => state.status === "approved" && matchesSection(section.section, id),
  );
}

/**
 * Parse every chapter into the neutral document. Pure and synchronous so the deterministic checks
 * can run it; assets are resolved later by the build.
 */
export function assembleDocument(
  project: LoadedProject,
  options: AssembleOptions = {},
): Assembled | undefined {
  const brief = project.brief?.brief;
  if (!brief) return undefined;
  const findings: Finding[] = [];
  const meta = resolveMeta(project, brief);

  const frontMatter: Section[] = [];
  const body: Section[] = [];
  const annexes: Section[] = [];
  const footnotes: ThesisDocument["footnotes"] = {};
  for (const chapter of project.chapters) {
    const parsed = parseChapter(chapter.path, chapter.content);
    findings.push(...parsed.findings);
    if (!inScope(parsed.section, options)) continue;
    Object.assign(footnotes, parsed.footnotes);
    if (frontRoles.has(parsed.section.role)) frontMatter.push(parsed.section);
    else if (parsed.section.role === "annex") annexes.push(parsed.section);
    else body.push(parsed.section);
  }

  const figures = new Map<string, FigureAsset>();
  const collect = (sections: readonly Section[]) => {
    for (const section of sections) {
      walkBlocks(section.blocks, (block) => {
        if (block.kind === "figure" && block.label && !figures.has(block.label)) {
          figures.set(block.label, block.asset);
        }
      });
    }
  };
  collect(body);
  collect(annexes);

  if ((options.scope ?? "full") !== "full") {
    const count = degradeRefs(document0(frontMatter, body, annexes, footnotes));
    if (count > 0) {
      findings.push({
        code: "BLD-003",
        gate: "G8",
        severity: "warning",
        message: `${count} cross-reference(s) point outside this partial build and were left as plain text`,
      });
    }
  }

  const base = shippedStrings(meta.languageCode);
  if (!base) {
    findings.push({
      code: "LNG-002",
      gate: "G7",
      severity: "warning",
      file: "thesis.yaml",
      message: `No built-in labels for language "${meta.languageCode}"; English labels are used`,
      hint: "Supply thesis/i18n.yaml with translated labels (see templates/typst/i18n/en.yaml for the keys).",
    });
  }
  const english = shippedStrings("en") as I18nStrings;
  const strings: I18nStrings = { ...overrideStrings(base ?? english, project.i18nText, findings) };
  // Abstract labels for every other abstract language, as `abstract@en` and `keywords@en`.
  const abstractLanguages = new Set<string>();
  if (meta.secondaryAbstractLanguage) abstractLanguages.add(meta.secondaryAbstractLanguage);
  for (const section of frontMatter) if (section.lang) abstractLanguages.add(section.lang);
  for (const language of abstractLanguages) {
    const code = language.split("-")[0]?.toLowerCase() ?? "en";
    const localized = shippedStrings(code) ?? english;
    strings[`abstract@${language}`] = localized.abstract as string;
    strings[`keywords@${language}`] = localized.keywords as string;
  }

  const library = parseLibraryText(project.libraryText).records.filter(
    (record) => record.status !== "REJECTED",
  );

  // Presentation profile and citation style: shipped or workspace; problems block the build.
  const resolvedProfile = resolvePresentationProfile(
    meta.presentationStandard,
    project.profileFiles,
  );
  for (const issue of resolvedProfile.issues) {
    findings.push({
      code: "PRF-001",
      gate: "G0",
      severity: "error",
      file: `styles/${meta.presentationStandard}.profile.yaml`,
      message: `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
    });
  }
  let presentation = resolvedProfile.profile;
  if (!presentation) {
    if (resolvedProfile.issues.length === 0) {
      findings.push({
        code: "BLD-004",
        gate: "G8",
        severity: "warning",
        message: `Presentation profile "${meta.presentationStandard}" is not available; the generic layout is used`,
      });
    }
    presentation = loadShippedProfile("generic") as NonNullable<typeof presentation>;
  }
  if (presentation.paper) meta.paper = presentation.paper;
  if (
    meta.presentationStandard === "icontec-ntc1486-2022" &&
    (meta.bodyFont === null || meta.lineSpacing === null)
  ) {
    findings.push({
      code: "BLD-004",
      gate: "G8",
      severity: "warning",
      message:
        "ICONTEC: body font and line spacing are disputed between the 2022 guides and were not chosen yet; provisional defaults are used",
      hint: "Answer them with /thesis:init --presentation or set presentation.bodyFont and presentation.lineSpacing.",
    });
  }
  const resolvedStyle = resolveCitationStyle(meta.citationStyle, project.styleFiles);
  for (const issue of resolvedStyle.issues) {
    findings.push({
      code: issue.code,
      gate: "G0",
      severity: "error",
      file: `styles/${meta.citationStyle}.csl`,
      message: issue.message,
      ...(issue.hint ? { hint: issue.hint } : {}),
    });
  }
  const style =
    resolvedStyle.style ??
    (resolveCitationStyle("apa-7", []).style as NonNullable<typeof resolvedStyle.style>);

  const document: ThesisDocument = {
    meta,
    presentation,
    diagramTheme: diagramThemeFor(meta),
    frontMatter,
    body,
    annexes,
    footnotes,
    figures,
    bibliography: {
      entries: library,
      styleId: meta.citationStyle,
      csl: style,
      bibtex: generateBibtex(library, typeLabels(strings)),
    },
    strings,
  };
  return { document, findings };
}
