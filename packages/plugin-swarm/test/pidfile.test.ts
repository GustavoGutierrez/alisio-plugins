import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimPidfile, isAlive, releasePidfile } from "../src/app/pidfile.js";
import { tempDir } from "./helpers.js";

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid as number;
}

describe("pidfile", () => {
  it("writes our pid and removes it on release", async () => {
    const dir = await tempDir();
    const file = join(dir, "swarm.pid");
    expect(await claimPidfile(file)).toEqual({});
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    await releasePidfile(file);
    expect(existsSync(file)).toBe(false);
    await releasePidfile(file);
  });

  it("reaps a stale pidfile left by a dead process and says so", async () => {
    const dir = await tempDir();
    const file = join(dir, "swarm.pid");
    const dead = deadPid();
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, pid: dead, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(await claimPidfile(file)).toEqual({ stale: dead });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
  });

  it("reports another live process without taking over", async () => {
    const dir = await tempDir();
    const file = join(dir, "swarm.pid");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.ppid,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(await claimPidfile(file)).toEqual({ other: process.ppid });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.ppid);
    await releasePidfile(file);
    expect(existsSync(file)).toBe(true);
  });

  it("treats a corrupt pidfile as stale", async () => {
    const dir = await tempDir();
    const file = join(dir, "swarm.pid");
    await writeFile(file, "{nope");
    expect(await claimPidfile(file)).toEqual({ corrupt: true });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
  });

  it("detects live and dead pids", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(deadPid())).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });
});
