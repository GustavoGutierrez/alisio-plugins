import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type LoadBriefResult, loadBrief } from "../brief.js";
import { packagePath } from "../package-paths.js";
import type { PackSelection } from "../policy/packs.js";
import {
  type ComplianceProfile,
  crossValidate,
  type LoadedPack,
  type LoadedRule,
  loadOverrides,
  loadPacks,
  type PackProblem,
  resolve,
  selectPacks,
} from "../policy/resolver.js";
import { loadWorkspaceStyleAssets, type WorkspaceStyleFile } from "../styles/discovery.js";
import type { WorkspaceProfileFile } from "../styles/profile.js";
import type { SectionState, ThesisState } from "../types.js";

export interface ProjectFile {
  /** Path relative to the thesis root, `/`-separated. */
  path: string;
  content: string;
}

/** Everything a pure check needs, loaded once. */
export interface LoadedProject {
  root: string;
  briefText: string | undefined;
  brief: LoadBriefResult | undefined;
  workspaceCitationStyles: string[];
  workspacePresentationStandards: string[];
  /** Workspace CSL styles, presentation profiles and style fixtures (spec 10.4.1). */
  styleFiles: WorkspaceStyleFile[];
  profileFiles: WorkspaceProfileFile[];
  styleFixtures: Record<string, string>;
  /** Chart specs under figures/charts and the files under data/, for the FIG checks. */
  chartSpecs: ProjectFile[];
  dataFiles: string[];
  /** Every shipped and workspace pack found, active or not. */
  allPacks: LoadedPack[];
  selection: PackSelection | undefined;
  overrides: LoadedRule[];
  policyProblems: PackProblem[];
  /** Fresh resolution; undefined while the brief has errors. */
  profile: ComplianceProfile | undefined;
  /** Raw text of compliance-profile.json, when present. */
  profileOnDisk: string | undefined;
  chapters: ProjectFile[];
  /** Raw text of research/protocol.md, outline/outline.json and the evidence files, when present. */
  protocolText: string | undefined;
  outlineText: string | undefined;
  libraryText: string | undefined;
  rejectedText: string | undefined;
  bibliographyText: string | undefined;
  /** Raw text of claims/claims.jsonl and the `reviews/FND-*.json` files, when present. */
  claimsText: string | undefined;
  reviewFiles: ProjectFile[];
  /** Raw text of i18n.yaml (user label overrides) and build/build-report.json, when present. */
  i18nText: string | undefined;
  buildReportText: string | undefined;
  /** Section states from state.json; undefined when the caller has no state (e.g. a bare folder). */
  sections: Record<string, SectionState> | undefined;
  /** Whole workspace state, for the checks that depend on gates and progress (ETH, POL-AI, REV, FIN). */
  state: ThesisState | undefined;
  now: Date;
}

export interface LoadProjectOptions {
  packsRoot?: string;
  /** Defaults to `<root>/policy-packs`. */
  workspacePacksRoot?: string;
  /** Section states from state.json, for the checks that depend on progress (EVD-010). */
  sections?: Record<string, SectionState>;
  /** The whole state; implies `sections`. */
  state?: ThesisState;
  now?: Date;
}

const maxChapterFiles = 500;
const maxFileBytes = 2 * 1024 * 1024;

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function listStyleIds(directory: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name.slice(0, -suffix.length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const maxChartSpecs = 200;
const maxDataFiles = 2000;

/** Chart spec texts (`*.vl.json` files under figures/). */
async function collectChartSpecs(root: string): Promise<ProjectFile[]> {
  const base = join(root, "figures");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: ProjectFile[] = [];
  const sorted = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".vl.json"))
    .map((entry) => join((entry as { parentPath?: string }).parentPath ?? base, entry.name))
    .sort();
  for (const absolute of sorted.slice(0, maxChartSpecs)) {
    if ((await stat(absolute)).size > 1024 * 1024) continue;
    files.push({
      path: absolute
        .slice(root.length + 1)
        .split("\\")
        .join("/"),
      content: await readFile(absolute, "utf8"),
    });
  }
  return files;
}

