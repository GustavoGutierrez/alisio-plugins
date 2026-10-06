import { FeatureLockedError } from "../../application/ports/feature-store.js";
import type { FrontsmithServices } from "../../application/services.js";
import { WorkflowError } from "../../application/workflow/coordinator.js";
import { isFeatureId } from "../../domain/ids.js";
import { gateIds } from "../../domain/state/feature-state.js";

/** A failure with an HTTP status; the message is safe to show the person at the dashboard. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiRequest {
  method: string;
  /** Path segments after `/api`, already percent-decoded. */
  segments: string[];
  body: unknown;
}

export type ApiResult =
  | { status: number; body: unknown }
  | { status: number; bytes: Uint8Array; type: string };

export interface ApiDeps {
  services: FrontsmithServices;
  workspace: string;
}

/** The complete list of mutating routes (spec 18.4); a test asserts nothing else can write. */
export const MUTATING_ROUTES = [
  "POST /api/features/:f/approve",
  "POST /api/features/:f/reject",
  "POST /api/features/:f/baseline",
] as const;

// TODO(owner): W-48 `config` and `dependency` approvals are command-only; spec 18.4 gives `{ what }` without a domain.
const APPROVE_TARGETS = ["spec", "ui-contract", "plan", "acceptance", "review-signoff"] as const;
const REJECT_TARGETS = ["spec", "ui-contract", "plan", "acceptance"] as const;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PNG_NAME = /^[a-z0-9-]+\.png$/;
const REPORT_NAME = new RegExp(`^(?:${gateIds.join("|")})(?:-T-\\d{3})?$`);
const CASE_ID = /^[a-z][a-z0-9-]{1,47}$/;
const MAX_COMMENTS = 4000;

