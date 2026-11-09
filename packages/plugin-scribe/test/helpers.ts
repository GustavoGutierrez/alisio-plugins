import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import type { Document, Job } from "../src/types.js";

export interface Capabilities {
  write: boolean;
  process: boolean;
  approvals: boolean;
  readOnly: boolean;
}
export interface FakeSessions {
  capabilities: (id: string) => Capabilities;
  create: () => Promise<{ id: string }>;
  cancel: (id: string) => number;
  run: (
    id: string,
    prompt: string,
    options: { signal: AbortSignal },
  ) => Promise<{
    status: string;
    text: string;
    usage: { input: number; output: number };
    turnsExceeded?: boolean;
  }>;
}
export interface FakeApi {
  models: { list: () => Promise<unknown[]>; resolve: (ref: string) => Promise<unknown> };
  sessions: FakeSessions;
}

export const proposalText = (body = "Test") =>
  JSON.stringify({
    tex: `\\documentclass{article}\n\\begin{document}${body}\\end{document}`,
    bib: "",
    summary: "A test proposal",
  });

export function fakeApi(): FakeApi {
  return {
    models: { list: async () => [], resolve: async (ref) => ({ reference: ref }) },
    sessions: {
      capabilities: () => ({ write: true, process: false, readOnly: false, approvals: true }),
      create: async () => ({ id: randomUUID() }),
      cancel: () => 1,
      run: async () => ({
        status: "completed",
        text: proposalText(),
        usage: { input: 12, output: 20 },
      }),
    },
  };
}

export async function fixture(locale: "es" | "en" = "es") {
  const root = await mkdtemp(join(tmpdir(), "scribe-test-"));
  const store = new Store(root);
  await store.init();
  const api = fakeApi();
  const service = new Service(api as unknown as PluginAPI, store, "session", { locale });
  const cleanup = async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  };
  const invoke = <T = Document>(
    action: string,
    input: Record<string, unknown> = {},
    key?: string,
  ) => service.invoke(action, input, key) as Promise<T>;
  return { service, store, api, root, cleanup, invoke };
}

export async function finish(store: Store, job: Job): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const value = (await store.jobs()).find((j) => j.id === job.id);
    if (value && value.status !== "running") return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job timeout");
}

export function latest(document: Document) {
  const revision = document.revisions.at(-1);
  if (!revision) throw new Error("document without revisions");
  return revision;
}
