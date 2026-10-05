import { describe, expect, it } from "vitest";
import { defaultLimits, defaultThresholds, parsePack, roleIds } from "../src/domain/pack.js";

const role = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: id,
  isolation: "worktree",
  receive: "task",
  propagation: "forward-only",
  ...extra,
});

const valid = () => ({
  schemaVersion: 1,
  name: "demo-pack",
  description: "Demo",
  toolchain: "node-ts",
  roles: [role("coder", { isolation: "master" }), role("cleaner")],
});

describe("parsePack", () => {
  it("parses a minimal pack and applies defaults", () => {
    const pack = parsePack(valid());
    expect(roleIds(pack)).toEqual(["coder", "cleaner"]);
    expect(pack.thresholds).toEqual(defaultThresholds);
    expect(pack.limits).toEqual(defaultLimits);
    expect(pack.approval).toBeUndefined();
    expect(defaultThresholds).toEqual({ coverage: 80, complexity: 6, crap: 8, mutation: 80 });
  });

  it("keeps explicit thresholds, approval, gates and limits", () => {
    const pack = parsePack({
      ...valid(),
      approval: { after: "coder" },
      thresholds: { crap: 5 },
      limits: { maxBounces: 1 },
      gates: { cleaner: ["crap", "dry"] },
    });
    expect(pack.approval).toEqual({ after: "coder" });
    expect(pack.thresholds).toEqual({ ...defaultThresholds, crap: 5 });
    expect(pack.limits.maxBounces).toBe(1);
    expect(pack.gates).toEqual({ cleaner: ["crap", "dry"] });
  });

  const rejects: Array<[string, (pack: Record<string, unknown>) => void, RegExp]> = [
    ["a non-object", () => undefined, /object/i],
    [
      "a wrong schemaVersion",
      (p) => {
        p.schemaVersion = 2;
      },
      /schemaVersion/,
    ],
    [
      "a bad pack name",
      (p) => {
        p.name = "Bad Name";
      },
      /pack name/i,
    ],
    [
      "an unknown top-level key",
      (p) => {
        p.extra = 1;
      },
      /unknown key/i,
    ],
    [
      "no roles",
      (p) => {
        p.roles = [];
      },
      /at least one role/i,
    ],
    [
      "no master role",
      (p) => {
        p.roles = [role("coder"), role("cleaner")];
      },
      /exactly one master/i,
    ],
    [
      "two master roles",
      (p) => {
        p.roles = [role("a", { isolation: "master" }), role("b", { isolation: "master" })];
      },
      /exactly one master/i,
    ],
    [
      "a master that is not first",
      (p) => {
        p.roles = [role("a"), role("b", { isolation: "master" })];
      },
      /first role/i,
    ],
    [
      "duplicate role ids",
      (p) => {
        p.roles = [role("a", { isolation: "master" }), role("a")];
      },
      /duplicate role/i,
    ],
    [
      "a role id with an underscore",
      (p) => {
        p.roles = [role("a_b", { isolation: "master" })];
      },
      /role/i,
    ],
    [
      "an invalid receive mode",
      (p) => {
        p.roles = [role("a", { isolation: "master", receive: "many" })];
      },
      /receive/i,
    ],
    [
      "an invalid propagation",
      (p) => {
        p.roles = [role("a", { isolation: "master", propagation: "sideways" })];
      },
      /propagation/i,
    ],
    [
      "an unknown role key",
      (p) => {
        p.roles = [role("a", { isolation: "master", color: "red" })];
      },
      /unknown key/i,
    ],
    [
      "approval for an unknown role",
      (p) => {
        p.approval = { after: "ghost" };
      },
      /approval/i,
    ],
    [
      "approval after the last role",
      (p) => {
        p.approval = { after: "cleaner" };
      },
      /approval/i,
    ],
    [
      "gates for an unknown role",
      (p) => {
        p.gates = { ghost: ["crap"] };
      },
      /unknown role/i,
    ],
    [
      "an unknown gate",
      (p) => {
        p.gates = { coder: ["magic"] };
      },
      /unknown gate/i,
    ],
    [
      "a negative threshold",
      (p) => {
        p.thresholds = { crap: -1 };
      },
      /threshold/i,
    ],
    [
      "a coverage threshold above 100",
      (p) => {
        p.thresholds = { coverage: 101 };
      },
      /threshold/i,
    ],
    [
      "a fractional maxBounces",
      (p) => {
        p.limits = { maxBounces: 1.5 };
      },
      /limit/i,
    ],
    [
      "parallel stages with unknown roles",
      (p) => {
        p.parallel = [["coder", "ghost"]];
      },
      /parallel/i,
    ],
    ["non-contiguous parallel stages", () => undefined, /parallel/i],
  ];
  for (const [label, mutate, message] of rejects) {
    if (label === "a non-object") {
      it("rejects a non-object", () => expect(() => parsePack("nope")).toThrow(message));
      continue;
    }
    if (label === "non-contiguous parallel stages") {
      it(`rejects ${label}`, () => {
        const pack = {
          ...valid(),
          roles: [role("a", { isolation: "master" }), role("b"), role("c"), role("d")],
          parallel: [["b", "d"]],
        };
        expect(() => parsePack(pack)).toThrow(message);
      });
      continue;
    }
    it(`rejects ${label}`, () => {
      const pack = valid() as Record<string, unknown>;
      mutate(pack);
      expect(() => parsePack(pack)).toThrow(message);
    });
  }

  it("accepts a contiguous parallel stage", () => {
    const pack = parsePack({
      ...valid(),
      roles: [role("a", { isolation: "master" }), role("b"), role("c"), role("d")],
      parallel: [["b", "c"]],
    });
    expect(pack.parallel).toEqual([["b", "c"]]);
  });
});

describe("parallel stage and rejection routing rules", () => {
  const roles = (extra: Record<string, Record<string, unknown>> = {}) => [
    role("a", { isolation: "master", ...extra.a }),
    role("b", extra.b),
    role("c", extra.c),
    role("d", extra.d),
  ];

  it("refuses a parallel stage that contains the last role", () => {
    expect(() => parsePack({ ...valid(), roles: roles(), parallel: [["c", "d"]] })).toThrow(
      /last role/i,
    );
  });

  it("refuses an approval gate inside a parallel stage", () => {
    expect(() =>
      parsePack({ ...valid(), roles: roles(), parallel: [["b", "c"]], approval: { after: "b" } }),
    ).toThrow(/parallel/i);
  });

  it("refuses a parallel stage that contains the master role", () => {
    expect(() => parsePack({ ...valid(), roles: roles(), parallel: [["a", "b"]] })).toThrow(
      /master/i,
    );
  });

  it("accepts rejectTo naming an earlier role and defaults to none", () => {
    const pack = parsePack({ ...valid(), roles: roles({ d: { rejectTo: "b" } }) });
    expect(pack.roles[3]?.rejectTo).toBe("b");
    expect(pack.roles[0]?.rejectTo).toBeUndefined();
  });

  it("refuses rejectTo naming a later or unknown role", () => {
    expect(() => parsePack({ ...valid(), roles: roles({ b: { rejectTo: "d" } }) })).toThrow(
      /rejectTo/i,
    );
    expect(() => parsePack({ ...valid(), roles: roles({ d: { rejectTo: "ghost" } }) })).toThrow(
      /rejectTo/i,
    );
  });
});
