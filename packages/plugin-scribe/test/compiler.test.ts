import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryPath } from "node-tectonic";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePdf, tectonicEnv } from "../src/compiler.js";
import type { ScribeError } from "../src/types.js";

describe("tectonicEnv", () => {
  it("forwards only allowlisted variables and forces untrusted mode", () => {
    const env = tectonicEnv({
      PATH: "/bin",
      HOME: "/var/lib/scribe-test",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_CACHE_HOME: "/cache",
      Path: "C:\\Windows",
      OPENAI_API_KEY: "secret",
      ALISIO_TOKEN: "secret",
      NODE_OPTIONS: "--require x",
      TECTONIC_UNTRUSTED_MODE: "0",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/var/lib/scribe-test",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_CACHE_HOME: "/cache",
      Path: "C:\\Windows",
      TECTONIC_UNTRUSTED_MODE: "1",
    });
  });
});

describe("compilePdf", () => {
  it("rejects a document without revisions", async () => {
    await expect(
      compilePdf({ assets: [], revisions: [] }, tmpdir(), new AbortController().signal),
    ).rejects.toThrow(/invalid_input/);
  });
});

// The engine binary may be missing for this platform or unable to run (e.g. an older glibc).
function engineRuns(): boolean {
  try {
    return (
      spawnSync(binaryPath(), ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0
    );
  } catch {
    return false;
  }
}
const available = engineRuns();

// Real engine and bundled TeX archive: slow on the first run because Tectonic builds its format.
describe.skipIf(!available)("compilePdf with the bundled engine", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "scribe-offline-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces a real PDF with mathematics and BibTeX offline, atomically", async () => {
    const tex = String.raw`\documentclass{article}\usepackage{amsmath,amssymb,graphicx}\begin{document}Mathematics: $E=mc^2$.\[\int_0^1 x^2 dx=\frac13,\quad A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\]Reference~\cite{knuth}.\bibliographystyle{plain}\bibliography{references}\end{document}`;
    const bib =
      "@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison Wesley}}";
    const d = { assets: [], revisions: [{ id: "r", tex, bib, summary: "", at: "" }] };
    const result = await compilePdf(d, root, new AbortController().signal);
    const bytes = await readFile(join(root, result.filename));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(5000);
    expect(await readdir(root)).toEqual([result.filename]);

    const controller = new AbortController();
    controller.abort();
    await expect(compilePdf(d, root, controller.signal)).rejects.toThrow();

    const broken = {
      assets: [],
      revisions: [
        {
          id: "r",
          tex: "\\documentclass{article}\\begin{document}\\undefinedScribeCommand\\end{document}",
          bib: "",
          summary: "",
          at: "",
        },
      ],
    };
    await expect(compilePdf(broken, root, new AbortController().signal)).rejects.toSatisfy(
      (e: ScribeError) => e.code === "compile_failed",
    );
  }, 300_000);
});
