import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_ACTIONS,
  effectOf,
  PROCESS_ACTIONS,
  READ_ACTIONS,
  SCHEMAS,
  unsupportedSchemaKeywords,
  WRITE_ACTIONS,
} from "../src/app/actions.js";
import { json, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers } from "./helpers/harness.js";
import { studio } from "./helpers/studio.js";

afterEach(cleanup);

const COMMANDS = [
  "init",
  "answer",
  "status",
  "check",
  "pack",
  "style",
  "norms",
  "design",
  "outline",
  "approve",
  "revise",
  "research",
  "draft",
  "figure",
  "review",
  "finalize",
  "build",
  "setup",
  "next",
  "doctor",
];
const TOOLS = [
  "thesis_answer",
  "thesis_scholar_search",
  "thesis_scholar_resolve",
  "thesis_status",
  "thesis_check",
  "thesis_build",
];

describe("registration (THA-AC-01)", () => {
  it("registers every command and tool without api.apps, and explains the minimum host", async () => {
    const s = await studio({ apps: false });
    expect([...s.h.commands.keys()].sort()).toEqual([...COMMANDS].sort());
    expect([...s.h.tools.keys()].sort()).toEqual([...TOOLS].sort());
    expect(s.app).toBeUndefined();
    expect(await s.h.run("status")).toContain("App: Thesis Studio needs Alisio 0.11.6 or newer.");
  });

  it("registers the same commands and tools plus the studio app when api.apps exists", async () => {
    const s = await studio();
    expect([...s.h.commands.keys()].sort()).toEqual([...COMMANDS].sort());
    expect([...s.h.tools.keys()].sort()).toEqual([...TOOLS].sort());
    expect(s.app?.id).toBe("studio");
    expect(s.app?.label).toEqual({ en: "Thesis Studio", es: "Estudio de tesis" });
    expect(await s.h.run("status")).toContain(
      "App: Thesis Studio is available in Alisio's Apps list.",
    );
  });
});

describe("action map (THA-AC-02)", () => {
  it("declares effects exactly as the spec table and safe schemas", async () => {
    const s = await studio();
    const actions = s.app?.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual([...ALL_ACTIONS].sort());
    expect(READ_ACTIONS).toEqual([
      "status",
      "interview.get",
      "artifact.get",
      "evidence.list",
      "claims.list",
      "findings.list",
      "check.last",
      "packs.list",
      "packs.explain",
      "packs.check",
      "styles.list",
      "files.list",
      "files.read",
      "pdf.get",
      "models.list",
      "jobs.get",
    ]);
    expect(PROCESS_ACTIONS).toEqual(["build.run", "finalize.run", "engine.setup", "doctor.run"]);
    expect(WRITE_ACTIONS).toContain("approve");
    expect(WRITE_ACTIONS).toContain("files.write");
    expect(WRITE_ACTIONS).toContain("jobs.cancel");
    for (const [name, action] of Object.entries(actions)) {
      expect(action.effect, name).toBe(effectOf(name as never));
      const schema = action.inputSchema as Record<string, unknown>;
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
      expect(unsupportedSchemaKeywords(schema), name).toEqual([]);
      expect(SCHEMAS[name as keyof typeof SCHEMAS]).toBe(action.inputSchema);
    }
    // Every string property is bounded.
    const unbounded: string[] = [];
    const visit = (schema: unknown, at: string) => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as Record<string, unknown>;
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.includes("string") && node.maxLength === undefined && !node.enum)
        unbounded.push(at);
      if (types.includes("array") && node.maxItems === undefined) unbounded.push(at);
      for (const [key, value] of Object.entries(node)) visit(value, `${at}.${key}`);
    };
    for (const [name, schema] of Object.entries(SCHEMAS)) visit(schema, name);
    expect(unbounded).toEqual([]);
  });

  it("serves the embedded page lazily from dist", async () => {
    const s = await studio();
    expect(typeof s.app?.html).toBe("function");
  });
});

describe("error results (THA-AC-17)", () => {
  it("return codes only: no input, no message, no absolute path", async () => {
    const s = await studio({ answers: intakeAnswers });
    const secret = "SECRET-INPUT-áé";
    const results = [
      await s.call("approve", { target: "A", revision: "none" }),
      await s.call("files.read", { path: `../${secret}` }),
      await s.call("approve", { target: secret, revision: "none" }),
      await s.call("jobs.get", { jobId: "job-unknown" }),
      await s.call("packs.explain", { query: secret }),
    ];
    await s.h.run("init", "--lang es-CO");
    s.h.setInteractive(false);
    results.push(await s.call("approve", { target: "A", notes: secret, revision: "f".repeat(64) }));
    s.h.script("thesis-methodologist", "not json", "still not json");
    const job = (await s.call("design.run", {})).value as { jobId: string };
    const failed = await s.waitJob(job.jobId);
    // The workflow reports a rejected child as text (the same reply as the chat).
    expect(failed).toMatchObject({
      state: "done",
      result: expect.stringContaining("did not return a valid result"),
    });
    results.push(failed);
    // A blocked decision carries the coordinator reason without input or absolute paths.
    const blocked = await s.call("approve", {
      target: "OUTLINE",
      notes: secret,
      revision: await s.revision(),
    });
    expect(blocked.error).toBe("blocked");
    expect(typeof blocked.reason).toBe("string");
    results.push(blocked);
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(s.h.workspace);
      expect(text).not.toMatch(/at .+\.ts:\d+/);
    }
    expect(results.slice(0, 6).map((r) => r.error)).toEqual([
      "not_initialized",
      "path_not_allowed",
      "invalid_input",
      "not_found",
      "not_initialized",
      "conflict",
    ]);
  });
});

describe("activation lifecycle", () => {
  it("dispose is idempotent and leaves the commands working", async () => {
    const s = await studio({ answers: intakeAnswers });
    await s.h.run("init", "--lang es-CO");
    s.h.setInteractive(false);
    s.app?.dispose?.();
    s.app?.dispose?.();
    expect(s.app?.busy?.()).toBe(false);
    s.h.script("thesis-methodologist", json(protocolDraft()));
    expect(await s.h.run("design")).toContain("protocol");
    const state = JSON.parse(
      await readFile(join(s.h.workspace, ".alisio", "thesis", "state.json"), "utf8"),
    );
    expect(state.protocolAt).toBeDefined();
  });
});