/** Regular files under data/, relative to it. */
async function collectDataFiles(root: string): Promise<string[]> {
  const base = join(root, "data");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join((entry as { parentPath?: string }).parentPath ?? base, entry.name)
        .slice(base.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort()
    .slice(0, maxDataFiles);
}

const maxReviewFiles = 500;

/** `reviews/FND-*.json`, sorted. */
async function collectReviews(root: string): Promise<ProjectFile[]> {
  const base = join(root, "reviews");
  let names: string[];
  try {
    names = (await readdir(base)).filter((name) => /^FND-\d{4}\.json$/.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: ProjectFile[] = [];
  for (const name of names.slice(0, maxReviewFiles)) {
    const absolute = join(base, name);
    if ((await stat(absolute)).size > 64 * 1024) continue;
    files.push({ path: `reviews/${name}`, content: await readFile(absolute, "utf8") });
  }
  return files;
}

async function collectChapters(root: string): Promise<ProjectFile[]> {
  const base = join(root, "chapters");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: ProjectFile[] = [];
  const sorted = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join((entry as { parentPath?: string }).parentPath ?? base, entry.name))
    .sort();
  for (const absolute of sorted.slice(0, maxChapterFiles)) {
    if ((await stat(absolute)).size > maxFileBytes) continue;
    files.push({
      path: absolute
        .slice(root.length + 1)
        .split("\\")
        .join("/"),
      content: await readFile(absolute, "utf8"),
    });
  }
  return files;
}

export async function loadProject(
  root: string,
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const briefText = await readIfPresent(join(root, "thesis.yaml"));
  const workspaceCitationStyles = await listStyleIds(join(root, "styles"), ".csl");
  const workspacePresentationStandards = await listStyleIds(join(root, "styles"), ".profile.yaml");
  const styleAssets = await loadWorkspaceStyleAssets(root);
  const brief =
    briefText === undefined
      ? undefined
      : loadBrief(briefText, {
          citationStyles: workspaceCitationStyles,
          presentationStandards: workspacePresentationStandards,
        });

  const shipped = await loadPacks(options.packsRoot ?? packagePath("policy-packs"), "shipped");
  const workspacePacks = await loadPacks(
    options.workspacePacksRoot ?? join(root, "policy-packs"),
    "workspace",
  );
  const allPacks = [...shipped.packs, ...workspacePacks.packs];
  const loadedOverrides = await loadOverrides(join(root, "policy"));
  const policyProblems: PackProblem[] = [
    ...shipped.problems,
    ...workspacePacks.problems,
    ...crossValidate(allPacks),
    ...loadedOverrides.problems,
  ];
  if (!allPacks.some((pack) => pack.scope === "global")) {
    policyProblems.push({
      code: "PCK-001",
      severity: "error",
      file: "policy-packs/global",
      message: "The global policy pack is missing",
    });
  }

  const selection = brief?.brief ? selectPacks(allPacks, brief.brief) : undefined;
  if (selection) policyProblems.push(...selection.problems);
  const profile =
    brief?.brief && selection
      ? resolve(brief.brief, selection.active, loadedOverrides.rules)
      : undefined;

  return {
    root,
    briefText,
    brief,
    workspaceCitationStyles,
    workspacePresentationStandards,
    styleFiles: styleAssets.styles,
    profileFiles: styleAssets.profiles,
    styleFixtures: styleAssets.fixtures,
    chartSpecs: await collectChartSpecs(root),
    dataFiles: await collectDataFiles(root),
    allPacks,
    selection,
    overrides: loadedOverrides.rules,
    policyProblems,
    profile,
    profileOnDisk: await readIfPresent(join(root, "compliance-profile.json")),
    chapters: await collectChapters(root),
    protocolText: await readIfPresent(join(root, "research", "protocol.md")),
    outlineText: await readIfPresent(join(root, "outline", "outline.json")),
    libraryText: await readIfPresent(join(root, "evidence", "library.jsonl")),
    rejectedText: await readIfPresent(join(root, "evidence", "rejected.jsonl")),
    bibliographyText: await readIfPresent(join(root, "bibliography", "references.bib")),
    claimsText: await readIfPresent(join(root, "claims", "claims.jsonl")),
    reviewFiles: await collectReviews(root),
    i18nText: await readIfPresent(join(root, "i18n.yaml")),
    buildReportText: await readIfPresent(join(root, "build", "build-report.json")),
    sections: options.sections ?? options.state?.sections,
    state: options.state,
    now: options.now ?? new Date(),
  };
}
