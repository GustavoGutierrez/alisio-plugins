import type { RejectAction } from "../app/operator.js";
import { rejectActions } from "../app/operator.js";
import type { SwarmServices } from "../app/services.js";
import { validateProjectName, validateRole, validateTaskName } from "../domain/identifiers.js";

/** A failure with an HTTP status; the message is safe to show the operator. */
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
  query: URLSearchParams;
  body: unknown;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ApiDeps {
  services: SwarmServices;
  workspace: string;
}

const MAX_TEXT = 8000;

/** Map a service error to an HTTP status from its message: our own messages are the contract. */
export function statusFor(error: unknown): number {
  if (error instanceof ApiError) return error.status;
  const message = error instanceof Error ? error.message : "";
  if (/^Unknown /i.test(message)) return 404;
  if (/already exists/i.test(message)) return 409;
  return 400;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function bodyOf(request: ApiRequest): Record<string, unknown> {
  if (!isRecord(request.body)) throw new ApiError(400, "Expected a JSON object body");
  return request.body;
}

function text(
  source: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; max?: number } = {},
): string {
  const value = source[key];
  if (value === undefined && options.optional) return "";
  if (typeof value !== "string") throw new ApiError(400, `"${key}" must be a string`);
  if (value.length > (options.max ?? MAX_TEXT)) throw new ApiError(400, `"${key}" is too long`);
  return value;
}

const project = (source: Record<string, unknown> | URLSearchParams): string => {
  const value = source instanceof URLSearchParams ? source.get("project") : source.project;
  if (typeof value !== "string") throw new ApiError(400, "A project is required");
  return validateProjectName(value);
};

const task = (source: Record<string, unknown> | URLSearchParams): string => {
  const value = source instanceof URLSearchParams ? source.get("task") : source.task;
  if (typeof value !== "string") throw new ApiError(400, "A task is required");
  return validateTaskName(value);
};

function itemId(id: string, kind: "approval" | "clarification"): { project: string; task: string } {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== kind) {
    throw new ApiError(400, `Expected an id like ${kind}:<project>:<task>`);
  }
  return {
    project: validateProjectName(parts[1] as string),
    task: validateTaskName(parts[2] as string),
  };
}

const ok = (body: unknown = { ok: true }): ApiResult => ({ status: 200, body });

type Handler = (deps: ApiDeps, request: ApiRequest, params: string[]) => Promise<ApiResult>;

interface Route {
  method: "GET" | "POST";
  pattern: string[];
  handler: Handler;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: ["state"],
    handler: async ({ services, workspace }) => ok(await services.state(workspace)),
  },
  {
    method: "GET",
    pattern: ["mission"],
    handler: async ({ services, workspace }, request) => {
      const name = project(request.query);
      return ok({ project: name, mission: await services.mission(workspace, name) });
    },
  },
  {
    method: "GET",
    pattern: ["doc"],
    handler: async ({ services, workspace }, request) =>
      ok(await services.documents(workspace, project(request.query), task(request.query))),
  },
  {
    method: "GET",
    pattern: ["agents", ":role", "tail"],
    handler: async ({ services, workspace }, request, [role]) => {
      validateRole(role as string);
      return ok(await services.agentTail(workspace, project(request.query), role as string));
    },
  },
  ...(["delete", "retry"] as const).map(
    (action): Route => ({
      method: "POST",
      pattern: ["tasks", action],
      handler: async ({ services, workspace }, request) => {
        const body = bodyOf(request);
        const args = [workspace, project(body), task(body)] as const;
        if (action === "delete") await services.deleteTask(...args);
        else await services.retryTask(...args);
        return ok();
      },
    }),
  ),
  {
    method: "POST",
    pattern: ["approvals", ":id", ":action"],
    handler: async ({ services, workspace }, request, [id, action]) => {
      if (action !== "approve" && action !== "comments" && action !== "reject") {
        throw new ApiError(404, "Unknown approval action");
      }
      const ref = itemId(id as string, "approval");
      const body = bodyOf(request);
      if (action === "approve") {
        await services.approve(workspace, ref.project, ref.task);
      } else if (action === "comments") {
        if (body.clear === true) {
          await services.clearComments(workspace, ref.project, ref.task);
        } else {
          await services.addComment(
            workspace,
            ref.project,
            ref.task,
            text(body, "doc", { max: 300 }),
            text(body, "text"),
          );
        }
      } else {
        const chosen = text(body, "action", { max: 20 });
        if (!(rejectActions as readonly string[]).includes(chosen)) {
          throw new ApiError(400, "Reject needs one of: retry, delete, accept");
        }
        const comments = body.comments === undefined ? undefined : text(body, "comments");
        await services.reject(workspace, ref.project, ref.task, chosen as RejectAction, comments);
      }
      return ok();
    },
  },
  {
    method: "POST",
    pattern: ["clarifications", ":id", "answer"],
    handler: async ({ services, workspace }, request, [id]) => {
      const ref = itemId(id as string, "clarification");
      const answer = text(bodyOf(request), "text");
      if (!answer.trim()) throw new ApiError(400, "An answer needs text");
      await services.answer(workspace, ref.project, ref.task, answer);
      return ok();
    },
  },
];

/** The mutating routes, for the "complementary only" test: gate decisions and nothing else. */
export const mutatingRoutes = (): string[] =>
  routes
    .filter((route) => route.method === "POST")
    .map((route) => `POST /api/${route.pattern.join("/")}`)
    .sort();

function match(pattern: string[], segments: string[]): string[] | undefined {
  if (pattern.length !== segments.length) return undefined;
  const params: string[] = [];
  for (const [index, part] of pattern.entries()) {
    if (part.startsWith(":")) params.push(segments[index] as string);
    else if (part !== segments[index]) return undefined;
  }
  return params;
}

/** Dispatch one API request. Every failure is an `ApiError` or a service `Error`; the caller maps it. */
export async function handleApi(deps: ApiDeps, request: ApiRequest): Promise<ApiResult> {
  let pathMatched = false;
  for (const route of routes) {
    const params = match(route.pattern, request.segments);
    if (!params) continue;
    pathMatched = true;
    if (route.method === request.method) return route.handler(deps, request, params);
  }
  if (pathMatched) throw new ApiError(405, "Method not allowed");
  throw new ApiError(404, "Unknown route");
}
