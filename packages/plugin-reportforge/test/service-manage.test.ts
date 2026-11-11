import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeneratedReport } from "../src/generate.js";
import { ACTIONS, createService } from "../src/service.js";
import type { Report } from "../src/types.js";
import { type FakeModel, fakeHost, VALID_ANSWER } from "./helpers/fake-api.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

async function setup(
  options: {
    generate?: (r: Report, signal: AbortSignal) => Promise<GeneratedReport>;
    models?: FakeModel[] | (() => Promise<FakeModel[]>);
  } = {},
) {
  const host = await fakeHost(options.models ? { models: options.models } : {});
  cleanup = host.cleanup;
  const service = createService({
    api: host.api,
    ...(options.generate
      ? {
          generate: (_s: string, r: Report, _i: string, signal: AbortSignal) =>
            options.generate?.(r, signal) as Promise<GeneratedReport>,
        }
      : {}),
  });
  const run = <T = Report>(action: string, input: Record<string, unknown> = {}) =>
    service.run(action, input, "session-1") as Promise<T>;
  return { host, service, run };
}

const storeDir = async (state: string) => {
  const [dir] = await readdir(join(state, "reports"));
  return join(state, "reports", dir as string);
};

describe("model choice", () => {
  it("stores a listed model or the Alisio default", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {});
    expect((await run("report.setModel", { id: r.id, model: "acme/fast" })).model).toBe(
      "acme/fast",
    );
    expect((await run("reports.get", { id: r.id })).model).toBe("acme/fast");
    expect((await run("report.setModel", { id: r.id, model: "" })).model).toBe("");
  });

  it("refuses a model that is not in the catalog", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {});
    await expect(run("report.setModel", { id: r.id, model: "evil/model" })).rejects.toThrow(
      "unknown_model",
    );
    expect((await run("reports.get", { id: r.id })).model).toBe("");
  });

  it("reports a failing catalog with a code but still allows the default", async () => {
    const { run } = await setup({
      models: async () => {
        throw new Error("catalog down at /private/path");
      },
    });
    const r = await run("reports.create", {});
    await expect(run("report.setModel", { id: r.id, model: "acme/fast" })).rejects.toThrow(
      "models_unavailable",
    );
    expect((await run("report.setModel", { id: r.id, model: "" })).model).toBe("");
    await expect(run("models")).rejects.toThrow("models_unavailable");
  });

  it("labels models readably and keeps profiles apart", async () => {
    const { run } = await setup({
      models: [
        {
          reference: "acme/fast",
          providerName: "Acme",
          profile: "default",
          model: { id: "fast", name: "Fast" },
        },
        {
          reference: "acme@work/fast",
          providerName: "Acme",
          profile: "work",
          model: { id: "fast" },
        },
        { reference: "x/y", provider: "x", model: {} },
      ],
    });
    expect(await run("models")).toEqual([
      { reference: "acme/fast", label: "Acme · Fast" },
      { reference: "acme@work/fast", label: "Acme (work) · fast" },
      { reference: "x/y", label: "x · x/y" },
    ]);
  });

  it("uses the stored model for the next generation and passes the fallback note on", async () => {
    const seen: string[] = [];
    const { run } = await setup({
      generate: async (r) => {
        seen.push(r.model);
        return {
          ...VALID_ANSWER,
          blocks: VALID_ANSWER.blocks as never,
          dropped: 2,
          modelFallback: true,
        };
      },
    });
    const r = await run("reports.create", {});
    await run("report.setModel", { id: r.id, model: "acme/fast" });
    const job = await run<{ id: string }>("report.generate", { id: r.id });
    await until(
      async () =>
        (await run<{ status: string }>("jobs.get", { jobId: job.id })).status === "succeeded",
    );
    expect(seen).toEqual(["acme/fast"]);
    expect(await run("jobs.get", { jobId: job.id })).toMatchObject({
      dropped: 2,
      modelFallback: true,
    });
    const stored = await run("reports.get", { id: r.id });
    expect(stored).not.toHaveProperty("dropped");
    expect(stored).not.toHaveProperty("modelFallback");
  });

  it("registers a strict write action and no unvalidated model in settings", () => {
    expect(ACTIONS["report.setModel"]?.effect).toBe("write");
    expect(ACTIONS["report.setModel"]?.inputSchema).toMatchObject({
      required: ["id", "model"],
      additionalProperties: false,
    });
    const settings = ACTIONS["report.settings"]?.inputSchema as { properties: object };
    expect(settings.properties).not.toHaveProperty("model");
  });
});

