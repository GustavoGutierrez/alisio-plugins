import { AtlassianError } from "./errors.js";
import { hasControlCharacters } from "./text.js";

/** Stable identifier grammars shared by the JSON schemas and local validation. */
export const PATTERNS = {
  issueKey: /^[A-Z][A-Z0-9_]{1,49}-[0-9]{1,10}$/,
  projectKeyOrId: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
  numericId: /^[0-9]{1,20}$/,
  accountId: /^[A-Za-z0-9:_-]{1,128}$/,
  fieldName: /^[*+-]?[A-Za-z_][A-Za-z0-9_.-]{0,63}$/,
  label: /^[A-Za-z0-9][A-Za-z0-9 _-]{0,254}$/,
  epicIdOrKey: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  cursor: /^[A-Za-z0-9._~+/=-]{1,2048}$/,
  typeName: /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/,
} as const;

/** Hard local cap on Agile issue moves, matching the REST limit. */
export const MAX_AGILE_MOVE_ISSUES = 50;

export const DEFAULT_ISSUE_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "labels",
  "created",
  "updated",
  "description",
] as const;

const UNSAFE_TEXT = hasControlCharacters;

export function invalid(detail: string): never {
  throw new AtlassianError("invalid input", detail);
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
  if (UNSAFE_TEXT(text)) invalid(`"${name}" contains control characters`);
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

function requiredInt(value: unknown, name: string, min: number, max: number): number {
  const parsed = optionalInt(value, name, min, max);
  if (parsed === undefined) invalid(`"${name}" is required`);
  return parsed;
}

function optionalBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`"${name}" must be a boolean`);
  return value;
}

function pattern(value: string, name: string, shape: RegExp): string {
  if (!shape.test(value)) invalid(`"${name}" is not a valid identifier`);
  return value;
}

function optionalPattern(value: unknown, name: string, shape: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(`"${name}" must be a string`);
  const text = value.trim();
  if (text === "") return undefined;
  return pattern(text, name, shape);
}

interface StringListOptions {
  minItems: number;
  maxItems: number;
  maxLength: number;
  pattern?: RegExp;
  tooMany: string;
}

function stringList(value: unknown, name: string, options: StringListOptions): string[] {
  if (!Array.isArray(value)) invalid(`"${name}" must be an array of strings`);
  if (value.length < options.minItems) invalid(`"${name}" must not be empty`);
  if (value.length > options.maxItems) invalid(options.tooMany);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") invalid(`"${name}" must contain only strings`);
    const text = item.trim();
    if (text === "" || text.length > options.maxLength)
      invalid(`"${name}" contains an invalid entry`);
    if (UNSAFE_TEXT(text)) invalid(`"${name}" contains control characters`);
    out.push(options.pattern ? pattern(text, name, options.pattern) : text);
  }
  return out;
}

const issueKey = (value: unknown): string =>
  pattern(requiredText(value, "issueKey", 1, 64), "issueKey", PATTERNS.issueKey);
const numericId = (value: unknown, name: string): string =>
  pattern(requiredText(value, name, 1, 20), name, PATTERNS.numericId);

export interface IssueRef {
  issueKey: string;
}

export function parseIssueRef(input: unknown): IssueRef {
  const v = parseInput(input, ["issueKey"]);
  return { issueKey: issueKey(v.issueKey) };
}

export interface SearchInput {
  jql: string;
  fields: string[];
  maxResults: number;
  nextPageToken: string | undefined;
}

export function parseSearchInput(input: unknown): SearchInput {
  const v = parseInput(input, ["jql", "fields", "maxResults", "nextPageToken"]);
  const jql = requiredText(v.jql, "jql", 1, 4096);
  if (!/\S/.test(jql)) invalid("jql must not be blank");
  const fields =
    v.fields === undefined
      ? [...DEFAULT_ISSUE_FIELDS]
      : stringList(v.fields, "fields", {
          minItems: 1,
          maxItems: 50,
          maxLength: 64,
          pattern: PATTERNS.fieldName,
          tooMany: "fields accepts at most 50 entries",
        });
  return {
    jql,
    fields,
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 100) ?? 50,
    nextPageToken: optionalPattern(v.nextPageToken, "nextPageToken", PATTERNS.cursor),
  };
}

export interface CommentsInput extends IssueRef {
  maxResults: number;
  startAt: number;
}

