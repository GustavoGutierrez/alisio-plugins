import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagePath } from "../../../package-paths.js";
import { atomicWrite } from "../../../storage.js";
import type { Finding } from "../../../types.js";
import type { ThesisDocument } from "../../model.js";
import type {
  Availability,
  RenderContext,
  RenderEnvironment,
  Renderer,
  RendererCapabilities,
  RenderOptions,
  RenderResult,
} from "../../port.js";
import { emitTypst } from "./emitter.js";
import { typstProfile } from "./profile.js";
import { parseDiagnostics, pdfPageCount, resolveTypst, runTypst } from "./runner.js";

export { emitTypst } from "./emitter.js";
export { escapeText, typstString } from "./escape.js";
export { compileArgs, parseDiagnostics, pdfPageCount, resolveTypst, typstEnv } from "./runner.js";
export { setupTypst } from "./setup.js";

async function listFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Output file name for a scope, inside the build directory. */
export function outputName(options: RenderOptions): string {
  if (options.scope === "approved") return "thesis-approved.pdf";
  if (options.scope === "section") {
    const id = (options.section ?? "section").replace(/[^A-Za-z0-9.-]/g, "");
    return `thesis-${id || "section"}.pdf`;
  }
  return "thesis.pdf";
}

export const typstPdfRenderer: Renderer = {
  id: "typst-pdf",
  format: "pdf",

  capabilities(): RendererCapabilities {
    return {
      math: "converted",
      mermaid: "converted",
      footnotes: "native",
      toc: "native",
      crossrefs: "native",
      bibliography: "native",
      pdfa: true,
      extension: "pdf",
    };
  },

  available(env: RenderEnvironment): Promise<Availability> {
    return resolveTypst(env.env, env.cacheRoot);
  },

  async render(
    doc: ThesisDocument,
    options: RenderOptions,
    context: RenderContext,
  ): Promise<RenderResult> {
    const started = Date.now();
    const fail = (findings: Finding[], engine = "typst-pdf"): RenderResult => ({
      ok: false,
      engine,
      ms: Date.now() - started,
      findings,
      unrepresented: [],
    });

    const emitted = emitTypst(doc);
    if (emitted.findings.some((finding) => finding.severity === "error")) {
      return fail(emitted.findings);
    }
    const engine = await resolveTypst(context.env, context.cacheRoot);
    if (!engine.available) {
      return fail([
        {
          code: "BLD-001",
          gate: "G8",
          severity: "error",
          message: engine.reason,
          ...(engine.hint ? { hint: engine.hint } : {}),
        },
      ]);
    }

    const notes: Finding[] = [];
    const meta = doc.meta;

    const dir = context.buildDir;
    await mkdir(join(dir, "_tpl"), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, "styles"), { recursive: true, mode: 0o700 });
    const template = await readFile(packagePath("templates", "typst", "thesis.typ"), "utf8");
    await atomicWrite(join(dir, "main.typ"), emitted.main);
    await atomicWrite(join(dir, "meta.json"), `${JSON.stringify(emitted.meta)}\n`);
    await atomicWrite(join(dir, "strings.json"), `${JSON.stringify(emitted.strings)}\n`);
    await atomicWrite(join(dir, "references.bib"), doc.bibliography.bibtex);
    await atomicWrite(join(dir, "styles", doc.bibliography.csl.file), doc.bibliography.csl.text);
    await atomicWrite(join(dir, "_tpl", "thesis.typ"), template);
    await atomicWrite(join(dir, "_tpl", "profile.typ"), typstProfile(doc.presentation));

    const fontsDir = join(context.root, "fonts");
    const fonts = await listFiles(fontsDir);
    const output = outputName(options);
    const packageCache = await mkdtemp(join(tmpdir(), "alisio-thesis-pkgs-"));
    context.progress?.("typst: compiling");
    try {
      const outcome = await runTypst({
        binary: engine.path as string,
        buildDir: dir,
        packageCache,
        packagePath: packagePath("typst-packages"),
        input: "main.typ",
        output,
        ...(fonts.length > 0 ? { fontPaths: [fontsDir] } : {}),
        ...(meta.fontProfile === "institutional" && fonts.length > 0
          ? { ignoreSystemFonts: true }
          : {}),
        ...(options.pdfa ? { pdfa: true } : {}),
        env: context.env,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const findings = [...notes, ...parseDiagnostics(`${outcome.stderr}\n${outcome.stdout}`)];
      if (outcome.timedOut) {
        findings.push({
          code: "BLD-001",
          gate: "G8",
          severity: "error",
          message: "Typst did not finish within 120 seconds and was stopped",
        });
      } else if (outcome.code !== 0 && !findings.some((finding) => finding.severity === "error")) {
        findings.push({
          code: "BLD-001",
          gate: "G8",
          severity: "error",
          message: `Typst exited with code ${outcome.code ?? "unknown"}`,
          ...(outcome.stderr.trim() ? { hint: outcome.stderr.trim().slice(0, 300) } : {}),
        });
      }
      let produced = false;
      let pages: number | undefined;
      try {
        await stat(join(dir, output));
        produced = true;
        pages = pdfPageCount(await readFile(join(dir, output)));
      } catch {
        produced = false;
      }
      const ok = outcome.code === 0 && produced && !findings.some((f) => f.severity === "error");
      return {
        ok,
        engine: `${engine.engine} (${engine.source})`,
        ...(produced ? { output } : {}),
        ...(pages === undefined ? {} : { pages }),
        ms: Date.now() - started,
        findings,
        unrepresented: [],
      };
    } finally {
      await rm(packageCache, { recursive: true, force: true });
    }
  },
};
