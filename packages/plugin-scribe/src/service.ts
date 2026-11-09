import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { strToU8, zipSync } from "fflate";
import { assetFingerprint, compilePdf } from "./compiler.js";
import { importProject } from "./importer.js";
import type { Store } from "./store.js";
import {
  checkAssetBudget,
  type Document,
  identifier,
  type Job,
  LIMITS,
  type Locale,
  type Proposal,
  pushRevision,
  ScribeError,
  string,
  validateAsset,
} from "./types.js";

const now = () => new Date().toISOString();
const current = (d: Document) => {
  const revision = d.revisions.at(-1);
  if (!revision) throw new ScribeError("invalid_document", undefined, 500);
  return revision;
};
const initialTex =
  "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb,graphicx}\n\\begin{document}\n\\section{Introduction}\n% Your draft will appear here.\n\\end{document}\n";
export class Service {
  readonly controllers = new Map<string, AbortController>();
  private idempotent = new Map<string, { hash: string; promise: Promise<unknown> }>();
  constructor(
    readonly api: PluginAPI,
    readonly store: Store,
    readonly sessionId: string,
    readonly options: { locale?: Locale; allowedTools?: string[] } = {},
    private busy = new Set<string>(),
  ) {}
  private async update(id: string, fn: (doc: Document) => void) {
    return this.store.exclusive(async () => {
      const d = await this.store.get(id);
      fn(d);
      await this.store.put(d);
      return d;
    });
  }
  async invoke(
    action: string,
    input: Record<string, unknown> = {},
    key?: string,
  ): Promise<unknown> {
    if (key) {
      if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new ScribeError("invalid_input");
      const hash = createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
      const cached = this.idempotent.get(key);
      if (cached) {
        if (cached.hash !== hash) throw new ScribeError("idempotency_conflict", undefined, 409);
        return cached.promise;
      }
      // Retries within this process share one invocation. Durable jobs are never auto-replayed.
      const promise = this.dispatch(action, input);
      this.idempotent.set(key, { hash, promise });
      if (this.idempotent.size > 500) {
        const oldest = this.idempotent.keys().next();
        if (!oldest.done) this.idempotent.delete(oldest.value);
      }
      return promise;
    }
    return this.dispatch(action, input);
  }
  // Authorization is the host's: Alisio gates every studio action by its declared effect (and, from
  // 0.11.6, asks the user). Scribe must not re-check `sessions.capabilities`, which reflects the
  // session's standing grants only, so an action approved "once" would be rejected again here.
  private async dispatch(action: string, input: Record<string, unknown>): Promise<unknown> {
    if (action === "context")
      return {
        locale: this.options.locale ?? "en",
        capabilities: this.api.sessions.capabilities(this.sessionId),
      };
    if (action === "models") return this.api.models.list();
    if (action === "documents.list") return this.store.list();
    if (action === "jobs.list") return this.store.jobs();
    if (action === "projects.import") {
      const imported = importProject(input.project);
      await this.store.put(imported);
      return imported;
    }
    if (action === "jobs.cancel") {
      this.controllers.get(identifier(input.jobId))?.abort();
      return { ok: true };
    }
    if (action === "documents.create") {
      const title = string(input.title, LIMITS.title).trim();
      if (!title) throw new ScribeError("invalid_input");
      const doc: Document = {
        id: randomUUID(),
        title,
        brief: string(input.brief ?? ""),
        discipline: string(input.discipline ?? "physics", 40),
        language: input.language === "es" ? "es" : "en",
        model: string(input.model ?? "", 256),
        createdAt: now(),
        updatedAt: now(),
        archived: false,
        revisions: [
          {
            id: randomUUID(),
            tex: input.tex === undefined ? initialTex : string(input.tex, LIMITS.tex),
            bib: "",
            summary: "Initial document",
            at: now(),
          },
        ],
        assets: [],
        proposals: [],
      };
      await this.store.put(doc);
      return doc;
    }
    const id = identifier(input.documentId);
    if (action === "documents.get") return this.store.get(id);
    if (action === "documents.settings")
      return this.update(id, (d) => {
        if (input.title !== undefined) {
          const title = string(input.title, LIMITS.title).trim();
          if (!title) throw new ScribeError("invalid_input");
          d.title = title;
        }
        if (input.model !== undefined) d.model = string(input.model, 256);
        if (input.language !== undefined) {
          if (!["es", "en"].includes(String(input.language)))
            throw new ScribeError("invalid_input");
          d.language = input.language as Locale;
        }
        if (typeof input.archived === "boolean") d.archived = input.archived;
      });
    if (action === "revision.save")
      return this.update(id, (d) => {
        if (current(d).id !== input.baseRevision)
          throw new ScribeError("revision_conflict", undefined, 409);
        pushRevision(d, {
          id: randomUUID(),
          tex: string(input.tex, LIMITS.tex),
          bib: string(input.bib ?? "", LIMITS.bib),
          summary: "Manual edit",
          at: now(),
        });
      });
    if (action === "revision.restore")
      return this.update(id, (d) => {
        if (current(d).id !== input.baseRevision)
          throw new ScribeError("revision_conflict", undefined, 409);
        const revision = d.revisions.find((r) => r.id === input.revisionId);
        if (!revision) throw new ScribeError("not_found");
        pushRevision(d, { ...revision, id: randomUUID(), summary: "Restored revision", at: now() });
      });
    if (action === "proposal.apply" || action === "proposal.discard")
      return this.update(id, (d) => {
        const proposal = d.proposals.find((p) => p.id === input.proposalId);
        if (!proposal) throw new ScribeError("not_found");
        if (action === "proposal.apply") {
          if (current(d).id !== proposal.baseRevision)
            throw new ScribeError("revision_conflict", undefined, 409);
          pushRevision(d, {
            id: randomUUID(),
            tex: proposal.tex,
            bib: proposal.bib,
            summary: proposal.summary,
            at: now(),
          });
        }
        d.proposals = d.proposals.filter((p) => p.id !== proposal.id);
      });
    if (action === "assets.add")
      return this.update(id, (d) => {
        const asset = validateAsset(input.name, input.base64);
        const total =
          d.assets.reduce((n, a) => n + Buffer.byteLength(a.base64, "base64"), 0) + asset.bytes;
        checkAssetBudget(d.assets.length + 1, total);
        const aid = randomUUID();
        d.assets.push({
          id: aid,
          name: asset.name,
          path: `assets/${aid}.${asset.ext}`,
          mime: asset.mime,
          base64: asset.base64,
        });
      });
    if (action === "assets.remove")
      return this.update(id, (d) => {
        const asset = d.assets.find((a) => a.id === input.assetId);
        if (!asset) throw new ScribeError("not_found");
        if (current(d).tex.includes(asset.path)) throw new ScribeError("asset_in_use");
        d.assets = d.assets.filter((a) => a.id !== asset.id);
      });
    if (action === "projects.export") {
      const doc = await this.store.get(id);
      return { schemaVersion: 1, document: doc };
    }
    if (action === "sources.export") {
      const d = await this.store.get(id);
      const files: Record<string, Uint8Array> = {
        "main.tex": strToU8(current(d).tex),
        "references.bib": strToU8(current(d).bib),
        "README.txt": strToU8(
          "Scribe source snapshot. References require review. Compile only in an isolated environment.",
        ),
      };
      for (const asset of d.assets) files[asset.path] = Buffer.from(asset.base64, "base64");
      // Stored ZIP entries avoid a CPU-intensive synchronous compression step.
      return { base64: Buffer.from(zipSync(files, { level: 0 })).toString("base64") };
    }
    if (action === "pdf.get") {
      const d = await this.store.get(id);
      if (!d.pdf) throw new ScribeError("pdf_missing");
      return {
        base64: (await readFile(join(this.store.root, d.pdf.filename))).toString("base64"),
        stale: d.pdf.revision !== current(d).id || d.pdf.assetFingerprint !== assetFingerprint(d),
      };
    }
    if (action === "draft.generate" || action === "pdf.compile")
      return this.startJob(id, action, input);
    throw new ScribeError("unknown_action", undefined, 404);
  }
  private async startJob(id: string, action: string, input: Record<string, unknown>) {
    if (this.busy.has(id)) throw new ScribeError("document_busy", undefined, 409);
    // Reserve before the first await so concurrent requests cannot race.
    this.busy.add(id);
    let doc: Document;
    try {
      doc = await this.store.get(id);
      if (action === "draft.generate" && !string(input.prompt ?? doc.brief).trim())
        throw new ScribeError("invalid_input");
    } catch (e) {
      this.busy.delete(id);
      throw e;
    }
    const job: Job = {
      id: randomUUID(),
      documentId: id,
      action: action === "pdf.compile" ? "compile" : "draft",
      status: "running",
      message: action === "pdf.compile" ? "compiling" : "drafting",
      createdAt: now(),
      updatedAt: now(),
      baseRevision: current(doc).id,
    };
    const abort = new AbortController();
    this.controllers.set(job.id, abort);
    try {
      await this.store.saveJob(job);
    } catch (e) {
      this.busy.delete(id);
      this.controllers.delete(job.id);
      throw e;
    }
    void (async () => {
      try {
        if (job.action === "compile") {
          const pdf = await compilePdf(doc, this.store.root, abort.signal);
          await this.update(id, (d) => {
            d.pdf = pdf;
          });
        } else {
          if (doc.model) await this.api.models.resolve(doc.model, abort.signal);
          const instructions = await readFile(
            new URL("../.agents/agents/scr-writer.md", import.meta.url),
            "utf8",
          );
          const child = await this.api.sessions.create({
            parentId: this.sessionId,
            agent: "scr-writer",
            title: doc.title,
            instructions,
            ...(doc.model ? { model: doc.model } : {}),
            readOnly: true,
            tools: { allow: this.options.allowedTools ?? [] },
            permission: { write: "deny", process: "deny" },
            maxTurns: 8,
            maxTokens: 24000,
            maxOutputTokens: 12000,
            timeoutMs: 120000,
          });
          const cancel = () => this.api.sessions.cancel(child.id);
          abort.signal.addEventListener("abort", cancel, { once: true });
          try {
            abort.signal.throwIfAborted();
            const assets = doc.assets.map((a) => ({
              name: a.name,
              path: a.path,
              mime: a.mime,
              text:
                a.mime.startsWith("text/") || a.mime === "application/json"
                  ? Buffer.from(a.base64, "base64").toString("utf8").slice(0, 12000)
                  : undefined,
            }));
            const prompt = JSON.stringify({
              request: string(input.prompt ?? doc.brief),
              language: doc.language,
              scope: string(input.scope ?? "document", 100),
              title: doc.title,
              source: current(doc).tex.slice(0, 80000),
              bibliography: current(doc).bib.slice(0, 20000),
              assets,
            });
            if (prompt.length > 180000) throw new ScribeError("context_limit");
            const result = await this.api.sessions.run(child.id, prompt, { signal: abort.signal });
            abort.signal.throwIfAborted();
            job.usage = result.usage;
            if (result.status !== "completed" || result.turnsExceeded)
              throw new ScribeError("agent_incomplete");
            const response = result.text
              .trim()
              .replace(/^```(?:json)?\s*/, "")
              .replace(/\s*```$/, "");
            let value: Record<string, unknown>;
            try {
              value = JSON.parse(response);
            } catch {
              throw new ScribeError("invalid_agent_output");
            }
            const tex = string(value.tex, LIMITS.tex);
            const bib = string(value.bib ?? "", LIMITS.bib);
            if (!tex.includes("\\begin{document}") || !tex.includes("\\end{document}"))
              throw new ScribeError("invalid_agent_output");
            const proposal: Proposal = {
              id: randomUUID(),
              baseRevision: job.baseRevision,
              tex,
              bib,
              summary: string(value.summary, LIMITS.summary),
            };
            await this.update(id, (d) => {
              d.proposals.push(proposal);
            });
          } finally {
            abort.signal.removeEventListener("abort", cancel);
          }
        }
        job.status = "succeeded";
        job.message = "done";
      } catch (e) {
        job.status = abort.signal.aborted ? "cancelled" : "failed";
        job.errorCode = abort.signal.aborted
          ? "cancelled"
          : e instanceof ScribeError
            ? e.code
            : "operation_failed";
        job.message = e instanceof Error ? e.message : "operation_failed";
      } finally {
        job.updatedAt = now();
        this.controllers.delete(job.id);
        this.busy.delete(id);
        await this.store.saveJob(job);
      }
    })().catch(() => {
      /* Persistence errors remain visible as interrupted work on recovery. */
    });
    return job;
  }
  dispose() {
    for (const controller of this.controllers.values()) controller.abort();
  }
}
