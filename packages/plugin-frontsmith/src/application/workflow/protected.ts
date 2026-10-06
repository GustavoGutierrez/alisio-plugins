import { canonicalJson } from "../../domain/canonical-json.js";
import type { DraftFinding } from "../../domain/gates/aggregate.js";
import { parseAgentsMd } from "../../domain/models/agents-md.js";
import {
  describeKey,
  type ProtectedChange,
  type ProtectedSnapshot,
} from "../../domain/protected.js";
import type { IntegrityReader } from "../ports/integrity.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface ProtectedDeps {
  integrity: IntegrityReader;
  fsFor(root: string): WorkspaceFs;
  sha256(text: string): string;
}

export interface ProtectedRequest {
  root: string;
  /** Approved artifacts of the feature (`spec.json`, `ui-contract.json`, `plan.json`), workspace-relative. */
  artifactPaths: readonly string[];
  /** Dependencies a person approved: adding them is not a violation (W-11). */
  approvedDependencies: readonly string[];
}

const DEPENDENCY_MAPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

/**
 * The protected set of spec 8.5 as a map of digests: everything under `.frontsmith/`, the approved
 * artifacts of the feature, the `frontsmith-models` block of AGENTS.md, and the `scripts` and
 * dependency maps of `package.json`. Files are digested with mode and link target (S-R16). The
 * lockfile is recorded as information only.
 */
export async function captureProtected(
  deps: ProtectedDeps,
  request: ProtectedRequest,
): Promise<ProtectedSnapshot> {
  const snapshot: ProtectedSnapshot = {};
  const tree = await deps.integrity.digestTree(request.root, ".frontsmith");
  for (const [path, digest] of Object.entries(tree)) snapshot[`file:${path}`] = digest;
  for (const path of request.artifactPaths) {
    const digest = await deps.integrity.digestFile(request.root, path);
    if (digest !== undefined) snapshot[`file:${path}`] = digest;
  }
  const fs = deps.fsFor(request.root);

  const agents = await fs.read("AGENTS.md");
  if (agents.kind === "text") {
    const parsed = parseAgentsMd(agents.text, { knownAgents: [], sha256: deps.sha256 });
    if (parsed.present)
      snapshot["agents-md:models"] = parsed.blockSha256 ?? deps.sha256(agents.text);
  }

  const pkg = await fs.read("package.json");
  if (pkg.kind === "text") {
    let manifest: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(pkg.text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        manifest = parsed as Record<string, unknown>;
    } catch {
      manifest = undefined;
    }
    if (!manifest) {
      const unreadable = `unreadable:${deps.sha256(pkg.text)}`;
      snapshot["package.json:scripts"] = unreadable;
      for (const key of DEPENDENCY_MAPS) snapshot[`package.json:${key}`] = unreadable;
    } else {
      snapshot["package.json:scripts"] = deps.sha256(canonicalJson(manifest.scripts ?? null));
      const approved = new Set(request.approvedDependencies);
      for (const key of DEPENDENCY_MAPS) {
        const map = manifest[key];
        if (map === undefined) continue;
        const kept =
          typeof map === "object" && map !== null && !Array.isArray(map)
            ? Object.fromEntries(Object.entries(map).filter(([name]) => !approved.has(name)))
            : map;
        snapshot[`package.json:${key}`] = deps.sha256(canonicalJson(kept));
      }
    }
  }

  for (const name of LOCKFILES) {
    const digest = await deps.integrity.digestFile(request.root, name);
    if (digest !== undefined) {
      snapshot["info:lockfile"] = `${name}:${digest}`;
      break;
    }
  }
  return snapshot;
}

/** FS-GOV-001 findings for the changes between two snapshots (blocker, never suppressible). */
export function protectedFindings(
  changes: readonly ProtectedChange[],
): Array<Omit<DraftFinding, "check">> {
  return changes.map((change) => ({
    ruleId: "FS-GOV-001",
    severity: "blocker" as const,
    status: "FAIL" as const,
    kind: "deterministic" as const,
    ...(change.key.startsWith("file:") ? { file: change.key.slice(5) } : {}),
    message: `Protected ${describeKey(change.key)} was ${change.kind} by a child run.`,
    fix: "Inspect, revert, or approve the change with /frontsmith:approve <feature> config.",
  }));
}
