import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serviceFixture } from "./service-fixture.js";

type Fixture = Awaited<ReturnType<typeof serviceFixture>>;
const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});
async function setup() {
  const f = await serviceFixture();
  open.push(f);
  await mkdir(join(f.workspace, "docs"), { recursive: true });
  await writeFile(join(f.workspace, "docs", "a.md"), "Workspace file about kites.");
  await writeFile(join(f.root, "secret.txt"), "outside secret");
  await symlink(join(f.root, "secret.txt"), join(f.workspace, "docs", "escape.txt"));
  await symlink(join(f.root), join(f.workspace, "up"));
  const { id } = await f.invoke("notebooks.create", { title: "W" });
  return { f, id };
}

describe("workspace sources (§7.2, SEM-AC-13)", () => {
  it("rejects ../x, absolute paths and escaping symlinks with path_outside_workspace", async () => {
    const { f, id } = await setup();
    for (const path of [
      "../secret.txt",
      "docs/../../secret.txt",
      join(f.root, "secret.txt"),
      "docs/escape.txt",
      "up/secret.txt",
    ])
      await expect(
        f.invoke("sources.addFromWorkspace", { notebookId: id, path }),
      ).rejects.toMatchObject({
        code: "path_outside_workspace",
      });
    await expect(f.invoke("workspace.list", { dir: "up" })).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    await expect(f.invoke("sources.read", { path: "up/secret.txt" })).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    expect((await f.invoke("notebooks.get", { id })).sources).toEqual([]);
  });

  it("lists the workspace and adds a file from it", async () => {
    const { f, id } = await setup();
    const entries = await f.invoke("workspace.list", {});
    expect(entries.map((e: { name: string }) => e.name)).toContain("docs");
    const docs = await f.invoke("workspace.list", { dir: "docs" });
    expect(docs.find((e: { name: string }) => e.name === "a.md")).toMatchObject({
      kind: "file",
      bytes: 27,
    });
    const { jobId } = await f.invoke("sources.addFromWorkspace", {
      notebookId: id,
      path: "docs/a.md",
    });
    expect((await f.waitJob(jobId)).state).toBe("done");
    expect((await f.invoke("notebooks.get", { id })).sources[0].name).toBe("a.md");
  });

  it("reads workspace PDFs for the frame only, and rejects large files", async () => {
    const { f } = await setup();
    await writeFile(join(f.workspace, "docs", "p.pdf"), "%PDF-1.4");
    expect(await f.invoke("sources.read", { path: "docs/p.pdf" })).toEqual({
      base64: Buffer.from("%PDF-1.4").toString("base64"),
    });
    await expect(f.invoke("sources.read", { path: "docs/a.md" })).rejects.toMatchObject({
      code: "unsupported_format",
    });
    await writeFile(join(f.workspace, "big.txt"), Buffer.alloc(26 * 1024 * 1024, 97));
    const { id } = await f.invoke("notebooks.create", { title: "Big" });
    await expect(
      f.invoke("sources.addFromWorkspace", { notebookId: id, path: "big.txt" }),
    ).rejects.toMatchObject({
      code: "file_too_large",
    });
  });
});
