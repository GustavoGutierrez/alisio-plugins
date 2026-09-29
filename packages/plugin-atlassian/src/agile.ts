import type { ToolDefinition } from "@alisio/sdk";
import { type AtlassianClient, buildPath, type QueryValue, requestJson } from "./http.js";
import { array, bounded, moreLine, pathText, record, text } from "./render.js";
import { frameUntrusted, sanitizeRemoteText } from "./text.js";
import { readTool, type ToolSpec, writeTool } from "./toolkit.js";
import {
  MAX_AGILE_MOVE_ISSUES,
  parseBacklogInput,
  parseBoardsInput,
  parseEpicsInput,
  parseMoveIssuesInput,
  parseSprintsInput,
} from "./validation.js";

function get(
  client: AtlassianClient,
  path: string,
  query: Record<string, QueryValue>,
  signal: AbortSignal,
): Promise<unknown> {
  return requestJson(client, { method: "GET", path, query, signal });
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

const BOARD_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 20,
  pattern: "^[0-9]{1,20}$",
} as const;
const ISSUE_KEY_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_]{1,49}-[0-9]{1,10}$",
} as const;

function pageTrailer(shown: number, isLast: boolean): string {
  return isLast ? `Showing ${shown} result(s); last page.` : `Showing ${shown} result(s).`;
}