export function parseCommentsInput(input: unknown): CommentsInput {
  const v = parseInput(input, ["issueKey", "maxResults", "startAt"]);
  return {
    issueKey: issueKey(v.issueKey),
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 100) ?? 25,
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
  };
}

export type WorklogsInput = CommentsInput;

export function parseWorklogsInput(input: unknown): WorklogsInput {
  return parseCommentsInput(input);
}

export interface ProjectsInput {
  query: string | undefined;
  maxResults: number;
  startAt: number;
}

export function parseProjectsInput(input: unknown): ProjectsInput {
  const v = parseInput(input, ["query", "maxResults", "startAt"]);
  return {
    query: optionalText(v.query, "query", 1, 128),
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 100) ?? 50,
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
  };
}

export interface VersionsInput {
  projectIdOrKey: string;
  maxResults: number;
  startAt: number;
}

export function parseVersionsInput(input: unknown): VersionsInput {
  const v = parseInput(input, ["projectIdOrKey", "maxResults", "startAt"]);
  return {
    projectIdOrKey: pattern(
      requiredText(v.projectIdOrKey, "projectIdOrKey", 1, 64),
      "projectIdOrKey",
      PATTERNS.projectKeyOrId,
    ),
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 100) ?? 50,
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
  };
}

export interface UserInput {
  accountId: string;
}

export function parseUserInput(input: unknown): UserInput {
  const v = parseInput(input, ["accountId"]);
  return {
    accountId: pattern(
      requiredText(v.accountId, "accountId", 1, 128),
      "accountId",
      PATTERNS.accountId,
    ),
  };
}

export function parseEmptyInput(input: unknown): Record<string, never> {
  parseInput(input, []);
  return {};
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description: string | undefined;
  labels: string[] | undefined;
  assigneeAccountId: string | undefined;
  priority: string | undefined;
}

export function parseCreateIssueInput(input: unknown): CreateIssueInput {
  const v = parseInput(input, [
    "projectKey",
    "issueType",
    "summary",
    "description",
    "labels",
    "assigneeAccountId",
    "priority",
  ]);
  return {
    projectKey: pattern(
      requiredText(v.projectKey, "projectKey", 1, 64),
      "projectKey",
      PATTERNS.projectKeyOrId,
    ),
    issueType: pattern(
      requiredText(v.issueType, "issueType", 1, 64),
      "issueType",
      PATTERNS.typeName,
    ),
    summary: requiredText(v.summary, "summary", 1, 255),
    description: optionalText(v.description, "description", 1, 32_768),
    labels:
      v.labels === undefined
        ? undefined
        : stringList(v.labels, "labels", {
            minItems: 1,
            maxItems: 20,
            maxLength: 255,
            pattern: PATTERNS.label,
            tooMany: "labels accepts at most 20 entries",
          }),
    assigneeAccountId: optionalPattern(
      v.assigneeAccountId,
      "assigneeAccountId",
      PATTERNS.accountId,
    ),
    priority: optionalPattern(v.priority, "priority", PATTERNS.typeName),
  };
}

export interface UpdateIssueInput {
  issueKey: string;
  summary: string | undefined;
  description: string | undefined;
  labels: string[] | undefined;
  assigneeAccountId: string | undefined;
  priority: string | undefined;
}

export function parseUpdateIssueInput(input: unknown): UpdateIssueInput {
  const v = parseInput(input, [
    "issueKey",
    "summary",
    "description",
    "labels",
    "assigneeAccountId",
    "priority",
  ]);
  const result: UpdateIssueInput = {
    issueKey: issueKey(v.issueKey),
    summary: optionalText(v.summary, "summary", 1, 255),
    description: optionalText(v.description, "description", 1, 32_768),
    labels:
      v.labels === undefined
        ? undefined
        : stringList(v.labels, "labels", {
            minItems: 0,
            maxItems: 20,
            maxLength: 255,
            pattern: PATTERNS.label,
            tooMany: "labels accepts at most 20 entries",
          }),
    assigneeAccountId: optionalPattern(
      v.assigneeAccountId,
      "assigneeAccountId",
      PATTERNS.accountId,
    ),
    priority: optionalPattern(v.priority, "priority", PATTERNS.typeName),
  };
  if (
    result.summary === undefined &&
    result.description === undefined &&
    result.labels === undefined &&
    result.assigneeAccountId === undefined &&
    result.priority === undefined
  )
    invalid("provide at least one field to update");
  return result;
}

