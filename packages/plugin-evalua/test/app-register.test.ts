import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_APP_LIMITS } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_LIMITS,
  PROCESS_ACTIONS,
  READ_ACTIONS,
  SCHEMAS,
  unsupportedSchemaKeywords,
  WRITE_ACTIONS,
} from "../src/app/register.js";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

afterEach(cleanup);

describe("hosts without apps (EVL-APP-AC-02)", () => {
  it("registers no app and keeps every command and tool", async () => {
    const h = await appHarness({ apps: false });
    expect(h.apps).toEqual([]);
    expect(await h.chat.run("status")).toMatch(/No Evalua workspace/);
    expect((await h.chat.tool("evalua_status")).text).toContain('"initialized": false');
  });

  it("stays fail-open when the host's app registration throws", async () => {
    const { registerEvalua } = await import("../src/index.js");
    const tools: string[] = [];
    const api = {
      commands: { register: () => () => undefined },
      tools: { register: (tool: { name: string }) => tools.push(tool.name) },
      resources: { agents() {}, skills() {} },
      sessions: { workspace: () => "/scratch/p" },
      ui: { status() {}, interactive: () => false, askQuestions: async () => ({}) },
      apps: {
        register() {
          throw new Error("host refused");
        },
      },
    };
    expect(() => registerEvalua(api as never)).not.toThrow();
    expect(tools).toHaveLength(8);
  });
});

describe("action map (EVL-APP-AC-03)", () => {
  it("declares the effects of the spec with closed, supported schemas", async () => {
    const h = await appHarness();
    const app = h.app;
    expect(app?.id).toBe("evalua");
    expect(app?.label).toEqual({ en: "Evalua", es: "Evalúa" });
    const actions = app?.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual(
      [...READ_ACTIONS, ...WRITE_ACTIONS, ...PROCESS_ACTIONS].sort(),
    );
    for (const name of READ_ACTIONS) expect(actions[name]?.effect, name).toBe("read");
    for (const name of WRITE_ACTIONS) expect(actions[name]?.effect, name).toBe("write");
    expect(actions["build.start"]?.effect).toBe("process");
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(unsupportedSchemaKeywords(schema), name).toEqual([]);
      expect((schema as { additionalProperties?: unknown }).additionalProperties, name).toBe(false);
      expect((schema as { type?: unknown }).type, name).toBe("object");
    }
    // Every string in every schema is bounded (or an enum / pattern).
    const unbounded = (schema: unknown, at: string): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const node = schema as Record<string, unknown>;
      const own =
        (node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"))) &&
        node.maxLength === undefined &&
        node.enum === undefined &&
        node.pattern === undefined
          ? [at]
          : [];
      return [
        ...own,
        ...Object.entries(node).flatMap(([key, value]) => unbounded(value, `${at}.${key}`)),
      ];
    };
    for (const [name, schema] of Object.entries(SCHEMAS))
      expect(unbounded(schema, name)).toEqual([]);
    // Mutations carry the revision the frame last saw (D2).
    for (const name of [...WRITE_ACTIONS, ...PROCESS_ACTIONS]) {
      if (name === "jobs.cancel" || name === "models.choose") continue;
      expect((SCHEMAS[name] as { required: string[] }).required, name).toContain(
        "expectedRevision",
      );
    }
  });

  it("returns codes without echoing the input", async () => {
    const h = await appHarness();
    const secret = "../../etc/passwd-SECRET";
    const results = [
      await h.call("docs.get", { examId: secret, doc: "exam", format: "pdf" }),
      await h.call("profile.save", {
        teacherName: secret,
        institution: "x",
        subject: "y",
        paper: "letter",
        language: "fr",
      }),
      await h.call("jobs.get", { jobId: secret }),
      await h.call("draft.create", { answers: { topic: secret }, expectedRevision: secret }),
      await h.call("nope" as never).catch(() => ({ error: "no action" })),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(typeof result.error).toBe("string");
    }
    expect(results.map((result) => result.error).slice(0, 4)).toEqual([
      "invalid_input",
      "invalid_input",
      "invalid_input",
      "state_changed",
    ]);
  });
});

describe("app limits (EVL-APP-AC-24)", () => {
  it("keeps local limit constants equal to the dev SDK's and never imports the SDK value", async () => {
    expect(APP_LIMITS).toEqual(PLUGIN_APP_LIMITS);
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    await walk(srcDir);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("PLUGIN_APP_LIMITS");
      // Only `definePlugin` (present since the oldest supported SDK) is a runtime SDK import.
      for (const match of source.matchAll(
        /^import\s+(?!type\b)\{([^}]*)\}\s+from\s+"@alisio\/sdk"/gm,
      )) {
        const values = (match[1] ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith("type "));
        expect(values, file).toEqual(values.length ? ["definePlugin"] : []);
      }
    }
  });
});
