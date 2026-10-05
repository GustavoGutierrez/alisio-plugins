import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type { Toolchain } from "./toolchains/profile.js";

const execFileAsync = promisify(execFile);

export interface DoctorItem {
  id: string;
  label: string;
  status: "ok" | "warn" | "missing";
  detail: string;
}

export interface DoctorReport {
  items: DoctorItem[];
  /** False when something the swarm cannot run without is missing. */
  ok: boolean;
}

export interface DoctorDeps {
  nodeVersion: string;
  workspace: string;
  toolchain: Toolchain;
  initialised: boolean;
  exec(command: string, args: string[]): Promise<string>;
  writable(path: string): Promise<boolean>;
}

/** Minimum git: `git init --initial-branch` needs 2.28; worktrees and merge-base need less. */
const MIN_GIT: [number, number] = [2, 28];
const MIN_NODE: [number, number] = [22, 16];

export const defaultDoctorDeps = {
  async exec(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout: 5000 });
    return stdout;
  },
  async writable(path: string): Promise<boolean> {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function parseGitVersion(text: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

const atLeast = (version: number[], minimum: [number, number]): boolean =>
  (version[0] as number) > minimum[0] ||
  ((version[0] as number) === minimum[0] && (version[1] as number) >= minimum[1]);

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const items: DoctorItem[] = [];
  const node = deps.nodeVersion.split(".").map(Number);
  items.push({
    id: "node",
    label: "Node.js",
    status: atLeast(node, MIN_NODE) ? "ok" : "missing",
    detail: atLeast(node, MIN_NODE)
      ? deps.nodeVersion
      : `${deps.nodeVersion} found; Node ${MIN_NODE.join(".")} or newer is required`,
  });

  try {
    const version = parseGitVersion(await deps.exec("git", ["--version"]));
    if (!version) {
      items.push({
        id: "git",
        label: "git",
        status: "missing",
        detail: "could not read the git version",
      });
    } else if (!atLeast(version, MIN_GIT)) {
      items.push({
        id: "git",
        label: "git",
        status: "missing",
        detail: `${version.join(".")} found; git ${MIN_GIT.join(".")} or newer is required for worktrees and --initial-branch`,
      });
    } else {
      items.push({ id: "git", label: "git", status: "ok", detail: version.join(".") });
    }
  } catch {
    items.push({ id: "git", label: "git", status: "missing", detail: "git was not found on PATH" });
  }

  const writable = await deps.writable(deps.workspace);
  items.push({
    id: "workspace",
    label: "Workspace",
    status: writable ? "ok" : "missing",
    detail: writable ? "writable" : "the workspace directory is not writable",
  });

  items.push({
    id: "forge",
    label: "Forge",
    status: deps.initialised ? "ok" : "warn",
    detail: deps.initialised ? "initialised" : "not initialised; run /swarm:init",
  });

  const commands = [
    ...new Set(Object.values(deps.toolchain.commands).map((command) => command?.argv[0] as string)),
  ];
  for (const command of commands) {
    try {
      await deps.exec(command, ["--version"]);
      items.push({
        id: `toolchain:${command}`,
        label: `${deps.toolchain.id}: ${command}`,
        status: "ok",
        detail: "found",
      });
    } catch {
      items.push({
        id: `toolchain:${command}`,
        label: `${deps.toolchain.id}: ${command}`,
        status: "warn",
        detail: "not found; gates that use it cannot run",
      });
    }
  }
  return { items, ok: items.every((item) => item.status !== "missing") };
}

export function formatDoctor(report: DoctorReport): string {
  return [
    report.ok ? "Swarm doctor: ready" : "Swarm doctor: problems found",
    ...report.items.map((item) => `[${item.status}] ${item.label}: ${item.detail}`),
  ].join("\n");
}
