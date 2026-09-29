import type { PluginAPI } from "@alisio/sdk";
import { buildPageReport, extractPageId } from "./confluence.js";
import { safeMessage } from "./errors.js";
import type { AtlassianClient } from "./http.js";
import { buildIssueReport } from "./jira.js";
import { frameUntrusted } from "./text.js";
import { PATTERNS } from "./validation.js";

export const COMMAND_NAMES = [
  "jira-issue",
  "get-jira-issue",
  "story-context",
  "confluence-page",
  "get-confluence-page",
] as const;

const COMMAND_TIMEOUT_MS = 30_000;
const ISSUE_USAGE = "Usage: /atlassian:jira-issue <ISSUE-KEY> [--context]";
const CONFLUENCE_USAGE = "Usage: /atlassian:confluence-page <page-id-or-url>";

function signal(): AbortSignal {
  return AbortSignal.timeout(COMMAND_TIMEOUT_MS);
}

function tokens(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
}

async function issueCommand(
  args: string,
  client: AtlassianClient,
  withContext: boolean,
): Promise<string> {
  const parts = tokens(args);
  const key = parts[0];
  if (key === undefined || !PATTERNS.issueKey.test(key)) return ISSUE_USAGE;
  const extras = parts.slice(1).filter((token) => token !== "--context");
  if (extras.length > 0) return ISSUE_USAGE;
  const context = withContext || parts.includes("--context");
  try {
    return frameUntrusted(
      await buildIssueReport(client, key, { comments: context, transitions: context }, signal()),
    );
  } catch (error) {
    return `Atlassian error: ${safeMessage(error)}`;
  }
}

async function pageCommand(args: string, client: AtlassianClient): Promise<string> {
  const parts = tokens(args);
  const target = parts[0];
  if (target === undefined || parts.length !== 1) return CONFLUENCE_USAGE;
  let pageId: string;
  try {
    pageId = PATTERNS.numericId.test(target) ? target : extractPageId(target);
  } catch {
    return CONFLUENCE_USAGE;
  }
  try {
    return frameUntrusted(await buildPageReport(client, pageId, signal()));
  } catch (error) {
    return `Atlassian error: ${safeMessage(error)}`;
  }
}

/** Register the read-only slash commands. Alisio exposes them as `atlassian:<name>`. */
export function registerCommands(api: PluginAPI, client: AtlassianClient): void {
  const register = (
    name: (typeof COMMAND_NAMES)[number],
    description: string,
    argumentHint: string,
    handler: (args: string) => Promise<string>,
  ): void => {
    api.commands.register(name, handler, { description, argumentHint });
  };

  register(
    "jira-issue",
    "Show a Jira issue, optionally with comments and transitions",
    "<ISSUE-KEY> [--context]",
    (args) => issueCommand(args, client, false),
  );
  register("get-jira-issue", "Show a Jira issue by key", "<ISSUE-KEY>", (args) =>
    issueCommand(args, client, false),
  );
  register(
    "story-context",
    "Show a Jira issue with its comments and transitions",
    "<ISSUE-KEY>",
    (args) => issueCommand(args, client, true),
  );
  register(
    "confluence-page",
    "Show a Confluence page from an id or link",
    "<page-id-or-url>",
    (args) => pageCommand(args, client),
  );
  register(
    "get-confluence-page",
    "Show a Confluence page from an id or link",
    "<page-id-or-url>",
    (args) => pageCommand(args, client),
  );
}
