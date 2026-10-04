import { readdirSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { packagePath } from "../package-paths.js";

/**
 * Declarative presentation profiles (spec 10.4.1). A profile is format-neutral data with a closed
 * schema: no raw Typst, no code. Shipped profiles live in `templates/profiles/*.profile.yaml`;
 * workspace profiles in `thesis/styles/*.profile.yaml` may `extends` a shipped one and override
 * any key. Each output adapter maps the resolved profile to its own settings (the Typst adapter
 * does it in `adapters/typst-pdf/profile.ts`); nothing here mentions a concrete format.
 */

export type Length = string;
export type Align = "left" | "center" | "right";
export type CoverField =
  | "institution"
  | "faculty"
  | "program"
  | "title"
  | "subtitle"
  | "workType"
  | "authors"
  | "advisors"
  | "cityYear";
export type FrontPart = "dedication" | "acknowledgments" | "ai-declaration" | "abstract" | "toc";

export interface HeadingStyle {
  size: number;
  weight: "regular" | "bold";
  case: "none" | "upper" | "lower";
  /** Counter pattern for the heading number, for example `1.1`. */
  numbering: string;
  align: "left" | "center";
  spaceBefore: Length;
  spaceAfter: Length;
  newPage: boolean;
  /** The heading runs into the first line of the following paragraph. */
  runIn: boolean;
  /** Text appended to the title, for example `.` for run-in headings. */
  endsWith: string;
}

export interface PresentationProfile {
  id: string;
  extends: string | null;
  paper: "letter" | "a4" | null;
  margins: { top: Length; bottom: Length; inside: Length; outside: Length };
  binding: "left" | "mirrored";
  font: { body: string | null; headings: string | null; mono: string | null; size: number };
  lineSpacing: number;
  paragraph: { indent: Length; spacing: Length; justify: boolean };
  /** Always four entries, level 1 first. */
  headings: HeadingStyle[];
  captions: {
    figurePosition: "top" | "bottom";
    tablePosition: "top" | "bottom";
    labelStyle: "plain" | "bold" | "italic";
    separator: string;
    sourceBelow: boolean;
    numbering: "chapter" | "continuous";
  };
  pageNumbers: {
    front: "roman" | "arabic" | "none";
    body: "arabic" | "none";
    position: Align;
    /** Numbering continues from the cover instead of restarting in each part. */
    continuous: boolean;
  };
  cover: { fields: CoverField[]; layout: "centered" | "left" };
  frontMatter: FrontPart[];
  footnotes: { size: number };
  toc: { depth: 1 | 2 | 3 | 4; pageLabel: boolean };
  header: "chapter" | "none";
  annexNumbering: string;
  /** Rule ids that justify values, for traceability comments. */
  ruleIds: string[];
}

export interface ProfileIssue {
  code: "PRF-001";
  /** Dotted path of the offending key. */
  path: string;
  message: string;
}

const lengthPattern = /^\d{1,3}(?:\.\d{1,3})?(?:cm|mm|in|pt|em)$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const patternChars = /^[0-9A-Za-z.() -]{1,24}$/;
const coverFields: readonly CoverField[] = [
  "institution",
  "faculty",
  "program",
  "title",
  "subtitle",
  "workType",
  "authors",
  "advisors",
  "cityYear",
];
const frontParts: readonly FrontPart[] = [
  "dedication",
  "acknowledgments",
  "ai-declaration",
  "abstract",
  "toc",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A partially specified profile as written in YAML, after validation. */
export type ProfileInput = Record<string, unknown>;

class Reader {
  readonly issues: ProfileIssue[] = [];
  readonly ruleIds: string[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ code: "PRF-001", path, message });
  }

  /** A scalar may be written `{ value: x, ruleId: R }` to carry its justification. */
  unwrap(value: unknown, path: string): unknown {
    if (isRecord(value) && "value" in value) {
      const keys = Object.keys(value);
      if (keys.some((key) => key !== "value" && key !== "ruleId")) {
        this.fail(path, 'A value with a justification may only have the keys "value" and "ruleId"');
        return undefined;
      }
      if (value.ruleId !== undefined) this.ruleId(value.ruleId, `${path}.ruleId`);
      return value.value;
    }
    return value;
  }

  ruleId(value: unknown, path: string): void {
    if (typeof value === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(value)) {
      if (!this.ruleIds.includes(value)) this.ruleIds.push(value);
    } else this.fail(path, "ruleId must be a rule id such as CO.NTC1486.2022.FORMAT.MARGIN.01");
  }

  section(
    value: unknown,
    path: string,
    keys: readonly string[],
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      this.fail(path, "Expected a mapping");
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (key === "ruleId") {
        this.ruleId(value.ruleId, `${path}.ruleId`);
      } else if (!keys.includes(key)) {
        this.fail(
          path === "" ? key : `${path}.${key}`,
          `Unknown key "${key}"; allowed keys: ${keys.join(", ")}`,
        );
      }
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    const raw = this.unwrap(value, path);
    if (typeof raw === "string" && (options as readonly string[]).includes(raw)) return raw as T;
    this.fail(path, `Expected one of: ${options.join(", ")}`);
    return undefined;
  }

  length(value: unknown, path: string): string | undefined {
    const raw = this.unwrap(value, path);
    if (typeof raw === "string" && lengthPattern.test(raw)) return raw;
    this.fail(path, 'Expected a length such as "2cm", "12pt", "1in" or "1.2em"');
    return undefined;
  }

  number(value: unknown, path: string, min: number, max: number): number | undefined {
    const raw = this.unwrap(value, path);
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max) return raw;
    this.fail(path, `Expected a number between ${min} and ${max}`);
    return undefined;
  }

  bool(value: unknown, path: string): boolean | undefined {
    const raw = this.unwrap(value, path);
    if (typeof raw === "boolean") return raw;
    this.fail(path, "Expected true or false");
    return undefined;
  }

  text(value: unknown, path: string, maxLength: number, allowEmpty = false): string | undefined {
    const raw = this.unwrap(value, path);
    if (
      typeof raw === "string" &&
      raw.length <= maxLength &&
      (allowEmpty || raw.length > 0) &&
      ![...raw].some((char) => (char.codePointAt(0) as number) < 0x20)
    ) {
      return raw;
    }
    this.fail(path, `Expected text of up to ${maxLength} characters`);
    return undefined;
  }

  fontName(value: unknown, path: string): string | null | undefined {
    const raw = this.unwrap(value, path);
    if (raw === null) return null;
    if (typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9 .-]{0,59}$/.test(raw)) return raw;
    this.fail(path, "Expected a font family name (letters, digits, spaces) or null");
    return undefined;
  }
}

