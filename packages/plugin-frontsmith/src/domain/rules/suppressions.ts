import type { Severity } from "../severity.js";

/** Inline suppression (spec 13.5): `frontsmith-disable-next-line <ruleId> -- <reason>`. */
export interface Suppression {
  ruleId: string;
  reason: string;
  /** The line the suppression applies to: the line after the comment ends. */
  line: number;
  valid: boolean;
  problem?: string;
}

const MIN_REASON = 10;
const DIRECTIVE =
  /^frontsmith-disable-next-line\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:\s+--\s+([\s\S]*))?$/;

export interface CommentLike {
  text: string;
  line: number;
}

/** Parse suppression directives from comment bodies (delimiters already removed). */
export function parseSuppressions(comments: readonly CommentLike[]): Suppression[] {
  const found: Suppression[] = [];
  for (const comment of comments) {
    const match = DIRECTIVE.exec(comment.text.trim());
    if (!match) continue;
    const newlines =
      comment.text.trimEnd().split("\n").length -
      1 +
      (comment.text.length - comment.text.trimEnd().length > 0
        ? comment.text.slice(comment.text.trimEnd().length).split("\n").length - 1
        : 0);
    const reason = (match[2] ?? "").trim();
    const line = comment.line + newlines + 1;
    if (reason.length < MIN_REASON)
      found.push({
        ruleId: match[1] as string,
        reason,
        line,
        valid: false,
        problem: `a reason of at least ${MIN_REASON} characters is required`,
      });
    else found.push({ ruleId: match[1] as string, reason, line, valid: true });
  }
  return found;
}

export type SuppressionOutcome =
  | { status: "none" }
  | { status: "honoured"; reason: string }
  | { status: "ignored"; reason: string };

/**
 * Decide what a suppression does to one finding. It only works for the next line, for a
 * suppressible rule and for minor or nit severity; otherwise it is ignored and the finding stays.
 */
export function suppressionFor(
  finding: { ruleId: string; line: number },
  rule: { id: string; severity: Severity; suppressible: boolean },
  suppressions: readonly Suppression[],
): SuppressionOutcome {
  const match = suppressions.find((s) => s.ruleId === finding.ruleId && s.line === finding.line);
  if (!match) return { status: "none" };
  if (!match.valid) return { status: "ignored", reason: match.problem ?? "invalid suppression" };
  if (!rule.suppressible) return { status: "ignored", reason: `${rule.id} is not suppressible` };
  if (rule.severity !== "minor" && rule.severity !== "nit")
    return { status: "ignored", reason: "only minor and nit rules can be suppressed" };
  return { status: "honoured", reason: match.reason };
}
