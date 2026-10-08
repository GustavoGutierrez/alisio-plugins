import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactPublisher,
  ArtifactRef,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { loadImage } from "@napi-rs/canvas";
import { afterAll, describe, expect, it } from "vitest";
import { registerCardsmithTools } from "../src/index.js";
import { NO_ARTIFACT_BRIDGE_NOTICE } from "../src/integrations/artifacts.js";
import { copyIntoWorkspace, moveIntoWorkspace } from "../src/integrations/workspace.js";
import { captureAsyncError } from "./helpers.js";

const cleanups: string[] = [];

async function makeWorkspace(prefix = "cardsmith-it-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ARTIFACT_REF: ArtifactRef = {
  id: "art_test_0001",
  sessionId: "session-test",
  title: "Cardsmith card",
  fileName: "card.png",
  kind: "image",
  mimeType: "image/png",
  bytes: 3,
  fileCount: 1,
  previewable: true,
  createdAt: 1_700_000_000_000,
  status: "ready",
};

interface Harness {
  workspace: string;
  tools: Map<string, ToolDefinition>;
  skills: string[];
  run: (name: string, input?: Record<string, unknown>) => Promise<ToolResult>;
  modelCalls: () => number;
  dispose: () => void;
}

interface HarnessOptions {
  artifacts?: ArtifactPublisher;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = await makeWorkspace();
  const tools = new Map<string, ToolDefinition>();
  const skills: string[] = [];
  let modelCalls = 0;
  const api = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    resources: {
      skills: (path: string) => {
        skills.push(path);
      },
    },
    model: {
      complete: async () => {
        modelCalls += 1;
        return "";
      },
    },
  } as unknown as PluginAPI;
  const dispose = registerCardsmithTools(api);
  const run = async (name: string, input: Record<string, unknown> = {}): Promise<ToolResult> => {
    const definition = tools.get(name);
    if (definition === undefined) throw new Error(`No tool ${name}`);
    const context: ToolContext = {
      signal: new AbortController().signal,
      workspace,
      emit() {},
      ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    };
    return definition.execute(input, context);
  };
  return { workspace, tools, skills, run, modelCalls: () => modelCalls, dispose };
}

function firstText(result: ToolResult): string {
  const part = result.content[0];
  return part !== undefined && part.type === "text" ? part.text : "";
}

function imagePart(result: ToolResult): Extract<ToolResult["content"][number], { type: "image" }> {
  const part = result.content.find((entry) => entry.type === "image");
  if (part === undefined || part.type !== "image") throw new Error("Expected an image part");
  return part;
}

function uiPart(
  result: ToolResult,
): Extract<ToolResult["content"][number], { type: "ui" }> | undefined {
  return result.content.find(
    (entry): entry is Extract<ToolResult["content"][number], { type: "ui" }> => entry.type === "ui",
  );
}

const DRAFT_ID_PATTERN = /draft ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function draftIdFrom(result: ToolResult): string {
  const match = DRAFT_ID_PATTERN.exec(firstText(result));
  if (match === null) throw new Error(`No draft id in "${firstText(result)}"`);
  return match[1] ?? "";
}

function draftFile(workspace: string, draftId: string): string {
  return join(workspace, ".alisio", "cardsmith", "drafts", `${draftId}.json`);
}

