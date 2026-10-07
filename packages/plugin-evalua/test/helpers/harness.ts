import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskQuestionsRequest, PluginAPI, ToolDefinition } from "@alisio/sdk";
import type { PdfPrinter } from "../../src/build.js";
import { fixedClock } from "../../src/clock.js";
import { registerEvalua } from "../../src/index.js";
import type { TopicCatalog } from "../../src/types.js";

type Answers = Record<string, string | string[] | undefined>;

const dirs: string[] = [];
export async function cleanup() {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
export async function scratchDir(prefix = "evalua-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export interface HarnessOptions {
  interactive?: boolean;
  answers?: Answers[];
  workspace?: string;
  catalog?: TopicCatalog;
  printer?: PdfPrinter;
  now?: string;
}

/** A fake PluginAPI: records registrations and scripts `askQuestions`. */
export async function harness(options: HarnessOptions = {}) {
  const workspace = options.workspace ?? (await scratchDir());
  const answers = [...(options.answers ?? [])];
  const asked: AskQuestionsRequest[] = [];
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const tools = new Map<string, ToolDefinition>();
  const resources = { agents: 0, skills: 0 };
  let interactive = options.interactive ?? true;
  const api = {
    commands: {
      register: (name: string, handler: never) => {
        commands.set(name, handler);
        return () => undefined;
      },
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => undefined;
      },
    },
    resources: {
      agents: () => {
        resources.agents += 1;
      },
      skills: () => {
        resources.skills += 1;
      },
    },
    sessions: { workspace: () => workspace },
    ui: {
      status() {},
      interactive: () => interactive,
      async askQuestions(request: AskQuestionsRequest) {
        asked.push(request);
        return answers.shift() ?? {};
      },
    },
  } as unknown as PluginAPI;
  const coordinator = registerEvalua(api, {
    clock: fixedClock(options.now ?? "2026-10-06T12:00:00.000Z"),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.printer ? { printer: options.printer } : {}),
  });
  const run = (name: string, args = "") => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`No command ${name}`);
    return handler(args, { sessionId: "parent" });
  };
  const tool = async (name: string, input: Record<string, unknown> = {}) => {
    const definition = tools.get(name);
    if (!definition) throw new Error(`No tool ${name}`);
    const result = await definition.execute(input, {
      signal: new AbortController().signal,
      workspace,
      emit() {},
    });
    const first = result.content[0];
    return {
      text: first && "text" in first ? String(first.text) : "",
      isError: result.isError === true,
    };
  };
  return {
    workspace,
    coordinator,
    commands,
    tools,
    resources,
    asked,
    run,
    tool,
    queue: (...next: Answers[]) => answers.push(...next),
    setInteractive: (value: boolean) => {
      interactive = value;
    },
  };
}

export const PROFILE_ANSWERS: Answers = {
  language: "es",
  institution: "enter",
  "institution:text": "Instituto Cristiano Demo",
  teacher_name: "enter",
  "teacher_name:text": "Ana Perez",
  logo: "none",
};
export const ROUND1: Answers = {
  topic: "enter",
  "topic:text": "Números racionales",
  grade: "septimo",
  level: "basico",
  kind: "basic-math",
};
export const ROUND2: Answers = {
  types: ["single_choice", "practice"],
  count: "10",
  distribution: "same",
  columns: "1",
};
export const ROUND3: Answers = {
  pages: "auto",
  time: "120-pencil",
  closing: "none",
  numbering: "letters",
};
