import { type Blueprint, blueprintTotal } from "./blueprint.js";
import type { ExamItem } from "./generate.js";
import type { CheckFinding } from "./knowledge/report.js";
import type { ItemType } from "./types.js";

export interface ExamCheckInput {
  items: readonly ExamItem[];
  blueprint: Blueprint;
  questionCount: number;
  itemTypes: Record<ItemType, number>;
  mode: "same" | "bank";
  /** In `same` mode, the ids of the previously frozen list (identity check). */
  frozenIds?: readonly string[];
}

function finding(id: string, subject: string, message: string): CheckFinding {
  return { id, severity: "error", subject, message };
}

/** Exam-level deterministic checks (EVL-EXM-001..004). */
export function verifyExam(input: ExamCheckInput): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const typeTotal = Object.values(input.itemTypes).reduce((acc, count) => acc + count, 0);
  if (typeTotal !== input.questionCount) {
    findings.push(
      finding(
        "EVL-EXM-001",
        "exam",
        `item type counts sum to ${typeTotal}, not questionCount ${input.questionCount}`,
      ),
    );
  }
  if (blueprintTotal(input.blueprint) !== input.questionCount) {
    findings.push(
      finding(
        "EVL-EXM-001",
        "blueprint",
        `blueprint sums to ${blueprintTotal(input.blueprint)}, not ${input.questionCount}`,
      ),
    );
  }

  const refs = input.items.map((item) => item.ref);
  if (refs.some((ref) => ref === "") || new Set(refs).size !== refs.length) {
    findings.push(finding("EVL-EXM-002", "exam", "a reference is missing or duplicated"));
  }
  if (input.items.length !== input.questionCount) {
    findings.push(
      finding(
        "EVL-EXM-002",
        "exam",
        `the exam has ${input.items.length} items, not the consecutive 1..${input.questionCount}`,
      ),
    );
  }

  const actual = new Map<string, number>();
  for (const item of input.items) {
    const key = `${item.topic}|${item.cognitive}|${item.type}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const cell of input.blueprint.cells) {
    const key = `${cell.topic}|${cell.cognitive}|${cell.type}`;
    const count = actual.get(key) ?? 0;
    if (Math.abs(count - cell.count) > 1) {
      findings.push(
        finding(
          "EVL-EXM-004",
          cell.topic,
          `cell ${cell.cognitive}/${cell.type} has ${count} items, blueprint expects ${cell.count}`,
        ),
      );
    }
  }

  if (input.mode === "same" && input.frozenIds !== undefined) {
    const ids = input.items.map((item) => item.id);
    if (ids.join("|") !== input.frozenIds.join("|")) {
      findings.push(finding("EVL-EXM-003", "exam", "the item list differs from the frozen list"));
    }
  }
  return findings;
}
