import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogEntry,
  type CslInfo,
  type CslIssue,
  inspectCsl,
  loadCatalog,
  readShippedStyle,
  shippedStyleIds,
} from "./csl.js";
import {
  loadShippedProfile,
  type PresentationProfile,
  type ProfileIssue,
  resolveWorkspaceProfile,
  type WorkspaceProfileFile,
} from "./profile.js";

/**
 * Discovery of workspace styles and profiles (spec 10.4.1): `thesis/styles/*.csl`,
 * `thesis/styles/*.profile.yaml` and `thesis/styles/fixtures/<id>.expected.json`. Only regular
 * files are read (symlinks are ignored), each capped in size.
 */

export interface WorkspaceStyleFile {
  /** File stem, which is the style id. */
  id: string;
  /** Path relative to the thesis root. */
  file: string;
  text: string;
}

export interface WorkspaceStyleAssets {
  styles: WorkspaceStyleFile[];
  profiles: WorkspaceProfileFile[];
  /** Expected renderings by style id (raw JSON text). */
  fixtures: Record<string, string>;
}

const maxFiles = 50;
const maxBytes = 4 * 1024 * 1024;

async function readFiles(
  directory: string,
  suffix: string,
): Promise<{ name: string; text: string }[]> {
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort()
      .slice(0, maxFiles);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: { name: string; text: string }[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path);
    out.push({ name, text: info.size > maxBytes ? "" : await readFile(path, "utf8") });
  }
  return out;
}

export async function loadWorkspaceStyleAssets(root: string): Promise<WorkspaceStyleAssets> {
  const base = join(root, "styles");
  const styles = (await readFiles(base, ".csl")).map(({ name, text }) => ({
    id: name.slice(0, -4),
    file: `styles/${name}`,
    text,
  }));
  const profiles = (await readFiles(base, ".profile.yaml")).map(({ name, text }) => ({
    id: name.slice(0, -".profile.yaml".length),
    file: `styles/${name}`,
    text,
  }));
  const fixtures: Record<string, string> = {};
  for (const { name, text } of await readFiles(join(base, "fixtures"), ".expected.json")) {
    fixtures[name.slice(0, -".expected.json".length)] = text;
  }
  return { styles, profiles, fixtures };
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface ResolvedCitationStyle {
  id: string;
  title: string;
  source: "shipped" | "workspace";
  provisional: boolean;
  citationFormat: string;
  /** Style file name inside the build directory. */
  file: string;
  text: string;
  info?: CslInfo;
}

export interface StyleResolution {
  style?: ResolvedCitationStyle;
  issues: CslIssue[];
}

/** Find a citation style by id among the shipped catalog and the workspace styles. */
export function resolveCitationStyle(
  id: string,
  workspace: readonly WorkspaceStyleFile[],
): StyleResolution {
  const shipped = readShippedStyle(id);
  if (shipped) {
    return {
      issues: [],
      style: {
        id,
        title: shipped.title,
        source: "shipped",
        provisional: shipped.provisional,
        citationFormat: shipped.citationFormat,
        file: shipped.file,
        text: shipped.text,
      },
    };
  }
  const found = workspace.find((entry) => entry.id === id);
  if (!found) {
    return {
      issues: [
        { code: "CSL-001", message: `Citation style "${id}" is neither shipped nor in styles/` },
      ],
    };
  }
  const inspected = inspectCsl(found.text, { stem: found.id, shipped: shippedStyleIds() });
  if (inspected.issues.length > 0 || !inspected.info) return { issues: inspected.issues };
  return {
    issues: [],
    style: {
      id,
      title: inspected.info.title,
      source: "workspace",
      provisional: false,
      citationFormat: inspected.info.citationFormat ?? "author-date",
      file: `${id}.csl`,
      text: found.text,
      info: inspected.info,
    },
  };
}

export interface ProfileResolution {
  profile?: PresentationProfile;
  issues: ProfileIssue[];
}

export function resolvePresentationProfile(
  id: string,
  workspace: readonly WorkspaceProfileFile[],
): ProfileResolution {
  const shipped = loadShippedProfile(id);
  if (shipped) return { profile: shipped, issues: [] };
  const found = workspace.find((entry) => entry.id === id);
  if (!found) return { issues: [] };
  return resolveWorkspaceProfile(found);
}

export { type CatalogEntry, loadCatalog };
