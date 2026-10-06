import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskQuestionsRequest } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/interface/plugin/workflow.js";
import { pluginFixture } from "./helpers/plugin.js";

const FILES = { "specs/p.md": "# Projects\n\nList them.\n" };

describe("/frontsmith:new --from-spec", () => {
  it("parses the flag as a value flag", () => {
    expect(parseCommandLine("projects --from-spec specs/p.md --level L1")).toMatchObject({
      words: ["projects"],
      flags: { "from-spec": "specs/p.md", level: "L1" },
      text: "",
    });
    expect(() => parseCommandLine("projects --from-spec")).toThrow(/needs a value/);
  });

  it("creates a feature from the file without an intent", async () => {
    const { f, harness } = await pluginFixture({ files: FILES });
    try {
      const out = await harness.callCommand(
        "new",
        "projects --level L1 --from-spec ./specs/p.md",
        "s1",
      );
      expect(out).toContain("Created `projects` (L1, build)");
      const state = JSON.parse(
        await readFile(join(f.root, ".alisio/frontsmith/features/projects/state.json"), "utf8"),
      );
      expect(state.intent).toBe("Projects (from specs/p.md)");
      expect(state.source.path).toBe("specs/p.md");
    } finally {
      await f.cleanup();
    }
  });

  it("keeps an explicit intent after --", async () => {
    const { f, harness } = await pluginFixture({ files: FILES });
    try {
      await harness.callCommand("new", "projects --level L1 --from-spec specs/p.md -- Mine", "s1");
      expect(await harness.callCommand("status", "projects", "s1")).toContain("Intent: Mine");
    } finally {
      await f.cleanup();
    }
  });

  it("reports SRC errors as messages, and still needs an intent without a source", async () => {
    const { f, harness } = await pluginFixture({ files: FILES });
    try {
      expect(
        await harness.callCommand("new", "projects --level L0 --from-spec specs/p.md", "s1"),
      ).toContain("SRC-008");
      expect(
        await harness.callCommand("new", "projects --level L1 --from-spec ../p.md", "s1"),
      ).toContain("SRC-001");
      expect(await harness.callCommand("new", "projects --level L1", "s1")).toContain("Usage:");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects a path with whitespace as a usage error", async () => {
    const { f, harness } = await pluginFixture({ files: FILES });
    try {
      const out = await harness.callCommand(
        "new",
        "projects --level L1 --from-spec my spec.md",
        "s1",
      );
      expect(out).toContain("Usage:");
      expect(out).toContain("--from-spec");
    } finally {
      await f.cleanup();
    }
  });

  it("does not offer L0 in the level dialog when a source is given", async () => {
    const asked: AskQuestionsRequest[] = [];
    const { f, harness } = await pluginFixture({
      files: FILES,
      ui: {
        interactive: () => true,
        askQuestions: async (request) => {
          asked.push(request);
          return { level: "L2" };
        },
      },
    });
    try {
      const out = await harness.callCommand("new", "projects --from-spec specs/p.md", "s1");
      expect(out).toContain("Created `projects` (L2, build)");
      expect(asked[0]?.questions[0]?.options.map((o) => o.value)).toEqual(["L1", "L2", "L3"]);
    } finally {
      await f.cleanup();
    }
  });

  it("advertises the flag in the command hint", async () => {
    const { f, harness } = await pluginFixture();
    try {
      expect(harness.commands.get("new")?.options?.argumentHint).toContain("--from-spec");
    } finally {
      await f.cleanup();
    }
  });
});
