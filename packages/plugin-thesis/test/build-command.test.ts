import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import type { Renderer } from "../src/render/port.js";
import { RendererRegistry } from "../src/render/registry.js";
import { defaultState, writeState } from "../src/storage.js";
import { cleanup, intakeAnswers, lifecycle, round1, round2, round3 } from "./helpers/harness.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(async () => {
  await cleanup();
  await cleanSamples();
});

/** A stand-in PDF adapter: proves the command, tool and state wiring without an engine. */
function fakePdf(ok = true): Renderer & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id: "fake-pdf",
    format: "pdf",
    calls,
    capabilities: () => ({
      math: "native",
      mermaid: "native",
      footnotes: "native",
      toc: "native",
      crossrefs: "native",
      bibliography: "native",
      pdfa: true,
      extension: "pdf",
    }),
    available: async () => ({ available: true, engine: "fake", source: "test" }),
    async render(_doc, options, context) {
      calls.push(options);
      await writeFile(join(context.buildDir, "thesis.pdf"), "%PDF");
      return {
        ok,
        engine: "fake",
        output: "thesis.pdf",
        pages: 7,
        ms: 1,
        findings: ok ? [] : [{ code: "BLD-001", gate: "G8", severity: "error", message: "boom" }],
        unrepresented: [],
      };
    },
  };
}

async function workspaceWithSample(h: Awaited<ReturnType<typeof lifecycle>>) {
  const sample = await sampleThesis();
  await cp(sample, join(h.workspace, "thesis"), { recursive: true });
  const state = defaultState("thesis");
  state.phase = "sections";
  state.sections = { "SEC-01": { status: "approved" } };
  await writeState(h.workspace, state);
}

describe("/thesis:build and thesis_build", () => {
  it("is blocked until the interview is done", async () => {
    const h = await lifecycle();
    await h.run("init", "--lang es-CO").catch(() => undefined);
    const reply = await h.run("build");
    expect(reply).toMatch(/^Blocked:/);
  });

  it("builds through the registered renderer, records lastBuild and honors scope and --pdfa", async () => {
    const renderer = fakePdf();
    const h = await lifecycle({
      coordinator: { registry: new RendererRegistry().register(renderer) },
    });
    await workspaceWithSample(h);
    const reply = await h.run("build", "approved --pdfa");
    expect(reply).toMatch(/^Build OK \(approved\): .*thesis\.pdf/);
    expect(reply).toContain("7 page(s)");
    expect(renderer.calls[0]).toEqual({ scope: "approved", pdfa: true });
    const state = await h.state();
    expect(state.lastBuild).toMatchObject({ engine: "typst-cli", pdf: "thesis/build/thesis.pdf" });
    const report = JSON.parse(await h.read("build/build-report.json"));
    expect(report).toMatchObject({ ok: true, scope: "approved", pages: 7 });
    await h.run("build", "SEC-02");
    expect(renderer.calls[1]).toEqual({ scope: "section", section: "SEC-02" });
  });

  it("reports failures with error codes and does not record lastBuild", async () => {
    const h = await lifecycle({
      coordinator: { registry: new RendererRegistry().register(fakePdf(false)) },
    });
    await workspaceWithSample(h);
    const reply = await h.run("build");
    expect(reply).toMatch(/^Build failed \(full\): 1 error/);
    expect(reply).toContain("ERROR BLD-001 boom");
    expect((await h.state()).lastBuild).toBeUndefined();
  });

  it("validates arguments and explains an unavailable format or engine", async () => {
    const h = await lifecycle({
      coordinator: {
        env: { ALISIO_THESIS_TYPST: "/nonexistent/typst", ALISIO_THESIS_CHROME: "off" },
      },
    });
    await workspaceWithSample(h);
    await expect(h.run("build", "everything")).rejects.toThrow(/Usage: \/thesis:build/);
    expect(await h.run("build", "--html")).not.toMatch(/Build failed/);
    const reply = await h.run("build");
    expect(reply).toMatch(/Build failed/);
    expect(reply).toMatch(/ALISIO_THESIS_TYPST: the Typst binary could not be run/);
    expect(reply).toMatch(/\/thesis:setup/);
  });

  it("the tool returns JSON with path, engine, ms, pages and warnings", async () => {
    const h = await lifecycle({
      coordinator: { registry: new RendererRegistry().register(fakePdf()) },
    });
    await workspaceWithSample(h);
    const tool = h.tools.get("thesis_build");
    expect(tool?.effect).toBe("process");
    const result = await tool?.execute({ scope: "full" }, {
      workspace: h.workspace,
      signal: new AbortController().signal,
    } as never);
    const payload = JSON.parse(((result?.content[0] ?? { text: "" }) as { text: string }).text);
    expect(payload).toMatchObject({ ok: true, engine: "fake", pages: 7, errors: [] });
    expect(payload.path).toMatch(/thesis\.pdf$/);
    const bad = await tool?.execute({ scope: "nope" }, { workspace: h.workspace } as never);
    expect(bad?.isError).toBe(true);
  });

  it("setup explains an unsupported platform instead of downloading", async () => {
    const h = await lifecycle({ coordinator: { setupDeps: { platform: "freebsd", arch: "x64" } } });
    expect(await h.run("setup")).toMatch(
      /Setup failed: No pinned Typst build exists for freebsd-x64/,
    );
    await expect(h.run("setup", "extra")).rejects.toThrow(/Usage/);
  });
});