export interface CommentInput extends IssueRef {
  body: string;
}

export function parseCommentInput(input: unknown): CommentInput {
  const v = parseInput(input, ["issueKey", "body"]);
  return { issueKey: issueKey(v.issueKey), body: requiredText(v.body, "body", 1, 32_768) };
}

export interface TransitionInput extends IssueRef {
  transitionId: string;
}

export function parseTransitionInput(input: unknown): TransitionInput {
  const v = parseInput(input, ["issueKey", "transitionId"]);
  return {
    issueKey: issueKey(v.issueKey),
    transitionId: numericId(v.transitionId, "transitionId"),
  };
}

export interface WorklogInput extends IssueRef {
  timeSpentSeconds: number;
  comment: string | undefined;
}

export function parseWorklogInput(input: unknown): WorklogInput {
  const v = parseInput(input, ["issueKey", "timeSpentSeconds", "comment"]);
  return {
    issueKey: issueKey(v.issueKey),
    timeSpentSeconds: requiredInt(v.timeSpentSeconds, "timeSpentSeconds", 1, 31_536_000),
    comment: optionalText(v.comment, "comment", 1, 32_768),
  };
}

export interface LinkInput {
  type: string;
  inwardIssueKey: string;
  outwardIssueKey: string;
}

export function parseLinkInput(input: unknown): LinkInput {
  const v = parseInput(input, ["type", "inwardIssueKey", "outwardIssueKey"]);
  return {
    type: pattern(requiredText(v.type, "type", 1, 64), "type", PATTERNS.typeName),
    inwardIssueKey: issueKey(v.inwardIssueKey),
    outwardIssueKey: issueKey(v.outwardIssueKey),
  };
}

export interface PageIdInput {
  pageId: string;
}

export function parsePageIdInput(input: unknown): PageIdInput {
  const v = parseInput(input, ["pageId"]);
  return { pageId: numericId(v.pageId, "pageId") };
}

export interface PageByUrlInput {
  url: string;
}

export function parsePageByUrlInput(input: unknown): PageByUrlInput {
  const v = parseInput(input, ["url"]);
  return { url: requiredText(v.url, "url", 1, 2048) };
}

export interface ConfluenceSearchInput {
  spaceId: string | undefined;
  title: string | undefined;
  status: string | undefined;
  cursor: string | undefined;
  limit: number;
}

export function parseConfluenceSearchInput(input: unknown): ConfluenceSearchInput {
  const v = parseInput(input, ["spaceId", "title", "status", "cursor", "limit"]);
  return {
    spaceId: v.spaceId === undefined ? undefined : numericId(v.spaceId, "spaceId"),
    title: optionalText(v.title, "title", 1, 255),
    status: optionalPattern(v.status, "status", /^(current|draft|archived|trashed)$/),
    cursor: optionalPattern(v.cursor, "cursor", PATTERNS.cursor),
    limit: optionalInt(v.limit, "limit", 1, 100) ?? 25,
  };
}

export interface ListSpacesInput {
  cursor: string | undefined;
  limit: number;
}

export function parseListSpacesInput(input: unknown): ListSpacesInput {
  const v = parseInput(input, ["cursor", "limit"]);
  return {
    cursor: optionalPattern(v.cursor, "cursor", PATTERNS.cursor),
    limit: optionalInt(v.limit, "limit", 1, 100) ?? 25,
  };
}

export interface ConfluenceCommentsInput extends PageIdInput {
  cursor: string | undefined;
  limit: number;
}

export function parseConfluenceCommentsInput(input: unknown): ConfluenceCommentsInput {
  const v = parseInput(input, ["pageId", "cursor", "limit"]);
  return {
    pageId: numericId(v.pageId, "pageId"),
    cursor: optionalPattern(v.cursor, "cursor", PATTERNS.cursor),
    limit: optionalInt(v.limit, "limit", 1, 100) ?? 25,
  };
}

export interface ConfluenceCreatePageInput {
  spaceId: string;
  title: string;
  body: string;
  parentId: string | undefined;
}

export function parseConfluenceCreatePageInput(input: unknown): ConfluenceCreatePageInput {
  const v = parseInput(input, ["spaceId", "title", "body", "parentId"]);
  return {
    spaceId: numericId(v.spaceId, "spaceId"),
    title: requiredText(v.title, "title", 1, 255),
    body: requiredText(v.body, "body", 1, 32_768),
    parentId: v.parentId === undefined ? undefined : numericId(v.parentId, "parentId"),
  };
}

