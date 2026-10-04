import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { finalProblems } from "./checks/closing.js";
import { runChecks } from "./checks/index.js";
import {
  askOne,
  describeFinding,
  type Loaded,
  loadAll,
  saveState,
  type WorkflowContext,
} from "./context.js";
import { splitChapter } from "./draft.js";
import { parseOutline } from "./outline.js";
import type { SectionPlan } from "./sections.js";
import { planSections } from "./sections.js";
import { atomicWrite, canonicalJson } from "./storage.js";
import type { Finding } from "./types.js";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Does a PDF declare conformance to PDF/A in its XMP metadata (Typst writes it uncompressed)? */
export function declaresPdfA(pdf: Buffer): boolean {
  const text = pdf.toString("latin1");
  return text.includes("pdfaid:part") || text.includes("pdfaid:conformance");
}

/** Copy a file atomically (temporary name in the same directory, then rename). */
async function atomicCopy(from: string, to: string): Promise<void> {
  const temporary = join(to.slice(0, to.length - basename(to).length), `.${randomUUID()}.tmp`);
  try {
    await copyFile(from, temporary);
    await rename(temporary, to);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface SubmissionFile {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * `/thesis:finalize` (spec 7.1 and 14, phase 5): G9 and G10, Human Gate C, the PDF/A build and the
 * submission package. Each step is safe to repeat: a failed build leaves Gate C approved, and the
 * next run resumes at the build.
 */
export class FinalizeFlow {
  constructor(private readonly context: WorkflowContext) {}

  private get now() {
    return this.context.now;
  }

  /** What stands between the thesis and Human Gate C; empty when it may proceed. */
  private async obstacles(loaded: Loaded): Promise<string[]> {
    const { state, project } = loaded;
    const out: string[] = [];
    const problems = finalProblems(project);
    out.push(...problems.blocking);
    const latest = Object.values(state.sections)
      .map((section) => section.updatedAt ?? "")
      .sort()
      .at(-1);
    if (!state.lastReview) out.push("No independent review was run (/thesis:review all)");
    else if (latest !== undefined && state.lastReview.at < latest)
      out.push("Sections changed after the last review; run /thesis:review all again");
    else if (state.lastReview.scope !== "all")
      out.push(`The last review covered ${state.lastReview.scope} only; run /thesis:review all`);
    const report = runChecks(project, { now: this.now });
    // FIN-001 is what this flow completes; BLD-001 reports the last build, which this flow redoes.
    const errors: Finding[] = report.findings.filter(
      (finding) =>
        finding.severity === "error" && finding.code !== "FIN-001" && finding.code !== "BLD-001",
    );
    for (const finding of errors.slice(0, 12))
      out.push(`${finding.gate} ${describeFinding(finding)}`);
    if (errors.length > 12) out.push(`... and ${errors.length - 12} more check error(s)`);
    return out;
  }

  private blocked(obstacles: readonly string[]): string {
    return `Blocked: the thesis is not ready for Human Gate C.\n${obstacles.map((line) => `- ${line}`).join("\n")}`;
  }

  /** `/thesis:approve C [-- notes]` */
  async approveC(
    workspace: string,
    sessionId: string,
    notes: string | undefined,
    options: { quiet?: boolean } = {},
  ): Promise<string> {
    const loaded = await loadAll(this.context, workspace, sessionId);
    const { state } = loaded;
    if (state.humanGates.C.status === "approved") return "Gate C is already approved.";
    if (state.phase !== "review")
      return `Blocked: Gate C can only be approved in the review phase, when every section is approved (phase is ${state.phase}).`;
    const obstacles = await this.obstacles(loaded);
    if (obstacles.length > 0) return this.blocked(obstacles);
    state.humanGates.C = {
      status: "approved",
      at: this.now().toISOString(),
      ...(notes ? { notes: notes.slice(0, 500) } : {}),
    };
    state.phase = "final";
    await saveState(loaded);
    return options.quiet ? "Approved Gate C." : "Approved Gate C. Next: /thesis:finalize";
  }

  async run(workspace: string, sessionId: string): Promise<string> {
    let loaded = await loadAll(this.context, workspace, sessionId);
    const { state } = loaded;
    if (state.phase === "submitted")
      return `The thesis was submitted at ${state.submittedAt}. The package is in build/submission/ (see its manifest.json).`;
    if (state.phase !== "review" && state.phase !== "final") {
      const left = Object.entries(state.sections)
        .filter(([, section]) => section.status !== "approved")
        .map(([id]) => id);
      return left.length
        ? `Blocked: ${left.length} section(s) are not approved yet (${left.slice(0, 6).join(", ")}). Run /thesis:next.`
        : `Blocked: finalize needs the review phase (phase is ${state.phase}). Run /thesis:next.`;
    }
    const obstacles = await this.obstacles(loaded);
    if (obstacles.length > 0) return this.blocked(obstacles);

    const lines: string[] = ["G9 and G10 checks pass."];
    if (state.humanGates.C.status !== "approved") {
      const answer = await askOne(this.context.api, "Human Gate C", {
        id: "C",
        header: "Gate C",
        question:
          "Approve Human Gate C: you have read the thesis, accept the checked result and want the final PDF/A build and the submission package?",
        options: [
          {
            value: "approve",
            label: "Approve and finalize",
            description: "Record the approval, build the PDF/A and write build/submission/.",
            recommended: true,
          },
          {
            value: "later",
            label: "Not yet",
            description: "Leave the gate pending; nothing is built.",
          },
        ],
      });
      if (answer?.value !== "approve") {
        return [
          ...lines,
          "Human Gate C is pending. Read the built PDF (/thesis:build), then record your decision:",
          "- /thesis:approve C   and then   /thesis:finalize",
        ].join("\n");
      }
      lines.push(await this.approveC(workspace, sessionId, undefined, { quiet: true }));
      loaded = await loadAll(this.context, workspace, sessionId);
    }
    return [...lines, await this.finish(loaded)].join("\n");
  }

  /** The PDF/A build and the submission package. */
  private async finish(first: Loaded): Promise<string> {
    const build = this.context.build;
    if (!build) return "No build is available in this context.";
    let outcome: Awaited<ReturnType<NonNullable<typeof build>>>;
    try {
      outcome = await build(first.workspace, { scope: "full", pdfa: true });
    } catch (error) {
      return `The PDF/A build could not start: ${(error as Error).message}. Gate C stays approved; run /thesis:finalize again.`;
    }
    if (!outcome.ok || !outcome.path) {
      const first = outcome.findings.find((finding) => finding.severity === "error");
      const noEngine = outcome.engine === "none" && /Typst|engine/i.test(first?.message ?? "");
      return [
        `The PDF/A build failed${first ? `: ${first.code} ${first.message}` : ""}.`,
        noEngine
          ? "Run /thesis:setup to install the Typst engine, then /thesis:finalize again (Gate C stays approved)."
          : "Fix the reported errors (/thesis:build --pdfa shows them), then run /thesis:finalize again.",
      ].join("\n");
    }
    // The build recorded itself in the state; continue from what is on disk now.
    const loaded = await loadAll(this.context, first.workspace, first.sessionId);
    const { state, base } = loaded;
    const pdf = await readFile(outcome.path);
    if (!declaresPdfA(pdf))
      return "The build produced a PDF that does not declare PDF/A conformance; it was not accepted. Run /thesis:finalize again with a Typst 0.15 engine.";

    const directory = join(base, "build", "submission");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files: SubmissionFile[] = [];
    const put = async (name: string, content: Buffer | string) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      if (typeof content === "string") await atomicWrite(join(directory, name), content);
      else await writeFile(join(directory, name), bytes, { mode: 0o600 });
      files.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
    };
    await atomicCopy(outcome.path, join(directory, "thesis-pdfa.pdf"));
    files.push({ path: "thesis-pdfa.pdf", sha256: sha256(pdf), bytes: pdf.length });
    const optional = async (from: string, name: string) => {
      const text = await readFile(join(base, from), "utf8").catch(() => undefined);
      if (text !== undefined) await put(name, text);
    };
    await optional("bibliography/references.bib", "references.bib");
    await optional("research/protocol.md", "protocol.md");
    await optional("compliance-profile.json", "compliance-profile.json");
    // FIN-001 holds from here on: the PDF/A build is recorded before the final check report.
    state.finalBuild = {
      at: this.now().toISOString(),
      pdf: `${state.root}/build/submission/thesis-pdfa.pdf`,
      sha256: sha256(pdf),
    };
    const report = runChecks(loaded.project, { now: this.now });
    await put("check-report.json", canonicalJson(report));

    if (loaded.project.profile?.aiDeclaration.required) {
      const outline = loaded.project.outlineText
        ? parseOutline(loaded.project.outlineText).outline
        : undefined;
      const plans = outline ? planSections(outline, loaded.brief) : new Map<string, SectionPlan>();
      const declaration = [...plans.values()].find((plan) => plan.role === "ai-declaration");
      const text = declaration
        ? await readFile(join(base, declaration.path), "utf8").catch(() => undefined)
        : undefined;
      if (declaration && text !== undefined)
        await put("ai-declaration.md", `${splitChapter(declaration, text).body}\n`);
    }

    const stamp = this.now().toISOString();
    const manifest = {
      generatedAt: stamp,
      title: loaded.brief.title,
      language: loaded.brief.language,
      citationStyle: loaded.project.profile?.citationStyle.value ?? null,
      engine: outcome.engine,
      pages: outcome.pages ?? null,
      files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    await atomicWrite(join(directory, "manifest.json"), canonicalJson(manifest));

    state.submittedAt = stamp;
    state.phase = "submitted";
    await saveState(loaded);
    const size = (await stat(join(directory, "thesis-pdfa.pdf"))).size;
    return [
      `Built the PDF/A (${outcome.pages ?? "?"} page(s), ${size} bytes) with ${outcome.engine}.`,
      `Submission package: ${state.root}/build/submission/ (${manifest.files.map((file) => file.path).join(", ")}, manifest.json).`,
      "The thesis is marked as submitted. Deliver the package to your institution.",
    ].join("\n");
  }
}
