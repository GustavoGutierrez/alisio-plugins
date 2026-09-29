import type { ToolDefinition } from "@alisio/sdk";
import { type AtlassianClient, buildPath, type QueryValue, requestJson } from "./http.js";
import {
  array,
  bounded,
  joinLines,
  kv,
  moreLine,
  number,
  pathText,
  record,
  text,
} from "./render.js";
import { frameUntrusted, MAX_FIELD_CHARS, sanitizeRemoteText } from "./text.js";
import { readTool, type ToolSpec, writeTool } from "./toolkit.js";
import {
  DEFAULT_ISSUE_FIELDS,
  parseCommentInput,
  parseCommentsInput,
  parseCreateIssueInput,
  parseEmptyInput,
  parseIssueRef,
  parseLinkInput,
  parseProjectsInput,
  parseSearchInput,
  parseTransitionInput,
  parseUpdateIssueInput,
  parseUserInput,
  parseVersionsInput,
  parseWorklogInput,
  parseWorklogsInput,
} from "./validation.js";

/** Flatten an Atlassian Document Format value to bounded plain text. */
export function adfToText(value: unknown, limit = MAX_FIELD_CHARS): string {
  const parts: string[] = [];
  let length = 0;
  let visited = 0;

  const walk = (node: unknown, depth: number): void => {
    if (length >= limit || visited >= 4000 || depth > 16) return;
    if (typeof node === "string") {
      parts.push(node);
      length += node.length;
      return;
    }
    const holder = record(node);
    if (!holder) return;
    visited += 1;
    if (typeof holder.text === "string") {
      parts.push(holder.text);
      length += holder.text.length;
    }
    if (holder.type === "hardBreak" || holder.type === "paragraph" || holder.type === "heading") {
      parts.push("\n");
      length += 1;
    }
    for (const child of array(holder.content)) walk(child, depth + 1);
  };

  walk(value, 0);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

/** Convert a plain-text description into a minimal ADF document. */
export function textToAdf(value: string): Record<string, unknown> {
  const paragraph = (block: string): Record<string, unknown> => {
    const content: unknown[] = [];
    block.split("\n").forEach((line, index) => {
      if (index > 0) content.push({ type: "hardBreak" });
      if (line !== "") content.push({ type: "text", text: line });
    });
    return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
  };
  return { type: "doc", version: 1, content: value.split(/\n{2,}/).map(paragraph) };
}

function asIssue(value: unknown): Record<string, unknown> {
  const issue = record(value);
  if (!issue) throw new Error("invalid issue payload");
  return issue;
}

function names(value: unknown): string | undefined {
  const labels = array(value)
    .map((item) => (typeof item === "string" ? item : pathText(item, "name")))
    .filter((item): item is string => item !== undefined);
  return labels.length > 0 ? labels.join(", ") : undefined;
}

function get(
  client: AtlassianClient,
  path: string,
  query: Record<string, QueryValue>,
  signal: AbortSignal,
): Promise<unknown> {
  return requestJson(client, { method: "GET", path, query, signal });
}

/** Fetch one Jira issue with a fixed field set. */
export async function fetchIssue(
  client: AtlassianClient,
  issueKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return asIssue(
    await get(
      client,
      buildPath("/rest/api/3/issue/{key}", { key: issueKey }),
      { fields: DEFAULT_ISSUE_FIELDS.join(",") },
      signal,
    ),
  );
}

export function renderIssue(issue: Record<string, unknown>): string {
  return joinLines([
    kv("Issue", text(issue.key)),
    kv("Summary", pathText(issue.fields, "summary")),
    kv("Type", pathText(issue.fields, "issuetype", "name")),
    kv("Status", pathText(issue.fields, "status", "name")),
    kv("Priority", pathText(issue.fields, "priority", "name")),
    kv("Assignee", pathText(issue.fields, "assignee", "displayName")),
    kv("Reporter", pathText(issue.fields, "reporter", "displayName")),
    kv("Labels", names(record(issue.fields)?.labels)),
    kv("Created", pathText(issue.fields, "created")),
    kv("Updated", pathText(issue.fields, "updated")),
    kv("Description", adfToText(record(issue.fields)?.description), 6000),
  ]);
}

export interface IssueReportOptions {
  comments?: boolean;
  transitions?: boolean;
}

export async function fetchComments(
  client: AtlassianClient,
  issueKey: string,
  maxResults: number,
  startAt: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const value = await get(
    client,
    buildPath("/rest/api/3/issue/{key}/comment", { key: issueKey }),
    { startAt, maxResults },
    signal,
  );
  return record(value) ?? {};
}

export function renderComments(payload: Record<string, unknown>): string {
  const all = array(payload.comments);
  const total = number(payload.total);
  const { shown, hidden } = bounded(all, 25);
  const lines = shown.map((item) => {
    const author = pathText(item, "author", "displayName") ?? "unknown author";
    const created = pathText(item, "created") ?? "";
    const body = adfToText(record(item)?.body, 1000);
    return `- ${sanitizeRemoteText(author, 200)}${created ? ` (${sanitizeRemoteText(created, 40)})` : ""}: ${sanitizeRemoteText(body, 1000)}`;
  });
  return [
    `## Comments (${shown.length}${total === undefined ? "" : ` of ${total}`})`,
    ...lines,
    moreLine(hidden),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function fetchTransitions(
  client: AtlassianClient,
  issueKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const value = await get(
    client,
    buildPath("/rest/api/3/issue/{key}/transitions", { key: issueKey }),
    {},
    signal,
  );
  return record(value) ?? {};
}

export function renderTransitions(payload: Record<string, unknown>): string {
  const transitions = bounded(array(payload.transitions), 25);
  const lines = transitions.shown.map((item) => {
    const id = text(record(item)?.id) ?? "?";
    const name = pathText(item, "name") ?? "unnamed transition";
    const to = pathText(item, "to", "name");
    return `- ${sanitizeRemoteText(id, 32)}: ${sanitizeRemoteText(name, 200)}${to ? ` -> ${sanitizeRemoteText(to, 200)}` : ""}`;
  });
  return [
    `## Available transitions (${transitions.shown.length}${transitions.hidden > 0 ? `, ${transitions.hidden} more` : ""})`,
    ...lines,
    moreLine(transitions.hidden),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Shared read flow: one issue, optionally with its comments and transitions. */
export async function buildIssueReport(
  client: AtlassianClient,
  issueKey: string,
  options: IssueReportOptions,
  signal: AbortSignal,
): Promise<string> {
  const issue = await fetchIssue(client, issueKey, signal);
  const sections = [renderIssue(issue)];
  if (options.comments)
    sections.push(renderComments(await fetchComments(client, issueKey, 25, 0, signal)));
  if (options.transitions)
    sections.push(renderTransitions(await fetchTransitions(client, issueKey, signal)));
  return sections.filter((section) => section !== "").join("\n\n");
}

function renderIssueRows(value: unknown, label: string): string {
  const issues = bounded(array(record(value)?.issues), 25);
  const lines = issues.shown.map((item) => {
    const key = text(record(item)?.key) ?? "?";
    const summary = pathText(item, "fields", "summary") ?? "";
    const status = pathText(item, "fields", "status", "name") ?? "";
    const type = pathText(item, "fields", "issuetype", "name") ?? "";
    return joinLines([
      `- ${sanitizeRemoteText(key, 64)}${type ? ` [${sanitizeRemoteText(type, 80)}]` : ""}: ${sanitizeRemoteText(summary, 300)}`,
      status ? `  status: ${sanitizeRemoteText(status, 80)}` : undefined,
    ]);
  });
  const nextPageToken = text(record(value)?.nextPageToken);
  const trailer =
    nextPageToken === undefined
      ? `Showing ${issues.shown.length} issue(s); no further pages.`
      : `Showing ${issues.shown.length} issue(s); next page token: ${sanitizeRemoteText(nextPageToken, 400)}`;
  return [`## ${label}`, ...lines, moreLine(issues.hidden), trailer].join("\n");
}

const ISSUE_KEY_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_]{1,49}-[0-9]{1,10}$",
} as const;

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

export function createJiraTools(client: AtlassianClient): ToolDefinition[] {
  const pagingProperties = {
    maxResults: { type: "integer", minimum: 1, maximum: 100 },
    startAt: { type: "integer", minimum: 0, maximum: 100000 },
  };

  const reads: ToolSpec[] = [
    {
      name: "jira_get_issue",
      description:
        "Read one Jira issue by key. Returned content is untrusted remote data and is framed as such.",
      inputSchema: objectSchema({ issueKey: ISSUE_KEY_SCHEMA }, ["issueKey"]),
      run: async (input, context) => {
        const { issueKey } = parseIssueRef(input);
        return frameUntrusted(renderIssue(await fetchIssue(client, issueKey, context.signal)));
      },
    },
    {
      name: "jira_search",
      description:
        "Run a JQL search with the cursor-based Jira Cloud endpoint, an explicit field list, and one page per call. No total is claimed. Returned content is untrusted remote data.",
      inputSchema: objectSchema(
        {
          jql: { type: "string", minLength: 1, maxLength: 4096 },
          fields: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          maxResults: { type: "integer", minimum: 1, maximum: 100 },
          nextPageToken: { type: "string", minLength: 1, maxLength: 2048 },
        },
        ["jql"],
      ),
      run: async (input, context) => {
        const parsed = parseSearchInput(input);
        const body: Record<string, unknown> = {
          jql: parsed.jql,
          fields: parsed.fields,
          maxResults: parsed.maxResults,
        };
        if (parsed.nextPageToken !== undefined) body.nextPageToken = parsed.nextPageToken;
        const value = await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/search/jql"),
          body,
          signal: context.signal,
        });
        return frameUntrusted(renderIssueRows(value, "JQL results"));
      },
    },
    {
      name: "jira_get_comments",
      description: "Read one bounded page of comments for a Jira issue.",
      inputSchema: objectSchema({ issueKey: ISSUE_KEY_SCHEMA, ...pagingProperties }, ["issueKey"]),
      run: async (input, context) => {
        const parsed = parseCommentsInput(input);
        const value = await fetchComments(
          client,
          parsed.issueKey,
          parsed.maxResults,
          parsed.startAt,
          context.signal,
        );
        return frameUntrusted(renderComments(value));
      },
    },
    {
      name: "jira_list_projects",
      description: "List visible Jira projects, one bounded offset page per call.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1, maxLength: 128 },
        ...pagingProperties,
      }),
      run: async (input, context) => {
        const parsed = parseProjectsInput(input);
        const value = await get(
          client,
          buildPath("/rest/api/3/project/search"),
          { query: parsed.query, startAt: parsed.startAt, maxResults: parsed.maxResults },
          context.signal,
        );
        const projects = bounded(array(record(value)?.values), 25);
        const lines = projects.shown.map((item) => {
          const key = text(record(item)?.key) ?? "?";
          const name = text(record(item)?.name) ?? "";
          const id = text(record(item)?.id);
          return `- ${sanitizeRemoteText(key, 64)}${id ? ` (#${sanitizeRemoteText(id, 32)})` : ""}: ${sanitizeRemoteText(name, 300)}`;
        });
        return frameUntrusted(
          [`## Projects (${projects.shown.length})`, ...lines, moreLine(projects.hidden)].join(
            "\n",
          ),
        );
      },
    },
    {
      name: "jira_get_transitions",
      description: "List the workflow transitions currently available for a Jira issue.",
      inputSchema: objectSchema({ issueKey: ISSUE_KEY_SCHEMA }, ["issueKey"]),
      run: async (input, context) => {
        const { issueKey } = parseIssueRef(input);
        return frameUntrusted(
          renderTransitions(await fetchTransitions(client, issueKey, context.signal)),
        );
      },
    },
    {
      name: "jira_get_worklogs",
      description: "Read one bounded page of worklog entries for a Jira issue.",
      inputSchema: objectSchema({ issueKey: ISSUE_KEY_SCHEMA, ...pagingProperties }, ["issueKey"]),
      run: async (input, context) => {
        const parsed = parseWorklogsInput(input);
        const value = await get(
          client,
          buildPath("/rest/api/3/issue/{key}/worklog", { key: parsed.issueKey }),
          { startAt: parsed.startAt, maxResults: parsed.maxResults },
          context.signal,
        );
        const payload = record(value) ?? {};
        const worklogs = bounded(array(payload.worklogs), 25);
        const lines = worklogs.shown.map((item) => {
          const author = pathText(item, "author", "displayName") ?? "unknown author";
          const spent = text(record(item)?.timeSpent) ?? "";
          const started = text(record(item)?.started) ?? "";
          return `- ${sanitizeRemoteText(author, 200)}${spent ? ` ${sanitizeRemoteText(spent, 40)}` : ""}${started ? ` (${sanitizeRemoteText(started, 40)})` : ""}`;
        });
        const total = number(payload.total);
        return frameUntrusted(
          [
            `## Worklogs (${worklogs.shown.length}${total === undefined ? "" : ` of ${total}`})`,
            ...lines,
            moreLine(worklogs.hidden),
          ].join("\n"),
        );
      },
    },
    {
      name: "jira_get_versions",
      description: "List versions defined for a Jira project.",
      inputSchema: objectSchema(
        { projectIdOrKey: { type: "string", minLength: 1, maxLength: 64 }, ...pagingProperties },
        ["projectIdOrKey"],
      ),
      run: async (input, context) => {
        const parsed = parseVersionsInput(input);
        const value = await get(
          client,
          buildPath("/rest/api/3/project/{key}/versions", { key: parsed.projectIdOrKey }),
          { startAt: parsed.startAt, maxResults: parsed.maxResults },
          context.signal,
        );
        const versions = bounded(array(value), 25);
        const lines = versions.shown.map((item) => {
          const name = text(record(item)?.name) ?? "?";
          const id = text(record(item)?.id);
          const released = record(item)?.released === true ? "released" : "unreleased";
          return `- ${sanitizeRemoteText(name, 200)}${id ? ` (#${sanitizeRemoteText(id, 32)})` : ""} — ${released}`;
        });
        return frameUntrusted(
          [`## Versions (${versions.shown.length})`, ...lines, moreLine(versions.hidden)].join(
            "\n",
          ),
        );
      },
    },
    {
      name: "jira_get_fields",
      description: "List the Jira fields available to this site, bounded to a safe page size.",
      inputSchema: objectSchema({}),
      run: async (input, context) => {
        parseEmptyInput(input);
        const value = await get(client, buildPath("/rest/api/3/field"), {}, context.signal);
        const fields = bounded(array(value), 50);
        const lines = fields.shown.map((item) => {
          const id = text(record(item)?.id) ?? "?";
          const name = text(record(item)?.name) ?? "";
          return `- ${sanitizeRemoteText(id, 64)}: ${sanitizeRemoteText(name, 200)}`;
        });
        return frameUntrusted(
          [`## Fields (${fields.shown.length})`, ...lines, moreLine(fields.hidden)].join("\n"),
        );
      },
    },
    {
      name: "jira_get_user",
      description: "Read one Jira user by Atlassian account id.",
      inputSchema: objectSchema({ accountId: { type: "string", minLength: 1, maxLength: 128 } }, [
        "accountId",
      ]),
      run: async (input, context) => {
        const parsed = parseUserInput(input);
        const value = await get(
          client,
          buildPath("/rest/api/3/user"),
          { accountId: parsed.accountId },
          context.signal,
        );
        const user = record(value) ?? {};
        return frameUntrusted(
          joinLines([
            kv("Account id", text(user.accountId)),
            kv("Display name", text(user.displayName)),
            kv("Active", user.active === true ? "yes" : user.active === false ? "no" : undefined),
            kv("Timezone", text(user.timeZone)),
          ]),
        );
      },
    },
  ];

  const writes: ToolSpec[] = [
    {
      name: "jira_create_issue",
      description:
        "Create a Jira issue. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          projectKey: { type: "string", minLength: 1, maxLength: 64 },
          issueType: { type: "string", minLength: 1, maxLength: 64 },
          summary: { type: "string", minLength: 1, maxLength: 255 },
          description: { type: "string", minLength: 1, maxLength: 32768 },
          labels: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 255 },
          },
          assigneeAccountId: { type: "string", minLength: 1, maxLength: 128 },
          priority: { type: "string", minLength: 1, maxLength: 64 },
        },
        ["projectKey", "issueType", "summary"],
      ),
      run: async (input, context) => {
        const parsed = parseCreateIssueInput(input);
        const fields: Record<string, unknown> = {
          project: { key: parsed.projectKey },
          issuetype: { name: parsed.issueType },
          summary: parsed.summary,
        };
        if (parsed.description !== undefined) fields.description = textToAdf(parsed.description);
        if (parsed.labels !== undefined) fields.labels = parsed.labels;
        if (parsed.assigneeAccountId !== undefined)
          fields.assignee = { accountId: parsed.assigneeAccountId };
        if (parsed.priority !== undefined) fields.priority = { name: parsed.priority };
        const value = await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/issue"),
          body: { fields },
          signal: context.signal,
        });
        const created = record(value) ?? {};
        return frameUntrusted(
          joinLines([kv("Created issue", text(created.key) ?? text(created.id) ?? "created")]),
        );
      },
    },
    {
      name: "jira_update_issue",
      description:
        "Update selected fields on a Jira issue. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          issueKey: ISSUE_KEY_SCHEMA,
          summary: { type: "string", minLength: 1, maxLength: 255 },
          description: { type: "string", minLength: 1, maxLength: 32768 },
          labels: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 255 },
          },
          assigneeAccountId: { type: "string", minLength: 1, maxLength: 128 },
          priority: { type: "string", minLength: 1, maxLength: 64 },
        },
        ["issueKey"],
      ),
      run: async (input, context) => {
        const parsed = parseUpdateIssueInput(input);
        const fields: Record<string, unknown> = {};
        if (parsed.summary !== undefined) fields.summary = parsed.summary;
        if (parsed.description !== undefined) fields.description = textToAdf(parsed.description);
        if (parsed.labels !== undefined) fields.labels = parsed.labels;
        if (parsed.assigneeAccountId !== undefined)
          fields.assignee = { accountId: parsed.assigneeAccountId };
        if (parsed.priority !== undefined) fields.priority = { name: parsed.priority };
        await requestJson(client, {
          method: "PUT",
          path: buildPath("/rest/api/3/issue/{key}", { key: parsed.issueKey }),
          body: { fields },
          signal: context.signal,
        });
        return frameUntrusted(`Updated issue ${sanitizeRemoteText(parsed.issueKey, 64)}.`);
      },
    },
    {
      name: "jira_add_comment",
      description:
        "Add a plain-text comment to a Jira issue. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        { issueKey: ISSUE_KEY_SCHEMA, body: { type: "string", minLength: 1, maxLength: 32768 } },
        ["issueKey", "body"],
      ),
      run: async (input, context) => {
        const parsed = parseCommentInput(input);
        await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/issue/{key}/comment", { key: parsed.issueKey }),
          body: { body: textToAdf(parsed.body) },
          signal: context.signal,
        });
        return frameUntrusted(`Comment added to ${sanitizeRemoteText(parsed.issueKey, 64)}.`);
      },
    },
    {
      name: "jira_transition_issue",
      description:
        "Move a Jira issue through a workflow transition by id. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          issueKey: ISSUE_KEY_SCHEMA,
          transitionId: { type: "string", minLength: 1, maxLength: 20, pattern: "^[0-9]{1,20}$" },
        },
        ["issueKey", "transitionId"],
      ),
      run: async (input, context) => {
        const parsed = parseTransitionInput(input);
        await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/issue/{key}/transitions", { key: parsed.issueKey }),
          body: { transition: { id: parsed.transitionId } },
          signal: context.signal,
        });
        return frameUntrusted(`Transition applied to ${sanitizeRemoteText(parsed.issueKey, 64)}.`);
      },
    },
    {
      name: "jira_add_worklog",
      description:
        "Add a worklog entry to a Jira issue. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          issueKey: ISSUE_KEY_SCHEMA,
          timeSpentSeconds: { type: "integer", minimum: 1, maximum: 31536000 },
          comment: { type: "string", minLength: 1, maxLength: 32768 },
        },
        ["issueKey", "timeSpentSeconds"],
      ),
      run: async (input, context) => {
        const parsed = parseWorklogInput(input);
        const body: Record<string, unknown> = { timeSpentSeconds: parsed.timeSpentSeconds };
        if (parsed.comment !== undefined) body.comment = textToAdf(parsed.comment);
        await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/issue/{key}/worklog", { key: parsed.issueKey }),
          body,
          signal: context.signal,
        });
        return frameUntrusted(`Worklog added to ${sanitizeRemoteText(parsed.issueKey, 64)}.`);
      },
    },
    {
      name: "jira_link_issues",
      description:
        "Create a typed link between two Jira issues. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          type: { type: "string", minLength: 1, maxLength: 64 },
          inwardIssueKey: ISSUE_KEY_SCHEMA,
          outwardIssueKey: ISSUE_KEY_SCHEMA,
        },
        ["type", "inwardIssueKey", "outwardIssueKey"],
      ),
      run: async (input, context) => {
        const parsed = parseLinkInput(input);
        await requestJson(client, {
          method: "POST",
          path: buildPath("/rest/api/3/issueLink"),
          body: {
            type: { name: parsed.type },
            inwardIssue: { key: parsed.inwardIssueKey },
            outwardIssue: { key: parsed.outwardIssueKey },
          },
          signal: context.signal,
        });
        return frameUntrusted(
          `Linked ${sanitizeRemoteText(parsed.inwardIssueKey, 64)} and ${sanitizeRemoteText(parsed.outwardIssueKey, 64)}.`,
        );
      },
    },
  ];

  return [...reads.map((spec) => readTool(spec)), ...writes.map((spec) => writeTool(client, spec))];
}
