import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { Document, Job } from "../src/types.js";
import { LIMITS } from "../src/types.js";
import { finish, fixture, latest } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
async function setup() {
  const f = await fixture();
  cleanups.push(f.cleanup);
  return f;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const csv = (text: string) => Buffer.from(text).toString("base64");

describe("Service", () => {
  it("creates documents, replays idempotent retries and detects revision conflicts", async () => {
    const { invoke } = await setup();
    const key = randomUUID();
    const a = await invoke("documents.create", { title: "First" }, key);
    const again = await invoke("documents.create", { title: "First" }, key);
    expect(again.id).toBe(a.id);
    await expect(invoke("documents.create", { title: "Different" }, key)).rejects.toThrow(
      /idempotency_conflict/,
    );
    const b = await invoke("documents.create", { title: "Second" });
    expect(b.id).not.toBe(a.id);
    const revision = latest(a).id;
    await invoke("revision.save", { documentId: a.id, baseRevision: revision, tex: "Updated" });
    await expect(
      invoke("revision.save", { documentId: a.id, baseRevision: revision, tex: "Old" }),
    ).rejects.toThrow(/revision_conflict/);
    expect(latest(await invoke("documents.get", { documentId: b.id })).tex).not.toBe("Updated");
  });

  it("stores agent output as a proposal that cannot overwrite a newer revision", async () => {
    const { invoke, store } = await setup();
    const d = await invoke("documents.create", { title: "Article", brief: "Write a paper" });
    const job = await invoke<Job>("draft.generate", { documentId: d.id });
    expect((await finish(store, job)).status).toBe("succeeded");
    let doc = await store.get(d.id);
    expect(doc.revisions).toHaveLength(1);
    expect(doc.proposals).toHaveLength(1);
    await invoke("revision.save", {
      documentId: d.id,
      baseRevision: latest(doc).id,
      tex: "Human change",
    });
    await expect(
      invoke("proposal.apply", { documentId: d.id, proposalId: doc.proposals[0]?.id }),
    ).rejects.toThrow(/revision_conflict/);
    doc = await store.get(d.id);
    expect(latest(doc).tex).toBe("Human change");
  });

  it("applies a proposal and restores an older revision as a new revision", async () => {
    const { invoke, store } = await setup();
    const d = await invoke("documents.create", { title: "Article", brief: "Draft" });
    await finish(store, await invoke<Job>("draft.generate", { documentId: d.id }));
    let doc = await store.get(d.id);
    doc = await invoke("proposal.apply", { documentId: d.id, proposalId: doc.proposals[0]?.id });
    expect(doc.revisions).toHaveLength(2);
    doc = await invoke("revision.restore", {
      documentId: d.id,
      revisionId: d.revisions[0]?.id,
      baseRevision: latest(doc).id,
    });
    expect(doc.revisions).toHaveLength(3);
    expect(latest(doc).tex).toBe(d.revisions[0]?.tex);
  });

  it("validates attachments, guards referenced assets and exports a source ZIP", async () => {
    const { invoke } = await setup();
    let d = await invoke("documents.create", { title: "Assets" });
    await expect(
      invoke("assets.add", { documentId: d.id, name: "../bad.txt", base64: "YQ==" }),
    ).rejects.toThrow(/asset_type/);
    await expect(
      invoke("assets.add", { documentId: d.id, name: "bad.png", base64: "YQ==" }),
    ).rejects.toThrow(/asset_type/);
    d = await invoke("assets.add", { documentId: d.id, name: "data.csv", base64: csv("x,y\n1,2") });
    const asset = d.assets[0];
    if (!asset) throw new Error("asset missing");
    d = await invoke("revision.save", {
      documentId: d.id,
      baseRevision: latest(d).id,
      tex: asset.path,
    });
    await expect(invoke("assets.remove", { documentId: d.id, assetId: asset.id })).rejects.toThrow(
      /asset_in_use/,
    );
    const result = await invoke<{ base64: string }>("sources.export", { documentId: d.id });
    const files = unzipSync(Buffer.from(result.base64, "base64"));
    expect(files["main.tex"]).toBeDefined();
    expect(files[asset.path]).toBeDefined();
  });

  it("enforces the per-document attachment count shared with import", async () => {
    const { invoke, store } = await setup();
    const d = await invoke("documents.create", { title: "Many" });
    const doc = await store.get(d.id);
    doc.assets = Array.from({ length: LIMITS.assets }, () => {
      const id = randomUUID();
      return { id, name: "a.txt", path: `assets/${id}.txt`, mime: "text/plain", base64: csv("a") };
    });
    await store.put(doc);
    await expect(
      invoke("assets.add", { documentId: d.id, name: "b.txt", base64: csv("b") }),
    ).rejects.toThrow(/asset_limit/);
  });

  it("trusts the host gate: an action approved once still runs", async () => {
    const { invoke, api, service, store } = await setup();
    const d = await invoke("documents.create", { title: "Writable", brief: "Draft" });
    let release: (() => void) | undefined;
    api.sessions.run = (_id, _prompt, { signal }) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new Error("released"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const job = await invoke<Job>("draft.generate", { documentId: d.id });
    while (!release) await new Promise((r) => setTimeout(r, 1));
    // The host already authorized these actions (an approval "once" leaves the standing grants
    // unchanged), so Scribe must not reject them by re-reading the session capabilities.
    api.sessions.capabilities = () => ({
      write: false,
      process: false,
      approvals: true,
      readOnly: false,
    });
    await expect(invoke("documents.create", { title: "Approved once" })).resolves.toBeTruthy();
    release?.();
    expect((await finish(store, job)).status).toBe("failed");
  });

  it("recovers interrupted jobs without replaying them", async () => {
    const { store } = await setup();
    const at = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      documentId: randomUUID(),
      action: "draft",
      status: "running",
      message: "drafting",
      createdAt: at,
      updatedAt: at,
      baseRevision: randomUUID(),
    };
    await store.saveJob(job);
    await store.recover();
    expect((await store.jobs())[0]?.status).toBe("interrupted");
  });

  it("round-trips a project under a new identity and rejects tampered asset paths", async () => {
    const { invoke } = await setup();
    const d = await invoke("documents.create", { title: "Roundtrip" });
    await invoke("assets.add", { documentId: d.id, name: "data.csv", base64: csv("x,y") });
    const project = await invoke<{ schemaVersion: 1; document: Document }>("projects.export", {
      documentId: d.id,
    });
    const imported = await invoke("projects.import", { project });
    expect(imported.id).not.toBe(d.id);
    expect(imported.assets).toHaveLength(1);
    const asset = project.document.assets[0];
    if (!asset) throw new Error("asset missing");
    asset.path = "../../secret";
    await expect(invoke("projects.import", { project })).rejects.toThrow(/invalid_input/);
  });

  it("keeps a document importable by pruning revisions beyond the shared limit", async () => {
    const { invoke, store } = await setup();
    let d = await invoke("documents.create", { title: "Long history" });
    const doc = await store.get(d.id);
    const base = latest(doc);
    doc.revisions = Array.from({ length: LIMITS.revisions }, () => ({ ...base, id: randomUUID() }));
    await store.put(doc);
    d = await invoke("revision.save", {
      documentId: d.id,
      baseRevision: latest(doc).id,
      tex: "Newest",
    });
    expect(d.revisions).toHaveLength(LIMITS.revisions);
    expect(latest(d).tex).toBe("Newest");
    const project = await invoke("projects.export", { documentId: d.id });
    await expect(invoke("projects.import", { project })).resolves.toBeDefined();
  });

  it("cancels a running agent and leaves the document untouched", async () => {
    const { invoke, store, api } = await setup();
    let entered = false;
    let cancelled = 0;
    api.sessions.cancel = () => ++cancelled;
    api.sessions.run = (_id, _prompt, { signal }) => {
      entered = true;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    };
    const d = await invoke("documents.create", { title: "Cancel", brief: "Draft" });
    const job = await invoke<Job>("draft.generate", { documentId: d.id });
    while (!entered) await new Promise((r) => setTimeout(r, 1));
    await invoke("jobs.cancel", { jobId: job.id });
    expect((await finish(store, job)).status).toBe("cancelled");
    expect(cancelled).toBeGreaterThan(0);
    expect((await store.get(d.id)).proposals).toHaveLength(0);
  });

  it("never overwrites a manuscript with malformed model output", async () => {
    const { invoke, store, api } = await setup();
    api.sessions.run = async () => ({
      status: "completed",
      text: "not json",
      usage: { input: 1, output: 1 },
    });
    const d = await invoke("documents.create", { title: "Invalid output", brief: "Draft" });
    const job = await finish(store, await invoke<Job>("draft.generate", { documentId: d.id }));
    expect(job.errorCode).toBe("invalid_agent_output");
    expect((await store.get(d.id)).revisions).toHaveLength(1);
  });
});