function workingFile(workspace: string, name: string): string {
  return join(workspace, ".alisio", "cardsmith", "working", name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createDraft(h: Harness): Promise<string> {
  const result = await h.run("card_design", {
    family: "social",
    templateId: "retro-message",
    content: { title: "Buenos días" },
  });
  if (result.isError === true) throw new Error(`design failed: ${firstText(result)}`);
  return draftIdFrom(result);
}

const RENDER_TIMEOUT = 30_000;

describe("cardsmith tool registration", () => {
  it("registers exactly five tools with effects and strict JSON schemas", async () => {
    const h = await harness();
    expect([...h.tools.keys()].sort()).toEqual([
      "card_catalog",
      "card_design",
      "card_export",
      "card_render",
      "card_update",
    ]);
    expect(h.tools.get("card_catalog")?.effect).toBe("read");
    for (const name of ["card_design", "card_update", "card_render", "card_export"]) {
      expect(h.tools.get(name)?.effect).toBe("write");
    }
    for (const tool of h.tools.values()) {
      const schema = tool.inputSchema as { type?: unknown; additionalProperties?: unknown };
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
    h.dispose();
    expect(h.tools.size).toBe(0);
  });
});

describe("card_catalog", () => {
  it("returns ids and compatible sizes without any binary payload", async () => {
    const h = await harness();
    const result = await h.run("card_catalog");
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("retro-message");
    expect(text).toContain("social-portrait");
    expect(text).toContain("alisio-ocean");
    expect(text).toContain("illustrations (39):");
    expect(text).toContain("rainbow-kawaii [kawaii, decoration]");
    expect(text).toContain("default illustration: flower-happy");
    expect(text).toContain("formats: png, jpeg");
    expect(text).not.toMatch(/[A-Za-z0-9+/]{200,}/);
    expect(text.length).toBeLessThan(8_000);
  });

  it("filters by family and template", async () => {
    const h = await harness();
    const charts = await h.run("card_catalog", { family: "chart" });
    expect(firstText(charts)).toContain("bar");
    expect(firstText(charts)).not.toContain("retro-message");
    const one = await h.run("card_catalog", { templateId: "retro-message" });
    expect(firstText(one)).toContain("retro-message");
    expect(firstText(one)).not.toContain("editorial-photo");
  });
});

describe("card_design and card_update", () => {
  it("creates a persisted draft at revision 1 with a compact summary", async () => {
    const h = await harness();
    const result = await h.run("card_design", {
      family: "social",
      templateId: "retro-message",
      content: { title: "Buenos días" },
    });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    const draftId = draftIdFrom(result);
    expect(text).toContain("revision 1");
    expect(text).not.toMatch(/[A-Za-z0-9+/]{200,}/);
    expect(text.length).toBeLessThan(500);
    const record = JSON.parse(await readFile(draftFile(h.workspace, draftId), "utf8"));
    expect(record.id).toBe(draftId);
    expect(record.revision).toBe(1);
    expect(record.spec.paletteId).toBe("retro-calido");
    expect(record.spec.content.title).toBe("Buenos días");
  });

  it("returns structured errors and creates no draft for an invalid spec", async () => {
    const h = await harness();
    const result = await h.run("card_design", {
      family: "social",
      templateId: "retro-message",
      content: {},
    });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("INVALID_SPEC");
    expect(text).toContain("title");
    expect(await readdir(join(h.workspace, ".alisio", "cardsmith", "drafts"))).toEqual([]);
  });

  it("bumps the revision and rejects stale expected revisions", async () => {
    const h = await harness();
    const draftId = await createDraft(h);
    const updated = await h.run("card_update", {
      draftId,
      expectedRevision: 1,
      patch: { content: { message: "Que tengas un gran día" } },
    });
    expect(updated.isError).toBeFalsy();
    expect(firstText(updated)).toContain("revision 2");
    const record = JSON.parse(await readFile(draftFile(h.workspace, draftId), "utf8"));
    expect(record.spec.content.title).toBe("Buenos días");
    expect(record.spec.content.message).toBe("Que tengas un gran día");

    const stale = await h.run("card_update", {
      draftId,
      expectedRevision: 1,
      patch: { paletteId: "alisio-ocean" },
    });
    expect(stale.isError).toBe(true);
    expect(firstText(stale)).toContain("REVISION_MISMATCH");
    const unchanged = JSON.parse(await readFile(draftFile(h.workspace, draftId), "utf8"));
    expect(unchanged.spec.paletteId).toBe("retro-calido");
  });

  it("changes the palette deterministically, without any model call", async () => {
    const h = await harness();
    const draftId = await createDraft(h);
    const result = await h.run("card_update", {
      draftId,
      expectedRevision: 1,
      patch: { paletteId: "alisio-ocean" },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("revision 2");
    expect(h.modelCalls()).toBe(0);
    const record = JSON.parse(await readFile(draftFile(h.workspace, draftId), "utf8"));
    expect(record.spec.paletteId).toBe("alisio-ocean");
  });
});

describe("card_render", () => {
  it(
    "renders a final image with the no-bridge notice and no artifact block",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const result = await h.run("card_render", { draftId, mode: "final" });
      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("final 1080x1350 png");
      expect(text).toContain(NO_ARTIFACT_BRIDGE_NOTICE);
      const decoded = await loadImage(Buffer.from(imagePart(result).data, "base64"));
      expect(decoded.width).toBe(1080);
      expect(decoded.height).toBe(1350);
      expect(uiPart(result)).toBeUndefined();
      expect(await exists(workingFile(h.workspace, `${draftId.slice(0, 8)}-r1-final.png`))).toBe(
        true,
      );
    },
    RENDER_TIMEOUT,
  );

  it(
    "publishes an artifact block when the host offers a publisher",
    async () => {
      const published: Array<{ source: string; title?: string }> = [];
      const artifacts: ArtifactPublisher = {
        async publish(input) {
          published.push({
            source: input.source,
            ...(input.title !== undefined ? { title: input.title } : {}),
          });
          return ARTIFACT_REF;
        },
        async publishText() {
          throw new Error("publishText is not used by cardsmith");
        },
      };
      const h = await harness({ artifacts });
      const draftId = await createDraft(h);
      const result = await h.run("card_render", { draftId, mode: "final" });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain(`artifact ${ARTIFACT_REF.id}`);
      expect(firstText(result)).not.toContain(NO_ARTIFACT_BRIDGE_NOTICE);
      expect(published).toHaveLength(1);
      const source = published[0]?.source ?? "";
      expect(source.endsWith("-r1-final.png")).toBe(true);
      expect(await exists(source)).toBe(true);
      const ui = uiPart(result);
      expect(ui?.block.kind).toBe("artifact");
      if (ui !== undefined && ui.block.kind === "artifact") {
        expect(ui.block.artifact).toEqual(ARTIFACT_REF);
      }
    },
    RENDER_TIMEOUT,
  );

  it(
    "renders a smaller preview without an artifact block",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const result = await h.run("card_render", { draftId, mode: "preview" });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("preview 378x472 png");
      expect(firstText(result)).not.toContain(NO_ARTIFACT_BRIDGE_NOTICE);
      const decoded = await loadImage(Buffer.from(imagePart(result).data, "base64"));
      expect(decoded.width).toBe(378);
      expect(decoded.height).toBe(472);
      expect(uiPart(result)).toBeUndefined();
      await expect(
        readFile(workingFile(h.workspace, `${draftId.slice(0, 8)}-r1-final.png`)),
      ).rejects.toThrow();
    },
    RENDER_TIMEOUT,
  );

  it(
    "serves a second identical render from the cache with byte-identical bytes",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const first = await h.run("card_render", { draftId, mode: "final" });
      const second = await h.run("card_render", { draftId, mode: "final" });
      expect(firstText(first)).not.toContain("cache hit");
      expect(firstText(second)).toContain("cache hit");
      expect(imagePart(second).data).toBe(imagePart(first).data);
    },
    RENDER_TIMEOUT,
  );

  it(
    "rejects input image paths that escape the workspace",
    async () => {
      const h = await harness();
      const design = await h.run("card_design", {
        family: "composite",
        templateId: "photo-caption",
        content: { caption: "Hola" },
        images: [{ id: "photo", path: "../escape.png" }],
      });
      expect(design.isError).toBeFalsy();
      const result = await h.run("card_render", { draftId: draftIdFrom(design) });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("EXPORT_INVALID_PATH");
    },
    RENDER_TIMEOUT,
  );
});

describe("card_export", () => {
  it(
    "copies the final image into the workspace with the default name",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const rendered = await h.run("card_render", { draftId, mode: "final" });
      const imageBytes = Buffer.from(imagePart(rendered).data, "base64");
      const result = await h.run("card_export", { draftId });
      expect(result.isError).toBeFalsy();
      const name = `card-${draftId.slice(0, 8)}.png`;
      expect(firstText(result)).toContain(name);
      expect(firstText(result)).toContain("saved");
      expect(await readFile(join(h.workspace, name))).toEqual(imageBytes);
      expect(await exists(workingFile(h.workspace, `${draftId.slice(0, 8)}-r1-final.png`))).toBe(
        true,
      );
    },
    RENDER_TIMEOUT,
  );

  it(
    "reports EXPORT_CONFLICT with a suggestion and keeps the original file",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const rendered = await h.run("card_render", { draftId, mode: "final" });
      const imageBytes = Buffer.from(imagePart(rendered).data, "base64");
      await h.run("card_export", { draftId });
      const second = await h.run("card_export", { draftId });
      expect(second.isError).toBe(true);
      const text = firstText(second);
      expect(text).toContain("EXPORT_CONFLICT");
      expect(text).toContain(`card-${draftId.slice(0, 8)}-2.png`);
      expect(await readFile(join(h.workspace, `card-${draftId.slice(0, 8)}.png`))).toEqual(
        imageBytes,
      );
    },
    RENDER_TIMEOUT,
  );

  it(
    "overwrites an existing destination when asked",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      await h.run("card_render", { draftId, mode: "final" });
      await h.run("card_export", { draftId });
      const second = await h.run("card_export", { draftId, overwrite: true });
      expect(second.isError).toBeFalsy();
      expect(await readFile(join(h.workspace, `card-${draftId.slice(0, 8)}.png`))).toBeInstanceOf(
        Buffer,
      );
    },
    RENDER_TIMEOUT,
  );

  it(
    "rejects traversal, absolute and symlink-escape destinations",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      await h.run("card_render", { draftId, mode: "final" });

      const traversal = await h.run("card_export", { draftId, path: "../evil.png" });
      expect(traversal.isError).toBe(true);
      expect(firstText(traversal)).toContain("EXPORT_INVALID_PATH");
      expect(await exists(join(h.workspace, "..", "evil.png"))).toBe(false);

      const absoluteTarget = join(tmpdir(), `cardsmith-absolute-evil-${Date.now()}.png`);
      const absolute = await h.run("card_export", { draftId, path: absoluteTarget });
      expect(absolute.isError).toBe(true);
      expect(firstText(absolute)).toContain("EXPORT_INVALID_PATH");
      expect(await exists(absoluteTarget)).toBe(false);

      const outside = await makeWorkspace("cardsmith-outside-");
      await symlink(outside, join(h.workspace, "link"), "dir");
      const symlinked = await h.run("card_export", { draftId, path: "link/evil.png" });
      expect(symlinked.isError).toBe(true);
      expect(firstText(symlinked)).toContain("EXPORT_INVALID_PATH");
      expect(await exists(join(outside, "evil.png"))).toBe(false);
    },
    RENDER_TIMEOUT,
  );

  it(
    "moves the working file only after a verified copy",
    async () => {
      const h = await harness();
      const draftId = await createDraft(h);
      const rendered = await h.run("card_render", { draftId, mode: "final" });
      const imageBytes = Buffer.from(imagePart(rendered).data, "base64");
      const source = workingFile(h.workspace, `${draftId.slice(0, 8)}-r1-final.png`);
      const result = await h.run("card_export", { draftId, path: "moved.png", mode: "move" });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("moved");
      expect(await readFile(join(h.workspace, "moved.png"))).toEqual(imageBytes);
      expect(await exists(source)).toBe(false);
    },
    RENDER_TIMEOUT,
  );

  it("fails cleanly when the source cannot be copied, leaving no partial file", async () => {
    const h = await harness();
    const source = join(h.workspace, "missing.png");
    const destination = join(h.workspace, "out.png");
    await expect(copyIntoWorkspace(source, destination)).rejects.toThrow();
    expect(await exists(destination)).toBe(false);
    const leftovers = (await readdir(h.workspace)).filter((name) => name.startsWith(".cardsmith-"));
    expect(leftovers).toEqual([]);
  });

  it("reports EXPORT_DELETE_FAILED and keeps the destination when the source cannot be removed", async () => {
    const h = await harness();
    const source = join(h.workspace, "source.png");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await writeFile(source, bytes);
    const destination = join(h.workspace, "kept.png");
    const error = await captureAsyncError(() =>
      moveIntoWorkspace(source, destination, {
        overwrite: true,
        removeSource: async () => {
          const failure = new Error("ENOENT: source already gone") as NodeJS.ErrnoException;
          failure.code = "ENOENT";
          throw failure;
        },
      }),
    );
    expect(error.code).toBe("EXPORT_DELETE_FAILED");
    expect(await readFile(destination)).toEqual(bytes);
    expect(await readFile(source)).toEqual(bytes);
  });
});
