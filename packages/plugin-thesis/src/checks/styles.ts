import { parseLibraryText } from "../research/library.js";
import { inspectCsl, loadCatalog, shippedStyleIds } from "../styles/csl.js";
import { resolveCitationStyle } from "../styles/discovery.js";
import { resolveWorkspaceProfile } from "../styles/profile.js";
import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

/**
 * Workspace styles and profiles, and the notes about the selected citation style (spec 9.2 and
 * 10.4.1): CSL-001 (style structure, DOCTYPE/entity guard, id rules, no shadowing), PRF-001
 * (profile schema), CSL-020 (provisional style selected) and CSL-021 (types without a source).
 * CSL-010 needs the Typst engine and is run by `style check` and by the build (`styles/golden.ts`).
 */

export type StyleScope = "all" | "selected";

export function styleFindings(project: LoadedProject, scope: StyleScope = "all"): Finding[] {
  const findings: Finding[] = [];
  const brief = project.brief?.brief;
  const selectedStyle = project.profile?.citationStyle.value ?? brief?.citationStyle;
  const selectedStandard = project.profile?.presentationStandard.value;
  const shipped = shippedStyleIds();

  for (const style of project.styleFiles) {
    if (scope === "selected" && style.id !== selectedStyle) continue;
    for (const issue of inspectCsl(style.text, { stem: style.id, shipped }).issues) {
      findings.push({
        code: issue.code,
        gate: "G0",
        severity: "error",
        file: style.file,
        message: issue.message,
        ...(issue.hint ? { hint: issue.hint } : {}),
      });
    }
  }
  for (const profile of project.profileFiles) {
    if (scope === "selected" && profile.id !== selectedStandard) continue;
    for (const issue of resolveWorkspaceProfile(profile).issues) {
      findings.push({
        code: issue.code,
        gate: "G0",
        severity: "error",
        file: profile.file,
        message: `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
      });
    }
  }

  const resolved = selectedStyle
    ? resolveCitationStyle(selectedStyle, project.styleFiles).style
    : undefined;
  if (resolved?.provisional) {
    findings.push({
      code: "CSL-020",
      gate: "G0",
      severity: "warning",
      message: `The citation style "${resolved.title}" is provisional: only one source documents its citation and reference format`,
      hint: "Confirm the result with your program, or drop a program-approved style into thesis/styles/ and select it.",
    });
    const fallback = new Set(
      (resolved.source === "shipped" ? (shippedFallback(resolved.id) ?? []) : []) as string[],
    );
    if (fallback.size > 0) {
      const records = parseLibraryText(project.libraryText).records.filter(
        (record) => record.status !== "REJECTED" && fallback.has(record.type),
      );
      if (records.length > 0) {
        findings.push({
          code: "CSL-021",
          gate: "G0",
          severity: "warning",
          message: `${records.length} ${[...fallback].join("/")} reference(s) have no format in the "${resolved.title}" style and use the closest type`,
          hint: "Check how those references print and correct them by hand if your program requires another format.",
        });
      }
    }
  }
  return findings;
}

const shippedFallback = (id: string): string[] | undefined =>
  loadCatalog().find((entry) => entry.id === id)?.fallbackTypes;

export const checkStyles = (project: LoadedProject): Finding[] => styleFindings(project, "all");