const setIf = (target: Record<string, unknown>, key: string, value: unknown) => {
  if (value !== undefined) target[key] = value;
};

/** Validate a parsed YAML document against the closed profile schema (PRF-001). */
export function validateProfile(raw: unknown): {
  input: ProfileInput;
  issues: ProfileIssue[];
  ruleIds: string[];
} {
  const r = new Reader();
  const input: ProfileInput = {};
  if (!isRecord(raw)) {
    r.fail("", "A profile must be a YAML mapping");
    return { input, issues: r.issues, ruleIds: r.ruleIds };
  }
  const top = r.section(raw, "", [
    "id",
    "description",
    "extends",
    "paper",
    "margins",
    "binding",
    "font",
    "lineSpacing",
    "paragraph",
    "headings",
    "captions",
    "pageNumbers",
    "cover",
    "frontMatter",
    "footnotes",
    "toc",
    "header",
    "annexNumbering",
  ]) as Record<string, unknown>;

  if (top.id !== undefined) {
    if (typeof top.id === "string" && idPattern.test(top.id)) input.id = top.id;
    else r.fail("id", "Expected a profile id (lowercase letters, digits, hyphens)");
  }
  if (top.description !== undefined) r.text(top.description, "description", 300);
  if (top.extends !== undefined) {
    if (typeof top.extends === "string" && idPattern.test(top.extends)) input.extends = top.extends;
    else r.fail("extends", "Expected the id of a shipped profile");
  }
  if (top.paper !== undefined) setIf(input, "paper", r.oneOf(top.paper, "paper", ["letter", "a4"]));
  if (top.binding !== undefined)
    setIf(input, "binding", r.oneOf(top.binding, "binding", ["left", "mirrored"]));
  if (top.lineSpacing !== undefined)
    setIf(input, "lineSpacing", r.number(top.lineSpacing, "lineSpacing", 1, 3));
  if (top.header !== undefined)
    setIf(input, "header", r.oneOf(top.header, "header", ["chapter", "none"]));
  if (top.annexNumbering !== undefined) {
    const pattern = r.text(top.annexNumbering, "annexNumbering", 24);
    if (pattern !== undefined && patternChars.test(pattern)) input.annexNumbering = pattern;
    else if (pattern !== undefined)
      r.fail("annexNumbering", "Expected a counter pattern such as A.1");
  }

  if (top.margins !== undefined) {
    const section = r.section(top.margins, "margins", ["top", "bottom", "inside", "outside"]);
    if (section) {
      const margins: Record<string, unknown> = {};
      for (const key of ["top", "bottom", "inside", "outside"]) {
        if (section[key] !== undefined)
          setIf(margins, key, r.length(section[key], `margins.${key}`));
      }
      input.margins = margins;
    }
  }
  if (top.font !== undefined) {
    const section = r.section(top.font, "font", ["body", "headings", "mono", "size"]);
    if (section) {
      const font: Record<string, unknown> = {};
      for (const key of ["body", "headings", "mono"]) {
        if (section[key] !== undefined) setIf(font, key, r.fontName(section[key], `font.${key}`));
      }
      if (section.size !== undefined)
        setIf(font, "size", r.number(section.size, "font.size", 8, 16));
      input.font = font;
    }
  }
  if (top.paragraph !== undefined) {
    const section = r.section(top.paragraph, "paragraph", ["indent", "spacing", "justify"]);
    if (section) {
      const paragraph: Record<string, unknown> = {};
      if (section.indent !== undefined)
        setIf(paragraph, "indent", r.length(section.indent, "paragraph.indent"));
      if (section.spacing !== undefined)
        setIf(paragraph, "spacing", r.length(section.spacing, "paragraph.spacing"));
      if (section.justify !== undefined)
        setIf(paragraph, "justify", r.bool(section.justify, "paragraph.justify"));
      input.paragraph = paragraph;
    }
  }
  if (top.headings !== undefined) {
    if (!Array.isArray(top.headings) || top.headings.length > 4) {
      r.fail(
        "headings",
        "Expected a list of up to four heading styles, each with a level (1 to 4)",
      );
    } else {
      const seen = new Set<number>();
      const list: Record<string, unknown>[] = [];
      top.headings.forEach((entry, index) => {
        const path = `headings[${index}]`;
        const section = r.section(entry, path, [
          "level",
          "size",
          "weight",
          "case",
          "numbering",
          "align",
          "spaceBefore",
          "spaceAfter",
          "newPage",
          "runIn",
          "endsWith",
        ]);
        if (!section) return;
        const level = r.number(section.level, `${path}.level`, 1, 4);
        if (level === undefined || !Number.isInteger(level)) {
          if (level !== undefined) r.fail(`${path}.level`, "Expected an integer from 1 to 4");
          return;
        }
        if (seen.has(level)) {
          r.fail(`${path}.level`, `Level ${level} is listed more than once`);
          return;
        }
        seen.add(level);
        const heading: Record<string, unknown> = { level };
        if (section.size !== undefined)
          setIf(heading, "size", r.number(section.size, `${path}.size`, 8, 36));
        if (section.weight !== undefined)
          setIf(heading, "weight", r.oneOf(section.weight, `${path}.weight`, ["regular", "bold"]));
        if (section.case !== undefined)
          setIf(heading, "case", r.oneOf(section.case, `${path}.case`, ["none", "upper", "lower"]));
        if (section.numbering !== undefined) {
          const pattern = r.text(section.numbering, `${path}.numbering`, 24);
          if (pattern !== undefined && patternChars.test(pattern)) heading.numbering = pattern;
          else if (pattern !== undefined)
            r.fail(`${path}.numbering`, "Expected a counter pattern such as 1.1.1");
        }
        if (section.align !== undefined)
          setIf(heading, "align", r.oneOf(section.align, `${path}.align`, ["left", "center"]));
        if (section.spaceBefore !== undefined)
          setIf(heading, "spaceBefore", r.length(section.spaceBefore, `${path}.spaceBefore`));
        if (section.spaceAfter !== undefined)
          setIf(heading, "spaceAfter", r.length(section.spaceAfter, `${path}.spaceAfter`));
        if (section.newPage !== undefined)
          setIf(heading, "newPage", r.bool(section.newPage, `${path}.newPage`));
        if (section.runIn !== undefined)
          setIf(heading, "runIn", r.bool(section.runIn, `${path}.runIn`));
        if (section.endsWith !== undefined)
          setIf(heading, "endsWith", r.text(section.endsWith, `${path}.endsWith`, 4, true));
        list.push(heading);
      });
      input.headings = list;
    }
  }
  if (top.captions !== undefined) {
    const section = r.section(top.captions, "captions", [
      "figurePosition",
      "tablePosition",
      "labelStyle",
      "separator",
      "sourceBelow",
      "numbering",
    ]);
    if (section) {
      const captions: Record<string, unknown> = {};
      if (section.figurePosition !== undefined)
        setIf(
          captions,
          "figurePosition",
          r.oneOf(section.figurePosition, "captions.figurePosition", ["top", "bottom"]),
        );
      if (section.tablePosition !== undefined)
        setIf(
          captions,
          "tablePosition",
          r.oneOf(section.tablePosition, "captions.tablePosition", ["top", "bottom"]),
        );
      if (section.labelStyle !== undefined)
        setIf(
          captions,
          "labelStyle",
          r.oneOf(section.labelStyle, "captions.labelStyle", ["plain", "bold", "italic"]),
        );
      if (section.separator !== undefined)
        setIf(captions, "separator", r.text(section.separator, "captions.separator", 6));
      if (section.sourceBelow !== undefined)
        setIf(captions, "sourceBelow", r.bool(section.sourceBelow, "captions.sourceBelow"));
      if (section.numbering !== undefined)
        setIf(
          captions,
          "numbering",
          r.oneOf(section.numbering, "captions.numbering", ["chapter", "continuous"]),
        );
      input.captions = captions;
    }
  }
  if (top.pageNumbers !== undefined) {
    const section = r.section(top.pageNumbers, "pageNumbers", [
      "front",
      "body",
      "position",
      "continuous",
    ]);
    if (section) {
      const pageNumbers: Record<string, unknown> = {};
      if (section.front !== undefined)
        setIf(
          pageNumbers,
          "front",
          r.oneOf(section.front, "pageNumbers.front", ["roman", "arabic", "none"]),
        );
      if (section.body !== undefined)
        setIf(pageNumbers, "body", r.oneOf(section.body, "pageNumbers.body", ["arabic", "none"]));
      if (section.position !== undefined)
        setIf(
          pageNumbers,
          "position",
          r.oneOf(section.position, "pageNumbers.position", ["left", "center", "right"]),
        );
      if (section.continuous !== undefined)
        setIf(pageNumbers, "continuous", r.bool(section.continuous, "pageNumbers.continuous"));
      input.pageNumbers = pageNumbers;
    }
  }
  if (top.cover !== undefined) {
    const section = r.section(top.cover, "cover", ["fields", "layout"]);
    if (section) {
      const cover: Record<string, unknown> = {};
      if (section.fields !== undefined) {
        if (
          Array.isArray(section.fields) &&
          section.fields.length <= 12 &&
          section.fields.every((field) => (coverFields as readonly unknown[]).includes(field))
        ) {
          cover.fields = section.fields;
        } else r.fail("cover.fields", `Expected a list of: ${coverFields.join(", ")}`);
      }
      if (section.layout !== undefined)
        setIf(cover, "layout", r.oneOf(section.layout, "cover.layout", ["centered", "left"]));
      input.cover = cover;
    }
  }
  if (top.frontMatter !== undefined) {
    if (
      Array.isArray(top.frontMatter) &&
      top.frontMatter.length <= 5 &&
      new Set(top.frontMatter).size === top.frontMatter.length &&
      top.frontMatter.every((part) => (frontParts as readonly unknown[]).includes(part))
    ) {
      input.frontMatter = top.frontMatter;
    } else r.fail("frontMatter", `Expected a list without repeats of: ${frontParts.join(", ")}`);
  }
  if (top.footnotes !== undefined) {
    const section = r.section(top.footnotes, "footnotes", ["size"]);
    if (section) {
      const footnotes: Record<string, unknown> = {};
      if (section.size !== undefined)
        setIf(footnotes, "size", r.number(section.size, "footnotes.size", 7, 14));
      input.footnotes = footnotes;
    }
  }
  if (top.toc !== undefined) {
    const section = r.section(top.toc, "toc", ["depth", "pageLabel"]);
    if (section) {
      const toc: Record<string, unknown> = {};
      if (section.depth !== undefined) {
        const depth = r.number(section.depth, "toc.depth", 1, 4);
        if (depth !== undefined && Number.isInteger(depth)) toc.depth = depth;
        else if (depth !== undefined) r.fail("toc.depth", "Expected an integer from 1 to 4");
      }
      if (section.pageLabel !== undefined)
        setIf(toc, "pageLabel", r.bool(section.pageLabel, "toc.pageLabel"));
      input.toc = toc;
    }
  }
  return { input, issues: r.issues, ruleIds: r.ruleIds };
}

