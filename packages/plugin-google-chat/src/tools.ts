import type { ToolDefinition } from "@alisio/sdk";
import type { GoogleChatClient, QueryValue } from "./http.js";
import {
  array,
  bounded,
  joinLines,
  kv,
  moreLine,
  pagingLine,
  pathText,
  record,
  text,
} from "./render.js";
import { frameUntrusted, sanitizeRemoteText } from "./text.js";
import { externalTool, type ToolSpec, writeTool } from "./toolkit.js";
import {
  parseDeleteMessageInput,
  parseEditMessageInput,
  parseListMembershipsInput,
  parseListMessagesInput,
  parseListSpacesInput,
  parseSearchMessagesInput,
  parseSendMessageInput,
} from "./validation.js";

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

const SPACE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 250,
  description: 'A space id like "AAAAAAAAAAA" or a resource name like "spaces/AAAAAAAAAAA".',
} as const;
const PAGE_TOKEN_SCHEMA = { type: "string", minLength: 1, maxLength: 4096 } as const;
const MESSAGE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 420,
  description: 'A full message resource name like "spaces/AAA/messages/BBB".',
} as const;
const TEXT_SCHEMA = { type: "string", minLength: 1, maxLength: 32000 } as const;

/** Build the seven Google Chat tools. Reads are `external`; mutations are `write`. */
export function createGoogleChatTools(client: GoogleChatClient): ToolDefinition[] {
  const reads: ToolSpec[] = [
    {
      name: "google_chat_list_spaces",
      description:
        "List Google Chat spaces the authenticated user is a member of, one bounded page per call. Requires OAuth user mode.",
      inputSchema: objectSchema({
        pageSize: { type: "integer", minimum: 1, maximum: 1000 },
        pageToken: PAGE_TOKEN_SCHEMA,
        spaceType: { type: "string", enum: ["SPACE", "GROUP_CHAT", "DIRECT_MESSAGE"] },
      }),
      run: async (input, context) => {
        const parsed = parseListSpacesInput(input);
        const query: Record<string, QueryValue> = {
          pageSize: parsed.pageSize,
          pageToken: parsed.pageToken,
        };
        if (parsed.spaceType !== undefined) query.filter = `spaceType = "${parsed.spaceType}"`;
        const value = await client.request({
          method: "GET",
          path: "/v1/spaces",
          query,
          signal: context.signal,
          idempotent: true,
        });
        const payload = record(value) ?? {};
        const spaces = bounded(array(payload.spaces), 25);
        const lines = spaces.shown.map((item) => {
          const name = text(record(item)?.name) ?? "?";
          const type = text(record(item)?.spaceType) ?? text(record(item)?.type) ?? "";
          const display = text(record(item)?.displayName) ?? "";
          return `- ${sanitizeRemoteText(name, 120)}${type ? ` [${sanitizeRemoteText(type, 40)}]` : ""}: ${sanitizeRemoteText(display, 300)}`;
        });
        return frameUntrusted(
          [
            `## Spaces (${spaces.shown.length})`,
            ...lines,
            moreLine(spaces.hidden),
            pagingLine(spaces.shown.length, text(payload.nextPageToken)),
          ].join("\n"),
        );
      },
    },
    {
      name: "google_chat_list_messages",
      description:
        "List messages in a Google Chat space, newest or oldest first, one bounded page per call. Requires OAuth user mode.",
      inputSchema: objectSchema(
        {
          space: SPACE_SCHEMA,
          pageSize: { type: "integer", minimum: 1, maximum: 1000 },
          pageToken: PAGE_TOKEN_SCHEMA,
          filter: { type: "string", minLength: 1, maxLength: 1024 },
          orderBy: { type: "string", enum: ["createTime ASC", "createTime DESC"] },
          showDeleted: { type: "boolean" },
        },
        ["space"],
      ),
      run: async (input, context) => {
        const parsed = parseListMessagesInput(input);
        const value = await client.request({
          method: "GET",
          path: `/v1/${parsed.space}/messages`,
          query: {
            pageSize: parsed.pageSize,
            pageToken: parsed.pageToken,
            filter: parsed.filter,
            orderBy: parsed.orderBy,
            showDeleted: parsed.showDeleted,
          },
          signal: context.signal,
          idempotent: true,
        });
        const payload = record(value) ?? {};
        const messages = bounded(array(payload.messages), 25);
        const lines = messages.shown.map((item) => {
          const name = text(record(item)?.name) ?? "?";
          const sender = pathText(item, "sender", "displayName") ?? "unknown";
          const when = text(record(item)?.createTime) ?? "";
          const body = sanitizeRemoteText(
            record(item)?.text ?? record(item)?.formattedText ?? record(item)?.argumentText,
            1000,
          );
          return `- ${sanitizeRemoteText(name, 160)} ${sanitizeRemoteText(when, 40)} ${sanitizeRemoteText(sender, 80)}: ${body}`;
        });
        return frameUntrusted(
          [
            `## Messages (${messages.shown.length})`,
            ...lines,
            moreLine(messages.hidden),
            pagingLine(messages.shown.length, text(payload.nextPageToken)),
          ].join("\n"),
        );
      },
    },
    {
      name: "google_chat_search_messages",
      description:
        "Search Google Chat messages the authenticated user can access, using the Chat search filter syntax. Developer Preview and user-auth only.",
      inputSchema: objectSchema(
        {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            description: "A Chat search query, for example a phrase or `is_unread()`.",
          },
          sender: {
            type: "string",
            minLength: 1,
            maxLength: 220,
            description:
              "Optional sender email, user id, or users/{user}; a leading @ is accepted and stripped.",
          },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
          pageToken: PAGE_TOKEN_SCHEMA,
          orderBy: { type: "string", enum: ["createTime desc", "relevance desc"] },
          view: {
            type: "string",
            enum: ["SEARCH_MESSAGES_VIEW_BASIC", "SEARCH_MESSAGES_VIEW_FULL"],
          },
        },
        ["query"],
      ),
      run: async (input, context) => {
        const parsed = parseSearchMessagesInput(input);
        const value = await client.request({
          method: "POST",
          path: "/v1/spaces/-/messages:search",
          body: {
            filter: parsed.filter,
            pageSize: parsed.pageSize,
            ...(parsed.pageToken === undefined ? {} : { pageToken: parsed.pageToken }),
            ...(parsed.orderBy === undefined ? {} : { orderBy: parsed.orderBy }),
            ...(parsed.view === undefined ? {} : { view: parsed.view }),
          },
          signal: context.signal,
        });
        const payload = record(value) ?? {};
        const results = bounded(array(payload.results), 25);
        const lines = results.shown.map((item) => {
          const message = record(record(item)?.message) ?? {};
          const name = text(message.name) ?? "?";
          const sender = pathText(message, "sender", "displayName") ?? "unknown";
          const when = text(message.createTime) ?? "";
          const body = sanitizeRemoteText(
            message.text ?? message.formattedText ?? message.argumentText,
            1000,
          );
          return `- ${sanitizeRemoteText(name, 160)} ${sanitizeRemoteText(when, 40)} ${sanitizeRemoteText(sender, 80)}: ${body}`;
        });
        return frameUntrusted(
          [
            `## Search results (${results.shown.length})`,
            ...lines,
            moreLine(results.hidden),
            pagingLine(results.shown.length, text(payload.nextPageToken)),
          ].join("\n"),
        );
      },
    },
    {
      name: "google_chat_list_memberships",
      description:
        "List members of a Google Chat space, optionally filtered by role or member type. Requires OAuth user mode.",
      inputSchema: objectSchema(
        {
          space: SPACE_SCHEMA,
          pageSize: { type: "integer", minimum: 1, maximum: 1000 },
          pageToken: PAGE_TOKEN_SCHEMA,
          role: { type: "string", enum: ["ROLE_MEMBER", "ROLE_MANAGER"] },
          memberType: { type: "string", enum: ["HUMAN", "BOT"] },
        },
        ["space"],
      ),
      run: async (input, context) => {
        const parsed = parseListMembershipsInput(input);
        const value = await client.request({
          method: "GET",
          path: `/v1/${parsed.space}/members`,
          query: {
            pageSize: parsed.pageSize,
            pageToken: parsed.pageToken,
            filter: parsed.filter,
          },
          signal: context.signal,
          idempotent: true,
        });
        const payload = record(value) ?? {};
        const members = bounded(array(payload.memberships), 25);
        const lines = members.shown.map((item) => {
          const name = text(record(item)?.name) ?? "?";
          const role = text(record(item)?.role) ?? "";
          const type = pathText(item, "member", "type") ?? "";
          const display = pathText(item, "member", "displayName") ?? "";
          const member = pathText(item, "member", "name") ?? "";
          return `- ${sanitizeRemoteText(name, 160)} ${sanitizeRemoteText(role, 40)} [${sanitizeRemoteText(type, 20)}] ${sanitizeRemoteText(display, 120)} ${sanitizeRemoteText(member, 160)}`;
        });
        return frameUntrusted(
          [
            `## Memberships (${members.shown.length})`,
            ...lines,
            moreLine(members.hidden),
            pagingLine(members.shown.length, text(payload.nextPageToken)),
          ].join("\n"),
        );
      },
    },
  ];

  const writes: ToolSpec[] = [
    {
      name: "google_chat_send_message",
      description:
        "Send a message to a Google Chat space. Uses OAuth user identity when authenticated, otherwise the configured incoming webhook. Supports thread replies.",
      inputSchema: objectSchema(
        {
          space: {
            type: "string",
            minLength: 1,
            maxLength: 250,
            description:
              "Required in OAuth user mode; with a webhook it must match the webhook's space when provided.",
          },
          text: TEXT_SCHEMA,
          threadKey: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Starts or replies to a thread by key.",
          },
          replyOption: {
            type: "string",
            enum: ["REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD", "REPLY_MESSAGE_OR_FAIL"],
          },
          messageId: {
            type: "string",
            pattern: "^client-[a-z0-9-]{1,56}$",
            description: "Client-assigned message id; OAuth user mode only.",
          },
        },
        ["text"],
      ),
      run: async (input, context) => {
        const parsed = parseSendMessageInput(input);
        const result = await client.send({
          space: parsed.space,
          text: parsed.text,
          threadKey: parsed.threadKey,
          replyOption: parsed.replyOption,
          messageId: parsed.messageId,
          signal: context.signal,
        });
        const message = record(result.message) ?? {};
        return frameUntrusted(
          joinLines([
            `Sent via ${result.via}.`,
            kv("Message", text(message.name), 160),
            kv("Thread", pathText(message, "thread", "name"), 160),
            kv("Text", parsed.text, 2000),
          ]),
        );
      },
    },
    {
      name: "google_chat_edit_message",
      description:
        "Edit the text of a Google Chat message the authenticated user owns. Requires OAuth user mode; only the text field can be changed.",
      inputSchema: objectSchema({ message: MESSAGE_SCHEMA, text: TEXT_SCHEMA }, [
        "message",
        "text",
      ]),
      run: async (input, context) => {
        const parsed = parseEditMessageInput(input);
        const value = await client.request({
          method: "PATCH",
          path: `/v1/${parsed.message}`,
          query: { updateMask: "text" },
          body: { text: parsed.text },
          signal: context.signal,
        });
        const message = record(value) ?? {};
        return frameUntrusted(
          joinLines([
            `Edited message ${sanitizeRemoteText(parsed.message, 160)}.`,
            kv("Updated", text(message.lastUpdateTime), 40),
            kv("Text", text(message.text) ?? parsed.text, 2000),
          ]),
        );
      },
    },
    {
      name: "google_chat_delete_message",
      description:
        "Delete a Google Chat message the authenticated user owns. Requires OAuth user mode.",
      inputSchema: objectSchema({ message: MESSAGE_SCHEMA }, ["message"]),
      run: async (input, context) => {
        const parsed = parseDeleteMessageInput(input);
        await client.request({
          method: "DELETE",
          path: `/v1/${parsed.message}`,
          signal: context.signal,
        });
        return `Deleted ${parsed.message}.`;
      },
    },
  ];

  return [...reads.map(externalTool), ...writes.map(writeTool)];
}
