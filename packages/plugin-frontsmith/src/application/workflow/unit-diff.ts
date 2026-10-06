import type { UnitChange } from "../../domain/rules/unit.js";
import type { PhaseEnv } from "./env.js";

/** The state of every file that differs from `HEAD` at one moment (spec 7.2 G6, B-12). */
export interface WorkSnapshot {
  isRepo: boolean;
  /** Content hash per changed path; `deleted` for a removed file. */
  hashes: Map<string, string>;
  /** Text of the changed files that could be read as text. */
  texts: Map<string, string>;
}

/**
 * Record what is currently changed against HEAD. A unit's diff is the difference between the
 * snapshot taken before a child ran and the one taken after, so changes from earlier tasks never
 * count against a later one.
 */
export async function snapshotWorkspace(env: PhaseEnv): Promise<WorkSnapshot> {
  const { git, fsFor, sha256 } = env.deps;
  const snapshot: WorkSnapshot = { isRepo: false, hashes: new Map(), texts: new Map() };
  if (!(await git.isRepo(env.root))) return snapshot;
  snapshot.isRepo = true;
  const fs = fsFor(env.root);
  // What the coordinator itself writes (artifacts, evidence, machine state) is never a child's change.
  const own = [`${env.config.paths.artifacts.replace(/\/$/, "")}/`, ".alisio/"];
  for (const change of await git.changedFiles(env.root)) {
    if (own.some((prefix) => change.path.startsWith(prefix))) continue;
    if (change.status === "D") {
      snapshot.hashes.set(change.path, "deleted");
      continue;
    }
    const read = await fs.read(change.path);
    if (read.kind === "text") {
      snapshot.hashes.set(change.path, sha256(read.text));
      snapshot.texts.set(change.path, read.text);
    } else if (read.kind === "too-large") snapshot.hashes.set(change.path, `large:${read.size}`);
    else snapshot.hashes.set(change.path, "deleted");
  }
  return snapshot;
}

/** The changes between two snapshots, with the text before and after (for the diff guards). */
export async function diffSince(env: PhaseEnv, before: WorkSnapshot): Promise<UnitChange[]> {
  const after = await snapshotWorkspace(env);
  const { git } = env.deps;
  const changes: UnitChange[] = [];
  const paths = [...new Set([...before.hashes.keys(), ...after.hashes.keys()])].sort();
  for (const path of paths) {
    const was = before.hashes.get(path) ?? "head";
    const now = after.hashes.get(path) ?? "head";
    if (was === now) continue;
    const beforeText = before.hashes.has(path)
      ? before.texts.get(path)
      : await git.show(env.root, "HEAD", path);
    const afterText = after.hashes.has(path)
      ? after.texts.get(path)
      : await git.show(env.root, "HEAD", path);
    const status: UnitChange["status"] =
      beforeText === undefined ? "A" : afterText === undefined ? "D" : "M";
    changes.push({
      path,
      status,
      ...(beforeText !== undefined ? { before: beforeText } : {}),
      ...(afterText !== undefined ? { after: afterText } : {}),
    });
  }
  return changes;
}