// ---------------------------------------------------------------------------------------------
// Parsing, shipped profiles and resolution
// ---------------------------------------------------------------------------------------------

export interface ParsedProfile {
  input?: ProfileInput;
  ruleIds: string[];
  issues: ProfileIssue[];
}

/** Parse profile YAML text. Anchors, merge keys and custom tags are refused (no aliasing games). */
export function parseProfileText(text: string): ParsedProfile {
  if (Buffer.byteLength(text) > 64 * 1024) {
    return {
      ruleIds: [],
      issues: [{ code: "PRF-001", path: "", message: "The profile is larger than 64 KB" }],
    };
  }
  const document = parseDocument(text, { uniqueKeys: true, merge: false });
  if (document.errors.length > 0) {
    return {
      ruleIds: [],
      issues: [
        {
          code: "PRF-001",
          path: "",
          message: `The profile is not valid YAML: ${document.errors[0]?.message.split("\n")[0] ?? "error"}`,
        },
      ],
    };
  }
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      ruleIds: [],
      issues: [
        {
          code: "PRF-001",
          path: "",
          message: "YAML anchors and aliases are not allowed in a profile",
        },
      ],
    };
  }
  const { input, issues, ruleIds } = validateProfile(data);
  return { input, ruleIds, issues };
}

const shippedCache = new Map<string, PresentationProfile>();

