import { cp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFrontsmith } from "../src/index.js";
import { createHarness } from "./helpers/harness.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const fixture = new URL("./fixtures/projects/react-fsd", import.meta.url).pathname;

describe("detection tools", () => {
  it("registers the tools implemented so far, with their effects", () => {
    const harness = createHarness();
    registerFrontsmith(harness.api);
    const processTools = [
      "fs_a11y_run",
      "fs_budget_check",
      "fs_fidelity_run",
      "fs_gate_run",
      "fs_next",
      "fs_phase_run",
    ];
    const writeTools = ["fs_answer", "fs_approval_request", "fs_feature_new"];
    expect([...harness.tools.keys()].sort()).toEqual(
      [
        "fs_a11y_run",
        "fs_answer",
        "fs_approval_request",
        "fs_architecture_check",
        "fs_budget_check",
        "fs_contrast",
        "fs_detect_stack",
        "fs_feature_new",
        "fs_fidelity_run",
        "fs_gate_run",
        "fs_inventory",
        "fs_models",
        "fs_next",
        "fs_palette_generate",
        "fs_phase_run",
        "fs_rules_check",
        "fs_rules_list",
        "fs_status",
        "fs_tokens_check",
      ].sort(),
    );
    for (const tool of harness.tools.values()) {
      expect(tool.effect).toBe(
        writeTools.includes(tool.name)
          ? "write"
          : processTools.includes(tool.name)
            ? "process"
            : "read",
      );
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("returns the stack profile as text, key-value and json", async () => {
    ws = await tempWorkspace();
    await cp(fixture, ws.root, { recursive: true });
    const harness = createHarness();
    registerFrontsmith(harness.api);
    const result = await harness.callTool("fs_detect_stack", {}, ws.root);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({ framework: "react", packageManager: "pnpm" });
    expect(result.content[1]).toMatchObject({ type: "ui", block: { kind: "key-value" } });
    expect(result.content[2]).toMatchObject({ type: "ui", block: { kind: "json" } });
  });

  it("lists the inventory as a table and validates its input", async () => {
    ws = await tempWorkspace();
    await cp(fixture, ws.root, { recursive: true });
    const harness = createHarness();
    registerFrontsmith(harness.api);
    const result = await harness.callTool("fs_inventory", { kind: "components" }, ws.root);
    const block = result.content.find((part) => part.type === "ui");
    expect(block).toMatchObject({
      block: { kind: "table", columns: ["name", "path", "layer", "kind"] },
    });
    const names =
      block?.type === "ui" && block.block.kind === "table" ? block.block.rows.map((r) => r[0]) : [];
    expect(names).toEqual(expect.arrayContaining(["App", "ProjectList", "ProjectsPage", "Card"]));
    const bad = await harness.callTool("fs_inventory", { kind: "bogus" }, ws.root);
    expect(bad.isError).toBe(true);
    const extra = await harness.callTool("fs_detect_stack", { surprise: 1 }, ws.root);
    expect(extra.isError).toBe(true);
    void join;
  });
});
