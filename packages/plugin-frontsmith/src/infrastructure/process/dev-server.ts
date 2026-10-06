import { spawn } from "node:child_process";
import type { DevServer, ServerOutcome } from "../../application/ports/dev-server.js";
import { scrubbedEnv } from "./process-exec.js";

const POLL_MS = 250;

/** Starts the configured `fidelity.serve` command and waits until its ready URL answers (spec 2.2). */
export class NodeDevServer implements DevServer {
  async start(input: {
    root: string;
    argv: readonly string[];
    readyUrl: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ServerOutcome> {
    const [command, ...args] = input.argv;
    if (!command) return { ok: false, reason: "the serve command is empty" };
    const child = spawn(command, args, {
      cwd: input.root,
      env: scrubbedEnv(),
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let exited = false;
    let spawnError: string | undefined;
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      exited = true;
      spawnError = (error as NodeJS.ErrnoException).code ?? error.message;
    });
    const stop = async (): Promise<void> => {
      if (child.pid === undefined || exited) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) {
        await stop();
        return { ok: false, reason: "cancelled" };
      }
      if (exited)
        return {
          ok: false,
          reason: spawnError
            ? `could not start the serve command (${spawnError})`
            : "the serve command exited before it was ready",
        };
      try {
        const response = await fetch(input.readyUrl, { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.status < 500) return { ok: true, server: { stop } };
      } catch {
        // Not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    await stop();
    return { ok: false, reason: `${input.readyUrl} did not answer within ${input.timeoutMs} ms` };
  }
}
