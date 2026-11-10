import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAppContext, PluginAppDefinition } from "@alisio/sdk";
import { expect } from "vitest";
import type { Renderer } from "../../src/render/port.js";
import { type Lifecycle, type LifecycleOptions, lifecycle } from "./harness.js";

export interface FakeModel {
  reference: string;
  provider: string;
  name?: string;
}

export interface StudioOptions extends LifecycleOptions {
  /** Models the fake host lists and resolves. */
  models?: FakeModel[];
  /** Model a child inherits from the session (`api.sessions.model`). */
  active?: string;
  /** False simulates a host without `api.apps`. */
  apps?: boolean;
  /** False simulates a host without `api.models`. */
  modelsApi?: boolean;
}

type Result = { value?: unknown; error?: string; [key: string]: unknown };

/** A stand-in PDF renderer that counts its calls (no engine, no process). */
export function fakePdf(): Renderer & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id: "fake-pdf",
    format: "pdf",
    calls,
    capabilities: () => ({
      math: "native",
      mermaid: "native",
      footnotes: "native",
      toc: "native",
      crossrefs: "native",
      bibliography: "native",
      pdfa: true,
      extension: "pdf",
    }),
    available: async () => ({ available: true, engine: "fake", source: "test" }),
    async render(_doc, options, context) {
      calls.push(options);
      await writeFile(join(context.buildDir, "thesis.pdf"), "%PDF-1.7 fake");
      return {
        ok: true,
        engine: "fake",
        output: "thesis.pdf",
        pages: 3,
        ms: 1,
        findings: [],
        unrepresented: [],
      };
    },
  };
}

/**
 * The fake `api.apps` host side: pass `extend` to `lifecycle` (or a phase helper), then `bind`
 * the resulting harness to call Thesis Studio actions like the frame does.
 */
export function studioHost(options: StudioOptions = {}) {
  let app: PluginAppDefinition | undefined;
  let unregistered = 0;
  let gate: Promise<void> | undefined;
  let runs = 0;
  let seenRuns = 0;
  const cancelled: string[] = [];
  const runSignals: (AbortSignal | undefined)[] = [];
  const models = [
    ...(options.models ?? [{ reference: "openai/gpt-test", provider: "openai", name: "GPT Test" }]),
  ];
  let active = options.active ?? "openai/gpt-test";
  const extend = (api: Record<string, unknown>) => {
    if (options.apps !== false)
      api.apps = {
        register(definition: PluginAppDefinition) {
          app = definition;
          return () => {
            unregistered += 1;
          };
        },
      };
    if (options.modelsApi !== false)
      api.models = {
        list: async () =>
          models.map((m) => ({
            reference: m.reference,
            provider: m.provider,
            profile: m.provider,
            providerName: m.provider,
            model: { id: m.reference.split("/").slice(1).join("/"), name: m.name },
          })),
        async resolve(reference: string) {
          const found = models.find((m) => m.reference === reference);
          if (!found) throw new Error("unknown model");
          return {
            reference: found.reference,
            provider: found.provider,
            profile: found.provider,
            providerName: found.provider,
            model: { id: found.reference },
          };
        },
      };
    const sessions = api.sessions as Record<string, unknown>;
    sessions.model = () => active;
    sessions.cancel = (id: string) => {
      cancelled.push(id);
      return 1;
    };
    const run = sessions.run as (id: string, prompt: string) => Promise<unknown>;
    sessions.run = async (id: string, prompt: string, opts?: { signal?: AbortSignal }) => {
      runs += 1;
      runSignals.push(opts?.signal);
      if (gate) {
        const waiting = gate;
        const signal = opts?.signal;
        await new Promise<void>((resolve, reject) => {
          void waiting.then(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      opts?.signal?.throwIfAborted();
      return run(id, prompt);
    };
    options.extend?.(api);
  };

  const bind = (h: Lifecycle) => {
    const context = (over: Partial<PluginAppContext> = {}): PluginAppContext => ({
      sessionId: "parent",
      workspace: h.workspace,
      signal: new AbortController().signal,
      ...over,
    });
    const call = async (
      action: string,
      input: unknown,
      over: Partial<PluginAppContext> = {},
    ): Promise<Result> => {
      const definition = app?.actions?.[action];
      if (!definition) throw new Error(`No app action ${action}`);
      return (await definition.handler(input, context(over))) as Result;
    };
    const revision = async () =>
      ((await call("status", {})).value as { revision: string }).revision;
    return {
      h,
      get app() {
        return app;
      },
      get unregistered() {
        return unregistered;
      },
      cancelled,
      runSignals,
      call,
      revision,
      setActive(value: string) {
        active = value;
      },
      setModels(next: FakeModel[]) {
        models.splice(0, models.length, ...next);
      },
      /** Hold every child run until the returned function is called. */
      holdChildren(): () => void {
        let release: () => void = () => undefined;
        gate = new Promise<void>((resolve) => {
          release = () => {
            gate = undefined;
            resolve();
          };
        });
        return () => release();
      },
      /** Resolves once a child run started after the previous call. */
      async untilChildRuns() {
        for (let i = 0; runs <= seenRuns && i < 400; i++)
          await new Promise((r) => setTimeout(r, 5));
        expect(runs).toBeGreaterThan(seenRuns);
        seenRuns = runs;
      },
      async waitJob(jobId: string) {
        let job: Record<string, unknown> = {};
        for (let i = 0; i < 1000; i++) {
          job = (await call("jobs.get", { jobId })).value as Record<string, unknown>;
          if (job?.state !== "running") return job;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`job ${jobId} did not finish`);
      },
    };
  };
  return { extend, bind };
}

/** The lifecycle harness plus a fake `api.apps` host that calls the Thesis Studio actions. */
export async function studio(options: StudioOptions = {}) {
  const host = studioHost(options);
  return host.bind(await lifecycle({ ...options, extend: host.extend }));
}

export type Studio = ReturnType<ReturnType<typeof studioHost>["bind"]>;
