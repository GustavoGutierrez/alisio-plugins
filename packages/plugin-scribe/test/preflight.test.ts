import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePdf } from "../src/compiler.js";
import {
  type BundleManifest,
  describeReport,
  loadManifest,
  packageAllowlist,
  parseManifest,
  parseTex,
  preflight,
  writerEngineNote,
} from "../src/preflight.js";
import { Service } from "../src/service.js";
import type { Job } from "../src/types.js";
import { finish, fixture } from "./helpers.js";

const manifest = (files: string[]): BundleManifest => ({ texlive: "2021", files: new Set(files) });
const base = manifest([
  "article.cls",
  "amsmath.sty",
  "amssymb.sty",
  "graphicx.sty",
  "babel.sty",
  "english.ldf",
  "babel-es.ini",
  "babel-spanish.tex",
  "babel-fr.ini",
]);
const doc = (preamble: string) =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}x\\end{document}\n`;

describe("parseTex", () => {
  it("reads classes, packages and options, ignoring comments", () => {
    const { uses } = parseTex(
      [
        "\\documentclass[11pt, a4paper]{article}",
        "\\usepackage[utf8]{inputenc} % \\usepackage{commented}",
        "% \\usepackage{siunitx}",
        "\\usepackage{amsmath, amssymb,",
        "  graphicx}",
        "\\RequirePackage[final]{hyperref}",
        "100\\% \\usepackage{after-escaped-percent}",
        "\\usepackage{\\mymacro}",
      ].join("\n"),
    );
    expect(uses).toEqual([
      { kind: "class", name: "article", options: ["11pt", "a4paper"] },
      { kind: "package", name: "inputenc", options: ["utf8"] },
      { kind: "package", name: "amsmath", options: [] },
      { kind: "package", name: "amssymb", options: [] },
      { kind: "package", name: "graphicx", options: [] },
      { kind: "package", name: "hyperref", options: ["final"] },
      { kind: "package", name: "after-escaped-percent", options: [] },
    ]);
  });

  it("reads \\babelprovide languages", () => {
    expect(parseTex("\\babelprovide[import,main]{spanish}").babelProvided).toEqual(["spanish"]);
  });
});

describe("preflight", () => {
  it("passes a document whose packages are all bundled", () => {
    expect(preflight(doc("\\usepackage{amsmath,amssymb,graphicx}"), base)).toBeNull();
  });

  it("lists missing packages and classes by name only", () => {
    const tex =
      "\\documentclass{revtex4}\n\\usepackage{siunitx}\n\\usepackage[backend=biber]{biblatex}\n% \\usepackage{algorithm2e}\n\\usepackage{amsmath}";
    const report = preflight(tex, base);
    expect(report).toEqual({
      packages: ["biblatex", "revtex4", "siunitx"],
      languages: [],
      provide: [],
    });
    if (!report) throw new Error("expected a report");
    const detail = describeReport(report);
    expect(detail).toContain("biblatex, revtex4, siunitx");
    expect(detail).not.toContain("documentclass");
  });

  it("accepts babel languages with an .ldf file", () => {
    expect(preflight(doc("\\usepackage[english]{babel}"), base)).toBeNull();
  });

  it("hints provide=* for languages that only exist as an .ini locale", () => {
    const report = preflight(doc("\\usepackage[spanish]{babel}"), base);
    expect(report).toEqual({ packages: [], languages: [], provide: ["spanish"] });
    if (!report) throw new Error("expected a report");
    expect(describeReport(report)).toContain("\\usepackage[spanish,provide=*]{babel}");
  });

  it("accepts .ini languages with provide=* or \\babelprovide", () => {
    expect(preflight(doc("\\usepackage[spanish,provide=*]{babel}"), base)).toBeNull();
    expect(preflight(doc("\\usepackage[provide*=*,main=french,spanish]{babel}"), base)).toBeNull();
    expect(
      preflight(doc("\\usepackage{babel}\n\\babelprovide[import,main]{spanish}"), base),
    ).toBeNull();
    // `french` resolves through the alias table when no babel-french.tex is listed.
    expect(preflight(doc("\\usepackage[french,provide=*]{babel}"), base)).toBeNull();
  });

  it("reports languages with neither .ldf nor .ini, ignoring babel flags", () => {
    expect(
      preflight(doc("\\usepackage[shorthands=off,activeacute,klingon,provide=*]{babel}"), base),
    ).toEqual({ packages: [], languages: ["klingon"], provide: [] });
    expect(preflight(doc("\\usepackage{babel}\\babelprovide{klingon}"), base)?.languages).toEqual([
      "klingon",
    ]);
  });

  it("checks language options passed through the document class", () => {
    expect(
      preflight("\\documentclass[spanish]{article}\\usepackage{babel}\\begin{document}", base)
        ?.provide,
    ).toEqual(["spanish"]);
  });
});

describe("manifest", () => {
  it("treats a missing or malformed manifest as absent", () => {
    expect(loadManifest(join(tmpdir(), "scribe-no-such-manifest.json"))).toBeNull();
    expect(parseManifest({ files: [1] })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ files: ["a.sty"] })?.files.has("a.sty")).toBe(true);
  });

  it("ships a manifest that lists the baseline packages", async () => {
    const shipped = loadManifest();
    expect(shipped).not.toBeNull();
    for (const file of ["article.cls", "amsmath.sty", "graphicx.sty", "babel.sty"])
      expect(shipped?.files.has(file)).toBe(true);
    const raw = JSON.parse(
      await readFile(new URL("../compiler/bundle-manifest.json", import.meta.url), "utf8"),
    ) as { files: string[] };
    expect(raw.files).toEqual([...raw.files].sort());
  });

  it("derives the writer allowlist from the manifest, with a static fallback", () => {
    expect(packageAllowlist(base)).toEqual(["amsmath", "amssymb", "graphicx", "babel"]);
    expect(packageAllowlist(null)).toContain("amsmath");
    expect(packageAllowlist(null)).not.toContain("siunitx");
    expect(writerEngineNote(base)).toContain("amsmath, amssymb, graphicx, babel");
  });
});

describe("compile preflight", () => {
  it("fails fast with latex_package_missing before starting the engine", async () => {
    const document = {
      assets: [],
      revisions: [{ id: "r", tex: doc("\\usepackage{siunitx}"), bib: "", summary: "", at: "" }],
    };
    await expect(
      compilePdf(document, tmpdir(), new AbortController().signal, base),
    ).rejects.toMatchObject({
      code: "latex_package_missing",
      message: expect.stringContaining("siunitx"),
    });
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("service preflight", () => {
  async function service(manifestValue: BundleManifest | null) {
    const f = await fixture("en");
    cleanups.push(f.cleanup);
    const s = new Service(f.service.api, f.store, "session", { manifest: manifestValue });
    cleanups.push(async () => s.dispose());
    return { ...f, s };
  }

  it("fails a compile job with the missing package list", async () => {
    const { s, store } = await service(base);
    const d = (await s.invoke("documents.create", {
      title: "Units",
      tex: doc("\\usepackage{siunitx}"),
    })) as { id: string };
    const job = await finish(store, (await s.invoke("pdf.compile", { documentId: d.id })) as Job);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("latex_package_missing");
    expect(job.message).toContain("siunitx");
    expect(job.message).not.toContain("\\begin{document}");
  });

  it("attaches the preflight report to a generated draft and tells the writer the allowlist", async () => {
    const { s, store, api } = await service(base);
    let instructions = "";
    api.sessions.create = (async (options: { instructions: string }) => {
      instructions = options.instructions;
      return { id: "child" };
    }) as unknown as typeof api.sessions.create;
    api.sessions.run = async () => ({
      status: "completed",
      text: JSON.stringify({
        tex: doc("\\usepackage[spanish]{babel}\\usepackage{siunitx}"),
        bib: "",
        summary: "s",
      }),
      usage: { input: 1, output: 1 },
    });
    const d = (await s.invoke("documents.create", { title: "Draft", brief: "b" })) as {
      id: string;
    };
    const job = await finish(
      store,
      (await s.invoke("draft.generate", { documentId: d.id })) as Job,
    );
    expect(job.status).toBe("succeeded");
    expect((await store.get(d.id)).proposals[0]?.preflight).toEqual({
      packages: ["siunitx"],
      languages: [],
      provide: ["spanish"],
    });
    expect(instructions).toContain("provide=*");
    expect(instructions).toContain("amsmath, amssymb, graphicx, babel");
  });

  it("skips preflight when there is no manifest", async () => {
    const { s, store, api } = await service(null);
    api.sessions.run = async () => ({
      status: "completed",
      text: JSON.stringify({ tex: doc("\\usepackage{siunitx}"), bib: "", summary: "s" }),
      usage: { input: 1, output: 1 },
    });
    const d = (await s.invoke("documents.create", { title: "Draft", brief: "b" })) as {
      id: string;
    };
    await finish(store, (await s.invoke("draft.generate", { documentId: d.id })) as Job);
    expect((await store.get(d.id)).proposals[0]?.preflight).toBeUndefined();
  });
});

describe("writer guidance", () => {
  it("tells the agent and the skill to load babel with provide=* and skip legacy font setup", async () => {
    for (const file of [
      "../.agents/agents/scr-writer.md",
      "../.agents/skills/scr-latex/SKILL.md",
    ]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      expect(text).toContain("\\usepackage[spanish,provide=*]{babel}");
      expect(text).toMatch(/fontenc/);
      expect(text).toMatch(/lmodern/);
    }
  });
});