/** Ids of the profiles shipped in `templates/profiles/`. */
export function shippedProfileIds(): string[] {
  return readdirSync(packagePath("templates", "profiles"))
    .filter((name) => name.endsWith(".profile.yaml"))
    .map((name) => name.slice(0, -".profile.yaml".length))
    .sort();
}

type DeepRecord = Record<string, unknown>;

function mergeInto(base: DeepRecord, over: DeepRecord): DeepRecord {
  const out: DeepRecord = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key === "headings") continue;
    const current = out[key];
    out[key] =
      isRecord(value) && isRecord(current) ? mergeInto(current, value) : (value as unknown);
  }
  return out;
}

/** Apply a validated partial profile over a fully resolved one; headings merge by level. */
function applyProfile(base: PresentationProfile, input: ProfileInput): PresentationProfile {
  const merged = mergeInto(base as unknown as DeepRecord, input) as unknown as PresentationProfile;
  const headings = base.headings.map((heading) => ({ ...heading }));
  const overrides = (input.headings ?? []) as (Partial<HeadingStyle> & { level: number })[];
  for (const entry of overrides) {
    const { level, ...rest } = entry;
    headings[level - 1] = { ...(headings[level - 1] as HeadingStyle), ...rest };
  }
  merged.headings = headings;
  return merged;
}

