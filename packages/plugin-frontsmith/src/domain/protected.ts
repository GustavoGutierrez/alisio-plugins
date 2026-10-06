/** Digests of the protected set, by key (spec 8.5). */
export type ProtectedSnapshot = Record<string, string>;

export interface ProtectedChange {
  key: string;
  kind: "added" | "removed" | "modified";
}

/** Keys that only inform (the lockfile hash) and never raise FS-GOV-001. */
const informational = (key: string): boolean => key.startsWith("info:");

/** Everything that differs between two snapshots, sorted by key; informational keys are ignored. */
export function diffSnapshots(
  before: ProtectedSnapshot,
  after: ProtectedSnapshot,
): ProtectedChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !informational(key))
    .sort();
  const changes: ProtectedChange[] = [];
  for (const key of keys) {
    const was = before[key];
    const now = after[key];
    if (was === now) continue;
    changes.push({
      key,
      kind: was === undefined ? "added" : now === undefined ? "removed" : "modified",
    });
  }
  return changes;
}

/** Human words for a key: the file path, or what the synthetic key stands for. */
export function describeKey(key: string): string {
  if (key.startsWith("file:")) return key.slice(5);
  if (key === "agents-md:models") return "the frontsmith-models block of AGENTS.md";
  if (key === "package.json:scripts") return "package.json scripts";
  if (key.startsWith("package.json:")) return `package.json ${key.slice(13)}`;
  return key;
}

/**
 * The message of FS-GOV-001 (spec 8.5): which protected files changed and what to do about it. The
 * task is blocked and no command derived from config or package scripts runs until it is resolved.
 */
export function describeProtectedChanges(
  changes: readonly ProtectedChange[],
  feature: string,
): string {
  const lines = changes.map((c) => `- ${describeKey(c.key)} (${c.kind})`);
  return [
    "A child run changed protected files:",
    ...lines,
    `Inspect the change, revert it, or accept it with /frontsmith:approve ${feature} config.`,
  ].join("\n");
}
