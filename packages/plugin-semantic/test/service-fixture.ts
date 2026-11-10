import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, ToolSemantic } from "@alisio/sdk";
import { NotebookDb } from "../src/notebook/db.js";
import { NotebookService } from "../src/notebook/service.js";
import { fakeSemantic } from "./fake-semantic.js";
import { openTestDb } from "./sqlite.js";

export async function serviceFixture(
  options: { semantic?: ToolSemantic | null; answer?: (r: CompletionRequest) => string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sem-nb-"));
  const workspace = join(root, "workspace");
  const fake = fakeSemantic();
  const semantic = options.semantic === null ? undefined : (options.semantic ?? fake.semantic);
  const completions: CompletionRequest[] = [];
  const db = new NotebookDb(openTestDb(join(root, "notebook.db")));
  const service = new NotebookService({
    db,
    semantic: () => semantic,
    complete: async (request) => {
      completions.push(request);
      return options.answer ? options.answer(request) : "The answer is in the notes [1].";
    },
  });
  const ctx = (key?: string) => ({
    sessionId: "session",
    workspace,
    signal: new AbortController().signal,
    ...(key ? { idempotencyKey: key } : {}),
  });
  const invoke = <T = any>(action: string, input: Record<string, unknown> = {}, key?: string) =>
    service.invoke(action, input, ctx(key)) as Promise<T>;
  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 500; i++) {
      const job = await invoke("jobs.get", { jobId });
      if (job.state !== "running" && job.state !== "queued") return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job timeout");
  };
  const upload = async (notebookId: string, name: string, text: string) => {
    const { sourceId, jobId } = await invoke("sources.upload", {
      notebookId,
      name,
      mime: "text/plain",
      base64: Buffer.from(text).toString("base64"),
    });
    return { sourceId, job: await waitJob(jobId) };
  };
  const cleanup = async () => {
    service.dispose();
    await service.idle();
    db.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, workspace, fake, service, db, completions, invoke, waitJob, upload, cleanup };
}
