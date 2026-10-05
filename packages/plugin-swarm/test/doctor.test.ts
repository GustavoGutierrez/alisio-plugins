import { describe, expect, it } from "vitest";
import { type DoctorDeps, formatDoctor, parseGitVersion, runDoctor } from "../src/doctor.js";
import { loadToolchain } from "../src/resources.js";

async function deps(overrides: Partial<DoctorDeps> = {}): Promise<DoctorDeps> {
  return {
    nodeVersion: "22.19.0",
    workspace: "/scratch/ws",
    toolchain: await loadToolchain("node-ts"),
    initialised: true,
    async exec(command) {
      return command === "git" ? "git version 2.34.1\n" : "10.0.0\n";
    },
    async writable() {
      return true;
    },
    ...overrides,
  };
}

describe("parseGitVersion", () => {
  it("parses common git version strings", () => {
    expect(parseGitVersion("git version 2.34.1")).toEqual([2, 34, 1]);
    expect(parseGitVersion("git version 2.45.0.windows.1")).toEqual([2, 45, 0]);
    expect(parseGitVersion("nonsense")).toBeUndefined();
  });
});

describe("runDoctor", () => {
  it("reports a healthy setup", async () => {
    const report = await runDoctor(await deps());
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => [i.id, i.status])).toEqual([
      ["node", "ok"],
      ["git", "ok"],
      ["workspace", "ok"],
      ["forge", "ok"],
      ["toolchain:npm", "ok"],
      ["toolchain:npx", "ok"],
    ]);
  });

  it("spawns tools with argv arrays, never a shell string", async () => {
    const calls: Array<[string, string[]]> = [];
    await runDoctor(
      await deps({
        async exec(command, args) {
          calls.push([command, args]);
          return "git version 2.34.1";
        },
      }),
    );
    expect(calls).toContainEqual(["git", ["--version"]]);
    expect(calls.every(([, args]) => Array.isArray(args))).toBe(true);
  });

  it("fails on an old Node, a missing or old git and an unwritable workspace", async () => {
    const report = await runDoctor(
      await deps({
        nodeVersion: "20.1.0",
        async exec(command) {
          if (command === "git") throw new Error("ENOENT");
          return "1.0.0";
        },
        async writable() {
          return false;
        },
      }),
    );
    expect(report.ok).toBe(false);
    const status = (id: string) => report.items.find((i) => i.id === id)?.status;
    expect(status("node")).toBe("missing");
    expect(status("git")).toBe("missing");
    expect(status("workspace")).toBe("missing");
    const old = await runDoctor(
      await deps({
        async exec() {
          return "git version 2.20.0";
        },
      }),
    );
    expect(old.items.find((i) => i.id === "git")?.status).toBe("missing");
    expect(old.items.find((i) => i.id === "git")?.detail).toMatch(/2\.28/);
  });

  it("only warns about toolchain commands and an uninitialised forge", async () => {
    const report = await runDoctor(
      await deps({
        initialised: false,
        async exec(command) {
          if (command === "git") return "git version 2.34.1";
          throw new Error("not found");
        },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.items.find((i) => i.id === "toolchain:npm")?.status).toBe("warn");
    expect(report.items.find((i) => i.id === "forge")?.status).toBe("warn");
  });

  it("formats one line per item", async () => {
    const text = formatDoctor(await runDoctor(await deps()));
    expect(text).toContain("[ok] node");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(6);
  });
});
