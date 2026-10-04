import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

// Absolute local-machine paths: POSIX home/temp roots and Windows drive paths.
const pathPatterns = [
  /(?<![\w.:/-])\/(?:home|Users|root|tmp|private\/var|var\/folders)\/[^\s"'`)\]}<>,;]+/g,
  /(?<![A-Za-z0-9])[A-Za-z]:\\[^\s"'`)\]}<>,;]+/g,
  /(?<![A-Za-z0-9])[A-Za-z]:\/(?:Users|Documents and Settings)\/[^\s"'`)\]}<>,;]+/g,
];

function scan(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of pathPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push({
          code: "HYG-001",
          gate: "G7",
          severity: "error",
          file,
          line: index + 1,
          message: "Absolute local path found; it leaks the author's machine layout",
          hint: "Use workspace-relative paths such as figures/charts/x.vl.json.",
        });
        break;
      }
    }
  });
  return findings;
}

/** G7 (path-leak part of HYG-001): no absolute local paths in the brief or the chapters. */
export function checkHygiene(project: LoadedProject): Finding[] {
  const findings: Finding[] = [];
  if (project.briefText !== undefined) findings.push(...scan("thesis.yaml", project.briefText));
  for (const chapter of project.chapters) findings.push(...scan(chapter.path, chapter.content));
  return findings;
}
