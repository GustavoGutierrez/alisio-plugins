/** Offline interpreter discovery. Runs only a constant `-c` probe; installs nothing. */
import { MANIFEST } from "./manifest.js";
import type { Runner } from "./runner.js";

export const PYTHON_PROBE = [
  "import sys, struct",
  "ok = 'ok'",
  "try:",
  "    import venv, ensurepip",
  "except Exception:",
  "    ok = 'novenv'",
  "print(sys.version_info[0], sys.version_info[1], sys.version_info[2], struct.calcsize('P') * 8, ok)",
].join("\n");

export type PythonResult =
  | { ok: true; command: string; args: string[]; version: string }
  | { ok: false; reason: string };

export interface DiscoverInput {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  runner: Runner;
}

interface Candidate {
  command: string;
  args: string[];
}

function candidates(input: DiscoverInput): Candidate[] {
  if (input.env.ALISIO_LAYA_PYTHON) return [{ command: input.env.ALISIO_LAYA_PYTHON, args: [] }];
  if (input.platform === "win32") {
    return [
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
    ];
  }
  return ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"].map(
    (command) => ({
      command,
      args: [],
    }),
  );
}

type Verdict = { ok: true; version: string } | { ok: false; rank: number; reason: string };

async function check(candidate: Candidate, runner: Runner): Promise<Verdict> {
  const result = await runner.run(candidate.command, [...candidate.args, "-c", PYTHON_PROBE], {
    maxOutput: 4096,
  });
  const match = /^(\d+) (\d+) (\d+) (\d+) (ok|novenv)\s*$/m.exec(result.stdout);
  if (!match) return { ok: false, rank: 0, reason: "Python was not found" };
  const [, major, minor, patch, bits, venv] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const version = `${major}.${minor}.${patch}`;
  const { minMajor, minMinor } = MANIFEST.python;
  if (Number(major) < minMajor || (Number(major) === minMajor && Number(minor) < minMinor)) {
    return {
      ok: false,
      rank: 1,
      reason: `Python ${version} found; ${minMajor}.${minMinor} or newer is required`,
    };
  }
  if (Number(bits) !== 64) {
    return {
      ok: false,
      rank: 2,
      reason: `Python ${version} is not 64-bit; a 64-bit interpreter is required`,
    };
  }
  if (venv !== "ok") {
    return {
      ok: false,
      rank: 3,
      reason: `Python ${version} cannot create virtual environments; install the venv module (on Debian or Ubuntu: apt install python3-venv)`,
    };
  }
  return { ok: true, version };
}

/** First interpreter that is >= 3.10, 64-bit and can create a venv; else the best diagnostic. */
export async function discoverPython(input: DiscoverInput): Promise<PythonResult> {
  let best: Extract<Verdict, { ok: false }> | null = null;
  for (const candidate of candidates(input)) {
    const verdict = await check(candidate, input.runner);
    if (verdict.ok) {
      return {
        ok: true,
        command: candidate.command,
        args: candidate.args,
        version: verdict.version,
      };
    }
    if (!best || verdict.rank > best.rank) best = verdict;
  }
  const reason = best?.reason ?? "Python was not found";
  return {
    ok: false,
    reason:
      reason === "Python was not found"
        ? `Python was not found. Install Python ${MANIFEST.python.minMajor}.${MANIFEST.python.minMinor} or newer, or set ALISIO_LAYA_PYTHON to an interpreter`
        : reason,
  };
}
