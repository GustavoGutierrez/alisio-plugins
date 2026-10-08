import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DesignSpecInput } from "../src/core/design-spec.js";
import { DraftStore } from "../src/integrations/drafts.js";
import { resolveStateDir } from "../src/integrations/state.js";
import { captureAsyncError, packagedRegistry } from "./helpers.js";

const cleanups: string[] = [];

async function makeWorkspace(prefix = "cardsmith-state-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const INPUT: DesignSpecInput = {
  family: "social",
  templateId: "retro-message",
  content: { title: "Buenos días" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("resolveStateDir", () => {
  it("prefers api.paths.state and api.paths.cache, creating dirs with 0700", async () => {
    const workspace = await makeWorkspace();
    const state = join(await makeWorkspace(), "state");
    const cache = join(await makeWorkspace(), "cache");
    const paths = await resolveStateDir({
      apiPaths: { state, config: join(state, "config"), cache },
      workspace,
    });
    expect(paths.stateDir).toBe(resolve(state));
    expect(paths.cacheDir).toBe(resolve(cache));
    expect(paths.workingDir).toBe(join(resolve(state), "working"));
    expect(paths.draftsDir).toBe(join(resolve(state), "drafts"));
    for (const dir of [paths.stateDir, paths.cacheDir, paths.workingDir, paths.draftsDir]) {
      expect(await modeOf(dir)).toBe(0o700);
    }
  });

  it("falls back to <workspace>/.alisio/cardsmith", async () => {
    const workspace = await makeWorkspace();
    const paths = await resolveStateDir({ workspace });
    expect(paths.stateDir).toBe(join(workspace, ".alisio", "cardsmith"));
    expect(paths.cacheDir).toBe(join(paths.stateDir, "cache"));
    expect(paths.workingDir).toBe(join(paths.stateDir, "working"));
    expect(paths.draftsDir).toBe(join(paths.stateDir, "drafts"));
    expect(await modeOf(join(workspace, ".alisio"))).toBe(0o700);
    expect(await modeOf(paths.stateDir)).toBe(0o700);
  });
});

describe("DraftStore", () => {
  it("round-trips a draft and leaves no partial files behind", async () => {
    const dir = join(await makeWorkspace(), "drafts");
    const store = new DraftStore(dir);
    const registry = packagedRegistry();
    const created = await store.create(INPUT, { registry });
    expect(created.id).toMatch(UUID);
    expect(created.revision).toBe(1);
    expect(created.spec.content.title).toBe("Buenos días");
    expect(created.createdAt).toBe(created.updatedAt);

    const loaded = await store.get(created.id);
    expect(loaded).toEqual(created);

    const names = await readdir(dir);
    expect(names).toEqual([`${created.id}.json`]);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    const parsed = JSON.parse(await readFile(join(dir, names[0] ?? ""), "utf8"));
    expect(parsed.id).toBe(created.id);
    expect(parsed.revision).toBe(1);
    expect(parsed.warnings).toBeInstanceOf(Array);
  });

  it("merges content per key, replaces other fields and bumps the revision", async () => {
    const dir = join(await makeWorkspace(), "drafts");
    const store = new DraftStore(dir);
    const registry = packagedRegistry();
    const created = await store.create(INPUT, { registry });
    const updated = await store.update(
      created.id,
      1,
      { content: { message: "Que tengas un gran día" }, paletteId: "alisio-ocean" },
      { registry },
    );
    expect(updated.revision).toBe(2);
    expect(updated.spec.content.title).toBe("Buenos días");
    expect(updated.spec.content.message).toBe("Que tengas un gran día");
    expect(updated.spec.paletteId).toBe("alisio-ocean");
    expect(updated.createdAt).toBe(created.createdAt);
    const names = await readdir(dir);
    expect(names).toEqual([`${created.id}.json`]);
  });

  it("rejects a stale revision with expected/actual details", async () => {
    const dir = join(await makeWorkspace(), "drafts");
    const store = new DraftStore(dir);
    const registry = packagedRegistry();
    const created = await store.create(INPUT, { registry });
    await store.update(created.id, 1, { content: { message: "Hola" } }, { registry });
    const error = await captureAsyncError(() =>
      store.update(created.id, 1, { content: { message: "Otra vez" } }, { registry }),
    );
    expect(error.code).toBe("REVISION_MISMATCH");
    expect(error.details).toEqual({ expected: 1, actual: 2 });
  });

  it("reports DRAFT_NOT_FOUND for unknown and malformed ids", async () => {
    const dir = join(await makeWorkspace(), "drafts");
    const store = new DraftStore(dir);
    const missing = await captureAsyncError(() =>
      store.get("00000000-0000-4000-8000-000000000000"),
    );
    expect(missing.code).toBe("DRAFT_NOT_FOUND");
    const malformed = await captureAsyncError(() => store.get("../escape"));
    expect(malformed.code).toBe("DRAFT_NOT_FOUND");
  });

  it("rejects an invalid create without writing a draft", async () => {
    const dir = join(await makeWorkspace(), "drafts");
    const store = new DraftStore(dir);
    const registry = packagedRegistry();
    const error = await captureAsyncError(() =>
      store.create({ family: "social", templateId: "retro-message", content: {} }, { registry }),
    );
    expect(error.code).toBe("INVALID_SPEC");
    expect(Array.isArray(error.details?.errors)).toBe(true);
    await expect(readdir(dir)).rejects.toThrow();
  });
});
