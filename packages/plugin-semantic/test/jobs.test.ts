import { afterEach, describe, expect, it } from "vitest";
import { serviceFixture } from "./service-fixture.js";

type Fixture = Awaited<ReturnType<typeof serviceFixture>>;
const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});

describe("jobs (D11)", () => {
  it("cancels an indexing job mid-way and leaves no vectors for that source (SEM-AC-20)", async () => {
    const f = await serviceFixture();
    open.push(f);
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} `.repeat(80)).join(
      "\n\n",
    );
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const indexing = new Promise<void>((r) => {
      entered = r;
    });
    let calls = 0;
    // The first batch passes; the second waits until the test releases it.
    f.fake.state.onIndex = () => {
      calls++;
      if (calls === 2) {
        f.fake.state.gate = pending;
        entered();
      }
    };
    const { sourceId, jobId } = await f.invoke("sources.upload", {
      notebookId: id,
      name: "long.txt",
      mime: "text/plain",
      base64: Buffer.from(paragraphs).toString("base64"),
    });
    await indexing;
    expect(f.service.busy()).toBe(true);
    expect(await f.invoke("jobs.cancel", { jobId })).toEqual({ cancelled: true });
    release();
    const job = await f.waitJob(jobId);
    expect(job).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(f.fake.ids(`nb-${id}`).filter((v) => v.startsWith(`${sourceId}:`))).toEqual([]);
    const source = (await f.invoke("notebooks.get", { id })).sources[0];
    expect(source).toMatchObject({ status: "failed", error: "cancelled", chunkCount: 0 });
    expect(f.service.busy()).toBe(false);
  });

  it("reports progress from 0 to 1 and an unknown job as not_found", async () => {
    const f = await serviceFixture();
    open.push(f);
    const { id } = await f.invoke("notebooks.create", { title: "N" });
    const { job } = await f.upload(id, "a.md", "Some text here.");
    expect(job).toMatchObject({ state: "done", progress: 1 });
    await expect(f.invoke("jobs.get", { jobId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
