import { isMap, LineCounter, parseDocument, stringify } from "yaml";
import {
  approaches,
  type Brief,
  paletteNames,
  shippedCitationStyles,
  shippedPresentationStandards,
  studyDesigns,
  workTypes,
} from "./types.js";

export interface BriefIssue {
  code: "BRF-001" | "BRF-002" | "BRF-003" | "BRF-004" | "BRF-005" | "BRF-006";
  severity: "error" | "warning";
  /** Dotted path into thesis.yaml, for example `presentation.paper`. */
  path: string;
  message: string;
  line?: number;
}

export interface LoadBriefOptions {
  /** Ids of workspace citation styles discovered in `styles/*.csl`. */
  citationStyles?: readonly string[];
  /** Ids of workspace presentation profiles discovered in `styles/*.profile.yaml`. */
  presentationStandards?: readonly string[];
}

export interface LoadBriefResult {
  /** Present only when the brief has no errors. */
  brief?: Brief;
  raw?: Record<string, unknown>;
  issues: BriefIssue[];
}

const languagePattern =
  /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-(?:[A-Za-z]{2}|\d{3}))?(-(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3}))*$/;

/** BCP-47 well-formedness: a structural pattern plus the platform canonicalizer. */
export function isValidLanguageTag(tag: string): boolean {
  if (!languagePattern.test(tag)) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

export function paletteCatalog(): string[] {
  return [...paletteNames];
}

const stylePattern = /^[a-z0-9][a-z0-9-]{0,60}$/;
const domainPattern = /^[a-z][a-z0-9_]{1,40}$/;
const countryPattern = /^[A-Z]{2}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is rejected
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const topKeys = [
  "schemaVersion",
  "language",
  "secondaryAbstractLanguage",
  "searchLanguages",
  "workType",
  "title",
  "subtitle",
  "authors",
  "advisors",
  "institution",
  "year",
  "domain",
  "approach",
  "studyDesign",
  "citationStyle",
  "presentation",
  "targets",
  "aiUse",
  "policy",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function primaryLanguage(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? tag;
}

type PartialBrief = {
  language: string;
  workType: Brief["workType"];
  year: number;
  institution: { country: string } & Partial<Brief["institution"]>;
} & Partial<Omit<Brief, "language" | "workType" | "year" | "institution">>;

/** Fill every optional field with its documented default. */
export function applyBriefDefaults(input: PartialBrief): Brief {
  const primary = primaryLanguage(input.language);
  const searchLanguages = input.searchLanguages ?? [...new Set([primary, "en"])];
  return {
    schemaVersion: 1,
    language: input.language,
    secondaryAbstractLanguage: input.secondaryAbstractLanguage ?? null,
    searchLanguages,
    workType: input.workType,
    title: input.title ?? null,
    subtitle: input.subtitle ?? null,
    authors: input.authors ?? [],
    advisors: input.advisors ?? [],
    institution: {
      name: input.institution.name ?? null,
      faculty: input.institution.faculty ?? null,
      program: input.institution.program ?? null,
      city: input.institution.city ?? null,
      country: input.institution.country,
    },
    year: input.year,
    domain: input.domain ?? { primary: "undetermined", secondary: [] },
    approach: input.approach ?? "mixed",
    studyDesign: input.studyDesign ?? null,
    citationStyle: input.citationStyle ?? "auto",
    presentation: {
      standard: input.presentation?.standard ?? "auto",
      paper: input.presentation?.paper ?? "letter",
      fontProfile: input.presentation?.fontProfile ?? "serif",
      palette: input.presentation?.palette ?? "okabe-ito",
      diagramTheme: input.presentation?.diagramTheme ?? "neutral",
      ...(input.presentation?.bodyFont ? { bodyFont: input.presentation.bodyFont } : {}),
      ...(input.presentation?.lineSpacing ? { lineSpacing: input.presentation.lineSpacing } : {}),
    },
    targets: input.targets ?? { pages: null, words: null },
    aiUse: input.aiUse ?? { assisted: true, declaration: "auto" },
    policy: input.policy ?? { packs: "auto" },
  };
}

/** Serialize a brief with the key order of the spec. */
export function stringifyBrief(brief: Brief): string {
  const ordered = {
    schemaVersion: brief.schemaVersion,
    language: brief.language,
    secondaryAbstractLanguage: brief.secondaryAbstractLanguage,
    searchLanguages: brief.searchLanguages,
    workType: brief.workType,
    title: brief.title,
    subtitle: brief.subtitle,
    authors: brief.authors,
    advisors: brief.advisors,
    institution: brief.institution,
    year: brief.year,
    domain: brief.domain,
    approach: brief.approach,
    studyDesign: brief.studyDesign,
    citationStyle: brief.citationStyle,
    presentation: brief.presentation,
    targets: brief.targets,
    aiUse: brief.aiUse,
    policy: brief.policy,
  };
  return `# Thesis brief. Edit freely; unknown keys are errors.\n${stringify(ordered, { lineWidth: 0 })}`;
}

class Collector {
  readonly issues: BriefIssue[] = [];
  constructor(
    private readonly lineOf: (path: (string | number)[], key?: string) => number | undefined,
  ) {}

  add(
    code: BriefIssue["code"],
    severity: BriefIssue["severity"],
    path: (string | number)[],
    message: string,
    keyOf?: string,
  ): void {
    const line = this.lineOf(keyOf === undefined ? path : path.slice(0, -1), keyOf);
    const issue: BriefIssue = { code, severity, path: formatPath(path), message };
    if (line !== undefined) issue.line = line;
    this.issues.push(issue);
  }

  error(path: (string | number)[], message: string, code: BriefIssue["code"] = "BRF-002"): void {
    this.add(code, "error", path, message);
  }
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === "number") return `${text}[${part}]`;
    return text ? `${text}.${part}` : part;
  }, "");
}

