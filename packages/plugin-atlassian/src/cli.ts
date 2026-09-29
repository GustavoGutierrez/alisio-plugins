#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { type Environment, loadConfig } from "./config.js";
import { buildPageReport, extractPageId } from "./confluence.js";
import { safeMessage } from "./errors.js";
import { type Clock, createClient, type Fetcher } from "./http.js";
import { buildIssueReport } from "./jira.js";
import { frameUntrusted } from "./text.js";
import { PATTERNS } from "./validation.js";

const CLI_TIMEOUT_MS = 30_000;

const USAGE = [
  "Usage: alisio-atlassian <command> [args]",
  "",
  "Commands:",
  "  jira <ISSUE-KEY> [--context]   Show a Jira issue; --context adds comments and transitions",
  "  confluence <page-id-or-url>    Show a Confluence page",
  "  --help                         Show this help",
  "",
  "Configuration is read from ATLASSIAN_BASE_URL or ATLASSIAN_DOMAIN, ATLASSIAN_EMAIL,",
  "and ATLASSIAN_API_TOKEN. Writes are never available from this CLI.",
].join("\n");

export interface CliIo {
  env: Environment;
  fetcher?: Fetcher;
  clock?: Clock;
  write: (text: string) => void;
  writeError: (text: string) => void;
}

function signal(): AbortSignal {
  return AbortSignal.timeout(CLI_TIMEOUT_MS);
}

/**
 * Run one local development command. Returns the process exit code: 0 on
 * success, 2 for usage or configuration errors, and 1 for API failures. The
 * token never appears in any output.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.write(USAGE);
    return 0;
  }

  if (command !== "jira" && command !== "confluence") {
    io.writeError(`unknown command: ${command}`);
    io.writeError(USAGE);
    return 2;
  }

  const target = rest[0];
  const extras = rest.slice(1);
  let load: (client: ReturnType<typeof createClient>) => Promise<string>;

  if (command === "jira") {
    const context = extras.includes("--context");
    const unknown = extras.filter((token) => token !== "--context");
    if (target === undefined || !PATTERNS.issueKey.test(target) || unknown.length > 0) {
      io.writeError(USAGE);
      return 2;
    }
    load = (client) =>
      buildIssueReport(client, target, { comments: context, transitions: context }, signal());
  } else {
    if (target === undefined || extras.length > 0) {
      io.writeError(USAGE);
      return 2;
    }
    let pageId: string;
    try {
      pageId = PATTERNS.numericId.test(target) ? target : extractPageId(target);
    } catch {
      io.writeError(USAGE);
      return 2;
    }
    load = (client) => buildPageReport(client, pageId, signal());
  }

  let client: ReturnType<typeof createClient>;
  try {
    client = createClient(loadConfig(io.env), io.fetcher ?? fetch, io.clock);
  } catch (error) {
    io.writeError(`configuration error: ${safeMessage(error)}`);
    return 2;
  }

  try {
    io.write(frameUntrusted(await load(client)));
    return 0;
  } catch (error) {
    io.writeError(`error: ${safeMessage(error)}`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    write: (text) => process.stdout.write(`${text}\n`),
    writeError: (text) => process.stderr.write(`${text}\n`),
  });
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((error) => {
    process.stderr.write(`error: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