export interface ConfluenceUpdatePageInput extends PageIdInput {
  title: string;
  body: string;
  versionNumber: number;
}

export function parseConfluenceUpdatePageInput(input: unknown): ConfluenceUpdatePageInput {
  const v = parseInput(input, ["pageId", "title", "body", "versionNumber"]);
  return {
    pageId: numericId(v.pageId, "pageId"),
    title: requiredText(v.title, "title", 1, 255),
    body: requiredText(v.body, "body", 1, 32_768),
    versionNumber: requiredInt(v.versionNumber, "versionNumber", 1, 2_147_483_647),
  };
}

export interface ConfluenceCommentInput extends PageIdInput {
  body: string;
}

export function parseConfluenceCommentInput(input: unknown): ConfluenceCommentInput {
  const v = parseInput(input, ["pageId", "body"]);
  return { pageId: numericId(v.pageId, "pageId"), body: requiredText(v.body, "body", 1, 32_768) };
}

export interface BoardsInput {
  startAt: number;
  maxResults: number;
}

export function parseBoardsInput(input: unknown): BoardsInput {
  const v = parseInput(input, ["startAt", "maxResults"]);
  return {
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 50) ?? 50,
  };
}

export interface SprintsInput {
  boardId: string;
  state: string | undefined;
  startAt: number;
  maxResults: number;
}

export function parseSprintsInput(input: unknown): SprintsInput {
  const v = parseInput(input, ["boardId", "state", "startAt", "maxResults"]);
  return {
    boardId: numericId(v.boardId, "boardId"),
    state: optionalPattern(v.state, "state", /^(future|active|closed)$/),
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 50) ?? 50,
  };
}

export interface BacklogInput {
  boardId: string;
  startAt: number;
  maxResults: number;
}

export function parseBacklogInput(input: unknown): BacklogInput {
  const v = parseInput(input, ["boardId", "startAt", "maxResults"]);
  return {
    boardId: numericId(v.boardId, "boardId"),
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 50) ?? 50,
  };
}

export interface EpicsInput extends BacklogInput {
  done: boolean | undefined;
}

export function parseEpicsInput(input: unknown): EpicsInput {
  const v = parseInput(input, ["boardId", "done", "startAt", "maxResults"]);
  return {
    boardId: numericId(v.boardId, "boardId"),
    done: optionalBool(v.done, "done"),
    startAt: optionalInt(v.startAt, "startAt", 0, 100_000) ?? 0,
    maxResults: optionalInt(v.maxResults, "maxResults", 1, 50) ?? 50,
  };
}

export interface MoveIssuesInput {
  destination: "sprint" | "backlog" | "epic";
  sprintId: string | undefined;
  epicIdOrKey: string | undefined;
  issueKeys: string[];
}

export function parseMoveIssuesInput(input: unknown): MoveIssuesInput {
  const v = parseInput(input, ["destination", "sprintId", "epicIdOrKey", "issueKeys"]);
  const destination = v.destination;
  if (destination !== "sprint" && destination !== "backlog" && destination !== "epic")
    invalid('"destination" must be "sprint", "backlog", or "epic"');
  const issueKeys = stringList(v.issueKeys, "issueKeys", {
    minItems: 1,
    maxItems: MAX_AGILE_MOVE_ISSUES,
    maxLength: 64,
    pattern: PATTERNS.issueKey,
    tooMany: `at most ${MAX_AGILE_MOVE_ISSUES} issues can be moved per request`,
  });
  if (destination === "sprint" && v.sprintId === undefined)
    invalid('"sprintId" is required when destination is "sprint"');
  if (destination === "epic" && v.epicIdOrKey === undefined)
    invalid('"epicIdOrKey" is required when destination is "epic"');
  return {
    destination,
    sprintId: v.sprintId === undefined ? undefined : numericId(v.sprintId, "sprintId"),
    epicIdOrKey:
      v.epicIdOrKey === undefined
        ? undefined
        : pattern(
            requiredText(v.epicIdOrKey, "epicIdOrKey", 1, 64),
            "epicIdOrKey",
            PATTERNS.epicIdOrKey,
          ),
    issueKeys,
  };
}
