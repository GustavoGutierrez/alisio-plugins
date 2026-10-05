import { assertRelativePath } from "../domain/identifiers.js";
import type { ApprovalComment } from "../domain/taskstate.js";
import type { ProjectRuntime } from "./project.js";

export const MAX_DOC_BYTES = 64 * 1024;
export const MAX_DIFF_BYTES = 256 * 1024;
const MAX_DOCS = 20;

export interface DocumentEntry {
  path: string;
  text: string;
  truncated: boolean;
  comments: ApprovalComment[];
}

/** What the Documents dialog shows for a task waiting at the approval gate. */
export interface DocumentsView {
  project: string;
  task: string;
  /** The role that owns the gate. */
  role: string;
  /** Head of that role when it started the task, when known. */
  base?: string;
  /** The held commit. */
  commit: string;
  docs: DocumentEntry[];
  diff: string;
  diffTruncated: boolean;
  comments: ApprovalComment[];
  /** Approve is disabled while comments exist (spec 8.3). */
  approvable: boolean;
}

const isDocument = (path: string): boolean =>
  /(^|\/)(specs|tasks|features|docs)\//.test(path) || /\.(feature|md)$/.test(path);

const clip = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

/**
 * Task documents and the diff from the gate role's base to the held commit. Everything is read
 * from the git object store at the held commit, so no path can leave the repository.
 */
export async function buildDocuments(
  runtime: ProjectRuntime,
  taskName: string,
): Promise<DocumentsView> {
  const held = await runtime.heldApproval(taskName);
  const role = held.location.kind === "pending_approval" ? held.location.role : undefined;
  const commit = held.handoff.commit;
  if (!role || !commit) throw new Error(`Task ${taskName} has no held commit to review`);
  const card = runtime.cardByName(taskName);
  const base = (await runtime.state.get(card.taskId))?.bases[role];
  const workdir = runtime.workdir(role);
  const changed = await runtime.isolation.changedFiles(workdir, base, commit);
  const paths: string[] = [];
  for (const path of [...changed.filter(isDocument), `tasks/${taskName}.md`]) {
    try {
      assertRelativePath(path);
    } catch {
      continue;
    }
    if (!paths.includes(path) && paths.length < MAX_DOCS) paths.push(path);
  }
  const comments = runtime.comments(taskName);
  const docs: DocumentEntry[] = [];
  for (const path of paths) {
    const content = await runtime.isolation
      .readFileAt(workdir, commit, path)
      .catch(() => undefined);
    if (content === undefined) continue;
    docs.push({
      path,
      ...clip(content, MAX_DOC_BYTES),
      comments: comments.filter((comment) => comment.doc === path),
    });
  }
  const rawDiff = await runtime.isolation
    .diff(workdir, base, commit)
    .catch(() => "The diff is too large or could not be produced.");
  const diff = clip(rawDiff, MAX_DIFF_BYTES);
  return {
    project: runtime.name,
    task: taskName,
    role,
    ...(base ? { base } : {}),
    commit,
    docs,
    diff: diff.text,
    diffTruncated: diff.truncated,
    comments,
    approvable: comments.length === 0,
  };
}
