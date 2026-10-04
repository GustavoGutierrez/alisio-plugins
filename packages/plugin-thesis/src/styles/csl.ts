import { readFileSync } from "node:fs";
import { packagePath } from "../package-paths.js";
import { child, childrenNamed, parseXml, walkXml, type XmlElement, XmlError } from "./xml.js";

/** CSL 1.0.2 namespace (spec 10.4). */
export const cslNamespace = "http://purl.org/net/xbiblio/csl";

export interface CslIssue {
  code: "CSL-001";
  message: string;
  hint?: string;
}

export interface CslInfo {
  /** Full `<info><id>` text. */
  id: string;
  /** Last path segment of the id; for workspace styles it must equal the file stem. */
  styleId: string;
  title: string;
  updated: string;
  citationFormat?: string;
  hasRights: boolean;
  independentParent: boolean;
}

export const styleIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function lastSegment(id: string): string {
  const trimmed = id.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Read the `<info>` block of a parsed style. */
export function readInfo(root: XmlElement): CslInfo | undefined {
  const info = child(root, "info");
  if (!info) return undefined;
  const id = child(info, "id")?.text ?? "";
  const category = childrenNamed(info, "category").find(
    (entry) => "citation-format" in entry.attrs,
  );
  return {
    id,
    styleId: lastSegment(id),
    title: child(info, "title")?.text ?? "",
    updated: child(info, "updated")?.text ?? "",
    ...(category ? { citationFormat: category.attrs["citation-format"] as string } : {}),
    hasRights: childrenNamed(info, "rights").length > 0,
    independentParent: childrenNamed(info, "link").some(
      (link) => link.attrs.rel === "independent-parent",
    ),
  };
}

export interface InspectOptions {
  /** Workspace styles: the file stem the id must match. Omit for shipped styles. */
  stem?: string;
  /** Ids (and file stems) of shipped styles, which a workspace style may not shadow. */
  shipped?: ReadonlySet<string>;
}

export interface Inspected {
  issues: CslIssue[];
  info?: CslInfo;
}

/** CSL-001: structural validation of a style file. */
export function inspectCsl(text: string, options: InspectOptions = {}): Inspected {
  const issues: CslIssue[] = [];
  const add = (message: string, hint?: string) =>
    issues.push({ code: "CSL-001", message, ...(hint ? { hint } : {}) });
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    if (error instanceof XmlError) {
      add(
        `Not a safe, well-formed CSL file: ${error.message}`,
        /DOCTYPE|ENTITY|Entity/.test(error.message)
          ? "Remove the DOCTYPE and entity declarations; styles may not declare a DTD."
          : undefined,
      );
      return { issues };
    }
    throw error;
  }
  if (root.name !== "style") add(`The root element must be <style>, found <${root.name}>`);
  if (root.attrs.xmlns !== cslNamespace)
    add(`The root element must declare xmlns="${cslNamespace}"`);
  if (root.attrs.version !== "1.0") add('The root element must have version="1.0" (CSL 1.0.2)');
  const info = readInfo(root);
  if (!info) {
    add("The style has no <info> block");
    return { issues };
  }
  if (!info.id) add("<info> needs an <id>");
  if (!info.title) add("<info> needs a <title>");
  if (!info.updated) add("<info> needs an <updated> timestamp");
  if (!info.hasRights) add("<info> needs a <rights> notice (license of the style)");
  if (!child(root, "citation")) add("The style has no <citation> block");
  if (!child(root, "bibliography")) add("The style has no <bibliography> block");

  if (options.stem !== undefined) {
    if (!styleIdPattern.test(options.stem)) {
      add(
        `The file name "${options.stem}.csl" is not a valid style id (lowercase letters, digits and hyphens)`,
      );
    }
    if (info.id && info.styleId !== options.stem) {
      add(
        `<info><id> ends in "${info.styleId}" but the file is ${options.stem}.csl; they must match`,
        `Use <id>${options.stem}</id> or an id URL ending in /${options.stem}.`,
      );
    }
    if (options.shipped?.has(options.stem) || (info.id && options.shipped?.has(info.styleId))) {
      add(`The id "${options.stem}" shadows a style shipped with the plugin; choose another id`);
    }
    if (info.independentParent) {
      add(
        'Workspace styles may not use <link rel="independent-parent">; make the style self-contained',
      );
    }
  }
  let external = 0;
  walkXml(root, (node) => {
    if (node.name === "link" && node.attrs.rel === "independent-parent") external += 1;
  });
  if (external > 0 && options.stem === undefined) {
    // Shipped styles are independent as well; a dependent style cannot be loaded offline.
    add('A shipped style may not be dependent (<link rel="independent-parent">)');
  }
  return { issues, info };
}

// ---------------------------------------------------------------------------------------------
// Shipped catalog
// ---------------------------------------------------------------------------------------------

export interface CatalogEntry {
  id: string;
  title: string;
  /** File name inside the package `styles/` folder. */
  file: string;
  provisional: boolean;
  citationFormat: "author-date" | "numeric" | "note" | "label";
  /** Evidence types the style has no source for; they fall back to the closest type (CSL-021). */
  fallbackTypes?: string[];
  source: { url: string; license: string; retrieved: string; basis?: string };
}

export interface ShippedStyle extends CatalogEntry {
  text: string;
}

let catalog: CatalogEntry[] | undefined;

export function loadCatalog(): CatalogEntry[] {
  catalog ??= (
    JSON.parse(readFileSync(packagePath("styles", "catalog.json"), "utf8")) as {
      styles: CatalogEntry[];
    }
  ).styles;
  return catalog;
}

export function shippedStyleIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of loadCatalog()) {
    ids.add(entry.id);
    ids.add(entry.file.replace(/\.csl$/, ""));
  }
  return ids;
}

export function readShippedStyle(id: string): ShippedStyle | undefined {
  const entry = loadCatalog().find((candidate) => candidate.id === id);
  if (!entry) return undefined;
  return { ...entry, text: readFileSync(packagePath("styles", entry.file), "utf8") };
}
