import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedProject } from "../checks/project.js";
import { packagePath } from "../package-paths.js";
import { resolveTypst, runTypst } from "../render/adapters/typst-pdf/runner.js";
import { shippedStrings, typeLabels } from "../render/assemble.js";
import { bibtexEntry } from "../research/bibtex.js";
import { canonicalJson } from "../storage.js";
import type { EvidenceRecord, Finding } from "../types.js";
import { type ResolvedCitationStyle, resolveCitationStyle } from "./discovery.js";

/**
 * Golden renderings of a citation style (CSL-010, spec 9.2 and 10.4.1). Eight fixture references
 * (journal article, book, chapter, thesis, law, standard, web page, dataset) are cited once each
 * and listed in a bibliography with the style; the rendered text is compared byte for byte with
 * `styles/fixtures/<id>.expected.json`. The engine is Typst (its CSL processor is the one the
 * thesis build uses), read through its HTML export. Without an engine the check is skipped with a
 * warning. This module depends on the Typst adapter on purpose: the golden text is engine output.
 */

export const fixtureKeys = [
  "journal",
  "book",
  "chapter",
  "thesis",
  "law",
  "standard",
  "webpage",
  "dataset",
] as const;

export interface GoldenExpected {
  version: 1;
  styleId: string;
  /** BCP-47 language the fixtures were rendered in. */
  lang: string;
  /** In-text citation (a footnote text for note styles) of each fixture, cited with `p. 12`. */
  citations: Record<string, string>;
  /** Reference list entry of each fixture. */
  bibliography: Record<string, string>;
}

export function loadFixtureRecords(): EvidenceRecord[] {
  const text = readFileSync(packagePath("styles", "fixtures", "references.jsonl"));
  return text
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EvidenceRecord);
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Plain text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function htmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (match, body: string) => {
      if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
      return entities[body] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The citation text and the first reference entry of one fixture document's HTML export. */
export function extractRendered(html: string): { citation: string; entry: string } {
  const notes = /<section role="doc-endnotes"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  let citation: string;
  if (notes) {
    const item = /<li[^>]*>([\s\S]*?)<\/li>/.exec(notes[1] as string);
    citation = htmlText((item?.[1] ?? "").replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, ""));
  } else {
    const paragraph = /<p>CITE:([\s\S]*?)<\/p>/.exec(html);
    citation = htmlText(paragraph?.[1] ?? "");
  }
  const bibliography = /<section role="doc-bibliography"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  const entry = /<li[^>]*>([\s\S]*?)<\/li>/.exec(bibliography?.[1] ?? "");
  return { citation, entry: htmlText(entry?.[1] ?? "") };
}

export interface RenderFixturesOptions {
  binary: string;
  lang?: string;
  env?: NodeJS.ProcessEnv;
}

