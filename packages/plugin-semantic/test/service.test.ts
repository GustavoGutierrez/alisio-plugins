import { afterEach, describe, expect, it } from "vitest";
import { NOT_FOUND } from "../src/notebook/answer.js";
import { serviceFixture } from "./service-fixture.js";
import { pptx, xlsx } from "./zip-fixture.js";

type Fixture = Awaited<ReturnType<typeof serviceFixture>>;
const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});
async function fixture(...args: Parameters<typeof serviceFixture>) {
  const f = await serviceFixture(...args);
  open.push(f);
  return f;
}
const notes = "Project Zephyr ships in March.\n\nThe budget code is ZX-4471 and Maria approves it.";

describe("notebooks", () => {
  it("creates, renames, lists, gets and deletes notebooks (dropping their collection)", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "Research" });
    expect(id).toMatch(/^[a-z2-7]{12}$/);
    await f.invoke("notebooks.rename", { id, title: "Renamed" });
    expect((await f.invoke("notebooks.list")).map((n: { title: string }) => n.title)).toEqual([
      "Renamed",
    ]);
    await f.upload(id, "notes.md", notes);
    const got = await f.invoke("notebooks.get", { id });
    expect(got.sources).toHaveLength(1);
    expect(got.sources[0]).toMatchObject({ name: "notes.md", status: "ready", chunkCount: 1 });
    expect(f.fake.collections.has(`nb-${id}`)).toBe(true);
    await f.invoke("notebooks.delete", { id });
    expect(f.fake.collections.has(`nb-${id}`)).toBe(false);
    await expect(f.invoke("notebooks.get", { id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns the same result for a retried mutation with the same idempotency key", async () => {
    const f = await fixture();
    const a = await f.invoke("notebooks.create", { title: "Once" }, "key-1");
    const b = await f.invoke("notebooks.create", { title: "Once" }, "key-1");
    expect(a).toEqual(b);
    expect(await f.invoke("notebooks.list")).toHaveLength(1);
  });
});

