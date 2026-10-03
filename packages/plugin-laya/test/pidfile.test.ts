import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPidfile, readLinuxCommandLine } from "../src/runtime/pidfile.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-pid-"));
  file = join(dir, "server.pid");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function make(over: Partial<Parameters<typeof createPidfile>[1]> = {}) {
  const kill = vi.fn();
  const alive = new Set<number>();
  const pidfile = createPidfile(file, {
    venvRoot: "/rt/venv",
    isAlive: (pid) => alive.has(pid),
    readCommandLine: async () => "/rt/venv/bin/python /rt/venv/bin/laya-serve",
    kill: (pid, signal) => {
      kill(pid, signal);
      if (signal === "SIGKILL" || signal === "SIGTERM") alive.delete(pid);
    },
    sleep: async () => {},
    ...over,
  });
  return { pidfile, kill, alive };
}

describe("pidfile", () => {
  it("writes {pid, startedAt, venv} with mode 0600 and removes it", async () => {
    const { pidfile } = make();
    await pidfile.write({ pid: 4321, startedAt: 1000 });
    const body = JSON.parse(await readFile(file, "utf8"));
    expect(body).toEqual({ pid: 4321, startedAt: 1000, venv: "/rt/venv" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await pidfile.remove();
    await expect(stat(file)).rejects.toThrow();
    await pidfile.remove();
  });

  it("does nothing when there is no pidfile", async () => {
    const { pidfile, kill } = make();
    expect(await pidfile.reapOrphan()).toBe("none");
    expect(kill).not.toHaveBeenCalled();
  });

  it("terminates a live orphan whose command line points into our venv", async () => {
    const { pidfile, kill, alive } = make();
    alive.add(777);
    await writeFile(file, JSON.stringify({ pid: 777, startedAt: 1, venv: "/rt/venv" }));
    expect(await pidfile.reapOrphan()).toBe("killed");
    expect(kill).toHaveBeenCalledWith(777, "SIGTERM");
    await expect(stat(file)).rejects.toThrow();
  });

  it("escalates to SIGKILL when the orphan ignores SIGTERM", async () => {
    const kill = vi.fn();
    const { pidfile } = make({
      isAlive: () => true,
      kill: (pid, signal) => kill(pid, signal),
    });
    await writeFile(file, JSON.stringify({ pid: 778, startedAt: 1, venv: "/rt/venv" }));
    await pidfile.reapOrphan();
    expect(kill.mock.calls.map((c) => c[1])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("never touches a live pid whose command line does not match", async () => {
    const { pidfile, kill, alive } = make({
      readCommandLine: async () => "/usr/bin/vim notes.txt",
    });
    alive.add(888);
    await writeFile(file, JSON.stringify({ pid: 888, startedAt: 1, venv: "/rt/venv" }));
    expect(await pidfile.reapOrphan()).toBe("foreign");
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(file)).rejects.toThrow();
  });

  it("never touches a pid when the command line cannot be read", async () => {
    const { pidfile, kill, alive } = make({ readCommandLine: async () => null });
    alive.add(889);
    await writeFile(file, JSON.stringify({ pid: 889, startedAt: 1, venv: "/rt/venv" }));
    expect(await pidfile.reapOrphan()).toBe("foreign");
    expect(kill).not.toHaveBeenCalled();
  });

  it("removes a stale pidfile for a dead pid without killing anything", async () => {
    const { pidfile, kill } = make();
    await writeFile(file, JSON.stringify({ pid: 999, startedAt: 1, venv: "/rt/venv" }));
    expect(await pidfile.reapOrphan()).toBe("stale");
    expect(kill).not.toHaveBeenCalled();
    await expect(stat(file)).rejects.toThrow();
  });

  it("ignores a pidfile written for another venv", async () => {
    const { pidfile, kill, alive } = make();
    alive.add(555);
    await writeFile(file, JSON.stringify({ pid: 555, startedAt: 1, venv: "/other/venv" }));
    expect(await pidfile.reapOrphan()).toBe("foreign");
    expect(kill).not.toHaveBeenCalled();
  });

  it("treats malformed content as stale and never kills", async () => {
    const { pidfile, kill } = make();
    for (const body of [
      "{nope",
      JSON.stringify({ pid: "x" }),
      JSON.stringify({ pid: -5, startedAt: 1, venv: "/rt/venv" }),
      JSON.stringify({ pid: 0, startedAt: 1, venv: "/rt/venv" }),
    ]) {
      await writeFile(file, body);
      expect(await pidfile.reapOrphan()).toBe("stale");
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("reads the Linux command line from /proc for the current process", async () => {
    if (process.platform !== "linux") return;
    const cmdline = await readLinuxCommandLine(process.pid);
    expect(cmdline).toContain("node");
    expect(await readLinuxCommandLine(2 ** 22 + 12345)).toBeNull();
  });
});
