import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envelopeExamples } from "../src/application/agents/examples.js";
import { prepareSource } from "../src/application/workflow/source-spec.js";
import { sha256 } from "../src/infrastructure/crypto/sha256.js";
import { FsSourceReader } from "../src/infrastructure/fs/source-reader.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

const deps = { sources: new FsSourceReader(), sha256 };
let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

describe("prepareSource", () => {
  it("reads a markdown spec, normalizes it and derives the intent", async () => {
    ws = await tempWorkspace({ "specs/cart.md": "﻿# Cart page\r\nBody\r\n" });
    const result = await prepareSource(deps, ws.root, "./specs/cart.md", "L2");
    expect(result).toMatchObject({
      ok: true,
      source: {
        path: "specs/cart.md",
        format: "markdown",
        text: "# Cart page\nBody\n",
        intent: "Cart page (from specs/cart.md)",
      },
    });
    if (result.ok) expect(result.source.sha256).toBe(sha256("# Cart page\nBody\n"));
  });

  it("accepts a valid json envelope and carries the parsed spec", async () => {
    ws = await tempWorkspace({ "spec.json": JSON.stringify(envelopeExamples.spec) });
    const result = await prepareSource(deps, ws.root, "spec.json", "L1");
    expect(result).toMatchObject({ ok: true, source: { format: "spec-json" } });
    if (result.ok) expect(result.source.spec?.kind).toBe("spec");
  });

  it("names SRC-007 for a json file that is not an envelope", async () => {
    ws = await tempWorkspace({ "spec.json": '{"a":1}' });
    expect(await prepareSource(deps, ws.root, "spec.json")).toMatchObject({
      ok: false,
      code: "SRC-007",
    });
  });

  it("refuses L0, missing files, directories, oversize and bad bytes", async () => {
    ws = await tempWorkspace({
      "a.md": "# x",
      "dir.md/inner.md": "# x",
      "big.md": "a".repeat(131_073),
      "blank.md": "  \n",
    });
    expect(await prepareSource(deps, ws.root, "a.md", "L0")).toMatchObject({ code: "SRC-008" });
    expect(await prepareSource(deps, ws.root, "nope.md")).toMatchObject({ code: "SRC-004" });
    expect(await prepareSource(deps, ws.root, "dir.md")).toMatchObject({ code: "SRC-004" });
    expect(await prepareSource(deps, ws.root, "big.md")).toMatchObject({ code: "SRC-005" });
    expect(await prepareSource(deps, ws.root, "blank.md")).toMatchObject({ code: "SRC-006" });
    await writeFile(join(ws.root, "bad.md"), new Uint8Array([0xff, 0xfe, 0x41]));
    expect(await prepareSource(deps, ws.root, "bad.md")).toMatchObject({ code: "SRC-006" });
  });

  it("refuses a symlink that leaves the workspace with SRC-001", async () => {
    ws = await tempWorkspace({});
    const outside = await tempWorkspace({ "secret.md": "# secret" });
    try {
      await mkdir(join(ws.root, "specs"), { recursive: true });
      await symlink(join(outside.root, "secret.md"), join(ws.root, "specs/link.md"));
      expect(await prepareSource(deps, ws.root, "specs/link.md")).toMatchObject({
        ok: false,
        code: "SRC-001",
      });
    } finally {
      await outside.cleanup();
    }
  });

  it("refuses path forms before touching the disk", async () => {
    ws = await tempWorkspace({});
    expect(await prepareSource(deps, ws.root, "../x.md")).toMatchObject({ code: "SRC-001" });
    expect(await prepareSource(deps, ws.root, ".git/x.md")).toMatchObject({ code: "SRC-002" });
    expect(await prepareSource(deps, ws.root, "x.txt")).toMatchObject({ code: "SRC-003" });
  });
});
