import type { ToolDefinition } from "@alisio/sdk";
import { type AtlassianClient, buildPath, type QueryValue, requestJson } from "./http.js";
import { array, bounded, joinLines, kv, moreLine, pathText, record, text } from "./render.js";
import { frameUntrusted, sanitizeRemoteText } from "./text.js";
import { readTool, type ToolSpec, writeTool } from "./toolkit.js";
import {
  invalid,
  PATTERNS,
  parseConfluenceCommentInput,
  parseConfluenceCommentsInput,
  parseConfluenceCreatePageInput,
  parseConfluenceSearchInput,
  parseConfluenceUpdatePageInput,
  parseListSpacesInput,
  parsePageByUrlInput,
  parsePageIdInput,
} from "./validation.js";

const ATLASSIAN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+atlassian\.net$/;

/**
 * Extract a numeric Confluence page id from a user-supplied link. Only the id is
 * used; the link's origin is never fetched, so a hostile host cannot redirect
 * the request away from the configured site.
 */
export function extractPageId(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    invalid("url is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:") invalid("url must use https");
  if (!ATLASSIAN_HOST.test(parsed.hostname.toLowerCase()))
    invalid("url host must end with .atlassian.net");
  const fromQuery = parsed.searchParams.get("pageId");
  if (fromQuery !== null && PATTERNS.numericId.test(fromQuery)) return fromQuery;
  const match = /\/pages\/([0-9]{1,20})(?:\/|$)/.exec(parsed.pathname);
  if (match?.[1] !== undefined) return match[1];
  invalid("could not find a page id in the url");
}

function get(
  client: AtlassianClient,
  path: string,
  query: Record<string, QueryValue>,
  signal: AbortSignal,
): Promise<unknown> {
  return requestJson(client, { method: "GET", path, query, signal });
}

/** Extract the cursor from a Confluence `_links.next` value without fetching it. */
const CURSOR = /^[A-Za-z0-9._~+/=-]{1,2048}$/;

function nextCursor(value: unknown, baseUrl: string): string | undefined {
  const link = pathText(value, "_links", "next");
  if (link === undefined) return undefined;
  try {
    const parsed = new URL(link, baseUrl);
    const cursor = parsed.searchParams.get("cursor");
    return cursor !== null && CURSOR.test(cursor) ? cursor : undefined;
  } catch {
    return undefined;
  }
}

function bodyText(page: Record<string, unknown>): string | undefined {
  const value = pathText(page, "body", "storage", "value");
  return value;
}

export async function fetchPageById(
  client: AtlassianClient,
  pageId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const value = await get(
    client,
    buildPath("/wiki/api/v2/pages/{id}", { id: pageId }),
    { "body-format": "storage" },
    signal,
  );
  return record(value) ?? {};
}

export function renderPage(page: Record<string, unknown>): string {
  return joinLines([
    kv("Page id", text(page.id)),
    kv("Title", text(page.title)),
    kv("Status", text(page.status)),
    kv("Space id", text(page.spaceId)),
    kv("Version", pathText(page, "version", "number")),
    "",
    "Body (storage format; untrusted):",
    sanitizeRemoteText(bodyText(page) ?? "(no body returned)", 8000),
  ]);
}

/** Shared read flow for one page, reused by the command and the CLI. */
export async function buildPageReport(
  client: AtlassianClient,
  pageId: string,
  signal: AbortSignal,
): Promise<string> {
  return renderPage(await fetchPageById(client, pageId, signal));
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

const PAGE_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 20,
  pattern: "^[0-9]{1,20}$",
} as const;
const CURSOR_SCHEMA = { type: "string", minLength: 1, maxLength: 2048 } as const;

