import type { DecisionProvider, PluginAPI } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { createBekkoPlugin, VERSION } from "../src/index.js";
import { fakeEngine } from "./helpers.js";

type Handler = (args: string) => Promise<string>;

function fakeApi(
  options: { decisions?: boolean; activate?: (id: string) => Promise<{ status: string }> } = {},
) {
  const commands = new Map<string, Handler>();
  const providers: DecisionProvider[] = [];
  let unregistered = 0;
  const api = {
    commands: {
      register(name: string, handler: Handler) {
        commands.set(name, handler);
        return () => commands.delete(name);
      },
    },
    paths: { state: "/state", config: "/config", cache: "/cache" },
    ...(options.decisions === false
      ? {}
      : {
          decisions: {
            registerProvider(provider: DecisionProvider) {
              providers.push(provider);
              return () => {
                unregistered++;
              };
            },
            available: () => true,
            activeProvider: () => null,
            tryDecide: async () => null,
            ...(options.activate ? { activate: options.activate } : {}),
          },
        }),
  } as unknown as PluginAPI;
  return { api, commands, providers, unregisteredCount: () => unregistered };
}

describe("bekko plugin", () => {
  it("declares its identity", () => {
    const plugin = createBekkoPlugin({ engineFactory: async () => fakeEngine() });
    expect(plugin.id).toBe("bekko");
    expect(plugin.version).toBe(VERSION);
    expect(plugin.categories).toEqual(["decisions"]);
  });

  it("registers commands and the provider without loading the model", async () => {
    let loads = 0;
    const plugin = createBekkoPlugin({
      engineFactory: async () => {
        loads++;
        return fakeEngine();
      },
    });
    const host = fakeApi();
    await plugin.setup(host.api);
    expect([...host.commands.keys()].sort()).toEqual(["activate", "setup", "status"]);
    expect(host.providers.map((p) => p.id)).toEqual(["bekko"]);
    expect(loads).toBe(0);
    expect(await host.commands.get("status")?.("")).toContain("Bekko 68m: inactive");
  });

  it("setup starts the download and reports its size", async () => {
    let loads = 0;
    const plugin = createBekkoPlugin({
      variant: "17m",
      engineFactory: async () => {
        loads++;
        return fakeEngine();
      },
    });
    const host = fakeApi();
    await plugin.setup(host.api);
    const message = await host.commands.get("setup")?.("");
    expect(message).toMatch(/about 33 MB/);
    expect(loads).toBe(1);
  });

  it("activate goes through the host and explains each outcome", async () => {
    const asked: string[] = [];
    const plugin = createBekkoPlugin({ engineFactory: async () => fakeEngine() });
    const host = fakeApi({
      activate: async (id) => {
        asked.push(id);
        return { status: "other_provider_active" };
      },
    });
    await plugin.setup(host.api);
    expect(await host.commands.get("activate")?.("")).toMatch(/did not replace/);
    expect(asked).toEqual(["bekko"]);
  });

  it("explains manual activation on a host without activate", async () => {
    const plugin = createBekkoPlugin({ engineFactory: async () => fakeEngine() });
    const host = fakeApi();
    await plugin.setup(host.api);
    expect(await host.commands.get("activate")?.("")).toMatch(/decisions.provider = "bekko"/);
  });

  it("works with only the commands on a host without decisions", async () => {
    const plugin = createBekkoPlugin({ engineFactory: async () => fakeEngine() });
    const host = fakeApi({ decisions: false });
    await plugin.setup(host.api);
    expect(await host.commands.get("status")?.("")).toMatch(/no decisions API/);
  });

  it("dispose unregisters everything", async () => {
    const plugin = createBekkoPlugin({ engineFactory: async () => fakeEngine() });
    const host = fakeApi();
    await plugin.setup(host.api);
    await plugin.dispose?.();
    expect(host.commands.size).toBe(0);
    expect(host.unregisteredCount()).toBe(1);
  });
});