describe("doctor shows the engine resolution", () => {
  it("reports the setup cache when Typst is only installed there", async () => {
    const report = await runDoctor({
      env: {},
      cacheRoot: "/cache",
      exec: async (command) => {
        if (command === "typst") throw new Error("not on PATH");
        return "typst 0.15.1";
      },
      exists: (path) => path.startsWith("/cache"),
    });
    const item = report.items.find((entry) => entry.id === "typst");
    expect(item).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("the setup cache"),
    });
  });
});

describe("ICONTEC interview round", () => {
  it("asks the disputed font and spacing only for ICONTEC and records them in the brief", async () => {
    const h = await lifecycle({
      answers: [round1, { ...round2, citationStyle: "icontec-ntc1486-2022" }, round3],
    });
    await h.run("init", "--lang es-CO");
    h.setInteractive(false);
    const pending = await h.run("init", "--presentation");
    expect(pending).toContain("round 4");
    expect(pending).not.toContain("icontecFont");
    const second = await h.run(
      "answer",
      "paper=letter palette=okabe-ito fontProfile=serif aiDeclaration=auto",
    );
    expect(second).toContain("ICONTEC presentation");
    expect(second).toContain("icontecFont");
    expect(second).toContain("icontecSpacing");
    // The 2022 guides disagree, so neither question carries a recommended option.
    expect(second).not.toContain("recommended");
    const done = await h.run(
      "answer",
      "icontecFont=other icontecFont:text=Calibri icontecSpacing=1.5",
    );
    expect(done).toContain("Interview complete");
    const brief = await h.read("thesis.yaml");
    expect(brief).toContain("bodyFont: Calibri");
    expect(brief).toContain("lineSpacing: 1.5");
    const bad = await h.run("init", "--presentation");
    expect(bad).not.toContain("icontecFont");
  });

  it("does not ask them for other styles", async () => {
    const h = await lifecycle({ answers: intakeAnswers });
    await h.run("init", "--lang es-CO");
    h.setInteractive(false);
    const pending = await h.run("init", "--presentation");
    expect(pending).not.toContain("icontecFont");
    const done = await h.run(
      "answer",
      "paper=letter palette=okabe-ito fontProfile=serif aiDeclaration=auto",
    );
    expect(done).not.toContain("ICONTEC");
  });
});

describe("CLI build and bib", () => {
  const run = async (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
    let out = "";
    let err = "";
    const code = await main(args, {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      cwd,
      env,
    });
    return { code, out, err };
  };

  it("bib regenerates and checks references.bib deterministically", async () => {
    const root = await sampleThesis();
    const path = join(root, "bibliography", "references.bib");
    const original = await readFile(path, "utf8");
    expect((await run(["bib", root, "--check"], "/")).code).toBe(0);
    await writeFile(path, "stale\n");
    const stale = await run(["bib", root, "--check"], "/");
    expect(stale).toMatchObject({ code: 1, out: expect.stringContaining("CIT-004") });
    const written = await run(["bib", root], "/");
    expect(written.out).toContain("Wrote bibliography/references.bib (6 record(s))");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await run(["bib", root], "/")).out).toContain("already up to date");
  });

  it("build exits 1 with an actionable message when no engine exists, and 2 on bad usage", async () => {
    const root = await sampleThesis();
    const failed = await run(["build", root], "/", {
      ALISIO_THESIS_TYPST: "/nonexistent/typst",
      ALISIO_THESIS_CHROME: "off",
      ALISIO_CACHE_HOME: join(root, "cache"),
    });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("Build failed (full)");
    expect((await run(["build", root, "--bogus"], "/")).code).toBe(2);
    const json = await run(["build", root, "SEC-02", "--json"], "/", {
      ALISIO_THESIS_TYPST: "/nonexistent/typst",
      ALISIO_THESIS_CHROME: "off",
    });
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, scope: "section" });
  });
});