const evidenceRoot = (feature: string): string => `.alisio/frontsmith/evidence/${feature}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Map an error to an HTTP status: our own messages are the contract, anything else is a 400. */
export function statusFor(error: unknown): number {
  if (error instanceof ApiError) return error.status;
  if (error instanceof FeatureLockedError) return 409;
  const message = error instanceof Error ? error.message : "";
  if (error instanceof WorkflowError && /^Unknown /i.test(message)) return 404;
  return 400;
}

const feature = (value: string | undefined): string => {
  if (!isFeatureId(value)) throw new ApiError(400, "Invalid feature id");
  return value;
};

function bodyOf(request: ApiRequest): Record<string, unknown> {
  if (!isRecord(request.body)) throw new ApiError(400, "Expected a JSON object body");
  return request.body;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw new ApiError(400, `"${key}" must be one of ${allowed.join(", ")}`);
  return value as T;
}

const json = (body: unknown, status = 200): ApiResult => ({ status, body });

async function featureView(deps: ApiDeps, id: string): Promise<unknown> {
  const { services, workspace } = deps;
  const status = await services.workflow.status(workspace, id);
  const config = await services.deps.project.readConfig(workspace);
  const artifactDir = services.workflow.artifactDir(status.state, config.config.paths.artifacts);
  const reports = (await services.deps.assets.list(workspace, `${artifactDir}/reports`))
    .map((path) => /([^/]+)\.json$/.exec(path)?.[1])
    .filter((name): name is string => name !== undefined && REPORT_NAME.test(name));
  let latest: { runId: string; files: string[] } | undefined;
  const raw = await services.deps.assets.read(workspace, `${evidenceRoot(id)}/latest.json`);
  if (raw) {
    try {
      const info = JSON.parse(Buffer.from(raw).toString("utf8")) as { runId?: unknown };
      if (typeof info.runId === "string" && RUN_ID.test(info.runId)) {
        const files = (
          await services.deps.assets.list(workspace, `${evidenceRoot(id)}/${info.runId}`)
        )
          .map((path) => path.split("/").pop() ?? "")
          .filter((name) => PNG_NAME.test(name));
        latest = { runId: info.runId, files };
      }
    } catch {
      // A damaged latest.json simply shows no evidence.
    }
  }
  return {
    state: status.state,
    next: status.next,
    running: status.running,
    readOnly: status.readOnly,
    artifactDir,
    gateIds,
    reports,
    baselines: await services.fidelity.listBaselines(workspace, id),
    evidence: latest ?? null,
  };
}

async function featureRoute(
  deps: ApiDeps,
  request: ApiRequest,
  [, id, section, a, b]: string[],
): Promise<ApiResult> {
  const { services, workspace } = deps;
  const name = feature(id);
  if (request.method === "GET") {
    if (section === undefined) return json(await featureView(deps, name));
    if (section === "reports" && a !== undefined && b === undefined) {
      if (!REPORT_NAME.test(a)) throw new ApiError(400, "Invalid report name");
      const status = await services.workflow.status(workspace, name);
      const config = await services.deps.project.readConfig(workspace);
      const dir = services.workflow.artifactDir(status.state, config.config.paths.artifacts);
      const bytes = await services.deps.assets.read(workspace, `${dir}/reports/${a}.json`);
      if (!bytes) throw new ApiError(404, `No report ${a} for ${name}`);
      try {
        return json(JSON.parse(Buffer.from(bytes).toString("utf8")));
      } catch {
        throw new ApiError(500, "The report is not valid JSON");
      }
    }
    if (section === "evidence" && a !== undefined && b !== undefined) {
      if (!RUN_ID.test(a)) throw new ApiError(400, "Invalid run id");
      if (!PNG_NAME.test(b)) throw new ApiError(400, "Invalid evidence file name");
      await services.workflow.status(workspace, name);
      const bytes = await services.deps.assets.read(workspace, `${evidenceRoot(name)}/${a}/${b}`);
      if (!bytes) throw new ApiError(404, "No such evidence file");
      return { status: 200, bytes, type: "image/png" };
    }
    throw new ApiError(404, "Not found");
  }
  if (section === "approve" && a === undefined) {
    const what = oneOf(bodyOf(request).what, APPROVE_TARGETS, "what");
    const result = await services.workflow.approve(workspace, name, what, { sessionId: "" });
    return json({ message: result.message, next: result.next });
  }
  if (section === "reject" && a === undefined) {
    const body = bodyOf(request);
    const what = oneOf(body.what, REJECT_TARGETS, "what");
    if (typeof body.comments !== "string" || body.comments.trim() === "")
      throw new ApiError(400, '"comments" must be a non-empty string');
    if (body.comments.length > MAX_COMMENTS) throw new ApiError(400, '"comments" is too long');
    const result = await services.workflow.reject(workspace, name, what, body.comments);
    return json({ message: result.message, next: result.next });
  }
  if (section === "baseline" && a === undefined) {
    const body = bodyOf(request);
    const caseId = body.caseId;
    if (caseId !== undefined && (typeof caseId !== "string" || !CASE_ID.test(caseId)))
      throw new ApiError(400, '"caseId" must be a case id');
    const result = await services.fidelity.approveBaseline(
      workspace,
      name,
      caseId as string | undefined,
    );
    if (!result.ok) throw new ApiError(/^Unknown /.test(result.reason) ? 404 : 409, result.reason);
    return json({ approved: result.approved });
  }
  throw new ApiError(404, "Not found");
}

/** Route one request (`segments` come after `/api`). Unknown paths are 404 whatever the method. */
export async function handleApi(deps: ApiDeps, request: ApiRequest): Promise<ApiResult> {
  const [head] = request.segments;
  if (request.method === "GET") {
    if (head === "state" && request.segments.length === 1) {
      const { services, workspace } = deps;
      const features = await services.workflow.list(workspace);
      return json({
        features: features.map((s) => ({
          feature: s.feature,
          level: s.level,
          mode: s.mode,
          phase: s.phase,
          blocked: s.blocked?.reason ?? null,
          running: services.deps.jobs.isRunning(s.feature),
          updatedAt: s.updatedAt,
          gates: Object.fromEntries(Object.entries(s.gates).map(([id, g]) => [id, g.verdict])),
        })),
      });
    }
    if (head === "rules" && request.segments.length === 1) {
      const { rules } = await deps.services.rules.list(deps.workspace);
      return json({
        rules: rules.map((r) => ({
          id: r.id,
          severity: r.severity,
          kind: r.kind,
          engine: r.engine,
          pack: r.packId,
          source: r.origin,
          title: r.title,
        })),
      });
    }
  }
  if (head === "features" && request.segments.length >= 2) {
    if (request.method === "GET" || request.segments.length === 3)
      return featureRoute(deps, request, request.segments);
  }
  throw new ApiError(404, "Not found");
}
