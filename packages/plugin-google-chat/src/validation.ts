import { GoogleChatError } from "./errors.js";
import { hasControlCharacters } from "./text.js";

/** Stable identifier grammars shared by the JSON schemas and local validation. */
export const PATTERNS = {
  spaceId: /^[A-Za-z0-9_-]{1,200}$/,
  messageName: /^spaces\/[A-Za-z0-9_-]{1,200}\/messages\/[A-Za-z0-9_.-]{1,200}$/,
  userReference: /^[A-Za-z0-9._%+@-]{1,200}$/,
  pageToken: /^[A-Za-z0-9._~+/=-]{1,4096}$/,
  clientMessageId: /^client-[a-z0-9-]{1,56}$/,
} as const;

/** Google Chat's documented maximum message size. */
export const MAX_MESSAGE_BYTES = 32_000;

export function invalid(detail: string): never {
  throw new GoogleChatError("invalid input", detail);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("expected an object with named fields");
  return value as Record<string, unknown>;
}

/** Reject unknown fields so every tool object is closed. */
export function parseInput(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = asObject(input);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`unknown field "${key}"`);
  return value;
}

function requiredText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") invalid(`"${name}" must be a string`);
  const text = value.trim();
  if (text.length < min) invalid(`"${name}" is too short`);
  if (text.length > max) invalid(`"${name}" is too long`);
  if (hasControlCharacters(text)) invalid(`"${name}" contains control characters`);
  return text;
}

function optionalText(value: unknown, name: string, min: number, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, name, min, max);
}

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    invalid(`"${name}" must be an integer`);
  if (value < min || value > max) invalid(`"${name}" must be between ${min} and ${max}`);
  return value;
}

function optionalBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`"${name}" must be a boolean`);
  return value;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    invalid(`"${name}" must be one of ${allowed.join(", ")}`);
  return value as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return enumValue(value, name, allowed);
}

function pattern(value: string, name: string, shape: RegExp, hint: string): string {
  if (!shape.test(value)) invalid(`${name} must be ${hint}`);
  return value;
}

/** Accept a bare space id or a `spaces/{id}` resource name; return the latter. */
export function normalizeSpace(value: unknown): string {
  const raw = requiredText(value, "space", 1, 250);
  const id = raw.startsWith("spaces/") ? raw.slice("spaces/".length) : raw;
  pattern(id, '"space"', PATTERNS.spaceId, "a space id or a spaces/{id} resource name");
  return `spaces/${id}`;
}

/** Require a full `spaces/{space}/messages/{message}` resource name. */
export function normalizeMessageName(value: unknown): string {
  const raw = requiredText(value, "message", 1, 420);
  return pattern(
    raw,
    '"message"',
    PATTERNS.messageName,
    'a full resource name like "spaces/AAA/messages/BBB"',
  );
}

/**
 * Normalize a user reference to `users/{user}`. Accepts an email, a user id, a
 * `users/{user}` resource name, and a leading `@` (the Chat mention form).
 */
export function normalizeUserReference(value: unknown): string {
  const raw = requiredText(value, "sender", 1, 220);
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  if (withoutAt === "users/me") return "users/me";
  const user = withoutAt.startsWith("users/") ? withoutAt.slice("users/".length) : withoutAt;
  pattern(
    user,
    '"sender"',
    PATTERNS.userReference,
    "an email, a user id, or a users/{user} resource name",
  );
  return `users/${user}`;
}

function messageText(value: unknown): string {
  if (typeof value !== "string") invalid('"text" must be a string');
  if (value.length === 0) invalid('"text" must not be empty');
  if (value.includes("\u0000")) invalid('"text" must not contain a NUL character');
  if (new TextEncoder().encode(value).length > MAX_MESSAGE_BYTES)
    invalid(`"text" exceeds the ${MAX_MESSAGE_BYTES}-byte Google Chat message limit`);
  return value;
}

const LIST_PAGE_MAX = 1000;
const SEARCH_PAGE_MAX = 100;

export interface ListSpacesInput {
  pageSize: number;
  pageToken: string | undefined;
  spaceType: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE" | undefined;
}

export function parseListSpacesInput(input: unknown): ListSpacesInput {
  const v = parseInput(input, ["pageSize", "pageToken", "spaceType"]);
  return {
    pageSize: optionalInt(v.pageSize, "pageSize", 1, LIST_PAGE_MAX) ?? 25,
    pageToken:
      v.pageToken === undefined || v.pageToken === null
        ? undefined
        : pattern(
            requiredText(v.pageToken, "pageToken", 1, 4096),
            '"pageToken"',
            PATTERNS.pageToken,
            "a valid page token",
          ),
    spaceType: optionalEnum(v.spaceType, "spaceType", ["SPACE", "GROUP_CHAT", "DIRECT_MESSAGE"]),
  };
}

export interface ListMessagesInput {
  space: string;
  pageSize: number;
  pageToken: string | undefined;
  filter: string | undefined;
  orderBy: "createTime ASC" | "createTime DESC" | undefined;
  showDeleted: boolean | undefined;
}

