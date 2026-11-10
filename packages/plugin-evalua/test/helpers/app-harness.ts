import { randomUUID } from "node:crypto";
import type {
  AskQuestionsRequest,
  AvailableProviderModel,
  CompletionRequest,
  PluginAPI,
  PluginAppDefinition,
  ToolDefinition,
} from "@alisio/sdk";
import type { PdfPrinter } from "../../src/build.js";
import type { ChromeDetection } from "../../src/chrome/detect.js";
import { fixedClock } from "../../src/clock.js";
import { registerEvalua } from "../../src/index.js";
import { scratchDir } from "./harness.js";

// biome-ignore lint/suspicious/noExplicitAny: action results are free-form JSON in tests.
type Json = any;

export const fakePrinter: PdfPrinter = async () => ({
  pdf: Buffer.from("/Type /Page /Count 1"),
  engineVersion: "Chrome/test",
});

export const MODEL: AvailableProviderModel = {
  reference: "acme/teacher-1",
  provider: "acme",
  profile: "default",
  providerName: "Acme",
  model: { id: "teacher-1", name: "Teacher One" },
};

export interface AppHarnessOptions {
  workspace?: string;
  interactive?: boolean;
  answers?: Array<Record<string, string | string[]>>;
  /** Default: a fake printer and a found browser. `null` means no browser and no printer. */
  printer?: PdfPrinter | null;
  models?: AvailableProviderModel[];
  resolve?: (reference: string) => Promise<AvailableProviderModel>;
  complete?: (request: CompletionRequest) => Promise<string>;
  /** false: a host without `api.apps`. */
  apps?: boolean;
}

/** A fake host with `api.apps`: records the app and calls its actions like the frame would. */
export async function appHarness(options: AppHarnessOptions = {}) {
  const workspace = options.workspace ?? (await scratchDir());
  const answers = [...(options.answers ?? [])];
  const apps: PluginAppDefinition[] = [];
  const unregistered: string[] = [];
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const tools = new Map<string, ToolDefinition>();
  const completions: CompletionRequest[] = [];
  const models = options.models ?? [MODEL];
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
    resources: { agents() {}, skills() {} },
    sessions: { workspace: () => workspace },
    ui: {
      status() {},
      interactive: () => options.interactive ?? true,
      async askQuestions(_request: AskQuestionsRequest) {
        return answers.shift() ?? {};
      },
    },
    models: {
      list: async () => models,
      resolve:
        options.resolve ??
        (async (reference: string) => {
          const found = models.find((entry) => entry.reference === reference);
          if (!found) throw new Error("unknown model");
          return found;
        }),
    },
    model: {
      async complete(request: CompletionRequest) {
        completions.push(request);
        return options.complete ? options.complete(request) : "{}";
      },
    },
    ...(options.apps === false
      ? {}
      : {
          apps: {
            register(app: PluginAppDefinition) {
              apps.push(app);
              return () => unregistered.push(app.id);
            },
          },
        }),
  } as unknown as PluginAPI;
  const detection: ChromeDetection =
    options.printer === null ? { source: "none" } : { path: "/scratch/p/chrome", source: "env" };
  const coordinator = registerEvalua(api, {
    clock: fixedClock("2026-10-06T12:00:00.000Z"),
    detectBrowser: async () => detection,
    ...(options.printer === null ? {} : { printer: options.printer ?? fakePrinter }),
  });
  const app = apps[0];
  /** Calls an action; mutations get the current revision unless the input names one. */
  const call = async (
    action: string,
    input: Record<string, unknown> = {},
    extra: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<{ value?: Json; error?: string }> => {
    if (!app) throw new Error("no app registered");
    const definition = app.actions?.[action];
    if (!definition) throw new Error(`No action ${action}`);
    let args = input;
    const needsRevision =
      definition.effect !== "read" &&
      !("expectedRevision" in input) &&
      action !== "jobs.cancel" &&
      action !== "models.choose";
    if (needsRevision) {
      const status = await call("status");
      args = { ...input, expectedRevision: status.value.revision };
    }
    return (await definition.handler(args, {
      sessionId: "parent",
      workspace,
      signal: extra.signal ?? new AbortController().signal,
      ...(definition.effect !== "read"
        ? { idempotencyKey: extra.idempotencyKey ?? randomUUID() }
        : {}),
    })) as { value?: Json; error?: string };
  };
  const chat = {
    run: (name: string, args = "") => {
      const handler = commands.get(name);
      if (!handler) throw new Error(`No command ${name}`);
      return handler(args, { sessionId: "parent" });
    },
    tool: async (name: string, input: Record<string, unknown> = {}) => {
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
    },
  };
  /** Saves a teacher profile through the app. */
  const profile = async () => {
    const result = await call("profile.save", {
      teacherName: "Ana Perez",
      institution: "Instituto Cristiano Demo",
      subject: "Matemáticas",
      paper: "letter",
      language: "es",
    });
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  /** Waits for a job to leave `running`. */
  const settle = async (jobId: string) => {
    for (let i = 0; i < 2000; i++) {
      const job = await call("jobs.get", { jobId });
      if (job.value?.state !== "running") return job.value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("job did not finish");
  };
  /** Profile, draft and Gate A: an approved exam ready for wording and generation. */
  const approvedExam = async (topic = "basic-math/integers") => {
    await profile();
    const draft = await call("draft.create", {
      answers: {
        topic,
        grade: "septimo",
        level: "basico",
        types: ["single_choice", "practice"],
        count: "10",
        distribution: "same",
        columns: "1",
        pages: "auto",
        time: "120-pencil",
        closing: "none",
        numbering: "letters",
      },
    });
    if (!draft.value?.draft) throw new Error(JSON.stringify(draft));
    const approved = await call("exam.approveA");
    if (!approved.value?.examId) throw new Error(JSON.stringify(approved));
    return approved.value.examId as string;
  };
  return {
    workspace,
    api,
    app,
    apps,
    unregistered,
    coordinator,
    completions,
    call,
    chat,
    profile,
    settle,
    approvedExam,
  };
}
