import type { PluginAppContext, PluginAppDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { type Harness, harness } from "./harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0).reverse()) await h.cleanup();
});
async function start(...args: Parameters<typeof harness>) {
  const h = await harness(...args);
  open.push(h);
  return h;
}
async function call(h: Harness, action: string, input: unknown = {}) {
  const app = h.apps[0] as PluginAppDefinition;
  const ctx: PluginAppContext = {
    sessionId: "s",
    workspace: h.root,
    signal: new AbortController().signal,
    idempotencyKey: crypto.randomUUID(),
  };
  return (await app.actions?.[action]?.handler(input, ctx)) as { value?: any; error?: string };
}

describe("activation lifecycle (O13)", () => {
  it("closing one workspace never unregisters another workspace's Notebook (the 0.1.0 bug)", async () => {
    // The desktop opens the home workspace and a project: setup runs twice on the same module.
    const home = await start();
    const project = await start({ root: home.root });
    expect(home.apps).toHaveLength(1);
    expect(project.apps).toHaveLength(1);
    // Ten minutes later the idle home workspace is evicted: plugin.dispose() + undo of ITS registrations.
    await home.close();
    expect(home.apps).toHaveLength(0);
    expect(project.apps).toHaveLength(1);
    expect(project.commands.size).toBe(3);
    expect(project.tools.has("notebook_search")).toBe(true);
    const { value } = await call(project, "notebooks.create", { title: "Still here" });
    expect(value.id).toMatch(/^[a-z2-7]{12}$/);
    expect((await call(project, "notebooks.list")).value).toHaveLength(1);
  });

  it("setup → close → setup on the same state registers everything again with fresh state", async () => {
    const first = await start();
    const { value } = await call(first, "notebooks.create", { title: "Persisted" });
    await first.close();
    const second = await start({ root: first.root });
    expect(second.apps).toHaveLength(1);
    expect([...second.commands.keys()].sort()).toEqual(["help", "setup", "status"]);
    expect(second.embeddings).toHaveLength(1);
    expect(second.stores).toHaveLength(1);
    expect((await call(second, "notebooks.list")).value.map((n: { id: string }) => n.id)).toEqual([
      value.id,
    ]);
    expect((await call(second, "status")).value).toMatchObject({ notebooks: 1 });
  });

  it("registers the app, tool and commands even when the engine registration throws", async () => {
    const h = await start({
      semantic: {
        registerEmbedding: () => {
          throw new TypeError("duplicate provider id");
        },
        registerStore: () => {
          throw new TypeError("duplicate provider id");
        },
      },
    });
    expect(h.apps).toHaveLength(1);
    expect(h.tools.has("notebook_search")).toBe(true);
    expect(h.commands.size).toBe(3);
  });

  it("closes while a job runs without throwing, and app dispose is idempotent", async () => {
    let release: (text: string) => void = () => {};
    const h = await start({
      complete: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const { value: nb } = await call(h, "notebooks.create", { title: "Busy" });
    const { value: up } = await call(h, "sources.upload", {
      notebookId: nb.id,
      name: "a.txt",
      base64: Buffer.from("Kites fly in steady wind.").toString("base64"),
    });
    for (let i = 0; i < 200; i++) {
      const job = (await call(h, "jobs.get", { jobId: up.jobId })).value;
      if (job.state === "done") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await call(h, "chat.ask", { notebookId: nb.id, question: "kites wind" });
    const app = h.apps[0] as PluginAppDefinition;
    expect(app.busy?.()).toBe(true);
    // A context-free dispose leaves the busy activation alone.
    await plugin.dispose?.();
    expect(h.apps).toHaveLength(1);
    await expect(h.close()).resolves.toBeUndefined();
    expect(() => app.dispose?.()).not.toThrow();
    release("done [1]");
  });
});