export function loadBrief(text: string, options: LoadBriefOptions = {}): LoadBriefResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: true });
  const lineAt = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;

  const syntax: BriefIssue[] = document.errors.map((error) => {
    const issue: BriefIssue = {
      code: "BRF-001",
      severity: "error",
      path: "",
      message: `thesis.yaml is not valid YAML: ${error.message.split("\n")[0] ?? error.code}`,
    };
    const line = error.linePos?.[0]?.line;
    if (line !== undefined) issue.line = line;
    return issue;
  });
  if (syntax.length > 0) return { issues: syntax };

  const parsed: unknown = document.toJS();
  if (parsed === null || parsed === undefined) {
    return {
      issues: [{ code: "BRF-001", severity: "error", path: "", message: "thesis.yaml is empty" }],
    };
  }
  if (!isRecord(parsed)) {
    return {
      issues: [
        {
          code: "BRF-001",
          severity: "error",
          path: "",
          message: "thesis.yaml must contain a mapping at the top level",
        },
      ],
    };
  }
  const raw = parsed;

  const lineOf = (path: (string | number)[], key?: string): number | undefined => {
    if (key !== undefined) {
      const parent = path.length === 0 ? document.contents : document.getIn(path, true);
      if (isMap(parent)) {
        const pair = parent.items.find(
          (item) => (item.key as { value?: unknown } | null)?.value === key,
        );
        const range = (pair?.key as { range?: [number, number, number] } | null)?.range;
        return lineAt(range?.[0]);
      }
      return undefined;
    }
    const node = path.length === 0 ? document.contents : document.getIn(path, true);
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    if (range) return lineAt(range[0]);
    return path.length > 1 ? lineOf(path.slice(0, -1)) : undefined;
  };
  const c = new Collector(lineOf);

  const unknownKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    base: string[],
  ) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key))
        c.add("BRF-002", "error", [...base, key], `Unknown key "${key}"`, key);
    }
  };

  const text_ = (
    value: unknown,
    path: (string | number)[],
    { max = 300, nullable = false }: { max?: number; nullable?: boolean } = {},
  ): string | null | undefined => {
    if (value === null && nullable) return null;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      controlPattern.test(value)
    ) {
      c.error(
        path,
        `Expected ${nullable ? "null or " : ""}a non-empty string of at most ${max} characters`,
      );
      return undefined;
    }
    return value;
  };

  const oneOf = <T extends string>(
    value: unknown,
    path: (string | number)[],
    allowed: readonly T[],
  ): T | undefined => {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      return value as T;
    c.error(path, `Expected one of: ${allowed.join(", ")}`);
    return undefined;
  };

  const language = (value: unknown, path: (string | number)[], nullable = false) => {
    if (value === null && nullable) return null;
    if (typeof value !== "string" || !isValidLanguageTag(value)) {
      c.error(path, "Expected a well-formed BCP-47 language tag such as es-CO or en", "BRF-003");
      return undefined;
    }
    return value;
  };

  const positiveInt = (value: unknown, path: (string | number)[]) => {
    if (value === null) return null;
    if (!Number.isInteger(value) || (value as number) <= 0) {
      c.error(path, "Expected null or a positive integer");
      return undefined;
    }
    return value as number;
  };

  const section = (
    value: unknown,
    key: string,
    allowed: readonly string[],
  ): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      c.error([key], "Expected a mapping");
      return undefined;
    }
    unknownKeys(value, allowed, [key]);
    return value;
  };

  unknownKeys(raw, topKeys, []);

  if (raw.schemaVersion !== 1) c.error(["schemaVersion"], "schemaVersion must be 1");
  if (raw.language === undefined) c.error(["language"], "language is required");
  const lang = raw.language === undefined ? undefined : language(raw.language, ["language"]);
  if (raw.workType === undefined) c.error(["workType"], "workType is required");
  const workType =
    raw.workType === undefined ? undefined : oneOf(raw.workType, ["workType"], workTypes);

  const secondary =
    raw.secondaryAbstractLanguage === undefined
      ? null
      : language(raw.secondaryAbstractLanguage, ["secondaryAbstractLanguage"], true);

  let searchLanguages: string[] | undefined;
  if (raw.searchLanguages !== undefined) {
    const list = raw.searchLanguages;
    if (!Array.isArray(list) || list.length < 1 || list.length > 5) {
      c.error(["searchLanguages"], "Expected 1 to 5 BCP-47 language tags");
    } else {
      const tags = list.map((tag, index) => language(tag, ["searchLanguages", index]));
      if (tags.every((tag): tag is string => typeof tag === "string")) searchLanguages = tags;
    }
  }

  const title =
    raw.title === undefined ? null : text_(raw.title, ["title"], { max: 400, nullable: true });
  const subtitle =
    raw.subtitle === undefined
      ? null
      : text_(raw.subtitle, ["subtitle"], { max: 400, nullable: true });

  const authors: Brief["authors"] = [];
  if (raw.authors !== undefined) {
    if (!Array.isArray(raw.authors) || raw.authors.length > 10) {
      c.error(["authors"], "Expected a list of at most 10 authors");
    } else {
      raw.authors.forEach((author: unknown, index: number) => {
        if (!isRecord(author)) {
          c.error(["authors", index], "Expected a mapping");
          return;
        }
        unknownKeys(author, ["name", "id"], ["authors", String(index)]);
        const name = text_(author.name, ["authors", index, "name"], { max: 200 });
        const id =
          author.id === undefined
            ? null
            : text_(author.id, ["authors", index, "id"], { max: 60, nullable: true });
        if (name && id !== undefined) authors.push({ name, id });
      });
    }
  }

  const advisors: Brief["advisors"] = [];
  if (raw.advisors !== undefined) {
    if (!Array.isArray(raw.advisors) || raw.advisors.length > 10) {
      c.error(["advisors"], "Expected a list of at most 10 advisors");
    } else {
      raw.advisors.forEach((advisor: unknown, index: number) => {
        if (!isRecord(advisor)) {
          c.error(["advisors", index], "Expected a mapping");
          return;
        }
        unknownKeys(advisor, ["name", "role"], ["advisors", String(index)]);
        const name = text_(advisor.name, ["advisors", index, "name"], { max: 200 });
        const role =
          advisor.role === undefined
            ? "advisor"
            : text_(advisor.role, ["advisors", index, "role"], { max: 60 });
        if (name && role) advisors.push({ name, role: role as string });
      });
    }
  }

  const institutionRaw = section(raw.institution, "institution", [
    "name",
    "faculty",
    "program",
    "city",
    "country",
  ]);
  const institution: Brief["institution"] = {
    name: null,
    faculty: null,
    program: null,
    city: null,
    country: "",
  };
  if (raw.institution !== undefined && !institutionRaw) {
    // already reported
  }
  if (institutionRaw) {
    for (const key of ["name", "faculty", "program", "city"] as const) {
      if (institutionRaw[key] === undefined) continue;
      const value = text_(institutionRaw[key], ["institution", key], { nullable: true });
      if (value !== undefined) institution[key] = value;
    }
    if (institutionRaw.country !== undefined) {
      if (
        typeof institutionRaw.country === "string" &&
        countryPattern.test(institutionRaw.country)
      ) {
        institution.country = institutionRaw.country;
      } else {
        c.error(["institution", "country"], "Expected an ISO 3166-1 alpha-2 code such as CO");
      }
    }
  }
  if (!institution.country && !c.issues.some((issue) => issue.path === "institution.country")) {
    c.error(["institution", "country"], "institution.country is required", "BRF-005");
  }

  let year: number | undefined;
  if (raw.year === undefined) {
    c.error(["year"], "year is required", "BRF-005");
  } else if (
    !Number.isInteger(raw.year) ||
    (raw.year as number) < 1900 ||
    (raw.year as number) > 2200
  ) {
    c.error(["year"], "Expected an integer year between 1900 and 2200");
  } else {
    year = raw.year as number;
  }

  const domainRaw = section(raw.domain, "domain", ["primary", "secondary"]);
  const domain: Brief["domain"] = { primary: "undetermined", secondary: [] };
  if (domainRaw) {
    if (domainRaw.primary !== undefined) {
      if (typeof domainRaw.primary === "string" && domainPattern.test(domainRaw.primary)) {
        domain.primary = domainRaw.primary;
      } else c.error(["domain", "primary"], "Expected a snake_case domain id");
    }
    if (domainRaw.secondary !== undefined) {
      const list = domainRaw.secondary;
      if (
        Array.isArray(list) &&
        list.length <= 5 &&
        list.every((item) => typeof item === "string" && domainPattern.test(item))
      ) {
        domain.secondary = list as string[];
      } else c.error(["domain", "secondary"], "Expected up to 5 snake_case domain ids");
    }
  }

  const approach =
    raw.approach === undefined ? "mixed" : oneOf(raw.approach, ["approach"], approaches);

  const studyDesign =
    raw.studyDesign === undefined || raw.studyDesign === null
      ? null
      : oneOf(raw.studyDesign, ["studyDesign"], studyDesigns);

  let citationStyle = "auto";
  if (raw.citationStyle !== undefined) {
    if (
      typeof raw.citationStyle === "string" &&
      (raw.citationStyle === "auto" || stylePattern.test(raw.citationStyle))
    ) {
      citationStyle = raw.citationStyle;
      const known = ["auto", ...shippedCitationStyles, ...(options.citationStyles ?? [])];
      if (!known.includes(citationStyle)) {
        c.add(
          "BRF-004",
          "error",
          ["citationStyle"],
          `Unknown citation style "${citationStyle}". Use auto, ${shippedCitationStyles.join(", ")} or the id of a style in styles/*.csl`,
        );
      }
    } else
      c.error(
        ["citationStyle"],
        "Expected auto or a style id (lowercase letters, digits, hyphens)",
      );
  }

  const presentationRaw = section(raw.presentation, "presentation", [
    "standard",
    "paper",
    "fontProfile",
    "palette",
    "diagramTheme",
    "bodyFont",
    "lineSpacing",
  ]);
  const presentation: Brief["presentation"] = {
    standard: "auto",
    paper: "letter",
    fontProfile: "serif",
    palette: "okabe-ito",
    diagramTheme: "neutral",
  };
  if (presentationRaw) {
    if (presentationRaw.standard !== undefined) {
      const standard = presentationRaw.standard;
      if (typeof standard === "string" && (standard === "auto" || stylePattern.test(standard))) {
        presentation.standard = standard;
        const known = [
          "auto",
          ...shippedPresentationStandards,
          ...(options.presentationStandards ?? []),
        ];
        if (!known.includes(standard)) {
          c.add(
            "BRF-004",
            "error",
            ["presentation", "standard"],
            `Unknown presentation standard "${standard}". Use auto, ${shippedPresentationStandards.join(", ")} or the id of a profile in styles/*.profile.yaml`,
          );
        }
      } else c.error(["presentation", "standard"], "Expected auto or a profile id");
    }
    const paper =
      presentationRaw.paper === undefined
        ? "letter"
        : oneOf(presentationRaw.paper, ["presentation", "paper"], ["letter", "a4"] as const);
    if (paper) presentation.paper = paper;
    const font =
      presentationRaw.fontProfile === undefined
        ? "serif"
        : oneOf(presentationRaw.fontProfile, ["presentation", "fontProfile"], [
            "serif",
            "sans",
            "institutional",
          ] as const);
    if (font) presentation.fontProfile = font;
    const palette =
      presentationRaw.palette === undefined
        ? "okabe-ito"
        : oneOf(presentationRaw.palette, ["presentation", "palette"], paletteNames);
    if (palette) presentation.palette = palette;
    const theme =
      presentationRaw.diagramTheme === undefined
        ? "neutral"
        : oneOf(presentationRaw.diagramTheme, ["presentation", "diagramTheme"], [
            "neutral",
            "grayscale",
          ] as const);
    if (theme) presentation.diagramTheme = theme;
    if (presentationRaw.bodyFont !== undefined && presentationRaw.bodyFont !== null) {
      const family = presentationRaw.bodyFont;
      if (typeof family === "string" && /^[A-Za-z0-9][A-Za-z0-9 .-]{0,59}$/.test(family)) {
        presentation.bodyFont = family;
      } else
        c.error(
          ["presentation", "bodyFont"],
          "Expected a font family name (letters, digits, spaces)",
        );
    }
    if (presentationRaw.lineSpacing !== undefined && presentationRaw.lineSpacing !== null) {
      const spacing = presentationRaw.lineSpacing;
      if (typeof spacing === "number" && spacing >= 1 && spacing <= 3) {
        presentation.lineSpacing = spacing;
      } else
        c.error(
          ["presentation", "lineSpacing"],
          "Expected a line spacing multiple between 1 and 3",
        );
    }
  }

  const targetsRaw = section(raw.targets, "targets", ["pages", "words"]);
  const targets: Brief["targets"] = { pages: null, words: null };
  if (targetsRaw) {
    for (const key of ["pages", "words"] as const) {
      if (targetsRaw[key] === undefined) continue;
      const value = positiveInt(targetsRaw[key], ["targets", key]);
      if (value !== undefined) targets[key] = value;
    }
  }

  const aiRaw = section(raw.aiUse, "aiUse", ["assisted", "declaration"]);
  const aiUse: Brief["aiUse"] = { assisted: true, declaration: "auto" };
  if (aiRaw) {
    if (aiRaw.assisted !== undefined) {
      if (typeof aiRaw.assisted === "boolean") aiUse.assisted = aiRaw.assisted;
      else c.error(["aiUse", "assisted"], "Expected true or false");
    }
    if (aiRaw.declaration !== undefined) {
      const declaration = oneOf(aiRaw.declaration, ["aiUse", "declaration"], [
        "auto",
        "always",
        "never",
      ] as const);
      if (declaration) aiUse.declaration = declaration;
    }
  }

  const policyRaw = section(raw.policy, "policy", ["packs"]);
  let policy: Brief["policy"] = { packs: "auto" };
  if (policyRaw && policyRaw.packs !== undefined) {
    const packs = policyRaw.packs;
    if (packs === "auto") policy = { packs: "auto" };
    else if (
      Array.isArray(packs) &&
      packs.length <= 20 &&
      packs.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(id))
    ) {
      policy = { packs: packs as string[] };
    } else c.error(["policy", "packs"], "Expected auto or a list of up to 20 packIds");
  }

  const hasError = c.issues.some((issue) => issue.severity === "error");
  if (
    !hasError &&
    lang &&
    workType &&
    year !== undefined &&
    approach &&
    title !== undefined &&
    subtitle !== undefined &&
    secondary !== undefined
  ) {
    const brief = applyBriefDefaults({
      language: lang,
      workType,
      year,
      institution,
      secondaryAbstractLanguage: secondary,
      title,
      subtitle,
      authors,
      advisors,
      domain,
      approach,
      studyDesign: studyDesign ?? null,
      citationStyle,
      presentation,
      targets,
      aiUse,
      policy,
      ...(searchLanguages ? { searchLanguages } : {}),
    });

    const warn = (path: string[], message: string) =>
      c.add("BRF-006", "warning", path, message, path.at(-1));
    if (!brief.title) warn(["title"], "No working title yet; the methodologist can propose three");
    if (brief.authors.length === 0)
      warn(["authors"], "No authors listed; the cover page needs them");
    if (!brief.institution.name) warn(["institution", "name"], "Institution name is not set");
    if (
      brief.advisors.length === 0 &&
      (brief.workType === "master_thesis" || brief.workType === "doctoral_dissertation")
    ) {
      warn(["advisors"], "No advisors listed; graduate work normally names at least one");
    }
    return { brief, raw, issues: c.issues };
  }
  return { raw, issues: c.issues };
}
