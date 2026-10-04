import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskQuestionsRequest, PluginAPI, ToolDefinition } from "@alisio/sdk";
import { vi } from "vitest";
import type { CoordinatorOptions } from "../../src/coordinator.js";
import { registerThesis } from "../../src/index.js";
import type { ScholarClient } from "../../src/research/client.js";
import { fixtureClient } from "./scholar.js";

type Answers = Record<string, string | string[] | undefined>;
type Reply = string | ((prompt: string) => string);
const roleOf = (agent: string) => agent.toLowerCase().replace(/\s+/g, "-");

// Tests never reach the network: scholarly calls go through an injected client over fixtures.
vi.stubGlobal("fetch", async (url: unknown) => {
  throw new Error(`Unexpected network request in a test: ${String(url)}`);
});

const dirs: string[] = [];
export async function cleanup() {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface LifecycleOptions {
  interactive?: boolean;
  /** One entry per askQuestions call, in order. */
  answers?: Answers[];
  scholar?: ScholarClient;
  workspace?: string;
  now?: () => Date;
  /** Extra coordinator options (environment, renderer registry, setup seams). */
  coordinator?: Partial<CoordinatorOptions>;
}

/** A fake PluginAPI with scripted child sessions; the real coordinator and workflows run on it. */
export async function lifecycle(options: LifecycleOptions = {}) {
  const workspace = options.workspace ?? (await mkdtemp(join(tmpdir(), "thesis-life-")));
  if (!options.workspace) dirs.push(workspace);
  const queues = new Map<string, Reply[]>();
  const prompts: { role: string; prompt: string; spec: Record<string, unknown> }[] = [];
  const asked: AskQuestionsRequest[] = [];
  const answers = [...(options.answers ?? [])];
  const children = new Map<string, { role: string; spec: Record<string, unknown> }>();
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const tools = new Map<string, ToolDefinition>();
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
    resources: { agents: () => undefined, skills: () => undefined },
    sessions: {
      workspace: () => workspace,
      async create(spec: Record<string, unknown>) {
        const id = `child-${children.size + 1}`;
        children.set(id, { role: roleOf(String(spec.agent)), spec });
        return { id };
      },
      async run(id: string, prompt: string) {
        const child = children.get(id) as { role: string; spec: Record<string, unknown> };
        prompts.push({ role: child.role, prompt, spec: child.spec });
        const reply = queues.get(child.role)?.shift();
        if (reply === undefined) throw new Error(`No scripted reply left for ${child.role}`);
        return {
          id,
          status: "completed",
          text: typeof reply === "function" ? reply(prompt) : reply,
          usage: { input: 0, output: 0 },
        };
      },
    },
    ui: {
      status() {},
      interactive: () => interactive,
      async askQuestions(request: AskQuestionsRequest) {
        asked.push(request);
        return answers.shift() ?? {};
      },
    },
  } as unknown as PluginAPI;
  const { client, network, clock } = fixtureClient();
  const scholar = options.scholar ?? client;
  const coordinator = registerThesis(api, {
    scholar,
    env: { LANG: "es_CO.UTF-8" },
    ...(options.now ? { now: options.now } : {}),
    ...options.coordinator,
  });
  const run = (name: string, args = "") => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`No command ${name}`);
    return handler(args, { sessionId: "parent" });
  };
  return {
    workspace,
    coordinator,
    network,
    clock,
    asked,
    prompts,
    tools,
    run,
    setInteractive(value: boolean) {
      interactive = value;
    },
    queueAnswers(...next: Answers[]) {
      answers.push(...next);
    },
    script(role: string, ...replies: Reply[]) {
      queues.set(role, [...(queues.get(role) ?? []), ...replies]);
    },
    remaining(role: string) {
      return queues.get(role)?.length ?? 0;
    },
    read: (path: string) => readFile(join(workspace, "thesis", path), "utf8"),
    state: async () =>
      JSON.parse(await readFile(join(workspace, ".alisio", "thesis", "state.json"), "utf8")),
  };
}

export type Lifecycle = Awaited<ReturnType<typeof lifecycle>>;

export const round1: Answers = {
  language: "conversation",
  workType: "master_thesis",
  country: "CO",
  secondaryAbstract: "en",
};
export const round2: Answers = {
  institution: "enter",
  "institution:text": "Example University; Engineering; Systems; Bogota",
  citationStyle: "auto",
  domain: "computer_science",
  approach: "recommended",
};
export const round3: Answers = {
  title: "enter",
  "title:text": "Automatic evidence verification for theses",
  topic: "enter",
  "topic:text": "How to verify bibliographic evidence automatically",
  objective: "draft",
  justification: "draft",
};
export const intakeAnswers = [round1, round2, round3];
