import type {
  CommandContext,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";

type CommandHandler = (args: string, context?: CommandContext) => Promise<string>;

export interface Harness {
  api: PluginAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<
    string,
    { handler: CommandHandler; options?: { description?: string; argumentHint?: string } }
  >;
  resources: { agents: string[]; skills: string[] };
  /** Run a registered tool the way the host would. */
  callTool(
    name: string,
    input: Record<string, unknown>,
    workspace: string,
    extra?: Partial<ToolContext>,
  ): Promise<ToolResult>;
  callCommand(name: string, args: string, sessionId?: string): Promise<string>;
}

/** A fake `PluginAPI` that records registrations; unimplemented host features throw when used. */
export function createHarness(
  workspaceOf: (sessionId?: string) => string = () => process.cwd(),
  ui: Partial<PluginAPI["ui"]> = {},
  sessions: Record<string, unknown> = {},
): Harness {
  const tools = new Map<string, ToolDefinition>();
  const commands: Harness["commands"] = new Map();
  const resources = { agents: [] as string[], skills: [] as string[] };
  const unavailable = (what: string) => () => {
    throw new Error(`${what} is not available in the test harness`);
  };
  const api = {
    tools: {
      register(tool: ToolDefinition) {
        if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    commands: {
      register(
        name: string,
        handler: CommandHandler,
        options?: { description?: string; argumentHint?: string },
      ) {
        if (commands.has(name)) throw new Error(`Duplicate command ${name}`);
        commands.set(name, { handler, ...(options ? { options } : {}) });
        return () => commands.delete(name);
      },
    },
    resources: {
      agents: (path: string) => void resources.agents.push(path),
      skills: (path: string) => void resources.skills.push(path),
      prompts: () => undefined,
      list: () => [],
    },
    sessions: {
      workspace: (id: string) => workspaceOf(id),
      create: unavailable("sessions.create"),
      run: unavailable("sessions.run"),
      ...sessions,
    },
    ui: {
      interactive: () => false,
      askQuestions: async () => ({}),
      select: async () => undefined,
      status: () => undefined,
      ...ui,
    },
    models: { list: unavailable("models.list"), resolve: unavailable("models.resolve") },
  } as unknown as PluginAPI;
  return {
    api,
    tools,
    commands,
    resources,
    async callTool(name, input, workspace, extra = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      return tool.execute(input, {
        signal: new AbortController().signal,
        workspace,
        emit: () => undefined,
        ...extra,
      });
    },
    async callCommand(name, args, sessionId) {
      const command = commands.get(name);
      if (!command) throw new Error(`Unknown command ${name}`);
      return command.handler(args, sessionId ? { sessionId } : undefined);
    },
  };
}
