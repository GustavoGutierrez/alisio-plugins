import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAppContext, PluginAppDefinition, ToolContext } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { READ_ACTIONS, unsupportedSchemaKeywords, WRITE_ACTIONS } from "../src/apps.js";
import { type Harness, harness } from "./harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});
async function start(...args: Parameters<typeof harness>) {
  const h = await harness(...args);
  open.push(h);
  return h;
}
const ctx = (h: Harness, key?: string): PluginAppContext => ({
  sessionId: "s1",
  workspace: h.root,
  signal: new AbortController().signal,
  ...(key ? { idempotencyKey: key } : {}),
});
async function call(h: Harness, app: PluginAppDefinition, action: string, input: unknown = {}) {
  const handler = app.actions?.[action];
  if (!handler) throw new Error(`no action ${action}`);
  return (await handler.handler(input, ctx(h, crypto.randomUUID()))) as {
    value?: any;
    error?: string;
  };
}
async function settle(h: Harness, app: PluginAppDefinition, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const { value } = await call(h, app, "jobs.get", { jobId });
    if (value && value.state !== "running" && value.state !== "queued") return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job timeout");
}

describe("Notebook app through the plugin entry", () => {
  it("declares effects per §7.7 with host-safe, closed schemas (SEM-AC-24)", async () => {
    const h = await start();
    const app = h.apps[0] as PluginAppDefinition;
    expect(app.id).toBe("notebook");
    expect(app.label).toEqual({ en: "Notebook", es: "Cuaderno" });
    const actions = app.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual([...READ_ACTIONS, ...WRITE_ACTIONS].sort());
    for (const name of READ_ACTIONS) expect(actions[name]?.effect, name).toBe("read");
    for (const name of WRITE_ACTIONS) expect(actions[name]?.effect, name).toBe("write");
    expect(Object.values(actions).some((a) => a.effect === "process")).toBe(false);
    for (const [name, action] of Object.entries(actions)) {
      expect(unsupportedSchemaKeywords(action.inputSchema), name).toEqual([]);
      expect(action.inputSchema.additionalProperties, name).toBe(false);
      const walk = (schema: any): void => {
        if (!schema || typeof schema !== "object") return;
        if (schema.type === "string" && !schema.enum && !schema.pattern)
          expect(schema.maxLength, name).toBeDefined();
        if (schema.type === "array") expect(schema.maxItems, name).toBeDefined();
        for (const value of Object.values(schema)) walk(value);
      };
      walk(action.inputSchema);
    }
  });

  it("returns error codes without echoing the input", async () => {
    const h = await start();
    const app = h.apps[0] as PluginAppDefinition;
    const secret = "private/secret-plan-7f3a.txt";
    const result = await call(h, app, "sources.addFromWorkspace", {
      notebookId: "aaaaaaaaaaaa",
      path: secret,
    });
    expect(result).toEqual({ error: "not_found" });
    const outside = await call(h, app, "workspace.list", { dir: "../.." });
    expect(outside).toEqual({ error: "path_outside_workspace" });
    expect(JSON.stringify(outside)).not.toContain("..");
  });

  it("runs a notebook end to end and reports keyword-only status without an engine", async () => {
    const h = await start({ semantic: "absent" });
    const app = h.apps[0] as PluginAppDefinition;
    const status = (await call(h, app, "status")).value;
    expect(status).toMatchObject({
      semanticApi: false,
      keywordOnly: true,
      minHost: "0.11.7",
      notebooks: 0,
    });
    // Runtime tarballs (113,574,683 bytes) + model (135,392,016 bytes), downloaded once.
    expect(status.model).toMatchObject({ key: "e5-small", prepared: false, bytes: 248_966_699 });
    const { value: nb } = await call(h, app, "notebooks.create", { title: "Trip" });
    const { value: up } = await call(h, app, "sources.upload", {
      notebookId: nb.id,
      name: "trip.md",
      base64: Buffer.from("The train to Lyon leaves at 9:40 from platform 4.").toString("base64"),
    });
    expect((await settle(h, app, up.jobId)).state).toBe("done");
    const { value: ask } = await call(h, app, "chat.ask", {
      notebookId: nb.id,
      question: "Which platform for Lyon?",
    });
    expect((await settle(h, app, ask.jobId)).result).toMatchObject({ keywordOnly: true });
    expect(h.completions).toHaveLength(1);
  });

  it("serves the setup job through jobs.get and cancels it through jobs.cancel", async () => {
    const h = await start();
    const app = h.apps[0] as PluginAppDefinition;
    const unknown = await call(h, app, "jobs.get", { jobId: "setup-missing" });
    expect(unknown).toEqual({ error: "not_found" });
  });

  it("is busy while a job runs, then idle; dispose is idempotent (SEM-AC-25)", async () => {
    let release: (text: string) => void = () => {};
    const h = await start({
      complete: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const app = h.apps[0] as PluginAppDefinition;
    const { value: nb } = await call(h, app, "notebooks.create", { title: "B" });
    const { value: up } = await call(h, app, "sources.upload", {
      notebookId: nb.id,
      name: "a.txt",
      base64: Buffer.from("Kites fly when the wind is steady.").toString("base64"),
    });
    await settle(h, app, up.jobId);
    expect(app.busy?.()).toBe(false);
    const { value: ask } = await call(h, app, "chat.ask", {
      notebookId: nb.id,
      question: "When do kites fly?",
    });
    for (let i = 0; i < 200 && h.completions.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(app.busy?.()).toBe(true);
    release("When the wind is steady [1].");
    await settle(h, app, ask.jobId);
    expect(app.busy?.()).toBe(false);
    expect(() => {
      app.dispose?.();
      app.dispose?.();
    }).not.toThrow();
  });

  it("serves the built frame lazily", async () => {
    const h = await start();
    const app = h.apps[0] as PluginAppDefinition;
    expect(typeof app.html).toBe("function");
  });
});

describe("notebook_search tool", () => {
  it("returns passages with source names, and not_found for an unknown notebook", async () => {
    const h = await start({ semantic: "absent" });
    const app = h.apps[0] as PluginAppDefinition;
    const tool = h.tools.get("notebook_search");
    expect(tool?.effect).toBe("read");
    const toolCtx = {
      signal: new AbortController().signal,
      workspace: h.root,
      emit: () => {},
    } as ToolContext;
    expect(
      (await tool?.execute({ notebook: "Nope", query: "x" }, toolCtx))?.content[0],
    ).toMatchObject({ text: "not_found" });
    const { value: nb } = await call(h, app, "notebooks.create", { title: "Garden" });
    const { value: up } = await call(h, app, "sources.upload", {
      notebookId: nb.id,
      name: "garden.md",
      base64: Buffer.from(
        "Tomatoes need six hours of sun.\n\n" + "Filler paragraph. ".repeat(2000),
      ).toString("base64"),
    });
    await settle(h, app, up.jobId);
    const result = await tool?.execute(
      { notebook: "garden", query: "tomatoes sun", topK: 8 },
      toolCtx,
    );
    const text = (result?.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(16_500);
    const parsed = JSON.parse(text);
    expect(parsed.passages[0]).toMatchObject({ n: 1, source: "garden.md" });
    expect(parsed.passages[0].text).toContain("Tomatoes");
  });

  it("does not create the notebook database from the read-only tool", async () => {
    const h = await start({ apps: false });
    const tool = h.tools.get("notebook_search");
    const toolCtx = {
      signal: new AbortController().signal,
      workspace: h.root,
      emit: () => {},
    } as ToolContext;
    await mkdir(join(h.root, "x"), { recursive: true });
    await writeFile(join(h.root, "x", "f"), "");
    expect((await tool?.execute({ notebook: "a", query: "b" }, toolCtx))?.content[0]).toMatchObject(
      { text: "not_found" },
    );
  });
});
