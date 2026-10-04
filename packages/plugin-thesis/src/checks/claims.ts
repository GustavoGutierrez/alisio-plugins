import { parseClaimsText } from "../claims.js";
import { allBlockLists, allSections, walkBlocks } from "../render/walk.js";
import { parseLibraryText } from "../research/library.js";
import type { ClaimRecord, Finding } from "../types.js";
import { documentOf } from "./document.js";
import { protocolObjectives } from "./outline.js";
import type { LoadedProject } from "./project.js";

const file = "claims/claims.jsonl";

/** Approaches that argue from the literature rather than from measured results (CLM-003). */
const literatureApproaches = new Set(["theoretical", "systematic_review"]);

interface Anchor {
  anchor: string;
  file: string;
  line: number | undefined;
  section: string | undefined;
}

/** Claim anchors found in the chapters with the section their file declares. */
export function anchorsOf(project: LoadedProject): Anchor[] {
  const assembled = documentOf(project);
  if (!assembled) return [];
  const doc = assembled.document;
  const sectionOfFile = new Map(allSections(doc).map((section) => [section.path, section.section]));
  const found: Anchor[] = [];
  for (const { file: path, blocks } of allBlockLists(doc)) {
    walkBlocks(blocks, (block) => {
      if (block.kind === "paragraph" && block.claim !== undefined && path !== undefined)
        found.push({
          anchor: block.claim,
          file: path,
          line: block.line,
          section: sectionOfFile.get(path),
        });
    });
  }
  return found;
}

const finding = (
  code: string,
  gate: Finding["gate"],
  message: string,
  extra: Partial<Finding> = {},
): Finding => ({ code, gate, severity: "error", message, ...extra });

/** G3: CLM-001 to CLM-003. */
export function checkClaims(project: LoadedProject): Finding[] {
  const parsed = parseClaimsText(project.claimsText);
  const findings: Finding[] = parsed.errors.map((error) =>
    finding("CLM-001", "G3", error.message, { file, line: error.line }),
  );
  const anchors = anchorsOf(project);
  const records = parsed.records;
  if (records.length === 0 && anchors.length === 0 && findings.length === 0) return findings;

  const ids = new Map<string, number>();
  const pairs = new Map<string, ClaimRecord>();
  for (const record of records) {
    ids.set(record.id, (ids.get(record.id) ?? 0) + 1);
    const pair = `${record.section}|${record.anchor}`;
    if (pairs.has(pair))
      findings.push(
        finding(
          "CLM-001",
          "G3",
          `Claim anchor ${record.anchor} of ${record.section} is recorded twice`,
          {
            file,
            section: record.section,
          },
        ),
      );
    else pairs.set(pair, record);
  }
  for (const [id, count] of ids)
    if (count > 1)
      findings.push(finding("CLM-001", "G3", `Claim id ${id} appears ${count} times`, { file }));

  // Anchors in the text -> a record, and a record -> an anchor in the text (both ways).
  const seenAnchors = new Set<string>();
  for (const anchor of anchors) {
    const base = {
      file: anchor.file,
      ...(anchor.line === undefined ? {} : { line: anchor.line }),
      ...(anchor.section === undefined ? {} : { section: anchor.section }),
    };
    if (anchor.section === undefined) {
      findings.push(
        finding(
          "CLM-001",
          "G3",
          `Claim anchor ${anchor.anchor} is in a file that declares no section`,
          {
            ...base,
            hint: "Add `section: SEC-xx` to the chapter's front matter.",
          },
        ),
      );
      continue;
    }
    const pair = `${anchor.section}|${anchor.anchor}`;
    if (seenAnchors.has(pair))
      findings.push(
        finding(
          "CLM-001",
          "G3",
          `Claim anchor ${anchor.anchor} appears twice in ${anchor.section}`,
          base,
        ),
      );
    seenAnchors.add(pair);
    if (!pairs.has(pair))
      findings.push(
        finding(
          "CLM-001",
          "G3",
          `Claim anchor ${anchor.anchor} has no record in claims/claims.jsonl`,
          {
            ...base,
            hint: "Anchors and claims are created together by /thesis:draft.",
          },
        ),
      );
  }
  for (const record of records) {
    if (!seenAnchors.has(`${record.section}|${record.anchor}`))
      findings.push(
        finding(
          "CLM-001",
          "G3",
          `${record.id} (${record.section}, anchor ${record.anchor}) has no anchor in the text`,
          {
            file,
            section: record.section,
          },
        ),
      );
  }

  // CLM-002: claims cite existing evidence; background and argument claims need some.
  const library = new Map(parseLibraryText(project.libraryText).records.map((r) => [r.id, r]));
  for (const record of records) {
    for (const id of record.evidence)
      if (!library.has(id))
        findings.push(
          finding(
            "CLM-002",
            "G3",
            `${record.id} cites evidence ${id}, which is not in the library`,
            {
              file,
              section: record.section,
            },
          ),
        );
    if (
      (record.kind === "background" || record.kind === "argument") &&
      record.evidence.length === 0
    )
      findings.push(
        finding("CLM-002", "G3", `${record.id} is a ${record.kind} claim without evidence`, {
          file,
          section: record.section,
          hint: "Cite a verified source, or turn the statement into a gap.",
        }),
      );
  }

  // CLM-003: a conclusion traces to results (or, for literature approaches, to arguments too).
  const byId = new Map(records.map((record) => [record.id, record]));
  const approach = project.brief?.brief?.approach;
  const traceable = literatureApproaches.has(approach ?? "") ? ["result", "argument"] : ["result"];
  for (const record of records) {
    if (record.kind !== "conclusion") continue;
    const cited = (record.results ?? []).map((id) => byId.get(id));
    const unknown = (record.results ?? []).filter((id) => !byId.has(id));
    for (const id of unknown)
      findings.push(
        finding("CLM-003", "G3", `${record.id} rests on ${id}, which is not a recorded claim`, {
          file,
          section: record.section,
        }),
      );
    if (!cited.some((entry) => entry !== undefined && traceable.includes(entry.kind)))
      findings.push(
        finding(
          "CLM-003",
          "G3",
          `Conclusion ${record.id} does not rest on any ${traceable.join(" or ")} claim`,
          {
            file,
            section: record.section,
            hint: "A conclusion must follow from results: list the result claims it rests on, or state the result first.",
          },
        ),
      );
  }
  return findings;
}

/** G10: CLM-004, every objective is reached by at least one result or conclusion claim. */
export function checkObjectivesReached(project: LoadedProject): Finding[] {
  if (project.protocolText === undefined) return [];
  const objectives = protocolObjectives(project.protocolText).allObjectiveIds ?? [];
  if (objectives.length === 0) return [];
  const phase = project.state?.phase;
  if (phase !== "review" && phase !== "final" && phase !== "submitted") return [];
  const reached = new Set(
    parseClaimsText(project.claimsText)
      .records.filter((record) => record.kind === "result" || record.kind === "conclusion")
      .flatMap((record) => record.objectives),
  );
  return objectives
    .filter((id) => !reached.has(id))
    .map((id) =>
      finding(
        "CLM-004",
        "G10",
        `Objective ${id} is not reached by any result or conclusion claim`,
        {
          file,
          hint: "Write a result or conclusion claim for it (objectives field of the claim), or revise the section that should answer it.",
        },
      ),
    );
}