/** Render the eight fixtures with a style. Throws when Typst fails. */
export async function renderStyleFixtures(
  style: Pick<ResolvedCitationStyle, "id" | "text">,
  options: RenderFixturesOptions,
): Promise<GoldenExpected> {
  const lang = options.lang ?? "es";
  const records = loadFixtureRecords();
  const labels = typeLabels(
    shippedStrings(lang.split("-")[0] ?? "en") ?? shippedStrings("en") ?? {},
  );
  const directory = await mkdtemp(join(tmpdir(), "thesis-csl-"));
  const packageCache = join(directory, ".pkgs");
  const citations: Record<string, string> = {};
  const bibliography: Record<string, string> = {};
  try {
    await mkdir(packageCache, { recursive: true });
    await writeFile(join(directory, "style.csl"), style.text);
    for (const key of fixtureKeys) {
      const record = records.find((entry) => entry.citeKey === key);
      if (!record) throw new Error(`Fixture ${key} is missing`);
      await writeFile(join(directory, "refs.bib"), bibtexEntry(record, labels));
      await writeFile(
        join(directory, "main.typ"),
        `#set text(lang: "${lang.split("-")[0]}"${lang.includes("-") ? `, region: "${lang.split("-")[1]?.toLowerCase()}"` : ""})\nCITE: #cite(<${key}>, supplement: [p. 12])\n\n#bibliography("refs.bib", style: "/style.csl", title: none)\n`,
      );
      const outcome = await runTypst({
        binary: options.binary,
        buildDir: directory,
        packageCache,
        packagePath: packagePath("typst-packages"),
        input: "main.typ",
        output: "out.html",
        html: true,
        env: options.env ?? process.env,
      });
      if (outcome.code !== 0) {
        throw new Error(
          `Typst could not render the fixture "${key}": ${outcome.stderr.trim().split("\n")[0] ?? "error"}`,
        );
      }
      const rendered = extractRendered(await readFile(join(directory, "out.html"), "utf8"));
      citations[key] = rendered.citation;
      bibliography[key] = rendered.entry;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { version: 1, styleId: style.id, lang, citations, bibliography };
}

export const goldenText = (expected: GoldenExpected): string => canonicalJson(expected);

/** Differences between the approved and the fresh rendering, one line each. */
export function diffGolden(expected: GoldenExpected, actual: GoldenExpected): string[] {
  const diffs: string[] = [];
  for (const group of ["citations", "bibliography"] as const) {
    for (const key of fixtureKeys) {
      const want = expected[group][key];
      const got = actual[group][key];
      if (want !== got) {
        diffs.push(
          `${group}.${key}: expected ${JSON.stringify(want ?? null)} but got ${JSON.stringify(got ?? null)}`,
        );
      }
    }
  }
  return diffs;
}

export interface FixtureCheckOptions {
  env: NodeJS.ProcessEnv;
  cacheRoot: string;
  /** Limit the check to one style id. */
  only?: string;
}

/**
 * CSL-010 for the workspace styles: render and compare. Styles without approved fixtures yield an
 * info finding; without an engine the whole check is skipped with one warning.
 */
export async function styleFixtureFindings(
  project: LoadedProject,
  options: FixtureCheckOptions,
): Promise<Finding[]> {
  const styles = project.styleFiles.filter((style) => !options.only || style.id === options.only);
  if (styles.length === 0) return [];
  const findings: Finding[] = [];
  const engine = await resolveTypst(options.env, options.cacheRoot);
  const withFixtures = styles.filter((style) => project.styleFixtures[style.id] !== undefined);
  for (const style of styles) {
    if (project.styleFixtures[style.id] === undefined) {
      findings.push({
        code: "CSL-010",
        gate: "G0",
        severity: "info",
        file: style.file,
        message: `Style ${style.id} has no approved fixtures (styles/fixtures/${style.id}.expected.json); its rendering is not checked`,
        hint: "Approve its fixtures with /thesis:style new, or add the expected file by hand.",
      });
    }
  }
  if (withFixtures.length === 0) return findings;
  if (!engine.available) {
    findings.push({
      code: "CSL-010",
      gate: "G0",
      severity: "warning",
      message: `The golden renderings of ${withFixtures.length} workspace style(s) were not checked: ${engine.reason}`,
      ...(engine.hint ? { hint: engine.hint } : {}),
    });
    return findings;
  }
  for (const style of withFixtures) {
    const resolved = resolveCitationStyle(style.id, project.styleFiles);
    if (!resolved.style) continue; // CSL-001 already reports it
    let expected: GoldenExpected;
    try {
      expected = JSON.parse(project.styleFixtures[style.id] as string) as GoldenExpected;
      if (expected.version !== 1 || typeof expected.citations !== "object")
        throw new Error("shape");
    } catch {
      findings.push({
        code: "CSL-010",
        gate: "G0",
        severity: "error",
        file: `styles/fixtures/${style.id}.expected.json`,
        message: "The expected fixtures file is not valid",
      });
      continue;
    }
    try {
      const actual = await renderStyleFixtures(resolved.style, {
        binary: engine.path as string,
        lang: expected.lang,
        env: options.env,
      });
      const diffs = diffGolden(expected, actual);
      if (diffs.length > 0) {
        findings.push({
          code: "CSL-010",
          gate: "G0",
          severity: "error",
          file: style.file,
          message: `Style ${style.id} no longer renders its approved fixtures: ${diffs[0]}${diffs.length > 1 ? ` (+${diffs.length - 1} more)` : ""}`,
          hint: "Review the change and approve new fixtures, or restore the style.",
        });
      }
    } catch (error) {
      findings.push({
        code: "CSL-010",
        gate: "G0",
        severity: "error",
        file: style.file,
        message: `Style ${style.id} could not render its fixtures: ${(error as Error).message}`,
      });
    }
  }
  return findings;
}