export function createAgileTools(client: AtlassianClient): ToolDefinition[] {
  const pagingProperties = {
    startAt: { type: "integer", minimum: 0, maximum: 100000 },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
  };

  const reads: ToolSpec[] = [
    {
      name: "agile_list_boards",
      description: "List Jira Software boards, one bounded offset page per call.",
      inputSchema: objectSchema({ ...pagingProperties }),
      run: async (input, context) => {
        const parsed = parseBoardsInput(input);
        const value = await get(
          client,
          buildPath("/rest/agile/1.0/board"),
          { startAt: parsed.startAt, maxResults: parsed.maxResults },
          context.signal,
        );
        const payload = record(value) ?? {};
        const boards = bounded(array(payload.values), 25);
        const lines = boards.shown.map((item) => {
          const id = text(record(item)?.id) ?? "?";
          const name = text(record(item)?.name) ?? "";
          const type = text(record(item)?.type) ?? "";
          return `- ${sanitizeRemoteText(id, 32)}${type ? ` (${sanitizeRemoteText(type, 40)})` : ""}: ${sanitizeRemoteText(name, 300)}`;
        });
        return frameUntrusted(
          [
            `## Boards (${boards.shown.length})`,
            ...lines,
            moreLine(boards.hidden),
            pageTrailer(boards.shown.length, payload.isLast === true),
          ].join("\n"),
        );
      },
    },
    {
      name: "agile_list_sprints",
      description: "List sprints for a Jira Software board, optionally filtered by state.",
      inputSchema: objectSchema(
        {
          boardId: BOARD_ID_SCHEMA,
          state: { type: "string", enum: ["future", "active", "closed"] },
          ...pagingProperties,
        },
        ["boardId"],
      ),
      run: async (input, context) => {
        const parsed = parseSprintsInput(input);
        const value = await get(
          client,
          buildPath("/rest/agile/1.0/board/{id}/sprint", { id: parsed.boardId }),
          { startAt: parsed.startAt, maxResults: parsed.maxResults, state: parsed.state },
          context.signal,
        );
        const payload = record(value) ?? {};
        const sprints = bounded(array(payload.values), 25);
        const lines = sprints.shown.map((item) => {
          const id = text(record(item)?.id) ?? "?";
          const name = text(record(item)?.name) ?? "";
          const state = text(record(item)?.state) ?? "";
          const start = text(record(item)?.startDate);
          const end = text(record(item)?.endDate);
          const dates =
            start !== undefined || end !== undefined ? ` (${start ?? "?"} - ${end ?? "?"})` : "";
          return `- ${sanitizeRemoteText(id, 32)}${state ? ` [${sanitizeRemoteText(state, 40)}]` : ""}: ${sanitizeRemoteText(name, 300)}${sanitizeRemoteText(dates, 120)}`;
        });
        return frameUntrusted(
          [
            `## Sprints (${sprints.shown.length})`,
            ...lines,
            moreLine(sprints.hidden),
            pageTrailer(sprints.shown.length, payload.isLast === true),
          ].join("\n"),
        );
      },
    },
    {
      name: "agile_get_backlog",
      description:
        "List issues in a Jira Software board backlog, one bounded offset page per call.",
      inputSchema: objectSchema({ boardId: BOARD_ID_SCHEMA, ...pagingProperties }, ["boardId"]),
      run: async (input, context) => {
        const parsed = parseBacklogInput(input);
        const value = await get(
          client,
          buildPath("/rest/agile/1.0/board/{id}/backlog", { id: parsed.boardId }),
          { startAt: parsed.startAt, maxResults: parsed.maxResults },
          context.signal,
        );
        const payload = record(value) ?? {};
        const issues = bounded(array(payload.issues), 25);
        const lines = issues.shown.map((item) => {
          const key = text(record(item)?.key) ?? "?";
          const summary = pathText(item, "fields", "summary") ?? "";
          return `- ${sanitizeRemoteText(key, 64)}: ${sanitizeRemoteText(summary, 300)}`;
        });
        return frameUntrusted(
          [
            `## Backlog (${issues.shown.length} of ${issues.shown.length + issues.hidden})`,
            ...lines,
            moreLine(issues.hidden),
          ].join("\n"),
        );
      },
    },
    {
      name: "agile_list_epics",
      description: "List epics on a Jira Software board, optionally filtered by completion.",
      inputSchema: objectSchema(
        { boardId: BOARD_ID_SCHEMA, done: { type: "boolean" }, ...pagingProperties },
        ["boardId"],
      ),
      run: async (input, context) => {
        const parsed = parseEpicsInput(input);
        const value = await get(
          client,
          buildPath("/rest/agile/1.0/board/{id}/epic", { id: parsed.boardId }),
          { startAt: parsed.startAt, maxResults: parsed.maxResults, done: parsed.done },
          context.signal,
        );
        const payload = record(value) ?? {};
        const epics = bounded(array(payload.values), 25);
        const lines = epics.shown.map((item) => {
          const key = text(record(item)?.key) ?? text(record(item)?.id) ?? "?";
          const name = text(record(item)?.name) ?? pathText(item, "summary") ?? "";
          const done = record(item)?.done === true ? "done" : "open";
          return `- ${sanitizeRemoteText(key, 64)} [${done}]: ${sanitizeRemoteText(name, 300)}`;
        });
        return frameUntrusted(
          [
            `## Epics (${epics.shown.length})`,
            ...lines,
            moreLine(epics.hidden),
            pageTrailer(epics.shown.length, payload.isLast === true),
          ].join("\n"),
        );
      },
    },
  ];

  const writes: ToolSpec[] = [
    {
      name: "agile_move_issues",
      description: `Move up to ${MAX_AGILE_MOVE_ISSUES} issues to a sprint, the backlog, or an epic. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.`,
      inputSchema: objectSchema(
        {
          destination: { type: "string", enum: ["sprint", "backlog", "epic"] },
          sprintId: { type: "string", minLength: 1, maxLength: 20, pattern: "^[0-9]{1,20}$" },
          epicIdOrKey: { type: "string", minLength: 1, maxLength: 64 },
          issueKeys: {
            type: "array",
            minItems: 1,
            maxItems: MAX_AGILE_MOVE_ISSUES,
            items: ISSUE_KEY_SCHEMA,
          },
        },
        ["destination", "issueKeys"],
      ),
      run: async (input, context) => {
        const parsed = parseMoveIssuesInput(input);
        const path =
          parsed.destination === "sprint"
            ? buildPath("/rest/agile/1.0/sprint/{id}/issue", { id: parsed.sprintId as string })
            : parsed.destination === "backlog"
              ? buildPath("/rest/agile/1.0/backlog/issue")
              : buildPath("/rest/agile/1.0/epic/{key}/issue", {
                  key: parsed.epicIdOrKey as string,
                });
        await requestJson(client, {
          method: "POST",
          path,
          body: { issues: parsed.issueKeys },
          signal: context.signal,
        });
        return frameUntrusted(
          `Moved ${parsed.issueKeys.length} issue(s) to ${parsed.destination}.`,
        );
      },
    },
  ];

  return [...reads.map((spec) => readTool(spec)), ...writes.map((spec) => writeTool(client, spec))];
}