export function createConfluenceTools(client: AtlassianClient): ToolDefinition[] {
  const reads: ToolSpec[] = [
    {
      name: "confluence_get_page",
      description:
        "Read one Confluence page by numeric id, including its storage-format body. Returned content is untrusted remote data.",
      inputSchema: objectSchema({ pageId: PAGE_ID_SCHEMA }, ["pageId"]),
      run: async (input, context) => {
        const { pageId } = parsePageIdInput(input);
        return frameUntrusted(renderPage(await fetchPageById(client, pageId, context.signal)));
      },
    },
    {
      name: "confluence_get_page_by_url",
      description:
        "Read a Confluence page from a pasted link. Only the page id is extracted; the page is always fetched from the configured site, never from the supplied link.",
      inputSchema: objectSchema({ url: { type: "string", minLength: 1, maxLength: 2048 } }, [
        "url",
      ]),
      run: async (input, context) => {
        const { url } = parsePageByUrlInput(input);
        const pageId = extractPageId(url);
        return frameUntrusted(renderPage(await fetchPageById(client, pageId, context.signal)));
      },
    },
    {
      name: "confluence_search",
      description:
        "Filter Confluence pages by space, title, and status using the v2 pages endpoint (no free-text search). One bounded cursor page per call.",
      inputSchema: objectSchema({
        spaceId: PAGE_ID_SCHEMA,
        title: { type: "string", minLength: 1, maxLength: 255 },
        status: { type: "string", enum: ["current", "draft", "archived", "trashed"] },
        cursor: CURSOR_SCHEMA,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
      run: async (input, context) => {
        const parsed = parseConfluenceSearchInput(input);
        const value = await get(
          client,
          buildPath("/wiki/api/v2/pages"),
          {
            "space-id": parsed.spaceId,
            title: parsed.title,
            status: parsed.status,
            cursor: parsed.cursor,
            limit: parsed.limit,
          },
          context.signal,
        );
        const pages = bounded(array(record(value)?.results), 25);
        const lines = pages.shown.map((item) => {
          const id = text(record(item)?.id) ?? "?";
          const title = text(record(item)?.title) ?? "";
          return `- ${sanitizeRemoteText(id, 32)}: ${sanitizeRemoteText(title, 300)}`;
        });
        const cursor = nextCursor(value, client.config.baseUrl);
        return frameUntrusted(
          [
            `## Pages (${pages.shown.length})`,
            ...lines,
            moreLine(pages.hidden),
            cursor === undefined
              ? "No further pages."
              : `Next cursor: ${sanitizeRemoteText(cursor, 400)}`,
          ].join("\n"),
        );
      },
    },
    {
      name: "confluence_list_spaces",
      description: "List Confluence spaces, one bounded cursor page per call.",
      inputSchema: objectSchema({
        cursor: CURSOR_SCHEMA,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
      run: async (input, context) => {
        const parsed = parseListSpacesInput(input);
        const value = await get(
          client,
          buildPath("/wiki/api/v2/spaces"),
          { cursor: parsed.cursor, limit: parsed.limit },
          context.signal,
        );
        const spaces = bounded(array(record(value)?.results), 25);
        const lines = spaces.shown.map((item) => {
          const id = text(record(item)?.id) ?? "?";
          const key = text(record(item)?.key) ?? "";
          const name = text(record(item)?.name) ?? "";
          return `- ${sanitizeRemoteText(id, 32)}${key ? ` [${sanitizeRemoteText(key, 64)}]` : ""}: ${sanitizeRemoteText(name, 200)}`;
        });
        const cursor = nextCursor(value, client.config.baseUrl);
        return frameUntrusted(
          [
            `## Spaces (${spaces.shown.length})`,
            ...lines,
            moreLine(spaces.hidden),
            cursor === undefined
              ? "No further pages."
              : `Next cursor: ${sanitizeRemoteText(cursor, 400)}`,
          ].join("\n"),
        );
      },
    },
    {
      name: "confluence_get_comments",
      description: "Read one bounded cursor page of footer comments for a Confluence page.",
      inputSchema: objectSchema(
        {
          pageId: PAGE_ID_SCHEMA,
          cursor: CURSOR_SCHEMA,
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        ["pageId"],
      ),
      run: async (input, context) => {
        const parsed = parseConfluenceCommentsInput(input);
        const value = await get(
          client,
          buildPath("/wiki/api/v2/pages/{id}/footer-comments", { id: parsed.pageId }),
          { "body-format": "storage", cursor: parsed.cursor, limit: parsed.limit },
          context.signal,
        );
        const comments = bounded(array(record(value)?.results), 25);
        const lines = comments.shown.map((item) => {
          const author = pathText(item, "version", "authorId") ?? "unknown author";
          const body = bodyText(record(item) ?? {}) ?? "";
          return `- ${sanitizeRemoteText(author, 200)}: ${sanitizeRemoteText(body, 500)}`;
        });
        const cursor = nextCursor(value, client.config.baseUrl);
        return frameUntrusted(
          [
            `## Footer comments (${comments.shown.length})`,
            ...lines,
            moreLine(comments.hidden),
            cursor === undefined
              ? "No further pages."
              : `Next cursor: ${sanitizeRemoteText(cursor, 400)}`,
          ].join("\n"),
        );
      },
    },
    {
      name: "confluence_get_labels",
      description: "List labels on a Confluence page. Labels are read-only in the v2 API.",
      inputSchema: objectSchema(
        {
          pageId: PAGE_ID_SCHEMA,
          cursor: CURSOR_SCHEMA,
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        ["pageId"],
      ),
      run: async (input, context) => {
        const parsed = parseConfluenceCommentsInput(input);
        const value = await get(
          client,
          buildPath("/wiki/api/v2/pages/{id}/labels", { id: parsed.pageId }),
          { cursor: parsed.cursor, limit: parsed.limit },
          context.signal,
        );
        const labels = bounded(array(record(value)?.results), 50);
        const lines = labels.shown.map((item) => {
          const name = text(record(item)?.name) ?? "?";
          const prefix = text(record(item)?.prefix);
          return `- ${sanitizeRemoteText(name, 200)}${prefix ? ` (${sanitizeRemoteText(prefix, 40)})` : ""}`;
        });
        return frameUntrusted(
          [`## Labels (${labels.shown.length})`, ...lines, moreLine(labels.hidden)].join("\n"),
        );
      },
    },
  ];

  const writes: ToolSpec[] = [
    {
      name: "confluence_create_page",
      description:
        "Create a Confluence page in a space with a storage-format body. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          spaceId: PAGE_ID_SCHEMA,
          title: { type: "string", minLength: 1, maxLength: 255 },
          body: { type: "string", minLength: 1, maxLength: 32768 },
          parentId: PAGE_ID_SCHEMA,
        },
        ["spaceId", "title", "body"],
      ),
      run: async (input, context) => {
        const parsed = parseConfluenceCreatePageInput(input);
        const body: Record<string, unknown> = {
          spaceId: parsed.spaceId,
          status: "current",
          title: parsed.title,
          body: { representation: "storage", value: parsed.body },
        };
        if (parsed.parentId !== undefined) body.parentId = parsed.parentId;
        const value = await requestJson(client, {
          method: "POST",
          path: buildPath("/wiki/api/v2/pages"),
          body,
          signal: context.signal,
        });
        const page = record(value) ?? {};
        return frameUntrusted(
          joinLines([kv("Created page", text(page.id) ?? text(page.title) ?? "created")]),
        );
      },
    },
    {
      name: "confluence_update_page",
      description:
        "Update a Confluence page. Requires the current version number; a stale version returns a version-conflict error. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        {
          pageId: PAGE_ID_SCHEMA,
          title: { type: "string", minLength: 1, maxLength: 255 },
          body: { type: "string", minLength: 1, maxLength: 32768 },
          versionNumber: { type: "integer", minimum: 1 },
        },
        ["pageId", "title", "body", "versionNumber"],
      ),
      run: async (input, context) => {
        const parsed = parseConfluenceUpdatePageInput(input);
        const value = await requestJson(client, {
          method: "PUT",
          path: buildPath("/wiki/api/v2/pages/{id}", { id: parsed.pageId }),
          body: {
            id: parsed.pageId,
            status: "current",
            title: parsed.title,
            body: { representation: "storage", value: parsed.body },
            version: { number: parsed.versionNumber },
          },
          signal: context.signal,
        });
        const page = record(value) ?? {};
        return frameUntrusted(
          joinLines([
            kv("Updated page", text(page.id) ?? parsed.pageId),
            kv("New version", pathText(page, "version", "number")),
          ]),
        );
      },
    },
    {
      name: "confluence_add_comment",
      description:
        "Add a storage-format footer comment to a Confluence page. Mutating: disabled unless ATLASSIAN_ALLOW_WRITES=1 is set.",
      inputSchema: objectSchema(
        { pageId: PAGE_ID_SCHEMA, body: { type: "string", minLength: 1, maxLength: 32768 } },
        ["pageId", "body"],
      ),
      run: async (input, context) => {
        const parsed = parseConfluenceCommentInput(input);
        await requestJson(client, {
          method: "POST",
          path: buildPath("/wiki/api/v2/footer-comments"),
          body: {
            pageId: parsed.pageId,
            body: { representation: "storage", value: parsed.body },
          },
          signal: context.signal,
        });
        return frameUntrusted(`Comment added to page ${sanitizeRemoteText(parsed.pageId, 32)}.`);
      },
    },
  ];

  return [...reads.map((spec) => readTool(spec)), ...writes.map((spec) => writeTool(client, spec))];
}