describe("delete a report", () => {
  it("removes the report and its sources and updates the list", async () => {
    const { host, run } = await setup();
    const keep = await run("reports.create", { name: "Keep" });
    const r = await run("reports.create", { name: "Gone" });
    await run("source.add", { id: r.id, name: "a.csv", mime: "text/csv", base64: "YSxiCjEsMg==" });
    expect(await run("reports.delete", { id: r.id })).toEqual({ id: r.id, deleted: true });
    expect((await run<{ id: string }[]>("reports.list")).map((x) => x.id)).toEqual([keep.id]);
    await expect(run("reports.get", { id: r.id })).rejects.toThrow("report_not_found");
    const files = await readdir(await storeDir(host.state));
    expect(files).toEqual([`${keep.id}.json`]);
  });

  it("refuses unknown ids and path traversal", async () => {
    const { run } = await setup();
    await expect(run("reports.delete", { id: crypto.randomUUID() })).rejects.toThrow(
      "report_not_found",
    );
    await expect(run("reports.delete", { id: "../../etc/passwd" })).rejects.toThrow("invalid_id");
    await expect(run("reports.delete", {})).rejects.toThrow("invalid_id");
  });

  it("removes a symlinked entry without touching its target", async () => {
    const { host, run } = await setup();
    await run("reports.create", {});
    const dir = await storeDir(host.state);
    const outside = join(host.state, "outside");
    await mkdir(outside);
    const target = join(outside, "precious.json");
    await writeFile(target, "{}");
    const id = crypto.randomUUID();
    await symlink(target, join(dir, `${id}.json`));
    await run("reports.delete", { id });
    expect((await lstat(target)).isFile()).toBe(true);
    await expect(lstat(join(dir, `${id}.json`))).rejects.toThrow();
  });

  it("cancels a running generation first and never resurrects the report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run, service } = await setup({
      generate: async (_r, signal) => {
        await Promise.race([
          gate,
          new Promise((resolve) => signal.addEventListener("abort", resolve)),
        ]);
        return { ...VALID_ANSWER, blocks: VALID_ANSWER.blocks as never };
      },
    });
    const r = await run("reports.create", {});
    const job = await run<{ id: string }>("report.generate", { id: r.id });
    expect(service.busy()).toBe(true);
    await run("reports.delete", { id: r.id });
    release();
    expect(service.busy()).toBe(false);
    expect((await run<{ status: string }>("jobs.get", { jobId: job.id })).status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await run("reports.list")).toEqual([]);
  });

  it("hides a report whose deletion was interrupted", async () => {
    const { host, run, service } = await setup();
    const r = await run("reports.create", {});
    const dir = await storeDir(host.state);
    await writeFile(join(dir, `${r.id}.json.0123456789ab.deleted`), "{}");
    service.dispose();
    const fresh = createService({ api: host.api });
    expect(await fresh.run("reports.list", {}, "session-1")).toHaveLength(1);
    expect(await readdir(dir)).toEqual([`${r.id}.json`]);
  });

  it("registers a strict write action", () => {
    expect(ACTIONS["reports.delete"]).toMatchObject({
      effect: "write",
      inputSchema: { required: ["id"], additionalProperties: false },
    });
  });
});
