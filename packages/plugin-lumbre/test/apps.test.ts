import { describe, expect, it } from "vitest";
import {
  buildActions,
  PROCESS_ACTIONS,
  READ_ACTIONS,
  SCHEMAS,
  unsupportedSchemaKeywords,
  WRITE_ACTIONS,
} from "../src/apps.js";
import { LumbreError } from "../src/errors.js";

const ctx = (signal = new AbortController().signal) => ({ sessionId: "s", workspace: "w", signal });

/** Every leaf string must be bounded (or an enum/pattern), every object closed. */
function strict(schema: Record<string, unknown>, at: string): string[] {
  const problems: string[] = [];
  const types = ([] as unknown[]).concat(schema.type);
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) problems.push(`${at}: open object`);
    for (const [k, v] of Object.entries(
      (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
    ))
      problems.push(...strict(v, `${at}.${k}`));
  }
  if (types.includes("string") && !schema.maxLength && !schema.enum && !schema.pattern)
    problems.push(`${at}: unbounded string`);
  if (types.includes("array")) {
    if (!schema.maxItems) problems.push(`${at}: unbounded array`);
    problems.push(...strict(schema.items as Record<string, unknown>, `${at}[]`));
  }
  return problems;
}

describe("app actions (LMB-AC-02)", () => {
  it("declares every action once with a strict schema the host accepts", () => {
    const all = [...READ_ACTIONS, ...WRITE_ACTIONS, ...PROCESS_ACTIONS];
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(SCHEMAS).sort()).toEqual([...all].sort());
    for (const name of all) {
      const schema = SCHEMAS[name] as Record<string, unknown>;
      expect(unsupportedSchemaKeywords(schema), name).toEqual([]);
      expect(strict(schema, name), name).toEqual([]);
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
    }
  });

  it("assigns the effect by group: npm, builds and servers are process; changes are write", () => {
    const actions = buildActions(async () => ({ invoke: async () => null }));
    expect(actions["projects.list"]?.effect).toBe("read");
    expect(actions["project.zip"]?.effect).toBe("read");
    expect(actions["chat.send"]?.effect).toBe("write");
    expect(actions["project.export"]?.effect).toBe("write");
    expect(actions["proposal.apply"]?.effect).toBe("write");
    for (const name of [
      "preview.check",
      "deps.install",
      "server.start",
      "server.stop",
      "server.open",
    ])
      expect(actions[name]?.effect, name).toBe("process");
  });

  it("returns codes only, including for an aborted call, and never echoes the input", async () => {
    const actions = buildActions(async () => ({
      invoke: async () => {
        throw new Error("secret /srv/private/path token=abc");
      },
    }));
    const failed = await actions["projects.get"]?.handler({ projectId: "x" }, ctx());
    expect(failed).toEqual({ error: "operation_failed" });
    const known = buildActions(async () => ({
      invoke: async () => {
        throw new LumbreError("conflict");
      },
    }));
    expect(await known["files.save"]?.handler({}, ctx())).toEqual({ error: "conflict" });
    const controller = new AbortController();
    controller.abort();
    expect(await actions["projects.list"]?.handler({}, ctx(controller.signal))).toEqual({
      error: "cancelled",
    });
    const ok = buildActions(async () => ({ invoke: async (action) => ({ action }) }));
    expect(await ok.status?.handler(undefined, ctx())).toEqual({ value: { action: "status" } });
  });
});
