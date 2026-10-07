import type { Family, ItemDraft } from "./families/types.js";
import type { ExamItem } from "./generate.js";
import type { CheckFinding } from "./knowledge/report.js";
import type { LevelCalibration } from "./knowledge/types.js";
import type { Level } from "./types.js";

const forbiddenPattern = /(todas|ninguna)\s+(las|de las)\s+anteriores/i;

function finding(id: string, subject: string, message: string): CheckFinding {
  return { id, severity: "error", subject, message };
}

/** Structural and calibration checks on a generated draft (EVL-ITM-001..010). */
export function verifyDraft(
  draft: ItemDraft,
  family: Family,
  level: Level,
  calibration: LevelCalibration,
): CheckFinding[] {
  const subject = `${family.id}/${level}`;
  const findings: CheckFinding[] = [];
  if (String(family.solve(draft.problem)) !== draft.answer.canonical) {
    findings.push(
      finding("EVL-ITM-004", subject, "the recomputed answer differs from the stored key"),
    );
  }
  if (draft.options.length !== 0) {
    const correct = draft.options.filter((option) => option.correct).length;
    if (draft.type === "single_choice" && correct !== 1) {
      findings.push(
        finding("EVL-ITM-001", subject, "single_choice must have exactly one correct option"),
      );
    }
    if (draft.type === "multiple_choice" && (correct < 2 || correct === draft.options.length)) {
      findings.push(
        finding(
          "EVL-ITM-002",
          subject,
          "multiple_choice needs at least two correct and one incorrect option",
        ),
      );
    }
    const values = draft.options.map((option) => option.value);
    if (new Set(values).size !== values.length) {
      findings.push(
        finding("EVL-ITM-003", subject, "two options are equivalent after canonicalization"),
      );
    }
    if (draft.options.some((option) => forbiddenPattern.test(option.display))) {
      findings.push(
        finding("EVL-ITM-007", subject, "forbidden option text (todas/ninguna las anteriores)"),
      );
    }
  }
  for (const value of draft.numericValues) {
    if (value < calibration.coefficientRange[0] || value > calibration.coefficientRange[1]) {
      findings.push(
        finding("EVL-ITM-006", subject, `coefficient ${value} is outside the level range`),
      );
      break;
    }
  }
  if (draft.stepCount < calibration.steps[0] || draft.stepCount > calibration.steps[1]) {
    findings.push(
      finding(
        "EVL-ITM-006",
        subject,
        `solution has ${draft.stepCount} steps, outside the level bounds`,
      ),
    );
  }
  if (draft.solution.length === 0 || draft.answer.canonical === "") {
    findings.push(finding("EVL-ITM-008", subject, "missing solution steps or answer"));
  }
  return findings;
}

/** Structural checks on a frozen item (EVL-ITM-001, 002, 003, 007, 008, 010). */
export function verifyItem(item: ExamItem): CheckFinding[] {
  const subject = item.ref || item.id;
  const findings: CheckFinding[] = [];
  if (item.options.length > 0) {
    const correct = item.options.filter((option) => option.correct).length;
    if (item.type === "single_choice" && correct !== 1) {
      findings.push(
        finding("EVL-ITM-001", subject, "single_choice must have exactly one correct option"),
      );
    }
    if (item.type === "multiple_choice" && (correct < 2 || correct === item.options.length)) {
      findings.push(
        finding(
          "EVL-ITM-002",
          subject,
          "multiple_choice needs at least two correct and one incorrect option",
        ),
      );
    }
    const values = item.options.map((option) => option.value);
    if (new Set(values).size !== values.length) {
      findings.push(
        finding("EVL-ITM-003", subject, "two options are equivalent after canonicalization"),
      );
    }
    if (item.options.some((option) => forbiddenPattern.test(option.display))) {
      findings.push(
        finding("EVL-ITM-007", subject, "forbidden option text (todas/ninguna las anteriores)"),
      );
    }
  }
  if (item.solution.length === 0 || item.answer.canonical === "") {
    findings.push(finding("EVL-ITM-008", subject, "missing solution steps or answer"));
  }
  if (item.ref === "" || item.level === undefined) {
    findings.push(finding("EVL-ITM-008", subject, "missing reference or level"));
  }
  if (item.source === "authored" && item.check.kind === "none") {
    findings.push(finding("EVL-ITM-010", subject, "authored item without a machine-checkable key"));
  }
  return findings;
}

/** Key distribution across the choice items of one exam (EVL-ITM-007). */
export function checkKeyDistribution(items: readonly ExamItem[]): CheckFinding[] {
  const choice = items.filter((item) => item.type === "single_choice");
  if (choice.length === 0) return [];
  const counts = new Map<string, number>();
  for (const item of choice) {
    const key = item.options.find((option) => option.correct)?.key ?? "?";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const limit = Math.ceil(choice.length / 2);
  const findings: CheckFinding[] = [];
  for (const [key, count] of counts) {
    if (count > limit) {
      findings.push(
        finding(
          "EVL-ITM-007",
          `exam keys`,
          `key ${key} is used ${count} times, more than ${limit}`,
        ),
      );
    }
  }
  let run = 1;
  for (let index = 1; index < choice.length; index += 1) {
    const previous = choice[index - 1]?.options.find((option) => option.correct)?.key;
    const current = choice[index]?.options.find((option) => option.correct)?.key;
    run = previous === current ? run + 1 : 1;
    if (run > 2) {
      findings.push(finding("EVL-ITM-007", "exam keys", "three adjacent items share the same key"));
      break;
    }
  }
  return findings;
}