describe("sources and asking", () => {
  it("indexes into FTS and vectors, then answers with valid citations", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { sourceId } = await f.upload(id, "notes.md", notes);
    expect(f.fake.ids(`nb-${id}`)).toEqual([`${sourceId}:0`]);
    const { jobId } = await f.invoke("chat.ask", {
      notebookId: id,
      question: "Who approves ZX-4471?",
    });
    const job = await f.waitJob(jobId);
    expect(job).toMatchObject({ state: "done", result: { keywordOnly: false, grounded: true } });
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0]?.maxTokens).toBe(1500);
    expect(f.completions[0]?.sessionId).toBe("session");
    const history = await f.invoke("chat.history", { notebookId: id });
    expect(history.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(history[1].citations[0]).toMatchObject({
      n: 1,
      sourceId,
      sourceName: "notes.md",
      ordinal: 0,
    });
    const passage = await f.invoke("sources.passage", { sourceId, ordinal: 0 });
    expect(passage.text).toContain("ZX-4471");
    await f.invoke("chat.clear", { notebookId: id });
    expect(await f.invoke("chat.history", { notebookId: id })).toEqual([]);
  });

  it("answers from FTS5 alone when api.semantic is unavailable (SEM-AC-10)", async () => {
    const f = await fixture({ semantic: null });
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { job } = await f.upload(id, "notes.md", notes);
    expect(job.state).toBe("done");
    expect((await f.invoke("notebooks.get", { id })).sources[0].status).toBe("ready_keyword");
    const ask = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "budget code" })).jobId,
    );
    expect(ask.result).toMatchObject({ keywordOnly: true, grounded: true });
    expect(f.completions).toHaveLength(1);
  });

  it("replies with the fixed not-found text without calling the model (SEM-AC-16)", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    await f.upload(id, "notes.md", notes);
    const job = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "photosynthesis", locale: "es" }))
        .jobId,
    );
    expect(job.state).toBe("done");
    expect(f.completions).toHaveLength(0);
    const history = await f.invoke("chat.history", { notebookId: id });
    expect(history[1].text).toBe(NOT_FOUND.es);
  });

  it("restricts retrieval to the ticked sources", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const a = await f.upload(id, "a.md", "Apples grow on trees in the orchard.");
    const b = await f.upload(id, "b.md", "Oranges also grow on trees.");
    await f.waitJob(
      (
        await f.invoke("chat.ask", {
          notebookId: id,
          question: "trees grow",
          sourceIds: [b.sourceId],
        })
      ).jobId,
    );
    const prompt = f.completions[0]?.messages.at(-1)?.text ?? "";
    expect(prompt).toContain("Oranges");
    expect(prompt).not.toContain("Apples");
    expect(a.sourceId).not.toBe(b.sourceId);
  });

  it("returns the existing source for a duplicate upload (SEM-AC-14)", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const first = await f.upload(id, "notes.md", notes);
    const second = await f.invoke("sources.upload", {
      notebookId: id,
      name: "copy.md",
      mime: "text/markdown",
      base64: Buffer.from(notes).toString("base64"),
    });
    expect(second.sourceId).toBe(first.sourceId);
    expect((await f.invoke("notebooks.get", { id })).sources).toHaveLength(1);
  });

  it("enforces the source, file size and question limits (SEM-AC-15)", async () => {
    const f = await fixture({ semantic: null });
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    for (let i = 0; i < 50; i++)
      await f.invoke("sources.upload", {
        notebookId: id,
        name: `s${i}.txt`,
        mime: "text/plain",
        base64: Buffer.from(`source ${i}`).toString("base64"),
      });
    await expect(
      f.invoke("sources.upload", {
        notebookId: id,
        name: "s51.txt",
        mime: "text/plain",
        base64: Buffer.from("one more").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    const { id: other } = await f.invoke("notebooks.create", { title: "Big" });
    await expect(
      f.invoke("sources.upload", {
        notebookId: other,
        name: "big.txt",
        mime: "text/plain",
        base64: Buffer.alloc(26 * 1024 * 1024, 97).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(
      f.invoke("chat.ask", { notebookId: id, question: "x".repeat(4001) }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("marks a source whose extraction fails with a code, never a message", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { sourceId, jobId } = await f.invoke("sources.upload", {
      notebookId: id,
      name: "bad.txt",
      mime: "text/plain",
      base64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64"),
    });
    const job = await f.waitJob(jobId);
    expect(job).toMatchObject({ state: "failed", error: "invalid_encoding" });
    const source = (await f.invoke("notebooks.get", { id })).sources.find(
      (s: { id: string }) => s.id === sourceId,
    );
    expect(source).toMatchObject({ status: "failed", error: "invalid_encoding" });
  });

  it("indexes PDF text pages sent by the frame and rejects image-only PDFs", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const pages = [
      "The first page explains the thermal model in detail.",
      "The second page lists results.",
    ];
    const ok = await f.waitJob(
      (await f.invoke("sources.upload", { notebookId: id, name: "paper.pdf", pages })).jobId,
    );
    expect(ok.state).toBe("done");
    const bad = await f.waitJob(
      (await f.invoke("sources.upload", { notebookId: id, name: "scan.pdf", pages: ["a", "b"] }))
        .jobId,
    );
    expect(bad.error).toBe("no_text");
  });

  it("deletes a source with its chunks, FTS rows and vectors", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { sourceId } = await f.upload(id, "notes.md", notes);
    await f.invoke("sources.delete", { sourceId });
    expect(f.fake.ids(`nb-${id}`)).toEqual([]);
    const job = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "ZX-4471" })).jobId,
    );
    expect(job.state).toBe("done");
    expect(f.completions).toHaveLength(0);
  });

  it("rebuilds the collection from SQLite after a model change (SEM-AC-19)", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { sourceId } = await f.upload(id, "notes.md", notes);
    f.fake.state.modelId = "other@2#q8";
    // The core rejects the old collection: vector search degrades, indexing reports model_mismatch.
    const degraded = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "Zephyr" })).jobId,
    );
    expect(degraded.result.keywordOnly).toBe(true);
    const more = await f.upload(id, "more.md", "Zephyr has a second phase.");
    expect(
      (await f.invoke("notebooks.get", { id })).sources.find(
        (s: { id: string }) => s.id === more.sourceId,
      ),
    ).toMatchObject({
      status: "ready_keyword",
      error: "model_mismatch",
    });
    const rebuild = await f.waitJob((await f.invoke("index.rebuild", { notebookId: id })).jobId);
    expect(rebuild.state).toBe("done");
    expect(f.fake.collections.get(`nb-${id}`)?.modelId).toBe("other@2#q8");
    expect(f.fake.ids(`nb-${id}`).sort()).toEqual([`${more.sourceId}:0`, `${sourceId}:0`].sort());
    const after = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "Zephyr" })).jobId,
    );
    expect(after.result.keywordOnly).toBe(false);
    expect(
      (await f.invoke("notebooks.get", { id })).sources.every(
        (s: { status: string }) => s.status === "ready",
      ),
    ).toBe(true);
  });

  it("produces a guide with a summary and three suggested questions", async () => {
    const f = await fixture({
      answer: () =>
        "Summary: Zephyr ships in March [1].\nQ: When does Zephyr ship?\nQ: Who approves the budget?\nQ: What is the budget code?",
    });
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    await f.upload(id, "notes.md", notes);
    const job = await f.waitJob((await f.invoke("notebook.guide", { notebookId: id })).jobId);
    expect(job.result.questions).toHaveLength(3);
    expect(job.result.summary).toContain("Zephyr ships in March [1].");
    expect(job.result.citations).toHaveLength(1);
    const sum = await f.waitJob(
      (
        await f.invoke("sources.summary", {
          sourceId: (await f.invoke("notebooks.get", { id })).sources[0].id,
        })
      ).jobId,
    );
    expect(sum.state).toBe("done");
  });

  it("cites slides and sheets as pages, labelled by kind (O10)", async () => {
    const f = await fixture({ answer: () => "Revenue grew [1]." });
    const { id } = await f.invoke("notebooks.create", { title: "Office" });
    const up = async (name: string, data: Buffer) => {
      const { sourceId, jobId } = await f.invoke("sources.upload", {
        notebookId: id,
        name,
        base64: data.toString("base64"),
      });
      expect((await f.waitJob(jobId)).state).toBe("done");
      return sourceId as string;
    };
    const deck = await up("deck.pptx", pptx());
    const book = await up("book.xlsx", xlsx());
    const ask = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "revenue grew", sourceIds: [deck] }))
        .jobId,
    );
    expect(ask.state).toBe("done");
    const [message] = (await f.invoke("chat.history", { notebookId: id })).slice(-1);
    expect(message.citations[0]).toMatchObject({ sourceId: deck, page: 1 });
    expect(await f.invoke("sources.passage", { sourceId: deck, ordinal: 1 })).toMatchObject({
      page: 2,
      pageKind: "slide",
    });
    const sheet = await f.invoke("sources.passage", { sourceId: book, ordinal: 1 });
    expect(sheet).toMatchObject({ page: 2, pageKind: "sheet", pageName: "Notes" });
    expect(await f.invoke("sources.passage", { sourceId: book, ordinal: 0 })).toMatchObject({
      pageName: "Sales & costs",
    });
  });

  it("lists configured models and uses the notebook's choice, falling back visibly (O12)", async () => {
    const f = await fixture();
    expect(await f.invoke("models.list")).toEqual({
      models: [
        { reference: "acme/fast", name: "fast", provider: "acme" },
        { reference: "acme/smart", name: "smart", provider: "acme" },
      ],
      active: "acme/fast",
      available: true,
    });
    const { id } = await f.invoke("notebooks.create", { title: "M" });
    await f.upload(id, "notes.md", notes);
    await expect(
      f.invoke("notebooks.setModel", { id, model: "acme/missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await f.invoke("notebooks.setModel", { id, model: "acme/smart" });
    expect((await f.invoke("notebooks.get", { id })).model).toBe("acme/smart");
    await f.waitJob((await f.invoke("chat.ask", { notebookId: id, question: "Zephyr" })).jobId);
    expect(f.completions.at(-1)?.model).toBe("acme/smart");
    // The chosen model disappears: the answer uses Alisio's active model and says so.
    f.models.current = ["acme/fast"];
    const job = await f.waitJob(
      (await f.invoke("chat.ask", { notebookId: id, question: "Zephyr" })).jobId,
    );
    expect(job.result.modelFallback).toBe(true);
    expect(f.completions.at(-1)?.model).toBeUndefined();
    expect((await f.invoke("chat.history", { notebookId: id })).at(-1).modelFallback).toBe(true);
    expect((await f.invoke("notebooks.get", { id })).model).toBeNull();
    await f.invoke("notebooks.setModel", { id, model: null });
  });

  it("refuses to ask, guide or summarize when no model is configured (O12)", async () => {
    const f = await fixture({ models: [] });
    expect((await f.invoke("models.list")).available).toBe(false);
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { sourceId } = await f.upload(id, "notes.md", notes);
    await expect(
      f.invoke("chat.ask", { notebookId: id, question: "Zephyr" }),
    ).rejects.toMatchObject({ code: "no_model" });
    await expect(f.invoke("notebook.guide", { notebookId: id })).rejects.toMatchObject({
      code: "no_model",
    });
    await expect(f.invoke("sources.summary", { sourceId })).rejects.toMatchObject({
      code: "no_model",
    });
    expect(f.completions).toHaveLength(0);
    // Indexing and keyword search still work.
    expect(
      (await f.service.retrieve(id, "Zephyr", { signal: new AbortController().signal })).passages
        .length,
    ).toBeGreaterThan(0);
  });

  it("persists the guide, source summaries and scope across re-entry and restarts (O15)", async () => {
    const f = await fixture({
      answer: () => "Summary: Zephyr ships in March [1].\nQ: When?\nQ: Who?\nQ: What code?",
    });
    const { id } = await f.invoke("notebooks.create", { title: "G" });
    const { sourceId } = await f.upload(id, "notes.md", notes);
    await f.waitJob((await f.invoke("notebook.guide", { notebookId: id })).jobId);
    await f.waitJob((await f.invoke("sources.summary", { sourceId })).jobId);
    await f.invoke("notebooks.setScope", { id, excluded: [sourceId] });
    const check = async (service: typeof f.service) => {
      const nb = (await service.invoke(
        "notebooks.get",
        { id },
        { sessionId: "s", workspace: f.workspace, signal: new AbortController().signal },
      )) as any;
      expect(nb.guide).toMatchObject({
        summary: "Zephyr ships in March [1].",
        questions: ["When?", "Who?", "What code?"],
        outdated: false,
        model: "acme/fast",
      });
      expect(nb.guide.citations[0]).toMatchObject({ n: 1, sourceId });
      expect(nb.guide.createdAt).toBeGreaterThan(0);
      expect(nb.sources[0].summary).toMatchObject({ model: "acme/fast" });
      expect(nb.sources[0].summary.summary).toContain("Zephyr ships in March [1].");
      expect(nb.excluded).toEqual([sourceId]);
      return nb;
    };
    // Leaving and re-entering is just another notebooks.get.
    await check(f.service);
    // A new service over the same database (app restart or plugin re-activation).
    const { NotebookService } = await import("../src/notebook/service.js");
    const again = new NotebookService({
      db: f.db,
      semantic: () => undefined,
      complete: async () => "",
    });
    await check(again);
    // chat.clear keeps them; a new source marks the guide outdated (never regenerated by itself).
    await f.invoke("chat.clear", { notebookId: id });
    const calls = f.completions.length;
    await f.upload(id, "more.md", "Another source about Zephyr.");
    const nb = await f.invoke("notebooks.get", { id });
    expect(nb.guide.outdated).toBe(true);
    expect(f.completions.length).toBe(calls);
    // Deleting the source also removes it from the scope.
    await f.invoke("sources.delete", { sourceId });
    expect((await f.invoke("notebooks.get", { id })).excluded).toEqual([]);
  });

  it("records the one-time remote-model notice per notebook (D14)", async () => {
    const f = await fixture();
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    expect((await f.invoke("notebooks.get", { id })).remoteNoticeAck).toBe(false);
    await f.invoke("notice.ack", { notebookId: id });
    expect((await f.invoke("notebooks.get", { id })).remoteNoticeAck).toBe(true);
  });
});
