import { formatReport, type LoadedProject } from "./checks/index.js";
import { styleFindings } from "./checks/styles.js";
import { inspectCsl, loadCatalog, shippedStyleIds } from "./styles/csl.js";
import { styleFixtureFindings } from "./styles/golden.js";
import { resolveWorkspaceProfile, shippedProfileIds } from "./styles/profile.js";
import type { CheckReport, Finding } from "./types.js";

/** `/thesis:style list|check` and the CLI `style` command (spec 10.4.1). */

export function listStyles(project: LoadedProject): string {
  const selectedStyle = project.profile?.citationStyle.value ?? project.brief?.brief?.citationStyle;
  const selectedStandard = project.profile?.presentationStandard.value;
  const mark = (selected: boolean) => (selected ? " [selected]" : "");
  const shipped = shippedStyleIds();
  const lines = ["Citation styles:"];
  for (const entry of loadCatalog()) {
    lines.push(
      `- ${entry.id}: ${entry.title}, ${entry.citationFormat}${entry.provisional ? ", provisional" : ""}, shipped${mark(entry.id === selectedStyle)}`,
    );
  }
  for (const style of project.styleFiles) {
    const { issues, info } = inspectCsl(style.text, { stem: style.id, shipped });
    lines.push(
      `- ${style.id}: ${info?.title || "(untitled)"}${info?.citationFormat ? `, ${info.citationFormat}` : ""}, workspace${issues.length > 0 ? `, INVALID (${issues.length} CSL-001 problem(s))` : ""}${project.styleFixtures[style.id] ? ", with fixtures" : ""}${mark(style.id === selectedStyle)}`,
    );
  }
  lines.push("", "Presentation profiles:");
  for (const id of shippedProfileIds()) {
    lines.push(`- ${id}: shipped${mark(id === selectedStandard)}`);
  }
  for (const profile of project.profileFiles) {
    const { issues, profile: resolved } = resolveWorkspaceProfile(profile);
    lines.push(
      `- ${profile.id}: workspace${resolved ? `, extends ${resolved.extends ?? "none"}` : ""}${issues.length > 0 ? `, INVALID (${issues.length} PRF-001 problem(s))` : ""}${mark(profile.id === selectedStandard)}`,
    );
  }
  return lines.join("\n");
}

export interface StyleCheckResult {
  report: CheckReport;
  text: string;
}

/** Static style findings plus the golden CSL-010 renderings (skipped with a warning without Typst). */
export async function checkStyleFiles(
  project: LoadedProject,
  options: { env: NodeJS.ProcessEnv; cacheRoot: string; now?: () => Date },
): Promise<StyleCheckResult> {
  const findings: Finding[] = [
    ...styleFindings(project, "all"),
    ...(await styleFixtureFindings(project, { env: options.env, cacheRoot: options.cacheRoot })),
  ];
  const order = { error: 0, warning: 1, info: 2 } as const;
  findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.file ?? "").localeCompare(b.file ?? ""),
  );
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const report: CheckReport = {
    at: (options.now ?? (() => new Date()))().toISOString(),
    ok: counts.error === 0,
    counts,
    findings,
  };
  const summary =
    project.styleFiles.length + project.profileFiles.length === 0
      ? "No workspace styles or profiles (thesis/styles/ is empty)."
      : `${project.styleFiles.length} workspace style(s), ${project.profileFiles.length} workspace profile(s).`;
  return { report, text: `${formatReport(report)}\n${summary}` };
}