export function parseListMessagesInput(input: unknown): ListMessagesInput {
  const v = parseInput(input, [
    "space",
    "pageSize",
    "pageToken",
    "filter",
    "orderBy",
    "showDeleted",
  ]);
  return {
    space: normalizeSpace(v.space),
    pageSize: optionalInt(v.pageSize, "pageSize", 1, LIST_PAGE_MAX) ?? 25,
    pageToken:
      v.pageToken === undefined || v.pageToken === null
        ? undefined
        : pattern(
            requiredText(v.pageToken, "pageToken", 1, 4096),
            '"pageToken"',
            PATTERNS.pageToken,
            "a valid page token",
          ),
    filter: optionalText(v.filter, "filter", 1, 1024),
    orderBy: optionalEnum(v.orderBy, "orderBy", ["createTime ASC", "createTime DESC"]),
    showDeleted: optionalBool(v.showDeleted, "showDeleted"),
  };
}

export interface SearchMessagesInput {
  filter: string;
  pageSize: number;
  pageToken: string | undefined;
  orderBy: "createTime desc" | "relevance desc" | undefined;
  view: "SEARCH_MESSAGES_VIEW_BASIC" | "SEARCH_MESSAGES_VIEW_FULL" | undefined;
}

export function parseSearchMessagesInput(input: unknown): SearchMessagesInput {
  const v = parseInput(input, ["query", "sender", "pageSize", "pageToken", "orderBy", "view"]);
  const query = requiredText(v.query, "query", 1, 1000);
  const sender =
    v.sender === undefined || v.sender === null ? undefined : normalizeUserReference(v.sender);
  const filter = sender === undefined ? query : `sender.name = "${sender}" AND ${query}`;
  return {
    filter,
    pageSize: optionalInt(v.pageSize, "pageSize", 1, SEARCH_PAGE_MAX) ?? 25,
    pageToken:
      v.pageToken === undefined || v.pageToken === null
        ? undefined
        : pattern(
            requiredText(v.pageToken, "pageToken", 1, 4096),
            '"pageToken"',
            PATTERNS.pageToken,
            "a valid page token",
          ),
    orderBy: optionalEnum(v.orderBy, "orderBy", ["createTime desc", "relevance desc"]),
    view: optionalEnum(v.view, "view", ["SEARCH_MESSAGES_VIEW_BASIC", "SEARCH_MESSAGES_VIEW_FULL"]),
  };
}

export interface ListMembershipsInput {
  space: string;
  pageSize: number;
  pageToken: string | undefined;
  filter: string | undefined;
}

export function parseListMembershipsInput(input: unknown): ListMembershipsInput {
  const v = parseInput(input, ["space", "pageSize", "pageToken", "role", "memberType"]);
  const role = optionalEnum(v.role, "role", ["ROLE_MEMBER", "ROLE_MANAGER"]);
  const memberType = optionalEnum(v.memberType, "memberType", ["HUMAN", "BOT"]);
  const clauses: string[] = [];
  if (role !== undefined) clauses.push(`role = "${role}"`);
  if (memberType !== undefined) clauses.push(`member.type = "${memberType}"`);
  return {
    space: normalizeSpace(v.space),
    pageSize: optionalInt(v.pageSize, "pageSize", 1, LIST_PAGE_MAX) ?? 25,
    pageToken:
      v.pageToken === undefined || v.pageToken === null
        ? undefined
        : pattern(
            requiredText(v.pageToken, "pageToken", 1, 4096),
            '"pageToken"',
            PATTERNS.pageToken,
            "a valid page token",
          ),
    filter: clauses.length > 0 ? clauses.join(" AND ") : undefined,
  };
}

export interface SendMessageInput {
  space: string | undefined;
  text: string;
  threadKey: string | undefined;
  replyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" | "REPLY_MESSAGE_OR_FAIL" | undefined;
  messageId: string | undefined;
}

export function parseSendMessageInput(input: unknown): SendMessageInput {
  const v = parseInput(input, ["space", "text", "threadKey", "replyOption", "messageId"]);
  return {
    space: v.space === undefined || v.space === null ? undefined : normalizeSpace(v.space),
    text: messageText(v.text),
    threadKey: optionalText(v.threadKey, "threadKey", 1, 4000),
    replyOption: optionalEnum(v.replyOption, "replyOption", [
      "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      "REPLY_MESSAGE_OR_FAIL",
    ]),
    messageId:
      v.messageId === undefined || v.messageId === null
        ? undefined
        : pattern(
            requiredText(v.messageId, "messageId", 1, 63),
            '"messageId"',
            PATTERNS.clientMessageId,
            'a client-assigned id like "client-my-id"',
          ),
  };
}

export interface EditMessageInput {
  message: string;
  text: string;
}

export function parseEditMessageInput(input: unknown): EditMessageInput {
  const v = parseInput(input, ["message", "text"]);
  return { message: normalizeMessageName(v.message), text: messageText(v.text) };
}

export interface DeleteMessageInput {
  message: string;
}

export function parseDeleteMessageInput(input: unknown): DeleteMessageInput {
  const v = parseInput(input, ["message"]);
  return { message: normalizeMessageName(v.message) };
}