/**
 * Load a shipped profile by id. A shipped profile is a complete one (every key present) or it
 * extends another shipped profile; either way the result is fully populated.
 */
export function loadShippedProfile(id: string): PresentationProfile | undefined {
  const cached = shippedCache.get(id);
  if (cached) return cached;
  if (!shippedProfileIds().includes(id)) return undefined;
  const parsed = parseProfileText(
    readFileSync(packagePath("templates", "profiles", `${id}.profile.yaml`), "utf8"),
  );
  if (parsed.issues.length > 0 || !parsed.input) {
    throw new Error(
      `Shipped profile ${id} is invalid: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  const parent = parsed.input.extends
    ? loadShippedProfile(String(parsed.input.extends))
    : undefined;
  if (parsed.input.extends && !parent)
    throw new Error(`Shipped profile ${id} extends an unknown profile`);
  const base = parent ?? baseline();
  const resolved = applyProfile(base, parsed.input);
  resolved.id = id;
  resolved.extends = parent ? parent.id : null;
  resolved.ruleIds = [...new Set([...(parent?.ruleIds ?? []), ...parsed.ruleIds])];
  shippedCache.set(id, resolved);
  return resolved;
}

/** The root of every `extends` chain: a plain, conservative thesis layout. */
export function baseline(): PresentationProfile {
  return {
    id: "baseline",
    extends: null,
    paper: null,
    margins: { top: "2.5cm", bottom: "2.5cm", inside: "3cm", outside: "2.5cm" },
    binding: "left",
    font: { body: null, headings: null, mono: null, size: 12 },
    lineSpacing: 1.5,
    paragraph: { indent: "1.25cm", spacing: "0.9em", justify: true },
    headings: [1, 2, 3, 4].map((level) => ({
      size: 12,
      weight: "bold" as const,
      case: "none" as const,
      numbering: Array.from({ length: level }, () => "1").join("."),
      align: "left" as const,
      spaceBefore: "1.2em",
      spaceAfter: "0.7em",
      newPage: level === 1,
      runIn: false,
      endsWith: "",
    })),
    captions: {
      figurePosition: "bottom",
      tablePosition: "top",
      labelStyle: "plain",
      separator: ". ",
      sourceBelow: false,
      numbering: "chapter",
    },
    pageNumbers: { front: "roman", body: "arabic", position: "center", continuous: false },
    cover: {
      fields: [
        "institution",
        "faculty",
        "program",
        "title",
        "subtitle",
        "workType",
        "authors",
        "advisors",
        "cityYear",
      ],
      layout: "centered",
    },
    frontMatter: ["dedication", "acknowledgments", "ai-declaration", "abstract", "toc"],
    footnotes: { size: 10 },
    toc: { depth: 3, pageLabel: false },
    header: "chapter",
    annexNumbering: "A.1.1",
    ruleIds: [],
  };
}

export interface WorkspaceProfileFile {
  /** File stem, which is the profile id. */
  id: string;
  file: string;
  text: string;
}

export interface ResolvedWorkspaceProfile {
  profile?: PresentationProfile;
  issues: ProfileIssue[];
}

/** PRF-001 for one workspace profile file: id rules, no shadowing, schema, resolvable extends. */
export function resolveWorkspaceProfile(file: WorkspaceProfileFile): ResolvedWorkspaceProfile {
  const issues: ProfileIssue[] = [];
  if (!idPattern.test(file.id)) {
    issues.push({
      code: "PRF-001",
      path: "",
      message: `The file name "${file.id}.profile.yaml" is not a valid profile id (lowercase letters, digits and hyphens)`,
    });
  }
  if (shippedProfileIds().includes(file.id)) {
    issues.push({
      code: "PRF-001",
      path: "",
      message: `The profile id "${file.id}" shadows a profile shipped with the plugin; choose another id`,
    });
  }
  const parsed = parseProfileText(file.text);
  issues.push(...parsed.issues);
  if (parsed.input?.id !== undefined && parsed.input.id !== file.id) {
    issues.push({
      code: "PRF-001",
      path: "id",
      message: `id "${String(parsed.input.id)}" does not match the file name ${file.id}.profile.yaml`,
    });
  }
  if (issues.length > 0 || !parsed.input) return { issues };
  const parentId = typeof parsed.input.extends === "string" ? parsed.input.extends : "generic";
  const parent = loadShippedProfile(parentId);
  if (!parent) {
    return {
      issues: [
        {
          code: "PRF-001",
          path: "extends",
          message: `extends "${parentId}" is not a shipped profile (${shippedProfileIds().join(", ")})`,
        },
      ],
    };
  }
  const resolved = applyProfile(parent, parsed.input);
  resolved.id = file.id;
  resolved.extends = parent.id;
  resolved.ruleIds = [...new Set([...parent.ruleIds, ...parsed.ruleIds])];
  return { profile: resolved, issues: [] };
}
