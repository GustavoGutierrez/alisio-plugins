import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, intakeAnswers } from "./helpers/harness.js";
import { studio } from "./helpers/studio.js";

const outside: string[] = [];
afterEach(async () => {
  await cleanup();
  await Promise.all(outside.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function initialized() {
  const s = await studio({ answers: intakeAnswers });
  await s.h.run("init", "--lang es-CO");
  return s;
}

describe("file allowlist (THA-AC-14)", () => {
  it("refuses traversal, absolute, chapter and symlink-escape paths and writes nothing", async () => {
    const s = await initialized();
    const elsewhere = await mkdtemp(join(tmpdir(), "thesis-outside-"));
    outside.push(elsewhere);
    await writeFile(join(elsewhere, "x.yaml"), "secret: 1\n");
    await mkdir(join(s.h.workspace, "thesis", "policy"), { recursive: true });
    await symlink(join(elsewhere, "x.yaml"), join(s.h.workspace, "thesis", "policy", "link.yaml"));
    await symlink(elsewhere, join(s.h.workspace, "thesis", "data", "escape"));
    const paths = [
      "../x.yaml",
      "/etc/passwd",
      "chapters/x.md",
      "policy/link.yaml",
      "data/escape/x.csv",
      "policy/../thesis.yaml",
      "state.json",
    ];
    for (const path of paths) {
      expect(await s.call("files.read", { path }), path).toEqual({ error: "path_not_allowed" });
      expect(
        await s.call("files.write", { path, content: "a: 1\n", revision: "none" }),
        path,
      ).toEqual({ error: "path_not_allowed" });
    }
    expect(await readFile(join(elsewhere, "x.yaml"), "utf8")).toBe("secret: 1\n");
    // Read-only files can be read but never written.
    await mkdir(join(s.h.workspace, "thesis", "styles"), { recursive: true });
    await writeFile(join(s.h.workspace, "thesis", "styles", "mine.csl"), "<style/>");
    const csl = (await s.call("files.read", { path: "styles/mine.csl" })).value as Record<
      string,
      unknown
    >;
    expect(csl).toMatchObject({
      editable: false,
      text: "<style/>",
      display: "thesis/styles/mine.csl",
    });
    expect(
      await s.call("files.write", {
        path: "styles/mine.csl",
        content: "<x/>",
        revision: csl.revision,
      }),
    ).toEqual({ error: "path_not_allowed" });
    const listed = (await s.call("files.list", {})).value as {
      files: { path: string; editable: boolean }[];
    };
    expect(listed.files).toContainEqual(
      expect.objectContaining({ path: "thesis.yaml", editable: true }),
    );
    expect(listed.files).toContainEqual(
      expect.objectContaining({ path: "styles/mine.csl", editable: false }),
    );
    expect(listed.files.map((f) => f.path)).not.toContain("chapters/x.md");
  });
});

describe("thesis.yaml editor (THA-AC-15)", () => {
  it("refuses a YAML syntax error with its line, and saves valid text with G0 findings", async () => {
    const s = await initialized();
    const file = (await s.call("files.read", { path: "thesis.yaml" })).value as {
      text: string;
      revision: string;
      editable: boolean;
    };
    expect(file.editable).toBe(true);
    const broken = `${file.text}\nbroken: [unclosed\n`;
    const refused = await s.call("files.write", {
      path: "thesis.yaml",
      content: broken,
      revision: file.revision,
    });
    expect(refused).toMatchObject({ error: "invalid_input", line: expect.any(Number) });
    expect(await readFile(join(s.h.workspace, "thesis", "thesis.yaml"), "utf8")).toBe(file.text);

    // A stale revision is a conflict.
    expect(
      await s.call("files.write", { path: "thesis.yaml", content: file.text, revision: "none" }),
    ).toEqual({ error: "conflict" });

    const edited = `${file.text.trimEnd()}\n# edited in Thesis Studio\n`;
    const saved = await s.call("files.write", {
      path: "thesis.yaml",
      content: edited,
      revision: file.revision,
    });
    expect(saved.error).toBeUndefined();
    expect(saved.value).toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Array.isArray((saved.value as { findings: unknown[] }).findings)).toBe(true);
    expect(await readFile(join(s.h.workspace, "thesis", "thesis.yaml"), "utf8")).toBe(edited);
  });
});
