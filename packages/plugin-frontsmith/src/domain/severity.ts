/** Finding severity, shared by rules and reviewers (spec 10.1). Index 0 is the most severe. */
export const severities = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof severities)[number];

export const isSeverity = (value: unknown): value is Severity =>
  typeof value === "string" && (severities as readonly string[]).includes(value);

/** Negative when `a` is more severe than `b`. */
export const compareSeverity = (a: Severity, b: Severity): number =>
  severities.indexOf(a) - severities.indexOf(b);

/** True when `severity` is at least as severe as `minimum`. */
export const atLeastSeverity = (severity: Severity, minimum: Severity): boolean =>
  compareSeverity(severity, minimum) <= 0;
